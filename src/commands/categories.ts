import { Command } from "commander";
import { apiRequest, formatApiError } from "../lib/api-client.js";
import * as log from "../utils/logger.js";

export function registerCategoryCommands(program: Command): void {
  const cat = program
    .command("categories")
    .description("Manage categories");

  cat
    .command("list")
    .description("List categories")
    .action(async () => {
      const opts = program.opts();
      try {
        const data = await apiRequest({ path: "/org/categories", apiKey: opts.apiKey, baseUrl: opts.baseUrl });
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  cat
    .command("list-all")
    .description("List all categories with their topics")
    .action(async () => {
      const opts = program.opts();
      try {
        const data = await apiRequest({ path: "/org/categories/all", apiKey: opts.apiKey, baseUrl: opts.baseUrl });
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  cat
    .command("create <name>")
    .description("Create a category")
    .action(async (name: string) => {
      const opts = program.opts();
      try {
        const data = await apiRequest({
          method: "POST",
          path: "/org/categories",
          body: { name },
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        log.success(`Category "${name}" created.`);
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  cat
    .command("get <id>")
    .description("Get category by ID")
    .action(async (id: string) => {
      const opts = program.opts();
      try {
        const data = await apiRequest({ path: `/org/categories/${id}`, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  cat
    .command("update <id>")
    .description("Update a category")
    .requiredOption("--name <name>", "New category name")
    .action(async (id: string, cmdOpts: { name: string }) => {
      const opts = program.opts();
      try {
        const data = await apiRequest({
          method: "PATCH",
          path: `/org/categories/${id}`,
          body: { name: cmdOpts.name },
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        log.success(`Category ${id} updated.`);
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  cat
    .command("delete <id>")
    .description("Delete a category")
    .action(async (id: string) => {
      const opts = program.opts();
      try {
        await apiRequest({ method: "DELETE", path: `/org/categories/${id}`, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
        log.success(`Category ${id} deleted.`);
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  cat
    .command("batch-create")
    .description("Batch create categories with topics")
    .requiredOption("--data <json>", "JSON array of categories with topics")
    .action(async (cmdOpts: { data: string }) => {
      const opts = program.opts();
      try {
        const body = JSON.parse(cmdOpts.data);
        const data = await apiRequest({
          method: "POST",
          path: "/org/categories/batch",
          body,
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        log.success("Batch create completed.");
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(err instanceof SyntaxError ? "Invalid JSON in --data" : formatApiError(err));
        process.exit(1);
      }
    });
}
