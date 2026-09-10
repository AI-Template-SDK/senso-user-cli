/**
 * Command layer: `senso prompts`, including the nested `prompts tags` group.
 *
 * Two things here are worth more than any rendering:
 *
 *   - The tag commands translate flags into a body via lib/tag-args.ts:
 *     `--names a,b` becomes `{ tag_names: ["a","b"] }`, `--ids` becomes
 *     `tag_ids`, and `add` prefers `--id` over `--name`. None of that is
 *     visible from the command line, so it is asserted on the wire.
 *   - `tags remove` picks a different route depending on which flag it got:
 *     `--id` deletes a sub-resource path, `--name` deletes the collection with
 *     a query parameter. Those are two different requests behind one command,
 *     and swapping them would silently detach the wrong tag.
 *
 * The rest is the group's contract: the exact request per subcommand, the
 * usage errors that must be caught before a request is made, and stdout
 * carrying the payload and nothing else.
 *
 * Failure branches come first, as in tests/commands/roles.test.ts.
 */

import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../setup.js";
import { apiUrl, runCli } from "../helpers.js";

const PROMPTS = {
  prompts: [
    {
      prompt_id: "p-1",
      text: "What are the best CRMs for startups?",
      type: "decision",
      created_at: "2026-03-01T00:00:00Z",
    },
    {
      prompt_id: "p-2",
      text: "How do I choose a CRM?",
      type: "consideration",
      created_at: "2026-03-02T00:00:00Z",
    },
  ],
};

const ONE_PROMPT = {
  prompt_id: "p-1",
  text: "What are the best CRMs for startups?",
  type: "decision",
  runs: [],
};

const TAGS = { tags: [{ id: "t-1", name: "crm", curated: true }] };

