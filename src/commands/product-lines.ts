import { Command } from "commander";
import { apiRequest, formatApiError } from "../lib/api-client.js";
import * as log from "../utils/logger.js";

export function registerProductLineCommands(program: Command): void {
  const pl = program
    .command("product-lines")
    .description("Manage product lines — flexible org-scoped product/service definitions. Each product line has a name and an arbitrary JSON 'details' blob carried by downstream generation and evaluation pipelines.");

  pl
    .command("list")
    .description("List all product lines for the organization.")
    .option("--limit <n>", "Maximum items to return (default: 50)")
    .option("--offset <n>", "Number of items to skip (for pagination)")
    .action(async (cmdOpts: Record<string, string>) => {
      const opts = program.opts();
      try {
        const data = await apiRequest({
          path: "/org/product-lines",
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

  pl
    .command("create")
    .description("Create a new product line. 'details' is an open-ended JSON object — put whatever structured metadata (SKUs, URLs, positioning, pricing tiers) your workflows need.")
    .requiredOption("--data <json>", 'JSON: { "name": "Pro Plan", "details": { ... } }')
    .action(async (cmdOpts: { data: string }) => {
      const opts = program.opts();
      try {
        const body = JSON.parse(cmdOpts.data);
        const data = await apiRequest({
          method: "POST",
          path: "/org/product-lines",
          body,
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        log.success("Product line created.");
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(err instanceof SyntaxError ? "Invalid JSON in --data" : formatApiError(err));
        process.exit(1);
      }
    });

  pl
    .command("get <id>")
    .description("Get a product line by ID.")
    .action(async (id: string) => {
      const opts = program.opts();
      try {
        const data = await apiRequest({ path: `/org/product-lines/${id}`, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  pl
    .command("update <id>")
    .description("Replace a product line's name and details (PUT). Both fields are required — run 'get <id>' first to preserve existing values. For single-field updates, use 'product-lines patch <id>'.")
    .requiredOption("--data <json>", 'JSON: { "name": "Updated Name", "details": { ... } }')
    .action(async (id: string, cmdOpts: { data: string }) => {
      const opts = program.opts();
      try {
        const body = JSON.parse(cmdOpts.data);
        const data = await apiRequest({
          method: "PUT",
          path: `/org/product-lines/${id}`,
          body,
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        log.success(`Product line ${id} updated.`);
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(err instanceof SyntaxError ? "Invalid JSON in --data" : formatApiError(err));
        process.exit(1);
      }
    });

  pl
    .command("patch <id>")
    .description("Partially update a product line (PATCH). Only the fields you provide are changed — existing fields are preserved.")
    .requiredOption("--data <json>", 'JSON: { "details": { "price": 99 } }')
    .action(async (id: string, cmdOpts: { data: string }) => {
      const opts = program.opts();
      try {
        const body = JSON.parse(cmdOpts.data);
        const data = await apiRequest({
          method: "PATCH",
          path: `/org/product-lines/${id}`,
          body,
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        log.success(`Product line ${id} updated.`);
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(err instanceof SyntaxError ? "Invalid JSON in --data" : formatApiError(err));
        process.exit(1);
      }
    });

  pl
    .command("delete <id>")
    .description("Delete a product line. This cannot be undone.")
    .action(async (id: string) => {
      const opts = program.opts();
      try {
        await apiRequest({ method: "DELETE", path: `/org/product-lines/${id}`, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
        log.success(`Product line ${id} deleted.`);
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });
}
