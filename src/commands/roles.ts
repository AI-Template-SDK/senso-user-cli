import { Command } from "commander";
import { apiRequest } from "../lib/api-client.js";
import { emit } from "../lib/output.js";
import { runAction } from "../lib/run-action.js";

export function registerRolesCommands(program: Command): void {
  const roles = program
    .command("roles")
    .description(
      "Inspect the roles defined for your organization. Each organization has its own per-org role_ids — resolve a role name to its UUID here before passing role_id to `users invite`, `users add`, or `users update`.",
    );

  roles
    .command("list")
    .description(
      "List every role for the current organization, including the built-in admin/collaborator/viewer roles and any custom roles.",
    )
    .action(
      runAction(program, async (ctx) => {
        const data = await apiRequest({
          path: "/org/roles",
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emit(ctx, data, { columns: ["role_id", "name", "description"] });
      }),
    );
}
