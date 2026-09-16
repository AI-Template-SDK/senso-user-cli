/**
 * Command layer: `senso industries` — the org-key view of the industry catalog.
 *
 * WHAT IS WORTH PROTECTING HERE, in the order it costs a caller the most.
 *
 *   - This group is NOT `senso partner industries`. It reads `/org/industries/*`
 *     with the key `senso login` stores; the partner group reads `/partner/*`
 *     and needs a partner key. The two are one word apart on a command line, so
 *     every test asserts the `/org/` path explicitly.
 *   - `<industry>` takes a UUID or a name, and a name takes the FIRST search
 *     match silently. That is a real hazard — "Airlines" resolves to whichever
 *     of two industries sorts first — so the first-match rule is pinned here,
 *     along with a UUID costing no extra round trip and a miss exiting 4 naming
 *     `senso industries list`.
 *   - Closed sets, ids, dates and the 90-day window are checked BEFORE the
 *     request. `--entity-type` and `--models` matter most: both filter
 *     server-side, so a typo would otherwise come back as a perfectly plausible
 *     empty leaderboard rather than an error. Every such test registers no MSW
 *     handler, so reaching the network fails the test.
 *   - `import-prompts` is asynchronous and activating. The import_id it returns
 *     must arrive as a runnable `senso history-imports get <id>` in the
 *     envelope's `next`, because under `--output json` stderr is silent and a
 *     hint written there reaches nobody.
 *   - `brands` is a list, not an object: `window` and `totals` are a header
 *     block and every declared column has to be a real field of
 *     `dto.BrandLeaderboardRow`.
 *
 * Every fixture is built from the API's own DTOs — PublicIndustryListResponse,
 * OrgIndustryPromptListResponse, BrandLeaderboardResponse,
 * IndustryBrandDetailResponse, IndustryDomainDetailResponse and
 * ImportIndustryPromptsResponse. Invented field names are what let a blank
 * column ship green.
 *
 * Failure branches come first, as in tests/commands/roles.test.ts.
 */

import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../setup.js";
import { apiUrl, envelope, errorEnvelope, runCli } from "../helpers.js";

/** A real UUID shape, so `resolveIndustryId` takes the no-search branch. */
const INDUSTRY_UUID = "3f7c1a2b-4d5e-4f60-9a1b-2c3d4e5f6071";
const SECOND_INDUSTRY_UUID = "5d6e7f80-9a0b-4c1d-8e2f-3a4b5c6d7e8f";
const BRAND_UUID = "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d";
const SURVIVOR_BRAND_UUID = "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const PROMPT_A = "a4226991-3d00-49ec-b5cc-95642c946cc0";
const PROMPT_B = "ac8d66db-888d-4ae8-b806-cb02d19e8cc6";
const GEO_QUESTION_ID = "7e8f9a0b-1c2d-4e3f-8a5b-6c7d8e9f0a1b";
const IMPORT_ID = "bf225e94-baad-44b2-9685-be2765979a1c";

/** dto.PublicIndustryListResponse. Two rows, so "first match" means something. */
const CATALOG = {
  industries: [
    {
      industry_id: INDUSTRY_UUID,
      name: "Airlines (Canada)",
      slug: "airlines-canada",
      description: "Scheduled passenger carriers operating in Canada.",
      active_prompt_count: 1000,
      model_count: 3,
      location_count: 1,
      created_at: "2026-01-04T09:00:00Z",
      updated_at: "2026-09-01T09:00:00Z",
    },
    {
      industry_id: SECOND_INDUSTRY_UUID,
      name: "Airlines (US)",
      slug: "airlines-us",
      description: "Scheduled passenger carriers operating in the United States.",
      active_prompt_count: 1400,
      model_count: 4,
      location_count: 1,
      created_at: "2026-01-04T09:00:00Z",
      updated_at: "2026-09-01T09:00:00Z",
    },
  ],
  total: 2,
  limit: 50,
  offset: 0,
};

/** dto.OrgIndustryPromptListResponse. */
const PROMPTS = {
  prompts: [
    {
      id: PROMPT_A,
      text: "Which airline has the best business class in Canada?",
      funnel_stage: "consideration",
    },
    { id: PROMPT_B, text: "Cheapest flights Toronto to Vancouver", funnel_stage: "decision" },
  ],
  total: 2,
  limit: 50,
  offset: 0,
};

/** One dto.BrandLeaderboardRow. */
function brandRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    brand_id: BRAND_UUID,
    brand_key: "air-canada",
    brand_name: "Air Canada",
    mentions_count: 812,
    mention_total: 1044,
    answered_count: 1793,
    mentions_rank: 1,
    average_position: 1.7,
    sentiment: { positive: 501, neutral: 280, negative: 31 },
    top_cited_domain: "aircanada.com",
    entity_type: "brand",
    surface_forms: ["Air Canada", "AirCanada"],
    model_data: [{ model: "chatgpt", mentions_count: 402, answered_count: 900 }],
    mentions_rank_trend: 1,
    mentions_count_trend: 96,
    mentions_percent_trend: 0.8,
    ...over,
  };
}

/** dto.BrandLeaderboardResponse: window + totals + a page of rows. */
const LEADERBOARD = {
  window: { from: "2026-06-22", to: "2026-09-14" },
  totals: { run_count: 1840, answered_count: 1793, brand_mention_total: 5211 },
  total: 2,
  limit: 100,
  offset: 0,
  brands: [
    brandRow(),
    brandRow({
      brand_id: SURVIVOR_BRAND_UUID,
      brand_key: "westjet",
      brand_name: "WestJet",
      mentions_count: 604,
      mention_total: 731,
      mentions_rank: 2,
      average_position: 2.4,
      top_cited_domain: "westjet.com",
      surface_forms: ["WestJet"],
      mentions_rank_trend: null,
      mentions_count_trend: null,
      mentions_percent_trend: null,
    }),
  ],
};

