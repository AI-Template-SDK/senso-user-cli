/**
 * `senso analytics mentions` — the visibility time series.
 *
 * Its own file: mentions and citations are separate endpoints with separate
 * series shapes, and keeping each registration next to the series row it
 * renders is what stops the two column sets drifting into one another.
 */

import { Command } from "commander";
import pc from "picocolors";
import { apiRequest } from "../../lib/api-client.js";
import { emit } from "../../lib/output.js";
import { runAction } from "../../lib/run-action.js";
import { parseEnumFlag } from "../../lib/enum-arg.js";
import { addWindowOptions, windowParams, type WindowFilters } from "./filters.js";
import { count, emitContext, emitNotes, qualityLine, rate, windowLine } from "./render.js";
import type { AnalyticsWindow, DataQuality, MentionSeriesPoint, Metrics, Totals } from "./types.js";

// The buckets --group-by accepts, as its help text lists them.
const GROUP_BY_VALUES = ["day", "week"] as const;

export function addMentionsCommand(analytics: Command, program: Command): void {
  // ── mentions ─────────────────────────────────────────────────────────────
  addWindowOptions(
    analytics
      .command("mentions")
      .description(
        "Visibility time series: mention counts, share of voice (your mentions ÷ mentions of every brand), average rank and sentiment, bucketed by day or week.",
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
          series: MentionSeriesPoint[];
          data_quality: DataQuality;
          notes: string[];
        }>({
          path: "/org/analytics/mentions",
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
          `  ${pc.bold("Mentions")} ${pc.dim(`by ${data.group_by}`)}`,
          windowLine(data.window),
          qualityLine(data.data_quality),
          `  ${pc.dim(`Window totals — mention rate ${rate(data.metrics.mention_rate)}, share of voice ${rate(data.metrics.share_of_voice)}, avg rank ${rate(data.metrics.avg_rank)}`)}`,
        ];
        emitContext(ctx, context);
        emit(ctx, data, {
          table: {
            rows: series.map((p) => ({
              period: p.period_start,
              answered: count(p.answered_count),
              mentioned: count(p.mentioned_count),
              mention_rate: rate(p.mention_rate),
              sov: rate(p.share_of_voice),
              avg_rank: rate(p.avg_rank),
            })),
            columns: ["period", "answered", "mentioned", "mention_rate", "sov", "avg_rank"],
          },
          plain: [
            ...context,
            "",
            ...(series.length
              ? series.map(
                  (p) =>
                    `  ${pc.bold(p.period_start)}  answered ${count(p.answered_count)}  mentioned ${count(p.mentioned_count)}  rate ${rate(p.mention_rate)}  SoV ${rate(p.share_of_voice)}  rank ${rate(p.avg_rank)}`,
                )
              : ["  No rollup days in this window."]),
          ],
        });
        emitNotes(ctx, data.notes);
      }),
    );
}
