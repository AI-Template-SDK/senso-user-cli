/**
 * The option builders and query-parameter mapping shared by the subcommands.
 *
 * Separated from render.ts because this is the input half of the contract: the
 * flags a caller may pass, the exact wording of their help text, and the API
 * parameter each one maps to. Every subcommand that accepts a window must
 * accept it in the same words, or the flags stop being learnable.
 */

import { Command } from "commander";
import { assertRange, parseDateFlag, parseEnumFlag, parseIntFlag } from "../../lib/enum-arg.js";
import { CliError, EXIT, usageError } from "../../lib/errors.js";

// ---------------------------------------------------------------------------
// Shared filter options
// ---------------------------------------------------------------------------

/**
 * The longest window the API will answer. Enforced here so a 366-day request
 * costs exit 2 rather than a round trip and a 400 the caller has to read.
 * `senso industries` caps the same flags at 90 days — a different endpoint
 * family, a different limit, which is why the number is not shared.
 */
export const MAX_WINDOW_DAYS = 365;

/**
 * Every model id the API accepts in `--models`, as a fixed allow-list.
 *
 * The set is knowable and small (supportedRunModelsList in the API), and it is
 * discoverable nowhere else in the CLI: `senso analytics filters` lists only
 * the ids that already HAVE data, and it prints display names beside them —
 * "Google AI Overviews" is not a value this flag accepts. Checking here turns
 * a typo into exit 2 with the accepted set in `error.allowed`, instead of a
 * 400 the caller sees as exit 1.
 */
export const MODEL_VALUES = [
  "gpt-4.1",
  "chatgpt",
  "perplexity",
  "aioverview",
  "gemini",
  "linkup",
  "claude-sonnet-4-6",
  "grok",
] as const;

/** Where an agent reads the ids that have data, for every `--models` hint. */
export const MODELS_HINT =
  "senso analytics filters --output json | jq -r '.data.models[].id' lists the ids with data.";

/**
 * Checks a comma-separated `--models` value against the allow-list.
 *
 * `parseEnumFlag` cannot do this: the flag is one string holding many values,
 * and every bad member should be named at once rather than one per round trip.
 */
export function parseModelsFlag(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const parts = value
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) {
    throw usageError("Invalid --models: no value given.", {
      field: "--models",
      received: value,
      allowed: MODEL_VALUES,
      hint: `Must be one or more of: ${MODEL_VALUES.join(", ")}. ${MODELS_HINT}`,
    });
  }
  const canonical = parts.map((part) => {
    const match = MODEL_VALUES.find((m) => m === part.toLowerCase());
    if (!match) {
      throw usageError(`Invalid --models: "${part}" is not a model id.`, {
        field: "--models",
        received: part,
        allowed: MODEL_VALUES,
        hint: `Must be one or more of: ${MODEL_VALUES.join(", ")}. ${MODELS_HINT}`,
      });
    }
    return match;
  });
  return canonical.join(",");
}

/**
 * The funnel stages `--prompt-type` accepts, exactly as the help text lists
 * them. Checked here rather than in each subcommand because the flag is
 * declared once, in `addWindowOptions`, and read once, in `windowParams` — so
 * one check covers every windowed command and cannot drift out of step with
 * the option that declares it.
 */
export const PROMPT_TYPE_VALUES = ["awareness", "consideration", "evaluation", "decision"] as const;

export interface WindowFilters {
  from?: string;
  to?: string;
  models?: string;
  location?: string;
  promptType?: string;
  tag?: string;
}

export function windowParams(o: WindowFilters): Record<string, string | undefined> {
  // Dates are checked before the request because this API takes two different
  // formats under the same flag names — YYYY-MM-DD here, RFC 3339 instants in
  // `senso evals` — and a caller carrying a timestamp between the two groups
  // should learn it from exit 2, not from a 400.
  const from = parseDateFlag("--from", o.from);
  const to = parseDateFlag("--to", o.to);
  assertRange("--from", from, "--to", to, { maxDays: MAX_WINDOW_DAYS });
  return {
    from,
    to,
    models: parseModelsFlag(o.models),
    location: o.location,
    // An unrecognized funnel stage is not a server-side error waiting to
    // happen — the API ignores a filter it cannot read, and an unapplied filter
    // returns MORE rows than were asked for. Exit 2 here instead, before the
    // request, the way normalizeBool already does for --mentioned/--cited.
    prompt_type: parseEnumFlag("--prompt-type", o.promptType, PROMPT_TYPE_VALUES),
    tag: o.tag,
  };
}

/**
 * Shared window/filter options.
 *
 * `tag` is opt-out because the cited-source endpoints (domains, pages) cannot
 * honor it — the domain and webpage rollups have no prompt grain to resolve a
 * tag through. Offering the flag there would advertise a filter that silently
 * does nothing, which is the one failure mode this CLI works hardest to avoid:
 * an unapplied filter returns MORE data, so the mistake is invisible.
 */
export function addWindowOptions(cmd: Command, opts: { tag?: boolean } = {}): Command {
  const withTag = opts.tag !== false;
  const base = cmd
    .option(
      "--from <date>",
      "Window start, YYYY-MM-DD (default: 30 days ending at the most recent day with data)",
    )
    .option("--to <date>", "Window end, YYYY-MM-DD, inclusive (max window: 365 days)")
    .option(
      "--models <list>",
      `Comma-separated model ids: ${MODEL_VALUES.join(", ")} — 'senso analytics filters' lists the ones with data`,
    )
    .option(
      "--location <list>",
      "Comma-separated location filter, case-sensitive (e.g. US, US/California)",
    )
    .option(
      "--prompt-type <type>",
      "Funnel stage: awareness | consideration | evaluation | decision",
    );
  return withTag ? base.option("--tag <tag>", "Restrict to prompts carrying this tag") : base;
}

export function addPagingOptions(cmd: Command, defaultLimit: number): Command {
  return cmd
    .option("--limit <n>", `Maximum rows to return (default: ${defaultLimit}, max: 100)`)
    .option("--offset <n>", "Rows to skip (for pagination)");
}

/**
 * The paging flags, checked rather than forwarded.
 *
 * The API clamps: `--limit 500` silently returns 100, so an agent concludes
 * the org has exactly 100 domains. Rejecting says what happened.
 */
export function pagingParams(o: { limit?: string; offset?: string }): {
  limit: string | undefined;
  offset: string | undefined;
} {
  const limit = parseIntFlag("--limit", o.limit, { min: 1, max: 100 });
  const offset = parseIntFlag("--offset", o.offset, { min: 0 });
  return { limit: limit?.toString(), offset: offset?.toString() };
}

export const BOOL_VALUES = new Set(["true", "false", "1", "0", "yes", "no"]);

export function normalizeBool(flag: string, raw?: string): string | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim().toLowerCase();
  if (!BOOL_VALUES.has(value)) {
    throw new CliError(`Invalid --${flag}: expected true or false.`, EXIT.USAGE, {
      code: "usage",
      hint: `Accepted values: ${[...BOOL_VALUES].join(", ")}.`,
    });
  }
  return value;
}
