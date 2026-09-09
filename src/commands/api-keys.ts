import { Command } from "commander";
import { apiRequest } from "../lib/api-client.js";
import { emit, emitConfirmation } from "../lib/output.js";
import { parseJsonFlag } from "../lib/json-arg.js";
import { runAction } from "../lib/run-action.js";
import * as log from "../utils/logger.js";

export function registerApiKeyCommands(program: Command): void {
  const keys = program
    .command("api-keys")
    .description(
      "Manage org-scoped API keys. Create, rotate, revoke, or list API keys used to authenticate with the Senso API.",
    );

  keys
    .command("list")
    .description(
      "List all API keys for the organization. Shows name, expiry, revocation status, and last usage.",
    )
    .option("--limit <n>", "Maximum number of keys to return")
    .option("--offset <n>", "Number of keys to skip (for pagination)")
    .action(
      runAction(program, async (ctx, cmdOpts: Record<string, string>) => {
        const data = await apiRequest({
          path: "/org/api-keys",
          params: { limit: cmdOpts.limit, offset: cmdOpts.offset },
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emit(ctx, data, { columns: ["id", "name", "scoped", "expires_at", "last_used_at"] });
      }),
    );

  keys
    .command("create")
    .description("Create a new API key. The key value is returned only once — store it securely.")
    .requiredOption(
      "--data <json>",
      'JSON: { "name": "my-key", "expires_at": "2025-12-31T00:00:00Z" }',
    )
    .action(
      runAction(program, async (ctx, cmdOpts: { data: string }) => {
        const body = parseJsonFlag(cmdOpts.data);
        const data = await apiRequest({
          method: "POST",
          path: "/org/api-keys",
          body,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        // The secret is in the payload and shown once, so it must reach stdout
        // even when the confirmation line is suppressed.
        if (!ctx.quiet) log.success("API key created.");
        emit(ctx, data);
      }),
    );

  keys
    .command("get <keyId>")
    .description(
      "Get details for a specific API key including name, expiry, and last used timestamp.",
    )
    .action(
      runAction(program, async (ctx, keyId: string) => {
        const data = await apiRequest({
          path: `/org/api-keys/${keyId}`,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emit(ctx, data);
      }),
    );

  keys
    .command("update <keyId>")
    .description("Update an API key's name or expiry date.")
    .requiredOption(
      "--data <json>",
      'JSON: { "name": "new-name", "expires_at": "2026-06-01T00:00:00Z" }',
    )
    .action(
      runAction(program, async (ctx, keyId: string, cmdOpts: { data: string }) => {
        const body = parseJsonFlag(cmdOpts.data);
        const data = await apiRequest({
          method: "PUT",
          path: `/org/api-keys/${keyId}`,
          body,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        if (!ctx.quiet) log.success(`API key ${keyId} updated.`);
        emit(ctx, data);
      }),
    );

  keys
    .command("delete <keyId>")
    .description("Permanently delete an API key. This cannot be undone.")
    .action(
      runAction(program, async (ctx, keyId: string) => {
        await apiRequest({
          method: "DELETE",
          path: `/org/api-keys/${keyId}`,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emitConfirmation(ctx, `API key ${keyId} deleted.`);
      }),
    );

  keys
    .command("revoke <keyId>")
    .description(
      "Revoke an API key. The key remains visible but can no longer be used for authentication.",
    )
    .action(
      runAction(program, async (ctx, keyId: string) => {
        await apiRequest({
          method: "POST",
          path: `/org/api-keys/${keyId}/revoke`,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emitConfirmation(ctx, `API key ${keyId} revoked.`);
      }),
    );

  keys
    .command("kb-permissions-get <keyId>")
    .description("Get the knowledge base node permission grants configured for an API key.")
    .action(
      runAction(program, async (ctx, keyId: string) => {
        const data = await apiRequest({
          path: `/org/api-keys/${keyId}/kb-permissions`,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emit(ctx, data, { columns: ["node_id", "role"] });
      }),
    );

  keys
    .command("kb-permissions-set <keyId>")
    .description(
      "Set KB node permission grants for an API key. Replaces any existing grants. Each grant requires a node_id (UUID) and role (viewer|editor|owner|admin).",
    )
    .requiredOption(
      "--data <json>",
      'JSON: { "grants": [{ "node_id": "<uuid>", "role": "viewer" }] }',
    )
    .action(
      runAction(program, async (ctx, keyId: string, cmdOpts: { data: string }) => {
        const body = parseJsonFlag(cmdOpts.data);
        const data = await apiRequest({
          method: "PUT",
          path: `/org/api-keys/${keyId}/kb-permissions`,
          body,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        if (!ctx.quiet) log.success(`KB permissions updated for key ${keyId}.`);
        emit(ctx, data, { columns: ["node_id", "role"] });
      }),
    );

  keys
    .command("kb-permissions-delete <keyId>")
    .description(
      "Remove all KB node permission grants from an API key, restoring full org-level access.",
    )
    .action(
      runAction(program, async (ctx, keyId: string) => {
        await apiRequest({
          method: "DELETE",
          path: `/org/api-keys/${keyId}/kb-permissions`,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emitConfirmation(ctx, `KB permissions removed from key ${keyId}.`);
      }),
    );
}
