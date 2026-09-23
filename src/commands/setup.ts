/**
 * `senso setup` — install every official Senso skill, globally, in one step.
 *
 * A named shortcut for what a first run always wants:
 *
 *   senso skills install quickstart context-layer evaluate-remediate \
 *     generate-verify publish --global
 *
 * It exists because that line is the first thing anyone runs and the last thing
 * anyone can remember. Nothing here is a second implementation — the package
 * list and the install loop both come from commands/skills.ts, so `setup` and
 * `skills install --all` cannot come to mean different things.
 *
 * Global by default is the deliberate part. A skill installed project-level is
 * invisible from the next directory the agent works in, which is the failure
 * mode this command exists to avoid; `--local` is there for the person who
 * genuinely wants one project configured.
 */

import { Command } from "commander";
import { CliError, EXIT } from "../lib/errors.js";
import { runAction } from "../lib/run-action.js";
import { SENSO_SKILLS, installSkills } from "./skills.js";

export function registerSetupCommands(program: Command): void {
  program
    .command("setup")
    .description(
      "Install every official Senso skill globally, so any AI coding agent on this machine knows how to use Senso. Equivalent to 'senso skills install --all --global'. Use --local to scope the install to the current project instead.",
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

          await installSkills(ctx, [...SENSO_SKILLS], {
            agent: cmdOpts.agent,
            global: cmdOpts.local !== true,
          });
        },
      ),
    );
}
