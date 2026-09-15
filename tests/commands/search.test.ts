/**
 * Command layer: `senso search`, and its four siblings.
 *
 * Two very different things share this file, and the second is the reason it is
 * long.
 *
 * The plain half is five POST bodies. `search`, `search context`, `search
 * content`, `search full` and `search stream` all send the same shape to five
 * different endpoints, and every constrained input is now CHECKED rather than
 * substituted: `--max-results 999` used to send 20 and `--max-results abc` used
 * to send 5, a different search from the one that was asked for, reported as a
 * success. So the assertions that earn their place are the ones on the request,
 * and on the exit 2 that replaces a silent substitution.
 *
 * The other thing worth protecting is a search that finds nothing. It is not
 * free and not silent: an answering search that finds nothing is filed in the
 * organization's gap report, and a caller that never learns that fills the
 * report with its own probes. So an empty result says so on stdout instead of
 * printing blank lines, and says what was filed — in `warnings` and `next` as
 * well, because `--output json` silences stderr. A
 * renamed field here silently changes what the API searches, and nothing in the
 * rendering would show it. Writing those assertions is how an option collision
 * came to light: the four subcommands declare the same option names as their
 * parent `search`, and Commander bound the value to the parent, so every option
 * typed on a subcommand was accepted and then replaced by its default. The
 * subcommands now resolve each option against whichever command carries the
 * user's value, and the tests below hold them to it.
 *
 * The interesting half is `search stream`, the only command that parses a
 * server-sent-event stream and the only one where partial output on stdout is
 * the product rather than a leak. Four things are worth protecting:
 *
 *   - a `data:` line split across two chunks. This is normal on any real
 *     network, and it is exactly what a naive `chunk.split("\n")` parser drops
 *     or mangles;
 *   - an `error` event, which must become a CliError with an exit code rather
 *     than a silently truncated answer;
 *   - an unparseable frame, which must cost a warning and not the answer;
 *   - `--output json`, where a half-written answer on stdout would make the
 *     whole document unparseable — so nothing is printed until the end.
 */

import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server, TEST_API_KEY } from "../setup.js";
import { apiUrl, envelope, errorEnvelope, runCli } from "../helpers.js";

/**
 * content_id and kb_node_id, as the API sends them: two different UUIDs.
 *
 * The fixtures below used to say `content_id: "c-1"` and carry no kb_node_id at
 * all, which meant the table asserted a column the API never omits and no test
 * could catch a command that confused the two id spaces.
 */
const CONTENT_ID_1 = "11111111-1111-4111-8111-111111111111";
const CONTENT_ID_2 = "22222222-2222-4222-8222-222222222222";
const KB_NODE_ID_1 = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const KB_NODE_ID_2 = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";

/** dto.SearchResultChunk, every field the API populates on a hybrid response. */
const RESULTS = [
  {
    content_chunk_id: "cccccccc-1111-4111-8111-cccccccccccc",
    content_id: CONTENT_ID_1,
    kb_node_id: KB_NODE_ID_1,
    version_id: "dddddddd-1111-4111-8111-dddddddddddd",
    chunk_index: 0,
    chunk_text: "Refunds are issued within 14 days.",
    score: 0.91,
    rank: 1,
    title: "Refund policy",
    source_type: "file",
    content_type: "application/pdf",
  },
  {
    content_chunk_id: "cccccccc-2222-4222-8222-cccccccccccc",
    content_id: CONTENT_ID_2,
    kb_node_id: KB_NODE_ID_2,
    version_id: "dddddddd-2222-4222-8222-dddddddddddd",
    chunk_index: 3,
    chunk_text: "Items must be unopened.",
    score: 0.64,
    rank: 2,
    title: "Returns",
    source_type: "file",
    content_type: "text/markdown",
  },
];

const QUERY = "how do refunds work";

/** dto.SearchResponse. */
const ANSWER_PAYLOAD = {
  query: QUERY,
  search_type: "hybrid",
  answer: "Refunds take 14 days.",
  results: RESULTS,
  total_results: RESULTS.length,
  max_results: 5,
  processing_time_ms: 412,
};

