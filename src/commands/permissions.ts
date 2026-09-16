/**
 * `senso permissions`: the catalog of permission keys a role can hold.
 *
 * Reference data, and the thing to be clear about is what it is NOT. These keys
 * are platform-wide and identical for every organization; they govern dashboard
 * users through the roles they hold, and an organization API key is not subject
 * to them at all. An agent asking "what can my key do?" will otherwise read
 * this list as the answer. The only thing that narrows an API key is its
 * knowledge base scope, which is `senso api-keys kb-permissions-get`.
 */

import { Command } from "commander";
import { apiRequest } from "../lib/api-client.js";
import { apiExits, describeCommand } from "../lib/help.js";
import { emit } from "../lib/output.js";
import { runAction } from "../lib/run-action.js";

/** One entry of the catalog, as much of it as the rendering below needs. */
interface Permission {
  key?: string;
  category?: string;
}

export function registerPermissionsCommands(program: Command): void {
  const perms = program
    .command("permissions")
    .description(
      "The catalog of permission keys (action:resource, e.g. update:org) that a dashboard user role can hold. The same list for every organization, and read-only. NOT what your API key may do: an organization API key is not subject to these keys — its only restriction is its knowledge base scope, from `senso api-keys kb-permissions-get`.",
    );

  describeCommand(perms, {
    notes: [
      "Static reference data. Roles are created and edited in the Senso dashboard, not over the API, so no command in this CLI takes a permission key as input.",
      "`senso roles list` is the command that shows which roles this organization actually has; the keys behind each role are not returned by the API.",
    ],
    examples: [
      { command: "senso permissions list --output json | jq -r '.data.permissions[].key'" },
    ],
    seeAlso: ["senso roles list", "senso api-keys kb-permissions-get"],
  });

  describeCommand(
    perms
      .command("list")
      .description(
        "List every permission key a role can hold, with the category it belongs to. Reference data: the same for every organization.",
      )
      .action(
        runAction(program, async (ctx) => {
          const data = await apiRequest<{ permissions?: Permission[] }>({
            path: "/org/permissions",
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
          });
          emit(ctx, data, {
            // `name` and `description` are derived mechanically from the key
            // ("update org", "Allows update operations on org"), so a table of
            // all four columns is three columns of restatement. They are still
            // in the payload under --output json.
            columns: ["key", "category"],
            empty: "permissions",
            emptyHint:
              "This list is static and is never empty in a healthy deployment — an empty one means the API answered with something other than the catalog. Re-run with --output json to see the raw body.",
            next: [
              {
                why: "See which roles this organization has; each holds a subset of these keys",
                command: "senso roles list",
              },
            ],
          });
        }),
      ),
    {
      returns: [
        "permissions[].key — action:resource, e.g. read:org, update:org, list:api_keys. This is the identifier; everything else is derived from it.",
        "permissions[].category — the resource half of the key (org, api_keys, org_roles …). Group by this to read the list.",
        'permissions[].name — the key with the colon removed ("update org"). Display text, nothing more.',
        'permissions[].description — "Allows <action> operations on <resource>", generated from the key.',
        "No total, no paging: the whole catalog comes back in one response.",
      ],
      exitCodes: apiExits,
      notes: [
        "The list is identical for every organization and does not change with your plan, your role or your key.",
        "No command in this CLI consumes a permission key: roles are edited in the dashboard. Use this to interpret a role, and `senso roles list` to get the role_id that `senso users invite`, `users add` and `users update` take.",
        "Nothing here describes an API key's own limits. A key's knowledge base scope is `senso api-keys kb-permissions-get`.",
      ],
      examples: [
        { command: "senso permissions list" },
        {
          comment: "Every key, one per line",
          command: "senso permissions list --output json | jq -r '.data.permissions[].key'",
        },
        {
          comment: "Just the api_key category",
          command:
            "senso permissions list --output json | jq -r '.data.permissions[] | select(.category==\"api_keys\") | .key'",
        },
      ],
      seeAlso: ["senso roles list", "senso users invite", "senso api-keys kb-permissions-get"],
    },
  );
}
