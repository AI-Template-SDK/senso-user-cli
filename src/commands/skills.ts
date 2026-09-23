import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Command } from "commander";
import { CliError, EXIT } from "../lib/errors.js";
import { emit, emitConfirmation } from "../lib/output.js";
import { runAction, type Ctx } from "../lib/run-action.js";
import * as log from "../utils/logger.js";
import { getApiKey } from "../lib/config.js";

const execFileAsync = promisify(execFile);

// Mirrors the skills published from the senso-skills repository. This list
// drifted once already — senso-onboarding shipped from senso-contextos and was
// never added here — so tests/policy/repo-rules.test.ts compares it against a
// fixture.
//
// These five supersede the seven task-shaped skills that came before (search,
// ingest, content-gen, brand-setup, kb-organize, review-publish, onboarding).
// The old packages are still in the registry and still install by name; they
// are simply no longer what `--all` means. Ordered as a first run uses them.
export const SENSO_SKILLS = [
  "senso-ai/senso-quickstart",
  "senso-ai/senso-context-layer",
  "senso-ai/senso-evaluate-remediate",
  "senso-ai/senso-generate-verify",
  "senso-ai/senso-publish",
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

/**
 * Install a list of skill packages, one at a time, and report the outcome.
 *
 * Shared by `senso skills install` and `senso setup` so the two cannot drift:
 * the argv handed to the child, the partial-failure accounting and the shape of
 * the emitted payload are decided once, here.
 */
export async function installSkills(
  ctx: Ctx,
  packages: string[],
  opts: { agent?: string; global: boolean },
): Promise<void> {
  const agentFlags = buildAgentFlags(opts.agent);

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

  const globalFlag = opts.global ? ["--global"] : [];

  if (!ctx.quiet) log.info(`Installing ${packages.length} skill(s)...`);

  const installed: string[] = [];
  const failed: { skill: string; reason: string }[] = [];

  for (const pkg of packages) {
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
      `${failed.length} of ${packages.length} skill(s) failed to install.`,
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
      "Install Senso agent skills. Use --all for every official skill, or pass individual short names (quickstart, context-layer, evaluate-remediate, generate-verify, publish). `senso setup` installs the full set globally in one step.",
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
              : // Allow short names like "quickstart" -> "senso-ai/senso-quickstart"
                names.map((n) => (n.startsWith("@") ? n : `senso-ai/senso-${n}`));

          await installSkills(ctx, skillPackages, {
            agent: cmdOpts.agent,
            global: cmdOpts.global === true,
          });
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
            "  Or, globally, in one step: senso setup",
          ],
        });
      }),
    );

  skills
    .command("remove <name>")
    .description(
      "Remove an installed Senso skill. Use the short name (e.g., quickstart, context-layer, publish).",
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
          removed: shortName(pkg),
          package: pkg,
        });
      }),
    );
}
