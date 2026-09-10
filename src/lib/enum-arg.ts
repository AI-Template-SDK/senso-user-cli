/**
 * Validation for flags that accept one of a fixed set of values.
 *
 * Several commands documented a closed set in their help text and then forwarded
 * whatever string they were given: `--match-type regex`, `--tier gold`,
 * `--status archived`, `--sort whenever`. Each of those cost a round trip to the
 * API and came back as a server-side validation error, or worse — for
 * `generated-content --status`, an unrecognized value silently fell through to
 * "published", so a typo returned a plausible-looking wrong list.
 *
 * Checking here makes a typo exit 2 before any request is made, with the valid
 * values named. `destinations` already did this by hand; this is that behavior,
 * shared.
 */

import { CliError, EXIT } from "./errors.js";

/**
 * Returns `value` when it is one of `allowed`, and raises a usage error when it
 * is not. `undefined` passes through — an omitted optional flag is not an error.
 */
export function parseEnumFlag<T extends string>(
  flag: string,
  value: string | undefined,
  allowed: readonly T[],
): T | undefined {
  if (value === undefined) return undefined;

  // Case-insensitive on the way in, canonical on the way out: the API wants the
  // lowercase form, and rejecting `--tier PRIMARY` would be pedantry.
  const normalized = value.trim().toLowerCase();
  const match = allowed.find((a) => a.toLowerCase() === normalized);
  if (match) return match;

  throw new CliError(`Invalid ${flag}: "${value}".`, EXIT.USAGE, {
    code: "usage",
    hint: `Must be one of: ${allowed.join(", ")}.`,
  });
}

/**
 * A flag that must be a whole number, optionally within a range.
 *
 * `Number("high")` is NaN and `JSON.stringify(NaN)` is `null`, so an unchecked
 * numeric flag did not fail — it sent `null` and cleared the field the user was
 * trying to set.
 */
export function parseIntFlag(
  flag: string,
  value: string | undefined,
  range?: { min?: number; max?: number },
): number | undefined {
  if (value === undefined) return undefined;

  const n = Number(value);
  if (!Number.isInteger(n)) {
    throw new CliError(`Invalid ${flag}: "${value}" is not a whole number.`, EXIT.USAGE, {
      code: "usage",
    });
  }
  const { min, max } = range ?? {};
  if ((min !== undefined && n < min) || (max !== undefined && n > max)) {
    throw new CliError(`Invalid ${flag}: ${String(n)} is out of range.`, EXIT.USAGE, {
      code: "usage",
      hint: `Must be between ${String(min ?? "-∞")} and ${String(max ?? "∞")}.`,
    });
  }
  return n;
}
