/**
 * `senso analytics prompts` — per-prompt performance over the window.
 *
 * Its own file, and deliberately separate from prompt.ts: this is the list you
 * sort to find the prompts you are invisible on, and that one is the drill-down
 * into a single prompt. Two endpoints, two payload shapes.
 */

import { Command } from "commander";
import pc from "picocolors";
import { apiRequest } from "../../lib/api-client.js";
import { emit } from "../../lib/output.js";
import { runAction, type Ctx } from "../../lib/run-action.js";
import { parseEnumFlag } from "../../lib/enum-arg.js";
import { addPagingOptions, addWindowOptions, windowParams, type WindowFilters } from "./filters.js";
import {
  count,
  emitContext,
  emitNotes,
  qualityLine,
  rate,
  truncate,
  windowLine,
} from "./render.js";
import type {
  AnalyticsWindow,
  DataQuality,
  Metrics,
  PromptPerformanceItem,
  Totals,
} from "./types.js";

// The values --sort and --order accept, as their help text lists them.
const SORT_VALUES = ["mention_rate", "share_of_voice", "citations", "answered", "text"] as const;
const ORDER_VALUES = ["asc", "desc"] as const;

export function addPromptsCommand(analytics: Command, program: Command): void {
  // ── prompts ──────────────────────────────────────────────────────────────
  addPagingOptions(
    addWindowOptions(
      analytics
        .command("prompts")
        .description(
          "Per-prompt performance over the window — sort ascending by mention_rate to find the prompts where you are invisible. Drill into one with 'senso analytics prompt <promptId>'.",
        ),
    )
      .option("--search <query>", "Filter prompts by question text")
      .option(
        "--sort <field>",
        "Sort by: mention_rate | share_of_voice | citations | answered | text (default: mention_rate)",
      )
      .option("--order <dir>", "Sort direction: asc | desc (default: desc)"),
    50,
  ).action(
    runAction(
      program,
      async (
        ctx: Ctx,
        cmdOpts: WindowFilters & {
          search?: string;
          sort?: string;
          order?: string;
          limit?: string;
          offset?: string;
        },
      ) => {
        const data = await apiRequest<{
          window: AnalyticsWindow;
          totals: Totals;
          metrics: Metrics;
          total: number;
          limit: number;
          offset: number;
          prompts: PromptPerformanceItem[];
          data_quality: DataQuality;
          notes: string[];
        }>({
          path: "/org/analytics/prompts",
          params: {
            ...windowParams(cmdOpts),
            search: cmdOpts.search,
            sort: parseEnumFlag("--sort", cmdOpts.sort, SORT_VALUES),
            order: parseEnumFlag("--order", cmdOpts.order, ORDER_VALUES),
            limit: cmdOpts.limit,
            offset: cmdOpts.offset,
          },
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });

        const prompts = data.prompts ?? [];
        const context = [
          "",
          `  ${pc.bold("Prompt performance")} ${pc.dim(`${prompts.length} of ${count(data.total)} (offset ${count(data.offset)})`)}`,
          windowLine(data.window),
          qualityLine(data.data_quality),
          `  ${pc.dim(`Org-wide over the same window — mention rate ${rate(data.metrics.mention_rate)}, share of voice ${rate(data.metrics.share_of_voice)}`)}`,
        ];
        emitContext(ctx, context);
        emit(ctx, data, {
          table: {
            rows: prompts.map((p) => ({
              prompt_id: p.prompt_id,
              prompt: truncate(p.prompt_text, 40),
              answered: count(p.answered_count),
              mention_rate: rate(p.mention_rate),
              sov: rate(p.share_of_voice),
              latest_sov: rate(p.latest?.share_of_voice ?? null),
              avg_rank: rate(p.avg_rank),
              owned_cite_rate: rate(p.primary_citation_rate),
            })),
            columns: [
              "prompt_id",
              "prompt",
              "answered",
              "mention_rate",
              "sov",
              "latest_sov",
              "avg_rank",
              "owned_cite_rate",
            ],
          },
          plain: [
            ...context,
            "",
            ...(prompts.length
              ? prompts.map((p) =>
                  [
                    `  ${pc.bold(truncate(p.prompt_text, 100))} ${pc.dim(`[${p.prompt_type}]`)}`,
                    `     mention rate ${rate(p.mention_rate)} (${count(p.mentioned_count)}/${count(p.answered_count)}) · SoV ${rate(p.share_of_voice)} (window) · ${rate(p.latest?.share_of_voice ?? null)} (latest) · avg rank ${rate(p.avg_rank)} · owned citation rate ${rate(p.primary_citation_rate)}`,
                    `     ${pc.dim(`ID: ${p.prompt_id}${p.tags?.length ? ` · tags: ${p.tags.join(", ")}` : ""}`)}`,
                  ].join("\n"),
                )
              : ["  No prompts matched this filter."]),
          ],
        });
        emitNotes(ctx, data.notes);
      },
    ),
  );
}
