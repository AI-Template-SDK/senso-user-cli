import { Command } from "commander";
import { apiRequest } from "../lib/api-client.js";
import { usageError } from "../lib/errors.js";
import { parseIntFlag } from "../lib/enum-arg.js";
import { describeCommand, idExits } from "../lib/help.js";
import { parseId } from "../lib/id-arg.js";
import { parseJsonFlag } from "../lib/json-arg.js";
import { emit, emitConfirmation } from "../lib/output.js";
import type { ResourceRef } from "../lib/resource.js";
import { runAction } from "../lib/run-action.js";
import * as log from "../utils/logger.js";

/**
 * The key's id — not its secret.
 *
 * `SENSO_API_KEY` holds the secret, and an agent that has one to hand will try
 * it as the argument. The id is a UUID and the secret is not, so the check
 * below turns that into an exit 2 that says where the id comes from.
 */
const API_KEY: ResourceRef = {
  type: "API key",
  idField: "id",
  list: "senso api-keys list",
};

/** A grant points at a knowledge base folder, in the kb_node_id space. */
const KB_NODE: ResourceRef = {
  type: "KB node",
  idField: "node_id",
  list: "senso kb my-files",
};

/**
 * The roles a KB grant may carry.
 *
 * models.KBNodeRole also defines `admin`, but it is virtual — "Not stored in
 * DB", it stands for the org-admin bypass — and the DB CHECK constraint accepts
 * only these three. The handler does not validate the value, so `admin` used to
 * travel all the way to the database and come back as a 500.
 */
const GRANT_ROLES = ["viewer", "editor", "owner"] as const;

/**
 * What every write in this group has in common.
 *
 * The routes sit behind RequireJWTOnly, so the API answers an API-key caller
 * with 403 "This action requires user authentication" before the handler runs.
 * The command still makes the request — a future JWT-capable caller would
 * succeed — but the help says where the work actually has to be done.
 */
const DASHBOARD_ONLY =
  "Requires a signed-in dashboard user: the API answers 403 to an API key, whatever its scope. Do this at https://app.senso.ai → Settings → API keys.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `expires_at`, checked loosely on purpose.
 *
 * The API accepts RFC 3339 and a handful of shorter ISO 8601 forms, so the
 * strict `parseInstantFlag` would reject values the server is happy with. This
 * catches what people actually type — "next year", "31/12/2026" — without
 * narrowing the accepted set.
 */
function assertIsoTimestamp(value: unknown): void {
  if (value === undefined) return;
  const ok =
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value.trim()) &&
    !Number.isNaN(Date.parse(value.trim()));
  if (!ok) {
    throw usageError("--data.expires_at must be an ISO 8601 timestamp.", {
      field: "--data.expires_at",
      received: typeof value === "string" ? value : JSON.stringify(value),
      hint: 'Example: "expires_at": "2026-12-31T00:00:00Z". Omit the key for a key that never expires.',
    });
  }
}

