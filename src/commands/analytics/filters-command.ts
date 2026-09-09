/**
 * `senso analytics filters` — the filter values that actually have data.
 *
 * Named filters-command.ts so it does not collide with filters.ts, which holds
 * the shared option builders. This file registers the subcommand; that one
 * defines the flags every other subcommand accepts.
 */

import { Command } from "commander";
import pc from "picocolors";
import { apiRequest } from "../../lib/api-client.js";
import { emit } from "../../lib/output.js";
import { runAction } from "../../lib/run-action.js";
import { emitContext, emitNotes, NO_VALUE } from "./render.js";
import type { FilterOption } from "./types.js";

export function addFiltersCommand(analytics: Command, program: Command): void {
  // ── filters ──────────────────────────────────────────────────────────────
  analytics
    .command("filters")
    .description(
      "The models, locations, prompt types, tags and tracked competitors that actually have data for this org, plus the span of rollup days available — so you never guess a model spelling or query an empty window.",
    )
    .action(
      runAction(program, async (ctx) => {
        const data = await apiRequest<{
          models: FilterOption[];
          locations: string[];
          prompt_types: string[];
          tags: string[];
          tracked_competitors: FilterOption[];
          date_range: { earliest_day: string | null; latest_day: string | null };
          notes: string[];
        }>({
          path: "/org/analytics/filters",
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });

        const models = (data.models ?? []).map((m) => m.display_name || m.id);
        const competitors = (data.tracked_competitors ?? []).map((c) => c.display_name || c.id);
        const range = data.date_range;
        const rangeText =
          range?.earliest_day && range?.latest_day
            ? `${range.earliest_day} → ${range.latest_day}`
            : "no rollup days yet";

        const list = (values: string[]): string => (values.length ? values.join(", ") : NO_VALUE);

        emitContext(ctx, ["", `  ${pc.bold("Available filters")}`]);
        emit(ctx, data, {
          table: {
            rows: [
              { filter: "--models", values: list(models) },
              { filter: "--location", values: list(data.locations ?? []) },
              { filter: "--prompt-type", values: list(data.prompt_types ?? []) },
              { filter: "--tag", values: list(data.tags ?? []) },
              { filter: "tracked competitors", values: list(competitors) },
              { filter: "date range", values: rangeText },
            ],
            columns: ["filter", "values"],
          },
          plain: [
            "",
            `  ${pc.bold("Available filters")}`,
            "",
            `  ${pc.bold("--models")}        ${list(models)}`,
            `  ${pc.bold("--location")}      ${list(data.locations ?? [])}`,
            `  ${pc.bold("--prompt-type")}   ${list(data.prompt_types ?? [])}`,
            `  ${pc.bold("--tag")}           ${list(data.tags ?? [])}`,
            "",
            `  ${pc.bold("Tracked competitors")}  ${list(competitors)}`,
            `  ${pc.bold("Date range")}           ${rangeText}`,
          ],
        });
        emitNotes(ctx, data.notes);
      }),
    );
}
