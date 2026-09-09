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
import { emitContext, NO_VALUE } from "./render.js";
import type { GlossaryEntry } from "./types.js";

export function addGlossaryCommand(analytics: Command, program: Command): void {
  // ── glossary ─────────────────────────────────────────────────────────────
  analytics
    .command("glossary")
    .description(
      "Canonical definition, denominator and gotcha for every metric these endpoints emit. Read this before quoting a number — a Citation Rate divides by cited answers (D), a Citation Share divides by citation instances (S), and they are not interchangeable.",
    )
    .action(
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
            })),
            columns: ["metric", "denominator", "definition"],
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
