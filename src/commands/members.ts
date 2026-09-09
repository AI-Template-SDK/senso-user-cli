import { Command } from "commander";
import { apiRequest } from "../lib/api-client.js";
import { emit } from "../lib/output.js";
import { runAction } from "../lib/run-action.js";

export function registerMemberCommands(program: Command): void {
  const members = program
    .command("members")
    .description(
      "View the organization member directory. Lists all users who belong to the organization with their names and emails.",
    );

  members
    .command("list")
    .description(
      "List all organization members. Use --search to filter by name or email, --sort to order results.",
    )
    .option("--limit <n>", "Maximum members to return (max: 1000)")
    .option("--offset <n>", "Number of members to skip (for pagination)")
    .option("--search <query>", "Filter by name or email")
    .option(
      "--sort <order>",
      "Sort order: name_asc, name_desc, email_asc, email_desc, created_asc, created_desc",
    )
    .action(
      runAction(program, async (ctx, cmdOpts: Record<string, string>) => {
        const data = await apiRequest({
          path: "/org/members",
          params: {
            limit: cmdOpts.limit,
            offset: cmdOpts.offset,
            search: cmdOpts.search,
            sort: cmdOpts.sort,
          },
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        // Columns taken from what the endpoint sorts on (name, email, created).
        emit(ctx, data, { columns: ["user_id", "name", "email", "created_at"] });
      }),
    );
}
