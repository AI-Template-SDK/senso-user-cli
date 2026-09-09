import { Command } from "commander";
import { apiRequest } from "../lib/api-client.js";
import { emit } from "../lib/output.js";
import { runAction } from "../lib/run-action.js";

export function registerGeneratedContentCommands(program: Command): void {
  const gc = program
    .command("generated-content")
    .description(
      "Browse AI-generated content (GEO). List published or draft generated items, or fetch a single item with its rendered body. Requires the GEO product and read:content permission.",
    );

  gc.command("list")
    .description(
      "List generated content. Use --status to switch between published and draft items.",
    )
    .option("--status <status>", "Which items to list: published | drafts", "published")
    .option("--limit <n>", "Items per page (max 100)", "10")
    .option("--offset <n>", "Pagination offset", "0")
    .option("--search <query>", "Filter by title")
    .action(
      runAction(program, async (ctx, cmdOpts: Record<string, string>) => {
        const status =
          cmdOpts.status === "drafts" || cmdOpts.status === "draft" ? "drafts" : "published";
        const data = await apiRequest({
          path: `/org/generated-content/${status}`,
          params: { limit: cmdOpts.limit, offset: cmdOpts.offset, search: cmdOpts.search },
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emit(ctx, data, { columns: ["id", "title", "status", "created_at"] });
      }),
    );

  gc.command("get <id>")
    .description(
      "Get a single generated content item including its question text and rendered body.",
    )
    .action(
      runAction(program, async (ctx, id: string) => {
        const data = await apiRequest({
          path: `/org/generated-content/${id}`,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emit(ctx, data);
      }),
    );
}
