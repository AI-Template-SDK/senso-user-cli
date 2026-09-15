/**
 * Search — five commands over the same request shape.
 *
 * Two things here are worth more than the code that implements them.
 *
 * The first is that a search is not free and not silent: an ANSWERING search
 * (`search`, `search full`, `search stream`) that finds nothing is filed in the
 * organization's gap report as an API search gap. A caller that never learns
 * that fills the gap report with its own probes. So an empty result says what
 * happened, in both formats, and names the escape hatch.
 *
 * The second is that a flag which is quietly replaced is worse than a flag that
 * is rejected. `--max-results 999` used to send 20 and `--max-results abc` used
 * to send 5 — a different search from the one that was asked for, reported as a
 * success. Every constrained input is now checked before the request.
 */

import { Command } from "commander";
import pc from "picocolors";
import { apiRequest, apiStreamRequest } from "../lib/api-client.js";
import { CliError, EXIT, usageError } from "../lib/errors.js";
import { GAP_SIGNALS_HEADER, gapSignalsHeaders } from "../lib/gap-signals.js";
import { apiExits, describeCommand } from "../lib/help.js";
import { parseIdList } from "../lib/id-arg.js";
import { parseIntFlag } from "../lib/enum-arg.js";
import { emit, writeStdout, type NextStep } from "../lib/output.js";
import { runAction, type Ctx } from "../lib/run-action.js";
import * as log from "../utils/logger.js";

const MAX_RESULTS_CEILING = 20;
const DEFAULT_MAX_RESULTS = 5;

/** The API rejects a longer query with a 400; exit 2 is cheaper and clearer. */
const MAX_QUERY_LENGTH = 2000;

/** The command that reads the gaps an unanswered search produces. */
const GAP_LIST_COMMAND = "senso gaps list --origin api_unanswered_question --status open";

/**
 * `--content-ids` takes content_id, not kb_node_id.
 *
 * The two id spaces are both UUIDs and neither the CLI nor the API used to say
 * which one was wanted: a kb_node_id here produces a search that simply matches
 * nothing, which reads exactly like a knowledge base with no answer in it.
 */
const CONTENT_ID_SPEC = {
  label: "--content-ids",
  type: "Content item",
  idField: "content_id",
  list: "senso search content <query>",
};

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

/**
 * The request body, with every constrained input checked first.
 *
 * Nothing is clamped or substituted. `--max-results 999` is a different search
 * from `--max-results 20`, and a caller who typed the first and silently got
 * the second has no way to notice.
 */
function buildSearchBody(query: string, cmdOpts: SearchOptions): Record<string, unknown> {
  const trimmed = query.trim();
  if (trimmed === "") {
    throw usageError("The search query is empty.", {
      field: "<query>",
      received: query,
      hint: 'Pass the question as one argument: senso search "how long do refunds take".',
    });
  }
  // Code points are exactly what the API counts (Go runes), so decomposing an
  // emoji here is the correct behavior rather than the bug the rule guards
  // against: it makes the CLI's bound the same bound as the server's.
  // eslint-disable-next-line @typescript-eslint/no-misused-spread
  const length = [...trimmed].length;
  if (length > MAX_QUERY_LENGTH) {
    throw usageError(
      `Query is ${String(length)} characters; the maximum is ${String(MAX_QUERY_LENGTH)}.`,
      {
        field: "<query>",
        received: `${String(length)} characters`,
        allowed: [`1-${String(MAX_QUERY_LENGTH)} characters`],
        hint: "Shorten the question, or search for the topic and read the documents with `senso kb get`.",
      },
    );
  }

  const contentIds = cmdOpts.contentIds
    ? parseIdList(cmdOpts.contentIds, CONTENT_ID_SPEC)
    : undefined;

  if (cmdOpts.requireScopedIds && (!contentIds || contentIds.length === 0)) {
    throw usageError("--require-scoped-ids needs --content-ids.", {
      field: "--require-scoped-ids",
      hint: 'Name the content items to scope to: senso search "q" --content-ids <content_id> --require-scoped-ids.',
    });
  }

  const body: Record<string, unknown> = {
    query: trimmed,
    max_results:
      parseIntFlag("--max-results", cmdOpts.maxResults, {
        min: 1,
        max: MAX_RESULTS_CEILING,
      }) ?? DEFAULT_MAX_RESULTS,
  };
  if (contentIds) body.content_ids = contentIds;
  if (cmdOpts.requireScopedIds) body.require_scoped_ids = true;
  return body;
}