/** Every grant checked before the request: a real node id and an allowed role. */
function validateGrants(value: unknown): void {
  if (!Array.isArray(value) || value.length === 0) {
    throw usageError("--data.grants must be a non-empty array of grants.", {
      field: "--data.grants",
      received: JSON.stringify(value),
      hint: `The API refuses an empty list. To clear every grant use \`senso api-keys kb-permissions-delete <keyId>\`. Example: --data '{"grants":[{"node_id":"<uuid>","role":"viewer"}]}'`,
    });
  }

  value.forEach((grant, i) => {
    const at = `--data.grants[${String(i)}]`;
    if (!isRecord(grant)) {
      throw usageError(`${at} must be an object with node_id and role.`, {
        field: at,
        received: JSON.stringify(grant),
        allowed: ["node_id", "role"],
      });
    }

    const unknown = Object.keys(grant).filter((k) => k !== "node_id" && k !== "role");
    const offender = unknown[0] ?? "";
    if (unknown.length > 0) {
      throw usageError(`${at}.${offender} is not an accepted key.`, {
        field: `${at}.${offender}`,
        received: JSON.stringify(grant[offender]),
        allowed: ["node_id", "role"],
        hint: "A grant takes node_id and role and nothing else.",
      });
    }

    const nodeId = grant.node_id;
    if (typeof nodeId !== "string") {
      throw usageError(`${at}.node_id must be a kb_node_id (UUID).`, {
        field: `${at}.node_id`,
        received: JSON.stringify(nodeId),
        hint: "Folder ids are the `kb_node_id` field of `senso kb my-files`.",
      });
    }
    parseId(nodeId, { ...KB_NODE, label: `${at}.node_id` });

    const role = grant.role;
    if (typeof role !== "string" || !GRANT_ROLES.includes(role as (typeof GRANT_ROLES)[number])) {
      throw usageError(`${at}.role must be one of: ${GRANT_ROLES.join(", ")}.`, {
        field: `${at}.role`,
        received: typeof role === "string" ? role : JSON.stringify(role),
        allowed: GRANT_ROLES,
        // `admin` reads like a fourth level and is not one: it is the org-admin
        // bypass, is never stored, and the API fails it at the database.
        hint: "`admin` is not a grantable role — it is the org-admin bypass. viewer grants view and download; editor and owner also grant create, update, delete and share.",
      });
    }
  });
}

