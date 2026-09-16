/**
 * `senso analytics glossary` — the canonical metric definitions.
 *
 * Its own file: it takes no filters and hits no rollup, so it shares nothing
 * with the window commands beyond the emit helpers, and it is the reference the
 * `analytics` group description points readers at.
 */

import { Command } from "commander";
import pc from "picocolors";
import { apiRequest } from "../../lib/api-client.js";
import { emit } from "../../lib/output.js";
import { runAction } from "../../lib/run-action.js";
import { apiExits, describeCommand } from "../../lib/help.js";
import { emitContext, NO_VALUE } from "./render.js";
import type { GlossaryEntry } from "./types.js";

export function addGlossaryCommand(analytics: Command, program: Command): void {
  // ── glossary ─────────────────────────────────────────────────────────────
  describeCommand(
    analytics
      .command("glossary")
      .description(
        "Canonical definition, denominator and gotcha for every metric these endpoints emit. Read this before quoting a number — a Citation Rate divides by cited answers (D), a Citation Share divides by citation instances (S), and they are not interchangeable.",
      ),
    {
      returns: [
        "entries[].metric — the field name as it appears in every other analytics payload's `definitions` block",
        "entries[].definition — what it measures, in one sentence",
        "entries[].denominator — what it divides by; absent for a raw count",
        "entries[].gotcha — the misreading this metric invites. Shown in table, plain and json",
        "The content is static: it describes the metrics, not this organization's data, so it is safe to cache",
      ],
      exitCodes: {
        ...apiExits,
        3: "no key, the organization lacks the GEO product, or the key lacks read:prompt — the definitions are gated with the rest of the group",
      },
      examples: [
        { comment: "Read every definition", command: "senso analytics glossary" },
        {
          comment: "Look one up",
          command:
            "senso analytics glossary --output json | jq '.data.entries[] | select(.metric == \"share_of_voice\")'",
        },
      ],
      seeAlso: ["senso analytics summary", "senso analytics citations"],
    },
  ).action(
    runAction(program, async (ctx) => {
      const data = await apiRequest<{ entries: GlossaryEntry[] }>({
        path: "/org/analytics/glossary",
        apiKey: ctx.apiKey,
        baseUrl: ctx.baseUrl,
      });

      const entries = data.entries ?? [];
      emitContext(ctx, [
        "",
        `  ${pc.bold("Metric glossary")} ${pc.dim(`${entries.length} metrics — gotchas shown in plain and json output`)}`,
      ]);
      emit(ctx, data, {
        table: {
          rows: entries.map((e) => ({
            metric: e.metric,
            // `||` not `??`: an empty denominator string is as absent as a
            // missing one, and should render as the placeholder.
            // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
            denominator: e.denominator || NO_VALUE,
            definition: e.definition,
            // The gotcha carries the warning that stops a number being
            // misquoted, so it is a column rather than a plain-only extra.
            // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
            gotcha: e.gotcha || NO_VALUE,
          })),
          columns: ["metric", "denominator", "definition", "gotcha"],
        },
        plain: [
          "",
          `  ${pc.bold("Metric glossary")}`,
          "",
          ...entries.map((e) =>
            [
              `  ${pc.bold(e.metric)}`,
              `     ${e.definition}`,
              ...(e.denominator ? [`     ${pc.dim(`Denominator: ${e.denominator}`)}`] : []),
              ...(e.gotcha ? [`     ${pc.yellow("Gotcha:")} ${e.gotcha}`] : []),
            ].join("\n"),
          ),
        ],
      });
    }),
  );
}
