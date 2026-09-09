/**
 * Command layer: `senso tracked-sources`.
 *
 * These rules decide whether a cited URL counts as Owned, Tracked or External,
 * so the whole group is really one thing worth protecting: the body that
 * `buildSourceBody` assembles. Every flag maps to a snake_case API field, an
 * absent optional flag must stay out of the JSON entirely rather than arrive as
 * null, and `--priority` is the one value the CLI coerces itself.
 *
 * Three of the assertions below cover the client-side guards: `--match-type`
 * and `--tier` are checked against the closed sets the help text names, and
 * `--priority` must be a whole number. Each is a usage error (exit 2) raised
 * before any request, with the valid values named.
 *
 * Failure branches come first, as in tests/commands/roles.test.ts.
 */

import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server, TEST_API_KEY } from "../setup.js";
import { apiUrl, runCli } from "../helpers.js";

const SOURCES = {
  tracked_sources: [
    {
      source_id: "ts-1",
      pattern: "example.com",
      match_type: "domain",
      tier: "primary",
      category: null,
      active: true,
    },
    {
      source_id: "ts-2",
      pattern: "https://blog.partner.example/posts",
      match_type: "path_prefix",
      tier: "tracked",
      category: "published_content",
      active: false,
    },
  ],
};

const ONE_SOURCE = {
  source_id: "ts-1",
  pattern: "example.com",
  match_type: "domain",
  tier: "primary",
  active: true,
};

