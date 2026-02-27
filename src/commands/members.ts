import { Command } from "commander";
import { apiRequest, formatApiError } from "../lib/api-client.js";
import * as log from "../utils/logger.js";

export function registerMemberCommands(program: Command): void {
  const members = program
    .command("members")
    .description("View the organization member directory. Lists all users who belong to the organization with their names and emails.");

  members
    .command("list")
    .description("List all organization members. Use --search to filter by name or email, --sort to order results.")
    .option("--limit <n>", "Maximum members to return (max: 1000)")
    .option("--offset <n>", "Number of members to skip (for pagination)")
    .option("--search <query>", "Filter by name or email")
    .option("--sort <order>", "Sort order: name_asc, name_desc, email_asc, email_desc, created_asc, created_desc")
    .action(async (cmdOpts: Record<string, string>) => {
      const opts = program.opts();
      try {
        const data = await apiRequest({
          path: "/org/members",
          params: { limit: cmdOpts.limit, offset: cmdOpts.offset, search: cmdOpts.search, sort: cmdOpts.sort },
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });
}
