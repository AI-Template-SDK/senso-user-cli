/**
 * `senso analytics answers` — the newest stored answer per combination.
 *
 * Its own file because it is the one subcommand that is a snapshot rather than
 * a window: it declares its own `--from`/`--to` with different help text (they
 * hide rows instead of widening the sample), so it must not reuse
 * addWindowOptions.
 */

import { Command } from "commander";
import pc from "picocolors";
import { apiRequest } from "../../lib/api-client.js";
import { emit } from "../../lib/output.js";
import { runAction, type Ctx } from "../../lib/run-action.js";
import { parseEnumFlag } from "../../lib/enum-arg.js";
import { addPagingOptions, normalizeBool, PROMPT_TYPE_VALUES } from "./filters.js";
import { count, emitContext, emitNotes, NO_VALUE, truncate } from "./render.js";
import type { LatestAnswerItem } from "./types.js";

// The tiers --citation-tier accepts, as its help text lists them. `answers`
// declares its own window flags rather than taking addWindowOptions, so its
// --prompt-type is checked here too, against the shared set.
const CITATION_TIER_VALUES = ["primary", "tracked", "secondary"] as const;

export function addAnswersCommand(analytics: Command, program: Command): void {
  // ── answers ──────────────────────────────────────────────────────────────
  addPagingOptions(
    analytics
      .command("answers")
      .description(
        "The newest stored answer per prompt × model × location, with its citations and competitor mentions. This is a snapshot, not a window: --from/--to filter on when each answer was collected, so narrowing them hides combinations instead of returning older answers. Historical answer text is not retained.",
      )
      .option(
        "--from <date>",
        "Answers collected on or after this date, YYYY-MM-DD (hides rows, never reveals older answers)",
      )
      .option(
        "--to <date>",
        "Answers collected on or before this date, YYYY-MM-DD (hides rows, never reveals older answers)",
      )
      .option("--models <list>", "Comma-separated model filter")
      .option("--location <list>", "Comma-separated location filter, case-sensitive")
      .option(
        "--prompt-type <type>",
        "Funnel stage: awareness | consideration | evaluation | decision",
      )
      .option("--tag <tag>", "Restrict to prompts carrying this tag")
      .option(
        "--mentioned <bool>",
        "Only answers that did (true) or did not (false) name your brand",
      )
      .option("--cited <bool>", "Only answers that did (true) or did not (false) cite anything")
      .option(
        "--citation-tier <tier>",
        "Only answers citing this tier: primary | tracked | secondary",
      ),
    25,
  ).action(
    runAction(
      program,
      async (
        ctx: Ctx,
        cmdOpts: {
          from?: string;
          to?: string;
          models?: string;
          location?: string;
          promptType?: string;
          tag?: string;
          mentioned?: string;
          cited?: string;
          citationTier?: string;
          limit?: string;
          offset?: string;
        },
      ) => {
        const mentioned = normalizeBool("mentioned", cmdOpts.mentioned);
        const cited = normalizeBool("cited", cmdOpts.cited);
        const data = await apiRequest<{
          total: number;
          limit: number;
          offset: number;
          answers: LatestAnswerItem[];
          notes: string[];
        }>({
          path: "/org/analytics/answers/latest",
          params: {
            from: cmdOpts.from,
            to: cmdOpts.to,
            models: cmdOpts.models,
            location: cmdOpts.location,
            prompt_type: parseEnumFlag("--prompt-type", cmdOpts.promptType, PROMPT_TYPE_VALUES),
            tag: cmdOpts.tag,
            mentioned,
            cited,
            citation_tier: parseEnumFlag(
              "--citation-tier",
              cmdOpts.citationTier,
              CITATION_TIER_VALUES,
            ),
            limit: cmdOpts.limit,
            offset: cmdOpts.offset,
          },
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });

        const answers = data.answers ?? [];
        const collectedLine =
          cmdOpts.from || cmdOpts.to
            ? `  ${pc.dim(`Collected ${cmdOpts.from ?? "any"} → ${cmdOpts.to ?? "any"} — combinations whose newest answer falls outside this window are hidden, not replaced by older answers.`)}`
            : "";
        const context = [
          "",
          `  ${pc.bold("Latest answers")} ${pc.dim(`${answers.length} of ${count(data.total)} (offset ${count(data.offset)})`)}`,
          `  ${pc.dim("Snapshot of the newest answer per prompt × model × location — not a sample of any window.")}`,
          ...(collectedLine ? [collectedLine] : []),
        ];
        emitContext(ctx, context);
        emit(ctx, data, {
          table: {
            rows: answers.map((a) => ({
              run_at: (a.run_at || "").slice(0, 10),
              model: a.model,
              location: a.location,
              prompt: truncate(a.prompt_text, 40),
              mentioned: a.mentioned ? "yes" : "no",
              rank: a.rank === null || a.rank === undefined ? NO_VALUE : `#${a.rank}`,
              sentiment: a.sentiment ?? NO_VALUE,
              citations: count(a.citations?.length ?? 0),
            })),
            columns: [
              "run_at",
              "model",
              "location",
              "prompt",
              "mentioned",
              "rank",
              "sentiment",
              "citations",
            ],
          },
          plain: [
            ...context,
            "",
            ...(answers.length
              ? answers.map((a) =>
                  [
                    `  ${pc.bold(truncate(a.prompt_text, 100))} ${pc.dim(`[${a.prompt_type}]`)}`,
                    `     ${a.model} · ${a.location} · ${pc.dim(a.run_at)}`,
                    `     mentioned ${a.mentioned ? "yes" : "no"} · rank ${a.rank === null || a.rank === undefined ? NO_VALUE : `#${a.rank}`} · sentiment ${a.sentiment ?? NO_VALUE} · ${count(a.citations?.length ?? 0)} citations`,
                    `     ${pc.dim(truncate(a.response_text, 200))}`,
                    `     ${pc.dim(`ID: ${a.prompt_id}`)}`,
                  ].join("\n"),
                )
              : ["  No answers matched this filter."]),
          ],
        });
        emitNotes(ctx, data.notes);
      },
    ),
  );
}
