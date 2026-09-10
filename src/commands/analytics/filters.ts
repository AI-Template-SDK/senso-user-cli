/**
 * The option builders and query-parameter mapping shared by the subcommands.
 *
 * Separated from render.ts because this is the input half of the contract: the
 * flags a caller may pass, the exact wording of their help text, and the API
 * parameter each one maps to. Every subcommand that accepts a window must
 * accept it in the same words, or the flags stop being learnable.
 */

import { Command } from "commander";
import { parseEnumFlag } from "../../lib/enum-arg.js";
import { CliError, EXIT } from "../../lib/errors.js";

// ---------------------------------------------------------------------------
// Shared filter options
// ---------------------------------------------------------------------------

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
  return {
    from: o.from,
    to: o.to,
    models: o.models,
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
    .option("--to <date>", "Window end, YYYY-MM-DD (max window: 365 days)")
    .option("--models <list>", "Comma-separated model filter — see 'senso analytics filters'")
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
