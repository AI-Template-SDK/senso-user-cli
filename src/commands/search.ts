import { Command } from "commander";
import pc from "picocolors";
import { apiRequest, formatApiError } from "../lib/api-client.js";
import { output, type OutputFormat } from "../lib/output.js";
import * as log from "../utils/logger.js";

function parseMaxResults(value: string): number {
  const n = parseInt(value);
  if (isNaN(n) || n < 1) return 5;
  return Math.min(n, 20);
}

export function registerSearchCommands(program: Command): void {
  const search = program
    .command("search")
    .description("Search the knowledge base with natural language queries. Returns AI-generated answers synthesised from matching content chunks, or raw chunks/content IDs.");

  // Default: senso search <query> → POST /org/search (answer + results)
  search
    .argument("<query>", "Search query")
    .option("--max-results <n>", "Maximum number of results (max: 20)", "5")
    .option("--content-ids <ids...>", "Restrict search to specific content item IDs (space-separated UUIDs)")
    .option("--require-scoped-ids", "Only return results from the specified --content-ids (omit to allow fallback to all content)")
    .action(async (query: string, cmdOpts: Record<string, string | boolean | string[]>) => {
      const opts = program.opts();
      try {
        const body: Record<string, unknown> = { query, max_results: parseMaxResults(cmdOpts.maxResults as string) };
        if (cmdOpts.contentIds) body.content_ids = cmdOpts.contentIds;
        if (cmdOpts.requireScopedIds) body.require_scoped_ids = true;
        const data = await apiRequest({
          method: "POST",
          path: "/org/search",
          body,
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });

        const format: OutputFormat = opts.output || "plain";
        const res = data as { answer?: string; results?: Array<Record<string, unknown>> };

        output(format, {
          json: data,
          table: res.results
            ? {
                rows: res.results.map((r) => ({
                  id: r.content_id,
                  title: r.title,
                  text: String(r.chunk_text || "").slice(0, 80),
                })),
                columns: ["id", "title", "text"],
              }
            : undefined,
          plain: [
            "",
            res.answer ? `  ${pc.bold("Answer:")} ${res.answer}` : "",
            "",
            ...(res.results || []).map(
              (r, i) =>
                `  ${pc.dim(`${i + 1}.`)} ${pc.bold(String(r.title || "Untitled"))}\n     ${String(r.chunk_text || "").slice(0, 120)}\n     ${pc.dim(`ID: ${r.content_id}`)}`,
            ),
            "",
          ].filter(Boolean),
        });
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  search
    .command("context <query>")
    .description("Search the knowledge base — returns matching content chunks only, without AI answer generation. Use this to feed verified chunks into your own LLM pipeline instead of using Senso's generated answer.")
    .option("--max-results <n>", "Maximum results (max: 20)", "5")
    .option("--content-ids <ids...>", "Restrict search to specific content item IDs (space-separated UUIDs)")
    .option("--require-scoped-ids", "Only return results from the specified --content-ids")
    .action(async (query: string, cmdOpts: Record<string, string | boolean | string[]>) => {
      const opts = program.opts();
      try {
        const body: Record<string, unknown> = { query, max_results: parseMaxResults(cmdOpts.maxResults as string) };
        if (cmdOpts.contentIds) body.content_ids = cmdOpts.contentIds;
        if (cmdOpts.requireScopedIds) body.require_scoped_ids = true;
        const data = await apiRequest({
          method: "POST",
          path: "/org/search/context",
          body,
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        outputByFormat(opts.output, data);
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  search
    .command("content <query>")
    .description("Search the knowledge base — returns deduplicated content IDs and titles only. Use this to discover which documents are relevant before fetching full content with 'content get <id>'.")
    .option("--max-results <n>", "Maximum results (max: 20)", "5")
    .option("--content-ids <ids...>", "Restrict search to specific content item IDs (space-separated UUIDs)")
    .option("--require-scoped-ids", "Only return results from the specified --content-ids")
    .action(async (query: string, cmdOpts: Record<string, string | boolean | string[]>) => {
      const opts = program.opts();
      try {
        const body: Record<string, unknown> = { query, max_results: parseMaxResults(cmdOpts.maxResults as string) };
        if (cmdOpts.contentIds) body.content_ids = cmdOpts.contentIds;
        if (cmdOpts.requireScopedIds) body.require_scoped_ids = true;
        const data = await apiRequest({
          method: "POST",
          path: "/org/search/content",
          body,
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        outputByFormat(opts.output, data);
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  search
    .command("full <query>")
    .description("Alias for the default search — returns AI answer plus matching chunks. Equivalent to 'senso search <query>'.")
    .option("--max-results <n>", "Maximum results (max: 20)", "5")
    .option("--content-ids <ids...>", "Restrict search to specific content item IDs (space-separated UUIDs)")
    .option("--require-scoped-ids", "Only return results from the specified --content-ids")
    .action(async (query: string, cmdOpts: Record<string, string | boolean | string[]>) => {
      const opts = program.opts();
      try {
        const body: Record<string, unknown> = { query, max_results: parseMaxResults(cmdOpts.maxResults as string) };
        if (cmdOpts.contentIds) body.content_ids = cmdOpts.contentIds;
        if (cmdOpts.requireScopedIds) body.require_scoped_ids = true;
        const data = await apiRequest({
          method: "POST",
          path: "/org/search/full",
          body,
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        outputByFormat(opts.output, data);
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });
}

function outputByFormat(format: string | undefined, data: unknown): void {
  if (format === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
}