/** dto.IndustryBrandDetailResponse. */
function brandDetail(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    resolved: {
      brand_id: BRAND_UUID,
      brand_key: "air-canada",
      brand_name: "Air Canada",
      entity_type: "brand",
      matched_on: "Air Canada",
      match_confidence: 0.98,
      surface_forms: ["Air Canada", "AirCanada"],
    },
    window: { from: "2026-06-22", to: "2026-09-14", days: 84 },
    mentioned: true,
    metrics: {
      mention_rate: { value: 0.453, display: "45.3%" },
      share_of_voice: { value: 0.2, display: "20.0%" },
      avg_position: 1.7,
      rank_in_industry: 1,
      brands_ranked: 42,
      sentiment: { positive: 501, neutral: 280, negative: 31 },
      top_cited_domain: "aircanada.com",
      owned_citation_share: { value: 0.11, display: "11.0%" },
    },
    by_model: [{ model: "chatgpt", mention_rate: { value: 0.447, display: "44.7%" } }],
    by_stage: null,
    data_quality: { level: "high", answered_count: 1793, reasons: [] },
    notes: ["Surface-form spellings are merged before any metric is computed."],
    definitions: { mention_rate: "Share of answered runs in which the brand was named." },
    ...over,
  };
}

/** dto.IndustryDomainDetailResponse. */
function domainDetail(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    resolved: {
      domain: "aircanada.com",
      host: "aircanada.com",
      ownership: "official",
      owned_by_brand: "Air Canada",
    },
    window: { from: "2026-06-22", to: "2026-09-14", days: 84 },
    cited: true,
    citation_references: 1204,
    rank_in_industry: 1,
    share_of_citations: { value: 0.143, display: "14.3%" },
    co_mentioned_brands: [{ brand_name: "WestJet", cooccurrence: 311 }],
    data_quality: { level: "high", answered_count: 1793, reasons: [] },
    notes: [],
    definitions: { citation_references: "Total number of times any source was cited." },
    ...over,
  };
}

/** dto.ImportIndustryPromptsResponse. */
function imported(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    outcomes: [
      {
        industry_prompt_id: PROMPT_A,
        status: "created",
        geo_question_id: GEO_QUESTION_ID,
        reason: null,
      },
    ],
    created: 1,
    skipped: 0,
    defaults_seeded: { models: [], schedule_dows: [], locations: [] },
    history_import: { status: "queued", import_id: IMPORT_ID, days: 30, reason: null },
    ...over,
  };
}

/** The catalog search every name resolution makes first. */
function catalogSearch(): ReturnType<typeof http.get> {
  return http.get(apiUrl("/org/industries"), () => HttpResponse.json(CATALOG));
}

