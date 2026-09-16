/**
 * Command layer: `senso competitors`.
 *
 * Tracked competitors are what share-of-voice analytics measure the
 * organization against, and what generation positions its content against, so
 * a wrong list here is wrong analysis rather than a wrong screen. Four things
 * are worth protecting:
 *
 *   - THE ID COLUMN. dto.CompetitorResponse marshals `id`, not
 *     `competitor_id`. The command asked for `competitor_id`, so the first
 *     cell of every row was blank — and the old fixture invented the CLI's
 *     spelling, which is why the suite stayed green;
 *   - THE ERASED URL. `update` is a PUT and the API cannot express "leave the
 *     URL alone": a body without one deleted the stored URL, answered 200, and
 *     omitted `url` from the response so nothing said so. Either --url or
 *     --clear-url is now required;
 *   - `batch-add` reports what the call DID — created, already present,
 *     discarded at the organization cap — rather than counting everything it
 *     sent as created. The rows cannot tell those apart, which is why the API
 *     reports the counts;
 *   - `suggest` carries `mode`, `cached` and `duration_ms` beside its array and
 *     must still render as a list, not as one stringified line.
 *
 * Failure branches come first, as in tests/commands/roles.test.ts.
 */

import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server, TEST_API_KEY } from "../setup.js";
import { apiUrl, envelope, errorEnvelope, runCli } from "../helpers.js";

const C_1 = "6b1f0a92-4c33-4c8e-9a5d-1e7f2b3c4d55";
const C_2 = "8d4e2a17-9b60-4c3f-a852-7e1b0f6d9c24";
const ORG = "0c9a1f47-2d58-4b3e-8a71-6f4d9e2c5b08";
const RUN_1 = "1f3c7b90-5a24-4e18-9d6b-2c8a4f0e7b31";

/** dto.CompetitorResponse: manual entries carry no rationale or confidence. */
const MANUAL = {
  id: C_1,
  org_id: ORG,
  name: "Acme Analytics",
  url: "https://acme.example.com",
  source: "manual",
  created_at: "2026-01-02T03:04:05Z",
  updated_at: "2026-01-02T03:04:05Z",
};

/** An accepted suggestion, which keeps the provenance it was accepted with. */
const SUGGESTED = {
  id: C_2,
  org_id: ORG,
  name: "Globex",
  url: "https://globex.example.com",
  source: "suggested_web_search",
  rationale: "Named alongside you in four recent answers about pipeline analytics.",
  confidence: 0.86,
  created_at: "2026-01-03T03:04:05Z",
  updated_at: "2026-01-03T03:04:05Z",
};

/** dto.CompetitorListResponse. */
const COMPETITORS = { competitors: [MANUAL, SUGGESTED], total: 2 };

/** What a row this very call inserted looks like: a timestamp seconds old. */
const JUST_NOW = new Date().toISOString();

/** dto.CompetitorBatchResponse: the rows, plus what the call actually did. */
const BATCH = {
  competitors: [MANUAL, { ...SUGGESTED, created_at: JUST_NOW, updated_at: JUST_NOW }],
  total: 2,
  created_count: 1,
  already_present_count: 1,
  skipped_count: 0,
  skipped_over_cap_count: 0,
  skipped_invalid_count: 0,
  competitor_cap: 50,
  remaining_capacity: 48,
};

/** The same call against an organization with one slot left. */
const BATCH_AT_CAP = {
  competitors: [{ ...SUGGESTED, created_at: JUST_NOW, updated_at: JUST_NOW }],
  total: 1,
  created_count: 1,
  already_present_count: 0,
  skipped_count: 2,
  skipped_over_cap_count: 2,
  skipped_invalid_count: 0,
  competitor_cap: 50,
  remaining_capacity: 0,
};

/** dto.SuggestCompetitorsResponse: an array with three scalars beside it. */
const SUGGESTIONS = {
  mode: "run_text",
  suggestions: [
    {
      name: "Acme Analytics",
      url: "https://acme.example.com",
      source: "suggested_run_text",
      confidence: 0.91,
      rationale: "Cited beside you in answers about pipeline analytics.",
      already_tracked: true,
    },
    {
      name: "Initech",
      url: "https://initech.example.com",
      source: "suggested_run_text",
      confidence: 0.62,
      rationale: "Mentioned as the cheaper option in two recent answers.",
      already_tracked: false,
    },
  ],
  sampled_run_ids: [RUN_1],
  duration_ms: 4210,
  cached: false,
};

