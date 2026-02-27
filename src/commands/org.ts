import { Command } from "commander";
import { apiRequest, formatApiError } from "../lib/api-client.js";
import * as log from "../utils/logger.js";

export function registerOrgCommands(program: Command): void {
  const org = program
    .command("org")
    .description("View and update organization profile and settings. Includes name, slug, logo, websites, locations, and tier information.");

  org
    .command("get")
    .description("Get full organization details including name, slug, tier, websites, locations, configured AI models, publishers, and schedule.")
    .action(async () => {
      const opts = program.opts();
      try {
        const data = await apiRequest({ path: "/org/me", apiKey: opts.apiKey, baseUrl: opts.baseUrl });
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  org
    .command("update")
    .description("Update organization details. All fields are optional — only provided fields are changed. Pass an empty array for websites/locations to clear them.")
    .requiredOption("--data <json>", 'JSON: { "name": "...", "slug": "...", "logo_url": "...", "websites": [...], "locations": [...] }')
    .action(async (cmdOpts: { data: string }) => {
      const opts = program.opts();
      try {
        const body = JSON.parse(cmdOpts.data);
        const data = await apiRequest({
          method: "PUT",
          path: "/org/me",
          body,
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        log.success("Organization updated.");
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(err instanceof SyntaxError ? "Invalid JSON in --data" : formatApiError(err));
        process.exit(1);
      }
    });
}
