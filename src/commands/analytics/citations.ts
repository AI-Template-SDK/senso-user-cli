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
import { addWindowOptions, windowParams, type WindowFilters } from "./filters.js";
import { count, emitContext, emitNotes, qualityLine, rate, windowLine } from "./render.js";
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
  addWindowOptions(
    analytics
      .command("citations")
      .description(
        "Citation overview: both denominators (D = cited answers, S = citation instances), every tier numerator, the tier rates (÷D) and tier shares (÷S), and the series underneath.",
      ),
  )
    .option("--group-by <bucket>", "Time bucket: day | week (default: day)")
    .action(
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
