import { Command } from "commander";
import { apiRequest, formatApiError } from "../lib/api-client.js";
import * as log from "../utils/logger.js";

export function registerCreditsCommands(program: Command): void {
  const credits = program
    .command("credits")
    .description("View your organisation's credit balance. Credits are consumed by AI content generation and search operations.");

  credits
    .command("balance")
    .description("Get the current credit balance for the organisation. Returns available credits and any spend limit configured.")
    .action(async () => {
      const opts = program.opts();
      try {
        const data = await apiRequest({ path: "/org/credits/balance", apiKey: opts.apiKey, baseUrl: opts.baseUrl });
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });
}
