/**
 * Command layer: `senso prompts`, including the nested `prompts tags` group.
 *
 * `prompts` and `questions` are two vocabularies over one table: a prompt_id IS
 * a geo_question_id, and `prompts delete` and `questions delete` remove the same
 * row and the same run history. An agent that believes they are two resources
 * will delete a "question" to keep the "prompt", so the help text that says so
 * is asserted here as a feature, not as documentation.
 *
 * Beyond that, what is worth protecting:
 *
 *   - `tags set` REPLACES the whole set. A forgotten flag used to PUT `{}`,
 *     which the API reads as "no tags", so an incomplete command line silently
 *     cleared every tag. Clearing now has to be spelled --clear.
 *   - `tags remove` picks a different route per flag: --id deletes a
 *     sub-resource, --name deletes the collection with a query parameter. Two
 *     requests behind one command; swapping them detaches the wrong tag.
 *   - Ids, `--sort`, `--limit` and the funnel stage inside `--data` are checked
 *     before the request. Every such test registers no MSW handler, so reaching
 *     the network fails the test that did it.
 *   - The fixtures are the API's real shapes (dto.OrgPromptListResponse,
 *     dto.OrgPromptDetailResponse, dto.TagResponse in senso-api
 *     internal/api/dto). An invented field name is how a blank table column
 *     ships green, so `--output table` is asserted to raise no
 *     "the API did not return" warning.
 *
 * Failure branches come first, as in tests/commands/roles.test.ts.
 */

import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../setup.js";
import { apiUrl, envelope, errorEnvelope, runCli } from "../helpers.js";

const PROMPT_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const OTHER_PROMPT_ID = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";
const MISSING_ID = "00000000-0000-4000-8000-000000000000";
const ORG_ID = "1f8b5c2e-77a1-4a3b-9f0c-6d2e1b4a7c93";
const GEO_POOL_ID = "6f1c9a2b-4d8e-4c3a-9f7b-2e5d8c1a3b4f";
const TAG_ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const OTHER_TAG_ID = "5c4d0e3a-9e5e-4a7f-9b3d-1c2f4a6b8d0e";

/** dto.TagResponse. The counts are pointers and omitted unless asked for. */
const TAG = {
  id: TAG_ID,
  org_id: ORG_ID,
  name: "crm",
  curated: true,
  created_at: "2026-03-01T00:00:00Z",
  updated_at: "2026-03-01T00:00:00Z",
};

/** dto.OrgPromptListResponse: prompts[] plus the page the API served. */
const PROMPTS = {
  prompts: [
    {
      prompt_id: PROMPT_ID,
      text: "What are the best CRMs for a 20-person agency?",
      type: "decision",
      tags: [TAG],
      created_at: "2026-03-01T00:00:00Z",
      updated_at: "2026-03-01T00:00:00Z",
    },
    {
      prompt_id: OTHER_PROMPT_ID,
      text: "How do agencies choose a CRM?",
      type: "consideration",
      tags: [],
      created_at: "2026-03-02T00:00:00Z",
      updated_at: "2026-03-02T00:00:00Z",
    },
  ],
  total: 2,
  limit: 50,
  offset: 0,
};

