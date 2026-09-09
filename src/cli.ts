/**
 * The bin entry, and the only file allowed to end the process.
 *
 * Everything else throws. lib/run-action.ts catches what a command throws,
 * reports it on stderr in the requested format, and sets `process.exitCode`;
 * this file exists to build the program, run it, and catch the failures that
 * happen outside an action — a bad global flag, or a bug.
 */

import { createProgram } from "./program.js";
import { ExitSignal } from "./lib/errors.js";
import { reportError } from "./lib/run-action.js";

async function main(): Promise<void> {
  await createProgram().parseAsync(process.argv);
}

main().catch((err: unknown) => {
  // `--help` and `--version` have already printed everything they mean to say.
  // Reporting here would append a spurious error to a successful run.
  if (err instanceof ExitSignal) {
    process.exit(err.exitCode);
  }

  // Nothing above this point has a resolved context, so report in the default
  // format. An error thrown here is either a usage failure Commander re-threw
  // or a genuine bug, and both want a plain sentence on stderr.
  const cliError = reportError(err, { format: "plain", debug: process.env.SENSO_DEBUG === "1" });
  process.exit(cliError.exitCode);
});
