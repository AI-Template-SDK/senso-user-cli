/**
 * Command layer: `senso content-types`.
 *
 * Four of the six subcommands take a raw `--data` blob, and three of them differ
 * only by HTTP method — PUT replaces, PATCH merges. That is what is worth
 * protecting here:
 *
 *   - `update` and `patch` must keep their methods distinct, because sending a
 *     partial body with PUT silently erases a config;
 *   - a malformed `--data` must fail as usage (exit 2) before any request goes
 *     out, so a shell that ate the quoting does not create a half-written type;
 *   - `--limit` and `--offset` must reach the query string under those names,
 *     and must be absent when the caller did not ask for them.
 *
 * Failure branches come first, as in tests/commands/roles.test.ts.
 */

import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server, TEST_API_KEY } from "../setup.js";
import { apiUrl, runCli } from "../helpers.js";

const CONTENT_TYPES = {
  content_types: [
    {
      content_type_id: "ct-1",
      name: "Blog Post",
      created_at: "2026-01-02T03:04:05Z",
      updated_at: "2026-01-04T03:04:05Z",
    },
    {
      content_type_id: "ct-2",
      name: "FAQ",
      created_at: "2026-01-05T03:04:05Z",
      updated_at: "2026-01-06T03:04:05Z",
    },
  ],
};

const ONE_TYPE = {
  content_type_id: "ct-1",
  name: "Blog Post",
  config: { template: "Write a post about {{topic}}", writing_rules: ["No hype"] },
};

