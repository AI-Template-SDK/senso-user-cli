import { Command } from "commander";
import pc from "picocolors";
import { apiRequest, apiStreamRequest } from "../lib/api-client.js";
import { CliError, EXIT } from "../lib/errors.js";
import { gapSignalsHeaders } from "../lib/gap-signals.js";
import { emit, writeStdout } from "../lib/output.js";
import { runAction, type Ctx } from "../lib/run-action.js";
import * as log from "../utils/logger.js";

const MAX_RESULTS_CEILING = 20;
const DEFAULT_MAX_RESULTS = 5;

function parseMaxResults(value: string | undefined): number {
  const n = Number.parseInt(value ?? "", 10);
  if (Number.isNaN(n) || n < 1) return DEFAULT_MAX_RESULTS;
  return Math.min(n, MAX_RESULTS_CEILING);
}

/** The options every search subcommand shares. */
interface SearchOptions {
  maxResults?: string;
  contentIds?: string[];
  requireScopedIds?: boolean;
  /** Commander's value for `--no-gap-signals`: false when the flag was passed. */
  gapSignals?: boolean;
}

/**
 * The help text for `--no-gap-signals`, shared so the five commands describe it
 * identically.
 */
const GAP_SIGNALS_HELP =
  "Keep this search out of the organization's gap report (sends X-Senso-Signals: off). Use it for probes, tests and monitors — a real question that finds nothing should be left eligible. The search still runs, costs credits and is recorded. Set SENSO_GAP_SIGNALS=off to do this for every search.";

function buildSearchBody(query: string, cmdOpts: SearchOptions): Record<string, unknown> {
  const body: Record<string, unknown> = {
    query,
    max_results: parseMaxResults(cmdOpts.maxResults),
  };
  if (cmdOpts.contentIds) body.content_ids = cmdOpts.contentIds;
  if (cmdOpts.requireScopedIds) body.require_scoped_ids = true;
  return body;
}

interface SearchResult {
  content_id?: string;
  kb_node_id?: string;
  title?: string;
  chunk_text?: string;
  [key: string]: unknown;
}

interface SearchResponse {
  answer?: string;
  results?: SearchResult[];
  /** `search content` returns its hits under `contents` rather than `results`. */
  contents?: SearchResult[];
}

/**
 * Columns worth seeing when a search result set is rendered as a table.
 *
 * `kb_node_id` leads because it is the id the rest of the CLI takes: every
 * `kb` command addresses a node, and `content_id` is a different id space that
 * 404s against `kb get`. `content_id` stays because it is what `--content-ids`
 * accepts, so the two ids answer different follow-up questions — what to read
 * next, and what to scope the next search to.
 */
const RESULT_COLUMNS = ["kb_node_id", "content_id", "title", "chunk_text"];

/** A content-item hit carries no chunk, so its table drops that column. */
const CONTENT_COLUMNS = ["kb_node_id", "content_id", "title"];

/** One table row: just the declared columns, in their declared order. */
function pickColumns(item: SearchResult, columns: string[]): Record<string, unknown> {
  return Object.fromEntries(columns.map((c) => [c, item[c]]));
}

/**
 * Reads an option that both the subcommand and its parent declare.
 *
 * `senso search <query>` has its own action and its own `--max-results`, and so
 * does every subcommand under it. When a flag name exists on both, Commander
 * binds the value to the parent — so `senso search context "q" --max-results 17
 * --content-ids a b` reached the subcommand with the DEFAULTS, silently
 * searching the whole knowledge base with 5 results instead of the two documents
 * the caller named. The request went out looking perfectly well-formed, which is
 * why nothing noticed.
 *
 * `getOptionValueSource` is what makes the fix exact rather than a guess: it
 * distinguishes a value the user typed ("cli") from one that is merely the
 * declared default, so the subcommand still wins when it was given something.
 */
function resolveOption<T>(command: Command, key: string): T | undefined {
  if (command.getOptionValueSource(key) === "cli") {
    return command.getOptionValue(key) as T;
  }
  const parent = command.parent;
  if (parent?.getOptionValueSource(key) === "cli") {
    return parent.getOptionValue(key) as T;
  }
  return command.getOptionValue(key) as T | undefined;
}

/** The shared options, resolved against both the subcommand and its parent. */
function resolveSearchOptions(command: Command): SearchOptions {
  return {
    maxResults: resolveOption<string>(command, "maxResults"),
    contentIds: resolveOption<string[]>(command, "contentIds"),
    requireScopedIds: resolveOption<boolean>(command, "requireScopedIds"),
    gapSignals: resolveOption<boolean>(command, "gapSignals"),
  };
}

