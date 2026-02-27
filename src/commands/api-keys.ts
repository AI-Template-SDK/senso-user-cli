import { Command } from "commander";
import { apiRequest, formatApiError } from "../lib/api-client.js";
import * as log from "../utils/logger.js";

export function registerApiKeyCommands(program: Command): void {
  const keys = program
    .command("api-keys")
    .description("Manage API keys");

  keys
    .command("list")
    .description("List API keys")
    .action(async () => {
      const opts = program.opts();
      try {
        const data = await apiRequest({ path: "/org/api-keys", apiKey: opts.apiKey, baseUrl: opts.baseUrl });
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  keys
    .command("create")
    .description("Create API key")
    .requiredOption("--data <json>", "JSON key configuration")
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
    .description("Get API key details")
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
    .description("Update API key")
    .requiredOption("--data <json>", "JSON key updates")
    .action(async (keyId: string, cmdOpts: { data: string }) => {
      const opts = program.opts();
      try {
        const body = JSON.parse(cmdOpts.data);
        const data = await apiRequest({
          method: "PATCH",
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
    .description("Delete API key")
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
    .description("Revoke API key")
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
}
