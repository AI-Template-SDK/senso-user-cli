/**
 * Command layer: `senso tags`.
 *
 * The tag library grows on its own — Senso auto-tags prompts, KB content and
 * searches — so these commands are the rare, deliberate edits to it. Four
 * things are worth protecting:
 *
 *   - THE ID COLUMN. dto.TagResponse marshals `id`, not `tag_id`. The command
 *     used to declare a `tag_id` column, so every row's first cell was blank,
 *     and the fixture here invented the CLI's spelling — which is exactly why
 *     nothing failed. The fixtures below are dto.TagResponse, and the table
 *     tests assert the id column has values in it;
 *   - `--counts` and `--include-uncurated` are the only query parameters in the
 *     group, and each is sent as the string "true" or not at all; a
 *     `counts=false` would be a different request than the flag promises;
 *   - `update` renames with PATCH, not PUT, because a tag's attachments must
 *     survive the rename — and the caller is warned that the new name is live
 *     everywhere at once;
 *   - `delete` detaches the tag everywhere, so its confirmation must be a
 *     stderr diagnostic in plain mode and a parseable object under
 *     `--output json` — never a sentence on stdout.
 *
 * Failure branches come first, as in tests/commands/roles.test.ts.
 */

import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server, TEST_API_KEY } from "../setup.js";
import { apiUrl, envelope, errorEnvelope, runCli } from "../helpers.js";

const TAG_1 = "9f1c4e2a-5c1d-4d0e-9f7a-2b8c6e1d3a44";
const TAG_2 = "3b6d5c81-7e42-4a9b-9c10-5f2e8d7a1b63";
const ORG = "0c9a1f47-2d58-4b3e-8a71-6f4d9e2c5b08";

/** dto.TagsListResponse: items carry `id`, and counts only under --counts. */
const TAGS = {
  items: [
    {
      id: TAG_1,
      org_id: ORG,
      name: "pricing",
      curated: true,
      created_at: "2026-01-02T03:04:05Z",
      updated_at: "2026-01-02T03:04:05Z",
    },
    {
      id: TAG_2,
      org_id: ORG,
      name: "onboarding",
      curated: true,
      created_at: "2026-01-03T03:04:05Z",
      updated_at: "2026-01-03T03:04:05Z",
    },
  ],
  total_count: 2,
  include_uncurated: false,
  uncurated_hidden_count: 3,
};

/** The same listing with `counts=true`, which adds the seven count fields. */
const TAGS_WITH_COUNTS = {
  items: [
    {
      ...TAGS.items[0],
      prompt_count: 12,
      content_count: 3,
      kb_content_count: 2,
      generated_content_count: 1,
      generated_draft_count: 1,
      generated_published_count: 0,
      kb_search_message_count: 4,
    },
  ],
  total_count: 1,
  include_uncurated: false,
  uncurated_hidden_count: 0,
};

const EMPTY_TAGS = {
  items: [],
  total_count: 0,
  include_uncurated: false,
  uncurated_hidden_count: 7,
};

/** dto.TagResponse from `GET /org/tags/{id}`, where counts are always present. */
const ONE_TAG = {
  id: TAG_1,
  org_id: ORG,
  name: "pricing",
  curated: true,
  prompt_count: 12,
  content_count: 3,
  kb_content_count: 2,
  generated_content_count: 1,
  generated_draft_count: 1,
  generated_published_count: 0,
  kb_search_message_count: 4,
  created_at: "2026-01-02T03:04:05Z",
  updated_at: "2026-01-02T03:04:05Z",
};

/**
 * The first column's cells, as the table rendered them.
 *
 * Located from the rule under the headers rather than from the top of the
 * output, because a list response's non-pagination fields — here
 * `uncurated_hidden_count` — are printed as a header block above the table.
 */
