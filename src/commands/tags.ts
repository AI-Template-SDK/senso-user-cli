import { Command } from "commander";
import { apiRequest, formatApiError } from "../lib/api-client.js";
import * as log from "../utils/logger.js";

export function registerTagsCommands(program: Command): void {
  const tags = program
    .command("tags")
    .description("Manage the organization's tag library. Tags are labels attached to prompts, KB nodes, and content items to group them for filtering or metric rollups. Senso auto-tags prompts, KB content, and search queries on creation, so the tag library grows automatically — most workflows skip these commands and rely on attach-by-name on the resource commands, which also creates tags on demand.");

  tags
    .command("list")
    .description("List all tags for the organization. Pass --counts to include per-tag usage counts.")
    .option("--counts", "Include prompt/content usage counts")
    .action(async (cmdOpts: { counts?: boolean }) => {
      const opts = program.opts();
      try {
        const data = await apiRequest({
          path: "/org/tags",
          params: cmdOpts.counts ? { counts: "true" } : {},
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  tags
    .command("create")
    .description("Create a new tag. Tag names are unique per org (case-insensitive).")
    .requiredOption("--name <name>", "Tag name")
    .action(async (cmdOpts: { name: string }) => {
      const opts = program.opts();
      try {
        const data = await apiRequest({
          method: "POST",
          path: "/org/tags",
          body: { name: cmdOpts.name },
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        log.success(`Tag "${cmdOpts.name}" created.`);
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  tags
    .command("get <id>")
    .description("Get a tag by ID, including usage counts.")
    .action(async (id: string) => {
      const opts = program.opts();
      try {
        const data = await apiRequest({ path: `/org/tags/${id}`, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  tags
    .command("update <id>")
    .description("Rename a tag. Existing attachments on prompts, content, and KB nodes are preserved.")
    .requiredOption("--name <name>", "New tag name")
    .action(async (id: string, cmdOpts: { name: string }) => {
      const opts = program.opts();
      try {
        const data = await apiRequest({
          method: "PATCH",
          path: `/org/tags/${id}`,
          body: { name: cmdOpts.name },
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        log.success(`Tag ${id} renamed to "${cmdOpts.name}".`);
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  tags
    .command("delete <id>")
    .description("Delete a tag and detach it from every prompt, content item, and KB node it was applied to. This cannot be undone.")
    .action(async (id: string) => {
      const opts = program.opts();
      try {
        await apiRequest({ method: "DELETE", path: `/org/tags/${id}`, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
        log.success(`Tag ${id} deleted.`);
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });
}
