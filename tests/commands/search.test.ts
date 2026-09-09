/**
 * Command layer: `senso search`, and its four siblings.
 *
 * Two very different things share this file, and the second is the reason it is
 * long.
 *
 * The plain half is five POST bodies. `search`, `search context`, `search
 * content`, `search full` and `search stream` all send the same shape to five
 * different endpoints, and `max_results` is clamped and defaulted on the way —
 * so the assertions that earn their place are the ones on the request. A
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
import { apiUrl, runCli } from "../helpers.js";

const RESULTS = [
  {
    content_id: "c-1",
    title: "Refund policy",
    chunk_text: "Refunds are issued within 14 days.",
  },
  {
    content_id: "c-2",
    title: "Returns",
    chunk_text: "Items must be unopened.",
  },
];

const ANSWER_PAYLOAD = { answer: "Refunds take 14 days.", results: RESULTS };

const QUERY = "how do refunds work";

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
    expect(res.stderr).toContain("not your fault");
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

  it("clamps an oversized count to the ceiling rather than sending it", async () => {
    // The API caps this at 20. Sending 500 would be rejected or, worse,
    // silently truncated somewhere the user cannot see.
    const seen = captureSearch("/org/search");

    await runCli(["search", QUERY, "--max-results", "500"]);

    expect(seen.body).toMatchObject({ max_results: 20 });
  });

  it("falls back to the default when the count is not a usable number", async () => {
    const seen = captureSearch("/org/search");

    await runCli(["search", QUERY, "--max-results", "not-a-number"]);

    expect(seen.body).toMatchObject({ max_results: 5 });
  });

  it("falls back to the default rather than asking for zero results", async () => {
    const seen = captureSearch("/org/search");

    await runCli(["search", QUERY, "--max-results", "0"]);

    expect(seen.body).toMatchObject({ max_results: 5 });
  });

  it("scopes the search to the content IDs it was given", async () => {
    const seen = captureSearch("/org/search");

    await runCli(["search", QUERY, "--content-ids", "c-1", "c-2"]);

    expect(seen.body).toMatchObject({ content_ids: ["c-1", "c-2"] });
  });

  it("sends require_scoped_ids only when the flag is present", async () => {
    const withoutFlag = captureSearch("/org/search");
    await runCli(["search", QUERY, "--content-ids", "c-1"]);
    expect(withoutFlag.body).not.toHaveProperty("require_scoped_ids");

    const withFlag = captureSearch("/org/search");
    await runCli(["search", QUERY, "--content-ids", "c-1", "--require-scoped-ids"]);
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

      const clamped = captureSearch(path);

      await runCli(["search", name, QUERY, "--max-results", "99"]);

      expect(clamped.body).toMatchObject({ max_results: 20 });
    });

    it(`applies the scoping options on search ${name}`, async () => {
      // A caller who scoped a search to two documents must get a search over
      // those two documents, not over the whole knowledge base.
      const seen = captureSearch(path);

      await runCli(["search", name, QUERY, "--content-ids", "c-1", "c-2", "--require-scoped-ids"]);

      expect(seen.body).toMatchObject({
        content_ids: ["c-1", "c-2"],
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
    expect(res.json()).toEqual(ANSWER_PAYLOAD);
    expect(res.stderr).toBe("");
  });

  it("leads with the answer, then the sources, in plain", async () => {
    captureSearch("/org/search");

    const res = await runCli(["search", QUERY]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Answer:");
    expect(res.stdout).toContain(ANSWER_PAYLOAD.answer);
    expect(res.stdout).toContain("Refund policy");
    expect(res.stdout).toContain("c-1");
  });

  it("renders one row per result under --output table", async () => {
    captureSearch("/org/search");

    const res = await runCli(["search", QUERY, "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("content_id");
    expect(res.stdout).toContain("title");
    expect(res.stdout).toContain("Returns");
  });

  it("copes with an answer and no results", async () => {
    captureSearch("/org/search", { answer: "Nothing matched.", results: [] });

    const res = await runCli(["search", QUERY]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Nothing matched.");
  });

  it("renders a variant's chunks without an answer", async () => {
    captureSearch("/org/search/context", { results: RESULTS });

    const res = await runCli(["search", "context", QUERY]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Refund policy");
  });
});

describe("search stream, on the wire", () => {
  it("posts the same body to /org/search/stream and asks for an event stream", async () => {
    const seen = captureStream([frame("sources", { results: [] })]);

    await runCli(["search", "stream", QUERY]);

    expect(seen.method).toBe("POST");
    expect(seen.path).toBe("/api/v1/org/search/stream");
    expect(seen.body).toEqual({ query: QUERY, max_results: 5 });
    expect(seen.headers?.get("accept")).toBe("text/event-stream");
    expect(seen.headers?.get("x-api-key")).toBe(TEST_API_KEY);
  });

  it("applies --max-results here too, clamped to the ceiling", async () => {
    const seen = captureStream([frame("sources", { results: [] })]);

    await runCli(["search", "stream", QUERY, "--max-results", "17"]);

    expect(seen.body).toMatchObject({ max_results: 17 });

    const clamped = captureStream([frame("sources", { results: [] })]);

    await runCli(["search", "stream", QUERY, "--max-results", "50"]);

    expect(clamped.body).toMatchObject({ max_results: 20 });
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

describe("search stream, reassembling the token stream", () => {
  it("joins a data: line that was split across two chunks", async () => {
    // The case that breaks a parser written as `chunk.split("\n")`: the JSON
    // for one token arrives in two pieces, and the first piece is not a
    // complete line. It has to be carried into the next read, not parsed and
    // not discarded.
    captureStream([
      'event: token\ndata: {"token":"Hel',
      'lo"}\n\nevent: token\ndata: {"token":" world"}\n\n',
      frame("sources", { results: [] }),
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
      frame("sources", { results: [] }),
    ]);

    const res = await runCli(["search", "stream", QUERY]);

    expect(res.exitCode).toBe(0);
    expect(streamed(res.stdout)).toContain("split header");
  });

  it("assembles an answer arriving one token per chunk", async () => {
    captureStream([
      ...["The ", "answer ", "is ", "42."].map((token) => frame("token", { token })),
      frame("sources", { results: RESULTS }),
    ]);

    const res = await runCli(["search", "stream", QUERY]);

    expect(res.exitCode).toBe(0);
    expect(streamed(res.stdout)).toContain("The answer is 42.");
  });

  it("prints the sources after the answer", async () => {
    captureStream([frame("token", { token: "Because." }), frame("sources", { results: RESULTS })]);

    const res = await runCli(["search", "stream", QUERY]);

    expect(res.stdout).toContain("Sources:");
    expect(res.stdout).toContain("Refund policy");
    expect(res.stdout).toContain("c-1");
  });

  it("says so when the stream carried no sources", async () => {
    captureStream([frame("token", { token: "Because." }), frame("sources", { results: [] })]);

    const res = await runCli(["search", "stream", QUERY]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("No sources found.");
  });

  it("ignores an event it does not recognize", async () => {
    // Servers add events. An unknown one is not a reason to stop reading.
    captureStream([
      frame("heartbeat", { ts: 1 }),
      frame("token", { token: "still here" }),
      frame("sources", { results: [] }),
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
      frame("sources", { results: [] }),
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
      frame("sources", { results: RESULTS }),
    ]);

    const res = await runCli(["search", "stream", QUERY, "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.json()).toEqual({
      answer: "Refunds take 14 days.",
      results: RESULTS,
    });
    expect(res.stderr).toBe("");
  });

  it("emits the document even when the stream carried no sources event", async () => {
    captureStream([frame("token", { token: "Just an answer." })]);

    const res = await runCli(["search", "stream", QUERY, "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.json()).toEqual({ answer: "Just an answer.", results: [] });
  });

  it("buffers the answer under --output table as well", async () => {
    // `table` is not the streaming format either — only `plain` is.
    captureStream([frame("token", { token: "Buffered." }), frame("sources", { results: RESULTS })]);

    const res = await runCli(["search", "stream", QUERY, "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("content_id");
    expect(res.stdout).toContain("Refund policy");
  });
});
