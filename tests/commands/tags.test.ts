/**
 * Command layer: `senso tags`.
 *
 * The tag library grows on its own — Senso auto-tags prompts, KB content and
 * searches — so these commands are the rare, deliberate edits to it. Three
 * things are worth protecting:
 *
 *   - `--counts` is the only query parameter in the group, and it is sent as the
 *     string "true" or not at all; a `counts=false` would be a different
 *     request than the one this flag promises;
 *   - `update` renames with PATCH, not PUT, because a tag's attachments must
 *     survive the rename;
 *   - `delete` detaches the tag everywhere, so its confirmation must be a
 *     stderr diagnostic in plain mode and a parseable object under
 *     `--output json` — never a sentence on stdout.
 *
 * Failure branches come first, as in tests/commands/roles.test.ts.
 */

import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server, TEST_API_KEY } from "../setup.js";
import { apiUrl, runCli } from "../helpers.js";

const TAGS = {
  tags: [
    { tag_id: "t-1", name: "pricing", created_at: "2026-01-02T03:04:05Z" },
    { tag_id: "t-2", name: "onboarding", created_at: "2026-01-03T03:04:05Z" },
  ],
};

const TAGS_WITH_COUNTS = {
  tags: [
    {
      tag_id: "t-1",
      name: "pricing",
      prompt_count: 12,
      content_count: 3,
      created_at: "2026-01-02T03:04:05Z",
    },
  ],
};

const ONE_TAG = { tag_id: "t-1", name: "pricing", prompt_count: 12, content_count: 3 };

