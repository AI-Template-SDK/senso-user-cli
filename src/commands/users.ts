import { Command } from "commander";
import { apiRequest } from "../lib/api-client.js";
import { emit, emitConfirmation } from "../lib/output.js";
import { parseJsonFlag } from "../lib/json-arg.js";
import { runAction } from "../lib/run-action.js";
import * as log from "../utils/logger.js";

export function registerUserCommands(program: Command): void {
  const users = program
    .command("users")
    .description(
      "Manage users within the organization. Add, update roles, remove users, or set the active organization for a user.",
    );

  users
    .command("list")
    .description(
      "List all users in the organization. Returns user IDs, roles, and membership status.",
    )
    .option("--limit <n>", "Maximum number of users to return")
    .option("--offset <n>", "Number of users to skip (for pagination)")
    .action(
      runAction(program, async (ctx, cmdOpts: Record<string, string>) => {
        const data = await apiRequest({
          path: "/org/users",
          params: { limit: cmdOpts.limit, offset: cmdOpts.offset },
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emit(ctx, data, {
          columns: ["org_user_id", "user_id", "role_id", "is_current", "created_at"],
        });
      }),
    );

  users
    .command("add")
    .description("Add an existing platform user to the organization. Requires user_id and role_id.")
    .requiredOption(
      "--data <json>",
      'JSON: { "user_id": "uuid", "role_id": "uuid", "is_current": false }',
    )
    .action(
      runAction(program, async (ctx, cmdOpts: { data: string }) => {
        const body = parseJsonFlag(cmdOpts.data);
        const data = await apiRequest({
          method: "POST",
          path: "/org/users",
          body,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        if (!ctx.quiet) log.success("User added.");
        emit(ctx, data);
      }),
    );

  users
    .command("get <userId>")
    .description(
      "Get a user's details including their role and membership status in the organization.",
    )
    .action(
      runAction(program, async (ctx, userId: string) => {
        const data = await apiRequest({
          path: `/org/users/${userId}`,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emit(ctx, data);
      }),
    );

  users
    .command("update <userId>")
    .description("Update a user's role in the organization. Requires role_id in the JSON body.")
    .requiredOption("--data <json>", 'JSON: { "role_id": "uuid", "is_current": true }')
    .action(
      runAction(program, async (ctx, userId: string, cmdOpts: { data: string }) => {
        const body = parseJsonFlag(cmdOpts.data);
        const data = await apiRequest({
          method: "PUT",
          path: `/org/users/${userId}`,
          body,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        if (!ctx.quiet) log.success(`User ${userId} updated.`);
        emit(ctx, data);
      }),
    );

  users
    .command("remove <userId>")
    .description(
      "Remove a user from the organization. This does not delete the platform user account.",
    )
    .action(
      runAction(program, async (ctx, userId: string) => {
        await apiRequest({
          method: "DELETE",
          path: `/org/users/${userId}`,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emitConfirmation(ctx, `User ${userId} removed.`);
      }),
    );

  users
    .command("set-current <userId>")
    .description("Set this organization as the current (active) organization for a user.")
    .action(
      runAction(program, async (ctx, userId: string) => {
        await apiRequest({
          method: "PATCH",
          path: `/org/users/${userId}/current`,
          body: { is_current: true },
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emitConfirmation(ctx, `Organization set as current for user ${userId}.`);
      }),
    );

  users
    .command("invite")
    .description(
      "Invite a brand-new user by email. Creates the user (in Clerk and Senso) and adds them to the organization with the given role. Use `roles list` to find a role_id. If the email already belongs to a Senso user, use `users invite-existing` instead.",
    )
    .requiredOption("--email <email>", "User's email address")
    .requiredOption("--given-name <name>", "First name")
    .requiredOption("--family-name <name>", "Last name")
    .requiredOption("--role-id <uuid>", "Role to assign — resolve with `senso roles list`")
    .option("--is-current", "Make this org the new user's current org")
    .action(
      runAction(
        program,
        async (
          ctx,
          cmdOpts: {
            email: string;
            givenName: string;
            familyName: string;
            roleId: string;
            isCurrent?: boolean;
          },
        ) => {
          const data = await apiRequest({
            method: "POST",
            path: "/org/users/invite",
            body: {
              email: cmdOpts.email,
              given_name: cmdOpts.givenName,
              family_name: cmdOpts.familyName,
              role_id: cmdOpts.roleId,
              is_current: cmdOpts.isCurrent ?? false,
            },
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
          });
          if (!ctx.quiet) log.success(`Invited ${cmdOpts.email} to the organization.`);
          emit(ctx, data);
        },
      ),
    );

  users
    .command("invite-existing")
    .description(
      "Add an existing Senso user to the organization by email. Returns 404 if no user with that email exists — use `users invite` for brand-new users.",
    )
    .requiredOption("--email <email>", "Email of an existing Senso user")
    .requiredOption("--role-id <uuid>", "Role to assign — resolve with `senso roles list`")
    .option("--is-current", "Make this org the user's current org")
    .action(
      runAction(
        program,
        async (ctx, cmdOpts: { email: string; roleId: string; isCurrent?: boolean }) => {
          const data = await apiRequest({
            method: "POST",
            path: "/org/users/invite/existing",
            body: {
              email: cmdOpts.email,
              role_id: cmdOpts.roleId,
              is_current: cmdOpts.isCurrent ?? false,
            },
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
          });
          if (!ctx.quiet) log.success(`Added ${cmdOpts.email} to the organization.`);
          emit(ctx, data);
        },
      ),
    );
}
