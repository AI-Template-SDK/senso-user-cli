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
 * Skills are discovered from shipables' own record of what it installed rather
 * than from `shipables list`, for two reasons. `list` sees only the current
 * directory and the global scope, so a skill installed in another project
 * would be missed; and reading a file first means a machine that never
 * installed a skill never has to download shipables through npx just to be
 * told there is nothing to do.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, rmdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { clearConfig, getConfigDir, getConfigPath } from "../lib/config.js";
import { CliError, EXIT } from "../lib/errors.js";
import { emitConfirmation } from "../lib/output.js";
import { runAction } from "../lib/run-action.js";
import * as log from "../utils/logger.js";
import { SENSO_SKILL_PREFIX, runShipables, shortName } from "./skills.js";

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
  program
    .command("uninstall")
    .description(
      "Remove this CLI, the Senso agent skills it installed, and the stored API key. Asks first unless --yes is passed.",
    )
    .option("-y, --yes", "Skip the confirmation prompt (required when there is no terminal)")
    .option("--dry-run", "Report what would be removed without removing anything")
    .option("--keep-skills", "Leave the installed agent skills alone")
    .option("--keep-config", "Leave the stored API key and organization info alone")
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

        if (apiKeyInEnvironment) {
          log.warn(
            "SENSO_API_KEY is set in this shell's environment. Uninstalling cannot unset it; remove it from your shell profile or CI configuration yourself.",
          );
        }

        if (cmdOpts.dryRun) {
          emitConfirmation(ctx, "Dry run: nothing was removed.", {
            action: "planned",
            resource: "installation",
            dryRun: true,
            skills: skills.map((s) => ({
              name: shortName(s.name),
              package: s.name,
              scope: s.scope,
            })),
            config: { path: configPath, present: configPresent, apiKeyInEnvironment },
            cli: { package: NPM_PACKAGE },
          });
          return;
        }

        if (!cmdOpts.yes) {
          // Without a terminal there is nobody to answer, and clack would wait
          // on a keypress that never arrives. An agent passes --yes.
          if (!process.stdin.isTTY) {
            throw new CliError("`senso uninstall` needs confirmation.", EXIT.USAGE, {
              code: "usage",
              hint: "Pass --yes to confirm without a prompt, or --dry-run to see what would be removed.",
            });
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
            },
          );
        }

        // 2. Credentials.
        if (!cmdOpts.keepConfig) {
          removeConfig();
          if (!ctx.quiet && configPresent) log.success(`Removed ${configPath}`);
        }

        // 3. The CLI itself. npm's output is the only useful thing to watch
        // while it runs, so it inherits the terminal as `update` does.
        try {
          execSync(`npm uninstall -g ${NPM_PACKAGE}`, { stdio: "inherit" });
        } catch (err) {
          throw new CliError("Removing the CLI failed.", EXIT.ERROR, {
            hint: `Skills and credentials were removed. Finish by hand: npm uninstall -g ${NPM_PACKAGE}`,
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
            },
          );
        }

        emitConfirmation(ctx, "Senso CLI removed.", {
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
          cli: { removed: true, package: NPM_PACKAGE },
        });

        if (!ctx.quiet) {
          log.raw(`  ${pc.dim(`Reinstall any time: npm install -g ${NPM_PACKAGE}`)}`);
        }
      }),
    );
}
