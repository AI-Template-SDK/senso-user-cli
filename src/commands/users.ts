import { Command } from "commander";
import { apiRequest, formatApiError } from "../lib/api-client.js";
import * as log from "../utils/logger.js";

export function registerUserCommands(program: Command): void {
  const users = program
    .command("users")
    .description("Manage users within the organization. Add, update roles, remove users, or set the active organization for a user.");

  users
    .command("list")
    .description("List all users in the organization. Returns user IDs, roles, and membership status.")
    .option("--limit <n>", "Maximum number of users to return")
    .option("--offset <n>", "Number of users to skip (for pagination)")
    .action(async (cmdOpts: Record<string, string>) => {
      const opts = program.opts();
      try {
        const data = await apiRequest({
          path: "/org/users",
          params: { limit: cmdOpts.limit, offset: cmdOpts.offset },
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  users
    .command("add")
    .description("Add an existing platform user to the organization. Requires user_id and role_id.")
    .requiredOption("--data <json>", 'JSON: { "user_id": "uuid", "role_id": "uuid", "is_current": false }')
    .action(async (cmdOpts: { data: string }) => {
      const opts = program.opts();
      try {
        const body = JSON.parse(cmdOpts.data);
        const data = await apiRequest({
          method: "POST",
          path: "/org/users",
          body,
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        log.success("User added.");
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(err instanceof SyntaxError ? "Invalid JSON in --data" : formatApiError(err));
        process.exit(1);
      }
    });

  users
    .command("get <userId>")
    .description("Get a user's details including their role and membership status in the organization.")
    .action(async (userId: string) => {
      const opts = program.opts();
      try {
        const data = await apiRequest({ path: `/org/users/${userId}`, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  users
    .command("update <userId>")
    .description("Update a user's role in the organization. Requires role_id in the JSON body.")
    .requiredOption("--data <json>", 'JSON: { "role_id": "uuid", "is_current": true }')
    .action(async (userId: string, cmdOpts: { data: string }) => {
      const opts = program.opts();
      try {
        const body = JSON.parse(cmdOpts.data);
        const data = await apiRequest({
          method: "PUT",
          path: `/org/users/${userId}`,
          body,
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        log.success(`User ${userId} updated.`);
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(err instanceof SyntaxError ? "Invalid JSON in --data" : formatApiError(err));
        process.exit(1);
      }
    });

  users
    .command("remove <userId>")
    .description("Remove a user from the organization. This does not delete the platform user account.")
    .action(async (userId: string) => {
      const opts = program.opts();
      try {
        await apiRequest({ method: "DELETE", path: `/org/users/${userId}`, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
        log.success(`User ${userId} removed.`);
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  users
    .command("set-current <userId>")
    .description("Set this organization as the current (active) organization for a user.")
    .action(async (userId: string) => {
      const opts = program.opts();
      try {
        await apiRequest({
          method: "PATCH",
          path: `/org/users/${userId}/current`,
          body: { is_current: true },
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        log.success(`Organization set as current for user ${userId}.`);
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });
}
