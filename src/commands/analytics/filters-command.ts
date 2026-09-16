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
import { apiExits, describeCommand } from "../../lib/help.js";
import { MODEL_VALUES } from "./filters.js";
import { emitContext, emitNotes, NO_VALUE } from "./render.js";
import type { FilterOption } from "./types.js";

export function addFiltersCommand(analytics: Command, program: Command): void {
  // ── filters ──────────────────────────────────────────────────────────────
  describeCommand(
    analytics
      .command("filters")
      .description(
        "The models, locations, prompt types, tags and tracked competitors that actually have data for this org, plus the span of rollup days available — so you never guess a model spelling or query an empty window. This is the discovery command every --models flag in the group points at.",
      ),
    {
      returns: [
        'models[] — {id, display_name}. The `id` is what --models accepts; the display_name ("Google AI Overviews") is not a value any flag takes',
        `The full allow-list, whether or not it has data yet: ${MODEL_VALUES.join(", ")}`,
        "locations[] — case-sensitive strings, exactly as --location wants them",
        "prompt_types[] — the funnel stages that have data, out of awareness | consideration | evaluation | decision",
        "tags[] — the values --tag accepts",
        "tracked_competitors[] — {id, display_name}; manage them with `senso competitors`",
        "date_range — earliest_day and latest_day, both null when no monitoring run has completed yet",
      ],
      exitCodes: {
        ...apiExits,
        3: "no key, the organization lacks the GEO product, or the key lacks read:prompt",
      },
      examples: [
        { comment: "Before any other analytics command", command: "senso analytics filters" },
        {
          comment: "Just the model ids --models accepts",
          command: "senso analytics filters --output json | jq -r '.data.models[].id'",
        },
      ],
      seeAlso: ["senso analytics summary", "senso competitors list"],
    },
  ).action(
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

      // The id leads and the display name is parenthetical: this line is
      // labelled `--models`, and "Google AI Overviews" is a value that flag
      // REJECTS. Printing the display name alone made the one command whose
      // job is to stop a guess into the reason for one.
      const models = (data.models ?? []).map((m) =>
        m.display_name && m.display_name !== m.id ? `${m.id} (${m.display_name})` : m.id,
      );
      const competitors = (data.tracked_competitors ?? []).map((c) =>
        c.display_name && c.display_name !== c.id ? `${c.display_name} [${c.id}]` : c.id,
      );
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
            { filter: "--models (all ids)", values: MODEL_VALUES.join(", ") },
          ],
          columns: ["filter", "values"],
        },
        next: [
          {
            why: "Use one of these models and a window that has data",
            command: "senso analytics summary --models <id>",
          },
        ],
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
          "",
          `  ${pc.dim(`Every model id --models accepts, with data or without: ${MODEL_VALUES.join(", ")}`)}`,
        ],
      });
      emitNotes(ctx, data.notes);
    }),
  );
}
