import { Command } from "commander";
import { apiRequest } from "../lib/api-client.js";
import { emit } from "../lib/output.js";
import { runAction } from "../lib/run-action.js";

export function registerPermissionsCommands(program: Command): void {
  const perms = program
    .command("permissions")
    .description("View available role permissions for the organization.");

  perms
    .command("list")
    .description(
      "List all available permission keys with their names, descriptions, and categories. Useful for building role management UIs.",
    )
    .action(
      runAction(program, async (ctx) => {
        const data = await apiRequest({
          path: "/org/permissions",
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emit(ctx, data, { columns: ["key", "name", "category", "description"] });
      }),
    );
}
