import { Command } from "commander";
import { apiRequest, formatApiError } from "../lib/api-client.js";
import * as log from "../utils/logger.js";

export function registerApiKeyCommands(program: Command): void {
  const keys = program
    .command("api-keys")
    .description("Manage org-scoped API keys. Create, rotate, revoke, or list API keys used to authenticate with the Senso API.");

  keys
    .command("list")
    .description("List all API keys for the organization. Shows name, expiry, revocation status, and last usage.")
    .option("--limit <n>", "Maximum number of keys to return")
    .option("--offset <n>", "Number of keys to skip (for pagination)")
    .action(async (cmdOpts: Record<string, string>) => {
      const opts = program.opts();
      try {
        const data = await apiRequest({
          path: "/org/api-keys",
          params: { limit: cmdOpts.limit, offset: cmdOpts.offset },
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  keys
    .command("create")
    .description("Create a new API key. The key value is returned only once — store it securely.")
    .requiredOption("--data <json>", 'JSON: { "name": "my-key", "expires_at": "2025-12-31T00:00:00Z" }')
    .action(async (cmdOpts: { data: string }) => {
      const opts = program.opts();
      try {
        const body = JSON.parse(cmdOpts.data);
        const data = await apiRequest({
          method: "POST",
          path: "/org/api-keys",
          body,
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        log.success("API key created.");
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(err instanceof SyntaxError ? "Invalid JSON in --data" : formatApiError(err));
        process.exit(1);
      }
    });

  keys
    .command("get <keyId>")
    .description("Get details for a specific API key including name, expiry, and last used timestamp.")
    .action(async (keyId: string) => {
      const opts = program.opts();
      try {
        const data = await apiRequest({ path: `/org/api-keys/${keyId}`, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  keys
    .command("update <keyId>")
    .description("Update an API key's name or expiry date.")
    .requiredOption("--data <json>", 'JSON: { "name": "new-name", "expires_at": "2026-06-01T00:00:00Z" }')
    .action(async (keyId: string, cmdOpts: { data: string }) => {
      const opts = program.opts();
      try {
        const body = JSON.parse(cmdOpts.data);
        const data = await apiRequest({
          method: "PUT",
          path: `/org/api-keys/${keyId}`,
          body,
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        log.success(`API key ${keyId} updated.`);
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(err instanceof SyntaxError ? "Invalid JSON in --data" : formatApiError(err));
        process.exit(1);
      }
    });

  keys
    .command("delete <keyId>")
    .description("Permanently delete an API key. This cannot be undone.")
    .action(async (keyId: string) => {
      const opts = program.opts();
      try {
        await apiRequest({ method: "DELETE", path: `/org/api-keys/${keyId}`, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
        log.success(`API key ${keyId} deleted.`);
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  keys
    .command("revoke <keyId>")
    .description("Revoke an API key. The key remains visible but can no longer be used for authentication.")
    .action(async (keyId: string) => {
      const opts = program.opts();
      try {
        await apiRequest({ method: "POST", path: `/org/api-keys/${keyId}/revoke`, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
        log.success(`API key ${keyId} revoked.`);
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  keys
    .command("kb-permissions-get <keyId>")
    .description("Get the knowledge base node permission grants configured for an API key.")
    .action(async (keyId: string) => {
      const opts = program.opts();
      try {
        const data = await apiRequest({ path: `/org/api-keys/${keyId}/kb-permissions`, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  keys
    .command("kb-permissions-set <keyId>")
    .description("Set KB node permission grants for an API key. Replaces any existing grants. Each grant requires a node_id (UUID) and role (viewer|editor|owner|admin).")
    .requiredOption("--data <json>", 'JSON: { "grants": [{ "node_id": "<uuid>", "role": "viewer" }] }')
    .action(async (keyId: string, cmdOpts: { data: string }) => {
      const opts = program.opts();
      try {
        const body = JSON.parse(cmdOpts.data);
        const data = await apiRequest({ method: "PUT", path: `/org/api-keys/${keyId}/kb-permissions`, body, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
        log.success(`KB permissions updated for key ${keyId}.`);
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(err instanceof SyntaxError ? "Invalid JSON in --data" : formatApiError(err));
        process.exit(1);
      }
    });

  keys
    .command("kb-permissions-delete <keyId>")
    .description("Remove all KB node permission grants from an API key, restoring full org-level access.")
    .action(async (keyId: string) => {
      const opts = program.opts();
      try {
        await apiRequest({ method: "DELETE", path: `/org/api-keys/${keyId}/kb-permissions`, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
        log.success(`KB permissions removed from key ${keyId}.`);
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });
}
