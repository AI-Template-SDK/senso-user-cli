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
import { apiExits, describeCommand } from "../../lib/help.js";
import {
  addPagingOptions,
  addWindowOptions,
  pagingParams,
  windowParams,
  type WindowFilters,
} from "./filters.js";
import {
  count,
  emitContext,
  emitNotes,
  qualityLine,
  rate,
  requireBlocks,
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
  describeCommand(
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
    ),
    {
      returns: [
        "prompts[].prompt_id — an ORG prompt id. It is what `senso analytics prompt <promptId>`, `senso prompts get` and `senso generate` accept; it is NOT an industry prompt id from `senso industries prompts`",
        "prompts[].mention_rate — mentioned_count ÷ answered_count over the window",
        "prompts[].share_of_voice — this prompt's mentions of you ÷ mentions of every brand on it",
        "prompts[].avg_rank — rank_sum ÷ mentioned_count; lower is better",
        "prompts[].primary_citation_rate — answers citing an owned source ÷ this prompt's cited answers",
        "prompts[].latest — the newest collection only (run_at, answer_count, mentioned_count, models[], share_of_voice). This is the 'right now' figure the app's prompt table shows; the fields above it are the window aggregate, and the two legitimately disagree",
        "Every rate is {value, display} or null; null means the denominator was zero, never 0%",
        "prompts[].prompt_type — awareness | consideration | evaluation | decision",
        "total / limit / offset — the page; `page.next` in the JSON envelope is the runnable next call",
      ],
      exitCodes: {
        ...apiExits,
        2: "a date that is not YYYY-MM-DD, a window longer than 365 days, an unknown model, prompt type, sort field or order, or a --limit outside 1-100",
        3: "no key, the organization lacks the GEO product, or the key lacks read:prompt",
      },
      examples: [
        {
          comment: "The prompts you are least visible on",
          command: "senso analytics prompts --order asc",
        },
        {
          comment: "Just the ids, to drill into each one",
          command: "senso analytics prompts --output json | jq -r '.data.prompts[].prompt_id'",
        },
      ],
      seeAlso: ["senso analytics prompt <promptId>", "senso analytics answers", "senso prompts list"],
    },
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
            ...pagingParams(cmdOpts),
          },
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });

        requireBlocks("/org/analytics/prompts", { metrics: data.metrics });

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
          empty: "prompts",
          emptyHint:
            "Nothing matched. Drop --search or --tag, widen --from/--to, or run `senso prompts list` to see what this organization tracks at all.",
          next: [
            {
              why: "Read one prompt end to end, including its latest answers",
              command: "senso analytics prompt <prompt_id>",
            },
          ],
          plain: [
            ...context,
            "",
            ...(prompts.length
              ? prompts.map((p) =>
                  [
                    // The id leads: it is the argument every follow-up command
                    // takes, and plain output does not truncate the text.
                    `  ${pc.bold(p.prompt_id)} ${pc.dim(`[${p.prompt_type}]${p.tags?.length ? ` · tags: ${p.tags.join(", ")}` : ""}`)}`,
                    `     ${p.prompt_text}`,
                    `     mention rate ${rate(p.mention_rate)} (${count(p.mentioned_count)}/${count(p.answered_count)} answers) · SoV ${rate(p.share_of_voice)} (window) · ${rate(p.latest?.share_of_voice ?? null)} (latest collection) · avg rank ${rate(p.avg_rank)} · owned citation rate ${rate(p.primary_citation_rate)} (${count(p.primary_cited_run_count)}/${count(p.cited_run_count)} cited answers)`,
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
