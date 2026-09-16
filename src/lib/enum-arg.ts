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
 * values named in the message AND in `error.allowed`, so an agent can read the
 * accepted set out of the JSON rather than parsing it out of a sentence.
 */

import { usageError } from "./errors.js";

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

  throw usageError(`Invalid ${flag}: "${value}".`, {
    field: flag,
    received: value,
    allowed,
    hint: `Must be one of: ${allowed.join(", ")}.`,
  });
}

/**
 * The same check for a value that must be present.
 *
 * A required flag Commander has already enforced still needs its value checked,
 * and the error for "missing" should name the same accepted set as the error
 * for "wrong".
 */
export function requireEnumFlag<T extends string>(
  flag: string,
  value: string | undefined,
  allowed: readonly T[],
): T {
  const parsed = parseEnumFlag(flag, value, allowed);
  if (parsed === undefined) {
    throw usageError(`Missing ${flag}.`, {
      field: flag,
      allowed,
      hint: `Must be one of: ${allowed.join(", ")}.`,
    });
  }
  return parsed;
}

/**
 * Every value of a repeatable or comma-separated flag, each checked.
 *
 * Returns `undefined` for an omitted flag so it can be spread into a query
 * without sending an empty parameter.
 */
export function parseEnumList<T extends string>(
  flag: string,
  values: string[] | undefined,
  allowed: readonly T[],
): T[] | undefined {
  if (values === undefined || values.length === 0) return undefined;
  return values.map((v) => requireEnumFlag(flag, v, allowed));
}

/**
 * A flag that must be a whole number, optionally within a range.
 *
 * `Number("high")` is NaN and `JSON.stringify(NaN)` is `null`, so an unchecked
 * numeric flag did not fail — it sent `null` and cleared the field the user was
 * trying to set. A value outside the range is rejected rather than clamped:
 * `--max-results 999` quietly becoming 20 is a different search than the one
 * the caller asked for, and nothing in the output said so.
 */
export function parseIntFlag(
  flag: string,
  value: string | undefined,
  range?: { min?: number; max?: number },
): number | undefined {
  if (value === undefined) return undefined;

  const n = Number(value);
  if (!Number.isInteger(n)) {
    throw usageError(`Invalid ${flag}: "${value}" is not a whole number.`, {
      field: flag,
      received: value,
    });
  }
  const { min, max } = range ?? {};
  if ((min !== undefined && n < min) || (max !== undefined && n > max)) {
    throw usageError(
      `Invalid ${flag}: ${String(n)} is out of range (${String(min ?? "-∞")} to ${String(max ?? "∞")}).`,
      {
        field: flag,
        received: value,
        hint: `Must be between ${String(min ?? "-∞")} and ${String(max ?? "∞")}.`,
      },
    );
  }
  return n;
}

/** `YYYY-MM-DD`, which is what the analytics and industries endpoints take. */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** RFC 3339 with an offset, which is what the evals endpoints take. */
const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * A calendar date.
 *
 * Named separately from `parseInstantFlag` because this API takes both forms
 * under the same flag names: `--from`/`--to` are `YYYY-MM-DD` on analytics and
 * industries, and RFC 3339 instants on evals. A caller who assumes one and gets
 * the other should learn it from exit 2, not from a 400.
 */
export function parseDateFlag(flag: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!DATE_RE.test(trimmed) || Number.isNaN(Date.parse(trimmed))) {
    throw usageError(`Invalid ${flag}: "${value}" is not a YYYY-MM-DD date.`, {
      field: flag,
      received: value,
      hint: "Use a calendar date, e.g. 2026-09-01. (`senso evals` takes full RFC 3339 instants instead.)",
    });
  }
  return trimmed;
}

/** An RFC 3339 instant, with the time zone that makes it unambiguous. */
export function parseInstantFlag(flag: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!INSTANT_RE.test(trimmed) || Number.isNaN(Date.parse(trimmed))) {
    throw usageError(`Invalid ${flag}: "${value}" is not an RFC 3339 instant.`, {
      field: flag,
      received: value,
      hint: "Use a full timestamp with a time zone, e.g. 2026-09-01T00:00:00Z. (`senso analytics` takes YYYY-MM-DD instead.)",
    });
  }
  return trimmed;
}

/** `--from` must not be after `--to`; the API answers an inverted window with nothing. */
export function assertRange(
  fromFlag: string,
  from: string | undefined,
  toFlag: string,
  to: string | undefined,
  opts: { maxDays?: number } = {},
): void {
  if (from === undefined || to === undefined) return;
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (start > end) {
    throw usageError(`${fromFlag} (${from}) is after ${toFlag} (${to}).`, {
      field: fromFlag,
      received: from,
      hint: `Swap them, or widen the window: ${fromFlag} must be on or before ${toFlag}.`,
    });
  }
  const days = (end - start) / 86_400_000;
  if (opts.maxDays !== undefined && days > opts.maxDays) {
    throw usageError(
      `The window ${from}..${to} is ${String(Math.round(days))} days; the maximum is ${String(opts.maxDays)}.`,
      {
        field: fromFlag,
        received: `${from}..${to}`,
        hint: `Request at most ${String(opts.maxDays)} days at a time.`,
      },
    );
  }
}
