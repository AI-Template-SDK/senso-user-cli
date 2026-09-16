/**
 * The bin entry, and the only file allowed to end the process.
 *
 * Everything else throws. lib/run-action.ts catches what a command throws,
 * reports it on stderr in the requested format, and sets `process.exitCode`;
 * this file exists to build the program, run it, and catch the failures that
 * happen outside an action — a bad global flag, a mistyped command, or a bug.
 */

import { createProgram } from "./program.js";
import { ExitSignal } from "./lib/errors.js";
import { reportError, requestedFormat } from "./lib/run-action.js";

const program = createProgram();

async function main(): Promise<void> {
  await program.parseAsync(process.argv);
}

main().catch((err: unknown) => {
  // `--help` and `--version` have already printed everything they mean to say.
  // Reporting here would append a spurious error to a successful run.
  if (err instanceof ExitSignal) {
    process.exit(err.exitCode);
  }

  // An error thrown here is either a usage failure Commander re-threw or a
  // genuine bug. Both are reported through the same path as every other
  // failure, in whichever format the caller asked for.
  const cliError = reportError(err, {
    format: requestedFormat(program, process.argv.slice(2)),
    debug: process.env.SENSO_DEBUG === "1",
  });
  process.exit(cliError.exitCode);
});
