/**
 * Command layer: `senso tracked-sources`.
 *
 * These rules decide whether a cited URL counts as Owned, Tracked or External,
 * which is what every share-of-voice number is computed from. Four things are
 * worth protecting:
 *
 *   - THE ID COLUMN. dto.TrackedSourceResponse marshals `id`, not `source_id`.
 *     The command asked for `source_id`, so the first cell of every row was
 *     blank — and the old fixture invented the CLI's spelling, which is why the
 *     suite stayed green;
 *   - THE SILENT NO-OP. For a rule with source_origin "published" the service
 *     applies `active`, ignores everything else, and answers 200 with no status,
 *     header or field saying so. The only detection available is the returned
 *     row against what was sent, and the command must report that as a failure
 *     rather than letting it look like a write;
 *   - the body `buildSourceBody` assembles: every flag maps to a snake_case
 *     field, an omitted optional flag stays out of the JSON rather than
 *     arriving as null, and --category, --match-type, --tier and --priority are
 *     all checked before the request;
 *   - what the caller is not told by the API: the pattern was normalized before
 *     storage, this PUT clears `label` and `category` when they are omitted, and
 *     every mutation queues a rollup recalculation that runs for minutes.
 *
 * Failure branches come first, as in tests/commands/roles.test.ts.
 */

import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server, TEST_API_KEY } from "../setup.js";
import { apiUrl, envelope, errorEnvelope, runCli } from "../helpers.js";

const TS_1 = "2f7b8c1d-9e04-4a55-8b77-6c1d3e9f0a21";
const TS_2 = "81c0a4f6-2b39-4d70-91ee-5a0b7c2d8e43";
const ORG = "0c9a1f47-2d58-4b3e-8a71-6f4d9e2c5b08";

/** dto.TrackedSourceResponse: `id`, and `category`/`label` only when set. */
const OWNED = {
  id: TS_1,
  org_id: ORG,
  pattern: "senso.ai",
  match_type: "domain",
  tier: "primary",
  priority: 10,
  source_origin: "manual",
  active: true,
  created_at: "2026-01-02T03:04:05Z",
  updated_at: "2026-01-02T03:04:05Z",
};

const COMMUNITY = {
  id: TS_2,
  org_id: ORG,
  pattern: "reddit.com/r/artificial",
  match_type: "path_prefix",
  tier: "tracked",
  category: "social",
  label: "Community threads",
  priority: 0,
  source_origin: "onboarding",
  active: false,
  created_at: "2026-01-03T03:04:05Z",
  updated_at: "2026-01-03T03:04:05Z",
};

/** A rule the publishing pipeline maintains. It accepts only an active toggle. */
const PUBLISHED = {
  id: TS_2,
  org_id: ORG,
  pattern: "senso.ai/blog/geo-guide",
  match_type: "exact_url",
  tier: "primary",
  priority: 0,
  source_origin: "published",
  active: true,
  created_at: "2026-01-04T03:04:05Z",
  updated_at: "2026-01-04T03:04:05Z",
};

/** dto.TrackedSourceListResponse. `total` is the org's full row count. */
const SOURCES = {
  tracked_sources: [OWNED, COMMUNITY],
  total: 120,
  limit: 50,
  offset: 0,
};

/** The three flags `add` and `update` both require. */
const REQUIRED = ["--pattern", "senso.ai", "--match-type", "domain", "--tier", "primary"];

