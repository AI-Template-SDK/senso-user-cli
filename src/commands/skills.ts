/**
 * `senso skills`: the official Senso skills, installed into an agent's own
 * skill directories.
 *
 * Nothing here reaches the Senso API. Every subcommand but `list-available`
 * shells out to shipables — from PATH when it is there, through
 * `npx --yes @senso-ai/shipables` when it is not — and shipables keys a
 * project-level install by the directory it was run from, which is why `list`
 * and `remove` see only the current directory unless `--global` is passed.
 *
 * Two things in here are load-bearing:
 *
 *   - **The API key travels in the child's environment, never in its argv.** It
 *     used to be passed as `--env SENSO_API_KEY=<key>`, where `ps` and the
 *     shell history could read it — and where Node's own "Command failed:
 *     <argv>" rejection message put it back on stderr the moment the child
 *     failed. It bought nothing: shipables reads `--env` only for a skill whose
 *     manifest declares an MCP server, and no Senso skill declares one. The
 *     skills call this CLI, which finds the key for itself. So the key is
 *     exported to the child in case shipables ever asks, and everything this
 *     command relays is redacted on the way out.
 *
 *   - **Both spellings of a skill name resolve to the same package.** The short
 *     name (`search`) and the package name `list-available` prints
 *     (`senso-ai/senso-search`) are the same skill. Only the short form used to
 *     be handled, so feeding this command its own output built
 *     `senso-ai/senso-senso-ai/senso-search` and failed after a 120-second
 *     round trip through npx.
 */

import { execFile, type ExecFileOptions } from "node:child_process";
import { promisify } from "node:util";
import { Command } from "commander";
import { CliError, EXIT, usageError } from "../lib/errors.js";
import { describeCommand, localExits } from "../lib/help.js";
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

/**
 * One line per skill, so an agent choosing between seven names has something to
 * choose on. Kept beside the list rather than fetched: `list-available` answers
 * offline, and that is the property that lets an agent call it first.
 */
const SKILL_SUMMARY: Record<string, string> = {
  search: "Search the knowledge base for verified answers, chunks and content ids.",
  ingest: "Upload files or raw text into the knowledge base and poll ingestion.",
  "content-gen": "Generate brand-aligned content from the knowledge base.",
  "brand-setup": "Configure the brand kit and the content types generation uses.",
  "kb-organize": "Browse and reorganize the knowledge base folder tree.",
  "review-publish": "Review, approve, publish and unpublish generated content.",
  onboarding: "Take a new organization from empty to a populated knowledge base.",
};

const AGENT_FLAGS: Record<string, string> = {
  claude: "--claude",
  cursor: "--cursor",
  codex: "--codex",
  copilot: "--copilot",
  gemini: "--gemini",
  cline: "--cline",
};

/** The agent names `--agent` accepts, in the order the help lists them. */
const AGENTS = Object.keys(AGENT_FLAGS);

/** How long a single shipables invocation may take. */
const SHIPABLES_TIMEOUT_MS = 120_000;

/** Every official skill is published under this prefix. */
export const SENSO_SKILL_PREFIX = "senso-ai/senso-";

export function shortName(pkg: string): string {
  return pkg.replace(SENSO_SKILL_PREFIX, "");
}

/** The short names, which are the id space every subcommand here takes. */
function shortNames(): string[] {
  return SENSO_SKILLS.map(shortName);
}

/**
 * Edit distance, for a did-you-mean on a misspelled skill name.
 *
 * Small on purpose: seven candidates of a dozen characters each, once, on the
 * failure path. The point is that `serach` costs exit 2 and a suggestion rather
 * than a 120-second npx download that ends in "registry returned 404".
 */
function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current.push(
        Math.min(
          (current[j - 1] ?? 0) + 1,
          (previous[j] ?? 0) + 1,
          (previous[j - 1] ?? 0) + cost,
        ),
      );
    }
    previous = current;
  }
  return previous[b.length] ?? Math.max(a.length, b.length);
}

