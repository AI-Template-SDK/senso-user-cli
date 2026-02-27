import { Command } from "commander";
import { apiRequest, formatApiError } from "../lib/api-client.js";
import * as log from "../utils/logger.js";

export function registerPromptCommands(program: Command): void {
  const prompts = program
    .command("prompts")
    .description("Manage prompts (geo questions)");

  prompts
    .command("list")
    .description("List prompts")
    .action(async () => {
      const opts = program.opts();
      try {
        const data = await apiRequest({ path: "/org/prompts", apiKey: opts.apiKey, baseUrl: opts.baseUrl });
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  prompts
    .command("create")
    .description("Create a prompt")
    .requiredOption("--data <json>", "JSON prompt definition")
    .action(async (cmdOpts: { data: string }) => {
      const opts = program.opts();
      try {
        const body = JSON.parse(cmdOpts.data);
        const data = await apiRequest({
          method: "POST",
          path: "/org/prompts",
          body,
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        log.success("Prompt created.");
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(err instanceof SyntaxError ? "Invalid JSON in --data" : formatApiError(err));
        process.exit(1);
      }
    });

  prompts
    .command("get <promptId>")
    .description("Get prompt with full run history")
    .action(async (promptId: string) => {
      const opts = program.opts();
      try {
        const data = await apiRequest({ path: `/org/prompts/${promptId}`, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  prompts
    .command("delete <promptId>")
    .description("Delete a prompt")
    .action(async (promptId: string) => {
      const opts = program.opts();
      try {
        await apiRequest({ method: "DELETE", path: `/org/prompts/${promptId}`, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
        log.success(`Prompt ${promptId} deleted.`);
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });
}