describe("competitors, when the request fails", () => {
  it("exits 3 and explains how to authenticate when there is no API key", async () => {
    const res = await runCli(["competitors", "list"], { withKey: false });

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("no API key found");
    expect(res.stderr).toContain("SENSO_API_KEY");
  });

  it("exits 3 when the API rejects the key", async () => {
    server.use(
      http.get(apiUrl("/org/competitors"), () =>
        HttpResponse.json({ error: "invalid key" }, { status: 401 }),
      ),
    );

    const res = await runCli(["competitors", "list"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Authentication failed");
  });

  it("exits 3 when the key is valid but lacks update:org", async () => {
    server.use(
      http.post(apiUrl("/org/competitors"), () =>
        HttpResponse.json({ error: "update:org required" }, { status: 403 }),
      ),
    );

    const res = await runCli(["competitors", "add", "--name", "Acme Analytics"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Permission denied");
  });

  it("names the competitor and the id in the 404", async () => {
    server.use(
      http.delete(apiUrl("/org/competitors/:id"), () => new HttpResponse(null, { status: 404 })),
    );

    const res = await runCli(["competitors", "delete", C_1, "--output", "json"]);

    expect(res.exitCode).toBe(4);
    expect(res.stdout).toBe("");
    const { error } = errorEnvelope(res);
    expect(error.code).toBe("not_found");
    expect(error.message).toContain(`Competitor ${C_1}`);
    expect(error.field).toBe("id");
    expect(error.hint).toContain("senso competitors list");
  });

  it("reads a 500 on a mutation as the organization cap, which is how the API reports it", async () => {
    // The service returns a plain error for the 50-competitor cap, which falls
    // to the default 500 branch. "Retry shortly" is advice that can never work
    // for the one failure an agent hits most while accepting suggestions.
    server.use(
      http.post(apiUrl("/org/competitors"), () =>
        HttpResponse.json({ error: "competitor cap of 50 reached" }, { status: 500 }),
      ),
    );

    const res = await runCli([
      "competitors",
      "add",
      "--name",
      "Acme Analytics",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    const { error } = errorEnvelope(res);
    expect(error.code).toBe("server_error");
    expect(error.status).toBe(500);
    expect(error.message).toContain("50-competitor per-organization cap");
    expect(error.hint).toContain("senso competitors delete");
  });

  it("exits 1 on a plain 500 from a read, where retrying is the right advice", async () => {
    server.use(http.get(apiUrl("/org/competitors"), () => new HttpResponse(null, { status: 500 })));

    const res = await runCli(["competitors", "list"]);

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("server-side failure");
    expect(res.stderr).toContain("Retry shortly");
  });

  it("exits 1 on a 503 from suggest and says it is not transient", async () => {
    server.use(
      http.post(apiUrl("/org/competitors/suggest"), () => new HttpResponse(null, { status: 503 })),
    );

    const res = await runCli(["competitors", "suggest"]);

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("not a transient failure");
  });

  it("exits 5 on suggest's 429, naming the 5-per-hour limit and the cache", async () => {
    server.use(
      http.post(apiUrl("/org/competitors/suggest"), () => new HttpResponse(null, { status: 429 })),
    );

    const res = await runCli(["competitors", "suggest", "--output", "json"]);

    expect(res.exitCode).toBe(5);
    expect(res.stdout).toBe("");
    const { error } = errorEnvelope(res);
    expect(error.code).toBe("rate_limited");
    expect(error.message).toContain("5 per hour");
    expect(error.hint).toContain("cached for 10 minutes");
  });

  it("exits 1 on suggest's 422 and says what to seed the model with", async () => {
    server.use(
      http.post(apiUrl("/org/competitors/suggest"), () =>
        HttpResponse.json({ error: "no website and no runs" }, { status: 422 }),
      ),
    );

    const res = await runCli(["competitors", "suggest", "--output", "json"]);

    expect(res.exitCode).toBe(1);
    const { error } = errorEnvelope(res);
    expect(error.code).toBe("validation");
    expect(error.hint).toContain("senso org update --website");
  });

  it("writes the failure to stderr as an error envelope, leaving stdout empty", async () => {
    server.use(
      http.get(apiUrl("/org/competitors"), () =>
        HttpResponse.json({ error: "nope" }, { status: 403 }),
      ),
    );

    const res = await runCli(["competitors", "list", "--output", "json"]);

    expect(res.exitCode).toBe(3);
    // A caller redirecting stdout to a file gets an empty file, not a file
    // containing an error object it would later read as data.
    expect(res.stdout).toBe("");

    const reported = errorEnvelope(res);
    expect(reported.ok).toBe(false);
    expect(reported.command).toBe("competitors list");
    expect(reported.error).toMatchObject({
      code: "forbidden",
      status: 403,
      request: { method: "GET", path: "/org/competitors" },
    });
  });
});

describe("competitors update, on the URL it would have erased", () => {
  // The silent data loss this command used to ship. No handler is registered
  // here, so these also prove nothing was sent.
  it("exits 2 rather than sending a PUT that deletes the stored URL", async () => {
    const res = await runCli([
      "competitors",
      "update",
      C_1,
      "--name",
      "Acme Analytics Inc",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    const { error } = errorEnvelope(res);
    expect(error.code).toBe("usage");
    expect(error.field).toBe("--url");
    expect(error.message).toContain("deletes the stored one");
    // Both ways out, and the first is a command that reads the URL back.
    expect(error.hint).toContain("senso competitors list");
    expect(error.hint).toContain("--clear-url");
  });

  it("exits 2 when --url and --clear-url contradict each other", async () => {
    const res = await runCli([
      "competitors",
      "update",
      C_1,
      "--name",
      "Acme Analytics Inc",
      "--url",
      "https://acme.example.com",
      "--clear-url",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    expect(errorEnvelope(res).error.field).toBe("--clear-url");
  });
});

describe("competitors, on usage errors", () => {
  // Still no handler: nothing in this block may reach the network.
  it("exits 2 when --data is not valid JSON", async () => {
    const res = await runCli(["competitors", "batch-add", "--data", "{items:[]}"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Invalid JSON in --data");
  });

  it("exits 2 when --data is valid JSON but not an object", async () => {
    const res = await runCli(["competitors", "batch-add", "--data", '[{"name":"Acme"}]']);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("--data must be a JSON object");
  });

  it("exits 2 when `items` is empty, since the API's minimum is one", async () => {
    const res = await runCli(["competitors", "batch-add", "--data", '{"items":[]}']);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("--data.items is empty");
  });

  it("exits 2 when `items` is over the 50-per-request maximum", async () => {
    const items = Array.from({ length: 51 }, (_, i) => ({ name: `Brand ${String(i)}` }));

    const res = await runCli(["competitors", "batch-add", "--data", JSON.stringify({ items })]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("51 entries");
  });

  it("names the ITEM INDEX for a bad source, which the API's own error does not", async () => {
    const items = [{ name: "Acme Analytics" }, { name: "Globex", source: "guessed" }];

    const res = await runCli([
      "competitors",
      "batch-add",
      "--data",
      JSON.stringify({ items }),
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    const { error } = errorEnvelope(res);
    expect(error.field).toBe("--data.items[1].source");
    expect(error.allowed).toEqual(["manual", "suggested_run_text", "suggested_web_search"]);
  });

  it("exits 2 for a confidence outside 0-1, and says 0.86 rather than 86", async () => {
    const items = [{ name: "Globex", confidence: 86 }];

    const res = await runCli([
      "competitors",
      "batch-add",
      "--data",
      JSON.stringify({ items }),
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    const { error } = errorEnvelope(res);
    expect(error.field).toBe("--data.items[0].confidence");
    expect(error.hint).toContain("0.86, not 86");
  });

  it("exits 2 for a rationale over 280 characters, which suggest can return", async () => {
    const items = [{ name: "Globex", rationale: "x".repeat(281) }];

    const res = await runCli(["competitors", "batch-add", "--data", JSON.stringify({ items })]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("281 characters");
    expect(res.stderr).toContain("rationale[0:280]");
  });

  it("names an unknown item key, because the API would drop it silently", async () => {
    const items = [{ name: "Globex", wesbite: "https://globex.example.com" }];

    const res = await runCli([
      "competitors",
      "batch-add",
      "--data",
      JSON.stringify({ items }),
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    expect(errorEnvelope(res).error.received).toBe("wesbite");
  });

  it("exits 2 for a --url with no scheme, which go's url rule rejects as 'Invalid value'", async () => {
    const res = await runCli([
      "competitors",
      "add",
      "--name",
      "Acme Analytics",
      "--url",
      "acme.example.com",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    const { error } = errorEnvelope(res);
    expect(error.field).toBe("--url");
    expect(error.hint).toContain("https://acme.example.com");
  });

  it("exits 2 for a --url that is neither http nor https", async () => {
    const res = await runCli([
      "competitors",
      "add",
      "--name",
      "Acme Analytics",
      "--url",
      "ftp://acme.example.com",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    expect(errorEnvelope(res).error.allowed).toEqual(["http://…", "https://…"]);
  });

  it("exits 2 when --name is blank after trimming", async () => {
    const res = await runCli(["competitors", "add", "--name", "   ", "--output", "json"]);

    expect(res.exitCode).toBe(2);
    expect(errorEnvelope(res).error.field).toBe("--name");
  });

  it("exits 2 when a required flag is missing, and names the flag", async () => {
    const res = await runCli(["competitors", "add"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("--name");
  });

  it("exits 2 when the id is not a UUID", async () => {
    const res = await runCli(["competitors", "delete", "c-1", "--output", "json"]);

    expect(res.exitCode).toBe(2);
    const { error } = errorEnvelope(res);
    expect(error.field).toBe("<competitorId>");
    expect(error.received).toBe("c-1");
  });

  it("exits 2 on a flag the command does not have", async () => {
    const res = await runCli(["competitors", "list", "--nonsense"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("--nonsense");
  });
});

describe("competitors, on the wire", () => {
  it("GETs /org/competitors with the API key and no query string", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/competitors"), ({ request }) => {
        seen = request;
        return HttpResponse.json(COMPETITORS);
      }),
    );

    await runCli(["competitors", "list"]);

    expect(seen?.method).toBe("GET");
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/competitors");
    expect(new URL(seen?.url ?? "").search).toBe("");
    expect(seen?.headers.get("x-api-key")).toBe(TEST_API_KEY);
  });

  it("POSTs the name alone when --url was not passed", async () => {
    let body: unknown;
    let seen: Request | undefined;
    server.use(
      http.post(apiUrl("/org/competitors"), async ({ request }) => {
        seen = request;
        body = await request.json();
        return HttpResponse.json(MANUAL);
      }),
    );

    await runCli(["competitors", "add", "--name", "  Acme Analytics  "]);

    expect(seen?.method).toBe("POST");
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/competitors");
    // Exactly `{ name }`, trimmed. On a create an absent `url` leaves the
    // stored value null rather than writing one.
    expect(body).toEqual({ name: "Acme Analytics" });
  });

  it("includes url when --url is passed", async () => {
    let body: unknown;
    server.use(
      http.post(apiUrl("/org/competitors"), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(MANUAL);
      }),
    );

    await runCli([
      "competitors",
      "add",
      "--name",
      "Acme Analytics",
      "--url",
      "https://acme.example.com",
    ]);

    expect(body).toEqual({ name: "Acme Analytics", url: "https://acme.example.com" });
  });

  it("POSTs the parsed --data object verbatim to /org/competitors/batch", async () => {
    let body: unknown;
    let seen: Request | undefined;
    server.use(
      http.post(apiUrl("/org/competitors/batch"), async ({ request }) => {
        seen = request;
        body = await request.json();
        return HttpResponse.json(BATCH);
      }),
    );

    const payload = {
      items: [
        { name: "Acme Analytics", url: "https://acme.example.com", source: "manual" },
        { name: "Globex", source: "suggested_web_search", confidence: 0.86 },
      ],
    };
    await runCli(["competitors", "batch-add", "--data", JSON.stringify(payload)]);

    expect(seen?.method).toBe("POST");
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/competitors/batch");
    expect(seen?.headers.get("content-type")).toBe("application/json");
    // Verbatim: the provenance fields are the point of this endpoint.
    expect(body).toEqual(payload);
  });

  it("POSTs to /org/competitors/suggest with no body", async () => {
    let seen: Request | undefined;
    let raw = "unset";
    server.use(
      http.post(apiUrl("/org/competitors/suggest"), async ({ request }) => {
        seen = request;
        raw = await request.text();
        return HttpResponse.json(SUGGESTIONS);
      }),
    );

    await runCli(["competitors", "suggest"]);

    expect(seen?.method).toBe("POST");
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/competitors/suggest");
    expect(raw).toBe("");
  });

  it("PUTs name and url together when --url was given", async () => {
    let body: unknown;
    let seen: Request | undefined;
    server.use(
      http.put(apiUrl("/org/competitors/:id"), async ({ request }) => {
        seen = request;
        body = await request.json();
        return HttpResponse.json({ ...MANUAL, name: "Acme Analytics Inc" });
      }),
    );

    await runCli([
      "competitors",
      "update",
      C_1,
      "--name",
      "Acme Analytics Inc",
      "--url",
      "https://acme.example.com/new",
    ]);

    expect(seen?.method).toBe("PUT");
    expect(new URL(seen?.url ?? "").pathname).toBe(`/api/v1/org/competitors/${C_1}`);
    expect(body).toEqual({ name: "Acme Analytics Inc", url: "https://acme.example.com/new" });
  });

  it("sends the name alone for --clear-url, which is what deletes the stored URL", async () => {
    let body: Record<string, unknown> | undefined;
    server.use(
      http.put(apiUrl("/org/competitors/:id"), async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ...MANUAL, url: undefined });
      }),
    );

    await runCli(["competitors", "update", C_1, "--name", "Acme Analytics Inc", "--clear-url"]);

    expect(body).toEqual({ name: "Acme Analytics Inc" });
    expect(body).not.toHaveProperty("url");
  });

  it("DELETEs the competitor's own path with no body", async () => {
    let seen: Request | undefined;
    server.use(
      http.delete(apiUrl("/org/competitors/:id"), ({ request }) => {
        seen = request;
        return HttpResponse.json({ deleted: true });
      }),
    );

    await runCli(["competitors", "delete", C_1]);

    expect(seen?.method).toBe("DELETE");
    expect(new URL(seen?.url ?? "").pathname).toBe(`/api/v1/org/competitors/${C_1}`);
  });
});

describe("competitors list, on success", () => {
  it("prints the payload unmodified inside the envelope", async () => {
    server.use(http.get(apiUrl("/org/competitors"), () => HttpResponse.json(COMPETITORS)));

    const res = await runCli(["competitors", "list", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    const env = envelope<typeof COMPETITORS>(res);
    expect(env.command).toBe("competitors list");
    expect(env.data).toEqual(COMPETITORS);
    expect(res.stderr).toBe("");
  });

  it("fills the id column, because the API's field is `id` and not `competitor_id`", async () => {
    server.use(http.get(apiUrl("/org/competitors"), () => HttpResponse.json(COMPETITORS)));

    const res = await runCli(["competitors", "list", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("id");
    expect(res.stdout).toContain(C_1);
    expect(res.stdout).toContain(C_2);
    expect(res.stderr).not.toContain("which the API did not return");
  });

  it("renders a readable block per competitor by default", async () => {
    server.use(http.get(apiUrl("/org/competitors"), () => HttpResponse.json(COMPETITORS)));

    const res = await runCli(["competitors", "list"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Acme Analytics");
    expect(res.stdout).toContain("https://globex.example.com");
  });

  it("points at suggest when nothing is tracked yet", async () => {
    server.use(
      http.get(apiUrl("/org/competitors"), () => HttpResponse.json({ competitors: [], total: 0 })),
    );

    const res = await runCli(["competitors", "list"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("No tracked competitors found.");
    expect(res.stderr).toContain("senso competitors suggest");
  });
});

describe("competitors batch-add, on what the call actually did", () => {
  it("reports created and already-present separately, not everything as created", async () => {
    // The rows cannot tell the two apart: a name already tracked comes back
    // with its ORIGINAL id, source and created_at, looking exactly like a row
    // this call inserted. Counting the response would have said "2 created".
    server.use(http.post(apiUrl("/org/competitors/batch"), () => HttpResponse.json(BATCH)));

    const res = await runCli([
      "competitors",
      "batch-add",
      "--data",
      '{"items":[{"name":"Acme Analytics"},{"name":"Globex"}]}',
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain("Added 1 competitor(s). 1 already tracked, 0 not created.");
  });

  it("warns which name came back pre-existing, in the envelope a JSON caller reads", async () => {
    server.use(http.post(apiUrl("/org/competitors/batch"), () => HttpResponse.json(BATCH)));

    const res = await runCli([
      "competitors",
      "batch-add",
      "--data",
      '{"items":[{"name":"Acme Analytics"},{"name":"Globex"}]}',
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(0);
    const env = envelope<typeof BATCH>(res);
    expect(env.data).toEqual(BATCH);
    const warnings = env.warnings?.join(" ") ?? "";
    expect(warnings).toContain("1 item(s) were already tracked");
    expect(warnings).toContain('"Acme Analytics"');
    expect(res.stderr).toBe("");
  });

  it("warns that the batch was truncated at the organization cap, and says how much room is left", async () => {
    // An item dropped at the cap does not come back at all, and the call still
    // answers 200. Silence here reads as a clean success.
    server.use(http.post(apiUrl("/org/competitors/batch"), () => HttpResponse.json(BATCH_AT_CAP)));

    const res = await runCli([
      "competitors",
      "batch-add",
      "--data",
      '{"items":[{"name":"Globex"},{"name":"Initech"},{"name":"Umbrella"}]}',
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(0);
    const warnings = envelope(res).warnings?.join(" ") ?? "";
    expect(warnings).toContain("2 item(s) were discarded");
    expect(warnings).toContain("50-competitor cap");
    expect(warnings).toContain("0 slot(s) left");
    // And the names, because the caller has to know which ones to send again.
    expect(warnings).toContain('"Initech"');
    expect(warnings).toContain('"Umbrella"');
  });

  it("exits 0 even when most of the batch was discarded, which is why the warnings matter", async () => {
    server.use(http.post(apiUrl("/org/competitors/batch"), () => HttpResponse.json(BATCH_AT_CAP)));

    const res = await runCli([
      "competitors",
      "batch-add",
      "--data",
      '{"items":[{"name":"Globex"},{"name":"Initech"},{"name":"Umbrella"}]}',
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain("Added 1 competitor(s). 0 already tracked, 2 not created.");
  });

  it("fills the id column of the returned rows under --output table", async () => {
    server.use(http.post(apiUrl("/org/competitors/batch"), () => HttpResponse.json(BATCH)));

    const res = await runCli([
      "competitors",
      "batch-add",
      "--data",
      '{"items":[{"name":"Acme Analytics"},{"name":"Globex"}]}',
      "--output",
      "table",
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain(C_1);
    expect(res.stdout).toContain(C_2);
    expect(res.stderr).not.toContain("which the API did not return");
  });
});

describe("competitors suggest, on success", () => {
  it("renders a real list although mode, cached and duration_ms travel with it", async () => {
    // The payload is an array plus three scalars describing it. A stricter
    // envelope rule stringified the whole thing onto one line and ignored the
    // command's declared columns.
    server.use(http.post(apiUrl("/org/competitors/suggest"), () => HttpResponse.json(SUGGESTIONS)));

    const res = await runCli(["competitors", "suggest", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    // The scalars become a header above the table, not a lost field.
    expect(res.stdout).toContain("mode");
    expect(res.stdout).toContain("run_text");
    // And the rows are rows.
    expect(res.stdout).toContain("already_tracked");
    expect(res.stdout).toContain("Initech");
    expect(res.stdout).toContain("0.62");
    expect(res.stderr).not.toContain("which the API did not return");
  });

  it("keeps the payload whole under --output json, sampled_run_ids included", async () => {
    server.use(http.post(apiUrl("/org/competitors/suggest"), () => HttpResponse.json(SUGGESTIONS)));

    const res = await runCli(["competitors", "suggest", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toEqual(SUGGESTIONS);
    expect(res.stderr).toBe("");
  });

  it("offers the accept pipeline, counting only the ones not already tracked", async () => {
    server.use(http.post(apiUrl("/org/competitors/suggest"), () => HttpResponse.json(SUGGESTIONS)));

    const res = await runCli(["competitors", "suggest", "--output", "json"]);

    const next = envelope(res).next?.[0];
    expect(next?.why).toContain("1 suggestion(s)");
    expect(next?.command).toContain("senso competitors batch-add");
  });

  it("says when the answer was a replay of a call made in the last ten minutes", async () => {
    // A cached result looks identical to a fresh one, and the rate limit counts
    // both, so an agent polling for changes needs to be told.
    server.use(
      http.post(apiUrl("/org/competitors/suggest"), () =>
        HttpResponse.json({ ...SUGGESTIONS, cached: true }),
      ),
    );

    const res = await runCli(["competitors", "suggest", "--output", "json"]);

    expect(envelope(res).warnings?.join(" ")).toContain("cached=true");
  });

  it("says so plainly when the model found no candidates", async () => {
    server.use(
      http.post(apiUrl("/org/competitors/suggest"), () =>
        HttpResponse.json({ mode: "web_search", suggestions: [], duration_ms: 900, cached: false }),
      ),
    );

    const res = await runCli(["competitors", "suggest"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("No suggestions found.");
    expect(res.stderr).toContain("senso competitors add");
  });
});

describe("competitors add, update and delete, on success", () => {
  it("prints the created competitor on stdout and the tick on stderr", async () => {
    server.use(http.post(apiUrl("/org/competitors"), () => HttpResponse.json(MANUAL)));

    const res = await runCli(["competitors", "add", "--name", "Acme Analytics"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain(C_1);
    expect(res.stdout).not.toContain("✓");
    expect(res.stderr).toContain("Added competitor");
  });

  it("returns the created competitor unmodified under --output json", async () => {
    server.use(http.post(apiUrl("/org/competitors"), () => HttpResponse.json(MANUAL)));

    const res = await runCli([
      "competitors",
      "add",
      "--name",
      "Acme Analytics",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toEqual(MANUAL);
    expect(res.stderr).toBe("");
  });

  it("warns that --clear-url did delete the stored URL", async () => {
    // The response omits `url` whether it was cleared or never set, so the
    // payload alone cannot confirm the destructive half of the request.
    server.use(
      http.put(apiUrl("/org/competitors/:id"), () =>
        HttpResponse.json({ ...MANUAL, url: undefined, name: "Acme Analytics Inc" }),
      ),
    );

    const res = await runCli([
      "competitors",
      "update",
      C_1,
      "--name",
      "Acme Analytics Inc",
      "--clear-url",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(0);
    expect(envelope(res).warnings?.join(" ")).toContain("stored URL was deleted");
  });

  it("says nothing about the URL when one was supplied", async () => {
    server.use(http.put(apiUrl("/org/competitors/:id"), () => HttpResponse.json(MANUAL)));

    const res = await runCli([
      "competitors",
      "update",
      C_1,
      "--name",
      "Acme Analytics Inc",
      "--url",
      "https://acme.example.com",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(0);
    expect(envelope(res).warnings).toBeUndefined();
  });

  it("puts the delete tick on stderr and leaves stdout empty in plain mode", async () => {
    server.use(
      http.delete(apiUrl("/org/competitors/:id"), () => HttpResponse.json({ deleted: true })),
    );

    const res = await runCli(["competitors", "delete", C_1]);

    expect(res.exitCode).toBe(0);
    // The API's { deleted: true } carries nothing the caller does not know.
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Removed competitor");
  });

  it("gives a JSON caller a record of what went, not a sentence to parse", async () => {
    server.use(
      http.delete(apiUrl("/org/competitors/:id"), () => HttpResponse.json({ deleted: true })),
    );

    const res = await runCli(["competitors", "delete", C_1, "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toEqual({ action: "deleted", resource: "competitor", id: C_1 });
    expect(res.stderr).toBe("");
  });
});