/** The closest official short name, when one is close enough to be a typo. */
function didYouMean(name: string): string | undefined {
  const ranked = shortNames()
    .map((candidate) => ({ candidate, d: distance(name.toLowerCase(), candidate) }))
    .sort((x, y) => x.d - y.d);
  const best = ranked[0];
  return best && best.d <= 3 ? best.candidate : undefined;
}

/**
 * The package name for a skill the caller named.
 *
 * Accepts the short name and the package form, which is what `list-available`
 * prints — before this, only the short name worked and the package form was
 * prefixed a second time. An unknown name is rejected here rather than by
 * shipables, so a typo costs exit 2 instead of a download and an opaque 404.
 *
 * A name starting with `@` is somebody else's scoped npm package and is taken
 * at face value: this CLI has no list to check it against, and refusing it
 * would remove the only way to install a skill Senso does not publish.
 */
export function resolveSkillPackage(name: string, field: string): string {
  const trimmed = name.trim();
  if (trimmed.startsWith("@")) return trimmed;

  const short = trimmed.startsWith(SENSO_SKILL_PREFIX) ? shortName(trimmed) : trimmed;
  const pkg = `${SENSO_SKILL_PREFIX}${short}`;
  if (!SENSO_SKILLS.includes(pkg)) {
    const suggestion = didYouMean(short);
    throw usageError(`Unknown skill "${name}".`, {
      field,
      received: name,
      allowed: shortNames(),
      hint: `${suggestion ? `Did you mean ${suggestion}? ` : ""}Run \`senso skills list-available\` for the full list.`,
    });
  }
  return pkg;
}

