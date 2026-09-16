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
import type { AnalyticsWindow, DataQuality, MentionSeriesPoint, Metrics, Totals } from "./types.js";

// The buckets --group-by accepts, as its help text lists them.
const GROUP_BY_VALUES = ["day", "week"] as const;

export function addMentionsCommand(analytics: Command, program: Command): void {
  // ── mentions ─────────────────────────────────────────────────────────────
  describeCommand(
    addWindowOptions(
      analytics
        .command("mentions")
        .description(
          "Visibility time series: mention counts, share of voice (your mentions ÷ mentions of every brand), average rank and sentiment, bucketed by day or week.",
        ),
    ).option(
      "--group-by <bucket>",
      "Time bucket: day | week (default: day). Weeks are ISO weeks starting Monday, so the first and last may be partial",
    ),
    {
      returns: [
        "series[] — one point per bucket: period_start, run_count, answered_count, mentioned_count, mention_total, brand_mention_total, rank_sum, sentiment{positive,neutral,negative}",
        "series[].mention_rate — mentioned_count ÷ answered_count for that bucket",
        "series[].share_of_voice — mention_total ÷ brand_mention_total for that bucket",
        "series[].avg_rank — rank_sum ÷ mentioned_count; lower is better",
        "Each rate is {value, display} or null; null means the bucket's denominator was zero, never 0%",
        "totals / metrics — the same figures over the whole window",
        "data_quality.level — low | medium | high; window; notes[]",
        "Counts are additive across buckets, rates are NOT: re-derive a rate from summed counts rather than averaging the per-bucket rates",
      ],
      exitCodes: {
        ...apiExits,
        2: "a date that is not YYYY-MM-DD, a window longer than 365 days, or an unknown model, prompt type or bucket",
        3: "no key, the organization lacks the GEO product, or the key lacks read:prompt",
      },
      examples: [
        {
          comment: "Weekly visibility over the default window",
          command: "senso analytics mentions --group-by week",
        },
        {
          comment: "One model, one quarter, as data",
          command:
            "senso analytics mentions --from 2026-06-01 --to 2026-08-31 --models chatgpt --output json | jq '.data.series[] | {period_start, mention_rate}'",
        },
      ],
      seeAlso: ["senso analytics summary", "senso analytics citations", "senso analytics filters"],
    },
  ).action(
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

      requireBlocks("/org/analytics/mentions", {
        totals: data.totals,
        metrics: data.metrics,
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
        empty: "rollup days",
        emptyHint:
          "No rollup days fell in this window. `senso analytics filters` shows the date range that has data.",
        plain: [
          ...context,
          "",
          ...(series.length
            ? series.map(
                (p) =>
                  `  ${pc.bold(p.period_start)}  answered ${count(p.answered_count)}  mentioned ${count(p.mentioned_count)}  rate ${rate(p.mention_rate)} (${count(p.mentioned_count)}/${count(p.answered_count)})  SoV ${rate(p.share_of_voice)} (${count(p.mention_total)}/${count(p.brand_mention_total)})  rank ${rate(p.avg_rank)}`,
              )
            : ["  No rollup days in this window."]),
        ],
      });
      emitNotes(ctx, data.notes);
    }),
  );
}