/** dto.OrgPromptDetailResponse, with one run and the nesting it really has. */
const PROMPT_WITH_RUNS = {
  prompt_id: PROMPT_ID,
  org_id: ORG_ID,
  text: "What are the best CRMs for a 20-person agency?",
  type: "decision",
  geo_pool_id: GEO_POOL_ID,
  scope: "org",
  tags: [TAG],
  created_at: "2026-03-01T00:00:00Z",
  updated_at: "2026-03-01T00:00:00Z",
  runs: [
    {
      run_id: "2a9c4e61-5d3b-4f8a-8c1e-7b6d5a4f3e2d",
      response_text: "For a 20-person agency, Acme CRM is the usual recommendation.",
      model: "chatgpt",
      country: "us",
      region: null,
      target_mentioned: true,
      target_sov: 0.42,
      target_rank: 1,
      target_sentiment: 0.8,
      is_latest: true,
      evals: [
        {
          mention_id: "8d2f7b1c-6a4e-4d9f-8b3c-5e7a1f2d4c6b",
          org: "Acme",
          text: "Acme CRM",
          rank: 1,
          sentiment: "positive",
          is_target_org: true,
        },
      ],
      claims: [
        {
          claim_id: "4e6b8d2a-1c3f-4a5e-9d7b-8c2a4f6e1b3d",
          text: "Acme CRM is priced per seat.",
          order: 0,
          sentiment: "neutral",
          target_mentioned: true,
          citations: [
            {
              citation_id: "7b3d5f1a-2e4c-4b6d-8a9f-1c3e5d7b9a2f",
              source_url: "https://example.com/crm-pricing",
              citation_type: "web",
              order: 0,
            },
          ],
        },
      ],
      competitors: [],
      created_at: "2026-03-03T00:00:00Z",
    },
  ],
};

/** The same prompt before the first scheduled run: the normal state at creation. */
const PROMPT_WITHOUT_RUNS = { ...PROMPT_WITH_RUNS, runs: [] };

/** POST /org/prompts answers with a dto.OrgPromptListItem, tags always empty. */
const CREATED_PROMPT = {
  prompt_id: PROMPT_ID,
  text: "What are the best CRMs for a 20-person agency?",
  type: "decision",
  tags: [],
  created_at: "2026-03-01T00:00:00Z",
  updated_at: "2026-03-01T00:00:00Z",
};

/** The tag endpoints answer with a BARE array of dto.TagResponse, no envelope. */
const TAGS = [TAG];