/** dto.SearchResponse with nothing matched — the shape that becomes a gap. */
const EMPTY_PAYLOAD = {
  query: QUERY,
  search_type: "hybrid",
  answer: "",
  results: [],
  total_results: 0,
  max_results: 5,
  processing_time_ms: 88,
};

/** What a search request looked like, filled in by the handler. */
interface SeenRequest {
  method?: string;
  path?: string;
  body?: Record<string, unknown>;
  headers?: Headers;
}

/** Answers one search endpoint and records what was asked of it. */
function captureSearch(
  path: string,
  response: Record<string, unknown> = ANSWER_PAYLOAD,
): SeenRequest {
  const seen: SeenRequest = {};
  server.use(
    http.post(apiUrl(path), async ({ request }) => {
      seen.method = request.method;
      seen.path = new URL(request.url).pathname;
      seen.headers = request.headers;
      seen.body = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json(response);
    }),
  );
  return seen;
}

/**
 * A response whose body arrives in the chunks given, one per read.
 *
 * `pull` rather than a loop in `start`: enqueuing everything up front lets the
 * runtime hand the whole body over in a single read, which would make the
 * split-across-chunks test below pass without ever testing a split.
 */
function sseStream(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const pending = [...chunks];

  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = pending.shift();
      if (next === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(next));
    },
  });

  return new HttpResponse(body, {
    headers: { "Content-Type": "text/event-stream" },
  });
}

/** One well-formed SSE frame. */
const frame = (event: string, data: unknown): string =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/**
 * The `sources` event as the API actually sends it.
 *
 * Not only the chunks: search_handler.go puts search_type, total_results and
 * max_results in the same frame, and they are the fields that tell a caller
 * which scale `score` is on and what bound the server applied.
 */
const sourcesFrame = (results: typeof RESULTS = []): string =>
  frame("sources", {
    results,
    total_results: results.length,
    max_results: 5,
    search_type: "hybrid",
  });

/** Registers the stream endpoint, and hands back what the request looked like. */
function captureStream(chunks: string[]): SeenRequest {
  const seen: SeenRequest = {};
  server.use(
    http.post(apiUrl("/org/search/stream"), async ({ request }) => {
      seen.method = request.method;
      seen.path = new URL(request.url).pathname;
      seen.headers = request.headers;
      seen.body = (await request.json()) as Record<string, unknown>;
      return sseStream(chunks);
    }),
  );
  return seen;
}

/**
 * Streamed stdout as the terminal would show it.
 *
 * Tokens reach stdout through `writeStdout`, one call per token, and the test
 * harness records each call separately — so the answer a user sees as one line
 * is several entries here. Joining them back is what lets a test assert on the
 * answer rather than on the arrival schedule.
 */
const streamed = (stdout: string): string => stdout.replace(/\n/g, "");