describe("tracked-sources, when the request fails", () => {
  it("exits 3 and explains how to authenticate when there is no API key", async () => {
    const res = await runCli(["tracked-sources", "list"], { withKey: false });

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("no API key found");
    expect(res.stderr).toContain("SENSO_API_KEY");
  });

  it("exits 3 when the API rejects the key", async () => {
    server.use(
      http.get(apiUrl("/org/tracked-sources"), () =>
        HttpResponse.json({ error: "invalid key" }, { status: 401 }),
      ),
    );

    const res = await runCli(["tracked-sources", "list"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Authentication failed");
  });

  it("exits 3 when the key is valid but lacks update:org", async () => {
    server.use(
      http.post(apiUrl("/org/tracked-sources"), () =>
        HttpResponse.json({ error: "update:org required" }, { status: 403 }),
      ),
    );

    const res = await runCli(["tracked-sources", "add", ...REQUIRED]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Permission denied");
  });

  it("names the tracked source and the id in the 404", async () => {
    server.use(
      http.put(apiUrl("/org/tracked-sources/:id"), () => new HttpResponse(null, { status: 404 })),
    );

    const res = await runCli(["tracked-sources", "update", TS_1, ...REQUIRED, "--output", "json"]);

    expect(res.exitCode).toBe(4);
    expect(res.stdout).toBe("");
    const { error } = errorEnvelope(res);
    expect(error.code).toBe("not_found");
    expect(error.message).toContain(`Tracked source ${TS_1}`);
    expect(error.field).toBe("id");
    expect(error.hint).toContain("senso tracked-sources list");
  });

  it("exits 1 on a 409 when the pattern and match type collide with another rule", async () => {
    server.use(
      http.put(apiUrl("/org/tracked-sources/:id"), () =>
        HttpResponse.json({ error: "a rule with this pattern already exists" }, { status: 409 }),
      ),
    );

    const res = await runCli(["tracked-sources", "update", TS_1, ...REQUIRED]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Conflict");
    expect(res.stderr).toContain("already exists");
  });

  it("exits 1 on a 502 and keeps the retry hint", async () => {
    server.use(
      http.get(apiUrl("/org/tracked-sources"), () => new HttpResponse(null, { status: 502 })),
    );

    const res = await runCli(["tracked-sources", "list"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("server-side failure");
    expect(res.stderr).toContain("Retry shortly");
  });

  it("exits 1 on a 501 and says the deployment does not offer the endpoint", async () => {
    server.use(
      http.get(apiUrl("/org/tracked-sources"), () => new HttpResponse(null, { status: 501 })),
    );

    const res = await runCli(["tracked-sources", "list"]);

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("not a transient failure");
  });

  it("writes the failure to stderr as an error envelope, leaving stdout empty", async () => {
    server.use(
      http.delete(
        apiUrl("/org/tracked-sources/:id"),
        () => new HttpResponse(null, { status: 404 }),
      ),
    );

    const res = await runCli(["tracked-sources", "delete", TS_1, "--output", "json"]);

    expect(res.exitCode).toBe(4);
    expect(res.stdout).toBe("");

    const reported = errorEnvelope(res);
    expect(reported.ok).toBe(false);
    expect(reported.command).toBe("tracked-sources delete");
    expect(reported.error).toMatchObject({
      code: "not_found",
      status: 404,
      request: { method: "DELETE", path: `/org/tracked-sources/${TS_1}` },
    });
  });
});

describe("tracked-sources update, on the published rule that accepts nothing", () => {
  it("exits 1 rather than letting a 200 that applied nothing look like a write", async () => {
    // For source_origin "published" the service applies `active`, saves, and
    // returns 200 with everything else untouched. Nothing in the status, the
    // headers or the body says so: the returned row against what was sent is
    // the only detection there is.
    server.use(http.put(apiUrl("/org/tracked-sources/:id"), () => HttpResponse.json(PUBLISHED)));

    const res = await runCli([
      "tracked-sources",
      "update",
      TS_2,
      "--pattern",
      "senso.ai/blog/geo-guide",
      "--match-type",
      "exact_url",
      "--tier",
      "secondary",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    const { error } = errorEnvelope(res);
    expect(error.code).toBe("conflict");
    expect(error.field).toBe("--tier");
    expect(error.message).toContain('source_origin "published"');
    expect(error.details).toMatchObject({ source_origin: "published", ignored: ["--tier"] });
    // The one change it does accept, written out with the rule's own values.
    expect(error.hint).toContain("--no-active");
    expect(error.hint).toContain("senso.ai/blog/geo-guide");
  });

  it("lets an active toggle through, since that is the one change it does apply", async () => {
    server.use(
      http.put(apiUrl("/org/tracked-sources/:id"), () =>
        HttpResponse.json({ ...PUBLISHED, active: false }),
      ),
    );

    const res = await runCli([
      "tracked-sources",
      "update",
      TS_2,
      "--pattern",
      "senso.ai/blog/geo-guide",
      "--match-type",
      "exact_url",
      "--tier",
      "primary",
      "--no-active",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toMatchObject({ source_origin: "published", active: false });
  });

  it("does not claim a published rule's label and category were cleared", async () => {
    // The PUT clears them on an editable rule. On a published one the service
    // never reaches that code, so saying otherwise would send the caller
    // re-sending fields to restore something that was never lost.
    server.use(
      http.put(apiUrl("/org/tracked-sources/:id"), () =>
        HttpResponse.json({ ...PUBLISHED, active: false }),
      ),
    );

    const res = await runCli([
      "tracked-sources",
      "update",
      TS_2,
      "--pattern",
      "senso.ai/blog/geo-guide",
      "--match-type",
      "exact_url",
      "--tier",
      "primary",
      "--no-active",
      "--output",
      "json",
    ]);

    const warnings = envelope(res).warnings?.join(" ") ?? "";
    expect(warnings).not.toContain("stored label was cleared");
    expect(warnings).not.toContain("stored category was cleared");
    expect(warnings).toContain("rollup recalculation");
  });
});

describe("tracked-sources, on usage errors", () => {
  // No handler is registered in this block: setup.ts fails any request that
  // reaches the network, so each of these also proves the guard ran first.
  it("reports one missing required flag at a time, naming it", async () => {
    // Commander reports the first missing one and exits rather than collecting
    // them, which is worth pinning: a caller fixing them one at a time should
    // expect exactly this.
    const nothing = await runCli(["tracked-sources", "add"]);
    expect(nothing.exitCode).toBe(2);
    expect(nothing.stdout).toBe("");
    expect(nothing.stderr).toContain("--pattern");

    const onlyPattern = await runCli(["tracked-sources", "add", "--pattern", "senso.ai"]);
    expect(onlyPattern.exitCode).toBe(2);
    expect(onlyPattern.stderr).toContain("--match-type");
  });

  it("exits 2 and names the four match types when --match-type is not one of them", async () => {
    const res = await runCli([
      "tracked-sources",
      "add",
      "--pattern",
      "senso.ai",
      "--match-type",
      "regex",
      "--tier",
      "primary",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    const { error } = errorEnvelope(res);
    expect(error.field).toBe("--match-type");
    expect(error.received).toBe("regex");
    expect(error.allowed).toEqual(["domain", "host", "path_prefix", "exact_url"]);
  });

  it("exits 2 and names the three tiers when --tier is not one of them", async () => {
    const res = await runCli([
      "tracked-sources",
      "add",
      "--pattern",
      "senso.ai",
      "--match-type",
      "domain",
      "--tier",
      "owned",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    const { error } = errorEnvelope(res);
    expect(error.field).toBe("--tier");
    expect(error.allowed).toEqual(["primary", "tracked", "secondary"]);
  });

  it("exits 2 for a --category the API would silently discard on this tier", async () => {
    // The service drops `category` for any tier but `tracked` and answers 201
    // anyway, so a caller has no way to notice the sub-label never landed.
    const res = await runCli([
      "tracked-sources",
      "add",
      ...REQUIRED,
      "--category",
      "social",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    const { error } = errorEnvelope(res);
    expect(error.field).toBe("--category");
    expect(error.message).toContain("--tier tracked");
  });

  it("exits 2 and names the four categories when --category is not one of them", async () => {
    const res = await runCli([
      "tracked-sources",
      "add",
      "--pattern",
      "reddit.com/r/artificial",
      "--match-type",
      "path_prefix",
      "--tier",
      "tracked",
      "--category",
      "forum",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    expect(errorEnvelope(res).error.allowed).toEqual([
      "affiliated_domain",
      "published_content",
      "social",
      "press",
    ]);
  });

  it("exits 2 when path_prefix or exact_url is given a pattern with no path", async () => {
    // The API answers 400 for this, which the CLI would report as exit 1 — a
    // server problem, for a command line the caller can fix.
    const res = await runCli([
      "tracked-sources",
      "add",
      "--pattern",
      "reddit.com",
      "--match-type",
      "path_prefix",
      "--tier",
      "tracked",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    const { error } = errorEnvelope(res);
    expect(error.field).toBe("--pattern");
    expect(error.hint).toContain("--match-type domain");
  });

  it("rejects a non-numeric --priority rather than sending it as null", async () => {
    // `Number("high")` is NaN and JSON.stringify writes NaN as null, so without
    // the guard this CLEARED the priority instead of failing.
    const res = await runCli(["tracked-sources", "add", ...REQUIRED, "--priority", "high"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("--priority");
  });

  it("exits 2 when --pattern is empty after trimming", async () => {
    const res = await runCli([
      "tracked-sources",
      "add",
      "--pattern",
      "   ",
      "--match-type",
      "domain",
      "--tier",
      "primary",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    expect(errorEnvelope(res).error.field).toBe("--pattern");
  });

  it("exits 2 when --limit is outside the API's 1-100 range", async () => {
    const res = await runCli(["tracked-sources", "list", "--limit", "101", "--output", "json"]);

    expect(res.exitCode).toBe(2);
    const { error } = errorEnvelope(res);
    expect(error.field).toBe("--limit");
    expect(error.message).toContain("out of range");
  });

  it("exits 2 when --offset is negative", async () => {
    const res = await runCli(["tracked-sources", "list", "--offset", "-1"]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("--offset");
  });

  it("exits 2 when <sourceId> is not a UUID", async () => {
    const res = await runCli(["tracked-sources", "delete", "ts-1", "--output", "json"]);

    expect(res.exitCode).toBe(2);
    const { error } = errorEnvelope(res);
    expect(error.field).toBe("<sourceId>");
    expect(error.received).toBe("ts-1");
    expect(error.hint).toContain("senso tracked-sources list");
  });
});

describe("tracked-sources, on the wire", () => {
  it("GETs /org/tracked-sources with the API key and no query string", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/tracked-sources"), ({ request }) => {
        seen = request;
        return HttpResponse.json(SOURCES);
      }),
    );

    await runCli(["tracked-sources", "list"]);

    expect(seen?.method).toBe("GET");
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/tracked-sources");
    expect(new URL(seen?.url ?? "").search).toBe("");
    expect(seen?.headers.get("x-api-key")).toBe(TEST_API_KEY);
  });

  it("sends --limit, --offset and --search as their query parameters", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/tracked-sources"), ({ request }) => {
        seen = request;
        return HttpResponse.json(SOURCES);
      }),
    );

    await runCli([
      "tracked-sources",
      "list",
      "--limit",
      "10",
      "--offset",
      "20",
      "--search",
      "senso.ai",
    ]);

    const params = new URL(seen?.url ?? "").searchParams;
    expect(params.get("limit")).toBe("10");
    expect(params.get("offset")).toBe("20");
    expect(params.get("search")).toBe("senso.ai");
  });

  it("POSTs only the three required fields when nothing optional was passed", async () => {
    let body: Record<string, unknown> | undefined;
    let seen: Request | undefined;
    server.use(
      http.post(apiUrl("/org/tracked-sources"), async ({ request }) => {
        seen = request;
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(OWNED);
      }),
    );

    await runCli(["tracked-sources", "add", ...REQUIRED]);

    expect(seen?.method).toBe("POST");
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/tracked-sources");
    // Exactly these three keys: an omitted optional flag must not arrive as
    // null and clear a field the caller never mentioned, and `active` is not
    // sent at all because new rules are created active by the API.
    expect(body).toEqual({ pattern: "senso.ai", match_type: "domain", tier: "primary" });
    expect(body).not.toHaveProperty("active");
  });

  it("maps every flag to its snake_case API field, with priority as a number", async () => {
    let body: unknown;
    server.use(
      http.post(apiUrl("/org/tracked-sources"), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(COMMUNITY);
      }),
    );

    await runCli([
      "tracked-sources",
      "add",
      "--pattern",
      "reddit.com/r/artificial",
      "--match-type",
      "path_prefix",
      "--tier",
      "tracked",
      "--category",
      "social",
      "--label",
      "Community threads",
      "--priority",
      "7",
    ]);

    expect(body).toEqual({
      pattern: "reddit.com/r/artificial",
      match_type: "path_prefix",
      tier: "tracked",
      category: "social",
      label: "Community threads",
      // A string here would be rejected by the API, or worse, coerced.
      priority: 7,
    });
  });

  it("PUTs to the rule's own path with the replacement fields", async () => {
    let body: unknown;
    let seen: Request | undefined;
    server.use(
      http.put(apiUrl("/org/tracked-sources/:id"), async ({ request }) => {
        seen = request;
        body = await request.json();
        return HttpResponse.json(OWNED);
      }),
    );

    await runCli(["tracked-sources", "update", TS_1, ...REQUIRED]);

    expect(seen?.method).toBe("PUT");
    expect(new URL(seen?.url ?? "").pathname).toBe(`/api/v1/org/tracked-sources/${TS_1}`);
    expect(body).toEqual({ pattern: "senso.ai", match_type: "domain", tier: "primary" });
  });

  it("sends active: true for --active and active: false for --no-active", async () => {
    const bodies: Record<string, unknown>[] = [];
    server.use(
      http.put(apiUrl("/org/tracked-sources/:id"), async ({ request }) => {
        bodies.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json(OWNED);
      }),
    );

    await runCli(["tracked-sources", "update", TS_1, ...REQUIRED, "--active"]);
    await runCli(["tracked-sources", "update", TS_1, ...REQUIRED, "--no-active"]);

    expect(bodies[0]).toMatchObject({ active: true });
    expect(bodies[1]).toMatchObject({ active: false });
  });

  it("leaves active out entirely when neither flag is passed", async () => {
    let body: Record<string, unknown> | undefined;
    server.use(
      http.put(apiUrl("/org/tracked-sources/:id"), async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(OWNED);
      }),
    );

    await runCli(["tracked-sources", "update", TS_1, ...REQUIRED]);

    // "Do not change it" is not the same request as "deactivate it".
    expect(body).not.toHaveProperty("active");
  });

  it("DELETEs the rule's own path", async () => {
    let seen: Request | undefined;
    server.use(
      http.delete(apiUrl("/org/tracked-sources/:id"), ({ request }) => {
        seen = request;
        return HttpResponse.json({ deleted: true });
      }),
    );

    await runCli(["tracked-sources", "delete", TS_2]);

    expect(seen?.method).toBe("DELETE");
    expect(new URL(seen?.url ?? "").pathname).toBe(`/api/v1/org/tracked-sources/${TS_2}`);
  });
});

describe("tracked-sources list, on success", () => {
  it("prints the payload unmodified inside the envelope, and pages it", async () => {
    server.use(http.get(apiUrl("/org/tracked-sources"), () => HttpResponse.json(SOURCES)));

    const res = await runCli(["tracked-sources", "list", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    const env = envelope<typeof SOURCES>(res);
    expect(env.command).toBe("tracked-sources list");
    expect(env.data).toEqual(SOURCES);
    // `total` here IS the organization's row count, so there is a next page and
    // the command that fetches it is built from the caller's own flags.
    expect(env.page).toMatchObject({
      returned: 2,
      limit: 50,
      offset: 0,
      total: 120,
      has_more: true,
    });
    expect(env.page?.next).toContain("senso tracked-sources list");
    expect(env.page?.next).toContain("--offset");
    expect(res.stderr).toBe("");
  });

  it("fills the id column, because the API's field is `id` and not `source_id`", async () => {
    server.use(http.get(apiUrl("/org/tracked-sources"), () => HttpResponse.json(SOURCES)));

    const res = await runCli(["tracked-sources", "list", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("match_type");
    expect(res.stdout).toContain(TS_1);
    expect(res.stdout).toContain(TS_2);
    // source_origin is in the table because it is what says whether a rule can
    // be edited at all.
    expect(res.stdout).toContain("manual");
    expect(res.stderr).not.toContain("which the API did not return");
  });

  it("renders a readable block per rule by default", async () => {
    server.use(http.get(apiUrl("/org/tracked-sources"), () => HttpResponse.json(SOURCES)));

    const res = await runCli(["tracked-sources", "list"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("senso.ai");
    expect(res.stdout).toContain("reddit.com/r/artificial");
    expect(res.stderr).toContain("Showing 1–2 of 120.");
  });

  it("says what an empty list means, which is that everything counts as External", async () => {
    server.use(
      http.get(apiUrl("/org/tracked-sources"), () =>
        HttpResponse.json({ tracked_sources: [], total: 0, limit: 50, offset: 0 }),
      ),
    );

    const res = await runCli(["tracked-sources", "list"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("No tracked source rules found.");
    expect(res.stderr).toContain("classified External");
    expect(res.stderr).toContain("senso tracked-sources add");
  });
});

describe("tracked-sources add and update, on success", () => {
  it("prints the created rule on stdout and the tick on stderr", async () => {
    server.use(http.post(apiUrl("/org/tracked-sources"), () => HttpResponse.json(OWNED)));

    const res = await runCli(["tracked-sources", "add", ...REQUIRED]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain(TS_1);
    expect(res.stdout).not.toContain("✓");
    expect(res.stderr).toContain("Created tracked source");
  });

  it("warns that analytics will lag, because the recalculation runs for minutes", async () => {
    server.use(http.post(apiUrl("/org/tracked-sources"), () => HttpResponse.json(OWNED)));

    const res = await runCli(["tracked-sources", "add", ...REQUIRED, "--output", "json"]);

    expect(res.exitCode).toBe(0);
    const env = envelope(res);
    expect(env.warnings?.join(" ")).toContain("rollup recalculation was queued");
    expect(env.next?.[0]?.command).toBe("senso tracked-sources list --search senso.ai");
  });

  it("says when the API stored something other than the pattern that was sent", async () => {
    // citationclass.Normalize lowercases the host, strips "www.", the scheme,
    // the query and the trailing slash. The stored form is what `list` and
    // `--search` match, so a caller searching for what it typed finds nothing.
    server.use(http.post(apiUrl("/org/tracked-sources"), () => HttpResponse.json(OWNED)));

    const res = await runCli([
      "tracked-sources",
      "add",
      "--pattern",
      "https://WWW.Senso.ai/",
      "--match-type",
      "domain",
      "--tier",
      "primary",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(0);
    const warnings = envelope(res).warnings?.join(" ") ?? "";
    expect(warnings).toContain("was normalized from");
    expect(warnings).toContain("senso.ai");
  });

  it("warns that this PUT cleared the label and the category it was not given", async () => {
    // The API cannot express "leave the label alone" on this endpoint: both are
    // reassigned on every PUT, so omitting them clears them.
    server.use(
      http.put(apiUrl("/org/tracked-sources/:id"), () =>
        HttpResponse.json({ ...COMMUNITY, category: undefined, label: undefined }),
      ),
    );

    const res = await runCli([
      "tracked-sources",
      "update",
      TS_2,
      "--pattern",
      "reddit.com/r/artificial",
      "--match-type",
      "path_prefix",
      "--tier",
      "secondary",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(0);
    const warnings = envelope(res).warnings?.join(" ") ?? "";
    expect(warnings).toContain("stored label was cleared");
    expect(warnings).toContain("stored category was cleared");
  });

  it("renders a single rule as field/value rows under --output table", async () => {
    server.use(http.post(apiUrl("/org/tracked-sources"), () => HttpResponse.json(OWNED)));

    const res = await runCli(["tracked-sources", "add", ...REQUIRED, "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("field");
    expect(res.stdout).toContain("source_origin");
    // The tick stays a diagnostic even when the payload is a table.
    expect(res.stdout).not.toContain("✓");
    expect(res.stderr).toContain("Created tracked source");
  });
});

describe("tracked-sources delete, on confirmation", () => {
  it("puts the tick on stderr and leaves stdout empty in plain mode", async () => {
    server.use(
      http.delete(apiUrl("/org/tracked-sources/:id"), () => HttpResponse.json({ deleted: true })),
    );

    const res = await runCli(["tracked-sources", "delete", TS_1]);

    expect(res.exitCode).toBe(0);
    // The API's { deleted: true } carries nothing the caller does not know.
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Removed tracked source");
    expect(res.stderr).toContain("External (secondary) tier");
  });

  it("gives a JSON caller a record of what went, not a sentence to parse", async () => {
    server.use(
      http.delete(apiUrl("/org/tracked-sources/:id"), () => HttpResponse.json({ deleted: true })),
    );

    const res = await runCli(["tracked-sources", "delete", TS_1, "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toEqual({
      action: "deleted",
      resource: "tracked_source",
      id: TS_1,
    });
    expect(envelope(res).warnings?.join(" ")).toContain("rollup recalculation");
    expect(res.stderr).toBe("");
  });
});