describe("prompts, when the request fails", () => {
  it("exits 3 and explains how to authenticate when there is no API key", async () => {
    const res = await runCli(["prompts", "list"], { withKey: false });

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("no API key found");
    expect(res.stderr).toContain("SENSO_API_KEY");
  });

  it("exits 3 when the API rejects the key", async () => {
    server.use(
      http.get(apiUrl("/org/prompts"), () =>
        HttpResponse.json({ error: "invalid key" }, { status: 401 }),
      ),
    );

    const res = await runCli(["prompts", "list"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Authentication failed");
  });

  it("exits 3 when the key lacks the scope for the operation", async () => {
    server.use(
      http.post(apiUrl("/org/prompts"), () =>
        HttpResponse.json({ error: "read-only key" }, { status: 403 }),
      ),
    );

    const res = await runCli(["prompts", "create", "--data", '{"question_text":"x"}']);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Permission denied");
  });

  it("exits 4 when the prompt id does not exist", async () => {
    server.use(
      http.get(apiUrl("/org/prompts/:promptId"), () => new HttpResponse(null, { status: 404 })),
    );

    const res = await runCli(["prompts", "get", "p-missing"]);

    expect(res.exitCode).toBe(4);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Not found");
  });

  it("exits 1 on a 500 and says it is not the caller's fault", async () => {
    server.use(http.get(apiUrl("/org/prompts"), () => new HttpResponse(null, { status: 503 })));

    const res = await runCli(["prompts", "list"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("not your fault");
  });

  it("exits 5 when the API rate-limits, because retrying is the right response", async () => {
    server.use(http.get(apiUrl("/org/prompts"), () => new HttpResponse(null, { status: 429 })));

    const res = await runCli(["prompts", "list"]);

    expect(res.exitCode).toBe(5);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Rate limited");
  });

  it("writes the failure to stderr as JSON, leaving stdout empty, under --output json", async () => {
    server.use(
      http.get(apiUrl("/org/prompts"), () => HttpResponse.json({ error: "nope" }, { status: 403 })),
    );

    const res = await runCli(["prompts", "list", "--output", "json"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");

    const reported: unknown = JSON.parse(res.stderr);
    expect(reported).toMatchObject({ error: { code: "forbidden", status: 403 } });
  });
});

describe("prompts, when the command line is wrong", () => {
  it("exits 2 when create's --data is not valid JSON", async () => {
    const res = await runCli(["prompts", "create", "--data", "{question_text: hi}"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Invalid JSON in --data");
  });

  it("exits 2 when create's --data is an array rather than an object", async () => {
    const res = await runCli(["prompts", "create", "--data", '[{"question_text":"hi"}]']);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("must be a JSON object");
  });

  it("exits 2 when tags add is given neither --name nor --id", async () => {
    const res = await runCli(["prompts", "tags", "add", "p-1"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Provide --name or --id");
  });

  it("exits 2 when tags remove is given neither --name nor --id", async () => {
    const res = await runCli(["prompts", "tags", "remove", "p-1"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Provide --name or --id");
  });

  it("names the valid formats when --output is not one of them", async () => {
    const res = await runCli(["prompts", "list", "--output", "yaml"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("json, table, plain");
  });
});

describe("prompts list, on the wire", () => {
  it("GETs /org/prompts with no query when no filter flags are given", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/prompts"), ({ request }) => {
        seen = request;
        return HttpResponse.json(PROMPTS);
      }),
    );

    await runCli(["prompts", "list"]);

    expect(seen?.method).toBe("GET");
    expect(new URL(seen!.url).pathname).toBe("/api/v1/org/prompts");
    expect(new URL(seen!.url).search).toBe("");
  });

  it("sends limit, offset, search and sort as query parameters", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/prompts"), ({ request }) => {
        seen = request;
        return HttpResponse.json(PROMPTS);
      }),
    );

    await runCli([
      "prompts",
      "list",
      "--limit",
      "10",
      "--offset",
      "20",
      "--search",
      "best CRM",
      "--sort",
      "created_asc",
    ]);

    const params = new URL(seen!.url).searchParams;
    expect(params.get("limit")).toBe("10");
    expect(params.get("offset")).toBe("20");
    expect(params.get("search")).toBe("best CRM");
    expect(params.get("sort")).toBe("created_asc");
  });

  // --sort is a closed set (created_desc, created_asc, text_asc, text_desc,
  // type_asc, type_desc), checked before the request: no handler is registered
  // here, so this also proves nothing was sent.
  it("exits 2 and names the valid sort orders when --sort is not one of them", async () => {
    const res = await runCli(["prompts", "list", "--sort", "not_a_sort_order"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain('Invalid --sort: "not_a_sort_order"');
    expect(res.stderr).toContain("created_desc, created_asc, text_asc, text_desc");
  });
});

describe("prompts create, get and delete, on the wire", () => {
  it("POSTs the parsed --data object to /org/prompts unchanged", async () => {
    let body: unknown;
    let seen: Request | undefined;
    server.use(
      http.post(apiUrl("/org/prompts"), async ({ request }) => {
        seen = request;
        body = await request.json();
        return HttpResponse.json(ONE_PROMPT, { status: 201 });
      }),
    );

    await runCli([
      "prompts",
      "create",
      "--data",
      '{"question_text":"What are the best CRMs?","type":"decision"}',
    ]);

    expect(seen?.method).toBe("POST");
    expect(seen?.headers.get("content-type")).toBe("application/json");
    expect(body).toEqual({ question_text: "What are the best CRMs?", type: "decision" });
  });

  it("GETs /org/prompts/<promptId>", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/prompts/:promptId"), ({ request }) => {
        seen = request;
        return HttpResponse.json(ONE_PROMPT);
      }),
    );

    await runCli(["prompts", "get", "p-1"]);

    expect(seen?.method).toBe("GET");
    expect(new URL(seen!.url).pathname).toBe("/api/v1/org/prompts/p-1");
  });

  it("DELETEs /org/prompts/<promptId> with no body", async () => {
    let seen: Request | undefined;
    server.use(
      http.delete(apiUrl("/org/prompts/:promptId"), ({ request }) => {
        seen = request;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const res = await runCli(["prompts", "delete", "p-1"]);

    expect(res.exitCode).toBe(0);
    expect(seen?.method).toBe("DELETE");
    expect(new URL(seen!.url).pathname).toBe("/api/v1/org/prompts/p-1");
    expect(seen?.headers.get("content-type")).toBeNull();
  });
});

describe("prompts tags, on the wire", () => {
  it("GETs /org/prompts/<promptId>/tags for a list", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/prompts/:promptId/tags"), ({ request }) => {
        seen = request;
        return HttpResponse.json(TAGS);
      }),
    );

    await runCli(["prompts", "tags", "list", "p-1"]);

    expect(seen?.method).toBe("GET");
    expect(new URL(seen!.url).pathname).toBe("/api/v1/org/prompts/p-1/tags");
  });

  it("splits --names and --ids into tag_names and tag_ids on a PUT", async () => {
    let body: unknown;
    let seen: Request | undefined;
    server.use(
      http.put(apiUrl("/org/prompts/:promptId/tags"), async ({ request }) => {
        seen = request;
        body = await request.json();
        return HttpResponse.json(TAGS);
      }),
    );

    await runCli(["prompts", "tags", "set", "p-1", "--names", "crm, saas ,", "--ids", "t-9,t-10"]);

    expect(seen?.method).toBe("PUT");
    expect(new URL(seen!.url).pathname).toBe("/api/v1/org/prompts/p-1/tags");
    // Whitespace trimmed and empty segments dropped, so a trailing comma in a
    // shell-quoted list does not become an empty tag name.
    expect(body).toEqual({ tag_names: ["crm", "saas"], tag_ids: ["t-9", "t-10"] });
  });

  it("PUTs an empty object when tags set is given neither list, which clears them", async () => {
    let body: unknown;
    server.use(
      http.put(apiUrl("/org/prompts/:promptId/tags"), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ tags: [] });
      }),
    );

    const res = await runCli(["prompts", "tags", "set", "p-1"]);

    expect(res.exitCode).toBe(0);
    expect(body).toEqual({});
  });

  it("attaches by name as tag_name", async () => {
    let body: unknown;
    let seen: Request | undefined;
    server.use(
      http.post(apiUrl("/org/prompts/:promptId/tags"), async ({ request }) => {
        seen = request;
        body = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await runCli(["prompts", "tags", "add", "p-1", "--name", "crm"]);

    expect(seen?.method).toBe("POST");
    expect(body).toEqual({ tag_name: "crm" });
  });

  it("attaches by id as tag_id, and prefers --id when both are given", async () => {
    let body: unknown;
    server.use(
      http.post(apiUrl("/org/prompts/:promptId/tags"), async ({ request }) => {
        body = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await runCli(["prompts", "tags", "add", "p-1", "--name", "crm", "--id", "t-1"]);

    expect(body).toEqual({ tag_id: "t-1" });
  });

  it("detaches by id through the sub-resource path", async () => {
    let seen: Request | undefined;
    server.use(
      http.delete(apiUrl("/org/prompts/:promptId/tags/:tagId"), ({ request }) => {
        seen = request;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const res = await runCli(["prompts", "tags", "remove", "p-1", "--id", "t-1"]);

    expect(res.exitCode).toBe(0);
    expect(seen?.method).toBe("DELETE");
    expect(new URL(seen!.url).pathname).toBe("/api/v1/org/prompts/p-1/tags/t-1");
  });

  it("detaches by name through a query parameter on the collection", async () => {
    let seen: Request | undefined;
    server.use(
      http.delete(apiUrl("/org/prompts/:promptId/tags"), ({ request }) => {
        seen = request;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const res = await runCli(["prompts", "tags", "remove", "p-1", "--name", "crm"]);

    expect(res.exitCode).toBe(0);
    expect(seen?.method).toBe("DELETE");
    expect(new URL(seen!.url).pathname).toBe("/api/v1/org/prompts/p-1/tags");
    expect(new URL(seen!.url).searchParams.get("name")).toBe("crm");
  });
});

describe("prompts list, on success", () => {
  it("prints the payload unmodified under --output json", async () => {
    server.use(http.get(apiUrl("/org/prompts"), () => HttpResponse.json(PROMPTS)));

    const res = await runCli(["prompts", "list", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.json()).toEqual(PROMPTS);
    expect(res.stderr).toBe("");
  });

  it("renders one row per prompt under --output table", async () => {
    server.use(http.get(apiUrl("/org/prompts"), () => HttpResponse.json(PROMPTS)));

    const res = await runCli(["prompts", "list", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("prompt_id");
    expect(res.stdout).toContain("p-1");
    expect(res.stdout).toContain("consideration");
  });

  it("renders a readable block per prompt by default", async () => {
    server.use(http.get(apiUrl("/org/prompts"), () => HttpResponse.json(PROMPTS)));

    const res = await runCli(["prompts", "list"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("decision");
    expect(res.stdout).toContain("How do I choose a CRM?");
  });

  it("says so plainly when the organization has no prompts", async () => {
    server.use(http.get(apiUrl("/org/prompts"), () => HttpResponse.json({ prompts: [] })));

    const res = await runCli(["prompts", "list"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("prompts");
  });
});

describe("prompts get, on success", () => {
  it("prints the single prompt unmodified under --output json", async () => {
    server.use(http.get(apiUrl("/org/prompts/:promptId"), () => HttpResponse.json(ONE_PROMPT)));

    const res = await runCli(["prompts", "get", "p-1", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.json()).toEqual(ONE_PROMPT);
    expect(res.stderr).toBe("");
  });

  it("renders a single prompt as field/value rows under --output table", async () => {
    server.use(http.get(apiUrl("/org/prompts/:promptId"), () => HttpResponse.json(ONE_PROMPT)));

    const res = await runCli(["prompts", "get", "p-1", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("field");
    expect(res.stdout).toContain("p-1");
  });

  it("renders key/value lines by default", async () => {
    server.use(http.get(apiUrl("/org/prompts/:promptId"), () => HttpResponse.json(ONE_PROMPT)));

    const res = await runCli(["prompts", "get", "p-1"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("type");
    expect(res.stdout).toContain("decision");
  });
});

describe("prompts create, on success", () => {
  it("puts the created prompt on stdout and the tick on stderr", async () => {
    server.use(http.post(apiUrl("/org/prompts"), () => HttpResponse.json(ONE_PROMPT)));

    const res = await runCli(["prompts", "create", "--data", '{"question_text":"x"}']);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("p-1");
    expect(res.stderr).toContain("Prompt created.");
    expect(res.stdout).not.toContain("Prompt created.");
  });
});

describe("prompts delete and tags remove, confirming without a payload", () => {
  it("prints a parseable object on stdout under --output json", async () => {
    server.use(
      http.delete(apiUrl("/org/prompts/:promptId"), () => new HttpResponse(null, { status: 204 })),
    );

    const res = await runCli(["prompts", "delete", "p-1", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.json()).toMatchObject({ ok: true });
    expect(res.stderr).toBe("");
  });

  it("puts the ✓ on stderr and leaves stdout empty in plain mode", async () => {
    server.use(
      http.delete(apiUrl("/org/prompts/:promptId"), () => new HttpResponse(null, { status: 204 })),
    );

    const res = await runCli(["prompts", "delete", "p-1"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Prompt p-1 deleted.");
  });

  it("confirms a tag detach on stderr, not stdout", async () => {
    server.use(
      http.delete(
        apiUrl("/org/prompts/:promptId/tags/:tagId"),
        () => new HttpResponse(null, { status: 204 }),
      ),
    );

    const res = await runCli(["prompts", "tags", "remove", "p-1", "--id", "t-1"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Tag detached from prompt p-1.");
  });
});
