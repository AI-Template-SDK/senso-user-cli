/**
 * Command layer: `senso content-types`.
 *
 * Four of the six subcommands take a raw `--data` blob, and three of them differ
 * only by HTTP method — PUT replaces, PATCH merges. That is what is worth
 * protecting here:
 *
 *   - `update` and `patch` must keep their methods distinct, because sending a
 *     partial body with PUT silently erases a config;
 *   - the whole `config` schema is checked before the request, because the API
 *     drops an unrecognized key without a word: a typo would otherwise read as
 *     a write that succeeded and changed nothing;
 *   - `template_spec` is accepted, validated and then thrown away by the API,
 *     so sending one has to produce a warning rather than silence;
 *   - `--limit` and `--offset` must reach the query string under those names,
 *     and must be absent when the caller did not ask for them.
 *
 * Every fixture here is shaped like dto.ContentTypeResponse in senso-api
 * (internal/api/dto/content_type_dto.go). A fixture that invents a field name
 * is how a blank column ships green.
 *
 * Failure branches come first, as in tests/commands/roles.test.ts.
 */

import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server, TEST_API_KEY } from "../setup.js";
import { apiUrl, envelope, errorEnvelope, runCli } from "../helpers.js";

const ORG_ID = "a1b2c3d4-e5f6-4071-8293-a4b5c6d7e8f9";
const CT_ID = "9c8b7a6d-1111-4222-8333-444455556666";
const CT_ID_2 = "3d4e5f60-2222-4333-8444-555566667777";

/** The canonicalized config the API always stores: all five keys, spec derived. */
const CONFIG = {
  template: "## Introduction (100-150 words)\nSet up the problem.",
  template_spec: {
    parser_version: 1,
    source_format: "freeform_markdown",
    total_word_budget: { min_words: 100, max_words: 150 },
    sections: [
      {
        id: "introduction",
        title: "Introduction",
        instructions: "Set up the problem.",
        word_budget: { min_words: 100, max_words: 150 },
      },
    ],
    parse_warnings: [],
  },
  cta_text: "Talk to us",
  cta_destination: "https://acme.example/demo",
  writing_rules: ["No superlatives without a number"],
};

const ONE_TYPE = {
  content_type_id: CT_ID,
  org_id: ORG_ID,
  name: "Blog Post",
  config: CONFIG,
  created_at: "2026-01-02T03:04:05Z",
  updated_at: "2026-01-04T03:04:05Z",
};

const SECOND_TYPE = {
  content_type_id: CT_ID_2,
  org_id: ORG_ID,
  name: "FAQ",
  config: { ...CONFIG, template: "## Question\n## Answer (max 150 words)" },
  created_at: "2026-01-05T03:04:05Z",
  updated_at: "2026-01-06T03:04:05Z",
};

/** dto.ContentTypeListResponse: the rows plus its own paging metadata. */
const CONTENT_TYPES = {
  content_types: [ONE_TYPE, SECOND_TYPE],
  total: 2,
  limit: 50,
  offset: 0,
};

