import { Command } from "commander";
import { apiRequest, formatApiError } from "../lib/api-client.js";
import * as log from "../utils/logger.js";

export function registerUserCommands(program: Command): void {
  const users = program
    .command("users")
    .description("Manage users in organization");

  users
    .command("list")
    .description("List users in organization")
    .action(async () => {
      const opts = program.opts();
      try {
        const data = await apiRequest({ path: "/org/users", apiKey: opts.apiKey, baseUrl: opts.baseUrl });
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  users
    .command("add")
    .description("Add user to organization")
    .requiredOption("--data <json>", "JSON user data")
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
    .description("Get a user in the organization")
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
    .description("Update a user's role")
    .requiredOption("--data <json>", "JSON user update data")
    .action(async (userId: string, cmdOpts: { data: string }) => {
      const opts = program.opts();
      try {
        const body = JSON.parse(cmdOpts.data);
        const data = await apiRequest({
          method: "PATCH",
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
    .description("Remove a user from the organization")
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
}
