import { Command } from "commander";
import { apiRequest } from "../lib/api-client.js";
import { parseEnumFlag, parseIntFlag } from "../lib/enum-arg.js";
import { describeCommand, idExits } from "../lib/help.js";
import { emit } from "../lib/output.js";
import type { ResourceRef } from "../lib/resource.js";
import { runAction } from "../lib/run-action.js";

/** No id argument: the directory belongs to the key's own organization. */
const ORG: ResourceRef = { type: "Organization", list: "senso whoami" };

/**
 * The orders the endpoint understands.
 *
 * Anything else silently sorted by name_asc and exited 0, so a typo returned a
 * plausible list in the wrong order — the most expensive kind of wrong answer.
 */
const SORTS = [
  "name_asc",
  "name_desc",
  "email_asc",
  "email_desc",
  "created_asc",
  "created_desc",
] as const;

export function registerMemberCommands(program: Command): void {
  const members = program
    .command("members")
    .description(
      "Read-only directory of the organization's members, with email, name, role name and groups. The same people as `senso users`, with the human-readable fields: use the user_id from here with `senso users get/update/remove/set-current`.",
    );

  describeCommand(
    members
      .command("list")
      .description(
        "One page of the organization's members with email, name, role and groups. Read-only — to change a membership use `senso users`.",
      )
      .option("--limit <n>", "Rows per page, integer 1-1000 (default 50)")
      .option("--offset <n>", "Rows to skip, integer >= 0 (default 0)")
      .option("--search <query>", "Case-insensitive substring match on name or email")
      .option("--sort <order>", `One of: ${SORTS.join(", ")} (default name_asc)`)
      .action(
        runAction(program, async (ctx, cmdOpts: Record<string, string>) => {
          const limit = parseIntFlag("--limit", cmdOpts.limit, { min: 1, max: 1000 });
          const offset = parseIntFlag("--offset", cmdOpts.offset, { min: 0 });
          const sort = parseEnumFlag("--sort", cmdOpts.sort, SORTS);

          const data = await apiRequest({
            path: "/org/members",
            params: {
              limit,
              offset,
              search: cmdOpts.search,
              sort,
            },
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
            resource: ORG,
          });
          // Columns taken from OrgMemberResponse. `name` and `created_at` were
          // here before and exist on no row: the payload carries given_name,
          // family_name and role_display_name, so two columns were always blank
          // and the role was invisible in table mode.
          emit(ctx, data, {
            columns: ["user_id", "email", "given_name", "family_name", "role_display_name"],
            empty: "members",
            emptyHint: cmdOpts.search
              ? `No member matched --search "${cmdOpts.search}". Drop the filter to list everyone: senso members list`
              : "An organization always has at least one member; an empty list usually means the key belongs to a different organization. Check with `senso whoami`.",
            next: [
              {
                why: "Change a member's role, using the user_id from this list",
                command: `senso users update <user_id> --data '{"role_id":"…"}'`,
              },
              { why: "See what a role_id is called", command: "senso roles list" },
            ],
          });
        }),
      ),
    {
      returns: [
        "members[].user_id — the person; what `senso users get/update/remove/set-current` take",
        "members[].org_user_id — the membership row; informational",
        "members[].email, given_name, family_name",
        "members[].role_id — the per-organization role id; role_display_name is its name (admin, collaborator, viewer, or a custom role)",
        "members[].groups[] — {group_id, name}, the groups visible to you; always an array, empty when there are none",
        "total, limit, offset — the page you are looking at",
      ],
      exitCodes: {
        ...idExits,
        2: "--sort is not one of the six orders, or --limit/--offset is out of range",
        4: "the organization this key belongs to no longer exists",
      },
      examples: [
        { comment: "Find someone's user_id", command: "senso members list --search jane@acme.com" },
        { command: "senso members list --sort created_desc --limit 5" },
        {
          command:
            "senso members list --output json | jq -r '.data.members[] | \"\\(.user_id)  \\(.email)  \\(.role_display_name)\"'",
        },
      ],
      seeAlso: ["senso users list", "senso users update", "senso roles list"],
    },
  );
}
