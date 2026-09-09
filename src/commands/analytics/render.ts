/**
 * The presentation layer shared by every `senso analytics` subcommand.
 *
 * It is its own file because these helpers encode the rules that make the
 * numbers readable and honest — a null metric renders as "—" and never as 0%,
 * a rate is printed from the server's own display string, and the window and
 * data-quality context travels alongside the table that cannot carry it. Those
 * rules have to be identical in ten subcommands, so they are written once.
 */

import pc from "picocolors";
import { outputPlain } from "../../lib/output.js";
import type { Ctx } from "../../lib/run-action.js";
import type { AnalyticsWindow, DataQuality, Deltas, Metrics, RateTrend, Totals } from "./types.js";

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** Rendered where a metric is null because its denominator was zero. Never 0%. */
export const NO_VALUE = "—";

/** Renders a {value, display} object — the display string is authoritative. */
export function rate(r?: { display?: string } | null): string {
  return r && typeof r.display === "string" ? r.display : NO_VALUE;
}

/** Renders a raw count, grouped for readability. */
export function count(v?: number | null): string {
  return v === undefined || v === null ? NO_VALUE : v.toLocaleString("en-US");
}

/** Renders a raw average ordinal position as "#3.2". */
export function position(v?: number | null): string {
  return v === undefined || v === null ? NO_VALUE : `#${v.toFixed(1)}`;
}

/** Renders a window-over-window trend with its semantic direction. */
export function trend(t?: RateTrend | null): string {
  return t ? `${t.display} (${t.direction})` : NO_VALUE;
}

/** Renders "numerator / denominator unit" so a reader can redo the math. */
export function ratio(numerator: number, denominator: number, unit: string): string {
  return `${count(numerator)} / ${count(denominator)} ${unit}`;
}

export function truncate(value: string | undefined, max: number): string {
  const flat = (value ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function windowLine(w?: AnalyticsWindow): string {
  if (!w) return "";
  const fresh = w.latest_data_day
    ? `, latest data ${w.latest_data_day}`
    : ", no data days in window";
  return `  ${pc.dim(`Window ${w.from} → ${w.to} (${w.days} days${fresh})`)}`;
}

export function qualityLine(dq?: DataQuality): string {
  if (!dq) return "";
  return `  ${pc.dim(`Data quality: ${dq.level} — ${count(dq.answered_count)} answered runs`)}`;
}

/**
 * Prints the window / data-quality context that a table alone cannot carry.
 * Plain output builds these lines into its own payload, so this only fires for
 * `--output table`; `--output json` gets the payload untouched.
 */
export function emitContext(ctx: Ctx, lines: string[]): void {
  if (ctx.format !== "table") return;
  const visible = lines.filter(Boolean);
  if (visible.length === 0) return;
  outputPlain([...visible, ""]);
}

/**
 * Surfaces the response's notes[] — the caveats that stop a reader misreading
 * the numbers (null denominators, truncated windows, tracking-set dependence).
 * Hidden only in `--output json`, where they are already in the payload.
 */
export function emitNotes(ctx: Ctx, notes?: string[]): void {
  if (ctx.format === "json" || !notes || notes.length === 0) return;
  outputPlain(["", `  ${pc.bold("Notes")}`, ...notes.map((note) => `  ${pc.dim("•")} ${note}`)]);
}

/** The headline metric table, shared by `summary` and `prompt <promptId>`. */
export function metricRows(
  totals: Totals,
  metrics: Metrics,
  deltas?: Deltas | null,
): Record<string, unknown>[] {
  return [
    {
      metric: "Mention Rate",
      value: rate(metrics.mention_rate),
      counts: ratio(totals.mentioned_count, totals.answered_count, "answers"),
      "vs prev": trend(deltas?.mention_rate),
    },
    {
      metric: "Share of Voice",
      value: rate(metrics.share_of_voice),
      counts: ratio(totals.mention_total, totals.brand_mention_total, "mentions (all brands)"),
      "vs prev": trend(deltas?.share_of_voice),
    },
    {
      metric: "Avg Rank",
      value: rate(metrics.avg_rank),
      counts: `over ${count(totals.mentioned_count)} mentioned answers`,
      "vs prev": NO_VALUE,
    },
    {
      metric: "Citation Rate (Owned)",
      value: rate(metrics.primary_citation_rate),
      counts: ratio(totals.primary_cited_run_count, totals.cited_run_count, "cited answers"),
      "vs prev": trend(deltas?.primary_citation_rate),
    },
    {
      metric: "Citation Rate (Tracked)",
      value: rate(metrics.tracked_citation_rate),
      counts: ratio(totals.tracked_cited_run_count, totals.cited_run_count, "cited answers"),
      "vs prev": NO_VALUE,
    },
    {
      metric: "Citation Rate (External)",
      value: rate(metrics.external_citation_rate),
      counts: ratio(totals.external_cited_run_count, totals.cited_run_count, "cited answers"),
      "vs prev": NO_VALUE,
    },
    {
      metric: "Citation Share (Owned)",
      value: rate(metrics.primary_citation_share),
      counts: ratio(totals.primary_cited_total, totals.cited_total, "citations"),
      "vs prev": NO_VALUE,
    },
    {
      metric: "Citation Share (Tracked)",
      value: rate(metrics.tracked_citation_share),
      counts: ratio(totals.tracked_cited_total, totals.cited_total, "citations"),
      "vs prev": NO_VALUE,
    },
    {
      metric: "Citation Share (External)",
      value: rate(metrics.external_citation_share),
      counts: ratio(totals.external_cited_total, totals.cited_total, "citations"),
      "vs prev": NO_VALUE,
    },
    {
      metric: "Citations per Answer",
      value: rate(metrics.citations_per_answer),
      counts: ratio(totals.cited_total, totals.cited_run_count, "cited answers"),
      "vs prev": NO_VALUE,
    },
    {
      metric: "Sentiment (pos/neu/neg)",
      value: `${count(totals.sentiment?.positive)} / ${count(totals.sentiment?.neutral)} / ${count(totals.sentiment?.negative)}`,
      counts: `sums to ${count(totals.mentioned_count)} mentioned answers`,
      "vs prev": NO_VALUE,
    },
  ];
}

export const METRIC_COLUMNS = ["metric", "value", "counts", "vs prev"];

export function metricPlainLines(rows: Record<string, unknown>[]): string[] {
  const width = rows.reduce((max, r) => Math.max(max, String(r.metric).length), 0);
  return rows.map(
    (r) =>
      `  ${pc.bold(String(r.metric).padEnd(width))}  ${String(r.value)}  ${pc.dim(`(${String(r.counts)})`)}` +
      (r["vs prev"] !== NO_VALUE ? `  ${pc.dim(`vs prev: ${String(r["vs prev"])}`)}` : ""),
  );
}
