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
import { assertRange, parseDateFlag, parseEnumFlag } from "../../lib/enum-arg.js";
import { apiExits, describeCommand } from "../../lib/help.js";
import {
  addPagingOptions,
  MODEL_VALUES,
  normalizeBool,
  pagingParams,
  parseModelsFlag,
  PROMPT_TYPE_VALUES,
} from "./filters.js";
import { count, emitContext, emitNotes, NO_VALUE, truncate } from "./render.js";
import type { LatestAnswerItem } from "./types.js";

// The tiers --citation-tier accepts, as its help text lists them. `answers`
// declares its own window flags rather than taking addWindowOptions, so its
// --prompt-type is checked here too, against the shared set.
const CITATION_TIER_VALUES = ["primary", "tracked", "secondary"] as const;

export function addAnswersCommand(analytics: Command, program: Command): void {
  // ── answers ──────────────────────────────────────────────────────────────
  describeCommand(
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
        .option(
          "--models <list>",
          `Comma-separated model ids: ${MODEL_VALUES.join(", ")} — 'senso analytics filters' lists the ones with data`,
        )
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
    ),
    {
      returns: [
        "answers[].prompt_id — an ORG prompt id, for `senso analytics prompt <promptId>`",
        "answers[].model / location / run_at — the combination this answer is the newest for",
        "answers[].response_text — the answer in full; `empty` is true when the model returned nothing at all",
        "answers[].mentioned — whether your brand was named; rank is null when it was not",
        "answers[].sentiment — positive | neutral | negative, or null when the answer did not name you",
        "answers[].sov_pct — this answer's share of voice as a percentage, or null when no brand was named",
        "answers[].citations[] — url, domain, citation_type (primary | tracked | secondary)",
        "answers[].competitor_mentions — {brand: count} over this one answer",
        "answers[].has_primary|tracked|external_citation — booleans, the same tiers as `analytics citations`",
        "total / limit / offset — the page; `page.next` in the JSON envelope is the runnable next call",
      ],
      exitCodes: {
        ...apiExits,
        2: "a date that is not YYYY-MM-DD, an unknown model, prompt type or citation tier, a --mentioned/--cited that is not a boolean, or a --limit outside 1-100",
        3: "no key, the organization lacks the GEO product, or the key lacks read:prompt",
      },
      examples: [
        {
          comment: "The answers that did not name you",
          command: "senso analytics answers --mentioned false",
        },
        {
          comment: "Everything one model said, in full",
          command: "senso analytics answers --models chatgpt --limit 100",
        },
      ],
      seeAlso: [
        "senso analytics prompt <promptId>",
        "senso analytics prompts",
        "senso analytics filters",
      ],
    },
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
        const from = parseDateFlag("--from", cmdOpts.from);
        const to = parseDateFlag("--to", cmdOpts.to);
        assertRange("--from", from, "--to", to);
        const data = await apiRequest<{
          total: number;
          limit: number;
          offset: number;
          answers: LatestAnswerItem[];
          notes: string[];
        }>({
          path: "/org/analytics/answers/latest",
          params: {
            from,
            to,
            models: parseModelsFlag(cmdOpts.models),
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
            ...pagingParams(cmdOpts),
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
          empty: "answers",
          emptyHint:
            "No stored answer matched. This is a snapshot of the NEWEST answer per combination, so narrowing --from/--to hides rows rather than revealing older ones — widen them, or drop --mentioned/--cited.",
          plain: [
            ...context,
            "",
            ...(answers.length
              ? answers.map((a) =>
                  [
                    // The id first, the text in full, and the citations and
                    // competitor mentions shown rather than left for
                    // --output json: they are what this command is opened for.
                    `  ${pc.bold(a.prompt_id)} ${pc.dim(`[${a.prompt_type}]`)}`,
                    `     ${a.prompt_text}`,
                    `     ${a.model} · ${a.location} · ${pc.dim(a.run_at)}`,
                    `     mentioned ${a.mentioned ? "yes" : "no"} · rank ${a.rank === null || a.rank === undefined ? NO_VALUE : `#${a.rank}`} · sentiment ${a.sentiment ?? NO_VALUE} · ${count(a.citations?.length ?? 0)} citations`,
                    `     ${pc.dim(a.response_text)}`,
                    ...(a.citations ?? []).map(
                      (c) => `     ${pc.dim(`↳ ${c.url} [${c.citation_type}]`)}`,
                    ),
                    ...(Object.keys(a.competitor_mentions ?? {}).length > 0
                      ? [
                          `     ${pc.dim(
                            `competitors named: ${Object.entries(a.competitor_mentions)
                              .map(([brand, n]) => `${brand} ×${String(n)}`)
                              .join(", ")}`,
                          )}`,
                        ]
                      : []),
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
