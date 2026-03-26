import { Command } from "commander";
import { apiRequest, formatApiError } from "../lib/api-client.js";
import * as log from "../utils/logger.js";

export function registerPermissionsCommands(program: Command): void {
  const perms = program
    .command("permissions")
    .description("View available role permissions for the organization.");

  perms
    .command("list")
    .description("List all available permission keys with their names, descriptions, and categories. Useful for building role management UIs.")
    .action(async () => {
      const opts = program.opts();
      try {
        const data = await apiRequest({ path: "/org/permissions", apiKey: opts.apiKey, baseUrl: opts.baseUrl });
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });
}
