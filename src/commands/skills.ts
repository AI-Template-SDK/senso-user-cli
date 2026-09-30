import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Command } from "commander";
import { CliError, EXIT } from "../lib/errors.js";
import { emit, emitConfirmation } from "../lib/output.js";
import { runAction, type Ctx } from "../lib/run-action.js";
import * as log from "../utils/logger.js";
import { getApiKey } from "../lib/config.js";

const execFileAsync = promisify(execFile);

/**
 * Every Senso skill is published under this namespace.
 *
 * shipables accepts it with or without a leading `@`, but records an install
 * under exactly the spelling it was given, and looks records up by exact match.
 * `@senso-ai/x` and `senso-ai/x` are therefore two records for one directory:
 * uninstalling either deletes the files the other still claims. This CLI always
 * hands shipables the bare spelling, and reads both.
 */
export const SENSO_NAMESPACE = "senso-ai/";

/** Whether a recorded package name belongs to Senso, in either spelling. */
export function isSensoPackage(name: string): boolean {
  return name.replace(/^@/, "").startsWith(SENSO_NAMESPACE);
}

/**
 * The package to hand shipables for what a user typed.
 *
 * A short name gets the namespace and the `senso-` prefix; a Senso package in
 * the `@` spelling loses the `@`, for the reason above; anything else with a
 * slash is someone else's package and passes through untouched.
 */
export function toPackage(name: string): string {
  if (isSensoPackage(name)) return name.replace(/^@/, "");
  if (name.includes("/")) return name;
  return `${SENSO_NAMESPACE}senso-${name}`;
}