/**
 * Registers one of the non-streaming search variants.
 *
 * `context`, `content` and `full` differ only in their endpoint and their help
 * text — they take the same options and render the same shape — so they are
 * declared once here rather than copied four times, which is what let the dead
 * `outputByFormat` branch sit unnoticed in three of them.
 */
function addSearchVariant(
  parent: Command,
  program: Command,
  name: string,
  path: string,
  description: string,
  columns: string[] = RESULT_COLUMNS,
): void {
  parent
    .command(`${name} <query>`)
    .description(description)
    .option("--max-results <n>", `Maximum results (max: ${MAX_RESULTS_CEILING})`, "5")
    .option(
      "--content-ids <ids...>",
      "Restrict search to specific content item IDs (space-separated UUIDs)",
    )
    .option("--require-scoped-ids", "Only return results from the specified --content-ids")
    .option("--no-gap-signals", GAP_SIGNALS_HELP)
    .action(
      runAction(
        program,
        async (ctx: Ctx, query: string, _cmdOpts: SearchOptions, command: Command) => {
          const opts = resolveSearchOptions(command);
          const data = await apiRequest<SearchResponse>({
            method: "POST",
            path,
            body: buildSearchBody(query, opts),
            headers: gapSignalsHeaders(opts.gapSignals),
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
          });
          // Explicit rows rather than letting `emit` find the list: a search
          // payload carries `query` and `search_type` beside its hits, and
          // findRows deliberately refuses anything that is not a list plus
          // pagination metadata — so without this the variants rendered their
          // whole response as one key/value blob under `--output table`.
          const items = data.results ?? data.contents ?? [];
          emit(ctx, data, {
            table: { rows: items.map((item) => pickColumns(item, columns)), columns },
          });
        },
      ),
    );
}

export function registerSearchCommands(program: Command): void {
  const search = program
    .command("search")
    .description(
      "Search the knowledge base with natural language queries. Returns AI-generated answers synthesized from matching content chunks, or raw chunks/content IDs. An answering search (`search`, `search full`, `search stream`) that finds nothing is filed in the organization's gap report as an API search gap — read them with `senso gaps list --origin api_unanswered_question --status weak --status open`. Pass --no-gap-signals, or set SENSO_GAP_SIGNALS=off, on probes and tests so they do not.",
    );

  // Default: senso search <query> → POST /org/search (answer + results)
  search
    .argument("<query>", "Search query")
    .option("--max-results <n>", `Maximum number of results (max: ${MAX_RESULTS_CEILING})`, "5")
    .option(
      "--content-ids <ids...>",
      "Restrict search to specific content item IDs (space-separated UUIDs)",
    )
    .option(
      "--require-scoped-ids",
      "Only return results from the specified --content-ids (omit to allow fallback to all content)",
    )
    .option("--no-gap-signals", GAP_SIGNALS_HELP)
    .action(
      runAction(program, async (ctx: Ctx, query: string, cmdOpts: SearchOptions) => {
        const data = await apiRequest<SearchResponse>({
          method: "POST",
          path: "/org/search",
          body: buildSearchBody(query, cmdOpts),
          headers: gapSignalsHeaders(cmdOpts.gapSignals),
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });

        const results = data.results ?? [];
        emit(ctx, data, {
          table: {
            rows: results.map((r) => ({
              kb_node_id: r.kb_node_id,
              content_id: r.content_id,
              title: r.title,
              chunk_text: r.chunk_text,
            })),
            columns: RESULT_COLUMNS,
          },
          plain: [
            "",
            ...(data.answer ? [`  ${pc.bold("Answer:")} ${data.answer}`, ""] : []),
            ...results.map(
              (r, i) =>
                `  ${pc.dim(`${i + 1}.`)} ${pc.bold(r.title ?? "Untitled")}\n     ${r.chunk_text ?? ""}\n     ${pc.dim(`kb_node_id: ${r.kb_node_id ?? "unknown"}   content_id: ${r.content_id ?? "unknown"}`)}`,
            ),
            "",
          ],
        });
      }),
    );

  addSearchVariant(
    search,
    program,
    "context",
    "/org/search/context",
    "Search the knowledge base — returns matching content chunks only, without AI answer generation. Use this to feed verified chunks into your own LLM pipeline instead of using Senso's generated answer.",
  );

  addSearchVariant(
    search,
    program,
    "content",
    "/org/search/content",
    "Search the knowledge base — returns deduplicated matches with no chunks: each carries the KB node ID to read it with 'kb get <id>', and the content ID to scope a later search with --content-ids.",
    CONTENT_COLUMNS,
  );

  addSearchVariant(
    search,
    program,
    "full",
    "/org/search/full",
    "Alias for the default search — returns AI answer plus matching chunks. Equivalent to 'senso search <query>'.",
  );

  search
    .command("stream <query>")
    .description(
      "Streaming search — returns AI answer tokens in real-time via SSE, followed by source chunks. Use this for a responsive, live search experience.",
    )
    .option("--max-results <n>", `Maximum results (max: ${MAX_RESULTS_CEILING})`, "5")
    .option(
      "--content-ids <ids...>",
      "Restrict search to specific content item IDs (space-separated UUIDs)",
    )
    .option("--require-scoped-ids", "Only return results from the specified --content-ids")
    .option("--no-gap-signals", GAP_SIGNALS_HELP)
    .action(
      runAction(
        program,
        async (ctx: Ctx, query: string, _cmdOpts: SearchOptions, command: Command) => {
          const opts = resolveSearchOptions(command);
          const res = await apiStreamRequest({
            method: "POST",
            path: "/org/search/stream",
            body: buildSearchBody(query, opts),
            headers: gapSignalsHeaders(opts.gapSignals),
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
          });

          if (!res.body) {
            throw new CliError("The server returned no response body for the stream.", EXIT.ERROR);
          }

          await renderStream(ctx, res.body);
        },
      ),
    );
}