describe("industries, when a flag is not a valid value", () => {
  // Nothing below registers an MSW handler: tests/setup.ts fails any unmocked
  // request, so reaching the network at all fails these tests.

  it("exits 2 when --limit is above the maximum", async () => {
    const res = await runCli(["industries", "list", "--limit", "101", "--output", "json"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(errorEnvelope(res).error).toMatchObject({
      code: "usage",
      field: "--limit",
      received: "101",
    });
  });

  it("exits 2 when --limit is not a whole number", async () => {
    const res = await runCli(["industries", "list", "--limit", "abc"]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("not a whole number");
  });

  it("exits 2 when --offset is negative", async () => {
    const res = await runCli(["industries", "list", "--offset", "-1"]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("--offset");
  });

  it("exits 2 and hands back the four sort orders when --sort is not one of them", async () => {
    const res = await runCli(["industries", "list", "--sort", "whenever", "--output", "json"]);

    expect(res.exitCode).toBe(2);
    expect(errorEnvelope(res).error.allowed).toEqual([
      "name_asc",
      "name_desc",
      "created_asc",
      "created_desc",
    ]);
  });

  it("exits 2 when --entity-type names a type that does not exist", async () => {
    // Applied server-side before paging, so a typo would otherwise come back as
    // a plausible empty leaderboard.
    const res = await runCli([
      "industries",
      "brands",
      INDUSTRY_UUID,
      "--entity-type",
      "brnad",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    const { error } = errorEnvelope(res);
    expect(error.field).toBe("--entity-type");
    expect(error.received).toBe("brnad");
    expect(error.allowed).toContain("brand");
  });

  it("exits 2 when one member of a --entity-type list is unknown", async () => {
    const res = await runCli([
      "industries",
      "brands",
      INDUSTRY_UUID,
      "--entity-type",
      "brand,bogus",
    ]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("bogus");
  });

  it("exits 2 when --rollup is not `parent`", async () => {
    const res = await runCli([
      "industries",
      "brands",
      INDUSTRY_UUID,
      "--rollup",
      "parents",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    expect(errorEnvelope(res).error.allowed).toEqual(["parent"]);
  });

  it("exits 2 when --models names a model that is not in the allow-list", async () => {
    const res = await runCli([
      "industries",
      "brands",
      INDUSTRY_UUID,
      "--models",
      "gpt-5",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    const { error } = errorEnvelope(res);
    expect(error.field).toBe("--models");
    expect(error.received).toBe("gpt-5");
    expect(error.allowed).toContain("chatgpt");
    // The only place an agent can discover which ids actually have data.
    expect(error.hint).toContain("senso analytics filters");
  });

  it("exits 2 when one model in a comma-separated --models is unknown", async () => {
    const res = await runCli([
      "industries",
      "brands",
      INDUSTRY_UUID,
      "--models",
      "chatgpt,gpt-9",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    expect(errorEnvelope(res).error.received).toBe("gpt-9");
  });

  it("exits 2 when a date is an instant rather than YYYY-MM-DD", async () => {
    // `senso evals` takes RFC 3339 under the same flag name, so a caller
    // carrying a timestamp across groups must learn it here, not from a 400.
    const res = await runCli([
      "industries",
      "brands",
      INDUSTRY_UUID,
      "--from",
      "2026-09-01T00:00:00Z",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    const { error } = errorEnvelope(res);
    expect(error.field).toBe("--from");
    expect(error.message).toContain("not a YYYY-MM-DD date");
  });

  it("exits 2 when the window is longer than 90 days", async () => {
    const res = await runCli([
      "industries",
      "brands",
      INDUSTRY_UUID,
      "--from",
      "2026-06-01",
      "--to",
      "2026-09-14",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    const { error } = errorEnvelope(res);
    expect(error.message).toContain("the maximum is 90");
    expect(error.received).toBe("2026-06-01..2026-09-14");
  });

  it("exits 2 when --from is after --to", async () => {
    const res = await runCli([
      "industries",
      "brands",
      INDUSTRY_UUID,
      "--from",
      "2026-09-14",
      "--to",
      "2026-09-01",
    ]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("is after");
  });

  it("exits 2 when <brandId> is not a UUID, naming the id space it wanted", async () => {
    const res = await runCli([
      "industries",
      "brand-by-id",
      INDUSTRY_UUID,
      "air-canada",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    const { error } = errorEnvelope(res);
    expect(error.field).toBe("<brandId>");
    expect(error.hint).toContain("brand_id");
    expect(error.hint).toContain("senso industries brands");
  });

  it("names the valid formats when --output is not one of them", async () => {
    const res = await runCli(["industries", "list", "--output", "yaml"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("json, table, plain");
  });
});

describe("industries, when the API refuses", () => {
  it("exits 3 on a 401", async () => {
    server.use(
      http.get(apiUrl("/org/industries"), () =>
        HttpResponse.json({ status: 401, message: "Authentication required" }, { status: 401 }),
      ),
    );

    const res = await runCli(["industries", "list"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
  });

  it("exits 3 for an organization without the GEO product, and says where to add it", async () => {
    server.use(
      http.get(apiUrl("/org/industries/:id/prompts"), () =>
        HttpResponse.json(
          { status: 403, message: "Your organization doesn't have access to this product" },
          { status: 403 },
        ),
      ),
    );

    const res = await runCli(["industries", "prompts", INDUSTRY_UUID, "--output", "json"]);

    expect(res.exitCode).toBe(3);
    const { error } = errorEnvelope(res);
    expect(error.code).toBe("forbidden");
    expect(error.hint).toContain("GEO product");
  });

  it("exits 4 naming the industry when the id is readable by nobody here", async () => {
    server.use(
      http.get(apiUrl("/org/industries/:id/brands"), () =>
        HttpResponse.json({ status: 404, message: "Industry not found" }, { status: 404 }),
      ),
    );

    const res = await runCli(["industries", "brands", INDUSTRY_UUID, "--output", "json"]);

    expect(res.exitCode).toBe(4);
    expect(res.stdout).toBe("");
    const { error } = errorEnvelope(res);
    expect(error).toMatchObject({ code: "not_found", status: 404, field: "industry_id" });
    expect(error.message).toContain("Industry");
    expect(error.hint).toContain("senso industries list");
  });

  it("exits 1 on a 500 and says it is not the caller's fault", async () => {
    server.use(
      http.get(apiUrl("/org/industries"), () =>
        HttpResponse.json({ status: 500, message: "boom" }, { status: 500 }),
      ),
    );

    const res = await runCli(["industries", "list"]);

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("Retry shortly");
  });

  it("exits 1 on a 503 and says it is not a transient failure", async () => {
    server.use(
      http.get(apiUrl("/org/industries"), () =>
        HttpResponse.json({ status: 503, message: "Service unavailable" }, { status: 503 }),
      ),
    );

    const res = await runCli(["industries", "list"]);

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("not a transient failure");
  });

  it("reports a malformed body rather than throwing a parse error at the user", async () => {
    server.use(http.get(apiUrl("/org/industries"), () => new HttpResponse("<html>nope</html>")));

    const res = await runCli(["industries", "list"]);

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("Invalid JSON response");
  });
});

describe("industries, resolving the <industry> argument", () => {
  it("exits 4 when no industry matches the name, naming the command that lists them", async () => {
    server.use(
      http.get(apiUrl("/org/industries"), () =>
        HttpResponse.json({ industries: [], total: 0, limit: 50, offset: 0 }),
      ),
    );

    const res = await runCli(["industries", "prompts", "Nonexistent Sector", "--output", "json"]);

    expect(res.exitCode).toBe(4);
    expect(res.stdout).toBe("");
    const { error } = errorEnvelope(res);
    expect(error).toMatchObject({
      code: "not_found",
      field: "<industry>",
      received: "Nonexistent Sector",
    });
    expect(error.message).toContain('matches "Nonexistent Sector"');
    expect(error.hint).toContain("senso industries list");
  });

  it("exits 4 when the first match carries no industry_id", async () => {
    server.use(
      http.get(apiUrl("/org/industries"), () =>
        HttpResponse.json({ industries: [{ name: "Airlines (Canada)" }], total: 1 }),
      ),
    );

    const res = await runCli(["industries", "prompts", "Airlines"]);

    expect(res.exitCode).toBe(4);
    expect(res.stdout).toBe("");
  });

  it("exits 2 when <industry> is empty, before any request", async () => {
    const res = await runCli(["industries", "prompts", "", "--output", "json"]);

    expect(res.exitCode).toBe(2);
    expect(errorEnvelope(res).error.field).toBe("<industry>");
  });

  it("searches the ORG catalog, not the partner one, to resolve a name", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/industries"), ({ request }) => {
        seen = request;
        return HttpResponse.json(CATALOG);
      }),
      http.get(apiUrl("/org/industries/:id/prompts"), () => HttpResponse.json(PROMPTS)),
    );

    const res = await runCli(["industries", "prompts", "Airlines (Canada)"]);

    expect(res.exitCode).toBe(0);
    expect(new URL(seen!.url).pathname).toBe("/api/v1/org/industries");
    expect(new URL(seen!.url).searchParams.get("search")).toBe("Airlines (Canada)");
  });

  it("takes the FIRST search match, even when a second one also matched", async () => {
    // "Airlines" matches both catalog rows. Whichever sorts first wins, and
    // silently — which is why every command's help says to pass the UUID.
    let seen: Request | undefined;
    server.use(
      catalogSearch(),
      http.get(apiUrl("/org/industries/:id/prompts"), ({ request }) => {
        seen = request;
        return HttpResponse.json(PROMPTS);
      }),
    );

    const res = await runCli(["industries", "prompts", "Airlines"]);

    expect(res.exitCode).toBe(0);
    expect(new URL(seen!.url).pathname).toBe(`/api/v1/org/industries/${INDUSTRY_UUID}/prompts`);
    expect(new URL(seen!.url).pathname).not.toContain(SECOND_INDUSTRY_UUID);
  });

  it("does NOT search when the argument is already a UUID", async () => {
    let searched = false;
    server.use(
      http.get(apiUrl("/org/industries"), () => {
        searched = true;
        return HttpResponse.json(CATALOG);
      }),
      http.get(apiUrl("/org/industries/:id/prompts"), () => HttpResponse.json(PROMPTS)),
    );

    const res = await runCli(["industries", "prompts", INDUSTRY_UUID]);

    expect(res.exitCode).toBe(0);
    expect(searched).toBe(false);
  });

  it("accepts a UUID in upper case and with surrounding whitespace", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/industries/:id/prompts"), ({ request }) => {
        seen = request;
        return HttpResponse.json(PROMPTS);
      }),
    );

    const res = await runCli(["industries", "prompts", ` ${INDUSTRY_UUID.toUpperCase()} `]);

    expect(res.exitCode).toBe(0);
    expect(new URL(seen!.url).pathname).toBe(
      `/api/v1/org/industries/${INDUSTRY_UUID.toUpperCase()}/prompts`,
    );
  });
});

describe("industries list", () => {
  it("sends search, limit, offset, sort and live as query parameters", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/industries"), ({ request }) => {
        seen = request;
        return HttpResponse.json(CATALOG);
      }),
    );

    const res = await runCli([
      "industries",
      "list",
      "--search",
      "air",
      "--limit",
      "10",
      "--offset",
      "5",
      "--sort",
      "name_desc",
      "--live",
    ]);

    expect(res.exitCode).toBe(0);
    const url = new URL(seen!.url);
    expect(url.pathname).toBe("/api/v1/org/industries");
    expect(url.searchParams.get("search")).toBe("air");
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.get("offset")).toBe("5");
    expect(url.searchParams.get("sort")).toBe("name_desc");
    expect(url.searchParams.get("live")).toBe("true");
  });

  it("omits live entirely when the flag is not passed", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/industries"), ({ request }) => {
        seen = request;
        return HttpResponse.json(CATALOG);
      }),
    );

    await runCli(["industries", "list"]);

    expect(new URL(seen!.url).searchParams.has("live")).toBe(false);
  });

  it("returns the payload unmodified under --output json, with nothing on stderr", async () => {
    server.use(catalogSearch());

    const res = await runCli(["industries", "list", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toEqual(CATALOG);
    expect(res.stderr).toBe("");
  });

  it("renders every declared column with a value under --output table", async () => {
    server.use(catalogSearch());

    const res = await runCli(["industries", "list", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    for (const column of [
      "industry_id",
      "name",
      "slug",
      "active_prompt_count",
      "model_count",
      "location_count",
    ]) {
      expect(res.stdout).toContain(column);
    }
    expect(res.stdout).toContain("Airlines (Canada)");
    expect(res.stdout).toContain("1000");
    expect(res.stdout).toMatch(
      /industry_id\s+name\s+slug\s+active_prompt_count\s+model_count\s+location_count/,
    );
    expect(res.stderr).not.toContain("which the API did not return");
  });

  it("offers the two things anyone does next with an industry_id", async () => {
    server.use(catalogSearch());

    const res = await runCli(["industries", "list", "--output", "json"]);

    const commands = (envelope(res).next ?? []).map((s) => s.command);
    expect(commands).toContain(`senso industries prompts ${INDUSTRY_UUID}`);
    expect(commands).toContain(`senso org set-industry ${INDUSTRY_UUID}`);
  });

  it("explains an empty page as a filter, because the catalog itself is never empty", async () => {
    server.use(
      http.get(apiUrl("/org/industries"), () =>
        HttpResponse.json({ industries: [], total: 0, limit: 50, offset: 0 }),
      ),
    );

    const res = await runCli(["industries", "list", "--search", "zzz"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("No industries found.");
    expect(res.stderr).toContain("--search");
  });
});

describe("industries prompts", () => {
  it("sends limit and offset, and reads the industry's own prompts", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/industries/:id/prompts"), ({ request }) => {
        seen = request;
        return HttpResponse.json(PROMPTS);
      }),
    );

    const res = await runCli([
      "industries",
      "prompts",
      INDUSTRY_UUID,
      "--limit",
      "25",
      "--offset",
      "50",
    ]);

    expect(res.exitCode).toBe(0);
    const url = new URL(seen!.url);
    expect(url.pathname).toBe(`/api/v1/org/industries/${INDUSTRY_UUID}/prompts`);
    expect(url.searchParams.get("limit")).toBe("25");
    expect(url.searchParams.get("offset")).toBe("50");
  });

  it("renders id, text and funnel_stage, all populated", async () => {
    server.use(http.get(apiUrl("/org/industries/:id/prompts"), () => HttpResponse.json(PROMPTS)));

    const res = await runCli(["industries", "prompts", INDUSTRY_UUID, "--output", "table"]);

    expect(res.exitCode).toBe(0);
    for (const column of ["id", "text", "funnel_stage"]) {
      expect(res.stdout).toContain(column);
    }
    expect(res.stdout).toContain("consideration");
    expect(res.stderr).not.toContain("which the API did not return");
  });

  it("hands the first prompt id straight to import-prompts", async () => {
    server.use(http.get(apiUrl("/org/industries/:id/prompts"), () => HttpResponse.json(PROMPTS)));

    const res = await runCli(["industries", "prompts", INDUSTRY_UUID, "--output", "json"]);

    expect((envelope(res).next ?? []).map((s) => s.command)).toContain(
      `senso industries import-prompts ${INDUSTRY_UUID} --prompt-ids ${PROMPT_A}`,
    );
  });

  it("says an industry with no prompts has nothing to import", async () => {
    server.use(
      http.get(apiUrl("/org/industries/:id/prompts"), () =>
        HttpResponse.json({ prompts: [], total: 0, limit: 50, offset: 0 }),
      ),
    );

    const res = await runCli(["industries", "prompts", INDUSTRY_UUID]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("No prompts found.");
    expect(res.stderr).toContain("nothing to import");
  });
});

describe("industries brands", () => {
  it("sends the window filters, paging, rollup and entity_type", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/industries/:id/brands"), ({ request }) => {
        seen = request;
        return HttpResponse.json(LEADERBOARD);
      }),
    );

    const res = await runCli([
      "industries",
      "brands",
      INDUSTRY_UUID,
      "--from",
      "2026-08-01",
      "--to",
      "2026-08-31",
      "--models",
      "chatgpt,perplexity",
      "--location",
      "CA",
      "--limit",
      "5",
      "--offset",
      "2",
      "--rollup",
      "parent",
      "--entity-type",
      "brand,publisher",
    ]);

    expect(res.exitCode).toBe(0);
    const url = new URL(seen!.url);
    expect(url.pathname).toBe(`/api/v1/org/industries/${INDUSTRY_UUID}/brands`);
    expect(url.searchParams.get("from")).toBe("2026-08-01");
    expect(url.searchParams.get("to")).toBe("2026-08-31");
    expect(url.searchParams.get("models")).toBe("chatgpt,perplexity");
    expect(url.searchParams.get("location")).toBe("CA");
    expect(url.searchParams.get("limit")).toBe("5");
    expect(url.searchParams.get("offset")).toBe("2");
    expect(url.searchParams.get("rollup")).toBe("parent");
    expect(url.searchParams.get("entity_type")).toBe("brand,publisher");
  });

  it("normalizes a model id's case rather than rejecting it", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/industries/:id/brands"), ({ request }) => {
        seen = request;
        return HttpResponse.json(LEADERBOARD);
      }),
    );

    await runCli(["industries", "brands", INDUSTRY_UUID, "--models", " ChatGPT , Gemini "]);

    expect(new URL(seen!.url).searchParams.get("models")).toBe("chatgpt,gemini");
  });

  it("sends canonicalize=false only when --no-canonicalize is passed", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/industries/:id/brands"), ({ request }) => {
        seen = request;
        return HttpResponse.json(LEADERBOARD);
      }),
    );

    await runCli(["industries", "brands", INDUSTRY_UUID, "--no-canonicalize"]);
    expect(new URL(seen!.url).searchParams.get("canonicalize")).toBe("false");

    await runCli(["industries", "brands", INDUSTRY_UUID]);
    expect(new URL(seen!.url).searchParams.has("canonicalize")).toBe(false);
  });

  it("warns that --rollup parent was ignored when canonicalization is off", async () => {
    // The server drops it silently, so the page that comes back is not the page
    // that was asked for.
    server.use(
      http.get(apiUrl("/org/industries/:id/brands"), () => HttpResponse.json(LEADERBOARD)),
    );

    const res = await runCli([
      "industries",
      "brands",
      INDUSTRY_UUID,
      "--rollup",
      "parent",
      "--no-canonicalize",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(0);
    expect(envelope(res).warnings?.join(" ")).toContain("--rollup parent was ignored");
  });

  it("renders every declared column with a value under --output table", async () => {
    server.use(
      http.get(apiUrl("/org/industries/:id/brands"), () => HttpResponse.json(LEADERBOARD)),
    );

    const res = await runCli(["industries", "brands", INDUSTRY_UUID, "--output", "table"]);

    expect(res.exitCode).toBe(0);
    for (const column of [
      "mentions_rank",
      "brand_name",
      "mentions_count",
      "mention_total",
      "average_position",
      "top_cited_domain",
      "entity_type",
    ]) {
      expect(res.stdout).toContain(column);
    }
    expect(res.stdout).toContain("Air Canada");
    expect(res.stdout).toContain("aircanada.com");
    expect(res.stdout).toContain("1044");
    // A real header row, in the declared order — which only the list rendering
    // produces. The single-object fallback would print `field`/`value` instead.
    expect(res.stdout).toMatch(
      /mentions_rank\s+brand_name\s+mentions_count\s+mention_total\s+average_position\s+top_cited_domain\s+entity_type/,
    );
    // Every column above is a real field of dto.BrandLeaderboardRow.
    expect(res.stderr).not.toContain("which the API did not return");
  });

  it("renders window and totals as a header block, not one line of inline JSON", async () => {
    // `brands` travels beside `window` and `totals`, neither of which is
    // pagination. Before the list keys were named, the whole leaderboard was
    // stringified onto one line and the declared columns were ignored.
    server.use(
      http.get(apiUrl("/org/industries/:id/brands"), () => HttpResponse.json(LEADERBOARD)),
    );

    const res = await runCli(["industries", "brands", INDUSTRY_UUID]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("window");
    expect(res.stdout).toContain("brand_mention_total");
    expect(res.stdout).toContain("5211");
    // A header block, not a blob: the denominators are on their own lines.
    expect(res.stdout).not.toContain('{"run_count"');
    // And the payload really was classified as a LIST: the pagination keys are
    // consumed by the page line on stderr rather than printed as fields, which
    // is what the single-object rendering would have done with them.
    expect(res.stdout).not.toMatch(/^\s*limit\s/m);
    expect(res.stderr).toContain("Showing 1–2 of 2.");
    // And the rows are still rows.
    expect(res.stdout).toContain("Air Canada");
    expect(res.stdout).toContain("WestJet");
  });

  it("reports where the page sits, because ranks are global", async () => {
    server.use(
      http.get(apiUrl("/org/industries/:id/brands"), () => HttpResponse.json(LEADERBOARD)),
    );

    const res = await runCli(["industries", "brands", INDUSTRY_UUID, "--output", "json"]);

    expect(envelope(res).page).toMatchObject({
      offset: 0,
      limit: 100,
      returned: 2,
      total: 2,
      has_more: false,
    });
  });

  it("offers the top brand's repeatable, no-write lookup", async () => {
    server.use(
      http.get(apiUrl("/org/industries/:id/brands"), () => HttpResponse.json(LEADERBOARD)),
    );

    const res = await runCli(["industries", "brands", INDUSTRY_UUID, "--output", "json"]);

    expect((envelope(res).next ?? []).map((s) => s.command)).toContain(
      `senso industries brand-by-id ${INDUSTRY_UUID} ${BRAND_UUID}`,
    );
  });

  it("says how to widen the window when nothing was named", async () => {
    server.use(
      http.get(apiUrl("/org/industries/:id/brands"), () =>
        HttpResponse.json({ ...LEADERBOARD, brands: [], total: 0 }),
      ),
    );

    const res = await runCli(["industries", "brands", INDUSTRY_UUID]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("No brands found.");
    expect(res.stderr).toContain("--from/--to");
  });
});

describe("industries brand", () => {
  it("percent-encodes the brand name in the path and passes the filters through", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/industries/:id/brands/:brand"), ({ request }) => {
        seen = request;
        return HttpResponse.json(brandDetail());
      }),
    );

    const res = await runCli([
      "industries",
      "brand",
      INDUSTRY_UUID,
      "Acme & Co",
      "--location",
      "US",
    ]);

    expect(res.exitCode).toBe(0);
    const url = new URL(seen!.url);
    expect(url.pathname).toBe(
      `/api/v1/org/industries/${INDUSTRY_UUID}/brands/${encodeURIComponent("Acme & Co")}`,
    );
    expect(url.searchParams.get("location")).toBe("US");
  });

  it("exits 2 when <brandName> is empty, before any request", async () => {
    const res = await runCli(["industries", "brand", INDUSTRY_UUID, "  ", "--output", "json"]);

    expect(res.exitCode).toBe(2);
    expect(errorEnvelope(res).error.field).toBe("<brandName>");
  });

  it("exits 0 for a brand that was never named, and says that is an answer", async () => {
    server.use(
      http.get(apiUrl("/org/industries/:id/brands/:brand"), () =>
        HttpResponse.json(
          brandDetail({
            mentioned: false,
            metrics: null,
            resolved: {
              brand_id: null,
              brand_key: "nobody",
              brand_name: "Nobody",
              entity_type: "brand",
              matched_on: "Nobody",
              match_confidence: 0.41,
              surface_forms: ["Nobody"],
            },
          }),
        ),
      ),
    );

    const res = await runCli(["industries", "brand", INDUSTRY_UUID, "Nobody", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.data<{ mentioned: boolean }>().mentioned).toBe(false);
    expect(envelope(res).warnings?.join(" ")).toContain("not an error");
  });

  it("shows the fuzzy-match fields in plain output rather than burying them in JSON", async () => {
    // resolved.match_confidence is the field that says whether to trust the
    // numbers, so it must not arrive as part of a stringified blob.
    server.use(
      http.get(apiUrl("/org/industries/:id/brands/:brand"), () => HttpResponse.json(brandDetail())),
    );

    const res = await runCli(["industries", "brand", INDUSTRY_UUID, "Air Canada"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("match_confidence");
    expect(res.stdout).toContain("0.98");
    expect(res.stdout).toContain("rank_in_industry");
  });
});

describe("industries brand-by-id", () => {
  it("uses the brands-by-id path, which keeps it off the fuzzy route", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/industries/:id/brands-by-id/:brandId"), ({ request }) => {
        seen = request;
        return HttpResponse.json(brandDetail());
      }),
    );

    const res = await runCli(["industries", "brand-by-id", INDUSTRY_UUID, BRAND_UUID]);

    expect(res.exitCode).toBe(0);
    expect(new URL(seen!.url).pathname).toBe(
      `/api/v1/org/industries/${INDUSTRY_UUID}/brands-by-id/${BRAND_UUID}`,
    );
  });

  it("warns when the id was merged away and the payload belongs to the survivor", async () => {
    server.use(
      http.get(apiUrl("/org/industries/:id/brands-by-id/:brandId"), () =>
        HttpResponse.json(
          brandDetail({
            resolved: {
              brand_id: SURVIVOR_BRAND_UUID,
              brand_key: "westjet",
              brand_name: "WestJet",
              entity_type: "brand",
              matched_on: "WestJet",
              match_confidence: 1,
              surface_forms: ["WestJet"],
            },
          }),
        ),
      ),
    );

    const res = await runCli([
      "industries",
      "brand-by-id",
      INDUSTRY_UUID,
      BRAND_UUID,
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(0);
    const warnings = envelope(res).warnings?.join(" ") ?? "";
    expect(warnings).toContain(`merged into ${SURVIVOR_BRAND_UUID}`);
    expect(warnings).toContain("store resolved.brand_id");
  });

  it("says nothing about a merge when the id came back unchanged", async () => {
    server.use(
      http.get(apiUrl("/org/industries/:id/brands-by-id/:brandId"), () =>
        HttpResponse.json(brandDetail()),
      ),
    );

    const res = await runCli([
      "industries",
      "brand-by-id",
      INDUSTRY_UUID,
      BRAND_UUID,
      "--output",
      "json",
    ]);

    expect(envelope(res).warnings).toBeUndefined();
  });

  it("exits 4 naming both ids, because the API will not say which was wrong", async () => {
    server.use(
      http.get(apiUrl("/org/industries/:id/brands-by-id/:brandId"), () =>
        HttpResponse.json({ status: 404, message: "Brand not found" }, { status: 404 }),
      ),
    );

    const res = await runCli([
      "industries",
      "brand-by-id",
      INDUSTRY_UUID,
      BRAND_UUID,
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(4);
    const { error } = errorEnvelope(res);
    expect(error.message).toContain("Industry or brand");
    expect(error.received).toBe(`${INDUSTRY_UUID} / ${BRAND_UUID}`);
  });
});

describe("industries domain", () => {
  it("keeps the domain in the path and sends --url as a query parameter", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/industries/:id/domains/:domain"), ({ request }) => {
        seen = request;
        return HttpResponse.json(domainDetail());
      }),
    );

    const res = await runCli([
      "industries",
      "domain",
      INDUSTRY_UUID,
      "aircanada.com",
      "--url",
      "https://aircanada.com/a?b=c",
    ]);

    expect(res.exitCode).toBe(0);
    const url = new URL(seen!.url);
    expect(url.pathname).toBe(`/api/v1/org/industries/${INDUSTRY_UUID}/domains/aircanada.com`);
    expect(url.searchParams.get("url")).toBe("https://aircanada.com/a?b=c");
  });

  it("warns that --url replaced <domain>, because the payload does not say which", async () => {
    server.use(
      http.get(apiUrl("/org/industries/:id/domains/:domain"), () =>
        HttpResponse.json(domainDetail()),
      ),
    );

    const res = await runCli([
      "industries",
      "domain",
      INDUSTRY_UUID,
      "aircanada.com",
      "--url",
      "https://aircanada.com/aeroplan",
      "--output",
      "json",
    ]);

    expect(envelope(res).warnings?.join(" ")).toContain(
      "--url replaced <domain>: this reports on https://aircanada.com/aeroplan",
    );
  });

  it("exits 2 when <domain> is empty", async () => {
    const res = await runCli(["industries", "domain", INDUSTRY_UUID, "  ", "--output", "json"]);

    expect(res.exitCode).toBe(2);
    expect(errorEnvelope(res).error.field).toBe("<domain>");
  });

  it("exits 0 for a domain that was never cited, and says that is an answer", async () => {
    server.use(
      http.get(apiUrl("/org/industries/:id/domains/:domain"), () =>
        HttpResponse.json(
          domainDetail({
            resolved: {
              domain: "nope.example",
              host: "nope.example",
              ownership: "unknown",
            },
            cited: false,
            citation_references: 0,
            rank_in_industry: 0,
            share_of_citations: { value: 0, display: "0.0%" },
            co_mentioned_brands: [],
          }),
        ),
      ),
    );

    const res = await runCli([
      "industries",
      "domain",
      INDUSTRY_UUID,
      "nope.example",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.data<{ cited: boolean }>().cited).toBe(false);
    expect(envelope(res).warnings?.join(" ")).toContain("not an error");
  });
});

