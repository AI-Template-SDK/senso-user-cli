import { Command } from "commander";
import pc from "picocolors";
import { apiRequest, formatApiError } from "../lib/api-client.js";
import { output, type OutputFormat } from "../lib/output.js";
import * as log from "../utils/logger.js";

export function registerSearchCommands(program: Command): void {
  const search = program
    .command("search")
    .description("Semantic search over your knowledge base");

  // Default: senso search <query> → POST /org/search (answer + results)
  search
    .argument("<query>", "Search query")
    .option("--max-results <n>", "Maximum number of results", "5")
    .action(async (query: string, cmdOpts: Record<string, string>) => {
      const opts = program.opts();
      try {
        const data = await apiRequest({
          method: "POST",
          path: "/org/search",
          body: { query, max_results: parseInt(cmdOpts.maxResults) },
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
    .description("Semantic search — chunks only")
    .option("--max-results <n>", "Maximum results", "5")
    .action(async (query: string, cmdOpts: Record<string, string>) => {
      const opts = program.opts();
      try {
        const data = await apiRequest({
          method: "POST",
          path: "/org/search/context",
          body: { query, max_results: parseInt(cmdOpts.maxResults) },
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
    .description("Semantic search — content IDs only")
    .option("--max-results <n>", "Maximum results", "5")
    .action(async (query: string, cmdOpts: Record<string, string>) => {
      const opts = program.opts();
      try {
        const data = await apiRequest({
          method: "POST",
          path: "/org/search/content",
          body: { query, max_results: parseInt(cmdOpts.maxResults) },
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
