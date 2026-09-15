import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Command } from "commander";
import { CliError, EXIT } from "../lib/errors.js";
import { emit, emitConfirmation } from "../lib/output.js";
import { runAction } from "../lib/run-action.js";
import * as log from "../utils/logger.js";
import { getApiKey } from "../lib/config.js";

const execFileAsync = promisify(execFile);

// Mirrors the skills published from senso-contextos/skills/. This list drifted
// once already — senso-onboarding shipped there and was never added here — so
// tests/policy/skills-list.test.ts now compares it against a fixture.
export const SENSO_SKILLS = [
  "senso-ai/senso-search",
  "senso-ai/senso-ingest",
  "senso-ai/senso-content-gen",
  "senso-ai/senso-brand-setup",
  "senso-ai/senso-kb-organize",
  "senso-ai/senso-review-publish",
  "senso-ai/senso-onboarding",
];

const AGENT_FLAGS: Record<string, string> = {
  claude: "--claude",
  cursor: "--cursor",
  codex: "--codex",
  copilot: "--copilot",
  gemini: "--gemini",
  cline: "--cline",
};

/** How long a single shipables invocation may take. */
const SHIPABLES_TIMEOUT_MS = 120_000;

/** Every official skill is published under this prefix. */
export const SENSO_SKILL_PREFIX = "senso-ai/senso-";

export function shortName(pkg: string): string {
  return pkg.replace(SENSO_SKILL_PREFIX, "");
}

async function resolveShipables(): Promise<string> {
  // Check if shipables is available globally
  try {
    await execFileAsync("shipables", ["--version"]);
    return "shipables";
  } catch {
    // Fall back to npx
    return "npx";
  }
}

/**
 * Run one shipables command and capture what it printed.
 *
 * `cwd` matters because shipables keys a project-level install by the
 * directory it was run from: an uninstall for a skill installed in another
 * project has to run from that project's directory to find it.
 */
export async function runShipables(
  args: string[],
  opts: { cwd?: string } = {},
): Promise<{ stdout: string; stderr: string }> {
  const bin = await resolveShipables();
  const execOpts = { timeout: SHIPABLES_TIMEOUT_MS, ...opts };
  if (bin === "npx") {
    return execFileAsync("npx", ["--yes", "@senso-ai/shipables", ...args], execOpts);
  }
  return execFileAsync(bin, args, execOpts);
}

function buildAgentFlags(agent?: string): string[] {
  if (!agent) return ["--all"];
  const flag = AGENT_FLAGS[agent.toLowerCase()];
  if (!flag) {
    throw new CliError(`Unknown agent "${agent}".`, EXIT.USAGE, {
      code: "usage",
      hint: `Valid agents: ${Object.keys(AGENT_FLAGS).join(", ")}.`,
    });
  }
  return [flag];
}