/** The smallest body the API accepts: name and config are both required. */
const MINIMAL_DATA = '{"name":"Blog Post","config":{"template":"## Introduction"}}';

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

  it("exits 3 and blames the plan, not the scope, when the product is missing", async () => {
    server.use(
      http.post(apiUrl("/org/content-types"), () =>
        HttpResponse.json({ error: "GEO product required" }, { status: 403 }),
      ),
    );

    const res = await runCli(["content-types", "create", "--data", MINIMAL_DATA]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Permission denied");
    // The four meanings of a 403 need different fixes; a product entitlement is
    // a billing question and no amount of widening a key will help.
    expect(res.stderr).toContain("does not have the product");
  });

  it("exits 4 naming the content type and the command that lists them", async () => {
    server.use(
      http.get(apiUrl("/org/content-types/:id"), () =>
        HttpResponse.json({ error: "Content type not found" }, { status: 404 }),
      ),
    );

    const res = await runCli(["content-types", "get", CT_ID, "--output", "json"]);

    expect(res.exitCode).toBe(4);
    expect(res.stdout).toBe("");

    const { error } = errorEnvelope(res);
    expect(error.code).toBe("not_found");
    expect(error.message).toContain(`Content type ${CT_ID}`);
    expect(error.field).toBe("content_type_id");
    expect(error.received).toBe(CT_ID);
    expect(error.hint).toContain("senso content-types list");
  });

  it("exits 1 on a 500 and says retrying may work", async () => {
    server.use(
      http.get(apiUrl("/org/content-types"), () =>
        HttpResponse.json({ error: "boom" }, { status: 500 }),
      ),
    );

    const res = await runCli(["content-types", "list"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("server-side failure");
    expect(res.stderr).toContain("Retry shortly");
  });

  it("exits 1 on a 503 and says it is NOT a transient failure", async () => {
    // The opposite advice from a 500: a deployment that does not offer an
    // endpoint will not start offering it because the caller waited.
    server.use(
      http.get(apiUrl("/org/content-types"), () =>
        HttpResponse.json({ error: "Content types are not enabled here" }, { status: 503 }),
      ),
    );

    const res = await runCli(["content-types", "list"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("not a transient failure");
    expect(res.stderr).not.toContain("Retry shortly");
  });

  it("reports a malformed body rather than throwing a parse error at the user", async () => {
    server.use(http.get(apiUrl("/org/content-types"), () => new HttpResponse("<html>nope</html>")));

    const res = await runCli(["content-types", "list"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Invalid JSON response");
  });

  it("writes the failure envelope to stderr, leaving stdout empty, under --output json", async () => {
    server.use(
      http.get(apiUrl("/org/content-types"), () =>
        HttpResponse.json({ error: "nope" }, { status: 403 }),
      ),
    );

    const res = await runCli(["content-types", "list", "--output", "json"]);

    expect(res.exitCode).toBe(3);
    // A caller redirecting stdout to a file gets an empty file, not a file
    // holding an error object it would later read back as data.
    expect(res.stdout).toBe("");

    const reported = errorEnvelope(res);
    expect(reported.ok).toBe(false);
    expect(reported.command).toBe("content-types list");
    expect(reported.error).toMatchObject({ code: "forbidden", status: 403 });
    expect(reported.error.request).toEqual({ method: "GET", path: "/org/content-types" });
  });
});

describe("content-types, on usage errors", () => {
  // No handler is registered in this block: setup.ts fails any request that
  // reaches the network, so each of these also proves nothing was sent.
  it("exits 2 when create --data is not valid JSON", async () => {
    const res = await runCli(["content-types", "create", "--data", "{name: 'Blog'}"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Invalid JSON in --data");
  });

  it("exits 2 when update --data is not valid JSON", async () => {
    const res = await runCli(["content-types", "update", CT_ID, "--data", "{"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Invalid JSON in --data");
  });

  it("exits 2 when patch --data is not valid JSON", async () => {
    const res = await runCli(["content-types", "patch", CT_ID, "--data", "not json"]);

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

  it("exits 2 naming the required keys when create --data omits config", async () => {
    const res = await runCli([
      "content-types",
      "create",
      "--data",
      '{"name":"Blog Post"}',
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    const { error } = errorEnvelope(res);
    expect(error.message).toContain("config");
    expect(error.allowed).toEqual(["name", "config"]);
  });

  it("exits 2 rather than sending a key the API would silently drop", async () => {
    const res = await runCli([
      "content-types",
      "create",
      "--data",
      '{"name":"Blog Post","config":{"template":"x"},"descriptions":"typo"}',
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    const { error } = errorEnvelope(res);
    expect(error.message).toContain("descriptions");
    expect(error.hint).toContain("would have looked like a success");
  });

  it("exits 2 and names every accepted config key when config carries an unknown one", async () => {
    const res = await runCli([
      "content-types",
      "create",
      "--data",
      '{"name":"Blog Post","config":{"tone":"friendly"}}',
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    const { error } = errorEnvelope(res);
    expect(error.field).toBe("config.tone");
    expect(error.allowed).toEqual([
      "template",
      "template_spec",
      "cta_text",
      "cta_destination",
      "writing_rules",
    ]);
  });

  it("exits 2 when writing_rules is not an array of strings", async () => {
    const res = await runCli([
      "content-types",
      "create",
      "--data",
      '{"name":"Blog Post","config":{"writing_rules":"No hype"}}',
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    const { error } = errorEnvelope(res);
    expect(error.field).toBe("config.writing_rules");
    expect(error.message).toContain("not a string");
  });

  it("exits 2 when cta_destination is a relative URL", async () => {
    const res = await runCli([
      "content-types",
      "create",
      "--data",
      '{"name":"Blog Post","config":{"cta_destination":"/demo"}}',
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    const { error } = errorEnvelope(res);
    expect(error.field).toBe("config.cta_destination");
    expect(error.received).toBe("/demo");
  });

  it("exits 2 when a patch names neither name nor config", async () => {
    const res = await runCli(["content-types", "patch", CT_ID, "--data", "{}", "--output", "json"]);

    expect(res.exitCode).toBe(2);
    const { error } = errorEnvelope(res);
    expect(error.message).toContain("empty object");
    expect(error.hint).toContain("would change nothing");
  });

  it("exits 2 with the id named when <id> is not a UUID, before any request", async () => {
    const res = await runCli(["content-types", "get", "ct-1", "--output", "json"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");

    const { error } = errorEnvelope(res);
    expect(error.code).toBe("usage");
    expect(error.field).toBe("<id>");
    expect(error.received).toBe("ct-1");
    expect(error.hint).toContain("senso content-types list");
  });

  it("exits 2 when --limit is not a whole number", async () => {
    const res = await runCli(["content-types", "list", "--limit", "lots"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("not a whole number");
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

describe("content-types writes, on the wire", () => {
  it("POSTs the parsed --data object verbatim, nested config included", async () => {
    let body: unknown;
    let seen: Request | undefined;
    server.use(
      http.post(apiUrl("/org/content-types"), async ({ request }) => {
        seen = request;
        body = await request.json();
        return HttpResponse.json(ONE_TYPE, { status: 201 });
      }),
    );

    const payload = {
      name: "Blog Post",
      config: {
        template: "## Introduction (100-150 words)",
        writing_rules: ["No hype", "Cite sources"],
      },
    };
    await runCli(["content-types", "create", "--data", JSON.stringify(payload)]);

    expect(seen?.method).toBe("POST");
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/content-types");
    expect(seen?.headers.get("content-type")).toBe("application/json");
    // Verbatim: the CLI is a transport here, not a translator.
    expect(body).toEqual(payload);
  });

  it("GETs the content type's own path", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/content-types/:id"), ({ request }) => {
        seen = request;
        return HttpResponse.json(ONE_TYPE);
      }),
    );

    await runCli(["content-types", "get", CT_ID]);

    expect(seen?.method).toBe("GET");
    expect(new URL(seen?.url ?? "").pathname).toBe(`/api/v1/org/content-types/${CT_ID}`);
  });

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
    await runCli(["content-types", "update", CT_ID, "--data", JSON.stringify(payload)]);

    expect(seen?.method).toBe("PUT");
    expect(new URL(seen?.url ?? "").pathname).toBe(`/api/v1/org/content-types/${CT_ID}`);
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
    await runCli(["content-types", "patch", CT_ID, "--data", JSON.stringify(payload)]);

    // The whole reason both commands exist. A PUT here would erase `name`.
    expect(seen?.method).toBe("PATCH");
    expect(new URL(seen?.url ?? "").pathname).toBe(`/api/v1/org/content-types/${CT_ID}`);
    expect(body).toEqual(payload);
  });

  it("DELETEs the content type's own path", async () => {
    let seen: Request | undefined;
    server.use(
      http.delete(apiUrl("/org/content-types/:id"), ({ request }) => {
        seen = request;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await runCli(["content-types", "delete", CT_ID_2]);

    expect(seen?.method).toBe("DELETE");
    expect(new URL(seen?.url ?? "").pathname).toBe(`/api/v1/org/content-types/${CT_ID_2}`);
  });
});

describe("content-types, on success", () => {
  it("wraps the list payload, unmodified, in the envelope under --output json", async () => {
    server.use(http.get(apiUrl("/org/content-types"), () => HttpResponse.json(CONTENT_TYPES)));

    const res = await runCli(["content-types", "list", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toEqual(CONTENT_TYPES);
    expect(envelope(res).command).toBe("content-types list");
    expect(res.stderr).toBe("");
  });

  it("reports where the page sits, so a caller knows whether to ask for more", async () => {
    server.use(http.get(apiUrl("/org/content-types"), () => HttpResponse.json(CONTENT_TYPES)));

    const res = await runCli(["content-types", "list", "--output", "json"]);

    expect(envelope(res).page).toMatchObject({
      offset: 0,
      limit: 50,
      returned: 2,
      total: 2,
      has_more: false,
    });
  });

  it("renders one row per content type under --output table, with no blank column", async () => {
    server.use(http.get(apiUrl("/org/content-types"), () => HttpResponse.json(CONTENT_TYPES)));

    const res = await runCli(["content-types", "list", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("content_type_id");
    expect(res.stdout).toContain(CT_ID);
    expect(res.stdout).toContain("FAQ");
    // Every declared column exists on the rows; the warning would say otherwise.
    expect(res.stderr).not.toContain("did not return");
  });

  it("renders a readable block per content type by default", async () => {
    server.use(http.get(apiUrl("/org/content-types"), () => HttpResponse.json(CONTENT_TYPES)));

    const res = await runCli(["content-types", "list"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Blog Post");
    expect(res.stdout).toContain("FAQ");
  });

  it("says so plainly, and suggests a fix, when there are no content types", async () => {
    server.use(
      http.get(apiUrl("/org/content-types"), () =>
        HttpResponse.json({ content_types: [], total: 0, limit: 50, offset: 0 }),
      ),
    );

    const res = await runCli(["content-types", "list"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("No content types found.");
    expect(res.stderr).toContain("senso content-types create");
  });

  it("prints one content type, nested config and all, under --output json", async () => {
    server.use(http.get(apiUrl("/org/content-types/:id"), () => HttpResponse.json(ONE_TYPE)));

    const res = await runCli(["content-types", "get", CT_ID, "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toEqual(ONE_TYPE);
    expect(res.stderr).toBe("");
  });

  it("carries the next command in the envelope, where a json caller can read it", async () => {
    // Under --output json stderr is silent, so guidance written only there
    // would reach nobody — and every shipped Senso skill passes --output json.
    server.use(http.get(apiUrl("/org/content-types/:id"), () => HttpResponse.json(ONE_TYPE)));

    const res = await runCli(["content-types", "get", CT_ID, "--output", "json"]);

    expect(envelope(res).next?.[0]?.command).toContain(`senso content-types patch ${CT_ID}`);
  });

  it("renders one content type as field/value rows under --output table", async () => {
    server.use(http.get(apiUrl("/org/content-types/:id"), () => HttpResponse.json(ONE_TYPE)));

    const res = await runCli(["content-types", "get", CT_ID, "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("field");
    expect(res.stdout).toContain("name");
    expect(res.stdout).toContain("Blog Post");
  });

  it("renders the derived template_spec as an indented block, not a JSON string", async () => {
    server.use(http.get(apiUrl("/org/content-types/:id"), () => HttpResponse.json(ONE_TYPE)));

    const res = await runCli(["content-types", "get", CT_ID]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Blog Post");
    // The parsed spec is the reason to run `get`; burying it inside a
    // stringified blob puts it behind another parse.
    expect(res.stdout).toContain("parser_version");
    expect(res.stdout).toContain("source_format");
    expect(res.stdout).not.toContain("[object Object]");
  });

  it("puts the created type on stdout and the next command on stderr", async () => {
    server.use(
      http.post(apiUrl("/org/content-types"), () => HttpResponse.json(ONE_TYPE, { status: 201 })),
    );

    const res = await runCli(["content-types", "create", "--data", MINIMAL_DATA]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain(CT_ID);
    expect(res.stderr).toContain(`senso content-types get ${CT_ID}`);
    expect(res.stdout).not.toContain("What you can do next");
  });

  it("warns that a supplied template_spec will be thrown away", async () => {
    // The API validates it and then rebuilds it from `template`, so a caller
    // who carefully constructed one watches it be replaced without a word.
    server.use(
      http.post(apiUrl("/org/content-types"), () => HttpResponse.json(ONE_TYPE, { status: 201 })),
    );

    const res = await runCli([
      "content-types",
      "create",
      "--data",
      '{"name":"Blog Post","config":{"template":"## Intro","template_spec":{"parser_version":1,"source_format":"freeform_markdown","sections":[]}}}',
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(0);
    expect(envelope(res).warnings?.join(" ")).toContain("template_spec is ignored");
  });

  it("warns that update cleared every config key that was not sent", async () => {
    server.use(http.put(apiUrl("/org/content-types/:id"), () => HttpResponse.json(ONE_TYPE)));

    const res = await runCli([
      "content-types",
      "update",
      CT_ID,
      "--data",
      '{"name":"Blog Post","config":{"template":"## Intro"}}',
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(0);
    expect(envelope(res).warnings?.join(" ")).toContain("now cleared");
  });

  it("warns that a patched writing_rules replaced the list rather than adding to it", async () => {
    server.use(http.patch(apiUrl("/org/content-types/:id"), () => HttpResponse.json(ONE_TYPE)));

    const res = await runCli([
      "content-types",
      "patch",
      CT_ID,
      "--data",
      '{"config":{"writing_rules":["Cite sources"]}}',
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(0);
    const warnings = envelope(res).warnings?.join(" ") ?? "";
    expect(warnings).toContain("replaced the whole list");
    expect(warnings).toContain("Patched config");
  });
});

describe("content-types delete, on confirmation", () => {
  it("puts the tick on stderr and leaves stdout empty in plain mode", async () => {
    server.use(
      http.delete(apiUrl("/org/content-types/:id"), () => new HttpResponse(null, { status: 204 })),
    );

    const res = await runCli(["content-types", "delete", CT_ID]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("deleted");
    expect(res.stderr).toContain(CT_ID);
  });

  it("names what changed on stdout under --output json, rather than a sentence", async () => {
    server.use(
      http.delete(apiUrl("/org/content-types/:id"), () => new HttpResponse(null, { status: 204 })),
    );

    const res = await runCli(["content-types", "delete", CT_ID, "--output", "json"]);

    expect(res.exitCode).toBe(0);
    // The id has to be readable as a field: parsing it out of English is what
    // the confirmation payload exists to avoid.
    expect(res.data()).toEqual({ action: "deleted", resource: "content_type", id: CT_ID });
    expect(res.stderr).toBe("");
  });
});
