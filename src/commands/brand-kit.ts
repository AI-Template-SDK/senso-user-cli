import { Command } from "commander";
import { apiRequest, formatApiError } from "../lib/api-client.js";
import * as log from "../utils/logger.js";

export function registerBrandKitCommands(program: Command): void {
  const bk = program
    .command("brand-kit")
    .description("Manage the organization's brand kit guidelines. The brand kit is a free-form JSON object that informs AI content generation about your brand voice, tone, and style.");

  bk
    .command("get")
    .description("Get the current brand kit guidelines.")
    .action(async () => {
      const opts = program.opts();
      try {
        const data = await apiRequest({ path: "/org/brand-kit", apiKey: opts.apiKey, baseUrl: opts.baseUrl });
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  bk
    .command("set")
    .description("Create or replace the brand kit. The guidelines field is a free-form JSON object defining your brand voice.")
    .requiredOption("--data <json>", 'JSON: { "guidelines": { "tone": "professional", "voice": "..." } }')
    .action(async (cmdOpts: { data: string }) => {
      const opts = program.opts();
      try {
        const body = JSON.parse(cmdOpts.data);
        const data = await apiRequest({
          method: "PUT",
          path: "/org/brand-kit",
          body,
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        log.success("Brand kit updated.");
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(err instanceof SyntaxError ? "Invalid JSON in --data" : formatApiError(err));
        process.exit(1);
      }
    });
}