/** The three flags `add` and `update` both require. */
const REQUIRED = ["--pattern", "example.com", "--match-type", "domain", "--tier", "primary"];

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

  it("exits 3 when the key is valid but lacks the scope", async () => {
    server.use(
      http.post(apiUrl("/org/tracked-sources"), () =>
        HttpResponse.json({ error: "write:tracked_sources required" }, { status: 403 }),
      ),
    );

    const res = await runCli(["tracked-sources", "add", ...REQUIRED]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Permission denied");
  });

  it("exits 4 when the rule does not exist", async () => {
    server.use(
      http.put(apiUrl("/org/tracked-sources/:id"), () => new HttpResponse(null, { status: 404 })),
    );

    const res = await runCli(["tracked-sources", "update", "ts-missing", ...REQUIRED]);

    expect(res.exitCode).toBe(4);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Not found");
  });

  it("exits 1 on a 500 and says it is not the caller's fault", async () => {
    server.use(
      http.get(apiUrl("/org/tracked-sources"), () => new HttpResponse(null, { status: 502 })),
    );

    const res = await runCli(["tracked-sources", "list"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("not your fault");
  });

  it("exits 1 on a 409 when the API refuses to edit a published rule", async () => {
    server.use(
      http.put(apiUrl("/org/tracked-sources/:id"), () =>
        HttpResponse.json({ error: "rule is read-only" }, { status: 409 }),
      ),
    );

    const res = await runCli(["tracked-sources", "update", "ts-1", ...REQUIRED]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Conflict");
  });

  it("writes the failure to stderr as JSON, leaving stdout empty, under --output json", async () => {
    server.use(
      http.delete(
        apiUrl("/org/tracked-sources/:id"),
        () => new HttpResponse(null, { status: 404 }),
      ),
    );

    const res = await runCli(["tracked-sources", "delete", "ts-1", "--output", "json"]);

    expect(res.exitCode).toBe(4);
    expect(res.stdout).toBe("");

    const reported: unknown = JSON.parse(res.stderr);
    expect(reported).toMatchObject({ error: { code: "not_found", status: 404 } });
  });
});

describe("tracked-sources, on usage errors", () => {
  it("reports one missing required flag at a time, naming it", async () => {
    // `add` requires --pattern, --match-type and --tier. Commander reports the
    // first missing one and exits rather than collecting them, which is worth
    // pinning: a caller fixing them one at a time should expect exactly this,
    // and changing to "report them all" would change the usage contract.
    //
    // The message is assertable because tests/helpers.ts routes Commander's own
    // output into the captured streams — it writes usage errors straight to
    // process.stderr rather than through console.
    const nothing = await runCli(["tracked-sources", "add"]);
    expect(nothing.exitCode).toBe(2);
    expect(nothing.stdout).toBe("");
    expect(nothing.stderr).toContain("--pattern");

    const onlyPattern = await runCli(["tracked-sources", "add", "--pattern", "example.com"]);
    expect(onlyPattern.exitCode).toBe(2);
    expect(onlyPattern.stderr).toContain("--match-type");
  });

  it("exits 2 when a required flag is missing", async () => {
    const res = await runCli(["tracked-sources", "add", "--pattern", "example.com"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
  });

  it("exits 2 and names the four match types when --match-type is not one of them", async () => {
    // No handler is registered, so this also proves the guard ran before the
    // request rather than after the response.
    const res = await runCli([
      "tracked-sources",
      "add",
      "--pattern",
      "example.com",
      "--match-type",
      "regex",
      "--tier",
      "primary",
    ]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain('Invalid --match-type: "regex"');
    expect(res.stderr).toContain("domain, host, path_prefix, exact_url");
  });

  it("exits 2 and names the three tiers when --tier is not one of them", async () => {
    const res = await runCli([
      "tracked-sources",
      "add",
      "--pattern",
      "example.com",
      "--match-type",
      "domain",
      "--tier",
      "owned",
    ]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain('Invalid --tier: "owned"');
    expect(res.stderr).toContain("primary, tracked, secondary");
  });

  it("rejects a non-numeric --priority rather than sending it as null", async () => {
    // `Number("high")` is NaN and JSON.stringify writes NaN as null, so without
    // the guard this cleared the priority instead of failing.
    const res = await runCli(["tracked-sources", "add", ...REQUIRED, "--priority", "high"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("--priority");
  });

  it("reports an invalid --tier as usage, with the valid values, under --output json", async () => {
    const res = await runCli([
      "tracked-sources",
      "update",
      "ts-1",
      "--pattern",
      "example.com",
      "--match-type",
      "domain",
      "--tier",
      "gold",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");

    const reported = JSON.parse(res.stderr) as { error: { code: string; hint: string } };
    expect(reported.error.code).toBe("usage");
    expect(reported.error.hint).toContain("primary, tracked, secondary");
  });
});

describe("tracked-sources list, on the wire", () => {
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
});

describe("tracked-sources add, on the wire", () => {
  it("POSTs only the three required fields when nothing optional was passed", async () => {
    let body: unknown;
    let seen: Request | undefined;
    server.use(
      http.post(apiUrl("/org/tracked-sources"), async ({ request }) => {
        seen = request;
        body = await request.json();
        return HttpResponse.json(ONE_SOURCE);
      }),
    );

    await runCli(["tracked-sources", "add", ...REQUIRED]);

    expect(seen?.method).toBe("POST");
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/tracked-sources");
    // Exactly these three keys: an omitted optional flag must not arrive as
    // null and clear a field the caller never mentioned.
    expect(body).toEqual({ pattern: "example.com", match_type: "domain", tier: "primary" });
  });

  it("maps every flag to its snake_case API field, with priority as a number", async () => {
    let body: unknown;
    server.use(
      http.post(apiUrl("/org/tracked-sources"), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(ONE_SOURCE);
      }),
    );

    await runCli([
      "tracked-sources",
      "add",
      "--pattern",
      "blog.partner.example",
      "--match-type",
      "path_prefix",
      "--tier",
      "tracked",
      "--category",
      "published_content",
      "--label",
      "Partner blog",
      "--priority",
      "7",
    ]);

    expect(body).toEqual({
      pattern: "blog.partner.example",
      match_type: "path_prefix",
      tier: "tracked",
      category: "published_content",
      label: "Partner blog",
      // A string here would be rejected by the API, or worse, coerced.
      priority: 7,
    });
  });

  it("never sends active, because new rules are created active by the API", async () => {
    let body: Record<string, unknown> | undefined;
    server.use(
      http.post(apiUrl("/org/tracked-sources"), async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(ONE_SOURCE);
      }),
    );

    await runCli(["tracked-sources", "add", ...REQUIRED]);

    expect(body).not.toHaveProperty("active");
  });
});

describe("tracked-sources update, on the wire", () => {
  it("PUTs to the rule's own path with the replacement fields", async () => {
    let body: unknown;
    let seen: Request | undefined;
    server.use(
      http.put(apiUrl("/org/tracked-sources/:id"), async ({ request }) => {
        seen = request;
        body = await request.json();
        return HttpResponse.json(ONE_SOURCE);
      }),
    );

    await runCli(["tracked-sources", "update", "ts-1", ...REQUIRED]);

    expect(seen?.method).toBe("PUT");
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/tracked-sources/ts-1");
    expect(body).toEqual({ pattern: "example.com", match_type: "domain", tier: "primary" });
  });

  it("sends active: true for --active and active: false for --no-active", async () => {
    const bodies: Record<string, unknown>[] = [];
    server.use(
      http.put(apiUrl("/org/tracked-sources/:id"), async ({ request }) => {
        bodies.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json(ONE_SOURCE);
      }),
    );

    await runCli(["tracked-sources", "update", "ts-1", ...REQUIRED, "--active"]);
    await runCli(["tracked-sources", "update", "ts-1", ...REQUIRED, "--no-active"]);

    expect(bodies[0]).toMatchObject({ active: true });
    expect(bodies[1]).toMatchObject({ active: false });
  });

  it("leaves active out entirely when neither flag is passed", async () => {
    let body: Record<string, unknown> | undefined;
    server.use(
      http.put(apiUrl("/org/tracked-sources/:id"), async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(ONE_SOURCE);
      }),
    );

    await runCli(["tracked-sources", "update", "ts-1", ...REQUIRED]);

    // The distinction that matters: "do not change it" is not the same request
    // as "deactivate it".
    expect(body).not.toHaveProperty("active");
  });
});

describe("tracked-sources delete, on the wire", () => {
  it("DELETEs the rule's own path", async () => {
    let seen: Request | undefined;
    server.use(
      http.delete(apiUrl("/org/tracked-sources/:id"), ({ request }) => {
        seen = request;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await runCli(["tracked-sources", "delete", "ts-2"]);

    expect(seen?.method).toBe("DELETE");
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/tracked-sources/ts-2");
  });
});

describe("tracked-sources, on success", () => {
  it("prints the list payload unmodified under --output json", async () => {
    server.use(http.get(apiUrl("/org/tracked-sources"), () => HttpResponse.json(SOURCES)));

    const res = await runCli(["tracked-sources", "list", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.json()).toEqual(SOURCES);
    expect(res.stderr).toBe("");
  });

  it("renders one row per rule under --output table", async () => {
    server.use(http.get(apiUrl("/org/tracked-sources"), () => HttpResponse.json(SOURCES)));

    const res = await runCli(["tracked-sources", "list", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("match_type");
    expect(res.stdout).toContain("ts-1");
    expect(res.stdout).toContain("path_prefix");
  });

  it("renders a readable block per rule by default", async () => {
    server.use(http.get(apiUrl("/org/tracked-sources"), () => HttpResponse.json(SOURCES)));

    const res = await runCli(["tracked-sources", "list"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("example.com");
    expect(res.stdout).toContain("tracked");
  });

  it("prints the created rule on stdout and the tick on stderr", async () => {
    server.use(http.post(apiUrl("/org/tracked-sources"), () => HttpResponse.json(ONE_SOURCE)));

    const res = await runCli(["tracked-sources", "add", ...REQUIRED]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("ts-1");
    expect(res.stdout).not.toContain("✓");
    expect(res.stderr).toContain("added");
  });

  it("renders a single rule as field/value rows under --output table", async () => {
    server.use(http.post(apiUrl("/org/tracked-sources"), () => HttpResponse.json(ONE_SOURCE)));

    const res = await runCli(["tracked-sources", "add", ...REQUIRED, "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("field");
    expect(res.stdout).toContain("source_id");
    // The tick stays a diagnostic even when the payload is a table.
    expect(res.stdout).not.toContain("✓");
    expect(res.stderr).toContain("added");
  });
});

describe("tracked-sources delete, on confirmation", () => {
  it("puts the tick on stderr and leaves stdout empty in plain mode", async () => {
    server.use(
      http.delete(
        apiUrl("/org/tracked-sources/:id"),
        () => new HttpResponse(null, { status: 204 }),
      ),
    );

    const res = await runCli(["tracked-sources", "delete", "ts-1"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("removed");
  });

  it("prints a parseable object on stdout under --output json", async () => {
    server.use(
      http.delete(
        apiUrl("/org/tracked-sources/:id"),
        () => new HttpResponse(null, { status: 204 }),
      ),
    );

    const res = await runCli(["tracked-sources", "delete", "ts-1", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.json()).toMatchObject({ ok: true });
    expect(res.stderr).toBe("");
  });
});