interface SearchResult {
  content_id?: string;
  kb_node_id?: string;
  title?: string;
  chunk_text?: string;
  score?: number;
  chunk_index?: number;
  [key: string]: unknown;
}

interface SearchResponse {
  query?: string;
  search_type?: string;
  answer?: string;
  results?: SearchResult[];
  /** `search content` returns its hits under `contents` rather than `results`. */
  contents?: SearchResult[];
  total_results?: number;
  total?: number;
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
const RESULT_COLUMNS = ["kb_node_id", "content_id", "title", "score", "chunk_text"];

/** A content-item hit carries no chunk, so its table drops that column. */
const CONTENT_COLUMNS = ["kb_node_id", "content_id", "title"];

/** One table row: just the declared columns, in their declared order. */
function pickColumns(item: SearchResult, columns: string[]): Record<string, unknown> {
  return Object.fromEntries(columns.map((c) => [c, item[c]]));
}

/** Whether this request asked the API to leave the search out of the gaps. */
function signalsAreOff(headers: Record<string, string>): boolean {
  return headers[GAP_SIGNALS_HEADER] === "off";
}

/**
 * What to say about a search that found nothing.
 *
 * `warnings` rather than a stderr line, because under `--output json` stderr is
 * silent — and an agent reading only stdout is exactly the caller that needs to
 * know its question was just recorded as a gap.
 */
function emptyWarnings(answering: boolean, signalsOff: boolean): string[] {
  if (!answering) {
    return [
      "No results. Only an answering search (`search`, `search full`, `search stream`) is filed as a gap; this one was not.",
    ];
  }
  return signalsOff
    ? ["No results. This search was NOT filed as a gap, because gap signals are off for it."]
    : [
        "No results. This search was filed as an API search gap; pass --no-gap-signals on probes, tests and monitors.",
      ];
}

/** The follow-ups an empty answering search deserves. */
function emptyNext(answering: boolean, signalsOff: boolean): NextStep[] {
  const steps: NextStep[] = [
    { why: "See what is in the knowledge base", command: "senso kb my-files" },
  ];
  if (answering && !signalsOff) {
    steps.unshift({ why: "Review the gap this search filed", command: GAP_LIST_COMMAND });
  }
  return steps;
}

/** `senso kb get <id>` for the best hit — the id space `kb` commands take. */
function resultNext(items: SearchResult[]): NextStep[] {
  const first = items.find((i) => typeof i.kb_node_id === "string" && i.kb_node_id !== "");
  if (!first?.kb_node_id) return [];
  return [
    {
      why: "Read the source document (kb_node_id, not content_id)",
      command: `senso kb get ${first.kb_node_id}`,
    },
  ];
}

/**
 * One hit as plain text: the ranking signal on the header line, then the
 * passage, then both ids labeled.
 *
 * The labels are the point. The unlabeled id in parentheses this used to print
 * was sometimes a kb_node_id and sometimes a content_id, and a caller cannot
 * tell them apart by looking.
 */
function resultLines(item: SearchResult, index: number): string {
  const header = [`${pc.dim(`${String(index + 1)}.`)} ${pc.bold(item.title ?? "Untitled")}`];
  if (typeof item.score === "number") header.push(pc.dim(`score ${item.score.toFixed(2)}`));
  if (typeof item.chunk_index === "number")
    header.push(pc.dim(`chunk ${String(item.chunk_index)}`));

  const lines = [`  ${header.join("   ")}`];
  if (item.chunk_text) lines.push(`     ${item.chunk_text}`);
  lines.push(`     ${pc.dim("kb_node_id")}  ${item.kb_node_id ?? pc.dim("unknown")}`);
  lines.push(`     ${pc.dim("content_id")}  ${item.content_id ?? pc.dim("unknown")}`);
  return lines.join("\n");
}

/** The plain rendering shared by every non-streaming variant. */
function plainSearch(query: string, answer: string | undefined, items: SearchResult[]): string[] {
  if (items.length === 0 && !answer) {
    // Never a payload made only of blank lines, which is what this printed
    // before: an agent saw exit 0 and an empty stdout and had nothing to read.
    return ["", `  No results for ${JSON.stringify(query)}.`, ""];
  }
  return [
    "",
    ...(answer ? [`  ${pc.bold("Answer:")} ${answer}`, ""] : []),
    ...items.map((item, i) => resultLines(item, i)),
    "",
  ];
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

/** The four options every search command declares, in the same words. */
function addSearchOptions(cmd: Command): Command {
  return cmd
    .option(
      "--max-results <n>",
      `How many results to return. Integer 1-${String(MAX_RESULTS_CEILING)}; out of range exits 2, nothing is clamped`,
      String(DEFAULT_MAX_RESULTS),
    )
    .option(
      "--content-ids <ids...>",
      "Restrict the search to these content items. Space-separated content_id UUIDs from a previous result — NOT kb_node_ids",
    )
    .option(
      "--require-scoped-ids",
      "Fail rather than fall back to the whole knowledge base. Requires --content-ids",
    )
    .option("--no-gap-signals", GAP_SIGNALS_HELP);
}

/** The Returns lines every chunk-returning variant shares. */
const CHUNK_RETURNS = [
  "results[].kb_node_id — the document's KB node; read it with `senso kb get <kb_node_id>`",
  "results[].content_id — the content item; the ONLY id `--content-ids` accepts. Not interchangeable with kb_node_id: `senso content get` serves non-KB content and answers 400 for knowledge base content",
  "results[].title — the document title (the file name, for uploads)",
  "results[].chunk_text — the matched passage; chunk_index is its position in the document",
  "results[].score — relevance on search_type's scale (rerank for hybrid, cosine for vector, BM25 for lexical); comparable within one response only",
  "results[].version_id — the content version the chunk came from",
  "results[].source_type — file | raw | web",
  "search_type — hybrid | lexical | vector",
  "total_results — 0 means nothing matched",
];

const SEARCH_EXITS: Record<number, string> = {
  ...apiExits,
  2: "--max-results outside 1-20 or not an integer; --require-scoped-ids without --content-ids; a --content-ids value that is not a UUID; an empty query or one over 2000 characters; SENSO_GAP_SIGNALS set to a value that is neither on nor off",
  3: "no API key, the key was rejected, or no knowledge base folder is shared with it (403 'No KB scope configured') — an org admin must share one",
};

/**
 * Registers one of the non-streaming search variants.
 *
 * `context`, `content` and `full` differ only in their endpoint and what they
 * return, so they are declared once here rather than copied three times — which
 * is how `full` came to be documented as "equivalent to senso search" while
 * dropping the answer, the one thing that endpoint exists to produce.
 */
function addSearchVariant(
  parent: Command,
  program: Command,
  name: string,
  path: string,
  description: string,
  opts: { columns?: string[]; answering: boolean },
): Command {
  const columns = opts.columns ?? RESULT_COLUMNS;
  return addSearchOptions(
    parent
      // The argument is declared through `.argument()` rather than in the
      // command string so it can carry its own help line; declaring it in both
      // places would register two required arguments.
      .command(name)
      .description(description)
      .argument("<query>", "The question, in natural language. 1-2000 characters"),
  ).action(
    runAction(
      program,
      async (ctx: Ctx, query: string, _cmdOpts: SearchOptions, command: Command) => {
        const resolved = resolveSearchOptions(command);
        const headers = gapSignalsHeaders(resolved.gapSignals);
        const data = await apiRequest<SearchResponse>({
          method: "POST",
          path,
          body: buildSearchBody(query, resolved),
          headers,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        // Explicit rows rather than letting `emit` find the list: a search
        // payload carries `query` and `search_type` beside its hits, and
        // findRows deliberately refuses anything that is not a list plus
        // pagination metadata — so without this the variants rendered their
        // whole response as one key/value blob under `--output table`.
        const items = data.results ?? data.contents ?? [];
        const empty = items.length === 0;
        emit(ctx, data, {
          table: { rows: items.map((item) => pickColumns(item, columns)), columns },
          plain: plainSearch(query, data.answer, items),
          warnings: empty ? emptyWarnings(opts.answering, signalsAreOff(headers)) : [],
          next: empty ? emptyNext(opts.answering, signalsAreOff(headers)) : resultNext(items),
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
    )
    .addHelpText(
      "after",
      [
        "",
        "The variants:",
        "  senso search <query>          answer + chunks (same call as `search full`)",
        "  senso search full <query>     answer + chunks",
        "  senso search context <query>  chunks only, for your own LLM pipeline",
        "  senso search content <query>  one row per document, no chunks, no answer",
        "  senso search stream <query>   answer tokens over SSE, then the chunks",
        "",
        "The two id spaces:",
        "  kb_node_id  addresses the knowledge base tree — `senso kb get <kb_node_id>` reads a source",
        "  content_id  addresses a stored document — the only id `--content-ids` takes",
        "  They are both UUIDs and they are NOT interchangeable: `senso content get` serves",
        "  generated (non-KB) content and answers 400 for anything in the knowledge base.",
        "",
        "Workflow:",
        '  1. senso search content "topic"        which documents cover it',
        "  2. senso kb get <kb_node_id>          read one of them",
        '  3. senso search "question" --content-ids <content_id>   ask, scoped to them',
        "",
        "Every variant costs credits and records a search turn.",
      ].join("\n"),
    );

  // Default: senso search <query> → POST /org/search (answer + results)
  describeCommand(
    addSearchOptions(
      search.argument("<query>", "The question, in natural language. 1-2000 characters"),
    ).action(
      runAction(program, async (ctx: Ctx, query: string, cmdOpts: SearchOptions) => {
        const headers = gapSignalsHeaders(cmdOpts.gapSignals);
        const data = await apiRequest<SearchResponse>({
          method: "POST",
          path: "/org/search",
          body: buildSearchBody(query, cmdOpts),
          headers,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });

        const results = data.results ?? [];
        const empty = results.length === 0;
        emit(ctx, data, {
          table: {
            rows: results.map((r) => pickColumns(r, RESULT_COLUMNS)),
            columns: RESULT_COLUMNS,
          },
          plain: plainSearch(query, data.answer, results),
          warnings: empty ? emptyWarnings(true, signalsAreOff(headers)) : [],
          next: empty ? emptyNext(true, signalsAreOff(headers)) : resultNext(results),
        });
      }),
    ),
    {
      returns: ['answer — the generated answer; "" when nothing matched', ...CHUNK_RETURNS],
      exitCodes: SEARCH_EXITS,
      notes: [
        "Costs credits and records a search turn.",
        "Finding nothing is exit 0, not a failure: check total_results (or results.length).",
        "An answering search that finds nothing is filed as an API search gap unless --no-gap-signals is given.",
      ],
      examples: [
        { comment: "Ask a question", command: 'senso search "how long do refunds take"' },
        {
          comment: "Just the answer",
          command: "senso search \"how long do refunds take\" --output json | jq -r '.data.answer'",
        },
        {
          comment: "The documents behind the answer",
          command:
            "senso search \"how long do refunds take\" --output json | jq -r '.data.results[].kb_node_id'",
        },
        {
          comment: "A probe that must not become a gap",
          command: 'senso search "onboarding probe" --no-gap-signals --max-results 1',
        },
      ],
      seeAlso: [
        "senso search content <query>",
        "senso search context <query>",
        "senso kb get <kb_node_id>",
        GAP_LIST_COMMAND,
      ],
    },
  );

  describeCommand(
    addSearchVariant(
      search,
      program,
      "context",
      "/org/search/context",
      "Search the knowledge base — returns matching content chunks only, without AI answer generation. Use this to feed verified chunks into your own LLM pipeline instead of using Senso's generated answer.",
      { answering: false },
    ),
    {
      returns: CHUNK_RETURNS,
      exitCodes: SEARCH_EXITS,
      notes: [
        "Costs credits and records a search turn, but is NEVER filed as a gap — only answering searches are.",
        "Chunks come back best-first, by score.",
      ],
      examples: [
        {
          comment: "Feed the passages to your own model",
          command:
            "senso search context \"refund window\" --output json | jq -r '.data.results[].chunk_text'",
        },
      ],
      seeAlso: ["senso search <query>", "senso kb get <kb_node_id>"],
    },
  );

  describeCommand(
    addSearchVariant(
      search,
      program,
      "content",
      "/org/search/content",
      "Search the knowledge base — returns deduplicated matches with no chunks: each carries the KB node ID to read it with 'kb get <id>', and the content ID to scope a later search with --content-ids.",
      { columns: CONTENT_COLUMNS, answering: false },
    ),
    {
      returns: [
        "contents[] — one entry per matching DOCUMENT, not per chunk (note the key: `contents`, not `results`)",
        "contents[].kb_node_id — read the document with `senso kb get <kb_node_id>`",
        "contents[].content_id — pass to `--content-ids` on a later search",
        "contents[].title — the document title",
        "total — how many documents matched (note the key: `total`, not `total_results`)",
        "search_type — hybrid | lexical | vector",
      ],
      exitCodes: SEARCH_EXITS,
      notes: [
        "--max-results bounds DOCUMENTS here, not chunks.",
        "Costs credits and records a search turn; never filed as a gap.",
      ],
      examples: [
        {
          comment: "Which documents cover this topic",
          command:
            "senso search content \"refund policy\" --output json | jq -r '.data.contents[].kb_node_id'",
        },
      ],
      seeAlso: ["senso kb get <kb_node_id>", "senso search <query>"],
    },
  );

  describeCommand(
    addSearchVariant(
      search,
      program,
      "full",
      "/org/search/full",
      "Alias for the default search — returns AI answer plus matching chunks. Equivalent to 'senso search <query>', and renders identically.",
      { answering: true },
    ),
    {
      returns: ['answer — the generated answer; "" when nothing matched', ...CHUNK_RETURNS],
      exitCodes: SEARCH_EXITS,
      notes: [
        "Same request, same response and same rendering as `senso search <query>`.",
        "Costs credits, records a turn, and files an API search gap when it finds nothing unless --no-gap-signals is given.",
      ],
      examples: [{ command: 'senso search full "how long do refunds take"' }],
      seeAlso: ["senso search <query>", GAP_LIST_COMMAND],
    },
  );

  describeCommand(
    addSearchOptions(
      search
        .command("stream")
        .description(
          "Streaming search — returns AI answer tokens in real-time via SSE, followed by source chunks. Use this for a responsive, live search experience.",
        )
        .argument("<query>", "The question, in natural language. 1-2000 characters"),
    ).action(
      runAction(
        program,
        async (ctx: Ctx, query: string, _cmdOpts: SearchOptions, command: Command) => {
          const opts = resolveSearchOptions(command);
          const headers = gapSignalsHeaders(opts.gapSignals);
          const res = await apiStreamRequest({
            method: "POST",
            path: "/org/search/stream",
            body: buildSearchBody(query, opts),
            headers,
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
          });

          if (!res.body) {
            throw new CliError("The server returned no response body for the stream.", EXIT.ERROR);
          }

          await renderStream(ctx, res.body, query, signalsAreOff(headers));
        },
      ),
    ),
    {
      returns: [
        'answer — the tokens, assembled; "" when nothing matched',
        ...CHUNK_RETURNS,
        "max_results — the bound the API applied",
      ],
      exitCodes: {
        ...SEARCH_EXITS,
        1: "the stream carried an `error` event, or the server sent no body",
      },
      notes: [
        "In plain output the answer is written to stdout token by token, then the sources.",
        "Under --output json or --output table nothing is printed until the stream ends: a half-written answer would not parse. 'Real-time' applies to plain only.",
        "An error event after tokens have been written exits 1 with partial output already on stdout.",
        "Costs credits, records a turn, and files an API search gap when it finds nothing unless --no-gap-signals is given.",
      ],
      examples: [
        {
          comment: "Watch the answer arrive",
          command: 'senso search stream "how do refunds work"',
        },
      ],
      seeAlso: ["senso search <query>", GAP_LIST_COMMAND],
    },
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
async function renderStream(
  ctx: Ctx,
  body: ReadableStream<Uint8Array>,
  query: string,
  signalsOff: boolean,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const streamTokens = ctx.format === "plain";
  let buffer = "";
  let eventType: string | null = null;
  let answerStarted = false;
  let answer = "";
  let sources: SearchResult[] | null = null;
  // Carried out of the `sources` event so the JSON document describes the same
  // search the API described, rather than the two fields the CLI happened to
  // keep.
  let searchType: string | undefined;
  let totalResults: number | undefined;
  let maxResults: number | undefined;

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

      let payload: {
        token?: string;
        results?: SearchResult[];
        error?: string;
        search_type?: string;
        total_results?: number;
        max_results?: number;
      };
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
          searchType = payload.search_type;
          totalResults = payload.total_results;
          maxResults = payload.max_results;
          if (streamTokens) {
            if (answerStarted) writeStdout("\n");
            renderSources(sources, query);
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

  const items = sources ?? [];
  const empty = items.length === 0;

  // The gap notice belongs on stderr in plain mode, where the JSON envelope's
  // `warnings` cannot reach anyone.
  if (streamTokens && empty && !ctx.quiet) {
    for (const warning of emptyWarnings(true, signalsOff)) log.warn(warning);
    for (const step of emptyNext(true, signalsOff)) log.hint(`${step.why}: ${step.command}`);
  }

  // Emitted once, at the end, so the JSON caller gets one parseable document
  // containing everything the stream carried.
  if (ctx.format !== "plain") {
    emit(
      ctx,
      {
        query,
        ...(searchType === undefined ? {} : { search_type: searchType }),
        answer,
        results: items,
        ...(totalResults === undefined ? {} : { total_results: totalResults }),
        ...(maxResults === undefined ? {} : { max_results: maxResults }),
      },
      {
        table: { rows: items.map((item) => pickColumns(item, RESULT_COLUMNS)) },
        columns: RESULT_COLUMNS,
        warnings: empty ? emptyWarnings(true, signalsOff) : [],
        next: empty ? emptyNext(true, signalsOff) : resultNext(items),
      },
    );
  }
}

function renderSources(results: SearchResult[], query: string): void {
  writeStdout("\n");
  if (results.length === 0) {
    writeStdout(`  No results for ${JSON.stringify(query)}.\n\n`);
    return;
  }

  writeStdout(`  ${pc.bold("Sources:")} (${String(results.length)})\n`);
  results.forEach((r, i) => {
    writeStdout("\n");
    writeStdout(`${resultLines(r, i)}\n`);
  });
  writeStdout("\n");
}
