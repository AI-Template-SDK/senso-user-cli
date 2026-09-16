import { Command } from "commander";
import { ApiError, apiRequest } from "../lib/api-client.js";
import { CliError, EXIT, usageError } from "../lib/errors.js";
import { parseIntFlag } from "../lib/enum-arg.js";
import { describeCommand, idExits } from "../lib/help.js";
import { parseId } from "../lib/id-arg.js";
import { parseJsonFlag } from "../lib/json-arg.js";
import { emit, emitConfirmation } from "../lib/output.js";
import type { ResourceRef } from "../lib/resource.js";
import { runAction } from "../lib/run-action.js";
import * as log from "../utils/logger.js";

/**
 * The three id spaces this group mixes, named once.
 *
 * `user_id` is the person and the only id any command here accepts on the path;
 * `org_user_id` is the membership row and is informational; `role_id` is a
 * PER-ORGANIZATION uuid, so a role_id copied from another org is refused with a
 * 400 that names no field. Every error below names the command that resolves the
 * id it is complaining about.
 */
const USER: ResourceRef = {
  type: "User",
  idField: "user_id",
  list: "senso members list",
};

const ROLE: ResourceRef = {
  type: "Role",
  idField: "role_id",
  list: "senso roles list",
};

/** OrgUserResponse: what every write in this group returns. */
interface OrgUser {
  org_user_id?: string;
  user_id?: string;
  role_id?: string;
  is_current?: boolean;
}

/** Enough of an email to catch the mistakes: a name, an @, a domain with a dot. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseEmailFlag(flag: string, value: string): string {
  const trimmed = value.trim();
  if (EMAIL_RE.test(trimmed)) return trimmed;
  throw usageError(`Invalid ${flag}: "${value}" is not an email address.`, {
    field: flag,
    received: value,
    hint: `Example: ${flag} jane@acme.com`,
  });
}

/**
 * The API's "Invalid role ID for this organization", made actionable.
 *
 * Roles are per organization, so this 400 has exactly one cause and one fix:
 * the role_id came from somewhere else (another org, a stale copy, a deleted
 * role). The API names neither the field nor the value, so both are added here
 * along with the command that lists this organization's roles.
 */
function rethrowRoleError(err: unknown, roleId: string, context: string): never {
  if (err instanceof ApiError && err.status === 400 && /role/i.test(err.message)) {
    throw new CliError(`${context}: ${err.message} (role_id ${roleId}).`, EXIT.ERROR, {
      code: "validation",
      status: 400,
      field: "role_id",
      received: roleId,
      hint: "Roles are per organization. List this organization's roles with `senso roles list`.",
      cause: err,
    });
  }
  throw err;
}

/** The `role_id` value out of a `--data` body, checked as a Role id. */
function roleIdFrom(body: Record<string, unknown>, key = "role_id"): string {
  const value = body[key];
  if (typeof value !== "string") {
    throw usageError(`--data.${key} must be a UUID string.`, {
      field: `--data.${key}`,
      received: JSON.stringify(value),
      hint: "Role ids are the `role_id` field of `senso roles list`.",
    });
  }
  return parseId(value, { ...ROLE, label: `--data.${key}` });
}