describe("content-types, when the request fails", () => {
  it("exits 3 and explains how to authenticate when there is no API key", async () => {
    const res = await runCli(["content-types", "list"], { withKey: false });

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("no API key found");
    expect(res.stderr).toContain("SENSO_API_KEY");
  });

  it("exits 3 when the API rejects the key", async () => {
    server.use(
      http.get(apiUrl("/org/content-types"), () =>
        HttpResponse.json({ error: "invalid key" }, { status: 401 }),
      ),
    );

    const res = await runCli(["content-types", "list"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Authentication failed");
  });

  it("exits 3 when the key is valid but lacks the scope", async () => {
    server.use(
      http.post(apiUrl("/org/content-types"), () =>
        HttpResponse.json({ error: "write:content_types required" }, { status: 403 }),
      ),
    );

    const res = await runCli(["content-types", "create", "--data", '{"name":"Blog Post"}']);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Permission denied");
  });

  it("exits 4 when the content type does not exist", async () => {
    server.use(
      http.get(apiUrl("/org/content-types/:id"), () => new HttpResponse(null, { status: 404 })),
    );

    const res = await runCli(["content-types", "get", "ct-missing"]);

    expect(res.exitCode).toBe(4);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Not found");
  });

  it("exits 1 on a 500 and says it is not the caller's fault", async () => {
    server.use(
      http.get(apiUrl("/org/content-types"), () => new HttpResponse(null, { status: 500 })),
    );

    const res = await runCli(["content-types", "list"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("not your fault");
  });

  it("reports a malformed body rather than throwing a parse error at the user", async () => {
    server.use(http.get(apiUrl("/org/content-types"), () => new HttpResponse("<html>nope</html>")));

    const res = await runCli(["content-types", "list"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Invalid JSON response");
  });

  it("writes the failure to stderr as JSON, leaving stdout empty, under --output json", async () => {
    server.use(
      http.get(apiUrl("/org/content-types"), () =>
        HttpResponse.json({ error: "nope" }, { status: 403 }),
      ),
    );

    const res = await runCli(["content-types", "list", "--output", "json"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");

    const reported: unknown = JSON.parse(res.stderr);
    expect(reported).toMatchObject({ error: { code: "forbidden", status: 403 } });
  });
});

describe("content-types, on usage errors", () => {
  // No handler is registered in this block: setup.ts fails any request that
  // reaches the network, so these also prove nothing was sent.
  it("exits 2 when create --data is not valid JSON", async () => {
    const res = await runCli(["content-types", "create", "--data", "{name: 'Blog'}"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Invalid JSON in --data");
  });

  it("exits 2 when update --data is not valid JSON", async () => {
    const res = await runCli(["content-types", "update", "ct-1", "--data", "{"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Invalid JSON in --data");
  });

  it("exits 2 when patch --data is not valid JSON", async () => {
    const res = await runCli(["content-types", "patch", "ct-1", "--data", "not json"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Invalid JSON in --data");
  });

  it("shows the shell quoting in the hint, since that is usually the cause", async () => {
    const res = await runCli(["content-types", "create", "--data", "{name:1}"]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain('--data \'{"key":"value"}\'');
  });

  it("exits 2 when --data is valid JSON but an array", async () => {
    const res = await runCli(["content-types", "create", "--data", '["Blog Post"]']);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("--data must be a JSON object");
    expect(res.stderr).toContain("an array");
  });

  it("exits 2 when create is called without --data at all", async () => {
    const res = await runCli(["content-types", "create"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
  });
});

describe("content-types list, on the wire", () => {
  it("GETs /org/content-types with no query string when no paging flags are given", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/content-types"), ({ request }) => {
        seen = request;
        return HttpResponse.json(CONTENT_TYPES);
      }),
    );

    await runCli(["content-types", "list"]);

    expect(seen?.method).toBe("GET");
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/content-types");
    // An undefined param must be dropped, not sent as the string "undefined".
    expect(new URL(seen?.url ?? "").search).toBe("");
    expect(seen?.headers.get("x-api-key")).toBe(TEST_API_KEY);
  });

  it("sends --limit and --offset as the limit and offset query parameters", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/content-types"), ({ request }) => {
        seen = request;
        return HttpResponse.json(CONTENT_TYPES);
      }),
    );

    await runCli(["content-types", "list", "--limit", "25", "--offset", "50"]);

    const params = new URL(seen?.url ?? "").searchParams;
    expect(params.get("limit")).toBe("25");
    expect(params.get("offset")).toBe("50");
  });

  it("sends only the paging parameter that was given", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/content-types"), ({ request }) => {
        seen = request;
        return HttpResponse.json(CONTENT_TYPES);
      }),
    );

    await runCli(["content-types", "list", "--limit", "5"]);

    const params = new URL(seen?.url ?? "").searchParams;
    expect(params.get("limit")).toBe("5");
    expect(params.has("offset")).toBe(false);
  });
});

describe("content-types create, on the wire", () => {
  it("POSTs the parsed --data object verbatim, nested config included", async () => {
    let body: unknown;
    let seen: Request | undefined;
    server.use(
      http.post(apiUrl("/org/content-types"), async ({ request }) => {
        seen = request;
        body = await request.json();
        return HttpResponse.json(ONE_TYPE);
      }),
    );

    const payload = {
      name: "Blog Post",
      config: { template: "Write about {{topic}}", writing_rules: ["No hype", "Cite sources"] },
    };
    await runCli(["content-types", "create", "--data", JSON.stringify(payload)]);

    expect(seen?.method).toBe("POST");
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/content-types");
    expect(seen?.headers.get("content-type")).toBe("application/json");
    // Verbatim: the CLI is a transport here, not a translator.
    expect(body).toEqual(payload);
  });
});

describe("content-types get, on the wire", () => {
  it("GETs the content type's own path", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/content-types/:id"), ({ request }) => {
        seen = request;
        return HttpResponse.json(ONE_TYPE);
      }),
    );

    await runCli(["content-types", "get", "ct-1"]);

    expect(seen?.method).toBe("GET");
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/content-types/ct-1");
  });
});

describe("content-types update and patch, on the wire", () => {
  it("uses PUT for update, so the body replaces the record", async () => {
    let seen: Request | undefined;
    let body: unknown;
    server.use(
      http.put(apiUrl("/org/content-types/:id"), async ({ request }) => {
        seen = request;
        body = await request.json();
        return HttpResponse.json(ONE_TYPE);
      }),
    );

    const payload = { name: "Blog Post v2", config: { template: "Rewritten" } };
    await runCli(["content-types", "update", "ct-1", "--data", JSON.stringify(payload)]);

    expect(seen?.method).toBe("PUT");
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/content-types/ct-1");
    expect(body).toEqual(payload);
  });

  it("uses PATCH for patch, so untouched fields survive", async () => {
    let seen: Request | undefined;
    let body: unknown;
    server.use(
      http.patch(apiUrl("/org/content-types/:id"), async ({ request }) => {
        seen = request;
        body = await request.json();
        return HttpResponse.json(ONE_TYPE);
      }),
    );

    const payload = { config: { template: "Only this changes" } };
    await runCli(["content-types", "patch", "ct-1", "--data", JSON.stringify(payload)]);

    // The whole reason both commands exist. A PUT here would erase `name`.
    expect(seen?.method).toBe("PATCH");
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/content-types/ct-1");
    expect(body).toEqual(payload);
  });
});

describe("content-types delete, on the wire", () => {
  it("DELETEs the content type's own path", async () => {
    let seen: Request | undefined;
    server.use(
      http.delete(apiUrl("/org/content-types/:id"), ({ request }) => {
        seen = request;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await runCli(["content-types", "delete", "ct-2"]);

    expect(seen?.method).toBe("DELETE");
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/content-types/ct-2");
  });
});

describe("content-types, on success", () => {
  it("prints the list payload unmodified under --output json", async () => {
    server.use(http.get(apiUrl("/org/content-types"), () => HttpResponse.json(CONTENT_TYPES)));

    const res = await runCli(["content-types", "list", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.json()).toEqual(CONTENT_TYPES);
    expect(res.stderr).toBe("");
  });

  it("renders one row per content type under --output table", async () => {
    server.use(http.get(apiUrl("/org/content-types"), () => HttpResponse.json(CONTENT_TYPES)));

    const res = await runCli(["content-types", "list", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("content_type_id");
    expect(res.stdout).toContain("ct-1");
    expect(res.stdout).toContain("FAQ");
  });

  it("renders a readable block per content type by default", async () => {
    server.use(http.get(apiUrl("/org/content-types"), () => HttpResponse.json(CONTENT_TYPES)));

    const res = await runCli(["content-types", "list"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Blog Post");
    expect(res.stdout).toContain("FAQ");
  });

  it("says so plainly when there are no content types", async () => {
    server.use(http.get(apiUrl("/org/content-types"), () => HttpResponse.json({ items: [] })));

    const res = await runCli(["content-types", "list"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("items");
  });

  it("prints one content type, nested config and all, under --output json", async () => {
    server.use(http.get(apiUrl("/org/content-types/:id"), () => HttpResponse.json(ONE_TYPE)));

    const res = await runCli(["content-types", "get", "ct-1", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.json()).toEqual(ONE_TYPE);
    expect(res.stderr).toBe("");
  });

  it("renders one content type as field/value rows under --output table", async () => {
    server.use(http.get(apiUrl("/org/content-types/:id"), () => HttpResponse.json(ONE_TYPE)));

    const res = await runCli(["content-types", "get", "ct-1", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("field");
    expect(res.stdout).toContain("name");
    expect(res.stdout).toContain("Blog Post");
  });

  it("renders one content type as key/value lines by default, config serialized", async () => {
    server.use(http.get(apiUrl("/org/content-types/:id"), () => HttpResponse.json(ONE_TYPE)));

    const res = await runCli(["content-types", "get", "ct-1"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Blog Post");
    // A nested object must not render as "[object Object]".
    expect(res.stdout).toContain("template");
    expect(res.stdout).not.toContain("[object Object]");
  });

  it("prints the created type on stdout and the tick on stderr", async () => {
    server.use(http.post(apiUrl("/org/content-types"), () => HttpResponse.json(ONE_TYPE)));

    const res = await runCli(["content-types", "create", "--data", '{"name":"Blog Post"}']);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("ct-1");
    expect(res.stdout).not.toContain("✓");
    expect(res.stderr).toContain("created");
  });
});

describe("content-types delete, on confirmation", () => {
  it("puts the tick on stderr and leaves stdout empty in plain mode", async () => {
    server.use(
      http.delete(apiUrl("/org/content-types/:id"), () => new HttpResponse(null, { status: 204 })),
    );

    const res = await runCli(["content-types", "delete", "ct-1"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("deleted");
  });

  it("prints a parseable object on stdout under --output json", async () => {
    server.use(
      http.delete(apiUrl("/org/content-types/:id"), () => new HttpResponse(null, { status: 204 })),
    );

    const res = await runCli(["content-types", "delete", "ct-1", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.json()).toMatchObject({ ok: true });
    expect(res.stderr).toBe("");
  });
});
