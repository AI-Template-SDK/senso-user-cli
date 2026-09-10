import { Command } from "commander";
import { apiRequest } from "../lib/api-client.js";
import { parseJsonFlag } from "../lib/json-arg.js";
import { emit, emitConfirmation } from "../lib/output.js";
import { runAction } from "../lib/run-action.js";
import * as log from "../utils/logger.js";

export function registerProductLineCommands(program: Command): void {
  const pl = program
    .command("product-lines")
    .description(
      "Manage product lines — flexible org-scoped product/service definitions. Each product line has a name and an arbitrary JSON 'details' blob carried by downstream generation and evaluation pipelines.",
    );

  pl.command("list")
    .description("List all product lines for the organization.")
    .option("--limit <n>", "Maximum items to return (default: 50)")
    .option("--offset <n>", "Number of items to skip (for pagination)")
    .action(
      runAction(program, async (ctx, cmdOpts: Record<string, string>) => {
        const data = await apiRequest({
          path: "/org/product-lines",
          params: { limit: cmdOpts.limit, offset: cmdOpts.offset },
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        // 'details' is an open-ended blob, so it is left out of the table —
        // `get <id>` is where you read it.
        emit(ctx, data, { columns: ["product_line_id", "name", "created_at", "updated_at"] });
      }),
    );

  pl.command("create")
    .description(
      "Create a new product line. 'details' is an open-ended JSON object — put whatever structured metadata (SKUs, URLs, positioning, pricing tiers) your workflows need.",
    )
    .requiredOption("--data <json>", 'JSON: { "name": "Pro Plan", "details": { ... } }')
    .action(
      runAction(program, async (ctx, cmdOpts: { data: string }) => {
        const body = parseJsonFlag(cmdOpts.data);
        const data = await apiRequest({
          method: "POST",
          path: "/org/product-lines",
          body,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        if (!ctx.quiet) log.success("Product line created.");
        emit(ctx, data);
      }),
    );

  pl.command("get <id>")
    .description("Get a product line by ID.")
    .action(
      runAction(program, async (ctx, id: string) => {
        const data = await apiRequest({
          path: `/org/product-lines/${id}`,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emit(ctx, data);
      }),
    );

  pl.command("update <id>")
    .description(
      "Replace a product line's name and details (PUT). Both fields are required — run 'get <id>' first to preserve existing values. For single-field updates, use 'product-lines patch <id>'.",
    )
    .requiredOption("--data <json>", 'JSON: { "name": "Updated Name", "details": { ... } }')
    .action(
      runAction(program, async (ctx, id: string, cmdOpts: { data: string }) => {
        const body = parseJsonFlag(cmdOpts.data);
        const data = await apiRequest({
          method: "PUT",
          path: `/org/product-lines/${id}`,
          body,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        if (!ctx.quiet) log.success(`Product line ${id} updated.`);
        emit(ctx, data);
      }),
    );

  pl.command("patch <id>")
    .description(
      "Partially update a product line (PATCH). Only the fields you provide are changed — existing fields are preserved.",
    )
    .requiredOption("--data <json>", 'JSON: { "details": { "price": 99 } }')
    .action(
      runAction(program, async (ctx, id: string, cmdOpts: { data: string }) => {
        const body = parseJsonFlag(cmdOpts.data);
        const data = await apiRequest({
          method: "PATCH",
          path: `/org/product-lines/${id}`,
          body,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        if (!ctx.quiet) log.success(`Product line ${id} updated.`);
        emit(ctx, data);
      }),
    );

  pl.command("delete <id>")
    .description("Delete a product line. This cannot be undone.")
    .action(
      runAction(program, async (ctx, id: string) => {
        await apiRequest({
          method: "DELETE",
          path: `/org/product-lines/${id}`,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emitConfirmation(ctx, `Product line ${id} deleted.`);
      }),
    );
}