export function registerUserCommands(program: Command): void {
  const users = program
    .command("users")
    .description(
      "Memberships of the organization your API key belongs to. Three ids appear here: user_id (the person — what every <userId> argument takes), org_user_id (the membership row, informational only) and role_id (a per-organization role UUID from `senso roles list`). This group returns ids only; for emails and names use `senso members list`. Which command to add someone with: `invite` for a brand-new person, `invite-existing` when they already have a Senso account and you know the email, `add` when you already hold their user_id.",
    );

  describeCommand(
    users
      .command("list")
      .description(
        "List memberships of the organization, one row per user: user_id, role_id and whether this organization is the user's active one. Ids only — for emails and names use `senso members list`.",
      )
      .option("--limit <n>", "Rows per page, integer >= 1 (the API defaults to 10)")
      .option("--offset <n>", "Rows to skip, integer >= 0 (default 0)")
      .action(
        runAction(program, async (ctx, cmdOpts: Record<string, string>) => {
          const limit = parseIntFlag("--limit", cmdOpts.limit, { min: 1 });
          const offset = parseIntFlag("--offset", cmdOpts.offset, { min: 0 });

          const data = await apiRequest({
            path: "/org/users",
            params: { limit, offset },
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
            resource: USER,
          });
          emit(ctx, data, {
            columns: ["user_id", "org_user_id", "role_id", "is_current", "created_at"],
            empty: "memberships",
            emptyHint:
              "The API pages at 10 by default; widen with `senso users list --limit 100`, or look for names and emails with `senso members list`.",
            next: [
              {
                why: "Emails, names and role names for these user_ids",
                command: "senso members list",
              },
              { why: "Resolve a role_id to a role name", command: "senso roles list" },
            ],
          });
        }),
      ),
    {
      returns: [
        "user_id — the person; pass this to users get/update/remove/set-current",
        "org_user_id — the membership row; no command takes it",
        "role_id — per-organization role id; resolve the name with `senso roles list`",
        "is_current — true | false. true means this organization is the user's active one in the dashboard",
        "created_at, updated_at — when the membership was created and last changed",
      ],
      exitCodes: {
        ...idExits,
        2: "--limit or --offset is not an integer in range",
        4: "the organization this key belongs to no longer exists",
      },
      examples: [
        { command: "senso users list --limit 100" },
        { command: "senso users list --output json | jq -r '.data[].user_id'" },
      ],
      seeAlso: ["senso members list", "senso roles list", "senso users get"],
      notes: [
        "The endpoint returns a bare array with no total, so a full page may mean there are more: ask for the next one with --offset.",
      ],
    },
  );

  describeCommand(
    users
      .command("add")
      .description(
        "Add a person who already has a Senso account to the organization, by user_id. Use `senso users invite-existing` when you only know the email, and `senso users invite` when the person has no Senso account yet.",
      )
      .requiredOption(
        "--data <json>",
        'JSON: { "user_id": "<uuid>", "role_id": "<uuid>", "is_current": false }. user_id comes from `senso members list`; role_id from `senso roles list` and must be a role of THIS organization. is_current is optional and is forced true when the person has no active organization yet.',
      )
      .action(
        runAction(program, async (ctx, cmdOpts: { data: string }) => {
          const body = parseJsonFlag(cmdOpts.data, {
            required: ["user_id", "role_id"],
            optional: ["is_current"],
          });
          const userId = typeof body.user_id === "string" ? body.user_id : "";
          parseId(userId, {
            ...USER,
            label: "--data.user_id",
          });
          const roleId = roleIdFrom(body);

          let data: OrgUser;
          try {
            data = await apiRequest<OrgUser>({
              method: "POST",
              path: "/org/users",
              body,
              apiKey: ctx.apiKey,
              baseUrl: ctx.baseUrl,
              resource: { ...USER, id: userId },
            });
          } catch (err) {
            rethrowRoleError(err, roleId, "Adding user");
          }

          if (!ctx.quiet) log.success(`Added user ${userId} to the organization.`);
          emit(ctx, data, {
            next: [{ why: "Confirm the membership", command: `senso users get ${userId}` }],
          });
        }),
      ),
    {
      returns: [
        "org_user_id — the new membership row",
        "user_id, role_id — what was stored",
        "is_current — true | false",
        "created_at, updated_at",
      ],
      exitCodes: {
        ...idExits,
        2: "--data is missing user_id or role_id, or one of them is not a UUID",
        4: "no Senso account has that user_id, or the organization no longer exists",
        1: "400 when role_id is not a role of this organization; 409 when the person is already a member",
      },
      examples: [
        {
          command: `senso users add --data '{"user_id":"2a9c1d3e-5f6a-4b7c-8d9e-0f1a2b3c4d5e","role_id":"9e8d7c6b-5a49-4837-9625-14f3e2d1c0b9"}'`,
        },
      ],
      seeAlso: [
        "senso users invite",
        "senso users invite-existing",
        "senso roles list",
        "senso members list",
      ],
    },
  );

  describeCommand(
    users
      .command("get")
      .description(
        "Read one membership: the person's role_id in this organization and whether this organization is their active one. Ids only — for email and name use `senso members list`.",
      )
      .argument(
        "<userId>",
        "user_id (UUID) from `senso members list` or `senso users list`. Not org_user_id",
      )
      .action(
        runAction(program, async (ctx, userIdArg: string) => {
          const userId = parseId(userIdArg, { ...USER, label: "<userId>" });
          const data = await apiRequest({
            path: `/org/users/${userId}`,
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
            resource: { ...USER, id: userId },
          });
          emit(ctx, data, {
            next: [
              {
                why: "Change this person's role",
                command: `senso users update ${userId} --data '{"role_id":"…"}'`,
              },
              { why: "Resolve role_id to a role name", command: "senso roles list" },
            ],
          });
        }),
      ),
    {
      returns: [
        "user_id, org_user_id — the person and the membership row",
        "role_id — resolve the name with `senso roles list`",
        "is_current — true | false",
        "created_at, updated_at",
      ],
      exitCodes: {
        ...idExits,
        2: "<userId> is not a UUID",
        4: "no such user, or the user is not a member of this organization",
      },
      examples: [
        { command: "senso users get 2a9c1d3e-5f6a-4b7c-8d9e-0f1a2b3c4d5e" },
        {
          command:
            "senso users get 2a9c1d3e-5f6a-4b7c-8d9e-0f1a2b3c4d5e --output json | jq -r .data.role_id",
        },
      ],
      seeAlso: ["senso members list", "senso roles list", "senso users update"],
      notes: ["The argument is user_id. Passing the org_user_id from `users list` answers 404."],
    },
  );

  describeCommand(
    users
      .command("update")
      .description(
        "Change a member's role in this organization, and optionally whether this organization is their active one. role_id is required on every call, even when only is_current is changing.",
      )
      .argument(
        "<userId>",
        "user_id (UUID) of the member, from `senso members list`. Not org_user_id",
      )
      .requiredOption(
        "--data <json>",
        'JSON: { "role_id": "<uuid>", "is_current": true }. role_id is required by the API on every update and must be a role of THIS organization (`senso roles list`); is_current is optional.',
      )
      .action(
        runAction(program, async (ctx, userIdArg: string, cmdOpts: { data: string }) => {
          const userId = parseId(userIdArg, { ...USER, label: "<userId>" });
          const body = parseJsonFlag(cmdOpts.data, {
            required: ["role_id"],
            optional: ["is_current"],
          });
          const roleId = roleIdFrom(body);

          let data: OrgUser;
          try {
            data = await apiRequest<OrgUser>({
              method: "PUT",
              path: `/org/users/${userId}`,
              body,
              apiKey: ctx.apiKey,
              baseUrl: ctx.baseUrl,
              resource: { ...USER, id: userId },
            });
          } catch (err) {
            rethrowRoleError(err, roleId, `Updating user ${userId}`);
          }

          if (!ctx.quiet) log.success(`Updated user ${userId}: role_id → ${roleId}.`);
          emit(ctx, data, {
            next: [{ why: "Confirm the membership", command: `senso users get ${userId}` }],
          });
        }),
      ),
    {
      returns: [
        "user_id, org_user_id, role_id, is_current, updated_at — the membership after the write",
        "is_current — true | false",
      ],
      exitCodes: {
        ...idExits,
        2: "<userId> is not a UUID, or --data is missing role_id",
        4: "no such user, or the user is not a member of this organization",
        1: "400 when role_id is not a role of this organization",
      },
      examples: [
        {
          command: `senso users update 2a9c1d3e-5f6a-4b7c-8d9e-0f1a2b3c4d5e --data '{"role_id":"9e8d7c6b-5a49-4837-9625-14f3e2d1c0b9"}'`,
        },
        {
          comment: "Resolve a role name to its id first",
          command: `senso roles list --output json | jq -r '.data[] | select(.name=="viewer") | .role_id'`,
        },
      ],
      seeAlso: ["senso roles list", "senso users get", "senso users set-current"],
      notes: [
        "role_id is mandatory even for an is_current-only change: the API validates the role before anything else.",
      ],
    },
  );

  describeCommand(
    users
      .command("remove")
      .description(
        "Remove a member from this organization. Their Senso account and their memberships in other organizations are untouched.",
      )
      .argument(
        "<userId>",
        "user_id (UUID) of the member, from `senso members list`. Not org_user_id",
      )
      .action(
        runAction(program, async (ctx, userIdArg: string) => {
          const userId = parseId(userIdArg, { ...USER, label: "<userId>" });
          await apiRequest({
            method: "DELETE",
            path: `/org/users/${userId}`,
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
            resource: { ...USER, id: userId },
          });
          emitConfirmation(ctx, `Removed user ${userId} from the organization.`, {
            action: "removed",
            resource: "org_user",
            id: userId,
            user_id: userId,
          });
        }),
      ),
    {
      returns: [
        "Nothing is returned by the API (204). JSON mode reports { action: removed, resource: org_user, user_id }.",
      ],
      exitCodes: {
        ...idExits,
        2: "<userId> is not a UUID",
        4: "no such user, or the user is not a member of this organization",
      },
      examples: [{ command: "senso users remove 2a9c1d3e-5f6a-4b7c-8d9e-0f1a2b3c4d5e" }],
      seeAlso: ["senso users list", "senso users add", "senso members list"],
      notes: [
        "Neither the API nor the CLI protects the last admin: check `senso members list` before removing one, or the organization is left with nobody who can administer it.",
      ],
    },
  );

  describeCommand(
    users
      .command("set-current")
      .description(
        "Make this organization the member's active (current) organization: the one the Senso dashboard opens for them. Only one organization is current per user. Same effect as is_current in `senso users update`, without having to send a role_id.",
      )
      .argument(
        "<userId>",
        "user_id (UUID) of the member, from `senso members list`. Not org_user_id",
      )
      .action(
        runAction(program, async (ctx, userIdArg: string) => {
          const userId = parseId(userIdArg, { ...USER, label: "<userId>" });
          // The API returns the updated membership; it used to be discarded in
          // favor of a synthetic confirmation, which made this the one command
          // in the group whose JSON was not the API's own payload.
          const data = await apiRequest({
            method: "PATCH",
            path: `/org/users/${userId}/current`,
            body: { is_current: true },
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
            resource: { ...USER, id: userId },
          });
          if (!ctx.quiet) log.success(`Organization is now current for user ${userId}.`);
          emit(ctx, data, {
            next: [{ why: "Confirm the membership", command: `senso users get ${userId}` }],
          });
        }),
      ),
    {
      returns: [
        "user_id, org_user_id, role_id, updated_at",
        "is_current — true after this command",
      ],
      exitCodes: {
        ...idExits,
        2: "<userId> is not a UUID",
        4: "no such user, or the user is not a member of this organization",
      },
      examples: [{ command: "senso users set-current 2a9c1d3e-5f6a-4b7c-8d9e-0f1a2b3c4d5e" }],
      seeAlso: ["senso users update", "senso users get"],
    },
  );

  describeCommand(
    users
      .command("invite")
      .description(
        "Create a Senso account for a person (in Clerk and Senso) and add them to this organization with a role. An account that already exists for the email is reused. This command does not send an invitation email.",
      )
      .requiredOption("--email <email>", "The person's email address")
      .requiredOption("--given-name <name>", "First name, 1-255 characters (API field given_name)")
      .requiredOption("--family-name <name>", "Last name, 1-255 characters (API field family_name)")
      .requiredOption(
        "--role-id <uuid>",
        "A role of THIS organization — resolve the name with `senso roles list`",
      )
      .option("--is-current", "Make this organization the person's active organization")
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
            const email = parseEmailFlag("--email", cmdOpts.email);
            const roleId = parseId(cmdOpts.roleId, { ...ROLE, label: "--role-id" });

            let data: OrgUser;
            try {
              data = await apiRequest<OrgUser>({
                method: "POST",
                path: "/org/users/invite",
                body: {
                  email,
                  given_name: cmdOpts.givenName,
                  family_name: cmdOpts.familyName,
                  role_id: roleId,
                  is_current: cmdOpts.isCurrent ?? false,
                },
                apiKey: ctx.apiKey,
                baseUrl: ctx.baseUrl,
                resource: USER,
              });
            } catch (err) {
              rethrowRoleError(err, roleId, `Inviting ${email}`);
            }

            if (!ctx.quiet) log.success(`Invited ${email} to the organization.`);
            emit(ctx, data, {
              next: [
                {
                  why: "See the member with their email and role name",
                  command: `senso members list --search ${email}`,
                },
              ],
            });
          },
        ),
      ),
    {
      returns: [
        "user_id — the person; pass it to users get/update/remove/set-current",
        "org_user_id, role_id, created_at",
        "is_current — true | false. Forced true when the person had no active organization",
        "The email is not echoed back; find the member again with `senso members list --search <email>`.",
      ],
      exitCodes: {
        ...idExits,
        2: "--email is not an email address, or --role-id is not a UUID",
        1: "400 when role_id is not a role of this organization; 409 when the person is already a member",
      },
      examples: [
        {
          command:
            "senso users invite --email jane@acme.com --given-name Jane --family-name Doe --role-id 9e8d7c6b-5a49-4837-9625-14f3e2d1c0b9",
        },
      ],
      seeAlso: ["senso users invite-existing", "senso roles list", "senso members list"],
    },
  );

  describeCommand(
    users
      .command("invite-existing")
      .description(
        "Add a person who already has a Senso account to this organization, by email. Answers 404 when no account has that email — use `senso users invite` to create one.",
      )
      .requiredOption("--email <email>", "Email of an existing Senso account")
      .requiredOption(
        "--role-id <uuid>",
        "A role of THIS organization — resolve the name with `senso roles list`",
      )
      .option("--is-current", "Make this organization the person's active organization")
      .action(
        runAction(
          program,
          async (ctx, cmdOpts: { email: string; roleId: string; isCurrent?: boolean }) => {
            const email = parseEmailFlag("--email", cmdOpts.email);
            const roleId = parseId(cmdOpts.roleId, { ...ROLE, label: "--role-id" });

            let data: OrgUser;
            try {
              data = await apiRequest<OrgUser>({
                method: "POST",
                path: "/org/users/invite/existing",
                body: {
                  email,
                  role_id: roleId,
                  is_current: cmdOpts.isCurrent ?? false,
                },
                apiKey: ctx.apiKey,
                baseUrl: ctx.baseUrl,
                // The 404 here is about an email, not an id, so the hint has to
                // be the command that creates the account rather than a list.
                resource: {
                  type: `Senso user with email ${email}`,
                  list: `senso users invite --email ${email} --given-name … --family-name … --role-id ${roleId}`,
                },
              });
            } catch (err) {
              rethrowRoleError(err, roleId, `Adding ${email}`);
            }

            if (!ctx.quiet) log.success(`Added ${email} to the organization.`);
            emit(ctx, data, {
              next: [
                {
                  why: "See the member with their email and role name",
                  command: `senso members list --search ${email}`,
                },
              ],
            });
          },
        ),
      ),
    {
      returns: [
        "user_id, org_user_id, role_id, created_at",
        "is_current — true | false. Forced true when the person had no active organization",
      ],
      exitCodes: {
        ...idExits,
        2: "--email is not an email address, or --role-id is not a UUID",
        4: "no Senso account has that email",
        1: "400 when role_id is not a role of this organization; 409 when the person is already a member",
      },
      examples: [
        {
          command:
            "senso users invite-existing --email jane@acme.com --role-id 9e8d7c6b-5a49-4837-9625-14f3e2d1c0b9",
        },
      ],
      seeAlso: ["senso users invite", "senso roles list", "senso members list"],
      notes: [
        "The email is looked up before the role, so an unknown email is reported as a 404 even when --role-id is also wrong.",
      ],
    },
  );
}
