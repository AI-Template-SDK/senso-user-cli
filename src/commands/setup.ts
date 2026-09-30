/**
 * `senso setup` — install the official Senso skills, globally, in one step, and
 * keep them current.
 *
 * A named shortcut for what a first run always wants, and what every later run
 * should converge on:
 *
 *   1. Work out which of the nine are missing or behind the registry, from
 *      shipables' own record and one registry search. A machine that already
 *      has all nine at their latest versions installs nothing and says "up to
 *      date" — an agent can run this at the start of every session.
 *   2. Install those, and only those. The install loop is the one
 *      `skills install` uses, so the two cannot come to mean different things.
 *   3. Only once every install succeeded, remove the retired skills. Removing
 *      first would leave a machine without the replacement if an install then
 *      failed.
 *
 * Global by default is the deliberate part. A skill installed project-level is
 * invisible from the next directory the agent works in, which is the failure
 * mode this command exists to avoid; `--local` is there for the person who
 * genuinely wants one project configured.
 */

import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { CliError, EXIT } from "../lib/errors.js";
import { emit } from "../lib/output.js";
import { runAction, type Ctx } from "../lib/run-action.js";
import * as log from "../utils/logger.js";
import {
  AGENT_SKILL_DIRS,
  RETIRED_SKILLS,
  SENSO_SKILLS,
  installPackages,
  latestVersions,
  listInstalled,
  resolveAgents,
  runShipables,
  shortName,
  type InstalledRecord,
} from "./skills.js";

/**
 * Whether one official skill needs installing: missing, behind the registry,
 * or not yet installed for every agent this run targets.
 *
 * An unknown latest version counts as behind. The cost of being wrong that way
 * is one redundant install; the cost of the other way is a skill that never
 * updates.
 */
function needsInstall(
  record: InstalledRecord | undefined,
  latest: string | undefined,
  agents: string[] | undefined,
): boolean {
  if (!record || !latest || record.version !== latest) return true;
  if (!agents) return false;
  const have = new Set(record.agents ?? []);
  return agents.some((a) => !have.has(a));
}

/**
 * The installed record for a package, under either spelling. A Senso package
 * recorded as `@senso-ai/...` is the same skill.
 */
function recordFor(
  installed: Record<string, InstalledRecord>,
  pkg: string,
): { name: string; record: InstalledRecord } | undefined {
  for (const name of [pkg, `@${pkg}`]) {
    const record = installed[name];
    if (record) return { name, record };
  }
  return undefined;
}

/**
 * Remove one retired skill from this scope: through shipables for every record
 * of it, then by deleting its directory from every agent's skills directory.
 *
 * The second step is not a fallback for the first failing. shipables removes
 * only what it recorded, and exits 4 leaving the files when the record is gone,
 * so a directory it never knew about survives the first step by design.
 * Returns whether anything was there to remove.
 */
async function removeRetired(
  ctx: Ctx,
  pkg: string,
  installed: Record<string, InstalledRecord>,
  global: boolean,
): Promise<boolean> {
  let removed = false;

  for (const name of [pkg, `@${pkg}`]) {
    if (!installed[name]) continue;
    try {
      await runShipables(["uninstall", name, ...(global ? ["--global"] : [])]);
      removed = true;
    } catch (err) {
      // The directory sweep below still runs; say why the record may linger.
      if (!ctx.quiet) {
        log.dim(
          `shipables could not uninstall ${name}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  const base = global ? homedir() : process.cwd();
  const dirName = `senso-${shortName(pkg)}`;
  for (const skillsDir of new Set(Object.values(AGENT_SKILL_DIRS))) {
    const dir = join(base, skillsDir, dirName);
    if (!existsSync(dir)) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      throw new CliError(`Could not remove ${dir}.`, EXIT.ERROR, {
        hint: "The current skills are installed. Delete that directory by hand.",
        cause: err,
      });
    }
    removed = true;
  }

  return removed;
}

export function registerSetupCommands(program: Command): void {
  program
    .command("setup")
    .description(
      "Install the nine official Senso skills globally, for every supported agent (Claude Code, Cursor, Codex, Copilot, Gemini CLI, Cline), and remove retired ones such as evaluate-remediate. Installs only what is missing or out of date; on a machine that is current it changes nothing and says so. Use --local to scope it to the current project instead.",
    )
    .option(
      "--agent <name>",
      "Target a specific agent: claude, cursor, codex, copilot, gemini, cline",
    )
    .option("--global", "Install globally (the default; accepted so the flag is never an error)")
    .option("--local", "Install into the current project instead of globally")
    .action(
      runAction(
        program,
        async (ctx, cmdOpts: { agent?: string; global?: boolean; local?: boolean }) => {
          // Both flags together is a contradiction, not a precedence puzzle.
          // Guessing which one wins would install to the wrong place silently,
          // and a wrongly-scoped install looks exactly like a successful one.
          if (cmdOpts.global === true && cmdOpts.local === true) {
            throw new CliError("--global and --local cannot both be given.", EXIT.USAGE, {
              code: "usage",
              hint: "Omit both for a global install, or pass --local for this project only.",
            });
          }

          const global = cmdOpts.local !== true;
          // Validated before anything is spawned, so a typo costs nothing.
          const agents = resolveAgents(cmdOpts.agent, global);

          // What is already here, and what the registry has. Neither is
          // essential: without them every skill counts as needing an install,
          // which is what this command did before it knew how to skip any.
          let installed: Record<string, InstalledRecord> = {};
          let latest = new Map<string, string>();
          try {
            installed = await listInstalled(global);
            latest = await latestVersions();
          } catch (err) {
            if (!ctx.quiet) {
              log.dim(
                `Could not check installed versions (${err instanceof Error ? err.message : String(err)}); installing all.`,
              );
            }
          }

          const toInstall = SENSO_SKILLS.filter((pkg) =>
            needsInstall(recordFor(installed, pkg)?.record, latest.get(pkg), agents),
          );
          const upToDate = SENSO_SKILLS.filter((pkg) => !toInstall.includes(pkg)).map(shortName);

          const newlyInstalled =
            toInstall.length > 0 ? await installPackages(ctx, toInstall, { agents, global }) : [];

          const removed: string[] = [];
          for (const pkg of RETIRED_SKILLS) {
            if (await removeRetired(ctx, pkg, installed, global)) {
              removed.push(shortName(pkg));
              if (!ctx.quiet) log.success(`Removed retired skill ${shortName(pkg)}`);
            }
          }

          emit(ctx, { installed: newlyInstalled, upToDate, removed, failed: [] });

          if (!ctx.quiet) {
            if (newlyInstalled.length === 0 && removed.length === 0) {
              log.success(`Senso skills are up to date (${SENSO_SKILLS.length} installed).`);
            } else {
              log.success("Done. Your agent can now use Senso — just talk to it naturally.");
            }
          }
        },
      ),
    );
}