export function registerApiKeyCommands(program: Command): void {
  const keys = program
    .command("api-keys")
    .description(
      "Inspect the API keys of the organization your key belongs to. Every command takes the key's id (a UUID from `api-keys list`), never the secret. Creating, renaming, revoking, deleting a key and changing its knowledge-base scope require a signed-in dashboard user — the API answers 403 to any API key — so over the CLI this group is effectively read-only: `list` → `get` → `kb-permissions-get`.",
    );

  describeCommand(
    keys
      .command("list")
      .description(
        "One page of the organization's API keys. Secrets are never returned. Revoked keys (revoked_at set) and expired keys (expires_at in the past) are included.",
      )
      .option("--limit <n>", "Rows per page, integer >= 1 (the API defaults to 10)")
      .option("--offset <n>", "Rows to skip, integer >= 0 (default 0)")
      .action(
        runAction(program, async (ctx, cmdOpts: Record<string, string>) => {
          const limit = parseIntFlag("--limit", cmdOpts.limit, { min: 1 });
          const offset = parseIntFlag("--offset", cmdOpts.offset, { min: 0 });

          const data = await apiRequest({
            path: "/org/api-keys",
            params: { limit, offset },
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
            resource: API_KEY,
          });
          emit(ctx, data, {
            // revoked_at is a column because a revoked key is otherwise
            // indistinguishable from a live one in table mode.
            columns: ["id", "name", "scoped", "revoked_at", "expires_at", "last_used_at"],
            empty: "API keys",
            emptyHint:
              "Keys are created in the dashboard (https://app.senso.ai → Settings → API keys); the API refuses to create one.",
            next: [{ why: "Identify the key you are calling with", command: "senso whoami" }],
          });
        }),
      ),
    {
      returns: [
        "items[].id — the key's id, and what `api-keys get` and `kb-permissions-get` take. Not the secret",
        "items[].name — the label given at creation",
        "items[].scoped — true | false. true means knowledge base folder grants restrict this key (`senso api-keys kb-permissions-get`); false means full organization access",
        "items[].revoked_at — present only when the key was revoked; it no longer authenticates",
        "items[].expires_at — present only when an expiry was set; a past value no longer authenticates",
        "items[].last_used_at — present once the key has authenticated at least once",
        "total, limit, offset — the page you are looking at",
      ],
      exitCodes: {
        ...idExits,
        2: "--limit or --offset is not an integer in range",
        4: "the organization this key belongs to no longer exists",
      },
      examples: [
        { command: "senso api-keys list --limit 100" },
        {
          comment: "Only the keys that still authenticate",
          command:
            "senso api-keys list --output json | jq -r '.data.items[] | select(.revoked_at == null) | .id'",
        },
      ],
      seeAlso: ["senso api-keys get", "senso api-keys kb-permissions-get", "senso whoami"],
      notes: [
        "Null timestamps are omitted rather than returned as null: no `last_used_at` key means the key has never been used.",
      ],
    },
  );

  describeCommand(
    keys
      .command("create")
      .description(
        "Create an API key. The secret is in the `key` field of the payload and is returned exactly once — the API never shows it again, and no other command can retrieve it.",
      )
      .requiredOption(
        "--data <json>",
        'JSON: { "name": "ci-deploy", "expires_at": "2026-12-31T00:00:00Z" }. name is required (1-255 characters); expires_at is optional ISO 8601 — omit it for a key that never expires.',
      )
      .action(
        runAction(program, async (ctx, cmdOpts: { data: string }) => {
          const body = parseJsonFlag(cmdOpts.data, {
            required: ["name"],
            optional: ["expires_at"],
          });
          assertIsoTimestamp(body.expires_at);

          const data = await apiRequest<{ id?: string; name?: string }>({
            method: "POST",
            path: "/org/api-keys",
            body,
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
            resource: API_KEY,
          });

          // The secret reaches stdout inside the payload and nowhere else: not
          // the confirmation line, not the debug log (api-client logs method,
          // URL and status only), not the warning.
          if (!ctx.quiet) {
            log.success(
              `Created API key ${data.name ?? ""} (${data.id ?? ""}).`.replace("  ", " "),
            );
          }
          emit(ctx, data, {
            warnings: [
              "The `key` field is the secret. It is shown once and is never returned again — store it now.",
            ],
            next: [
              {
                why: "Restrict the new key to knowledge base folders",
                command: `senso api-keys kb-permissions-set ${data.id ?? "<keyId>"} --data '{"grants":[{"node_id":"<kb_node_id>","role":"viewer"}]}'`,
              },
            ],
          });
        }),
      ),
    {
      returns: [
        "id — the key's id, for every other command in this group",
        "key — THE SECRET, returned once and never again. Store it before the process exits",
        "name, organization_id, expires_at (absent when the key never expires), created_at, updated_at",
      ],
      exitCodes: {
        ...idExits,
        2: "--data is not an object, is missing name, or has an unparseable expires_at",
        3: "the API refuses API-key authentication for this action (see Notes)",
      },
      examples: [
        { command: `senso api-keys create --data '{"name":"ci-deploy"}'` },
        {
          comment: "Capture the secret; it cannot be read back",
          command: `senso api-keys create --data '{"name":"ci-deploy"}' --output json | jq -r .data.key`,
        },
      ],
      seeAlso: ["senso api-keys list", "senso api-keys kb-permissions-set"],
      notes: [DASHBOARD_ONLY, "The secret is written to stdout only, and never to the debug log."],
    },
  );

  describeCommand(
    keys
      .command("get")
      .description("Read one API key of the organization. The secret is never returned.")
      .argument(
        "<keyId>",
        "the key's id (UUID) from `senso api-keys list` — not the sk_… secret. To identify the key you are calling with, use `senso whoami`",
      )
      .action(
        runAction(program, async (ctx, keyIdArg: string) => {
          const keyId = parseId(keyIdArg, { ...API_KEY, label: "<keyId>" });
          const data = await apiRequest<{ scoped?: boolean }>({
            path: `/org/api-keys/${keyId}`,
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
            resource: { ...API_KEY, id: keyId },
          });
          emit(ctx, data, {
            next: [
              {
                why: data.scoped
                  ? "See which knowledge base folders this scoped key can read"
                  : "Check the key's knowledge base grants (none means full access)",
                command: `senso api-keys kb-permissions-get ${keyId}`,
              },
            ],
          });
        }),
      ),
    {
      returns: [
        "id, name, organization_id, created_at, updated_at",
        "scoped — true | false. true means knowledge base folder grants apply (`senso api-keys kb-permissions-get`)",
        "revoked_at — present only when revoked",
        "expires_at — present only when an expiry was set",
        "last_used_at — present once the key has been used",
      ],
      exitCodes: {
        ...idExits,
        2: "<keyId> is not a UUID — most often the secret was passed instead of the id",
        4: "no key with that id in this organization",
      },
      examples: [
        { command: "senso api-keys get c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f" },
        {
          command:
            "senso api-keys get c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f --output json | jq .data.scoped",
        },
      ],
      seeAlso: ["senso api-keys list", "senso api-keys kb-permissions-get", "senso whoami"],
    },
  );

  describeCommand(
    keys
      .command("update")
      .description(
        "Rename an API key or change its expiry. The API requires `name` on every update, so an expires_at-only change is not possible.",
      )
      .argument("<keyId>", "the key's id (UUID) from `senso api-keys list` — not the secret")
      .requiredOption(
        "--data <json>",
        'JSON: { "name": "new-name", "expires_at": "2027-01-01T00:00:00Z" }. name is required by the API even when only the expiry is changing; expires_at is optional ISO 8601.',
      )
      .action(
        runAction(program, async (ctx, keyIdArg: string, cmdOpts: { data: string }) => {
          const keyId = parseId(keyIdArg, { ...API_KEY, label: "<keyId>" });
          const body = parseJsonFlag(cmdOpts.data, {
            required: ["name"],
            optional: ["expires_at"],
          });
          assertIsoTimestamp(body.expires_at);

          const data = await apiRequest({
            method: "PUT",
            path: `/org/api-keys/${keyId}`,
            body,
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
            resource: { ...API_KEY, id: keyId },
          });
          if (!ctx.quiet) log.success(`API key ${keyId} updated.`);
          emit(ctx, data, {
            next: [{ why: "Confirm the stored record", command: `senso api-keys get ${keyId}` }],
          });
        }),
      ),
    {
      returns: ["The key record after the write — the same fields as `senso api-keys get`."],
      exitCodes: {
        ...idExits,
        2: "<keyId> is not a UUID, or --data is missing name",
        3: "the API refuses API-key authentication for this action (see Notes)",
        4: "no key with that id in this organization",
      },
      examples: [
        {
          command: `senso api-keys update c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f --data '{"name":"ci-deploy-2"}'`,
        },
      ],
      seeAlso: ["senso api-keys list", "senso api-keys get"],
      notes: [DASHBOARD_ONLY],
    },
  );

  describeCommand(
    keys
      .command("delete")
      .description("Permanently delete an API key. This cannot be undone.")
      .argument("<keyId>", "the key's id (UUID) from `senso api-keys list` — not the secret")
      .action(
        runAction(program, async (ctx, keyIdArg: string) => {
          const keyId = parseId(keyIdArg, { ...API_KEY, label: "<keyId>" });
          await apiRequest({
            method: "DELETE",
            path: `/org/api-keys/${keyId}`,
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
            resource: { ...API_KEY, id: keyId },
          });
          emitConfirmation(ctx, `API key ${keyId} deleted.`, {
            action: "deleted",
            resource: "api_key",
            id: keyId,
          });
        }),
      ),
    {
      returns: [
        "Nothing is returned by the API (204). JSON mode reports { action: deleted, resource: api_key, id }.",
      ],
      exitCodes: {
        ...idExits,
        2: "<keyId> is not a UUID",
        3: "the API refuses API-key authentication for this action (see Notes)",
        4: "no key with that id in this organization",
      },
      examples: [{ command: "senso api-keys delete c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f" }],
      seeAlso: ["senso api-keys revoke", "senso api-keys list"],
      notes: [
        DASHBOARD_ONLY,
        "Deleting removes the record; `senso api-keys revoke` keeps it listed with revoked_at set.",
      ],
    },
  );

  describeCommand(
    keys
      .command("revoke")
      .description(
        "Revoke an API key. The key stays listed, with revoked_at set, and no longer authenticates.",
      )
      .argument("<keyId>", "the key's id (UUID) from `senso api-keys list` — not the secret")
      .action(
        runAction(program, async (ctx, keyIdArg: string) => {
          const keyId = parseId(keyIdArg, { ...API_KEY, label: "<keyId>" });
          await apiRequest({
            method: "POST",
            path: `/org/api-keys/${keyId}/revoke`,
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
            resource: { ...API_KEY, id: keyId },
          });
          emitConfirmation(ctx, `API key ${keyId} revoked.`, {
            action: "revoked",
            resource: "api_key",
            id: keyId,
          });
        }),
      ),
    {
      returns: [
        "Nothing is returned by the API (204). JSON mode reports { action: revoked, resource: api_key, id }.",
      ],
      exitCodes: {
        ...idExits,
        2: "<keyId> is not a UUID",
        3: "the API refuses API-key authentication for this action (see Notes)",
        4: "no key with that id in this organization",
      },
      examples: [{ command: "senso api-keys revoke c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f" }],
      seeAlso: ["senso api-keys delete", "senso api-keys list"],
      notes: [DASHBOARD_ONLY, "Revoking is not reversible: issue a new key instead."],
    },
  );

  describeCommand(
    keys
      .command("kb-permissions-get")
      .description(
        "List the knowledge base folder grants that restrict a key. A scoped key can only read and search within the folders listed; an unscoped key has full organization access.",
      )
      .argument("<keyId>", "the key's id (UUID) from `senso api-keys list` — not the secret")
      .action(
        runAction(program, async (ctx, keyIdArg: string) => {
          const keyId = parseId(keyIdArg, { ...API_KEY, label: "<keyId>" });
          const data = await apiRequest({
            path: `/org/api-keys/${keyId}/kb-permissions`,
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
            resource: { ...API_KEY, id: keyId },
          });
          emit(ctx, data, {
            columns: ["node_id", "role"],
            empty: "KB grants",
            // The API answers an unknown key id with [] rather than a 404, so
            // "no grants" and "no such key" look identical. Say both.
            emptyHint: `No grants means this key has full organization access — or that no key has this id, which the API reports the same way. Confirm with \`senso api-keys get ${keyId}\`.`,
            next: [
              {
                why: "Confirm the key exists and is scoped",
                command: `senso api-keys get ${keyId}`,
              },
            ],
          });
        }),
      ),
    {
      returns: [
        "node_id — the kb_node_id of a folder (`senso kb my-files`, `senso kb get <id>`)",
        "role — viewer | editor | owner. viewer grants view and download; editor and owner also grant create, update, delete and share",
        "An empty array means the key is unscoped — or that no key has this id; the API answers both the same way.",
      ],
      exitCodes: {
        ...idExits,
        2: "<keyId> is not a UUID",
      },
      examples: [
        { command: "senso api-keys kb-permissions-get c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f" },
        {
          command:
            "senso api-keys kb-permissions-get c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f --output json | jq -r '.data[].node_id'",
        },
      ],
      seeAlso: ["senso api-keys get", "senso kb my-files"],
      notes: ["This endpoint does not 404: an unknown key id returns an empty list."],
    },
  );

  describeCommand(
    keys
      .command("kb-permissions-set")
      .description(
        "Set the knowledge base folder grants for an API key. REPLACES the existing grants: the list you send becomes the whole scope. At least one grant is required — to clear the scope use `senso api-keys kb-permissions-delete`.",
      )
      .argument("<keyId>", "the key's id (UUID) from `senso api-keys list` — not the secret")
      .requiredOption(
        "--data <json>",
        'JSON: { "grants": [{ "node_id": "<kb_node_id>", "role": "viewer" }] }. node_id is a folder from `senso kb my-files`; role is one of viewer, editor, owner (`admin` is the org-admin bypass and is not grantable). At least one grant.',
      )
      .action(
        runAction(program, async (ctx, keyIdArg: string, cmdOpts: { data: string }) => {
          const keyId = parseId(keyIdArg, { ...API_KEY, label: "<keyId>" });
          const body = parseJsonFlag(cmdOpts.data, { required: ["grants"] });
          validateGrants(body.grants);

          const data = await apiRequest({
            method: "PUT",
            path: `/org/api-keys/${keyId}/kb-permissions`,
            body,
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
            resource: { ...API_KEY, id: keyId },
          });
          if (!ctx.quiet) log.success(`KB permissions updated for key ${keyId}.`);
          emit(ctx, data, {
            columns: ["node_id", "role"],
            warnings: [
              "These grants replaced the key's whole scope: any folder you left out is no longer reachable with this key.",
            ],
            next: [
              {
                why: "Confirm the stored grants",
                command: `senso api-keys kb-permissions-get ${keyId}`,
              },
            ],
          });
        }),
      ),
    {
      returns: [
        "The full grant list after the write: node_id and role per entry",
        "role — viewer | editor | owner",
      ],
      exitCodes: {
        ...idExits,
        2: "<keyId> is not a UUID, --data has no grants, a node_id is not a UUID, or a role is not viewer/editor/owner",
        3: "the API refuses API-key authentication for this action (see Notes)",
        4: "no key with that id in this organization",
      },
      examples: [
        {
          command: `senso api-keys kb-permissions-set c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f --data '{"grants":[{"node_id":"3f2a1b0c-9d8e-4f7a-b6c5-d4e3f2a1b0c9","role":"viewer"}]}'`,
        },
      ],
      seeAlso: ["senso api-keys kb-permissions-get", "senso kb my-files"],
      notes: [
        DASHBOARD_ONLY,
        "Grants are replaced wholesale. Read the current list with `senso api-keys kb-permissions-get` and send back every grant you want to keep.",
      ],
    },
  );

  describeCommand(
    keys
      .command("kb-permissions-delete")
      .description(
        "Remove every knowledge base folder grant from an API key, restoring full organization access for that key.",
      )
      .argument("<keyId>", "the key's id (UUID) from `senso api-keys list` — not the secret")
      .action(
        runAction(program, async (ctx, keyIdArg: string) => {
          const keyId = parseId(keyIdArg, { ...API_KEY, label: "<keyId>" });
          await apiRequest({
            method: "DELETE",
            path: `/org/api-keys/${keyId}/kb-permissions`,
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
            resource: { ...API_KEY, id: keyId },
          });
          emitConfirmation(
            ctx,
            `KB permissions removed from key ${keyId}; it now has full organization access.`,
            { action: "deleted", resource: "api_key_kb_scope", id: keyId },
            {
              warnings: [
                "This key is now unscoped: it can read and search the whole knowledge base.",
              ],
              next: [
                {
                  why: "Confirm the scope is empty",
                  command: `senso api-keys kb-permissions-get ${keyId}`,
                },
              ],
            },
          );
        }),
      ),
    {
      returns: [
        "Nothing is returned by the API (204). JSON mode reports { action: deleted, resource: api_key_kb_scope, id }.",
      ],
      exitCodes: {
        ...idExits,
        2: "<keyId> is not a UUID",
        3: "the API refuses API-key authentication for this action (see Notes)",
        4: "no key with that id in this organization",
      },
      examples: [
        { command: "senso api-keys kb-permissions-delete c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f" },
      ],
      seeAlso: ["senso api-keys kb-permissions-set", "senso api-keys kb-permissions-get"],
      notes: [
        DASHBOARD_ONLY,
        "This widens a key's access. It is why the API refuses API-key authentication here: a scoped key could otherwise promote itself.",
      ],
    },
  );
}
