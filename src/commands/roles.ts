import { Command } from "commander";
import { apiRequest, formatApiError } from "../lib/api-client.js";
import * as log from "../utils/logger.js";

export function registerRolesCommands(program: Command): void {
  const roles = program
    .command("roles")
    .description("Inspect the roles defined for your organization. Each organization has its own per-org role_ids — resolve a role name to its UUID here before passing role_id to `users invite`, `users add`, or `users update`.");

  roles
    .command("list")
    .description("List every role for the current organization, including the built-in admin/collaborator/viewer roles and any custom roles.")
    .action(async () => {
      const opts = program.opts();
      try {
        const data = await apiRequest({
          path: "/org/roles",
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
