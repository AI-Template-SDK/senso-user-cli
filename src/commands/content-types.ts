import { Command } from "commander";
import { apiRequest } from "../lib/api-client.js";
import { parseJsonFlag } from "../lib/json-arg.js";
import { emit, emitConfirmation } from "../lib/output.js";
import { runAction } from "../lib/run-action.js";
import * as log from "../utils/logger.js";

export function registerContentTypeCommands(program: Command): void {
  const ct = program
    .command("content-types")
    .description(
      "Manage content type configurations. Content types define the output format and structure for AI-generated content (e.g. blog post, FAQ, landing page).",
    );

  ct.command("list")
    .description("List all content types configured for the organization.")
    .option("--limit <n>", "Maximum number of content types to return (default: 50)")
    .option("--offset <n>", "Number of items to skip (for pagination)")
    .action(
      runAction(program, async (ctx, cmdOpts: Record<string, string>) => {
        const data = await apiRequest({
          path: "/org/content-types",
          params: { limit: cmdOpts.limit, offset: cmdOpts.offset },
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        // 'config' is nested and long; `get <id>` is where you read it.
        emit(ctx, data, { columns: ["content_type_id", "name", "created_at", "updated_at"] });
      }),
    );

  ct.command("create")
    .description(
      "Create a new content type. Requires a name and a config defining the output structure. config accepts a defined set of keys: template, cta_text, cta_destination, writing_rules (array). Unknown keys are rejected. `template` is markdown, not a description of markdown: the server derives the section structure from its headings, and word budgets from annotations like (40-80 words). Prose that describes a structure parses to zero sections and is accepted silently. `template_spec` is derived from `template` and is not settable — sending it fails validation.",
    )
    .requiredOption(
      "--data <json>",
      'JSON: { "name": "Blog Post", "config": { "template": "# Title\\n\\nDirect answer to the question. (40-80 words)\\n\\n## Detail\\n\\nSupporting evidence from the knowledge base. (150-250 words)\\n", "cta_text": "Talk to us", "cta_destination": "https://example.com", "writing_rules": [] } }',
    )
    .action(
      runAction(program, async (ctx, cmdOpts: { data: string }) => {
        const body = parseJsonFlag(cmdOpts.data);
        const data = await apiRequest({
          method: "POST",
          path: "/org/content-types",
          body,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        if (!ctx.quiet) log.success("Content type created.");
        emit(ctx, data);
      }),
    );

  ct.command("get <id>")
    .description("Get a content type by ID, including its full configuration.")
    .action(
      runAction(program, async (ctx, id: string) => {
        const data = await apiRequest({
          path: `/org/content-types/${id}`,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emit(ctx, data);
      }),
    );

  ct.command("update <id>")
    .description(
      "Replace a content type's name and config (PUT). Both fields are required — run 'get <id>' first to preserve existing values. For single-field updates, use 'content-types patch <id>'. `template` is markdown and the server re-derives the section structure from its headings; see 'content-types create --help'.",
    )
    .requiredOption(
      "--data <json>",
      'JSON: { "name": "Updated Name", "config": { "template": "# Title\\n\\nDirect answer to the question. (40-80 words)\\n\\n## Detail\\n\\nSupporting evidence from the knowledge base. (150-250 words)\\n", "cta_text": "Talk to us", "cta_destination": "https://example.com", "writing_rules": [] } }',
    )
    .action(
      runAction(program, async (ctx, id: string, cmdOpts: { data: string }) => {
        const body = parseJsonFlag(cmdOpts.data);
        const data = await apiRequest({
          method: "PUT",
          path: `/org/content-types/${id}`,
          body,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        if (!ctx.quiet) log.success(`Content type ${id} updated.`);
        emit(ctx, data);
      }),
    );

  ct.command("patch <id>")
    .description(
      "Partially update a content type (PATCH). Only the fields you provide are changed — existing fields are preserved. Preferred over 'update' for targeted changes like updating just the template. `template` is markdown and the server re-derives the section structure from its headings; see 'content-types create --help'.",
    )
    .requiredOption(
      "--data <json>",
      'JSON: { "config": { "template": "# Title\\n\\nDirect answer to the question. (40-80 words)\\n\\n## Detail\\n\\nSupporting evidence from the knowledge base. (150-250 words)\\n" } }',
    )
    .action(
      runAction(program, async (ctx, id: string, cmdOpts: { data: string }) => {
        const body = parseJsonFlag(cmdOpts.data);
        const data = await apiRequest({
          method: "PATCH",
          path: `/org/content-types/${id}`,
          body,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        if (!ctx.quiet) log.success(`Content type ${id} updated.`);
        emit(ctx, data);
      }),
    );

  ct.command("delete <id>")
    .description("Delete a content type. This cannot be undone.")
    .action(
      runAction(program, async (ctx, id: string) => {
        await apiRequest({
          method: "DELETE",
          path: `/org/content-types/${id}`,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emitConfirmation(ctx, `Content type ${id} deleted.`);
      }),
    );
}
