/**
 * `senso uninstall`: remove this CLI and everything it put on the machine.
 *
 * Three things, in an order chosen so that a failure leaves the user with the
 * tool to retry:
 *
 *   1. The Senso agent skills, wherever `senso skills install` put them. Done
 *      first, because it needs shipables and is the step most likely to fail —
 *      and if it does, the CLI is still installed to run again.
 *   2. The config file, which holds the API key. `logout`, plus removing the
 *      directory if nothing else is in it.
 *   3. The npm package itself. Last, because after this there is no `senso`.
 *
 * npm's own log is captured and relayed to stderr, never inherited: see the
 * note on `runNpm` in update.ts. stdout carries the payload and nothing else.
 *
 * Skills are discovered from shipables' own record of what it installed rather
 * than from `shipables list`, for two reasons. `list` sees only the current
 * directory and the global scope, so a skill installed in another project
 * would be missed; and reading a file first means a machine that never
 * installed a skill never has to download shipables through npx just to be
 * told there is nothing to do.
 */

import { existsSync, readFileSync, rmdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { clearConfig, getConfigDir, getConfigPath } from "../lib/config.js";
import { CliError, EXIT } from "../lib/errors.js";
import { describeCommand, localExits } from "../lib/help.js";
import { emitConfirmation } from "../lib/output.js";
import { runAction } from "../lib/run-action.js";
import * as log from "../utils/logger.js";
import { SENSO_SKILL_PREFIX, runShipables, shortName } from "./skills.js";
// npm's log is captured and relayed to stderr rather than inherited, for the
// reason set out in update.ts: with `stdio: "inherit"` npm writes to THIS
// process's stdout and `--output json` stops being one document.
import { npmFailureOutput, runNpm } from "./update.js";

const NPM_PACKAGE = "@senso-ai/cli";

/** How shipables 0.1.x records an install: `~/.shipables/installed.json`. */
interface ShipablesInstalledFile {
  installations?: Record<string, Record<string, unknown>>;
}

/** The key shipables uses for skills installed with `--global`. */
const SHIPABLES_GLOBAL_SCOPE = "__global__";

/** One installed Senso skill, and where shipables installed it. */
export interface InstalledSkill {
  name: string;
  /** "global", or the absolute path of the project it was installed in. */
  scope: string;
}

/**
 * Resolved per call rather than at module load: `homedir()` reads the
 * environment, and the tests point it at a temporary directory.
 */
function shipablesInstalledPath(): string {
  return join(homedir(), ".shipables", "installed.json");
}

/**
 * Every Senso skill shipables has a record of, in every scope.
 *
 * A missing or unreadable file means shipables has never installed anything
 * here, which is the normal case on a machine that only ever used the CLI.
 */
export function findInstalledSensoSkills(): InstalledSkill[] {
  let parsed: ShipablesInstalledFile;
  try {
    parsed = JSON.parse(readFileSync(shipablesInstalledPath(), "utf-8")) as ShipablesInstalledFile;
  } catch {
    return [];
  }

  const found: InstalledSkill[] = [];
  for (const [projectPath, skills] of Object.entries(parsed.installations ?? {})) {
    for (const name of Object.keys(skills)) {
      if (!name.startsWith(SENSO_SKILL_PREFIX)) continue;
      found.push({
        name,
        scope: projectPath === SHIPABLES_GLOBAL_SCOPE ? "global" : projectPath,
      });
    }
  }
  return found;
}

function describeScope(skill: InstalledSkill): string {
  return skill.scope === "global" ? "global" : `in ${skill.scope}`;
}

/** Remove one skill through shipables, from the scope it was installed in. */
async function removeSkill(skill: InstalledSkill, quiet: boolean): Promise<void> {
  const args =
    skill.scope === "global" ? ["uninstall", skill.name, "--global"] : ["uninstall", skill.name];
  const { stdout, stderr } = await runShipables(
    args,
    skill.scope === "global" ? {} : { cwd: skill.scope },
  );
  // shipables' own commentary belongs on stderr with the rest of ours.
  if (!quiet) {
    if (stdout.trim()) log.raw(stdout.trim());
    if (stderr.trim()) log.raw(stderr.trim());
  }
}

/**
 * Remove the config file, then the directory if it is now empty.
 *
 * Never recursive. `SENSO_CONFIG_DIR` can point anywhere, including somewhere
 * the user keeps other things, and an uninstall must not take those with it.
 */
function removeConfig(): void {
  clearConfig();
  try {
    rmdirSync(getConfigDir());
  } catch {
    // Not empty, or already gone. Either way it is not ours to force.
  }
}

/**
 * The file Node is running this CLI from.
 *
 * After `npm uninstall -g` this path should be gone. If it is still there, this
 * copy of the CLI was not the global npm install — it came from npx, a checkout,
 * or another package manager — and saying "removed" would be untrue.
 */
function runningBinaryPath(): string | undefined {
  return process.argv[1];
}

interface UninstallOptions {
  yes?: boolean;
  dryRun?: boolean;
  keepSkills?: boolean;
  keepConfig?: boolean;
}

export function registerUninstallCommand(program: Command): void {
  describeCommand(
    program
      .command("uninstall")
      .description(
        "Remove everything this CLI put on the machine: the Senso agent skills, the stored API key, then the npm package itself — in that order, so a failure leaves you the CLI to retry with. Local: nothing is sent to the Senso API. Asks for confirmation on a terminal; without one, --yes is required.",
      )
      .option(
        "-y, --yes",
        "Confirm without a prompt. REQUIRED when there is no terminal (CI, an agent): without it the command exits 2 rather than waiting on a keypress that never comes",
      )
      .option("--dry-run", "Print the plan as a payload and remove nothing. Needs no --yes")
      .option("--keep-skills", "Leave the installed agent skills alone (step 1 is skipped)")
      .option(
        "--keep-config",
        "Leave the stored API key and organization info alone (step 2 is skipped)",
      )
      .action(
        runAction(program, async (ctx, cmdOpts: UninstallOptions) => {
          const skills = cmdOpts.keepSkills ? [] : findInstalledSensoSkills();
          const configPath = getConfigPath();
          const configPresent = !cmdOpts.keepConfig && existsSync(configPath);
          const apiKeyInEnvironment = Boolean(process.env.SENSO_API_KEY);

          if (!ctx.quiet) {
            log.info("This will remove:");
            for (const skill of skills) {
              log.raw(`    skill ${shortName(skill.name)} (${describeScope(skill)})`);
            }
            if (skills.length === 0 && !cmdOpts.keepSkills) {
              log.raw(`    ${pc.dim("no agent skills are installed")}`);
            }
            if (configPresent) {
              log.raw(`    ${configPath}`);
            } else if (!cmdOpts.keepConfig) {
              log.raw(`    ${pc.dim("no stored credentials")}`);
            }
            log.raw(`    ${NPM_PACKAGE} (npm uninstall -g)`);
            log.raw("");
          }

          // Carried in the envelope rather than only printed: under --output json
          // stderr is silent, and "your key is still in the environment" is
          // precisely the kind of thing an agent has to be able to read.
          const warnings = apiKeyInEnvironment
            ? [
                "SENSO_API_KEY is set in this shell's environment. Uninstalling cannot unset it; remove it from your shell profile or CI configuration yourself.",
              ]
            : [];

          if (cmdOpts.dryRun) {
            emitConfirmation(
              ctx,
              "Dry run: nothing was removed.",
              {
                action: "planned",
                resource: "installation",
                dryRun: true,
                skills: skills.map((s) => ({
                  name: shortName(s.name),
                  package: s.name,
                  scope: s.scope,
                })),
                config: { path: configPath, present: configPresent, apiKeyInEnvironment },
                // `path` is the file this process is running from. When it is not
                // inside npm's global directory, `npm uninstall -g` will not
                // remove it — see the check after the uninstall below.
                cli: { package: NPM_PACKAGE, path: runningBinaryPath() ?? null },
              },
              {
                warnings,
                next: [{ why: "Remove everything listed", command: "senso uninstall --yes" }],
              },
            );
            return;
          }

          if (!cmdOpts.yes) {
            // Without a terminal there is nobody to answer, and clack would wait
            // on a keypress that never arrives. An agent passes --yes.
            if (!process.stdin.isTTY) {
              throw new CliError(
                "`senso uninstall` needs confirmation, and there is no terminal to ask on.",
                EXIT.USAGE,
                {
                  code: "usage",
                  hint: "Pass --yes to confirm without a prompt, or --dry-run --output json to see what would be removed.",
                },
              );
            }
            const confirmed = await p.confirm({
              message: "Remove the Senso CLI, its skills and the stored API key?",
              initialValue: false,
            });
            if (p.isCancel(confirmed) || confirmed !== true) {
              p.cancel("Uninstall canceled. Nothing was removed.");
              return;
            }
          }

          // 1. Skills. Independent removals, so one failing does not abandon the
          // rest — but any failure stops the uninstall before the CLI goes, since
          // the CLI is what the user would retry with.
          const removedSkills: InstalledSkill[] = [];
          const skippedSkills: { skill: InstalledSkill; reason: string }[] = [];
          const failedSkills: { skill: InstalledSkill; reason: string }[] = [];

          for (const skill of skills) {
            if (skill.scope !== "global" && !existsSync(skill.scope)) {
              // The project directory is gone, and the skill files with it.
              // shipables would fail to start there, so there is nothing to run.
              skippedSkills.push({ skill, reason: "project directory no longer exists" });
              if (!ctx.quiet) {
                log.warn(
                  `Skipped ${shortName(skill.name)} (${describeScope(skill)}): the project directory no longer exists.`,
                );
              }
              continue;
            }
            try {
              await removeSkill(skill, ctx.quiet);
              removedSkills.push(skill);
              if (!ctx.quiet)
                log.success(`Removed skill ${shortName(skill.name)} (${describeScope(skill)})`);
            } catch (err) {
              const reason = err instanceof Error ? err.message : String(err);
              failedSkills.push({ skill, reason });
              log.error(
                `Failed to remove ${shortName(skill.name)} (${describeScope(skill)}): ${reason}`,
              );
            }
          }

          if (failedSkills.length > 0) {
            throw new CliError(
              `${failedSkills.length} of ${skills.length} skill(s) could not be removed. The CLI and your credentials were left in place.`,
              EXIT.ERROR,
              {
                hint: `Failed: ${failedSkills.map((f) => shortName(f.skill.name)).join(", ")}. Re-run with SENSO_DEBUG=1 to see why, remove them with \`senso skills remove\`, or pass --keep-skills to uninstall without them.`,
                details: {
                  skills: {
                    removed: removedSkills.map((s) => ({
                      name: shortName(s.name),
                      scope: s.scope,
                    })),
                    failed: failedSkills.map((f) => ({
                      name: shortName(f.skill.name),
                      scope: f.skill.scope,
                      reason: f.reason,
                    })),
                  },
                  config: { removed: false },
                  cli: { removed: false, package: NPM_PACKAGE },
                },
              },
            );
          }

          // 2. Credentials.
          if (!cmdOpts.keepConfig) {
            removeConfig();
            if (!ctx.quiet && configPresent) log.success(`Removed ${configPath}`);
          }

          // 3. The CLI itself. npm's log is relayed to stderr, as `update` does:
          // inheriting stdout would put a page of npm output in front of the
          // payload under --output json.
          try {
            runNpm(`npm uninstall -g ${NPM_PACKAGE}`, ctx.quiet);
          } catch (err) {
            throw new CliError("Removing the CLI failed.", EXIT.ERROR, {
              hint: `Skills and credentials were removed. Finish by hand: npm uninstall -g ${NPM_PACKAGE}`,
              details: { npm: npmFailureOutput(err, ctx.quiet) },
              cause: err,
            });
          }

          const binary = runningBinaryPath();
          if (binary && existsSync(binary)) {
            // npm exited 0 but this file is still here, so npm did not own it.
            // Reporting "removed" would be false, and the path says where to look.
            throw new CliError(
              "This copy of the CLI was not installed globally with npm.",
              EXIT.ERROR,
              {
                hint: `Skills and credentials were removed. Delete the CLI the way it was installed. It is running from: ${binary}`,
                details: {
                  config: { removed: !cmdOpts.keepConfig && configPresent },
                  cli: { removed: false, package: NPM_PACKAGE, path: binary },
                },
              },
            );
          }

          emitConfirmation(
            ctx,
            "Senso CLI removed.",
            {
              action: "removed",
              resource: "installation",
              skills: {
                removed: removedSkills.map((s) => ({
                  name: shortName(s.name),
                  package: s.name,
                  scope: s.scope,
                })),
                skipped: skippedSkills.map((s) => ({
                  name: shortName(s.skill.name),
                  package: s.skill.name,
                  scope: s.skill.scope,
                  reason: s.reason,
                })),
              },
              config: {
                removed: !cmdOpts.keepConfig && configPresent,
                path: configPath,
                apiKeyInEnvironment,
              },
              cli: { removed: true, package: NPM_PACKAGE, path: binary ?? null },
            },
            { warnings },
          );

          if (!ctx.quiet) {
            log.raw(`  ${pc.dim(`Reinstall any time: npm install -g ${NPM_PACKAGE}`)}`);
          }
        }),
      ),
    {
      returns: [
        "dryRun — present and true only under --dry-run, where the payload is a PLAN and nothing was touched.",
        "skills.removed[] / skills.skipped[] — {name, package, scope} per skill, and `reason` on a skipped one (its project directory is gone). Under --dry-run this is a flat skills[] of what would be removed.",
        "config.removed — whether the file holding the API key was deleted. Under --dry-run the field is `present` instead: whether there is one to delete.",
        "config.path — where that file is, whether or not it was removed.",
        "config.apiKeyInEnvironment — true when SENSO_API_KEY is set in this shell. The CLI CANNOT unset it: the key still works after this command, and that is also reported as a warning.",
        "cli.removed, cli.package — whether npm removed @senso-ai/cli.",
        "cli.path — the file this process is running from. Under --dry-run it is the way to tell in advance whether `npm uninstall -g` owns this copy.",
        "npm's own log goes to stderr, never stdout, so --output json stays one document.",
      ],
      exitCodes: {
        ...localExits,
        1: "a skill could not be removed (the CLI and the key were left in place), npm refused the uninstall, or this copy was not npm's global install — in that last case the skills and the key are already gone",
        2: "no --yes and no terminal to ask on; nothing was removed",
      },
      notes: [
        "Three steps, in this order: (1) every senso-ai/senso-* skill shipables has a record of, from the scope it was installed in; (2) the config file holding the API key, and its directory if that is then empty; (3) the npm package. A skill that cannot be removed stops the command BEFORE steps 2 and 3, so you still have the CLI to retry with.",
        "Without a terminal this exits 2 rather than waiting on a prompt nobody can answer. An agent passes --yes, or --dry-run to see the plan first.",
        "--dry-run needs no --yes, removes nothing, and returns the whole plan as the payload.",
        "Skills are found in shipables' own record (~/.shipables/installed.json), so the plan can name a senso-ai/senso-* skill that something other than this CLI installed.",
        "If this copy of the CLI is not the global npm install — npx, a checkout, another package manager — npm exits 0 without removing it and the command exits 1 naming the path. The skills and the stored key are gone by then; check cli.path with --dry-run first.",
        "This cannot be undone, but it is not destructive beyond Senso's own files: reinstall with `npm install -g @senso-ai/cli`, then `senso login`.",
      ],
      examples: [
        {
          comment: "What would go, as a payload, without touching anything",
          command: "senso uninstall --dry-run --output json",
        },
        { comment: "The whole thing, unattended", command: "senso uninstall --yes" },
        {
          comment: "Keep the stored key for a later reinstall",
          command: "senso uninstall --yes --keep-config",
        },
        {
          comment: "Remove the CLI but leave the agent skills in place",
          command: "senso uninstall --yes --keep-skills",
        },
      ],
      seeAlso: ["senso skills remove", "senso logout", "senso update"],
    },
  );
}
