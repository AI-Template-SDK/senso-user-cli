/**
 * `senso analytics citations` — the citation overview and its series.
 *
 * Its own file because this command is where the two citation denominators (D
 * = cited answers, S = citation instances) are spelled out for the reader, and
 * that context block belongs beside the rows it explains.
 */

import { Command } from "commander";
import pc from "picocolors";
import { apiRequest } from "../../lib/api-client.js";
import { emit } from "../../lib/output.js";
import { runAction } from "../../lib/run-action.js";
import { parseEnumFlag } from "../../lib/enum-arg.js";
import { apiExits, describeCommand } from "../../lib/help.js";
import { addWindowOptions, windowParams, type WindowFilters } from "./filters.js";
import {
  count,
  emitContext,
  emitNotes,
  qualityLine,
  rate,
  requireBlocks,
  windowLine,
} from "./render.js";
import type {
  AnalyticsWindow,
  CitationSeriesPoint,
  DataQuality,
  Metrics,
  Totals,
} from "./types.js";

// The buckets --group-by accepts, as its help text lists them.
const GROUP_BY_VALUES = ["day", "week"] as const;

export function addCitationsCommand(analytics: Command, program: Command): void {
  // ── citations ────────────────────────────────────────────────────────────
  describeCommand(
    addWindowOptions(
      analytics
        .command("citations")
        .description(
          "Citation overview: both denominators (D = cited answers, S = citation instances), every tier numerator, the tier rates (÷D) and tier shares (÷S), and the series underneath.",
        ),
    ).option(
      "--group-by <bucket>",
      "Time bucket: day | week (default: day). Weeks are ISO weeks starting Monday, so the first and last may be partial",
    ),
    {
      returns: [
        "totals.cited_run_count — D, the answers that cited anything; the denominator of every *_citation_rate",
        "totals.cited_total — S, the citation instances; the denominator of every *_citation_share",
        "metrics.primary|tracked|external_citation_rate — that tier's cited answers ÷ D. Tiers overlap: one answer can cite owned and external pages, so the three rates may sum past 100%",
        "metrics.primary|tracked|external_citation_share — that tier's citations ÷ S. Shares partition S and sum to 100%",
        "metrics.citations_per_answer — S ÷ D; an intensity, not a percentage",
        "Each rate is {value, display} or null; null means the denominator was zero, never 0%",
        "series[] — the same numerators and rates per bucket, with period_start",
        "tier — primary (Owned) | tracked (a competitor or source you track) | external (everything else)",
        "data_quality.level — low | medium | high; window; notes[]",
      ],
      exitCodes: {
        ...apiExits,
        2: "a date that is not YYYY-MM-DD, a window longer than 365 days, or an unknown model, prompt type or bucket",
        3: "no key, the organization lacks the GEO product, or the key lacks read:prompt",
      },
      examples: [
        { comment: "The default 30-day window, by day", command: "senso analytics citations" },
        {
          comment: "Owned-citation trend by week",
          command:
            "senso analytics citations --group-by week --output json | jq '.data.series[] | {period_start, primary_citation_rate}'",
        },
      ],
      seeAlso: ["senso analytics domains", "senso analytics pages", "senso analytics glossary"],
    },
  ).action(
      runAction(program, async (ctx, cmdOpts: WindowFilters & { groupBy?: string }) => {
        const data = await apiRequest<{
          window: AnalyticsWindow;
          group_by: string;
          totals: Totals;
          metrics: Metrics;
          series: CitationSeriesPoint[];
          data_quality: DataQuality;
          notes: string[];
        }>({
          path: "/org/analytics/citations",
          params: {
            ...windowParams(cmdOpts),
            group_by: parseEnumFlag("--group-by", cmdOpts.groupBy, GROUP_BY_VALUES),
          },
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });

        requireBlocks("/org/analytics/citations", {
          totals: data.totals,
          metrics: data.metrics,
        });

        const series = data.series ?? [];
        const context = [
          "",
          `  ${pc.bold("Citations")} ${pc.dim(`by ${data.group_by}`)}`,
          windowLine(data.window),
          qualityLine(data.data_quality),
          `  ${pc.dim(`D = ${count(data.totals.cited_run_count)} cited answers, S = ${count(data.totals.cited_total)} citation instances`)}`,
          `  ${pc.dim(`Owned rate ${rate(data.metrics.primary_citation_rate)} (÷D) · Owned share ${rate(data.metrics.primary_citation_share)} (÷S) · ${rate(data.metrics.citations_per_answer)}`)}`,
        ];
        emitContext(ctx, context);
        emit(ctx, data, {
          table: {
            rows: series.map((p) => ({
              period: p.period_start,
              cited_answers: count(p.cited_run_count),
              citations: count(p.cited_total),
              owned_rate: rate(p.primary_citation_rate),
              tracked_rate: rate(p.tracked_citation_rate),
              external_rate: rate(p.external_citation_rate),
              owned_share: rate(p.primary_citation_share),
            })),
            columns: [
              "period",
              "cited_answers",
              "citations",
              "owned_rate",
              "tracked_rate",
              "external_rate",
              "owned_share",
            ],
          },
          empty: "rollup days",
          emptyHint:
            "No rollup days fell in this window. `senso analytics filters` shows the date range that has data.",
          plain: [
            ...context,
            "",
            ...(series.length
              ? series.map(
                  (p) =>
                    `  ${pc.bold(p.period_start)}  cited answers ${count(p.cited_run_count)}  citations ${count(p.cited_total)}  owned ${rate(p.primary_citation_rate)}  tracked ${rate(p.tracked_citation_rate)}  external ${rate(p.external_citation_rate)}`,
                )
              : ["  No rollup days in this window."]),
          ],
        });
        emitNotes(ctx, data.notes);
      }),
    );
}
