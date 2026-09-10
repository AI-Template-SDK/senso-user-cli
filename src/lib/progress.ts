/**
 * A spinner that cannot corrupt stdout.
 *
 * `@clack/prompts`' spinner writes its frames — and a cursor-hide escape
 * sequence — to stdout, even when stdout is a pipe. For an interactive command
 * that is exactly right; for `senso ingest upload --output json | jq` it puts
 * control characters ahead of the payload and the parse fails. The ESLint rule
 * that guards the output contract cannot see this, because the writes happen
 * inside node_modules.
 *
 * So: a spinner only when there is a person to see it. When output is being
 * consumed by a program, or the caller asked for quiet, or stdout is not a
 * terminal, this degrades to a stderr line and no animation. Same call sites,
 * same messages, no escape sequences on stdout.
 */

import * as p from "@clack/prompts";
import * as log from "../utils/logger.js";

export interface Spinner {
  start: (message: string) => void;
  stop: (message: string) => void;
}

/** True when an animated spinner is safe and useful. */
function interactive(quiet: boolean): boolean {
  return !quiet && process.stdout.isTTY;
}

export function spinner(quiet: boolean): Spinner {
  if (!interactive(quiet)) {
    return {
      start: (message) => {
        if (!quiet) log.info(message);
      },
      stop: (message) => {
        if (!quiet) log.info(message);
      },
    };
  }

  const inner = p.spinner();
  return {
    start: (message) => {
      inner.start(message);
    },
    stop: (message) => {
      inner.stop(message);
    },
  };
}
