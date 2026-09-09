import { Command } from "commander";
import { apiRequest } from "../lib/api-client.js";
import { parseJsonFlag } from "../lib/json-arg.js";
import { emit, emitConfirmation } from "../lib/output.js";
import { runAction } from "../lib/run-action.js";
import * as log from "../utils/logger.js";

export function registerCompetitorsCommands(program: Command): void {
  const competitors = program
    .command("competitors")
    .description(
      "Manage the curated list of competitor brands your organization tracks. Tracked competitors feed downstream share-of-voice analytics and inform content-generation prompts.",
    );

  competitors
    .command("list")
    .description("List every tracked competitor for the current organization.")
    .action(
      runAction(program, async (ctx) => {
        const data = await apiRequest({
          path: "/org/competitors",
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emit(ctx, data, {
          columns: ["competitor_id", "name", "url", "source", "created_at"],
        });
      }),
    );

  competitors
    .command("add")
    .description("Add a single tracked competitor.")
    .requiredOption("--name <name>", "Competitor brand name")
    .option("--url <url>", "Competitor website URL")
    .action(
      runAction(program, async (ctx, cmdOpts: { name: string; url?: string }) => {
        const body: Record<string, unknown> = { name: cmdOpts.name };
        if (cmdOpts.url) body.url = cmdOpts.url;
        const data = await apiRequest({
          method: "POST",
          path: "/org/competitors",
          body,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        if (!ctx.quiet) log.success(`Tracked competitor "${cmdOpts.name}" added.`);
        emit(ctx, data);
      }),
    );

  competitors
    .command("batch-add")
    .description(
      "Add up to 50 tracked competitors in one call. Designed for accepting AI-generated suggestions returned by `competitors suggest`.",
    )
    .requiredOption(
      "--data <json>",
      'JSON: { "items": [{ "name": "...", "url": "...", "source": "manual|suggested_run_text|suggested_web_search", "rationale": "...", "confidence": 0.85 }, ...] }',
    )
    .action(
      runAction(program, async (ctx, cmdOpts: { data: string }) => {
        const body = parseJsonFlag(cmdOpts.data);
        const data = await apiRequest({
          method: "POST",
          path: "/org/competitors/batch",
          body,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        if (!ctx.quiet) log.success("Tracked competitors added.");
        emit(ctx, data);
      }),
    );

  competitors
    .command("suggest")
    .description(
      "Get AI-generated competitor suggestions seeded from your org's website and recent prompt-run results. Pipe accepted suggestions into `competitors batch-add`.",
    )
    .action(
      runAction(program, async (ctx) => {
        const data = await apiRequest({
          method: "POST",
          path: "/org/competitors/suggest",
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        // Suggestions carry the fields `batch-add` accepts, so the table shows
        // what you would be sending on.
        emit(ctx, data, { columns: ["name", "url", "source", "confidence", "rationale"] });
      }),
    );

  competitors
    .command("update <competitorId>")
    .description("Update a tracked competitor's name or URL.")
    .requiredOption("--name <name>", "Competitor brand name")
    .option("--url <url>", "Competitor website URL")
    .action(
      runAction(
        program,
        async (ctx, competitorId: string, cmdOpts: { name: string; url?: string }) => {
          const body: Record<string, unknown> = { name: cmdOpts.name };
          if (cmdOpts.url) body.url = cmdOpts.url;
          const data = await apiRequest({
            method: "PUT",
            path: `/org/competitors/${competitorId}`,
            body,
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
          });
          if (!ctx.quiet) log.success(`Tracked competitor ${competitorId} updated.`);
          emit(ctx, data);
        },
      ),
    );

  competitors
    .command("delete <competitorId>")
    .description("Remove a tracked competitor.")
    .action(
      runAction(program, async (ctx, competitorId: string) => {
        await apiRequest({
          method: "DELETE",
          path: `/org/competitors/${competitorId}`,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emitConfirmation(ctx, `Tracked competitor ${competitorId} removed.`);
      }),
    );
}