describe("search, when the request fails", () => {
  it("exits 3 and explains how to authenticate when there is no API key", async () => {
    const res = await runCli(["search", QUERY], { withKey: false });

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("no API key found");
    expect(res.stderr).toContain("SENSO_API_KEY");
  });

  it("exits 3 when the API rejects the key", async () => {
    server.use(
      http.post(apiUrl("/org/search"), () =>
        HttpResponse.json({ error: "invalid key" }, { status: 401 }),
      ),
    );

    const res = await runCli(["search", QUERY]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Authentication failed");
  });

  it("exits 4 on a 404", async () => {
    server.use(http.post(apiUrl("/org/search"), () => new HttpResponse(null, { status: 404 })));

    const res = await runCli(["search", QUERY]);

    expect(res.exitCode).toBe(4);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Not found");
  });

  it("exits 1 on a 500 and says it is not the caller's fault", async () => {
    server.use(http.post(apiUrl("/org/search"), () => new HttpResponse(null, { status: 500 })));

    const res = await runCli(["search", QUERY]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("server-side failure");
  });

  it("exits 5 when the search is rate limited", async () => {
    // Retrying is the right reaction, which is why this is a network code and
    // not an error code.
    server.use(http.post(apiUrl("/org/search"), () => new HttpResponse(null, { status: 429 })));

    const res = await runCli(["search", QUERY]);

    expect(res.exitCode).toBe(5);
    expect(res.stderr).toContain("Rate limited");
  });

  it("writes the failure to stderr as JSON, leaving stdout empty, under --output json", async () => {
    server.use(
      http.post(apiUrl("/org/search"), () => HttpResponse.json({ error: "nope" }, { status: 403 })),
    );

    const res = await runCli(["search", QUERY, "--output", "json"]);

    expect(res.exitCode).toBe(3);
    // A caller redirecting stdout to a file gets an empty file, not a file
    // containing an error object it would later read as data.
    expect(res.stdout).toBe("");
    expect(JSON.parse(res.stderr)).toMatchObject({
      error: { code: "forbidden", status: 403 },
    });
  });
});

describe("search, on the wire", () => {
  it("posts the query to /org/search with the default result count", async () => {
    const seen = captureSearch("/org/search");

    await runCli(["search", QUERY]);

    expect(seen.method).toBe("POST");
    expect(seen.path).toBe("/api/v1/org/search");
    expect(seen.body).toEqual({ query: QUERY, max_results: 5 });
    expect(seen.headers?.get("x-api-key")).toBe(TEST_API_KEY);
    expect(seen.headers?.get("content-type")).toBe("application/json");
  });

  it("sends the count the caller asked for", async () => {
    const seen = captureSearch("/org/search");

    await runCli(["search", QUERY, "--max-results", "12"]);

    expect(seen.body).toMatchObject({ max_results: 12 });
  });

  it("exits 2 rather than sending 20 when --max-results is above the ceiling", async () => {
    // The regression this pins: 999 used to be clamped to 20 and reported as a
    // success, so a caller who asked for a different search than the one that
    // ran had no way to notice. A rejected flag is recoverable; a substituted
    // one is not.
    const seen = captureSearch("/org/search");

    const res = await runCli(["search", QUERY, "--max-results", "999"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("--max-results");
    expect(seen.method).toBeUndefined();
  });

  it("names the flag and the range in the JSON error for an oversized count", async () => {
    captureSearch("/org/search");

    const res = await runCli(["search", QUERY, "--max-results", "999", "--output", "json"]);

    expect(res.exitCode).toBe(2);
    expect(errorEnvelope(res).error).toMatchObject({
      code: "usage",
      field: "--max-results",
      received: "999",
    });
  });

  it("exits 2 rather than sending 5 when --max-results is not a whole number", async () => {
    const seen = captureSearch("/org/search");

    const res = await runCli(["search", QUERY, "--max-results", "abc", "--output", "json"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(errorEnvelope(res).error).toMatchObject({ field: "--max-results", received: "abc" });
    expect(seen.method).toBeUndefined();
  });

  it("exits 2 rather than quietly turning a request for zero results into five", async () => {
    const seen = captureSearch("/org/search");

    const res = await runCli(["search", QUERY, "--max-results", "0"]);

    expect(res.exitCode).toBe(2);
    expect(seen.method).toBeUndefined();
  });

  it("exits 2 when a --content-ids value is not a UUID, before any request", async () => {
    const seen = captureSearch("/org/search");

    const res = await runCli(["search", QUERY, "--content-ids", "c-1", "--output", "json"]);

    expect(res.exitCode).toBe(2);
    expect(errorEnvelope(res).error).toMatchObject({ field: "--content-ids", received: "c-1" });
    expect(seen.method).toBeUndefined();
  });

  it("exits 2 when --require-scoped-ids is passed without --content-ids", async () => {
    const seen = captureSearch("/org/search");

    const res = await runCli(["search", QUERY, "--require-scoped-ids"]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("--content-ids");
    expect(seen.method).toBeUndefined();
  });

  it("scopes the search to the content IDs it was given", async () => {
    const seen = captureSearch("/org/search");

    await runCli(["search", QUERY, "--content-ids", CONTENT_ID_1, CONTENT_ID_2]);

    expect(seen.body).toMatchObject({ content_ids: [CONTENT_ID_1, CONTENT_ID_2] });
  });

  it("sends require_scoped_ids only when the flag is present", async () => {
    const withoutFlag = captureSearch("/org/search");
    await runCli(["search", QUERY, "--content-ids", CONTENT_ID_1]);
    expect(withoutFlag.body).not.toHaveProperty("require_scoped_ids");

    const withFlag = captureSearch("/org/search");
    await runCli(["search", QUERY, "--content-ids", CONTENT_ID_1, "--require-scoped-ids"]);
    expect(withFlag.body).toMatchObject({ require_scoped_ids: true });
  });

  it("omits content_ids entirely when none were named", async () => {
    const seen = captureSearch("/org/search");

    await runCli(["search", QUERY]);

    expect(seen.body).not.toHaveProperty("content_ids");
  });
});

describe("the three search variants, on the wire", () => {
  // Same options, same body, four endpoints. The endpoint is the whole
  // difference between them, so it is what gets asserted.
  const variants: { name: string; path: string }[] = [
    { name: "context", path: "/org/search/context" },
    { name: "content", path: "/org/search/content" },
    { name: "full", path: "/org/search/full" },
  ];

  for (const { name, path } of variants) {
    it(`posts to ${path} for search ${name}`, async () => {
      const seen = captureSearch(path);

      const res = await runCli(["search", name, QUERY]);

      expect(res.exitCode).toBe(0);
      expect(seen.method).toBe("POST");
      expect(seen.path).toBe(`/api/v1${path}`);
      expect(seen.body).toEqual({ query: QUERY, max_results: 5 });
    });

    it(`applies --max-results on search ${name}`, async () => {
      // The subcommand and its parent `search` declare the same flag names, so
      // the value has to be read off whichever command the user set it on —
      // and the ceiling still applies once it has been found.
      const seen = captureSearch(path);

      await runCli(["search", name, QUERY, "--max-results", "17"]);

      expect(seen.body).toMatchObject({ max_results: 17 });
    });

    it(`exits 2 for an out-of-range --max-results on search ${name}`, async () => {
      // Resolving the option off the parent is only half the fix: the value it
      // finds has to be validated too, or the subcommands go back to clamping.
      const seen = captureSearch(path);

      const res = await runCli(["search", name, QUERY, "--max-results", "99"]);

      expect(res.exitCode).toBe(2);
      expect(seen.method).toBeUndefined();
    });

    it(`applies the scoping options on search ${name}`, async () => {
      // A caller who scoped a search to two documents must get a search over
      // those two documents, not over the whole knowledge base.
      const seen = captureSearch(path);

      await runCli([
        "search",
        name,
        QUERY,
        "--content-ids",
        CONTENT_ID_1,
        CONTENT_ID_2,
        "--require-scoped-ids",
      ]);

      expect(seen.body).toMatchObject({
        content_ids: [CONTENT_ID_1, CONTENT_ID_2],
        require_scoped_ids: true,
      });
    });
  }

  it("exits 3 for a variant when the key is rejected", async () => {
    server.use(
      http.post(apiUrl("/org/search/context"), () => new HttpResponse(null, { status: 401 })),
    );

    const res = await runCli(["search", "context", QUERY]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
  });
});

describe("search, on success", () => {
  it("prints the payload unmodified under --output json", async () => {
    captureSearch("/org/search");

    const res = await runCli(["search", QUERY, "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toEqual(ANSWER_PAYLOAD);
    expect(res.stderr).toBe("");
  });

  it("leads with the answer, then the sources, in plain", async () => {
    captureSearch("/org/search");

    const res = await runCli(["search", QUERY]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Answer:");
    expect(res.stdout).toContain(ANSWER_PAYLOAD.answer);
    expect(res.stdout).toContain("Refund policy");
  });

  it("labels both ids on every hit, because they are not interchangeable", async () => {
    // An unlabeled id in parentheses was sometimes a kb_node_id and sometimes a
    // content_id, and `senso kb get <content_id>` is a 404 with no explanation.
    captureSearch("/org/search");

    const res = await runCli(["search", QUERY]);

    expect(res.stdout).toContain(`kb_node_id  ${KB_NODE_ID_1}`);
    expect(res.stdout).toContain(`content_id  ${CONTENT_ID_1}`);
  });

  it("points at the best hit's kb_node_id, not its content_id, in next", async () => {
    captureSearch("/org/search");

    const res = await runCli(["search", QUERY, "--output", "json"]);

    expect(envelope(res).next).toEqual([
      expect.objectContaining({ command: `senso kb get ${KB_NODE_ID_1}` }),
    ]);
  });

  it("renders one row per result under --output table", async () => {
    captureSearch("/org/search");

    const res = await runCli(["search", QUERY, "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("kb_node_id");
    expect(res.stdout).toContain("content_id");
    expect(res.stdout).toContain("title");
    expect(res.stdout).toContain("Returns");
    // Every declared column exists on every row, so nothing warns about a
    // column the API "did not return".
    expect(res.stderr).not.toContain("did not return");
  });

  it("copes with an answer and no results", async () => {
    captureSearch("/org/search", { ...EMPTY_PAYLOAD, answer: "Nothing matched." });

    const res = await runCli(["search", QUERY]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Nothing matched.");
  });

  it("renders a variant's chunks without an answer", async () => {
    captureSearch("/org/search/context", {
      query: QUERY,
      search_type: "hybrid",
      results: RESULTS,
      total_results: RESULTS.length,
      max_results: 5,
    });

    const res = await runCli(["search", "context", QUERY]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Refund policy");
  });

  it("renders search content's `contents` key, which is not `results`", async () => {
    // dto.SearchContentResponse puts the hits under `contents` and the count
    // under `total`. A renderer that only knows `results` prints the whole
    // response as one key/value blob.
    captureSearch("/org/search/content", {
      query: QUERY,
      search_type: "hybrid",
      contents: [
        { content_id: CONTENT_ID_1, kb_node_id: KB_NODE_ID_1, title: "Refund policy" },
        { content_id: CONTENT_ID_2, kb_node_id: KB_NODE_ID_2, title: "Returns" },
      ],
      total: 2,
    });

    const res = await runCli(["search", "content", QUERY, "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain(KB_NODE_ID_1);
    expect(res.stdout).toContain("Returns");
    expect(res.stderr).not.toContain("did not return");
  });
});

/**
 * A search that finds nothing.
 *
 * This is the case that used to print a payload made only of blank lines: exit
 * 0, an empty-looking stdout, and no word anywhere that the question had just
 * been filed in the organization's gap report. An agent that cannot see that
 * fills the report with its own probes.
 */
describe("search, when nothing matched", () => {
  it("says so on stdout rather than printing blank lines", async () => {
    captureSearch("/org/search", EMPTY_PAYLOAD);

    const res = await runCli(["search", QUERY]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain(`No results for ${JSON.stringify(QUERY)}.`);
  });

  it("says on stderr that the search was recorded as a gap, and where to read it", async () => {
    captureSearch("/org/search", EMPTY_PAYLOAD);

    const res = await runCli(["search", QUERY]);

    expect(res.stderr).toContain("filed as an API search gap");
    expect(res.stderr).toContain("senso gaps list --origin api_unanswered_question");
  });

  it("carries the gap notice in warnings and next under --output json", async () => {
    // `--output json` implies `--quiet`, so the stderr sentence above reaches
    // nobody. Every published Senso skill passes this flag.
    captureSearch("/org/search", EMPTY_PAYLOAD);

    const res = await runCli(["search", QUERY, "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.stderr).toBe("");
    const env = envelope(res);
    expect(env.warnings?.join(" ")).toContain("filed as an API search gap");
    expect(env.next).toContainEqual(
      expect.objectContaining({ command: expect.stringContaining("senso gaps list") as string }),
    );
  });

  it("says the search was NOT filed when gap signals were turned off", async () => {
    // The opposite fact is just as important: a caller who passed
    // --no-gap-signals must not go looking for a gap that was never created.
    captureSearch("/org/search", EMPTY_PAYLOAD);

    const res = await runCli(["search", QUERY, "--no-gap-signals", "--output", "json"]);

    const env = envelope(res);
    expect(env.warnings?.join(" ")).toContain("NOT filed as a gap");
    expect(env.next).not.toContainEqual(
      expect.objectContaining({ command: expect.stringContaining("senso gaps list") as string }),
    );
  });

  it("says a non-answering variant is never filed at all", async () => {
    // `search context` and `search content` cost credits but produce no gap, so
    // an empty one must not send the caller to the gap report.
    captureSearch("/org/search/context", {
      query: QUERY,
      search_type: "hybrid",
      results: [],
      total_results: 0,
      max_results: 5,
    });

    const res = await runCli(["search", "context", QUERY, "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(envelope(res).warnings?.join(" ")).toContain("this one was not");
  });
});

describe("search stream, on the wire", () => {
  it("posts the same body to /org/search/stream and asks for an event stream", async () => {
    const seen = captureStream([sourcesFrame()]);

    await runCli(["search", "stream", QUERY]);

    expect(seen.method).toBe("POST");
    expect(seen.path).toBe("/api/v1/org/search/stream");
    expect(seen.body).toEqual({ query: QUERY, max_results: 5 });
    expect(seen.headers?.get("accept")).toBe("text/event-stream");
    expect(seen.headers?.get("x-api-key")).toBe(TEST_API_KEY);
  });

  it("applies --max-results here too, clamped to the ceiling", async () => {
    const seen = captureStream([sourcesFrame()]);

    await runCli(["search", "stream", QUERY, "--max-results", "17"]);

    expect(seen.body).toMatchObject({ max_results: 17 });
  });

  it("exits 2 without opening a stream for an out-of-range --max-results", async () => {
    const seen = captureStream([sourcesFrame()]);

    const res = await runCli(["search", "stream", QUERY, "--max-results", "50"]);

    expect(res.exitCode).toBe(2);
    expect(seen.method).toBeUndefined();
  });

  it("exits 3 without opening a stream when the key is rejected", async () => {
    server.use(
      http.post(apiUrl("/org/search/stream"), () => new HttpResponse(null, { status: 401 })),
    );

    const res = await runCli(["search", "stream", QUERY]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
  });

  it("exits 1 when the server accepts the request and then sends no body", async () => {
    server.use(
      http.post(apiUrl("/org/search/stream"), () => new HttpResponse(null, { status: 204 })),
    );

    const res = await runCli(["search", "stream", QUERY]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("no response body");
  });
});

/**
 * The gap-signal opt-out.
 *
 * An answering search that finds nothing is filed in the organization's gap
 * report. Probes and tests must be able to stay out of it, and the thing to
 * protect is that the header reaches the API from every command and from the
 * environment — including the subcommands, where Commander binds a flag typed
 * after `search context` to the parent unless it is resolved explicitly.
 */
describe("search, keeping a probe out of the gap report", () => {
  it("sends no X-Senso-Signals header by default, so a real question stays eligible", async () => {
    const seen = captureSearch("/org/search");

    await runCli(["search", QUERY]);

    expect(seen.headers?.get("x-senso-signals")).toBeNull();
  });

  it("sends X-Senso-Signals: off with --no-gap-signals", async () => {
    const seen = captureSearch("/org/search");

    const res = await runCli(["search", QUERY, "--no-gap-signals"]);

    expect(res.exitCode).toBe(0);
    expect(seen.headers?.get("x-senso-signals")).toBe("off");
  });

  it("sends it from every subcommand, not only the parent", async () => {
    for (const [name, path] of [
      ["context", "/org/search/context"],
      ["content", "/org/search/content"],
      ["full", "/org/search/full"],
    ] as const) {
      const seen = captureSearch(path);

      await runCli(["search", name, QUERY, "--no-gap-signals"]);

      expect(seen.headers?.get("x-senso-signals"), name).toBe("off");
    }
  });

  it("sends it from search stream", async () => {
    const seen = captureStream([sourcesFrame()]);

    await runCli(["search", "stream", QUERY, "--no-gap-signals"]);

    expect(seen.headers?.get("x-senso-signals")).toBe("off");
  });

  it("sends it for every search when SENSO_GAP_SIGNALS=off", async () => {
    process.env.SENSO_GAP_SIGNALS = "off";
    const seen = captureSearch("/org/search/full");

    await runCli(["search", "full", QUERY]);

    expect(seen.headers?.get("x-senso-signals")).toBe("off");
  });

  it("exits 2 before any request when SENSO_GAP_SIGNALS is misspelled", async () => {
    // A typo the API would read as "eligible" would file every probe as a gap
    // while the caller believed they had opted out.
    process.env.SENSO_GAP_SIGNALS = "of";
    const seen = captureSearch("/org/search");

    const res = await runCli(["search", QUERY]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("SENSO_GAP_SIGNALS");
    expect(seen.method).toBeUndefined();
  });
});

describe("search stream, reassembling the token stream", () => {
  it("joins a data: line that was split across two chunks", async () => {
    // The case that breaks a parser written as `chunk.split("\n")`: the JSON
    // for one token arrives in two pieces, and the first piece is not a
    // complete line. It has to be carried into the next read, not parsed and
    // not discarded.
    captureStream([
      'event: token\ndata: {"token":"Hel',
      'lo"}\n\nevent: token\ndata: {"token":" world"}\n\n',
      sourcesFrame(),
    ]);

    const res = await runCli(["search", "stream", QUERY]);

    expect(res.exitCode).toBe(0);
    expect(streamed(res.stdout)).toContain("Hello world");
    // Not a warning in sight: the frame was well formed, it just arrived in
    // two pieces.
    expect(res.stderr).not.toContain("unparseable");
  });

  it("joins an event: line that was split across two chunks", async () => {
    // The event name is carried between reads as well — it lives outside the
    // per-chunk loop precisely so that this works.
    captureStream([
      "even",
      't: token\ndata: {"token":"split header"}\n\n',
      sourcesFrame(),
    ]);

    const res = await runCli(["search", "stream", QUERY]);

    expect(res.exitCode).toBe(0);
    expect(streamed(res.stdout)).toContain("split header");
  });

  it("assembles an answer arriving one token per chunk", async () => {
    captureStream([
      ...["The ", "answer ", "is ", "42."].map((token) => frame("token", { token })),
      sourcesFrame(RESULTS),
    ]);

    const res = await runCli(["search", "stream", QUERY]);

    expect(res.exitCode).toBe(0);
    expect(streamed(res.stdout)).toContain("The answer is 42.");
  });

  it("prints the sources after the answer", async () => {
    captureStream([frame("token", { token: "Because." }), sourcesFrame(RESULTS)]);

    const res = await runCli(["search", "stream", QUERY]);

    expect(res.stdout).toContain("Sources:");
    expect(res.stdout).toContain("Refund policy");
    expect(res.stdout).toContain(KB_NODE_ID_1);
  });

  it("says so on stdout when the stream carried no sources", async () => {
    captureStream([frame("token", { token: "Because." }), sourcesFrame()]);

    const res = await runCli(["search", "stream", QUERY]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain(`No results for ${JSON.stringify(QUERY)}.`);
  });

  it("tells a streaming caller the empty search became a gap, on stderr", async () => {
    captureStream([sourcesFrame()]);

    const res = await runCli(["search", "stream", QUERY]);

    expect(res.stderr).toContain("filed as an API search gap");
    expect(res.stderr).toContain("senso gaps list --origin api_unanswered_question");
  });

  it("ignores an event it does not recognize", async () => {
    // Servers add events. An unknown one is not a reason to stop reading.
    captureStream([
      frame("heartbeat", { ts: 1 }),
      frame("token", { token: "still here" }),
      sourcesFrame(),
    ]);

    const res = await runCli(["search", "stream", QUERY]);

    expect(res.exitCode).toBe(0);
    expect(streamed(res.stdout)).toContain("still here");
  });
});

describe("search stream, when a frame is bad", () => {
  it("skips an unparseable frame with a warning and keeps the answer", async () => {
    // The server's problem, not a reason to abandon an answer that is
    // otherwise arriving correctly.
    captureStream([
      frame("token", { token: "before " }),
      "event: token\ndata: {this is not json}\n\n",
      frame("token", { token: "after" }),
      sourcesFrame(),
    ]);

    const res = await runCli(["search", "stream", QUERY]);

    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain("Skipped an unparseable event");
    expect(streamed(res.stdout)).toContain("before after");
  });

  it("surfaces an error event as a CliError and exits 1", async () => {
    captureStream([frame("error", { error: "The index is rebuilding." })]);

    const res = await runCli(["search", "stream", QUERY]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("The index is rebuilding.");
  });

  it("reports an error event with no message of its own", async () => {
    captureStream([frame("error", {})]);

    const res = await runCli(["search", "stream", QUERY]);

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("stream reported an error");
  });

  it("reports an error event as JSON on stderr under --output json", async () => {
    captureStream([
      frame("token", { token: "partial" }),
      frame("error", { error: "upstream 503" }),
    ]);

    const res = await runCli(["search", "stream", QUERY, "--output", "json"]);

    expect(res.exitCode).toBe(1);
    // Nothing on stdout, so the caller does not parse half an answer as the
    // whole one.
    expect(res.stdout).toBe("");
    expect(JSON.parse(res.stderr)).toMatchObject({ error: { code: "error" } });
  });
});

describe("search stream, under --output json", () => {
  it("emits one parseable document instead of streaming partial text", async () => {
    // The reason renderStream buffers in this format: a token written to stdout
    // as it arrives leaves a half-written string in front of the JSON, and the
    // whole document becomes unparseable.
    captureStream([
      frame("token", { token: "Refunds " }),
      frame("token", { token: "take 14 days." }),
      sourcesFrame(RESULTS),
    ]);

    const res = await runCli(["search", "stream", QUERY, "--output", "json"]);

    expect(res.exitCode).toBe(0);
    // The document describes the same search the API described: the fields the
    // `sources` frame carried travel with the answer rather than being dropped
    // because the CLI only kept the two it happened to render.
    expect(res.data()).toEqual({
      query: QUERY,
      search_type: "hybrid",
      answer: "Refunds take 14 days.",
      results: RESULTS,
      total_results: RESULTS.length,
      max_results: 5,
    });
    expect(res.stderr).toBe("");
  });

  it("emits the document even when the stream carried no sources event", async () => {
    // Nothing to carry the search_type or the counts, so they are absent rather
    // than invented.
    captureStream([frame("token", { token: "Just an answer." })]);

    const res = await runCli(["search", "stream", QUERY, "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toEqual({ query: QUERY, answer: "Just an answer.", results: [] });
  });

  it("carries the gap notice in the envelope when the stream found nothing", async () => {
    captureStream([sourcesFrame()]);

    const res = await runCli(["search", "stream", QUERY, "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.stderr).toBe("");
    expect(envelope(res).warnings?.join(" ")).toContain("filed as an API search gap");
    expect(envelope(res).next).toContainEqual(
      expect.objectContaining({ command: expect.stringContaining("senso gaps list") as string }),
    );
  });

  it("buffers the answer under --output table as well", async () => {
    // `table` is not the streaming format either — only `plain` is.
    captureStream([frame("token", { token: "Buffered." }), sourcesFrame(RESULTS)]);

    const res = await runCli(["search", "stream", QUERY, "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("kb_node_id");
    expect(res.stdout).toContain("Refund policy");
    expect(res.stderr).not.toContain("did not return");
  });
});
