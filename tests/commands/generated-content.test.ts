/**
 * Command layer: `senso generated-content`.
 *
 * Read-only, two subcommands, and almost all of the risk is in one line: `list`
 * turns `--status` into a path segment rather than a query parameter, so the
 * flag decides which endpoint is called. What is worth protecting:
 *
 *   - `published` and `drafts` reach the URL as path segments, with `published`
 *     the default when the flag is absent;
 *   - the paging defaults ("10" and "0") are actually sent, because a caller
 *     paging by hand needs the CLI's idea of page one to match the server's;
 *   - `--search` is omitted entirely when unset, rather than sent empty.
 *
 * One assertion covers the guard on `--status`: anything but published/drafts
 * (with `draft` accepted as a spelling of `drafts`) is a usage error, rather
 * than silently falling through to `published` and returning a wrong list.
 *
 * Failure branches come first, as in tests/commands/roles.test.ts.
 */

import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server, TEST_API_KEY } from "../setup.js";
import { apiUrl, runCli } from "../helpers.js";

const LISTING = {
  items: [
    {
      id: "gc-1",
      title: "How does pricing work?",
      status: "published",
      created_at: "2026-01-02T03:04:05Z",
    },
    {
      id: "gc-2",
      title: "What is a citeable?",
      status: "published",
      created_at: "2026-01-03T03:04:05Z",
    },
  ],
  total: 2,
};

const ONE_ITEM = {
  id: "gc-1",
  title: "How does pricing work?",
  status: "published",
  question: "How does pricing work?",
  body: "# Pricing\n\nIt works like this.",
};

describe("generated-content, when the request fails", () => {
  it("exits 3 and explains how to authenticate when there is no API key", async () => {
    const res = await runCli(["generated-content", "list"], { withKey: false });

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("no API key found");
    expect(res.stderr).toContain("SENSO_API_KEY");
  });

  it("exits 3 when the API rejects the key", async () => {
    server.use(
      http.get(apiUrl("/org/generated-content/published"), () =>
        HttpResponse.json({ error: "invalid key" }, { status: 401 }),
      ),
    );

    const res = await runCli(["generated-content", "list"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Authentication failed");
  });

  it("exits 3 when the org does not have the GEO product or the read scope", async () => {
    server.use(
      http.get(apiUrl("/org/generated-content/published"), () =>
        HttpResponse.json({ error: "read:content required" }, { status: 403 }),
      ),
    );

    const res = await runCli(["generated-content", "list"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Permission denied");
    expect(res.stderr).toContain("read:content required");
  });

  it("exits 4 when the item does not exist", async () => {
    server.use(
      http.get(apiUrl("/org/generated-content/:id"), () => new HttpResponse(null, { status: 404 })),
    );

    const res = await runCli(["generated-content", "get", "gc-missing"]);

    expect(res.exitCode).toBe(4);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Not found");
  });

  it("exits 1 on a 500 and says it is not the caller's fault", async () => {
    server.use(
      http.get(
        apiUrl("/org/generated-content/published"),
        () => new HttpResponse(null, { status: 500 }),
      ),
    );

    const res = await runCli(["generated-content", "list"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("not your fault");
  });

  it("exits 5 when the API rate limits the caller", async () => {
    server.use(
      http.get(
        apiUrl("/org/generated-content/published"),
        () => new HttpResponse(null, { status: 429 }),
      ),
    );

    const res = await runCli(["generated-content", "list"]);

    expect(res.exitCode).toBe(5);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Rate limited");
  });

  it("writes the failure to stderr as JSON, leaving stdout empty, under --output json", async () => {
    server.use(
      http.get(apiUrl("/org/generated-content/:id"), () =>
        HttpResponse.json({ error: "nope" }, { status: 404 }),
      ),
    );

    const res = await runCli(["generated-content", "get", "gc-1", "--output", "json"]);

    expect(res.exitCode).toBe(4);
    // A caller redirecting stdout to a file gets an empty file, not a file
    // containing an error object it would later read as data.
    expect(res.stdout).toBe("");

    const reported: unknown = JSON.parse(res.stderr);
    expect(reported).toMatchObject({ error: { code: "not_found", status: 404 } });
  });
});

describe("generated-content, on usage errors", () => {
  it("exits 2 when get is called without an id", async () => {
    // No handler is registered: setup.ts fails any request that reaches the
    // network, so this also proves nothing was sent.
    const res = await runCli(["generated-content", "get"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
  });

  it("exits 2 and names the valid formats when --output is not one of them", async () => {
    const res = await runCli(["generated-content", "list", "--output", "csv"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("json, table, plain");
  });

  it("exits 2 and names the two statuses when --status is neither", async () => {
    // No handler is registered, so this also proves nothing was requested: the
    // old behavior fell through to "published" and returned a wrong list.
    const res = await runCli(["generated-content", "list", "--status", "archived"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain('Invalid --status: "archived"');
    expect(res.stderr).toContain("published, drafts");
  });

  it("still accepts the singular --status draft", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/generated-content/drafts"), ({ request }) => {
        seen = request;
        return HttpResponse.json(LISTING);
      }),
    );

    const res = await runCli(["generated-content", "list", "--status", "draft"]);

    expect(res.exitCode).toBe(0);
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/generated-content/drafts");
  });
});

describe("generated-content list, on the wire", () => {
  it("GETs the published path with the documented paging defaults", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/generated-content/published"), ({ request }) => {
        seen = request;
        return HttpResponse.json(LISTING);
      }),
    );

    await runCli(["generated-content", "list"]);

    expect(seen?.method).toBe("GET");
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/generated-content/published");
    const params = new URL(seen?.url ?? "").searchParams;
    // Sent explicitly rather than left to the server, so the CLI's page one and
    // the API's page one cannot drift apart.
    expect(params.get("limit")).toBe("10");
    expect(params.get("offset")).toBe("0");
    // Unset, so absent — not an empty `search=`, which would filter on "".
    expect(params.has("search")).toBe(false);
    expect(seen?.headers.get("x-api-key")).toBe(TEST_API_KEY);
  });

  it("switches to the drafts path for --status drafts", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/generated-content/drafts"), ({ request }) => {
        seen = request;
        return HttpResponse.json({ items: [], total: 0 });
      }),
    );

    await runCli(["generated-content", "list", "--status", "drafts"]);

    // The flag picks the endpoint, not a filter on one endpoint.
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/generated-content/drafts");
  });

  it("accepts the singular --status draft as well", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/generated-content/drafts"), ({ request }) => {
        seen = request;
        return HttpResponse.json({ items: [], total: 0 });
      }),
    );

    await runCli(["generated-content", "list", "--status", "draft"]);

    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/generated-content/drafts");
  });

  it("sends --limit, --offset and --search as query parameters", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/generated-content/published"), ({ request }) => {
        seen = request;
        return HttpResponse.json(LISTING);
      }),
    );

    await runCli([
      "generated-content",
      "list",
      "--limit",
      "50",
      "--offset",
      "100",
      "--search",
      "pricing & plans",
    ]);

    const params = new URL(seen?.url ?? "").searchParams;
    expect(params.get("limit")).toBe("50");
    expect(params.get("offset")).toBe("100");
    // Encoded by URLSearchParams, so an ampersand in a title cannot inject a
    // second parameter.
    expect(params.get("search")).toBe("pricing & plans");
  });
});

