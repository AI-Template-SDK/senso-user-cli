/**
 * `senso roles`: the discovery command for role_id.
 *
 * `users invite`, `users invite-existing`, `users add` and `users update` all
 * require a role_id, and a role_id is per organization — the "admin" of one
 * organization is a different UUID from the "admin" of another. There is no
 * other way to resolve a role NAME to the id those commands take, which makes
 * this list the first call in every user-management sequence.
 *
 * Read-only: roles are created and edited in the Senso dashboard, not over the
 * API, and this endpoint does not return the permission keys behind each role.
 * `senso permissions list` is the catalog those keys are drawn from.
 */

import { Command } from "commander";
import { apiRequest } from "../lib/api-client.js";
import { apiExits, describeCommand } from "../lib/help.js";
import { emit, type NextStep } from "../lib/output.js";
import { runAction } from "../lib/run-action.js";

/** A role, as much of it as the rendering below needs. */
interface Role {
  role_id?: string;
  name?: string;
  is_system?: boolean;
  deleted_at?: string | null;
}

/**
 * The roles out of whatever came back.
 *
 * The endpoint answers with a bare array, and that is what the Returns section
 * documents — but `apiRequest<T>` is a cast, not a validator, so trusting the
 * type here turns a wrapped or malformed body into "rows.filter is not a
 * function" and exit 1 with a stack trace in place of an answer.
 */
function rolesOf(data: unknown): Role[] {
  if (Array.isArray(data)) return data as Role[];
  const wrapped = (data as { roles?: unknown } | null)?.roles;
  return Array.isArray(wrapped) ? (wrapped as Role[]) : [];
}

/** The first role that is safe to pass on, for the follow-up commands. */
function usableRole(roles: Role[]): Role | undefined {
  return roles.find((r) => r.role_id !== undefined && !r.deleted_at);
}

function inviteSteps(roles: Role[]): NextStep[] {
  const role = usableRole(roles);
  if (role?.role_id === undefined) return [];
  return [
    {
      why: `Invite a new user with the ${role.name ?? "chosen"} role`,
      command: `senso users invite --email <email> --role-id ${role.role_id}`,
    },
    {
      why: "Change an existing member's role",
      command: `senso users update <userId> --data '{"role_id":"${role.role_id}"}'`,
    },
  ];
}

export function registerRolesCommands(program: Command): void {
  const roles = program
    .command("roles")
    .description(
      "The roles of the organization your key belongs to. role_ids are PER ORGANIZATION: resolve a name (admin, collaborator, viewer, or a custom role) to its UUID here before passing --role-id to `senso users invite` or role_id to `senso users add` and `senso users update`. Read-only — roles are created and edited in the Senso dashboard.",
    );

  describeCommand(roles, {
    notes: [
      "A role_id from one organization is meaningless in another. Resolve it against the organization this key belongs to, every time.",
      "The permission keys a role grants are not returned by this API. `senso permissions list` is the catalog they come from.",
    ],
    examples: [
      { command: "senso roles list" },
      {
        comment: "The id `users invite` wants",
        command:
          "senso roles list --output json | jq -r '.data[] | select(.name==\"viewer\") | .role_id'",
      },
    ],
    seeAlso: ["senso users invite", "senso users update", "senso permissions list"],
  });

  describeCommand(
    roles
      .command("list")
      .description(
        "List every role of this organization — the built-in admin, collaborator and viewer, plus any custom roles — with the role_id that `senso users` commands take.",
      )
      .action(
        runAction(program, async (ctx) => {
          const data = await apiRequest({
            path: "/org/roles",
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
          });
          const rows = rolesOf(data);
          const deleted = rows.filter((r) => Boolean(r.deleted_at)).length;
          emit(ctx, data, {
            columns: ["role_id", "name", "is_system", "description"],
            empty: "roles",
            emptyHint:
              "Every organization has the three built-in roles, so an empty list means this key is not attached to an organization. Check with: senso whoami",
            warnings:
              deleted > 0
                ? [
                    `${String(deleted)} role(s) in this list are deleted (deleted_at is set). \`senso users update\` and \`senso users invite\` reject them — pick one without deleted_at.`,
                  ]
                : [],
            next: inviteSteps(rows),
          });
        }),
      ),
    {
      returns: [
        "A bare array — no paging, no total. Every role of this organization, in one response.",
        "[].role_id — the per-organization UUID to pass as --role-id to `senso users invite` and `users invite-existing`, and as role_id in the --data body of `users add` and `users update`.",
        "[].name — admin | collaborator | viewer for the built-ins, or whatever a custom role was called. Names are stable; ids are not shared between organizations.",
        "[].is_system — true | false:",
        "  true   one of the three built-in roles. Always present, cannot be removed.",
        "  false  a custom role created for this organization in the dashboard.",
        "[].description — free text, and often absent.",
        "[].org_id — the organization the role belongs to, which is the reason role_ids are not portable.",
        "[].deleted_at — present and non-null means the role is DELETED: it is still listed, and `senso users update` rejects it. Skip those rows.",
        "[].created_at / updated_at — RFC 3339 timestamps.",
        "The permission keys behind a role are NOT returned here; `senso permissions list` shows the catalog they are drawn from.",
      ],
      exitCodes: apiExits,
      notes: [
        "This is the only way to turn a role name into the role_id the `senso users` commands require.",
        "Roles cannot be created, renamed or deleted over the API — this group is read-only.",
        "Nothing here says what your API key may do: an organization API key is not governed by roles at all.",
      ],
      examples: [
        { command: "senso roles list" },
        {
          comment: "Resolve a name to the id `users invite` takes",
          command:
            "senso roles list --output json | jq -r '.data[] | select(.name==\"collaborator\") | .role_id'",
        },
        {
          comment: "Invite someone with that role",
          command:
            'senso users invite --email new@example.com --role-id "$(senso roles list --output json | jq -r \'.data[] | select(.name=="viewer") | .role_id\')"',
        },
      ],
      seeAlso: [
        "senso users invite",
        "senso users add",
        "senso users update",
        "senso permissions list",
      ],
    },
  );
}
