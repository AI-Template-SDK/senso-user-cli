import { Command } from "commander";
import { apiRequest, formatApiError } from "../lib/api-client.js";
import * as log from "../utils/logger.js";

export function registerTopicCommands(program: Command): void {
  const topics = program
    .command("topics")
    .description("Manage topics within categories");

  topics
    .command("list <categoryId>")
    .description("List topics for a category")
    .action(async (categoryId: string) => {
      const opts = program.opts();
      try {
        const data = await apiRequest({
          path: `/org/categories/${categoryId}/topics`,
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  topics
    .command("create <categoryId>")
    .description("Create topic in category")
    .requiredOption("--name <name>", "Topic name")
    .action(async (categoryId: string, cmdOpts: { name: string }) => {
      const opts = program.opts();
      try {
        const data = await apiRequest({
          method: "POST",
          path: `/org/categories/${categoryId}/topics`,
          body: { name: cmdOpts.name },
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        log.success(`Topic "${cmdOpts.name}" created.`);
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  topics
    .command("get <categoryId> <topicId>")
    .description("Get topic by ID")
    .action(async (categoryId: string, topicId: string) => {
      const opts = program.opts();
      try {
        const data = await apiRequest({
          path: `/org/categories/${categoryId}/topics/${topicId}`,
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  topics
    .command("update <categoryId> <topicId>")
    .description("Update a topic")
    .requiredOption("--name <name>", "New topic name")
    .action(async (categoryId: string, topicId: string, cmdOpts: { name: string }) => {
      const opts = program.opts();
      try {
        const data = await apiRequest({
          method: "PATCH",
          path: `/org/categories/${categoryId}/topics/${topicId}`,
          body: { name: cmdOpts.name },
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        log.success(`Topic ${topicId} updated.`);
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  topics
    .command("delete <categoryId> <topicId>")
    .description("Delete a topic")
    .action(async (categoryId: string, topicId: string) => {
      const opts = program.opts();
      try {
        await apiRequest({
          method: "DELETE",
          path: `/org/categories/${categoryId}/topics/${topicId}`,
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        log.success(`Topic ${topicId} deleted.`);
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  topics
    .command("batch-create <categoryId>")
    .description("Batch create topics in a category")
    .requiredOption("--data <json>", "JSON array of topics")
    .action(async (categoryId: string, cmdOpts: { data: string }) => {
      const opts = program.opts();
      try {
        const body = JSON.parse(cmdOpts.data);
        const data = await apiRequest({
          method: "POST",
          path: `/org/categories/${categoryId}/topics/batch`,
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