/**
 * Renders a server-sent-event stream.
 *
 * The token stream is the one place in this CLI where partial output on stdout
 * is the product rather than a leak, so tokens are written to stdout as they
 * arrive — but only in `plain`. Under `--output json` a half-written answer
 * would make the stream unparseable, so nothing is printed until the final
 * `sources` event carries the whole payload.
 */
async function renderStream(ctx: Ctx, body: ReadableStream<Uint8Array>): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const streamTokens = ctx.format === "plain";
  let buffer = "";
  let eventType: string | null = null;
  let answerStarted = false;
  let answer = "";
  let sources: unknown = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    // The last element is whatever came after the final newline: an incomplete
    // line that must be carried into the next chunk. A `data:` payload split
    // across a chunk boundary is normal, not an edge case.
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line.startsWith("event: ")) {
        eventType = line.slice(7).trim();
        continue;
      }
      if (!line.startsWith("data: ") || !eventType) continue;

      let payload: { token?: string; results?: unknown[]; error?: string };
      try {
        payload = JSON.parse(line.slice(6)) as typeof payload;
      } catch {
        // A malformed frame is the server's problem, not a reason to abandon an
        // answer that is otherwise arriving correctly.
        log.warn("Skipped an unparseable event from the stream.");
        eventType = null;
        continue;
      }

      switch (eventType) {
        case "token": {
          const token = payload.token ?? "";
          answer += token;
          if (streamTokens) {
            if (!answerStarted) {
              answerStarted = true;
              writeStdout(`\n  ${pc.bold("Answer:")} `);
            }
            writeStdout(token);
          }
          break;
        }

        case "sources": {
          sources = payload.results ?? [];
          if (streamTokens) {
            if (answerStarted) writeStdout("\n");
            renderSources(payload.results ?? []);
          }
          break;
        }

        case "error":
          throw new CliError(payload.error ?? "The search stream reported an error.", EXIT.ERROR);

        default:
          break;
      }
      eventType = null;
    }
  }

  // Emitted once, at the end, so the JSON caller gets one parseable document
  // containing everything the stream carried.
  if (ctx.format !== "plain") {
    emit(ctx, { answer, results: sources ?? [] }, { columns: RESULT_COLUMNS });
  }
}

function renderSources(results: unknown[]): void {
  writeStdout("\n");
  if (results.length === 0) {
    writeStdout(`  ${pc.dim("No sources found.")}\n\n`);
    return;
  }

  writeStdout(`  ${pc.bold("Sources:")} (${results.length})\n`);
  results.forEach((raw, i) => {
    const r = raw as SearchResult;
    writeStdout("\n");
    writeStdout(
      `  ${pc.dim(`${i + 1}.`)} ${pc.bold(r.title ?? "Untitled")} ${pc.dim(`(${r.kb_node_id ?? r.content_id ?? "unknown"})`)}\n`,
    );
    if (r.chunk_text) {
      writeStdout(`     ${pc.dim("Snippet:")} ${r.chunk_text}\n`);
    }
  });
  writeStdout("\n");
}
