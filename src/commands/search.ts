import { Command } from "commander";
import pc from "picocolors";
import { apiRequest, apiStreamRequest, formatApiError } from "../lib/api-client.js";
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
  search
    .command("stream <query>")
    .description("Streaming search — returns AI answer tokens in real-time via SSE, followed by source chunks. Use this for a responsive, live search experience.")
    .option("--max-results <n>", "Maximum results (max: 20)", "5")
    .option("--content-ids <ids...>", "Restrict search to specific content item IDs (space-separated UUIDs)")
    .option("--require-scoped-ids", "Only return results from the specified --content-ids")
    .action(async (query: string, cmdOpts: Record<string, string | boolean | string[]>) => {
      const opts = program.opts();
      const body: Record<string, unknown> = { query, max_results: parseMaxResults(cmdOpts.maxResults as string) };
      if (cmdOpts.contentIds) body.content_ids = cmdOpts.contentIds;
      if (cmdOpts.requireScopedIds) body.require_scoped_ids = true;

      try {
        const res = await apiStreamRequest({
          method: "POST",
          path: "/org/search/stream",
          body,
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });

        if (!res.body) {
          log.error("No response body received.");
          process.exit(1);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let eventType: string | null = null;
        let answerStarted = false;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (line.startsWith("event: ")) {
              eventType = line.slice(7).trim();
            } else if (line.startsWith("data: ") && eventType) {
              const data = JSON.parse(line.slice(6));

              switch (eventType) {
                case "token":
                  if (!answerStarted) {
                    answerStarted = true;
                    process.stdout.write(`\n  ${pc.bold("Answer:")} `);
                  }
                  process.stdout.write(data.token);
                  break;

                case "sources": {
                  if (answerStarted) process.stdout.write("\n");
                  console.log();

                  const results = data.results || [];
                  if (results.length > 0) {
                    console.log(`  ${pc.bold("Sources:")} (${results.length})`);
                    for (let i = 0; i < results.length; i++) {
                      const r = results[i];
                      console.log();
                      console.log(`  ${pc.dim(`${i + 1}.`)} ${pc.bold(r.title || "Untitled")} ${pc.dim(`(${r.content_id})`)}`);
                      if (r.chunk_text) {
                        console.log(`     ${pc.dim("Snippet:")} ${r.chunk_text}`);
                      }
                    }
                  } else {
                    console.log(`  ${pc.dim("No sources found.")}`);
                  }
                  console.log();

                  if (opts.output === "json") {
                    console.log(JSON.stringify(data, null, 2));
                  }
                  break;
                }

                case "error":
                  log.error(`Stream error: ${data.error}`);
                  break;

                case "done":
                  break;
              }
              eventType = null;
            }
          }
        }
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