describe("industries import-prompts, validating --prompt-ids", () => {
  // None of these register a handler: a typo must never cost a request, and
  // this endpoint activates the organization.

  it("exits 2 when an id is not a UUID", async () => {
    const res = await runCli([
      "industries",
      "import-prompts",
      INDUSTRY_UUID,
      "--prompt-ids",
      `${PROMPT_A},nope`,
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    const { error } = errorEnvelope(res);
    expect(error.field).toBe("--prompt-ids");
    expect(error.message).toContain("not a UUID");
    expect(error.hint).toContain("senso industries prompts");
  });

  it("exits 2 when an id appears more than once, because the API rejects the lot", async () => {
    const res = await runCli([
      "industries",
      "import-prompts",
      INDUSTRY_UUID,
      "--prompt-ids",
      `${PROMPT_A},${PROMPT_B},${PROMPT_A}`,
    ]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("more than once");
  });

  it("exits 2 when more than 100 ids are given, and says to split the call", async () => {
    const ids = Array.from(
      { length: 101 },
      (_, i) => `3f7c1a2b-4d5e-4f60-9a1b-${String(i).padStart(12, "0")}`,
    ).join(",");

    const res = await runCli([
      "industries",
      "import-prompts",
      INDUSTRY_UUID,
      "--prompt-ids",
      ids,
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    expect(errorEnvelope(res).error.message).toContain("the maximum is 100");
    expect(errorEnvelope(res).error.hint).toContain("safe to re-run");
  });

  it("exits 2 when --prompt-ids is empty", async () => {
    const res = await runCli(["industries", "import-prompts", INDUSTRY_UUID, "--prompt-ids", ""]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("no ids given");
  });
});

describe("industries import-prompts, when the API refuses", () => {
  it("exits 3 and names `senso org get` when the industry is not the organization's own", async () => {
    server.use(
      http.post(apiUrl("/org/industries/:id/prompts/import"), () =>
        HttpResponse.json(
          { status: 403, message: "Industry does not match the organization's industry" },
          { status: 403 },
        ),
      ),
    );

    const res = await runCli([
      "industries",
      "import-prompts",
      INDUSTRY_UUID,
      "--prompt-ids",
      PROMPT_A,
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(errorEnvelope(res).error.hint).toContain("senso org set-industry");
  });

  it("exits 3 and says to set an industry first when the organization has none", async () => {
    server.use(
      http.post(apiUrl("/org/industries/:id/prompts/import"), () =>
        HttpResponse.json(
          { status: 403, message: "Organization has no industry set" },
          { status: 403 },
        ),
      ),
    );

    const res = await runCli([
      "industries",
      "import-prompts",
      INDUSTRY_UUID,
      "--prompt-ids",
      PROMPT_A,
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(3);
    expect(errorEnvelope(res).error.hint).toContain("senso industries list");
  });

  it("exits 1 and names the prompt list when an id is not an active prompt", async () => {
    server.use(
      http.post(apiUrl("/org/industries/:id/prompts/import"), () =>
        HttpResponse.json(
          { status: 400, message: "Prompt is inactive and cannot be imported" },
          { status: 400 },
        ),
      ),
    );

    const res = await runCli([
      "industries",
      "import-prompts",
      INDUSTRY_UUID,
      "--prompt-ids",
      PROMPT_A,
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(1);
    const { error } = errorEnvelope(res);
    expect(error.code).toBe("validation");
    expect(error.hint).toContain(`senso industries prompts ${INDUSTRY_UUID}`);
  });
});

describe("industries import-prompts, on success", () => {
  it("posts prompt_ids as an array, trimmed", async () => {
    let body: unknown;
    server.use(
      http.post(apiUrl("/org/industries/:id/prompts/import"), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(imported());
      }),
    );

    const res = await runCli([
      "industries",
      "import-prompts",
      INDUSTRY_UUID,
      "--prompt-ids",
      `${PROMPT_A}, ${PROMPT_B}`,
    ]);

    expect(res.exitCode).toBe(0);
    expect(body).toEqual({ prompt_ids: [PROMPT_A, PROMPT_B] });
  });

  it("puts the exact poll command, with the real import_id, in the envelope's next", async () => {
    // The whole point of the async contract: under --output json stderr is
    // silent, so this is the only place the caller learns what to poll.
    server.use(
      http.post(apiUrl("/org/industries/:id/prompts/import"), () => HttpResponse.json(imported())),
    );

    const res = await runCli([
      "industries",
      "import-prompts",
      INDUSTRY_UUID,
      "--prompt-ids",
      PROMPT_A,
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(0);
    expect((envelope(res).next ?? []).map((s) => s.command)).toContain(
      `senso history-imports get ${IMPORT_ID}`,
    );
    expect(res.data()).toEqual(imported());
    expect(res.stderr).toBe("");
  });

  it("puts the payload on stdout and the confirmation on stderr in plain output", async () => {
    server.use(
      http.post(apiUrl("/org/industries/:id/prompts/import"), () => HttpResponse.json(imported())),
    );

    const res = await runCli([
      "industries",
      "import-prompts",
      INDUSTRY_UUID,
      "--prompt-ids",
      PROMPT_A,
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain("Imported 1 prompt(s); 0 already present.");
    // history_import and defaults_seeded are what a caller acts on next, so
    // plain must render the whole payload, not just the outcomes.
    expect(res.stdout).toContain("geo_question_id");
    expect(res.stdout).toContain(IMPORT_ID);
    expect(res.stdout).toContain("defaults_seeded");
  });

  it("warns when nothing was imported because the texts were already held", async () => {
    server.use(
      http.post(apiUrl("/org/industries/:id/prompts/import"), () =>
        HttpResponse.json(
          imported({
            created: 0,
            skipped: 1,
            outcomes: [
              {
                industry_prompt_id: PROMPT_A,
                status: "skipped",
                geo_question_id: GEO_QUESTION_ID,
                reason: "an organization prompt with identical text already exists",
              },
            ],
          }),
        ),
      ),
    );

    const res = await runCli([
      "industries",
      "import-prompts",
      INDUSTRY_UUID,
      "--prompt-ids",
      PROMPT_A,
      "--output",
      "json",
    ]);

    expect(envelope(res).warnings?.join(" ")).toContain("1 prompt(s) were skipped");
  });

  it("warns that activation wrote run defaults onto an unconfigured organization", async () => {
    server.use(
      http.post(apiUrl("/org/industries/:id/prompts/import"), () =>
        HttpResponse.json(
          imported({
            defaults_seeded: {
              models: ["chatgpt", "perplexity"],
              schedule_dows: [1, 4],
              locations: ["CA"],
            },
          }),
        ),
      ),
    );

    const res = await runCli([
      "industries",
      "import-prompts",
      INDUSTRY_UUID,
      "--prompt-ids",
      PROMPT_A,
      "--output",
      "json",
    ]);

    const warnings = envelope(res).warnings?.join(" ") ?? "";
    expect(warnings).toContain("Activation wrote run defaults");
    expect(warnings).toContain("senso run-config");
  });

  it("says the prompts were still copied when no history import started", async () => {
    server.use(
      http.post(apiUrl("/org/industries/:id/prompts/import"), () =>
        HttpResponse.json(
          imported({
            history_import: {
              status: "skipped",
              import_id: null,
              days: 0,
              reason: "the scheduler has no dispatch configured",
            },
          }),
        ),
      ),
    );

    const res = await runCli([
      "industries",
      "import-prompts",
      INDUSTRY_UUID,
      "--prompt-ids",
      PROMPT_A,
      "--output",
      "json",
    ]);

    const env = envelope(res);
    expect(env.warnings?.join(" ")).toContain("No history import started");
    expect(env.warnings?.join(" ")).toContain("re-run this same command");
    // Nothing to poll, so nothing is offered to poll.
    expect((env.next ?? []).map((s) => s.command)).not.toContain(
      `senso history-imports get ${IMPORT_ID}`,
    );
  });

  it("renders the per-prompt outcomes as a table under --output table", async () => {
    server.use(
      http.post(apiUrl("/org/industries/:id/prompts/import"), () => HttpResponse.json(imported())),
    );

    const res = await runCli([
      "industries",
      "import-prompts",
      INDUSTRY_UUID,
      "--prompt-ids",
      PROMPT_A,
      "--output",
      "table",
    ]);

    expect(res.exitCode).toBe(0);
    for (const column of ["industry_prompt_id", "status", "geo_question_id", "reason"]) {
      expect(res.stdout).toContain(column);
    }
    expect(res.stdout).toContain(GEO_QUESTION_ID);
    expect(res.stderr).not.toContain("which the API did not return");
  });
});
