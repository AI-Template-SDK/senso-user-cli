import { Command } from "commander";
import { apiRequest, formatApiError } from "../lib/api-client.js";
import * as log from "../utils/logger.js";

export function registerBrandKitCommands(program: Command): void {
  const bk = program
    .command("brand-kit")
    .description("Manage brand kit");

  bk
    .command("get")
    .description("Get brand kit")
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
    .description("Upsert brand kit")
    .requiredOption("--data <json>", "JSON brand kit data")
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
