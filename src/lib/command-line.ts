/**
 * Rebuilding the command line that produced this invocation.
 *
 * Every "next page" and "next step" the CLI offers has to be a command the
 * caller can actually run. A hint that says `--offset 50` without the filters
 * the caller already typed sends an agent to a different result set than the
 * one it was paging through, which is worse than saying nothing.
 *
 * So rather than guessing from a template, this reconstructs the invocation
 * from Commander's own record of it: the command path, the operands, and every
 * option whose value came from the command line rather than from a default.
 * `getOptionValueSource` is what makes that exact — it distinguishes a value the
 * user typed from one that is merely declared.
 *
 * Reading `process.argv` would be simpler and wrong: the in-process test suite
 * drives `createProgram()` directly, so argv there belongs to the test runner.
 */

import type { Command } from "commander";

/** "kb my-files" — the command path without the program name. */
export function commandPath(cmd: Command): string {
  const parts: string[] = [];
  let node: Command = cmd;
  while (node.parent !== null) {
    parts.unshift(node.name());
    node = node.parent;
  }
  return parts.join(" ");
}

/** Single-quote anything a shell would otherwise split or interpret. */
function shellQuote(value: string): string {
  if (value !== "" && !/[^\w@%+=:,./-]/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function flagFor(cmd: Command, attribute: string): string | undefined {
  for (const opt of cmd.options) {
    if (opt.attributeName() === attribute) return opt.long ?? opt.short ?? undefined;
  }
  return undefined;
}

function renderOption(flag: string, value: unknown): string[] {
  if (value === undefined || value === null || value === false) return [];
  if (value === true) return [flag];
  if (Array.isArray(value)) {
    // Variadic options are declared `--content-ids <ids...>` and read back as an
    // array; they are re-sent space-separated, the way they were typed.
    const items = value
      .filter((v) => v !== undefined && v !== null)
      .map((v) => shellQuote(typeof v === "string" ? v : JSON.stringify(v)));
    return items.length > 0 ? [flag, ...items] : [];
  }
  if (typeof value === "string") return [flag, shellQuote(value)];
  if (typeof value === "number" || typeof value === "bigint")
    return [flag, shellQuote(String(value))];
  // A --data object, round-tripped so the rebuilt line stays runnable.
  return [flag, shellQuote(JSON.stringify(value))];
}

/**
 * The full command line, with `overrides` applied.
 *
 * `overrides` is keyed by Commander attribute name (`offset`, not `--offset`).
 * A key the command does not declare is skipped rather than invented, so a
 * caller cannot produce a flag the command would reject.
 */
export function commandLine(
  cmd: Command,
  overrides: Record<string, string | number | boolean | undefined> = {},
): string {
  const tokens: string[] = ["senso", ...commandPath(cmd).split(" ").filter(Boolean)];

  for (const operand of cmd.args) {
    tokens.push(shellQuote(operand));
  }

  const seen = new Set<string>();
  for (const opt of cmd.options) {
    const attribute = opt.attributeName();
    const flag = opt.long ?? opt.short;
    if (!flag) continue;
    seen.add(attribute);

    const value = attribute in overrides ? overrides[attribute] : readTypedValue(cmd, attribute);
    if (value === undefined) continue;

    // A `--no-x` option stores true by default and false when passed, so the
    // flag itself is emitted only for the false case.
    if (opt.negate) {
      if (value === false) tokens.push(flag);
      continue;
    }
    tokens.push(...renderOption(flag, value));
  }

  // An override for a flag the command declares but that was never set above
  // (because it had no value) still has to appear.
  for (const [attribute, value] of Object.entries(overrides)) {
    if (seen.has(attribute)) continue;
    const flag = flagFor(cmd, attribute);
    if (flag) tokens.push(...renderOption(flag, value));
  }

  return tokens.join(" ");
}

/** The option's value, but only when the caller actually supplied it. */
function readTypedValue(cmd: Command, attribute: string): unknown {
  return cmd.getOptionValueSource(attribute) === "cli" ? cmd.getOptionValue(attribute) : undefined;
}

/** True when the command declares a flag, so a hint can mention it honestly. */
export function hasOption(cmd: Command, attribute: string): boolean {
  return cmd.options.some((o) => o.attributeName() === attribute);
}