describe("tags, when the request fails", () => {
  it("exits 3 and explains how to authenticate when there is no API key", async () => {
    const res = await runCli(["tags", "list"], { withKey: false });

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("no API key found");
    expect(res.stderr).toContain("SENSO_API_KEY");
  });

  it("exits 3 when the API rejects the key", async () => {
    server.use(
      http.get(apiUrl("/org/tags"), () =>
        HttpResponse.json({ error: "invalid key" }, { status: 401 }),
      ),
    );

    const res = await runCli(["tags", "list"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Authentication failed");
  });

  it("exits 3 when the key is valid but lacks the scope", async () => {
    server.use(
      http.post(apiUrl("/org/tags"), () =>
        HttpResponse.json({ error: "write:tags required" }, { status: 403 }),
      ),
    );

    const res = await runCli(["tags", "create", "--name", "pricing"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Permission denied");
  });

  it("exits 4 when the tag does not exist", async () => {
    server.use(http.get(apiUrl("/org/tags/:id"), () => new HttpResponse(null, { status: 404 })));

    const res = await runCli(["tags", "get", "t-missing"]);

    expect(res.exitCode).toBe(4);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Not found");
  });

  it("exits 1 on a 409 when the name is already taken", async () => {
    server.use(
      http.post(apiUrl("/org/tags"), () =>
        HttpResponse.json({ error: "tag already exists" }, { status: 409 }),
      ),
    );

    const res = await runCli(["tags", "create", "--name", "pricing"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Conflict");
    expect(res.stderr).toContain("tag already exists");
  });

  it("exits 1 on a 500 and says it is not the caller's fault", async () => {
    server.use(http.get(apiUrl("/org/tags"), () => new HttpResponse(null, { status: 500 })));

    const res = await runCli(["tags", "list"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("not your fault");
  });

  it("writes the failure to stderr as JSON, leaving stdout empty, under --output json", async () => {
    server.use(
      http.get(apiUrl("/org/tags"), () => HttpResponse.json({ error: "nope" }, { status: 403 })),
    );

    const res = await runCli(["tags", "list", "--output", "json"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");

    const reported: unknown = JSON.parse(res.stderr);
    expect(reported).toMatchObject({ error: { code: "forbidden", status: 403 } });
  });
});

describe("tags, on usage errors", () => {
  it("exits 2 when create is called without --name", async () => {
    // No handler is registered: setup.ts fails any request that reaches the
    // network, so this also proves nothing was sent.
    const res = await runCli(["tags", "create"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
  });

  it("exits 2 when update is called without --name", async () => {
    const res = await runCli(["tags", "update", "t-1"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
  });

  it("exits 2 and names the valid formats when --output is not one of them", async () => {
    const res = await runCli(["tags", "list", "--output", "yaml"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("json, table, plain");
  });
});

describe("tags list, on the wire", () => {
  it("GETs /org/tags with no query string when --counts is absent", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/tags"), ({ request }) => {
        seen = request;
        return HttpResponse.json(TAGS);
      }),
    );

    await runCli(["tags", "list"]);

    expect(seen?.method).toBe("GET");
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/tags");
    // Not `counts=false`: the flag's absence means "do not compute them".
    expect(new URL(seen?.url ?? "").search).toBe("");
    expect(seen?.headers.get("x-api-key")).toBe(TEST_API_KEY);
  });

  it("sends counts=true when --counts is passed", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/tags"), ({ request }) => {
        seen = request;
        return HttpResponse.json(TAGS_WITH_COUNTS);
      }),
    );

    await runCli(["tags", "list", "--counts"]);

    expect(new URL(seen?.url ?? "").searchParams.get("counts")).toBe("true");
  });
});

describe("tags create, on the wire", () => {
  it("POSTs exactly { name } to /org/tags", async () => {
    let body: unknown;
    let seen: Request | undefined;
    server.use(
      http.post(apiUrl("/org/tags"), async ({ request }) => {
        seen = request;
        body = await request.json();
        return HttpResponse.json(ONE_TAG);
      }),
    );

    await runCli(["tags", "create", "--name", "pricing"]);

    expect(seen?.method).toBe("POST");
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/tags");
    expect(seen?.headers.get("content-type")).toBe("application/json");
    expect(body).toEqual({ name: "pricing" });
  });

  it("sends a name with spaces and punctuation through untouched", async () => {
    let body: unknown;
    server.use(
      http.post(apiUrl("/org/tags"), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(ONE_TAG);
      }),
    );

    await runCli(["tags", "create", "--name", "Q1 pricing & packaging"]);

    expect(body).toEqual({ name: "Q1 pricing & packaging" });
  });
});

describe("tags get, on the wire", () => {
  it("GETs the tag's own path", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/tags/:id"), ({ request }) => {
        seen = request;
        return HttpResponse.json(ONE_TAG);
      }),
    );

    await runCli(["tags", "get", "t-1"]);

    expect(seen?.method).toBe("GET");
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/tags/t-1");
  });
});

describe("tags update, on the wire", () => {
  it("PATCHes the tag's own path with just the new name", async () => {
    let seen: Request | undefined;
    let body: unknown;
    server.use(
      http.patch(apiUrl("/org/tags/:id"), async ({ request }) => {
        seen = request;
        body = await request.json();
        return HttpResponse.json({ ...ONE_TAG, name: "pricing-2026" });
      }),
    );

    await runCli(["tags", "update", "t-1", "--name", "pricing-2026"]);

    // PATCH, not PUT: a rename must not look like a replacement of the tag.
    expect(seen?.method).toBe("PATCH");
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/tags/t-1");
    expect(body).toEqual({ name: "pricing-2026" });
  });
});

describe("tags delete, on the wire", () => {
  it("DELETEs the tag's own path", async () => {
    let seen: Request | undefined;
    server.use(
      http.delete(apiUrl("/org/tags/:id"), ({ request }) => {
        seen = request;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await runCli(["tags", "delete", "t-2"]);

    expect(seen?.method).toBe("DELETE");
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/tags/t-2");
  });
});

describe("tags, on success", () => {
  it("prints the list payload unmodified under --output json", async () => {
    server.use(http.get(apiUrl("/org/tags"), () => HttpResponse.json(TAGS)));

    const res = await runCli(["tags", "list", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.json()).toEqual(TAGS);
    expect(res.stderr).toBe("");
  });

  it("renders one row per tag under --output table", async () => {
    server.use(http.get(apiUrl("/org/tags"), () => HttpResponse.json(TAGS)));

    const res = await runCli(["tags", "list", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("tag_id");
    expect(res.stdout).toContain("t-1");
    expect(res.stdout).toContain("onboarding");
  });

  it("shows the count columns when the response carries them", async () => {
    server.use(http.get(apiUrl("/org/tags"), () => HttpResponse.json(TAGS_WITH_COUNTS)));

    const res = await runCli(["tags", "list", "--counts", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("prompt_count");
    expect(res.stdout).toContain("12");
  });

  it("renders a readable block per tag by default", async () => {
    server.use(http.get(apiUrl("/org/tags"), () => HttpResponse.json(TAGS)));

    const res = await runCli(["tags", "list"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("pricing");
    expect(res.stdout).toContain("onboarding");
  });

  it("prints one tag unmodified under --output json", async () => {
    server.use(http.get(apiUrl("/org/tags/:id"), () => HttpResponse.json(ONE_TAG)));

    const res = await runCli(["tags", "get", "t-1", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.json()).toEqual(ONE_TAG);
    expect(res.stderr).toBe("");
  });

  it("renders one tag as field/value rows under --output table", async () => {
    server.use(http.get(apiUrl("/org/tags/:id"), () => HttpResponse.json(ONE_TAG)));

    const res = await runCli(["tags", "get", "t-1", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("field");
    expect(res.stdout).toContain("prompt_count");
  });

  it("renders one tag as key/value lines by default", async () => {
    server.use(http.get(apiUrl("/org/tags/:id"), () => HttpResponse.json(ONE_TAG)));

    const res = await runCli(["tags", "get", "t-1"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("tag_id");
    expect(res.stdout).toContain("pricing");
  });

  it("prints the renamed tag on stdout and the tick on stderr", async () => {
    server.use(
      http.patch(apiUrl("/org/tags/:id"), () =>
        HttpResponse.json({ ...ONE_TAG, name: "pricing-2026" }),
      ),
    );

    const res = await runCli(["tags", "update", "t-1", "--name", "pricing-2026"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("pricing-2026");
    expect(res.stdout).not.toContain("✓");
    expect(res.stderr).toContain("renamed");
  });
});

describe("tags delete, on confirmation", () => {
  it("puts the tick on stderr and leaves stdout empty in plain mode", async () => {
    server.use(http.delete(apiUrl("/org/tags/:id"), () => new HttpResponse(null, { status: 204 })));

    const res = await runCli(["tags", "delete", "t-1"]);

    expect(res.exitCode).toBe(0);
    // Nothing was returned, so nothing is payload.
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("deleted");
  });

  it("prints a parseable object on stdout under --output json", async () => {
    server.use(http.delete(apiUrl("/org/tags/:id"), () => new HttpResponse(null, { status: 204 })));

    const res = await runCli(["tags", "delete", "t-1", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.json()).toMatchObject({ ok: true });
    expect(res.stderr).toBe("");
  });

  it("says nothing at all when --quiet is passed", async () => {
    server.use(http.delete(apiUrl("/org/tags/:id"), () => new HttpResponse(null, { status: 204 })));

    const res = await runCli(["tags", "delete", "t-1", "--quiet"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("");
    expect(res.stderr).toBe("");
  });
});
