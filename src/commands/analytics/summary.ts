/**
 * `senso analytics summary` — the one-call dashboard.
 *
 * Its own file so the headline metric table has a single registration site;
 * the rows themselves live in render.ts because `prompt <promptId>` prints the
 * same table for one prompt.
 */

import { Command } from "commander";
import pc from "picocolors";
import { apiRequest } from "../../lib/api-client.js";
import { emit } from "../../lib/output.js";
import { runAction } from "../../lib/run-action.js";
import { addWindowOptions, windowParams, type WindowFilters } from "./filters.js";
import {
  count,
  emitContext,
  emitNotes,
  METRIC_COLUMNS,
  metricPlainLines,
  metricRows,
  qualityLine,
  windowLine,
} from "./render.js";
import type { AnalyticsWindow, DataQuality, Deltas, Metrics, Totals } from "./types.js";

export function addSummaryCommand(analytics: Command, program: Command): void {
  // ── summary ──────────────────────────────────────────────────────────────
  addWindowOptions(
    analytics
      .command("summary")
      .description(
        "One-call dashboard: every headline metric with its raw counts, plus the preceding equal-length window and the deltas between them.",
      ),
  ).action(
    runAction(program, async (ctx, cmdOpts: WindowFilters) => {
      const data = await apiRequest<{
        window: AnalyticsWindow;
        totals: Totals;
        metrics: Metrics;
        deltas: Deltas | null;
        data_quality: DataQuality;
        notes: string[];
      }>({
        path: "/org/analytics/summary",
        params: windowParams(cmdOpts),
        apiKey: ctx.apiKey,
        baseUrl: ctx.baseUrl,
      });

      const rows = metricRows(data.totals, data.metrics, data.deltas);
      emitContext(ctx, [
        "",
        `  ${pc.bold("Analytics summary")}`,
        windowLine(data.window),
        qualityLine(data.data_quality),
      ]);
      emit(ctx, data, {
        table: { rows, columns: METRIC_COLUMNS },
        plain: [
          "",
          `  ${pc.bold("Analytics summary")}`,
          windowLine(data.window),
          qualityLine(data.data_quality),
          "",
          ...metricPlainLines(rows),
          "",
          `  ${pc.dim(`Monitoring ${count(data.totals.prompt_count)} prompts × ${count(data.totals.model_count)} models × ${count(data.totals.location_count)} locations — ${count(data.totals.answered_count)} of ${count(data.totals.run_count)} runs answered`)}`,
        ],
      });
      emitNotes(ctx, data.notes);
    }),
  );
}