/** Where shipables will look, which is the current directory unless --global. */
function scopeOf(global?: boolean): string {
  return global ? "global" : process.cwd();
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
 *
 * `apiKey` is exported into the child's environment and never added to its
 * argv. See the note at the top of this file: argv is world-readable, and
 * shipables would not have used the value anyway.
 */
export async function runShipables(
  args: string[],
  opts: { cwd?: string; apiKey?: string } = {},
): Promise<{ stdout: string; stderr: string }> {
  const bin = await resolveShipables();
  // `encoding` is what makes the promisified execFile resolve to strings
  // rather than Buffers; without it the captured output cannot be reported.
  const execOpts: ExecFileOptions & { encoding: BufferEncoding } = {
    encoding: "utf8",
    timeout: SHIPABLES_TIMEOUT_MS,
    ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
    ...(opts.apiKey === undefined
      ? {}
      : { env: { ...process.env, SENSO_API_KEY: opts.apiKey } }),
  };
  if (bin === "npx") {
    return execFileAsync("npx", ["--yes", "@senso-ai/shipables", ...args], execOpts);
  }
  return execFileAsync(bin, args, execOpts);
}

/** The fields Node hangs off a failed execFile, none of which are in its type. */
interface ChildError {
  message?: string;
  stdout?: string;
  stderr?: string;
  killed?: boolean;
  signal?: string;
}

export interface ChildFailure {
  /** What the child said, with the command line it was given left out. */
  reason: string;
  /** The child was killed for taking too long, rather than refusing. */
  timedOut: boolean;
}

/**
 * What a failed shipables run actually says.
 *
 * Node builds the rejection message as `Command failed: <the whole argv>`
 * followed by the child's stderr. Relaying that verbatim is how this command
 * used to print `--env SENSO_API_KEY=<key>` on stderr; even with the key out of
 * the argv it is a line of noise in front of the one useful sentence. So the
 * child's own output wins, and the command line is stripped when it is all
 * there is.
 */
export function childFailure(err: unknown, apiKey?: string): ChildFailure {
  const e = (typeof err === "object" && err !== null ? err : {}) as ChildError;
  // execFile kills the child itself when `timeout` expires, which is the only
  // way `killed` is true here.
  const timedOut = e.killed === true;
  const fromChild = [e.stderr, e.stdout]
    .map((s) => (typeof s === "string" ? s.trim() : ""))
    .filter(Boolean)
    .join("\n");
  const message = typeof e.message === "string" ? e.message : String(err);
  const reason =
    fromChild ||
    message.replace(/^Command failed:.*$/m, "").trim() ||
    (timedOut
      ? `shipables did not finish within ${String(SHIPABLES_TIMEOUT_MS / 1000)} seconds`
      : "shipables failed without saying why");
  return { reason: redact(reason, apiKey), timedOut };
}

/** Belt and braces: a credential must not survive into a line we print. */
function redact(text: string, apiKey?: string): string {
  return apiKey ? text.split(apiKey).join("<redacted>") : text;
}

/** shipables' own commentary belongs on stderr, next to the rest of ours. */
function relay(ctx: { quiet: boolean }, out: { stdout: string; stderr: string }, key?: string) {
  if (ctx.quiet) return;
  for (const stream of [out.stdout, out.stderr]) {
    if (stream.trim()) log.raw(redact(stream.trim(), key));
  }
}

function buildAgentFlags(agent?: string): string[] {
  if (!agent) return ["--all"];
  const flag = AGENT_FLAGS[agent.trim().toLowerCase()];
  if (!flag) {
    throw usageError(`Unknown agent "${agent}".`, {
      field: "--agent",
      received: agent,
      allowed: AGENTS,
      hint: `Must be one of: ${AGENTS.join(", ")}. Omit --agent to install for every agent on this machine.`,
    });
  }
  return [flag];
}

/** shipables says this when a package it has no record of is uninstalled. */
const NOT_INSTALLED = /is not installed/i;

/** What shipables 0.1.x prints under `list --json`: a map keyed by package. */
interface ShipablesRecord {
  version?: string;
  agents?: string[];
}

export function registerSkillsCommands(program: Command): void {
  const skills = program
    .command("skills")
    .description(
      "Install and manage the official Senso skills for AI coding agents (Claude Code, Cursor, Codex, Copilot, Gemini, Cline). A skill is a folder of instructions the agent reads before it calls this CLI. Local: nothing is sent to the Senso API.",
    );

  describeCommand(skills, {
    notes: [
      "These commands run the shipables installer, from PATH or through `npx --yes @senso-ai/shipables` — which needs network and can take up to 120 seconds the first time.",
      "A skill is named by its short name (search, ingest, content-gen, brand-setup, kb-organize, review-publish, onboarding). The package form senso-ai/senso-<name> is accepted everywhere the short name is.",
      "install, list and remove are scoped to the directory they run from unless --global is passed. A skill installed in another project is not visible here.",
      "The installed skill authenticates with the key this CLI already has: run `senso login` once, and nothing is written into the skill itself.",
    ],
    examples: [
      { comment: "The usual order", command: "senso skills list-available" },
      { command: "senso skills install --all --agent claude" },
      { command: "senso skills list --output json" },
      { command: "senso skills remove search" },
    ],
    seeAlso: ["senso login", "senso uninstall"],
  });

  describeCommand(
    skills
      .command("install")
      .description(
        "Install official Senso skills into this directory's agent skill folders. With no names, or with --all, installs every official skill.",
      )
      .argument(
        "[names...]",
        "Skill short names (search, ingest, content-gen, brand-setup, kb-organize, review-publish, onboarding), or the package form senso-ai/senso-<name>. Omit to install all of them.",
      )
      .option("--all", "Install every official Senso skill (same as giving no names)")
      .option(
        "--agent <name>",
        `Install for one agent only: ${AGENTS.join(", ")}. Default: every agent shipables detects here.`,
      )
      .option("--global", "Install into your home directory, for every project")
      .action(
        runAction(
          program,
          async (
            ctx,
            names: string[],
            cmdOpts: { all?: boolean; agent?: string; global?: boolean },
          ) => {
            // Validated before anything is spawned: an unknown name or agent
            // should cost exit 2, not a 120-second npx download that ends in a
            // registry 404.
            const skillPackages =
              cmdOpts.all || names.length === 0
                ? [...SENSO_SKILLS]
                : names.map((n) => resolveSkillPackage(n, "[names...]"));
            const agentFlags = buildAgentFlags(cmdOpts.agent);
            const globalFlag = cmdOpts.global ? ["--global"] : [];
            const scope = scopeOf(cmdOpts.global);

            // Exported to the child, never added to its argv. See the file
            // header: argv is readable by every process on the machine, and
            // shipables would not have read the value for these skills anyway.
            const apiKey = getApiKey({ apiKey: ctx.apiKey });
            const warnings = apiKey
              ? []
              : [
                  "No API key is configured, so the installed skill cannot authenticate until you run `senso login` or set SENSO_API_KEY.",
                ];

            if (!ctx.quiet) log.info(`Installing ${String(skillPackages.length)} skill(s)...`);

            const installed: { name: string; package: string }[] = [];
            const failed: { name: string; package: string; reason: string; timedOut: boolean }[] =
              [];

            for (const pkg of skillPackages) {
              try {
                const args = ["install", pkg, ...agentFlags, ...globalFlag, "--yes"];
                relay(ctx, await runShipables(args, { apiKey }), apiKey);

                installed.push({ name: shortName(pkg), package: pkg });
                if (!ctx.quiet) log.success(`Installed ${shortName(pkg)} (${scope})`);
              } catch (err) {
                // One skill failing should not abandon the rest — they are
                // independent installs — so failures are collected and reported
                // together at the end.
                const { reason, timedOut } = childFailure(err, apiKey);
                failed.push({ name: shortName(pkg), package: pkg, reason, timedOut });
                log.error(`Failed to install ${shortName(pkg)}: ${reason}`);
              }
            }

            // Previously every install could fail and the command still exited 0,
            // reporting "Done" — so a CI step that installed skills could not tell
            // whether it had worked.
            //
            // Thrown BEFORE the payload is emitted, so stdout stays empty on a
            // failure like every other command. `details` carries the same
            // structure the success path would have emitted, because "which
            // ones DID install" is the question a partial failure raises.
            if (failed.length > 0) {
              const timedOut = failed.every((f) => f.timedOut);
              throw new CliError(
                `${String(failed.length)} of ${String(skillPackages.length)} skill(s) failed to install: ${failed.map((f) => `${f.name} (${f.reason})`).join("; ")}`,
                timedOut ? EXIT.NETWORK : EXIT.ERROR,
                {
                  code: timedOut ? "timeout" : "error",
                  details: { installed, failed: failed.map(({ timedOut: _t, ...f }) => f), scope },
                  hint: `Retry the ones that failed: \`senso skills install ${failed.map((f) => f.name).join(" ")}\`. SENSO_DEBUG=1 shows the child's full output; \`npm install -g @senso-ai/shipables\` avoids the npx download.`,
                },
              );
            }

            emit(
              ctx,
              { installed, failed, scope, agent: cmdOpts.agent ?? "all detected" },
              {
                warnings,
                next: [
                  { why: "See what this directory now has", command: "senso skills list --output json" },
                ],
              },
            );

            if (!ctx.quiet) {
              log.success("Done. Your agent can now use Senso — just talk to it naturally.");
            }
          },
        ),
      ),
    {
      returns: [
        "installed[] — {name, package} per skill that installed",
        "failed[] — always empty on exit 0; on a failure the same list is in error.details.failed, with a reason each",
        "scope — the directory installed into, or \"global\"",
        "agent — the agent named with --agent, or \"all detected\"",
      ],
      exitCodes: {
        ...localExits,
        1: "shipables failed for at least one skill (error.details says which, and why)",
        2: "an unknown skill name or --agent value; nothing was spawned",
        5: "shipables did not finish within 120 seconds",
      },
      notes: [
        "The API key is NOT written into the installed skill: it is passed to the installer in its environment and never on its command line. The skill calls this CLI, which reads the key from `senso login` or SENSO_API_KEY at the time it runs.",
        "Skills are independent: one failing does not stop the others, but the command still exits non-zero.",
      ],
      examples: [
        { comment: "Every official skill, for Claude Code", command: "senso skills install --all --agent claude" },
        {
          comment: "Two by name, machine-readable",
          command: "senso skills install search ingest --output json | jq -r '.data.installed[].name'",
        },
      ],
      seeAlso: ["senso skills list-available", "senso skills list", "senso skills remove <name>"],
    },
  );

  describeCommand(
    skills
      .command("list")
      .description(
        "List the skills installed for this directory, or for your home directory with --global.",
      )
      .option("--global", "List the home-directory (all projects) scope instead")
      .action(
        runAction(program, async (ctx, cmdOpts: { global?: boolean }) => {
          const globalFlag = cmdOpts.global ? ["--global"] : [];
          const scope = scopeOf(cmdOpts.global);
          let stdout: string;
          try {
            ({ stdout } = await runShipables(["list", ...globalFlag, "--json"]));
          } catch (err) {
            throw new CliError(`shipables could not list skills: ${childFailure(err).reason}`, EXIT.ERROR, {
              hint: "Install the lister once with `npm install -g @senso-ai/shipables`, then retry.",
              cause: err,
            });
          }

          let data: unknown;
          try {
            data = JSON.parse(stdout);
          } catch (err) {
            throw new CliError("shipables did not return valid JSON.", EXIT.ERROR, {
              hint: "Update it with `npm install -g @senso-ai/shipables@latest`, then retry `senso skills list`.",
              cause: err,
            });
          }

          // shipables prints a map keyed by package name, and `{}` for a scope
          // with nothing in it. Rendering that map raw meant an empty project
          // printed a blank line and nothing else — and the "no skills
          // installed" branch, which tested for an empty ARRAY, could never
          // fire. Normalizing to a list makes the empty case sayable.
          const installations = (
            typeof data === "object" && data !== null && !Array.isArray(data) ? data : {}
          ) as Record<string, ShipablesRecord>;
          const skillList = Object.entries(installations).map(([pkg, record]) => ({
            name: shortName(pkg),
            package: pkg,
            version: record.version ?? "",
            agents: record.agents ?? [],
          }));

          const empty = skillList.length === 0;
          const where = cmdOpts.global ? "the global scope" : scope;
          emit(
            ctx,
            { scope, skills: skillList },
            {
              table: { rows: skillList, columns: ["name", "package", "version", "agents"] },
              // Handwritten so that `plain` keeps the scope on the page: the
              // same list means different things in two directories, and the
              // generic list rendering would print only the rows.
              plain: empty
                ? [`  No Senso skills installed in ${where}.`]
                : [
                    `  scope  ${scope}`,
                    "",
                    ...skillList.map(
                      (s, i) =>
                        `  ${String(i + 1)}. ${s.name.padEnd(16)} ${s.package}  ${s.version}  ${s.agents.join(", ")}`,
                    ),
                  ],
              ...(empty
                ? {
                    warnings: [
                      `No skills are installed in ${where}. Skills installed in another project are not shown here${cmdOpts.global ? "" : "; try `senso skills list --global`"}.`,
                    ],
                  }
                : {}),
              next: empty
                ? [{ why: "Install every official skill", command: "senso skills install --all" }]
                : [{ why: "Remove one of them", command: "senso skills remove <name>" }],
            },
          );
        }),
      ),
    {
      returns: [
        "scope — the directory this listing is for, or \"global\"",
        "skills[] — {name (the short name remove takes), package, version, agents[]}",
        "An empty skills[] means nothing is installed in THIS scope; other projects are not shown.",
      ],
      exitCodes: {
        ...localExits,
        1: "shipables could not be run, or did not answer with JSON",
      },
      examples: [
        { command: "senso skills list" },
        {
          comment: "Just the names",
          command: "senso skills list --global --output json | jq -r '.data.skills[].name'",
        },
      ],
      seeAlso: ["senso skills install", "senso skills remove <name>"],
    },
  );

  describeCommand(
    skills
      .command("list-available")
      .description(
        "Show every official Senso skill that `senso skills install` can install. Static and offline: no key, no network, no subprocess.",
      )
      .action(
        runAction(program, (ctx) => {
          const available = SENSO_SKILLS.map((pkg) => ({
            name: shortName(pkg),
            package: pkg,
            description: SKILL_SUMMARY[shortName(pkg)] ?? "",
          }));

          emit(
            ctx,
            { skills: available },
            {
              table: { rows: available, columns: ["name", "package", "description"] },
              next: [
                { why: "Install them all", command: "senso skills install --all" },
                { why: "Install one", command: "senso skills install search" },
              ],
            },
          );
        }),
      ),
    {
      returns: [
        "skills[] — {name (the short name install and remove take), package, description}",
      ],
      exitCodes: { 0: "success" },
      examples: [
        { command: "senso skills list-available" },
        { command: "senso skills list-available --output json | jq -r '.data.skills[].name'" },
      ],
      seeAlso: ["senso skills install"],
    },
  );

  describeCommand(
    skills
      .command("remove")
      .description(
        "Remove one installed Senso skill from this directory, or from your home directory with --global.",
      )
      .argument(
        "<name>",
        "Skill short name (search, ingest, ...) or the package form senso-ai/senso-<name>. `senso skills list` shows what is installed here.",
      )
      .option("--global", "Remove from the home-directory scope")
      .action(
        runAction(program, async (ctx, name: string, cmdOpts: { global?: boolean }) => {
          const pkg = resolveSkillPackage(name, "<name>");
          const globalFlag = cmdOpts.global ? ["--global"] : [];
          const scope = scopeOf(cmdOpts.global);

          try {
            // No `--yes`: shipables' uninstall does not take one and rejects it
            // as an unknown option, so passing it made every `skills remove` exit
            // 1 without removing anything. The install side does take it.
            relay(ctx, await runShipables(["uninstall", pkg, ...globalFlag]));
          } catch (err) {
            const { reason } = childFailure(err);
            // shipables exits non-zero for a skill it has no record of, which is
            // a 404 in every sense that matters: the name was fine, the thing is
            // not there. Reporting it as exit 1 made "not installed" and
            // "shipables is broken" the same answer.
            if (NOT_INSTALLED.test(reason)) {
              throw new CliError(
                `Skill ${shortName(pkg)} (${pkg}) is not installed in ${scope}.`,
                EXIT.NOT_FOUND,
                {
                  code: "not_found",
                  field: "<name>",
                  received: name,
                  hint: `See what is installed with \`senso skills list${cmdOpts.global ? " --global" : ""} --output json\`${cmdOpts.global ? "" : "; add --global if it was installed globally"}.`,
                  cause: err,
                },
              );
            }
            throw new CliError(`Could not remove ${shortName(pkg)}: ${reason}`, EXIT.ERROR, {
              hint: "SENSO_DEBUG=1 shows the child's full output; `npm install -g @senso-ai/shipables` avoids the npx download.",
              cause: err,
            });
          }

          emitConfirmation(
            ctx,
            `Removed skill ${shortName(pkg)} from ${scope}.`,
            {
              action: "removed",
              resource: "skill",
              id: shortName(pkg),
              package: pkg,
              scope,
            },
            { next: [{ why: "See what remains", command: "senso skills list --output json" }] },
          );
        }),
      ),
    {
      returns: [
        "action — always \"removed\"",
        "resource — always \"skill\"",
        "id — the short name that was removed",
        "package, scope — the package name, and the directory (or \"global\") it came out of",
      ],
      exitCodes: {
        ...localExits,
        1: "shipables failed",
        2: "the name is not an official skill",
        4: "the skill is not installed in this scope",
      },
      notes: [
        "A project-level skill has to be removed from the directory it was installed in; --global removes the home-directory copy.",
      ],
      examples: [
        { command: "senso skills remove search" },
        { command: "senso skills remove senso-ai/senso-search --global --output json" },
      ],
      seeAlso: ["senso skills list", "senso uninstall"],
    },
  );
}