/** Commander wraps help at the terminal width, so compare on one line. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ");
}

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

  it("says which of the four things a 403 means when the product is missing", async () => {
    // The GEO product gate, not a scope problem: "an org admin can widen it" is
    // advice that cannot work here, and it is what this used to say.
    server.use(
      http.post(apiUrl("/org/prompts"), () =>
        HttpResponse.json({ error: "organization does not have product geo" }, { status: 403 }),
      ),
    );

    const res = await runCli([
      "prompts",
      "create",
      "--data",
      '{"question_text":"What are the best CRMs?","type":"decision"}',
    ]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Permission denied");
    expect(res.stderr).toContain("does not have the product");
  });

  it("exits 4 naming the prompt, the id and the command that lists them", async () => {
    server.use(
      http.get(apiUrl("/org/prompts/:promptId"), () =>
        HttpResponse.json({ error: "Prompt not found" }, { status: 404 }),
      ),
    );

    const res = await runCli(["prompts", "get", MISSING_ID, "--output", "json"]);

    expect(res.exitCode).toBe(4);
    expect(res.stdout).toBe("");
    expect(errorEnvelope(res).error).toMatchObject({
      code: "not_found",
      status: 404,
      field: "prompt_id",
      received: MISSING_ID,
      hint: "List them with `senso prompts list`.",
      request: { method: "GET", path: `/org/prompts/${MISSING_ID}` },
    });
    expect(errorEnvelope(res).error.message).toContain(`Prompt ${MISSING_ID} not found`);
  });

  it("exits 1 on a 500 and says retrying is worth it", async () => {
    server.use(http.get(apiUrl("/org/prompts"), () => new HttpResponse(null, { status: 500 })));

    const res = await runCli(["prompts", "list"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("server-side failure");
    expect(res.stderr).toContain("Retry shortly");
  });

  it("exits 1 on a 503 and says retrying is precisely what will not work", async () => {
    server.use(http.get(apiUrl("/org/prompts"), () => new HttpResponse(null, { status: 503 })));

    const res = await runCli(["prompts", "list"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("not a transient failure");
  });

  it("exits 5 when the API rate-limits, because retrying is the right response", async () => {
    server.use(http.get(apiUrl("/org/prompts"), () => new HttpResponse(null, { status: 429 })));

    const res = await runCli(["prompts", "list"]);

    expect(res.exitCode).toBe(5);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Rate limited");
  });

  it("reports a malformed body rather than throwing a parse error at the user", async () => {
    server.use(http.get(apiUrl("/org/prompts"), () => new HttpResponse("<html>nope</html>")));

    const res = await runCli(["prompts", "list"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Invalid JSON response");
  });

  it("writes the failure envelope to stderr, leaving stdout empty, under --output json", async () => {
    server.use(
      http.get(apiUrl("/org/prompts"), () => HttpResponse.json({ error: "nope" }, { status: 403 })),
    );

    const res = await runCli(["prompts", "list", "--output", "json"]);

    expect(res.exitCode).toBe(3);
    // The important half: a caller redirecting stdout to a file gets an empty
    // file, not a file containing an error object it would later read as data.
    expect(res.stdout).toBe("");
    expect(errorEnvelope(res)).toMatchObject({
      ok: false,
      command: "prompts list",
      error: { code: "forbidden", status: 403 },
    });
  });
});

describe("prompts, when the command line is wrong", () => {
  // Nothing in this block registers a handler: reaching the network would fail
  // the test that did it, which is how "validated before the request" is proved.
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

  it("exits 2 naming the missing key when --data has no type", async () => {
    const res = await runCli(["prompts", "create", "--data", '{"question_text":"hi"}']);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("missing a required key: type");
  });

  it("exits 2 on a key the API would have ignored, rather than looking like a write", async () => {
    const res = await runCli([
      "prompts",
      "create",
      "--data",
      '{"question_text":"hi","type":"decision","tags":["crm"]}',
    ]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("unknown key: tags");
  });

  it("exits 2 with the four funnel stages in error.allowed when type is not one", async () => {
    // The set an agent needs is in the payload, not only in the sentence: this
    // is what lets it fix its own command line without parsing prose.
    const res = await runCli([
      "prompts",
      "create",
      "--data",
      '{"question_text":"hi","type":"not-a-stage"}',
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(errorEnvelope(res).error).toMatchObject({
      code: "usage",
      field: "type",
      received: "not-a-stage",
      allowed: ["awareness", "consideration", "evaluation", "decision"],
    });
  });

  it("exits 2 when question_text is longer than the 500 this endpoint stores", async () => {
    const res = await runCli([
      "prompts",
      "create",
      "--data",
      JSON.stringify({ question_text: "x".repeat(501), type: "decision" }),
    ]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("501 characters");
    expect(res.stderr).toContain("at most 500");
  });

  it("exits 2 naming the id space when <promptId> is not a UUID", async () => {
    const res = await runCli(["prompts", "get", "p-1", "--output", "json"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(errorEnvelope(res).error).toMatchObject({
      code: "usage",
      field: "<promptId>",
      received: "p-1",
    });
    expect(errorEnvelope(res).error.hint).toContain("senso prompts list");
  });

  it("exits 2 and names the valid sort orders when --sort is not one of them", async () => {
    const res = await runCli(["prompts", "list", "--sort", "not_a_sort_order"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain('Invalid --sort: "not_a_sort_order"');
    expect(res.stderr).toContain("created_desc, created_asc, text_asc, text_desc");
  });

  it("exits 2 rather than silently serving a smaller page when --limit is over 100", async () => {
    // The API clamps a larger page instead of reporting it, so `--limit 500`
    // used to return a different page than the one that was asked for.
    const res = await runCli(["prompts", "list", "--limit", "500"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("out of range (1 to 100)");
  });

  it("exits 2 rather than clearing every tag when tags set is given no flag", async () => {
    // PUT with an empty body is how the API says "no tags". A forgotten flag
    // must not be spelled the same way as "remove them all".
    const res = await runCli(["prompts", "tags", "set", PROMPT_ID]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Provide --names, --ids or --clear.");
  });

  it("exits 2 when tags set is asked to clear and to set at the same time", async () => {
    const res = await runCli(["prompts", "tags", "set", PROMPT_ID, "--clear", "--names", "crm"]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("--clear cannot be combined");
  });

  it("exits 2 naming every bad tag id at once, not one round trip each", async () => {
    const res = await runCli([
      "prompts",
      "tags",
      "set",
      PROMPT_ID,
      "--ids",
      `${TAG_ID},t-9,t-10`,
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    expect(errorEnvelope(res).error).toMatchObject({ field: "--ids", received: "t-9, t-10" });
  });

  it("exits 2 when tags add is given neither --name nor --id", async () => {
    const res = await runCli(["prompts", "tags", "add", PROMPT_ID]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Provide --name or --id");
  });

  it("exits 2 when tags add is given both, rather than picking one silently", async () => {
    // --id used to win, so a caller who meant the name watched a different tag
    // move and nothing said so.
    const res = await runCli(["prompts", "tags", "add", PROMPT_ID, "--name", "crm", "--id", TAG_ID]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("Pass --name or --id, not both.");
  });

  it("exits 2 when tags remove is given neither --name nor --id", async () => {
    const res = await runCli(["prompts", "tags", "remove", PROMPT_ID]);

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
});

describe("prompts create, get and delete, on the wire", () => {
  it("POSTs the question text and the canonical stage to /org/prompts", async () => {
    let body: unknown;
    let seen: Request | undefined;
    server.use(
      http.post(apiUrl("/org/prompts"), async ({ request }) => {
        seen = request;
        body = await request.json();
        return HttpResponse.json(CREATED_PROMPT, { status: 201 });
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

  it("rewrites a legacy stage spelling instead of rejecting a value the API takes", async () => {
    // services.NormalizeQuestionType accepts these; refusing them here would
    // make the CLI stricter than the endpoint it wraps.
    let body: unknown;
    server.use(
      http.post(apiUrl("/org/prompts"), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(CREATED_PROMPT, { status: 201 });
      }),
    );

    await runCli([
      "prompts",
      "create",
      "--data",
      '{"question_text":"What are the best CRMs?","type":"Brand-Specific"}',
    ]);

    expect(body).toEqual({ question_text: "What are the best CRMs?", type: "decision" });
  });

  it("GETs /org/prompts/<promptId>", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/prompts/:promptId"), ({ request }) => {
        seen = request;
        return HttpResponse.json(PROMPT_WITH_RUNS);
      }),
    );

    await runCli(["prompts", "get", PROMPT_ID]);

    expect(seen?.method).toBe("GET");
    expect(new URL(seen!.url).pathname).toBe(`/api/v1/org/prompts/${PROMPT_ID}`);
  });

  it("DELETEs /org/prompts/<promptId> with no body", async () => {
    let seen: Request | undefined;
    server.use(
      http.delete(apiUrl("/org/prompts/:promptId"), ({ request }) => {
        seen = request;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const res = await runCli(["prompts", "delete", PROMPT_ID]);

    expect(res.exitCode).toBe(0);
    expect(seen?.method).toBe("DELETE");
    expect(new URL(seen!.url).pathname).toBe(`/api/v1/org/prompts/${PROMPT_ID}`);
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

    await runCli(["prompts", "tags", "list", PROMPT_ID]);

    expect(seen?.method).toBe("GET");
    expect(new URL(seen!.url).pathname).toBe(`/api/v1/org/prompts/${PROMPT_ID}/tags`);
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

    await runCli([
      "prompts",
      "tags",
      "set",
      PROMPT_ID,
      "--names",
      "crm, saas ,",
      "--ids",
      `${TAG_ID},${OTHER_TAG_ID}`,
    ]);

    expect(seen?.method).toBe("PUT");
    expect(new URL(seen!.url).pathname).toBe(`/api/v1/org/prompts/${PROMPT_ID}/tags`);
    // Whitespace trimmed and empty segments dropped, so a trailing comma in a
    // shell-quoted list does not become an empty tag name.
    expect(body).toEqual({ tag_names: ["crm", "saas"], tag_ids: [TAG_ID, OTHER_TAG_ID] });
  });

  it("PUTs an empty object only when --clear asked for it", async () => {
    let body: unknown;
    server.use(
      http.put(apiUrl("/org/prompts/:promptId/tags"), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json([]);
      }),
    );

    const res = await runCli(["prompts", "tags", "set", PROMPT_ID, "--clear"]);

    expect(res.exitCode).toBe(0);
    expect(body).toEqual({});
    expect(res.stderr).toContain(`Every tag was removed from prompt ${PROMPT_ID}.`);
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

    await runCli(["prompts", "tags", "add", PROMPT_ID, "--name", "crm"]);

    expect(seen?.method).toBe("POST");
    expect(body).toEqual({ tag_name: "crm" });
  });

  it("attaches by id as tag_id", async () => {
    let body: unknown;
    server.use(
      http.post(apiUrl("/org/prompts/:promptId/tags"), async ({ request }) => {
        body = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await runCli(["prompts", "tags", "add", PROMPT_ID, "--id", TAG_ID]);

    expect(body).toEqual({ tag_id: TAG_ID });
  });

  it("detaches by id through the sub-resource path", async () => {
    let seen: Request | undefined;
    server.use(
      http.delete(apiUrl("/org/prompts/:promptId/tags/:tagId"), ({ request }) => {
        seen = request;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const res = await runCli(["prompts", "tags", "remove", PROMPT_ID, "--id", TAG_ID]);

    expect(res.exitCode).toBe(0);
    expect(seen?.method).toBe("DELETE");
    expect(new URL(seen!.url).pathname).toBe(`/api/v1/org/prompts/${PROMPT_ID}/tags/${TAG_ID}`);
  });

  it("detaches by name through a query parameter on the collection", async () => {
    let seen: Request | undefined;
    server.use(
      http.delete(apiUrl("/org/prompts/:promptId/tags"), ({ request }) => {
        seen = request;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const res = await runCli(["prompts", "tags", "remove", PROMPT_ID, "--name", "crm"]);

    expect(res.exitCode).toBe(0);
    expect(seen?.method).toBe("DELETE");
    expect(new URL(seen!.url).pathname).toBe(`/api/v1/org/prompts/${PROMPT_ID}/tags`);
    expect(new URL(seen!.url).searchParams.get("name")).toBe("crm");
  });
});

describe("prompts list, on success", () => {
  it("carries the payload unmodified in the envelope's data under --output json", async () => {
    server.use(http.get(apiUrl("/org/prompts"), () => HttpResponse.json(PROMPTS)));

    const res = await runCli(["prompts", "list", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toEqual(PROMPTS);
    // Nothing decorative alongside it: no banner, no paging line.
    expect(res.stderr).toBe("");
  });

  it("reports where the page sits, so a caller knows whether to ask for more", async () => {
    server.use(http.get(apiUrl("/org/prompts"), () => HttpResponse.json(PROMPTS)));

    const res = await runCli(["prompts", "list", "--output", "json"]);

    expect(envelope(res).page).toMatchObject({
      offset: 0,
      limit: 50,
      returned: 2,
      total: 2,
      has_more: false,
    });
  });

  it("hands back a runnable next-page command that keeps the caller's filters", async () => {
    server.use(
      http.get(apiUrl("/org/prompts"), () =>
        HttpResponse.json({ ...PROMPTS, total: 120, limit: 2, offset: 0 }),
      ),
    );

    const res = await runCli([
      "prompts",
      "list",
      "--limit",
      "2",
      "--search",
      "crm",
      "--output",
      "json",
    ]);

    expect(envelope(res).page?.next).toBe("senso prompts list --limit 2 --offset 2 --search crm");
  });

  it("renders one row per prompt under --output table, with the columns it declared", async () => {
    server.use(http.get(apiUrl("/org/prompts"), () => HttpResponse.json(PROMPTS)));

    const res = await runCli(["prompts", "list", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    for (const column of ["prompt_id", "text", "type", "created_at"]) {
      expect(res.stdout).toContain(column);
    }
    expect(res.stdout).toContain(PROMPT_ID);
    expect(res.stdout).toContain("consideration");
    // Every declared column exists on the rows, so the renderer has nothing to
    // complain about. This is the assertion that would have caught the blank
    // column `tags list` once shipped.
    expect(res.stderr).not.toContain("the API did not return");
  });

  it("renders a readable block per prompt by default, with the text untruncated", async () => {
    server.use(http.get(apiUrl("/org/prompts"), () => HttpResponse.json(PROMPTS)));

    const res = await runCli(["prompts", "list"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("What are the best CRMs for a 20-person agency?");
    expect(res.stdout).toContain("decision");
    expect(res.stderr).toContain("Showing 1–2 of 2.");
  });

  it("says the list is empty, and on stderr why --search may be the reason", async () => {
    server.use(
      http.get(apiUrl("/org/prompts"), () =>
        HttpResponse.json({ prompts: [], total: 0, limit: 50, offset: 0 }),
      ),
    );

    const res = await runCli(["prompts", "list", "--search", "nothing matches this"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("No prompts found.");
    expect(res.stderr).toContain("--search matches the question text only");
  });
});

describe("prompts get, on success", () => {
  it("carries the run history unmodified under --output json", async () => {
    server.use(
      http.get(apiUrl("/org/prompts/:promptId"), () => HttpResponse.json(PROMPT_WITH_RUNS)),
    );

    const res = await runCli(["prompts", "get", PROMPT_ID, "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toEqual(PROMPT_WITH_RUNS);
    expect(res.stderr).toBe("");
  });

  it("shows the prompt and its runs as blocks, not as one line of JSON", async () => {
    // The citations are the point of the command: they are three levels deep,
    // and they used to be stringified into a cell.
    server.use(
      http.get(apiUrl("/org/prompts/:promptId"), () => HttpResponse.json(PROMPT_WITH_RUNS)),
    );

    const res = await runCli(["prompts", "get", PROMPT_ID]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("What are the best CRMs for a 20-person agency?");
    expect(res.stdout).toContain("chatgpt");
    expect(res.stdout).toContain("https://example.com/crm-pricing");
    expect(res.stdout).not.toContain('{"citation_id"');
  });

  it("says an empty run history is the scheduler's doing, not a failure", async () => {
    // A prompt created since the last run has no runs, which is
    // indistinguishable from "nothing works" unless the CLI says which it is.
    server.use(
      http.get(apiUrl("/org/prompts/:promptId"), () => HttpResponse.json(PROMPT_WITHOUT_RUNS)),
    );

    const res = await runCli(["prompts", "get", PROMPT_ID, "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(envelope(res).warnings?.join(" ")).toContain("no runs yet");
    expect(envelope(res).next).toContainEqual({
      why: "See which days runs fire",
      command: "senso run-config schedule",
    });
  });
});

describe("prompts create, on success", () => {
  it("puts the created prompt on stdout and the follow-ups on stderr", async () => {
    server.use(http.post(apiUrl("/org/prompts"), () => HttpResponse.json(CREATED_PROMPT)));

    const res = await runCli([
      "prompts",
      "create",
      "--data",
      '{"question_text":"What are the best CRMs?","type":"decision"}',
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain(PROMPT_ID);
    expect(res.stderr).toContain("What you can do next");
    expect(res.stdout).not.toContain("What you can do next");
  });

  it("tells a JSON caller that tags arrive later and that creating does not run it", async () => {
    // Under --output json stderr is silent, so guidance that is not in the
    // envelope reaches nobody — and every published Senso skill passes it.
    server.use(http.post(apiUrl("/org/prompts"), () => HttpResponse.json(CREATED_PROMPT)));

    const res = await runCli([
      "prompts",
      "create",
      "--data",
      '{"question_text":"What are the best CRMs?","type":"decision"}',
      "--output",
      "json",
    ]);

    expect(res.data()).toEqual(CREATED_PROMPT);
    expect(envelope(res).next).toEqual([
      {
        why: "Tags are assigned asynchronously; read them back",
        command: `senso prompts tags list ${PROMPT_ID}`,
      },
      {
        why: "Prompts run on the org schedule, not on creation",
        command: "senso run-config schedule",
      },
    ]);
  });
});

describe("prompts tags list and set, on success", () => {
  it("renders the bare array the API returns with id, name and curated", async () => {
    server.use(http.get(apiUrl("/org/prompts/:promptId/tags"), () => HttpResponse.json(TAGS)));

    const res = await runCli(["prompts", "tags", "list", PROMPT_ID, "--output", "table"]);

    expect(res.exitCode).toBe(0);
    for (const column of ["id", "name", "curated"]) {
      expect(res.stdout).toContain(column);
    }
    expect(res.stdout).toContain(TAG_ID);
    expect(res.stdout).toContain("crm");
    expect(res.stderr).not.toContain("the API did not return");
  });

  it("warns that a set replaced the whole collection, not added to it", async () => {
    server.use(http.put(apiUrl("/org/prompts/:promptId/tags"), () => HttpResponse.json(TAGS)));

    const res = await runCli([
      "prompts",
      "tags",
      "set",
      PROMPT_ID,
      "--names",
      "crm",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toEqual(TAGS);
    expect(envelope(res).warnings?.join(" ")).toContain("any others were removed");
  });

  it("says the prompt has no tags rather than printing an empty block", async () => {
    server.use(http.get(apiUrl("/org/prompts/:promptId/tags"), () => HttpResponse.json([])));

    const res = await runCli(["prompts", "tags", "list", PROMPT_ID]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("No tags found.");
    expect(res.stderr).toContain(`senso prompts tags add ${PROMPT_ID} --name <tag>`);
  });
});

describe("prompts delete and tags remove, confirming without a payload", () => {
  it("names what was deleted in the envelope, so a script need not parse a sentence", async () => {
    server.use(
      http.delete(apiUrl("/org/prompts/:promptId"), () => new HttpResponse(null, { status: 204 })),
    );

    const res = await runCli(["prompts", "delete", PROMPT_ID, "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toEqual({ action: "deleted", resource: "prompt", id: PROMPT_ID });
    expect(res.stderr).toBe("");
  });

  it("says the run history went with it, and keeps the ✓ off stdout", async () => {
    server.use(
      http.delete(apiUrl("/org/prompts/:promptId"), () => new HttpResponse(null, { status: 204 })),
    );

    const res = await runCli(["prompts", "delete", PROMPT_ID]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain(`Prompt ${PROMPT_ID} deleted, with its run history.`);
  });

  it("warns that a 204 on a detach is not proof that anything changed", async () => {
    // The API answers 204 whether or not the tag was attached, so silence here
    // would read as confirmation.
    server.use(
      http.delete(
        apiUrl("/org/prompts/:promptId/tags/:tagId"),
        () => new HttpResponse(null, { status: 204 }),
      ),
    );

    const res = await runCli(["prompts", "tags", "remove", PROMPT_ID, "--id", TAG_ID]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain(`Tag detached from prompt ${PROMPT_ID}.`);
    expect(res.stderr).toContain("not proof that anything changed");
  });
});

describe("prompts --help, where an agent learns what a prompt is", () => {
  it("says prompts and questions are the same rows, and the ids are the same UUID", async () => {
    const res = await runCli(["prompts", "--help"]);

    const help = oneLine(res.stdout);
    expect(help).toContain("Prompts and questions are the SAME records");
    expect(help).toContain("prompt_id is the same UUID as geo_question_id");
  });

  it("says delete is soft, permanent from here, and takes the run history with it", async () => {
    const res = await runCli(["prompts", "delete", "--help"]);

    const help = oneLine(res.stdout);
    expect(help).toContain("hide its run history");
    expect(help).toContain("there is no undelete");
    expect(help).toContain("`senso questions delete <id>` is the same operation on the same row");
  });
});
