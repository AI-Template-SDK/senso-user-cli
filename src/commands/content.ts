import { Command } from "commander";
import pc from "picocolors";
import { apiRequest, formatApiError } from "../lib/api-client.js";
import { output, type OutputFormat } from "../lib/output.js";
import * as log from "../utils/logger.js";

export function registerContentCommands(program: Command): void {
  const content = program
    .command("content")
    .description("Manage content items in the knowledge base. List, inspect, delete, unpublish, and manage the verification workflow and ownership of content.");

  content
    .command("list")
    .description("List all content items in the knowledge base. Returns title, status, and ID for each item. Use --search to filter by title, --sort to order results.")
    .option("--limit <n>", "Items per page", "10")
    .option("--offset <n>", "Pagination offset", "0")
    .option("--search <query>", "Filter content by title")
    .option("--sort <order>", "Sort order: title_asc, title_desc, created_asc, created_desc")
    .action(async (cmdOpts: Record<string, string>) => {
      const opts = program.opts();
      try {
        const data = await apiRequest<Record<string, unknown>[]>({
          path: "/org/content",
          params: { limit: cmdOpts.limit, offset: cmdOpts.offset, search: cmdOpts.search, sort: cmdOpts.sort },
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        const format: OutputFormat = opts.output || "plain";
        const rows = Array.isArray(data) ? data : [];
        output(format, {
          json: data,
          table: {
            rows: rows.map((r) => ({
              id: r.id || r.content_id,
              title: r.title,
              status: r.status,
            })),
            columns: ["id", "title", "status"],
          },
          plain: rows.length
            ? rows.map(
                (r) =>
                  `  ${pc.bold(String(r.title || "Untitled"))} ${pc.dim(`(${r.id || r.content_id})`)} ${r.status ? pc.dim(`[${r.status}]`) : ""}`,
              )
            : ["  No content found."],
        });
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  content
    .command("get <id>")
    .description("Get a content item by ID. Returns the full content detail including versions, metadata, and publish status.")
    .action(async (id: string) => {
      const opts = program.opts();
      try {
        const data = await apiRequest({ path: `/org/content/${id}`, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  content
    .command("delete <id>")
    .description("Delete a content item from the knowledge base and any external publish destinations. This cannot be undone.")
    .action(async (id: string) => {
      const opts = program.opts();
      try {
        await apiRequest({ method: "DELETE", path: `/org/content/${id}`, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
        log.success(`Content ${id} deleted.`);
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  content
    .command("unpublish <id>")
    .description("Unpublish a content item. Removes it from external destinations and sets its status back to draft.")
    .action(async (id: string) => {
      const opts = program.opts();
      try {
        await apiRequest({ method: "POST", path: `/org/content/${id}/unpublish`, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
        log.success(`Content ${id} unpublished.`);
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  content
    .command("verification")
    .description("List content items in the verification workflow. Filter by editorial status (draft, review, rejected, published) to manage the review pipeline.")
    .option("--limit <n>", "Maximum items to return")
    .option("--offset <n>", "Number of items to skip (for pagination)")
    .option("--search <query>", "Filter by title")
    .option("--status <status>", "Filter by status: all, draft, review, rejected, published")
    .action(async (cmdOpts: Record<string, string>) => {
      const opts = program.opts();
      try {
        const data = await apiRequest({
          path: "/org/content/verification",
          params: { limit: cmdOpts.limit, offset: cmdOpts.offset, search: cmdOpts.search, status: cmdOpts.status },
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  content
    .command("reject <versionId>")
    .description("Reject a content version in the verification workflow. Optionally provide a reason for the rejection.")
    .option("--reason <text>", "Reason for rejection")
    .action(async (versionId: string, cmdOpts: { reason?: string }) => {
      const opts = program.opts();
      try {
        const body = cmdOpts.reason ? { reason: cmdOpts.reason } : undefined;
        await apiRequest({ method: "POST", path: `/org/content/versions/${versionId}/reject`, body, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
        log.success(`Version ${versionId} rejected.`);
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  content
    .command("restore <versionId>")
    .description("Restore a rejected content version back to draft status for further editing.")
    .action(async (versionId: string) => {
      const opts = program.opts();
      try {
        await apiRequest({ method: "POST", path: `/org/content/versions/${versionId}/restore`, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
        log.success(`Version ${versionId} restored to draft.`);
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  content
    .command("owners <id>")
    .description("List the owners assigned to a content item. Owners are responsible for reviewing and approving content.")
    .action(async (id: string) => {
      const opts = program.opts();
      try {
        const data = await apiRequest({ path: `/org/content/${id}/owners`, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  content
    .command("set-owners <id>")
    .description("Replace all owners of a content item with a new set of user IDs.")
    .requiredOption("--user-ids <ids...>", "User IDs to set as owners")
    .action(async (id: string, cmdOpts: { userIds: string[] }) => {
      const opts = program.opts();
      try {
        await apiRequest({
          method: "PUT",
          path: `/org/content/${id}/owners`,
          body: { user_ids: cmdOpts.userIds },
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        log.success(`Owners updated for content ${id}.`);
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  content
    .command("remove-owner <id> <userId>")
    .description("Remove a single owner from a content item.")
    .action(async (id: string, userId: string) => {
      const opts = program.opts();
      try {
        await apiRequest({ method: "DELETE", path: `/org/content/${id}/owners/${userId}`, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
        log.success(`Owner ${userId} removed from content ${id}.`);
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });
}