function idColumn(stdout: string): string[] {
  const lines = stdout.split("\n");
  const rule = lines.findIndex((line) => /^\s*─+(?:\s+─+)*\s*$/.test(line));
  return lines
    .slice(rule + 1)
    .map((line) => line.trim().split(/\s{2,}/)[0] ?? "")
    .filter((cell) => cell.length > 0);
}

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
        HttpResponse.json({ error: "write:tag required" }, { status: 403 }),
      ),
    );

    const res = await runCli(["tags", "create", "--name", "pricing"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Permission denied");
  });

  it("names the tag and the id in the 404, rather than saying 'Not found'", async () => {
    server.use(http.get(apiUrl("/org/tags/:id"), () => new HttpResponse(null, { status: 404 })));

    const res = await runCli(["tags", "get", TAG_1, "--output", "json"]);

    expect(res.exitCode).toBe(4);
    expect(res.stdout).toBe("");
    const { error } = errorEnvelope(res);
    expect(error.code).toBe("not_found");
    expect(error.status).toBe(404);
    expect(error.message).toContain(`Tag ${TAG_1}`);
    expect(error.field).toBe("id");
    expect(error.received).toBe(TAG_1);
    expect(error.hint).toContain("senso tags list");
  });

  it("exits 1 on a 409 when the name is already taken, keeping the API's own message", async () => {
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

  it("exits 1 on a 500 and offers the retry that might work", async () => {
    server.use(http.get(apiUrl("/org/tags"), () => new HttpResponse(null, { status: 500 })));

    const res = await runCli(["tags", "list"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("server-side failure");
    expect(res.stderr).toContain("Retry shortly");
  });

  it("exits 1 on a 503 and says retrying is not the answer", async () => {
    server.use(http.get(apiUrl("/org/tags"), () => new HttpResponse(null, { status: 503 })));

    const res = await runCli(["tags", "list"]);

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("not a transient failure");
  });

  it("reports a malformed body rather than throwing a parse error at the user", async () => {
    server.use(http.get(apiUrl("/org/tags"), () => new HttpResponse("<html>nope</html>")));

    const res = await runCli(["tags", "list"]);

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("Invalid JSON response");
  });

  it("writes the failure to stderr as an error envelope, leaving stdout empty", async () => {
    server.use(
      http.get(apiUrl("/org/tags"), () => HttpResponse.json({ error: "nope" }, { status: 403 })),
    );

    const res = await runCli(["tags", "list", "--output", "json"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");

    const reported = errorEnvelope(res);
    expect(reported.ok).toBe(false);
    expect(reported.command).toBe("tags list");
    expect(reported.error).toMatchObject({
      code: "forbidden",
      status: 403,
      request: { method: "GET", path: "/org/tags" },
    });
  });
});

describe("tags, on usage errors", () => {
  // No handler is registered in this block: setup.ts fails any request that
  // reaches the network, so each of these also proves nothing was sent.
  it("exits 2 when create is called without --name", async () => {
    const res = await runCli(["tags", "create"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("--name");
  });

  it("exits 2 when --name is only whitespace, naming the flag", async () => {
    const res = await runCli(["tags", "create", "--name", "   ", "--output", "json"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    const { error } = errorEnvelope(res);
    expect(error.code).toBe("usage");
    expect(error.field).toBe("--name");
  });

  it("exits 2 when --name is longer than the API's 255-character limit", async () => {
    const res = await runCli(["tags", "create", "--name", "x".repeat(256)]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("255");
  });

  it("exits 2 when update is called without --name", async () => {
    const res = await runCli(["tags", "update", TAG_1]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
  });

  it("exits 2 when the id is not a UUID, naming the id space it wanted", async () => {
    const res = await runCli(["tags", "get", "t-1", "--output", "json"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    const { error } = errorEnvelope(res);
    expect(error.code).toBe("usage");
    expect(error.field).toBe("<id>");
    expect(error.received).toBe("t-1");
    expect(error.hint).toContain("senso tags list");
  });

  it("exits 2 and names the valid formats when --output is not one of them", async () => {
    const res = await runCli(["tags", "list", "--output", "yaml"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("json, table, plain");
  });
});

describe("tags list, on the wire", () => {
  it("GETs /org/tags with no query string when neither flag is given", async () => {
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

  it("sends counts=true and include_uncurated=true only when asked", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/tags"), ({ request }) => {
        seen = request;
        return HttpResponse.json(TAGS_WITH_COUNTS);
      }),
    );

    await runCli(["tags", "list", "--counts", "--include-uncurated"]);

    const params = new URL(seen?.url ?? "").searchParams;
    expect(params.get("counts")).toBe("true");
    expect(params.get("include_uncurated")).toBe("true");
  });
});

describe("tags create, get, update and delete, on the wire", () => {
  it("POSTs exactly { name }, trimmed, to /org/tags", async () => {
    let body: unknown;
    let seen: Request | undefined;
    server.use(
      http.post(apiUrl("/org/tags"), async ({ request }) => {
        seen = request;
        body = await request.json();
        return HttpResponse.json(ONE_TAG);
      }),
    );

    await runCli(["tags", "create", "--name", "  pricing  "]);

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

  it("GETs the tag's own path", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/tags/:id"), ({ request }) => {
        seen = request;
        return HttpResponse.json(ONE_TAG);
      }),
    );

    await runCli(["tags", "get", TAG_1]);

    expect(seen?.method).toBe("GET");
    expect(new URL(seen?.url ?? "").pathname).toBe(`/api/v1/org/tags/${TAG_1}`);
  });

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

    await runCli(["tags", "update", TAG_1, "--name", "pricing-2026"]);

    // PATCH, not PUT: a rename must not look like a replacement of the tag.
    expect(seen?.method).toBe("PATCH");
    expect(new URL(seen?.url ?? "").pathname).toBe(`/api/v1/org/tags/${TAG_1}`);
    expect(body).toEqual({ name: "pricing-2026" });
  });

  it("DELETEs the tag's own path", async () => {
    let seen: Request | undefined;
    server.use(
      http.delete(apiUrl("/org/tags/:id"), ({ request }) => {
        seen = request;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await runCli(["tags", "delete", TAG_2]);

    expect(seen?.method).toBe("DELETE");
    expect(new URL(seen?.url ?? "").pathname).toBe(`/api/v1/org/tags/${TAG_2}`);
  });
});

describe("tags list, on success", () => {
  it("prints the payload unmodified inside the envelope, and pages it", async () => {
    server.use(http.get(apiUrl("/org/tags"), () => HttpResponse.json(TAGS)));

    const res = await runCli(["tags", "list", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    const env = envelope<typeof TAGS>(res);
    expect(env.command).toBe("tags list");
    expect(env.data).toEqual(TAGS);
    expect(env.page).toMatchObject({ returned: 2, total: 2, has_more: false });
    // json implies quiet: nothing decorative alongside it.
    expect(res.stderr).toBe("");
  });

  it("fills the id column, because the API's field is `id` and not `tag_id`", async () => {
    // The regression this file exists for. The command asked for `tag_id`,
    // dto.TagResponse returns `id`, and the old fixture invented `tag_id` — so
    // a blank first column on every row shipped and the suite stayed green.
    server.use(http.get(apiUrl("/org/tags"), () => HttpResponse.json(TAGS)));

    const res = await runCli(["tags", "list", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("id");
    expect(idColumn(res.stdout)).toEqual([TAG_1, TAG_2]);
    // And the renderer's own alarm for a column the API never returned is
    // silent, which is the general form of the same bug.
    expect(res.stderr).not.toContain("which the API did not return");
  });

  it("shows the count columns when --counts asked for them", async () => {
    server.use(http.get(apiUrl("/org/tags"), () => HttpResponse.json(TAGS_WITH_COUNTS)));

    const res = await runCli(["tags", "list", "--counts", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("prompt_count");
    expect(res.stdout).toContain("12");
    expect(res.stderr).not.toContain("which the API did not return");
  });

  it("renders a readable block per tag, id included, by default", async () => {
    server.use(http.get(apiUrl("/org/tags"), () => HttpResponse.json(TAGS)));

    const res = await runCli(["tags", "list"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain(TAG_1);
    expect(res.stdout).toContain("pricing");
    expect(res.stdout).toContain("onboarding");
  });

  it("says the library is empty, and that auto-minted tags are hidden by default", async () => {
    server.use(http.get(apiUrl("/org/tags"), () => HttpResponse.json(EMPTY_TAGS)));

    const res = await runCli(["tags", "list"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("No tags found.");
    expect(res.stderr).toContain("--include-uncurated");
  });
});

describe("tags get, update and delete, on success", () => {
  it("prints one tag unmodified under --output json", async () => {
    server.use(http.get(apiUrl("/org/tags/:id"), () => HttpResponse.json(ONE_TAG)));

    const res = await runCli(["tags", "get", TAG_1, "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toEqual(ONE_TAG);
    expect(res.stderr).toBe("");
  });

  it("renders one tag as field/value rows under --output table", async () => {
    server.use(http.get(apiUrl("/org/tags/:id"), () => HttpResponse.json(ONE_TAG)));

    const res = await runCli(["tags", "get", TAG_1, "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("field");
    expect(res.stdout).toContain("prompt_count");
  });

  it("renders one tag as key/value lines by default, id first", async () => {
    server.use(http.get(apiUrl("/org/tags/:id"), () => HttpResponse.json(ONE_TAG)));

    const res = await runCli(["tags", "get", TAG_1]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain(TAG_1);
    expect(res.stdout).toContain("pricing");
  });

  it("prints the renamed tag on stdout and the tick on stderr", async () => {
    server.use(
      http.patch(apiUrl("/org/tags/:id"), () =>
        HttpResponse.json({ ...ONE_TAG, name: "pricing-2026" }),
      ),
    );

    const res = await runCli(["tags", "update", TAG_1, "--name", "pricing-2026"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("pricing-2026");
    expect(res.stdout).not.toContain("✓");
    expect(res.stderr).toContain("Renamed tag");
  });

  it("warns a JSON caller that the new name is live everywhere at once", async () => {
    // Under --output json stderr is silent, so a warning written only there
    // would reach nobody — and a rename is not reversible by re-tagging.
    server.use(
      http.patch(apiUrl("/org/tags/:id"), () =>
        HttpResponse.json({ ...ONE_TAG, name: "pricing-2026" }),
      ),
    );

    const res = await runCli(["tags", "update", TAG_1, "--name", "pricing-2026", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    const env = envelope(res);
    expect(env.warnings?.join(" ")).toContain("every resource this tag is attached to");
    expect(env.next?.[0]?.command).toContain(`senso tags get ${TAG_1}`);
    expect(res.stderr).toBe("");
  });
});

describe("tags delete, on confirmation", () => {
  it("puts the tick on stderr and leaves stdout empty in plain mode", async () => {
    server.use(http.delete(apiUrl("/org/tags/:id"), () => new HttpResponse(null, { status: 204 })));

    const res = await runCli(["tags", "delete", TAG_1]);

    expect(res.exitCode).toBe(0);
    // Nothing was returned, so nothing is payload.
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Deleted tag");
  });

  it("gives a JSON caller a record of what went, not a sentence to parse", async () => {
    server.use(http.delete(apiUrl("/org/tags/:id"), () => new HttpResponse(null, { status: 204 })));

    const res = await runCli(["tags", "delete", TAG_1, "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toEqual({ action: "deleted", resource: "tag", id: TAG_1 });
    expect(res.stderr).toBe("");
  });

  it("says nothing at all when --quiet is passed", async () => {
    server.use(http.delete(apiUrl("/org/tags/:id"), () => new HttpResponse(null, { status: 204 })));

    const res = await runCli(["tags", "delete", TAG_1, "--quiet"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("");
    expect(res.stderr).toBe("");
  });
});
