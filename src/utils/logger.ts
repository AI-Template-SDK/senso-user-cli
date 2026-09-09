/**
 * Diagnostics. Everything here goes to stderr, without exception.
 *
 * The split is the whole point: lib/output.ts owns stdout and prints the
 * payload; this module prints everything a human wants to see alongside it —
 * progress, warnings, failures, hints. Keeping them on separate streams is what
 * lets `senso ... --output json | jq` work, and what lets `2>/dev/null` silence
 * the commentary without losing the data.
 *
 * ESLint permits `console.*` in this file and two others, and nowhere else.
 */

import pc from "picocolors";

export function success(msg: string): void {
  console.error(`  ${pc.green("✓")} ${msg}`);
}

export function error(msg: string): void {
  console.error(`  ${pc.red("✗")} ${msg}`);
}

export function warn(msg: string): void {
  console.error(`  ${pc.yellow("!")} ${msg}`);
}

export function info(msg: string): void {
  console.error(`  ${pc.cyan("ℹ")} ${msg}`);
}

export function dim(msg: string): void {
  console.error(pc.dim(`  ${msg}`));
}

/**
 * The second line of an error: what the reader can do about it.
 *
 * Indented under the ✗ rather than given its own marker, so a failure reads as
 * one block instead of two unrelated events.
 */
export function hint(msg: string): void {
  console.error(`    ${pc.dim(msg)}`);
}

/** Unadorned line on stderr. For JSON error payloads and debug output. */
export function raw(msg: string): void {
  console.error(msg);
}
