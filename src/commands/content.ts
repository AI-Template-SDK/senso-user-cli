import { Command } from "commander";
import pc from "picocolors";
import { apiRequest, formatApiError } from "../lib/api-client.js";
import { output, type OutputFormat } from "../lib/output.js";
import * as log from "../utils/logger.js";

export function registerContentCommands(program: Command): void {
  const content = program
    .command("content")
    .description("Manage content items");

  content
    .command("list")
    .description("List content items")
    .option("--limit <n>", "Items per page", "10")
    .option("--offset <n>", "Pagination offset", "0")
    .action(async (cmdOpts: Record<string, string>) => {
      const opts = program.opts();
      try {
        const data = await apiRequest<Record<string, unknown>[]>({
          path: "/org/content",
          params: { limit: cmdOpts.limit, offset: cmdOpts.offset },
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
    .description("Get content item by ID")
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
    .description("Delete content (local + external)")
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
    .description("Unpublish content (external delete + set draft)")
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
    .description("List content awaiting verification")
    .action(async () => {
      const opts = program.opts();
      try {
        const data = await apiRequest({ path: "/org/content/verification", apiKey: opts.apiKey, baseUrl: opts.baseUrl });
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  content
    .command("reject <versionId>")
    .description("Reject a content version")
    .action(async (versionId: string) => {
      const opts = program.opts();
      try {
        await apiRequest({ method: "POST", path: `/org/content/versions/${versionId}/reject`, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
        log.success(`Version ${versionId} rejected.`);
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  content
    .command("restore <versionId>")
    .description("Restore a content version to draft")
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
    .description("List content owners")
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
    .description("Replace content owners")
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
    .description("Remove content owner")
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
