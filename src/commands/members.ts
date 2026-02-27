import { Command } from "commander";
import { apiRequest, formatApiError } from "../lib/api-client.js";
import * as log from "../utils/logger.js";

export function registerMemberCommands(program: Command): void {
  const members = program
    .command("members")
    .description("Organization members");

  members
    .command("list")
    .description("List organization members")
    .action(async () => {
      const opts = program.opts();
      try {
        const data = await apiRequest({ path: "/org/members", apiKey: opts.apiKey, baseUrl: opts.baseUrl });
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });
}
