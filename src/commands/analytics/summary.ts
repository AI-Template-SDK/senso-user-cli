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
import { apiExits, describeCommand } from "../../lib/help.js";
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
  requireBlocks,
  windowLine,
} from "./render.js";
import type { AnalyticsWindow, DataQuality, Deltas, Metrics, Totals } from "./types.js";

export function addSummaryCommand(analytics: Command, program: Command): void {
  // ── summary ──────────────────────────────────────────────────────────────
  describeCommand(
    addWindowOptions(
      analytics
        .command("summary")
        .description(
          "One-call dashboard: every headline metric with its raw counts, plus the preceding equal-length window and the deltas between them.",
        ),
    ),
    {
      returns: [
        "window — from, to, days, latest_data_day: the window actually used",
        "totals — the additive counts every rate divides: answered_count, mentioned_count, mention_total, brand_mention_total, rank_sum, cited_run_count (D), cited_total (S)",
        "metrics.mention_rate — mentioned_count ÷ answered_count",
        "metrics.share_of_voice — mention_total ÷ brand_mention_total (mentions of EVERY brand, not only tracked competitors)",
        "metrics.avg_rank — rank_sum ÷ mentioned_count; lower is better",
        "metrics.primary|tracked|external_citation_rate — that tier's cited answers ÷ D (cited_run_count)",
        "metrics.primary|tracked|external_citation_share — that tier's citations ÷ S (cited_total)",
        "metrics.citations_per_answer — S ÷ D; an intensity, not a percentage",
        "Every metric is {value, display} or null. null means the denominator was zero — it is never a 0%, and it renders as “—”",
        "deltas — mention_rate, share_of_voice, primary_citation_rate as {prev, delta, direction, display}; direction is improved | declined | flat, and a delta is null when either window lacked the denominator",
        "data_quality.level — low | medium | high, with reasons[]",
        "notes[] — why a value is null and what it may not be compared with",
      ],
      exitCodes: {
        ...apiExits,
        2: "a date that is not YYYY-MM-DD, a window longer than 365 days, or an unknown model or prompt type",
        3: "no key, the organization lacks the GEO product, or the key lacks read:prompt",
      },
      examples: [
        { comment: "The default 30-day window", command: "senso analytics summary" },
        {
          comment: "One month, two models",
          command:
            "senso analytics summary --from 2026-08-01 --to 2026-08-31 --models chatgpt,gemini",
        },
        {
          comment: "Read one metric, and its null-ness, from a script",
          command: "senso analytics summary --output json | jq '.data.metrics.mention_rate'",
        },
      ],
      seeAlso: ["senso analytics glossary", "senso analytics prompts", "senso analytics filters"],
    },
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

      requireBlocks("/org/analytics/summary", {
        totals: data.totals,
        metrics: data.metrics,
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
        next: [
          {
            why: "Find the prompts you are invisible on",
            command: "senso analytics prompts --order asc",
          },
          {
            why: "Read the denominator of every metric above before quoting one",
            command: "senso analytics glossary",
          },
        ],
      });
      emitNotes(ctx, data.notes);
    }),
  );
}
