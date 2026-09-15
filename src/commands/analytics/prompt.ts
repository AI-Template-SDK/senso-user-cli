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
import { parseId } from "../../lib/id-arg.js";
import { describeCommand, idExits } from "../../lib/help.js";
import { assertRange, parseDateFlag } from "../../lib/enum-arg.js";
import { MODEL_VALUES, parseModelsFlag } from "./filters.js";
import {
  count,
  emitContext,
  emitNotes,
  metricPlainLines,
  metricRows,
  NO_VALUE,
  qualityLine,
  rate,
  requireBlocks,
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
  describeCommand(
    analytics
      .command("prompt")
      .description(
        "One prompt end to end: its metric history over the window plus the latest full answer from every model × location.",
      )
      .argument(
        "<promptId>",
        "An ORG prompt id — the prompt_id field of `senso analytics prompts` or `senso prompts list`. An industry prompt id from `senso industries prompts` is a different id space and is rejected",
      )
      .option(
        "--from <date>",
        "Window start, YYYY-MM-DD (default: 30 days ending at the most recent day with data)",
      )
      .option("--to <date>", "Window end, YYYY-MM-DD, inclusive (max window: 365 days)")
      .option(
        "--models <list>",
        `Comma-separated model ids: ${MODEL_VALUES.join(", ")} — 'senso analytics filters' lists the ones with data`,
      )
      .option("--location <list>", "Comma-separated location filter, case-sensitive")
      .option("--no-include-answers", "Omit the latest answer bodies (included by default)"),
    {
      returns: [
        "prompt_id, prompt_text, prompt_type (awareness | consideration | evaluation | decision), tags[]",
        "totals / metrics — the same headline block as `analytics summary`, for this prompt only: mention_rate = mentioned_count ÷ answered_count, share_of_voice = mention_total ÷ brand_mention_total, avg_rank = rank_sum ÷ mentioned_count, *_citation_rate ÷ cited_run_count (D), *_citation_share ÷ cited_total (S)",
        "Every rate is {value, display} or null; null means the denominator was zero, never 0%",
        "series[] — the same figures per day over the window",
        "latest_answers[] — one per model × location: run_at, response_text in full, mentioned, rank (null when not mentioned), sentiment (positive | neutral | negative | null), citations[] with url/domain/citation_type, competitor_mentions{}",
        "data_quality.level — low | medium | high; window; notes[]",
      ],
      exitCodes: {
        ...idExits,
        2: "<promptId> is not a UUID, a date is not YYYY-MM-DD, the window is longer than 365 days, or a model id is unknown",
        3: "no key, the organization lacks the GEO product, or the key lacks read:prompt",
        4: "no prompt with this id in your organization — an industry prompt id will land here",
      },
      examples: [
        {
          comment: "Everything known about one prompt",
          command: "senso analytics prompt 3f2a8c10-5f4e-4a8f-9b0d-2c1e6a7b8d90",
        },
        {
          comment: "Metrics only, without the answer bodies",
          command: "senso analytics prompt <promptId> --no-include-answers",
        },
      ],
      seeAlso: ["senso analytics prompts", "senso analytics answers", "senso prompts get"],
    },
  ).action(
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
          const id = parseId(promptId, {
            label: "<promptId>",
            type: "Prompt",
            idField: "prompt_id",
            list: "senso analytics prompts",
          });
          const from = parseDateFlag("--from", cmdOpts.from);
          const to = parseDateFlag("--to", cmdOpts.to);
          assertRange("--from", from, "--to", to, { maxDays: 365 });

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
            path: `/org/analytics/prompts/${id}`,
            params: {
              from,
              to,
              models: parseModelsFlag(cmdOpts.models),
              location: cmdOpts.location,
              include_answers: cmdOpts.includeAnswers === false ? "false" : undefined,
            },
            resource: {
              type: "Prompt",
              id,
              idField: "prompt_id",
              list: "senso analytics prompts",
            },
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
          });
          requireBlocks("/org/analytics/prompts/{promptId}", {
            totals: data.totals,
            metrics: data.metrics,
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
            next: [
              {
                why: "Compare this prompt with the rest",
                command: "senso analytics prompts --order asc",
              },
            ],
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
                        // Plain never truncates, and the citations and
                        // competitor mentions are what this command is opened
                        // for — hiding them behind --output json defeats it.
                        `     ${pc.dim(a.response_text)}`,
                        ...(a.citations ?? []).map(
                          (c) => `     ${pc.dim(`↳ ${c.url} [${c.citation_type}]`)}`,
                        ),
                        ...(Object.keys(a.competitor_mentions ?? {}).length > 0
                          ? [
                              `     ${pc.dim(`competitors named: ${Object.entries(a.competitor_mentions).map(([brand, n]) => `${brand} ×${String(n)}`).join(", ")}`)}`,
                            ]
                          : []),
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