/** `senso-ai/senso-gap-report` → `gap-report`, the directory name minus `senso-`. */
export function shortName(pkg: string): string {
  if (!isSensoPackage(pkg)) return pkg;
  return pkg.replace(/^@?senso-ai\//, "").replace(/^senso-/, "");
}

/**
 * One official skill. A `flow` is a path a user walks through end to end; a
 * `module` is a capability the flows call into.
 */
export interface OfficialSkill {
  package: string;
  kind: "flow" | "module";
}

// Mirrors the skills published from the senso-skills repository. This list
// drifted once already — senso-onboarding shipped from senso-contextos and was
// never added here — so tests/policy/repo-rules.test.ts compares it against a
// fixture.
//
// ONE SET, NOT A MENU. The nine cross-reference each other by heading, so a
// partial install is broken by construction; `--all` and `setup` always mean
// all nine. Ordered as a first run uses them, flows before modules.
export const OFFICIAL_SKILLS: readonly OfficialSkill[] = [
  { package: "senso-ai/senso-quickstart", kind: "flow" },
  { package: "senso-ai/senso-verification-loop-setup", kind: "flow" },
  { package: "senso-ai/senso-verification-loop", kind: "flow" },
  { package: "senso-ai/senso-shared-context-setup", kind: "flow" },
  { package: "senso-ai/senso-shared-context", kind: "flow" },
  { package: "senso-ai/senso-context-layer", kind: "module" },
  { package: "senso-ai/senso-gap-report", kind: "module" },
  { package: "senso-ai/senso-generate-verify", kind: "module" },
  { package: "senso-ai/senso-publish", kind: "module" },
];

export const SENSO_SKILLS = OFFICIAL_SKILLS.map((s) => s.package);

// Skills `senso setup` removes on every run. Each has a tombstone in the
// registry that tells an agent to run `senso setup`, so an install that is
// never set up again still gets redirected — but setup removes it outright
// rather than leave a skill whose only content is "this skill is gone".
//
// evaluate-remediate split three ways: verification-loop-setup,
// verification-loop and gap-report.
export const RETIRED_SKILLS = ["evaluate-remediate"].map((n) => `${SENSO_NAMESPACE}senso-${n}`);

const AGENT_FLAGS: Record<string, string> = {
  claude: "--claude",
  cursor: "--cursor",
  codex: "--codex",
  copilot: "--copilot",
  gemini: "--gemini",
  cline: "--cline",
};

export const SUPPORTED_AGENTS = Object.keys(AGENT_FLAGS);

/**
 * Where each agent keeps its skills, relative to the home directory for a
 * global install and to the project for a local one. Mirrors the adapters in
 * shipables 0.1.2; codex, copilot, gemini and cline share one directory.
 *
 * Needed because shipables removes only what it recorded. A skill directory
 * with no record — copied by hand, or left behind by a record that was lost —
 * survives `shipables uninstall`, which exits 4 and leaves it in place.
 */
export const AGENT_SKILL_DIRS: Record<string, string> = {
  claude: ".claude/skills",
  cursor: ".cursor/skills",
  codex: ".agents/skills",
  copilot: ".agents/skills",
  gemini: ".agents/skills",
  cline: ".agents/skills",
};

/** How long a single shipables invocation may take. */
const SHIPABLES_TIMEOUT_MS = 120_000;

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

/**
 * The agents an install targets, or `undefined` for "whichever shipables
 * detects".
 *
 * GLOBAL WITH NO --agent MEANS EVERY SUPPORTED AGENT, named one by one. The
 * alternative, shipables' `--all`, means every *detected* agent, and detection
 * is uneven: Copilot is detected by a `.vscode` directory in the current
 * directory, Gemini only by its binary on PATH, Cline only by a project
 * `.cline`. A global install that depends on where it was run from is the
 * failure `setup` exists to avoid. Naming an agent that is not installed only
 * writes a directory under the home directory.
 *
 * A project install keeps `--all`: naming every agent there would create
 * `.claude`, `.cursor` and `.agents` in a repository that uses one of them.
 */
export function resolveAgents(agent: string | undefined, global: boolean): string[] | undefined {
  if (agent) {
    const name = agent.toLowerCase();
    if (!AGENT_FLAGS[name]) {
      throw new CliError(`Unknown agent "${agent}".`, EXIT.USAGE, {
        code: "usage",
        hint: `Valid agents: ${SUPPORTED_AGENTS.join(", ")}.`,
      });
    }
    return [name];
  }
  return global ? [...SUPPORTED_AGENTS] : undefined;
}

function agentFlags(agents: string[] | undefined): string[] {
  // resolveAgents has already rejected any name not in AGENT_FLAGS.
  return agents ? agents.map((a) => AGENT_FLAGS[a] ?? `--${a}`) : ["--all"];
}

/**
 * Install a list of skill packages, one at a time, and return their short
 * names. Throws, having tried every one, if any failed.
 *
 * Shared by `senso skills install` and `senso setup` so the two cannot drift
 * on the argv handed to the child or the partial-failure accounting.
 */
export async function installPackages(
  ctx: Ctx,
  packages: string[],
  opts: { agents: string[] | undefined; global: boolean },
): Promise<string[]> {
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
      const args = [
        "install",
        pkg,
        ...agentFlags(opts.agents),
        ...globalFlag,
        ...envFlags,
        "--yes",
      ];
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

  return installed;
}

/** What shipables recorded for one install, as `shipables list --json` prints it. */
export interface InstalledRecord {
  version?: string;
  agents?: string[];
}

/**
 * shipables' record for one scope, keyed by package name as it was spelled at
 * install time.
 *
 * `list --json` prints an object, `{}` when nothing is installed. Anything
 * else — an npx banner, an older shipables — is a usage problem for the
 * caller, so it throws the same diagnosis `skills list` gives.
 */
export async function listInstalled(global: boolean): Promise<Record<string, InstalledRecord>> {
  const { stdout } = await runShipables(["list", ...(global ? ["--global"] : []), "--json"]);
  try {
    const data = JSON.parse(stdout) as unknown;
    if (data && typeof data === "object" && !Array.isArray(data)) {
      return data as Record<string, InstalledRecord>;
    }
    return {};
  } catch (err) {
    throw new CliError("shipables did not return valid JSON.", EXIT.ERROR, {
      hint: "Check that @senso-ai/shipables is installed and current.",
      cause: err,
    });
  }
}

/**
 * The latest published version of every package in the Senso namespace, from
 * one registry call.
 *
 * One `search` rather than an `info` per skill: the registry rate-limits, and
 * nine lookups on top of nine installs is what an agent re-running `setup`
 * would trip it with. `shipables update` is no help — 0.1.2 reports every
 * skill as up to date with its latest version "unknown".
 */
export async function latestVersions(): Promise<Map<string, string>> {
  const { stdout } = await runShipables(["search", "senso-ai", "--limit", "100", "--json"]);
  const data = JSON.parse(stdout) as {
    skills?: { full_name?: string; latest_version?: string }[];
  };
  const latest = new Map<string, string>();
  for (const skill of data.skills ?? []) {
    if (skill.full_name && skill.latest_version && isSensoPackage(skill.full_name)) {
      latest.set(toPackage(skill.full_name), skill.latest_version);
    }
  }
  return latest;
}

/** Install packages for `senso skills install`, and report them. */
async function installSkills(
  ctx: Ctx,
  packages: string[],
  opts: { agent?: string; global: boolean },
): Promise<void> {
  const agents = resolveAgents(opts.agent, opts.global);
  const installed = await installPackages(ctx, packages, { agents, global: opts.global });

  emit(ctx, { installed, failed: [] });

  if (!ctx.quiet) {
    log.success("Done. Your agent can now use Senso — just talk to it naturally.");
  }
}

/**
 * Warn, on stderr, when a named install leaves the official set incomplete or
 * asks for a retired skill. A warning rather than a refusal: installing one
 * skill to try it, or to repair one directory, is legitimate.
 */
function warnAboutPartialSet(packages: string[]): void {
  for (const pkg of packages.filter((p) => RETIRED_SKILLS.includes(p))) {
    log.warn(
      `${shortName(pkg)} is retired and installs only a pointer to its replacements. Run \`senso setup\` for the current skills.`,
    );
  }
  const official = packages.filter((p) => SENSO_SKILLS.includes(p));
  if (official.length > 0 && official.length < SENSO_SKILLS.length) {
    log.warn(
      "The official Senso skills reference each other and are meant to be installed together: `senso skills install --all`, or `senso setup`.",
    );
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
      `Install Senso agent skills. With no names, or --all, installs the nine official skills as one set: ${OFFICIAL_SKILLS.map((s) => shortName(s.package)).join(", ")}. They reference each other, so install them together; a single name still works and warns. \`senso setup\` installs the set globally in one step.`,
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
          const everything = cmdOpts.all === true || names.length === 0;
          // Short names like "quickstart" -> "senso-ai/senso-quickstart".
          const skillPackages = everything ? [...SENSO_SKILLS] : names.map(toPackage);

          if (!everything) warnAboutPartialSet(skillPackages);

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

        // shipables prints `{}` for an empty scope, not `[]`, so an array-only
        // check never told anyone that nothing was installed.
        const empty =
          !data ||
          (Array.isArray(data)
            ? data.length === 0
            : typeof data === "object" && Object.keys(data).length === 0);
        if (empty) {
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
        const available = OFFICIAL_SKILLS.map((s) => ({
          shortName: shortName(s.package),
          package: s.package,
          kind: s.kind,
        }));

        emit(ctx, available, {
          columns: ["shortName", "package", "kind"],
          plain: [
            "",
            ...available.map(
              (s) => `  ${s.shortName.padEnd(25)} ${s.package.padEnd(41)} ${s.kind}`,
            ),
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
        const pkg = toPackage(name);
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
