/**
 * `senso analytics prompt <promptId>` — one prompt end to end.
 *
 * Its own file because it is the only subcommand that takes an argument, the
 * only one that declines the shared window options (it offers a narrower set),
 * and the only one that prints the metric table and a series and the latest
 * answer bodies in a single view.
 */

import { Command } from "commander";
import pc from "picocolors";
import { apiRequest } from "../../lib/api-client.js";
import { emit } from "../../lib/output.js";
import { runAction, type Ctx } from "../../lib/run-action.js";
import {
  count,
  emitContext,
  emitNotes,
  metricPlainLines,
  metricRows,
  NO_VALUE,
  qualityLine,
  rate,
  truncate,
  windowLine,
} from "./render.js";
import type {
  AnalyticsWindow,
  DataQuality,
  LatestAnswerItem,
  MentionSeriesPoint,
  Metrics,
  Totals,
} from "./types.js";

export function addPromptCommand(analytics: Command, program: Command): void {
  // ── prompt <promptId> ────────────────────────────────────────────────────
  analytics
    .command("prompt <promptId>")
    .description(
      "One prompt end to end: its metric history over the window plus the latest full answer from every model × location.",
    )
    .option("--from <date>", "Window start, YYYY-MM-DD")
    .option("--to <date>", "Window end, YYYY-MM-DD")
    .option("--models <list>", "Comma-separated model filter")
    .option("--location <list>", "Comma-separated location filter, case-sensitive")
    .option("--no-include-answers", "Omit the latest answer bodies (included by default)")
    .action(
      runAction(
        program,
        async (
          ctx: Ctx,
          promptId: string,
          cmdOpts: {
            from?: string;
            to?: string;
            models?: string;
            location?: string;
            includeAnswers?: boolean;
          },
        ) => {
          const data = await apiRequest<{
            prompt_id: string;
            prompt_text: string;
            prompt_type: string;
            tags: string[];
            window: AnalyticsWindow;
            totals: Totals;
            metrics: Metrics;
            series: MentionSeriesPoint[];
            latest_answers: LatestAnswerItem[];
            data_quality: DataQuality;
            notes: string[];
          }>({
            path: `/org/analytics/prompts/${promptId}`,
            params: {
              from: cmdOpts.from,
              to: cmdOpts.to,
              models: cmdOpts.models,
              location: cmdOpts.location,
              include_answers: cmdOpts.includeAnswers === false ? "false" : undefined,
            },
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
          });

          const series = data.series ?? [];
          const answers = data.latest_answers ?? [];
          const rows = metricRows(data.totals, data.metrics);
          const context = [
            "",
            `  ${pc.bold(data.prompt_text)} ${pc.dim(`[${data.prompt_type}]`)}`,
            `  ${pc.dim(`ID: ${data.prompt_id}${data.tags?.length ? ` · tags: ${data.tags.join(", ")}` : ""}`)}`,
            windowLine(data.window),
            qualityLine(data.data_quality),
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
              ...metricPlainLines(rows),
              "",
              `  ${pc.bold("Series")}`,
              ...(series.length
                ? series.map(
                    (p) =>
                      `  ${p.period_start}  answered ${count(p.answered_count)}  mentioned ${count(p.mentioned_count)}  rate ${rate(p.mention_rate)}  SoV ${rate(p.share_of_voice)}  rank ${rate(p.avg_rank)}`,
                  )
                : ["  No rollup days in this window."]),
              ...(answers.length
                ? [
                    "",
                    `  ${pc.bold("Latest answers")}`,
                    ...answers.map((a) =>
                      [
                        `  ${pc.bold(`${a.model} · ${a.location}`)} ${pc.dim(a.run_at)}`,
                        `     mentioned ${a.mentioned ? "yes" : "no"} · rank ${a.rank === null || a.rank === undefined ? NO_VALUE : `#${a.rank}`} · sentiment ${a.sentiment ?? NO_VALUE} · ${count(a.citations?.length ?? 0)} citations`,
                        `     ${pc.dim(truncate(a.response_text, 200))}`,
                      ].join("\n"),
                    ),
                  ]
                : []),
            ],
          });
          emitNotes(ctx, data.notes);
        },
      ),
    );
}