export function registerSkillsCommands(program: Command): void {
  const skills = program
    .command("skills")
    .description(
      "Install and manage Senso agent skills. Skills teach AI coding agents (Claude Code, Cursor, Codex, etc.) how to use Senso automatically.",
    );

  skills
    .command("install [names...]")
    .description(
      "Install Senso agent skills. Use --all for every official skill, or pass individual short names (search, ingest, content-gen, brand-setup, kb-organize, review-publish, onboarding).",
    )
    .option("--all", "Install every official Senso skill")
    .option(
      "--agent <name>",
      "Target a specific agent: claude, cursor, codex, copilot, gemini, cline",
    )
    .option("--global", "Install globally instead of project-level")
    .action(
      runAction(
        program,
        async (
          ctx,
          names: string[],
          cmdOpts: { all?: boolean; agent?: string; global?: boolean },
        ) => {
          const skillPackages =
            cmdOpts.all || names.length === 0
              ? [...SENSO_SKILLS]
              : // Allow short names like "search" -> "senso-ai/senso-search"
                names.map((n) => (n.startsWith("@") ? n : `senso-ai/senso-${n}`));

          const agentFlags = buildAgentFlags(cmdOpts.agent);

          // KNOWN LIMITATION: this puts the API key in the child's argv, where it
          // is readable in `ps` output and lands in shell history. It cannot be
          // fixed from this side. shipables 0.1.2 uses --env to populate the
          // installed skill's MCP server environment and never falls back to
          // process.env for a value — non-interactively an unsupplied variable
          // becomes the empty string with a warning — so passing the key through
          // the child's own environment would install a skill with no credential
          // at all. Recorded in SECURITY.md; the fix belongs upstream.
          const envFlags: string[] = [];
          const apiKey = getApiKey({ apiKey: ctx.apiKey });
          if (apiKey) {
            envFlags.push("--env", `SENSO_API_KEY=${apiKey}`);
          }

          const globalFlag = cmdOpts.global ? ["--global"] : [];

          if (!ctx.quiet) log.info(`Installing ${skillPackages.length} skill(s)...`);

          const installed: string[] = [];
          const failed: { skill: string; reason: string }[] = [];

          for (const pkg of skillPackages) {
            try {
              const args = ["install", pkg, ...agentFlags, ...globalFlag, ...envFlags, "--yes"];
              const { stdout, stderr } = await runShipables(args);

              // shipables' own progress output. It belongs on stderr with the
              // rest of the commentary, not interleaved with this command's
              // payload on stdout.
              if (!ctx.quiet) {
                if (stdout.trim()) log.raw(stdout.trim());
                if (stderr.trim()) log.raw(stderr.trim());
              }

              installed.push(shortName(pkg));
              if (!ctx.quiet) log.success(`Installed ${shortName(pkg)}`);
            } catch (err) {
              // One skill failing should not abandon the rest — they are
              // independent installs — so failures are collected and reported
              // together at the end.
              const reason = err instanceof Error ? err.message : String(err);
              failed.push({ skill: shortName(pkg), reason });
              log.error(`Failed to install ${shortName(pkg)}: ${reason}`);
            }
          }

          // Previously every install could fail and the command still exited 0,
          // reporting "Done" — so a CI step that installed skills could not tell
          // whether it had worked.
          //
          // Thrown BEFORE the payload is emitted, so stdout stays empty on a
          // failure like every other command. The per-skill detail is already on
          // stderr, and the hint says how to get more.
          if (failed.length > 0) {
            throw new CliError(
              `${failed.length} of ${skillPackages.length} skill(s) failed to install.`,
              EXIT.ERROR,
              {
                hint: `Failed: ${failed.map((f) => f.skill).join(", ")}. Re-run one at a time, or with SENSO_DEBUG=1, to see why.`,
              },
            );
          }

          emit(ctx, { installed, failed });

          if (!ctx.quiet) {
            log.success("Done. Your agent can now use Senso — just talk to it naturally.");
          }
        },
      ),
    );

  skills
    .command("list")
    .description("List installed Senso skills.")
    .option("--global", "List globally installed skills")
    .action(
      runAction(program, async (ctx, cmdOpts: { global?: boolean }) => {
        const globalFlag = cmdOpts.global ? ["--global"] : [];
        const { stdout } = await runShipables(["list", ...globalFlag, "--json"]);

        let data: unknown;
        try {
          data = JSON.parse(stdout);
        } catch (err) {
          throw new CliError("shipables did not return valid JSON.", EXIT.ERROR, {
            hint: "Check that @senso-ai/shipables is installed and current.",
            cause: err,
          });
        }

        if (!data || (Array.isArray(data) && data.length === 0)) {
          if (!ctx.quiet) {
            log.info("No skills installed. Run `senso skills install --all` to get started.");
          }
        }
        emit(ctx, data);
      }),
    );

  skills
    .command("list-available")
    .description("Show every official Senso skill available for install.")
    .action(
      runAction(program, (ctx) => {
        const available = SENSO_SKILLS.map((pkg) => ({
          package: pkg,
          shortName: shortName(pkg),
        }));

        emit(ctx, available, {
          columns: ["shortName", "package"],
          plain: [
            "",
            ...available.map((s) => `  ${s.shortName.padEnd(18)} ${s.package}`),
            "",
            "  Install all: senso skills install --all",
          ],
        });
      }),
    );

  skills
    .command("remove <name>")
    .description(
      "Remove an installed Senso skill. Use the short name (e.g., search, ingest, content-gen).",
    )
    .option("--global", "Remove from global install")
    .action(
      runAction(program, async (ctx, name: string, cmdOpts: { global?: boolean }) => {
        const pkg = name.startsWith("@") ? name : `senso-ai/senso-${name}`;
        const globalFlag = cmdOpts.global ? ["--global"] : [];

        // No `--yes`: shipables' uninstall does not take one and rejects it
        // as an unknown option, so passing it made every `skills remove` exit 1
        // without removing anything. The install side does take it.
        const { stdout, stderr } = await runShipables(["uninstall", pkg, ...globalFlag]);

        if (!ctx.quiet) {
          if (stdout.trim()) log.raw(stdout.trim());
          if (stderr.trim()) log.raw(stderr.trim());
        }

        emitConfirmation(ctx, `Removed ${shortName(pkg)}`, {
          action: "removed",
          resource: "skill",
          id: shortName(pkg),
          package: pkg,
        });
      }),
    );
}