describe("generated-content get, on the wire", () => {
  it("GETs the item's own path with no query string", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/generated-content/:id"), ({ request }) => {
        seen = request;
        return HttpResponse.json(ONE_ITEM);
      }),
    );

    await runCli(["generated-content", "get", "gc-1"]);

    expect(seen?.method).toBe("GET");
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/generated-content/gc-1");
    expect(new URL(seen?.url ?? "").search).toBe("");
  });
});

describe("generated-content, on success", () => {
  it("prints the list payload unmodified under --output json", async () => {
    server.use(
      http.get(apiUrl("/org/generated-content/published"), () => HttpResponse.json(LISTING)),
    );

    const res = await runCli(["generated-content", "list", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.json()).toEqual(LISTING);
    // json implies quiet: no banner, no commentary alongside the payload.
    expect(res.stderr).toBe("");
  });

  it("renders one row per item under --output table", async () => {
    server.use(
      http.get(apiUrl("/org/generated-content/published"), () => HttpResponse.json(LISTING)),
    );

    const res = await runCli(["generated-content", "list", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("title");
    expect(res.stdout).toContain("gc-1");
    expect(res.stdout).toContain("What is a citeable?");
  });

  it("renders a readable block per item by default", async () => {
    server.use(
      http.get(apiUrl("/org/generated-content/published"), () => HttpResponse.json(LISTING)),
    );

    const res = await runCli(["generated-content", "list"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("How does pricing work?");
    expect(res.stdout).toContain("gc-2");
  });

  it("says so plainly when there are no drafts", async () => {
    server.use(
      http.get(apiUrl("/org/generated-content/drafts"), () =>
        HttpResponse.json({ items: [], total: 0 }),
      ),
    );

    const res = await runCli(["generated-content", "list", "--status", "drafts"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("total");
  });

  it("prints one item, body and all, unmodified under --output json", async () => {
    server.use(http.get(apiUrl("/org/generated-content/:id"), () => HttpResponse.json(ONE_ITEM)));

    const res = await runCli(["generated-content", "get", "gc-1", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    // The rendered body is the reason to call this command; it must survive
    // whole, newlines included.
    expect(res.json()).toEqual(ONE_ITEM);
    expect(res.stderr).toBe("");
  });

  it("renders one item as field/value rows under --output table", async () => {
    server.use(http.get(apiUrl("/org/generated-content/:id"), () => HttpResponse.json(ONE_ITEM)));

    const res = await runCli(["generated-content", "get", "gc-1", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("field");
    expect(res.stdout).toContain("question");
  });

  it("renders one item as key/value lines by default", async () => {
    server.use(http.get(apiUrl("/org/generated-content/:id"), () => HttpResponse.json(ONE_ITEM)));

    const res = await runCli(["generated-content", "get", "gc-1"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("title");
    expect(res.stdout).toContain("How does pricing work?");
  });
});
