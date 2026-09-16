/**
 * Command layer: `senso partner`.
 *
 * WHAT IS WORTH PROTECTING HERE is mostly one thing: this is the only group in
 * the CLI that the key `senso login` stores cannot use at all.
 *
 *   - Every command reads a `/partner/*` route, gated by partner authentication
 *     in senso-api. An organization key is refused there, and the generic
 *     handler would answer with "run `senso login`" — the one action that can
 *     never fix it. So the group rewrites that refusal into an explanation that
 *     names partner authentication, says the stored key is not a partner key,
 *     and points at `senso industries` for the same data under an organization
 *     key. Both statuses the middleware can produce are covered below, and the
 *     translation must NOT leak to any other status: a 404 is still a 404.
 *   - `partner industries list` now takes --limit/--offset. The API defaults to
 *     10 rows, so without them only ten industries were ever reachable — the
 *     paging assertions below are what keep that fixed.
 *   - `<industry>` takes a UUID or a name, a name takes the FIRST search match
 *     silently, and a UUID must cost no extra round trip.
 *   - `--models`, the dates and the 90-day window are checked before the
 *     request, so the tests for them register no MSW handler at all.
 *
 * Fixtures are the API's own DTOs — PartnerIndustryListResponse,
 * IndustrySummaryResponse, IndustryBrandDetailResponse,
 * IndustryDomainDetailResponse, AdminIndustryPromptsResponse and
 * GlossaryResponse — because an invented field name is how a blank column
 * ships green.
 *
 * Failure branches come first, as in tests/commands/roles.test.ts.
 */

import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../setup.js";
import { apiUrl, envelope, errorEnvelope, runCli } from "../helpers.js";

/** A real UUID shape, so `resolveIndustryId` takes the no-search branch. */
const INDUSTRY_UUID = "3f7c1a2b-4d5e-4f60-9a1b-2c3d4e5f6071";
const SECOND_INDUSTRY_UUID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const PARTNER_UUID = "2b3c4d5e-6f70-4812-9a3b-4c5d6e7f8091";
const BRAND_UUID = "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d";
const PROMPT_UUID = "a4226991-3d00-49ec-b5cc-95642c946cc0";

/** What RequirePartnerAuth answers a caller it cannot authenticate at all. */
const AUTH_REQUIRED = { status: 401, message: "Authentication required" };

/** What it answers a caller presenting a perfectly good ORGANIZATION key. */
const ORG_KEY_ON_PARTNER_ROUTE = {
  status: 403,
  message:
    "Partner credentials required. This is an organization API key; /api/v1/partner routes need a partner API key or a partner user's JWT. Organization-scoped data is under /api/v1/org.",
};

/** dto.PartnerIndustryListResponse: owned and subscribed, plus the page window. */
const PARTNER_INDUSTRIES = {
  industries: [
    {
      industry_id: INDUSTRY_UUID,
      name: "Automotive",
      slug: "automotive",
      description: "Passenger vehicles and the brands that sell them.",
      partner_id: PARTNER_UUID,
      is_public: false,
      relationship: "owned",
      editable: true,
      enable_runs: true,
      subscriber_count: 0,
      active_prompt_count: 128,
      model_count: 4,
      location_count: 2,
      created_at: "2026-02-11T09:00:00Z",
      updated_at: "2026-09-01T09:00:00Z",
    },
    {
      industry_id: SECOND_INDUSTRY_UUID,
      name: "Insurance",
      slug: "insurance",
      description: "Personal lines insurance carriers and brokers.",
      is_public: true,
      relationship: "subscribed",
      editable: false,
      enable_runs: true,
      subscriber_count: 0,
      active_prompt_count: 91,
      model_count: 3,
      location_count: 1,
      created_at: "2026-02-11T09:00:00Z",
      updated_at: "2026-09-01T09:00:00Z",
    },
  ],
  total: 34,
  limit: 10,
  offset: 0,
  max_limit: 100,
};

/** dto.IndustrySummaryResponse. */
function summary(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    industry_id: INDUSTRY_UUID,
    industry_name: "Automotive",
    window: { from: "2026-06-22", to: "2026-09-14", days: 84 },
    answers_analyzed: 1793,
    prompts_by_stage: null,
    top_brand: {
      brand_id: BRAND_UUID,
      brand_name: "Toyota",
      mention_rate: { value: 0.262, display: "26.2%" },
      entity_type: "brand",
    },
    citation_summary: {
      citation_references: 8421,
      unique_domains: 612,
      official_brand_domain_citations: 903,
      official_brand_domain_share: { value: 0.107, display: "10.7%" },
      external_citations: 7518,
      external_share: { value: 0.893, display: "89.3%" },
    },
    top_external_citers: [{ domain: "caranddriver.com", citation_references: 412 }],
    data_quality: { level: "high", answered_count: 1793, reasons: [] },
    notes: ["Rates are computed over the industry's whole prompt set."],
    definitions: { mention_rate: "Share of answered runs in which the brand was named." },
    ...over,
  };
}

/** dto.IndustryBrandDetailResponse. */
function brandDetail(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    resolved: {
      brand_id: BRAND_UUID,
      brand_key: "toyota",
      brand_name: "Toyota",
      entity_type: "brand",
      matched_on: "Toyota",
      match_confidence: 0.99,
      surface_forms: ["Toyota", "Toyota Motor"],
    },
    window: { from: "2026-06-22", to: "2026-09-14", days: 84 },
    mentioned: true,
    metrics: {
      mention_rate: { value: 0.262, display: "26.2%" },
      share_of_voice: { value: 0.181, display: "18.1%" },
      avg_position: 2.1,
      rank_in_industry: 1,
      brands_ranked: 57,
      sentiment: { positive: 300, neutral: 150, negative: 20 },
      top_cited_domain: "toyota.com",
      owned_citation_share: { value: 0.09, display: "9.0%" },
    },
    by_model: [{ model: "chatgpt", mention_rate: { value: 0.27, display: "27.0%" } }],
    by_stage: null,
    data_quality: { level: "high", answered_count: 1793, reasons: [] },
    notes: [],
    definitions: { share_of_voice: "The brand's share of all brand-mention occurrences." },
    ...over,
  };
}

/** dto.IndustryDomainDetailResponse. */
function domainDetail(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    resolved: {
      domain: "toyota.com",
      host: "toyota.com",
      ownership: "official",
      owned_by_brand: "Toyota",
    },
    window: { from: "2026-06-22", to: "2026-09-14", days: 84 },
    cited: true,
    citation_references: 903,
    rank_in_industry: 2,
    share_of_citations: { value: 0.107, display: "10.7%" },
    co_mentioned_brands: [{ brand_name: "Honda", cooccurrence: 188 }],
    data_quality: { level: "high", answered_count: 1793, reasons: [] },
    notes: [],
    definitions: { citation_references: "Total number of times any source was cited." },
    ...over,
  };
}

/** dto.AdminIndustryPromptsResponse, which is what the partner route returns. */
const PROMPT_METRICS = {
  window: { from: "2026-06-22", to: "2026-09-14" },
  total: 91,
  limit: 100,
  offset: 0,
  industry_prompts: [
    {
      industry_prompt_id: PROMPT_UUID,
      industry_prompt: "Which midsize SUV is most reliable?",
      funnel_stage: "consideration",
      persona: "family buyer",
      category: "reliability",
      models: [
        { model: "chatgpt", answered_count: 84, brand_mention_count: 22, brand_mention_rate: 0.26 },
      ],
      top_three_mentioned: [
        { brand_id: BRAND_UUID, brand_name: "Toyota", mentioned_count: 41 },
        { brand_name: "Honda", mentioned_count: 33 },
      ],
    },
  ],
};

/** dto.GlossaryResponse. */
const GLOSSARY = {
  entries: [
    {
      metric: "mention_rate",
      definition: "Share of answered runs in which the brand was named.",
      denominator: "answered runs in the window (industry-wide)",
      gotcha:
        "Uses the BROAD industry prompt set as denominator. Do not compare it to an org dashboard's mention_rate, which uses that org's own prompt set — different questions, different denominator.",
    },
    {
      metric: "share_of_voice",
      definition: "The brand's share of all brand-mention occurrences.",
      denominator: "Σ mention_total across all brands in the window",
      gotcha: "Mentions are occurrences, not runs; a brand named twice in one answer counts twice.",
    },
  ],
};

describe("partner, when the key is not a partner key", () => {
  it("exits 3 on the 401 and blames partner auth rather than telling the user to log in again", async () => {
    server.use(
      http.get(apiUrl("/partner/industries"), () =>
        HttpResponse.json(AUTH_REQUIRED, { status: 401 }),
      ),
    );

    const res = await runCli(["partner", "industries", "list"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("partner authentication");
    expect(res.stderr).toContain("Authentication required");
    expect(res.stderr).toContain("not a partner key");
    // Never the generic advice, which cannot work here.
    expect(res.stderr).not.toContain("Authentication failed");
    expect(res.stderr).not.toContain("Run `senso login`");
  });

  it("names `senso industries` as the organization-key way to read the same data", async () => {
    server.use(
      http.get(apiUrl("/partner/industries"), () =>
        HttpResponse.json(AUTH_REQUIRED, { status: 401 }),
      ),
    );

    const res = await runCli(["partner", "industries", "list", "--output", "json"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    const { error } = errorEnvelope(res);
    expect(error.code).toBe("unauthorized");
    expect(error.status).toBe(401);
    expect(error.message).toContain("senso industries");
    expect(error.message).toContain("senso analytics");
    // Exactly one hint, and it is the thing to type.
    expect(error.hint).toContain("--api-key <partner-key>");
    expect(error.hint).toContain("SENSO_API_KEY");
  });

  it("gives the same explanation for the 403 an organization key is answered with", async () => {
    server.use(
      http.get(apiUrl("/partner/glossary"), () =>
        HttpResponse.json(ORG_KEY_ON_PARTNER_ROUTE, { status: 403 }),
      ),
    );

    const res = await runCli(["partner", "glossary", "--output", "json"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    const { error } = errorEnvelope(res);
    // The code still says which status it was, so a script switching on the
    // code sees the same values it would anywhere else.
    expect(error.code).toBe("forbidden");
    expect(error.status).toBe(403);
    expect(error.message).toContain("partner authentication");
    // The API's own sentence is passed through, so the caller sees exactly what
    // the middleware said about the key it presented.
    expect(error.message).toContain("This is an organization API key");
    expect(error.hint).toContain("--api-key <partner-key>");
    expect(res.stderr).not.toContain("Permission denied");
  });

  it("translates the failure even when it happens during name resolution", async () => {
    // The refusal comes from the industries search, one request before the
    // command's own — the translation covers the whole action, not the last call.
    server.use(
      http.get(apiUrl("/partner/industries"), () =>
        HttpResponse.json(AUTH_REQUIRED, { status: 401 }),
      ),
    );

    const res = await runCli(["partner", "industries", "summary", "Automotive"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("partner authentication");
  });

  it("says every partner command needs one, in the group's own help", async () => {
    const res = await runCli(["partner", "industries", "list", "--help"]);

    expect(res.stdout).toContain("REQUIRES A PARTNER API KEY");
    expect(res.stdout).toContain("senso industries");
  });
});

describe("partner, when the request fails for some other reason", () => {
  it("exits 3 and explains how to authenticate when there is no API key at all", async () => {
    const res = await runCli(["partner", "industries", "list"], { withKey: false });

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("no API key found");
  });

  it("leaves a 404 alone: it is not an auth problem and must not be described as one", async () => {
    server.use(
      http.get(apiUrl("/partner/industries/:id/summary"), () =>
        HttpResponse.json({ status: 404, message: "Industry not found" }, { status: 404 }),
      ),
    );

    const res = await runCli(["partner", "industries", "summary", INDUSTRY_UUID]);

    expect(res.exitCode).toBe(4);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Not found");
    expect(res.stderr).not.toContain("partner authentication");
  });

  it("leaves a 500 alone, and keeps the retry hint", async () => {
    server.use(
      http.get(apiUrl("/partner/glossary"), () =>
        HttpResponse.json({ status: 500, message: "boom" }, { status: 500 }),
      ),
    );

    const res = await runCli(["partner", "glossary"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Retry shortly");
    expect(res.stderr).not.toContain("partner authentication");
  });

  it("exits 1 on a 503 and says it is not a transient failure", async () => {
    server.use(
      http.get(apiUrl("/partner/glossary"), () =>
        HttpResponse.json({ status: 503, message: "Service unavailable" }, { status: 503 }),
      ),
    );

    const res = await runCli(["partner", "glossary"]);

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("not a transient failure");
  });

  it("exits 5 on a 429, so a caller in a loop knows to back off", async () => {
    server.use(
      http.get(apiUrl("/partner/glossary"), () =>
        HttpResponse.json({ status: 429, message: "Too many requests" }, { status: 429 }),
      ),
    );

    const res = await runCli(["partner", "glossary"]);

    expect(res.exitCode).toBe(5);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Rate limited");
  });

  it("reports a malformed body rather than throwing a parse error at the user", async () => {
    server.use(http.get(apiUrl("/partner/glossary"), () => new HttpResponse("<html>nope</html>")));

    const res = await runCli(["partner", "glossary"]);

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("Invalid JSON response");
  });

  it("names the valid formats when --output is not one of them", async () => {
    const res = await runCli(["partner", "industries", "list", "--output", "yaml"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("json, table, plain");
  });
});

describe("partner, when a flag is not a valid value", () => {
  // Nothing here registers an MSW handler: reaching the network fails the test.

  it("exits 2 when --models names a model that is not in the allow-list", async () => {
    const res = await runCli([
      "partner",
      "industries",
      "summary",
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
    expect(error.hint).toContain("senso analytics filters");
  });

  it("exits 2 when a date is an instant rather than YYYY-MM-DD", async () => {
    const res = await runCli([
      "partner",
      "industries",
      "summary",
      INDUSTRY_UUID,
      "--to",
      "2026-09-14T00:00:00Z",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    expect(errorEnvelope(res).error.field).toBe("--to");
    expect(errorEnvelope(res).error.message).toContain("not a YYYY-MM-DD date");
  });

  it("exits 2 when the window is longer than 90 days", async () => {
    const res = await runCli([
      "partner",
      "industries",
      "prompt-metrics",
      INDUSTRY_UUID,
      "--from",
      "2026-06-01",
      "--to",
      "2026-09-14",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    expect(errorEnvelope(res).error.message).toContain("the maximum is 90");
  });

  it("exits 2 when --limit is outside 1-100", async () => {
    const res = await runCli([
      "partner",
      "industries",
      "list",
      "--limit",
      "101",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    expect(errorEnvelope(res).error).toMatchObject({ field: "--limit", received: "101" });
  });

  it("exits 2 when --offset is negative", async () => {
    const res = await runCli(["partner", "industries", "list", "--offset", "-1"]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("--offset");
  });

  it("exits 2 when <brandName> is empty", async () => {
    const res = await runCli([
      "partner",
      "industries",
      "brand",
      INDUSTRY_UUID,
      "  ",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    expect(errorEnvelope(res).error.field).toBe("<brandName>");
  });

  it("exits 2 when <domain> is empty", async () => {
    const res = await runCli([
      "partner",
      "industries",
      "domain",
      INDUSTRY_UUID,
      "  ",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    expect(errorEnvelope(res).error.field).toBe("<domain>");
  });
});

describe("partner, resolving the <industry> argument", () => {
  it("uses a UUID directly, without a search request", async () => {
    let searched = false;
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/partner/industries"), () => {
        searched = true;
        return HttpResponse.json(PARTNER_INDUSTRIES);
      }),
      http.get(apiUrl("/partner/industries/:id/summary"), ({ request }) => {
        seen = request;
        return HttpResponse.json(summary());
      }),
    );

    const res = await runCli(["partner", "industries", "summary", INDUSTRY_UUID]);

    expect(res.exitCode).toBe(0);
    // A round trip per command that nobody asked for is the regression here.
    expect(searched).toBe(false);
    expect(new URL(seen!.url).pathname).toBe(`/api/v1/partner/industries/${INDUSTRY_UUID}/summary`);
  });

  it("accepts a UUID in upper case and with surrounding whitespace", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/partner/industries/:id/summary"), ({ request }) => {
        seen = request;
        return HttpResponse.json(summary());
      }),
    );

    const res = await runCli([
      "partner",
      "industries",
      "summary",
      ` ${INDUSTRY_UUID.toUpperCase()} `,
    ]);

    expect(res.exitCode).toBe(0);
    expect(new URL(seen!.url).pathname).toBe(
      `/api/v1/partner/industries/${INDUSTRY_UUID.toUpperCase()}/summary`,
    );
  });

  it("searches the PARTNER catalog, which is a different set from the public one", async () => {
    let search: Request | undefined;
    server.use(
      http.get(apiUrl("/partner/industries"), ({ request }) => {
        search = request;
        return HttpResponse.json(PARTNER_INDUSTRIES);
      }),
      http.get(apiUrl("/partner/industries/:id/summary"), () => HttpResponse.json(summary())),
    );

    const res = await runCli(["partner", "industries", "summary", "Automotive"]);

    expect(res.exitCode).toBe(0);
    expect(new URL(search!.url).pathname).toBe("/api/v1/partner/industries");
    expect(new URL(search!.url).searchParams.get("search")).toBe("Automotive");
  });

  it("takes the FIRST search match, even when a second one also matched", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/partner/industries"), () => HttpResponse.json(PARTNER_INDUSTRIES)),
      http.get(apiUrl("/partner/industries/:id/summary"), ({ request }) => {
        seen = request;
        return HttpResponse.json(summary());
      }),
    );

    const res = await runCli(["partner", "industries", "summary", "auto"]);

    expect(res.exitCode).toBe(0);
    expect(new URL(seen!.url).pathname).toBe(`/api/v1/partner/industries/${INDUSTRY_UUID}/summary`);
    expect(new URL(seen!.url).pathname).not.toContain(SECOND_INDUSTRY_UUID);
  });

  it("exits 4 quoting the name back, and naming the partner listing", async () => {
    server.use(
      http.get(apiUrl("/partner/industries"), () =>
        HttpResponse.json({ industries: [], total: 0, limit: 10, offset: 0, max_limit: 100 }),
      ),
    );

    const res = await runCli([
      "partner",
      "industries",
      "summary",
      "Underwater Basket Weaving",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(4);
    expect(res.stdout).toBe("");
    const { error } = errorEnvelope(res);
    expect(error).toMatchObject({
      code: "not_found",
      field: "<industry>",
      received: "Underwater Basket Weaving",
    });
    expect(error.message).toContain('matches "Underwater Basket Weaving"');
    expect(error.hint).toContain("senso partner industries list");
  });

  it("exits 4 when the first match carries no industry_id", async () => {
    server.use(
      http.get(apiUrl("/partner/industries"), () =>
        HttpResponse.json({ industries: [{ name: "Automotive" }], total: 1 }),
      ),
    );

    const res = await runCli(["partner", "industries", "summary", "Automotive"]);

    expect(res.exitCode).toBe(4);
    expect(res.stdout).toBe("");
  });

  it("exits 2 when <industry> is empty, before any request", async () => {
    const res = await runCli(["partner", "industries", "summary", "", "--output", "json"]);

    expect(res.exitCode).toBe(2);
    expect(errorEnvelope(res).error.field).toBe("<industry>");
  });
});

describe("partner industries list", () => {
  it("sends --limit and --offset, which is the only way past the API's default of 10", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/partner/industries"), ({ request }) => {
        seen = request;
        return HttpResponse.json(PARTNER_INDUSTRIES);
      }),
    );

    await runCli([
      "partner",
      "industries",
      "list",
      "--search",
      "auto",
      "--limit",
      "100",
      "--offset",
      "20",
    ]);

    const url = new URL(seen!.url);
    expect(url.pathname).toBe("/api/v1/partner/industries");
    expect(url.searchParams.get("search")).toBe("auto");
    expect(url.searchParams.get("limit")).toBe("100");
    expect(url.searchParams.get("offset")).toBe("20");
  });

  it("sends no query at all when no flag is given", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/partner/industries"), ({ request }) => {
        seen = request;
        return HttpResponse.json(PARTNER_INDUSTRIES);
      }),
    );

    await runCli(["partner", "industries", "list"]);

    expect(seen?.method).toBe("GET");
    expect(new URL(seen!.url).search).toBe("");
  });

  it("reports how much of the catalog was left behind, with a runnable next page", async () => {
    // The whole reason --limit/--offset exist here: 34 industries, 10 per page.
    server.use(
      http.get(apiUrl("/partner/industries"), () => HttpResponse.json(PARTNER_INDUSTRIES)),
    );

    const res = await runCli(["partner", "industries", "list", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    const page = envelope(res).page;
    expect(page).toMatchObject({ offset: 0, limit: 10, returned: 2, total: 34, has_more: true });
    expect(page?.next).toBe("senso partner industries list --offset 2");
  });

  it("keeps the caller's own filters in the next-page command", async () => {
    server.use(
      http.get(apiUrl("/partner/industries"), () => HttpResponse.json(PARTNER_INDUSTRIES)),
    );

    const res = await runCli([
      "partner",
      "industries",
      "list",
      "--search",
      "auto",
      "--limit",
      "10",
      "--output",
      "json",
    ]);

    expect(envelope(res).page?.next).toBe(
      "senso partner industries list --search auto --limit 10 --offset 2",
    );
  });

  it("renders every declared column with a value under --output table", async () => {
    server.use(
      http.get(apiUrl("/partner/industries"), () => HttpResponse.json(PARTNER_INDUSTRIES)),
    );

    const res = await runCli(["partner", "industries", "list", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toMatch(
      /industry_id\s+name\s+slug\s+relationship\s+active_prompt_count\s+model_count\s+location_count/,
    );
    // relationship is the field that says which rows are editable, and it was
    // absent from the old fixture entirely.
    expect(res.stdout).toContain("owned");
    expect(res.stdout).toContain("subscribed");
    expect(res.stdout).toContain("Automotive");
    expect(res.stderr).not.toContain("which the API did not return");
  });

  it("returns the payload unmodified under --output json, with nothing on stderr", async () => {
    server.use(
      http.get(apiUrl("/partner/industries"), () => HttpResponse.json(PARTNER_INDUSTRIES)),
    );

    const res = await runCli(["partner", "industries", "list", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toEqual(PARTNER_INDUSTRIES);
    expect(res.stderr).toBe("");
  });

  it("offers the first industry's headline numbers", async () => {
    server.use(
      http.get(apiUrl("/partner/industries"), () => HttpResponse.json(PARTNER_INDUSTRIES)),
    );

    const res = await runCli(["partner", "industries", "list", "--output", "json"]);

    expect((envelope(res).next ?? []).map((s) => s.command)).toContain(
      `senso partner industries summary ${INDUSTRY_UUID}`,
    );
  });

  it("says why an empty listing may be empty", async () => {
    server.use(
      http.get(apiUrl("/partner/industries"), () =>
        HttpResponse.json({ industries: [], total: 0, limit: 10, offset: 0, max_limit: 100 }),
      ),
    );

    const res = await runCli(["partner", "industries", "list", "--search", "zzz"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("No industries found.");
    expect(res.stderr).toContain("--search");
  });
});

describe("partner industries summary", () => {
  it("sends from, to, location and models as query parameters", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/partner/industries/:id/summary"), ({ request }) => {
        seen = request;
        return HttpResponse.json(summary());
      }),
    );

    await runCli([
      "partner",
      "industries",
      "summary",
      INDUSTRY_UUID,
      "--from",
      "2026-08-01",
      "--to",
      "2026-08-31",
      "--location",
      "US",
      "--models",
      "chatgpt,gemini",
    ]);

    const params = new URL(seen!.url).searchParams;
    expect(params.get("from")).toBe("2026-08-01");
    expect(params.get("to")).toBe("2026-08-31");
    expect(params.get("location")).toBe("US");
    expect(params.get("models")).toBe("chatgpt,gemini");
  });

  it("omits the filters entirely when they are not given", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/partner/industries/:id/summary"), ({ request }) => {
        seen = request;
        return HttpResponse.json(summary());
      }),
    );

    await runCli(["partner", "industries", "summary", INDUSTRY_UUID]);

    // Not `from=`, not `from=undefined`: absent.
    expect(new URL(seen!.url).search).toBe("");
  });

  it("warns that a null owned-vs-external share is not 0%", async () => {
    server.use(
      http.get(apiUrl("/partner/industries/:id/summary"), () =>
        HttpResponse.json(
          summary({
            citation_summary: {
              citation_references: 8421,
              unique_domains: 612,
              official_brand_domain_citations: 0,
              official_brand_domain_share: null,
              external_citations: 8421,
              external_share: null,
            },
          }),
        ),
      ),
    );

    const res = await runCli([
      "partner",
      "industries",
      "summary",
      INDUSTRY_UUID,
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(0);
    const warnings = envelope(res).warnings?.join(" ") ?? "";
    expect(warnings).toContain("not 0%");
    expect(warnings).toContain("registry has not been seeded");
  });

  it("says nothing when the share is a real number", async () => {
    server.use(
      http.get(apiUrl("/partner/industries/:id/summary"), () => HttpResponse.json(summary())),
    );

    const res = await runCli([
      "partner",
      "industries",
      "summary",
      INDUSTRY_UUID,
      "--output",
      "json",
    ]);

    expect(envelope(res).warnings).toBeUndefined();
    expect(res.data()).toEqual(summary());
  });

  it("renders the nested blocks as sub-blocks, not one line of JSON, in plain output", async () => {
    server.use(
      http.get(apiUrl("/partner/industries/:id/summary"), () => HttpResponse.json(summary())),
    );

    const res = await runCli(["partner", "industries", "summary", INDUSTRY_UUID]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("citation_summary");
    expect(res.stdout).toContain("official_brand_domain_share");
    expect(res.stdout).toContain("10.7%");
    expect(res.stdout).not.toContain('{"citation_references"');
  });

  it("points at the glossary, because the metric names are the hard part", async () => {
    server.use(
      http.get(apiUrl("/partner/industries/:id/summary"), () => HttpResponse.json(summary())),
    );

    const res = await runCli([
      "partner",
      "industries",
      "summary",
      INDUSTRY_UUID,
      "--output",
      "json",
    ]);

    const commands = (envelope(res).next ?? []).map((s) => s.command);
    expect(commands).toContain("senso partner glossary");
    expect(commands).toContain(`senso partner industries prompt-metrics ${INDUSTRY_UUID}`);
  });
});

describe("partner industries brand", () => {
  it("puts the brand name in the path, percent-encoded", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/partner/industries/:id/brands/:brand"), ({ request }) => {
        seen = request;
        return HttpResponse.json(brandDetail());
      }),
    );

    const res = await runCli([
      "partner",
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
      `/api/v1/partner/industries/${INDUSTRY_UUID}/brands/${encodeURIComponent("Acme & Co")}`,
    );
    expect(url.searchParams.get("location")).toBe("US");
  });

  it("resolves a named industry before fetching the brand", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/partner/industries"), () => HttpResponse.json(PARTNER_INDUSTRIES)),
      http.get(apiUrl("/partner/industries/:id/brands/:brand"), ({ request }) => {
        seen = request;
        return HttpResponse.json(brandDetail());
      }),
    );

    const res = await runCli(["partner", "industries", "brand", "Automotive", "Toyota"]);

    expect(res.exitCode).toBe(0);
    expect(new URL(seen!.url).pathname).toBe(
      `/api/v1/partner/industries/${INDUSTRY_UUID}/brands/Toyota`,
    );
  });

  it("exits 0 for a brand that was never named, and says that is an answer", async () => {
    server.use(
      http.get(apiUrl("/partner/industries/:id/brands/:brand"), () =>
        HttpResponse.json(brandDetail({ mentioned: false, metrics: null })),
      ),
    );

    const res = await runCli([
      "partner",
      "industries",
      "brand",
      INDUSTRY_UUID,
      "Nobody",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.data<{ mentioned: boolean }>().mentioned).toBe(false);
    expect(envelope(res).warnings?.join(" ")).toContain("not an error");
  });

  it("shows the fuzzy-match fields rather than burying them in a blob", async () => {
    server.use(
      http.get(apiUrl("/partner/industries/:id/brands/:brand"), () =>
        HttpResponse.json(brandDetail()),
      ),
    );

    const res = await runCli(["partner", "industries", "brand", INDUSTRY_UUID, "Toyota"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("match_confidence");
    expect(res.stdout).toContain("0.99");
    expect(res.stdout).toContain("rank_in_industry");
  });
});

describe("partner industries domain", () => {
  it("puts the domain in the path and sends the window through", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/partner/industries/:id/domains/:domain"), ({ request }) => {
        seen = request;
        return HttpResponse.json(domainDetail());
      }),
    );

    const res = await runCli([
      "partner",
      "industries",
      "domain",
      INDUSTRY_UUID,
      "toyota.com",
      "--from",
      "2026-08-01",
    ]);

    expect(res.exitCode).toBe(0);
    const url = new URL(seen!.url);
    expect(url.pathname).toBe(`/api/v1/partner/industries/${INDUSTRY_UUID}/domains/toyota.com`);
    expect(url.searchParams.get("from")).toBe("2026-08-01");
  });

  it("warns that --url replaced <domain>, because the payload does not say which", async () => {
    server.use(
      http.get(apiUrl("/partner/industries/:id/domains/:domain"), () =>
        HttpResponse.json(domainDetail()),
      ),
    );

    const res = await runCli([
      "partner",
      "industries",
      "domain",
      INDUSTRY_UUID,
      "toyota.com",
      "--url",
      "https://toyota.com/build",
      "--output",
      "json",
    ]);

    expect(envelope(res).warnings?.join(" ")).toContain(
      "--url replaced <domain>: this reports on https://toyota.com/build",
    );
  });

  it("exits 0 for a domain that was never cited", async () => {
    server.use(
      http.get(apiUrl("/partner/industries/:id/domains/:domain"), () =>
        HttpResponse.json(
          domainDetail({
            resolved: { domain: "nope.example", host: "nope.example", ownership: "unknown" },
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
      "partner",
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

describe("partner industries prompt-metrics", () => {
  it("sends the shared filters plus limit and offset", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/partner/industries/:id/prompt-metrics"), ({ request }) => {
        seen = request;
        return HttpResponse.json(PROMPT_METRICS);
      }),
    );

    await runCli([
      "partner",
      "industries",
      "prompt-metrics",
      INDUSTRY_UUID,
      "--from",
      "2026-08-01",
      "--models",
      "chatgpt",
      "--limit",
      "50",
      "--offset",
      "100",
    ]);

    const url = new URL(seen!.url);
    expect(url.pathname).toBe(`/api/v1/partner/industries/${INDUSTRY_UUID}/prompt-metrics`);
    expect(url.searchParams.get("from")).toBe("2026-08-01");
    expect(url.searchParams.get("models")).toBe("chatgpt");
    expect(url.searchParams.get("limit")).toBe("50");
    expect(url.searchParams.get("offset")).toBe("100");
  });

  it("renders every declared column with a value, and reports the window on stderr", async () => {
    server.use(
      http.get(apiUrl("/partner/industries/:id/prompt-metrics"), () =>
        HttpResponse.json(PROMPT_METRICS),
      ),
    );

    const res = await runCli([
      "partner",
      "industries",
      "prompt-metrics",
      INDUSTRY_UUID,
      "--output",
      "table",
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toMatch(
      /industry_prompt_id\s+industry_prompt\s+funnel_stage\s+persona\s+category/,
    );
    expect(res.stdout).toContain("family buyer");
    expect(res.stdout).toContain("reliability");
    expect(res.stderr).toContain("Window: 2026-06-22 to 2026-09-14");
    expect(res.stderr).not.toContain("which the API did not return");
  });

  it("warns that an empty list does NOT mean the industry_id was wrong", async () => {
    // This endpoint never 404s, so a well-formed id that belongs to nothing is
    // indistinguishable from an industry with no prompts in the window.
    server.use(
      http.get(apiUrl("/partner/industries/:id/prompt-metrics"), () =>
        HttpResponse.json({ ...PROMPT_METRICS, total: 0, industry_prompts: [] }),
      ),
    );

    const res = await runCli([
      "partner",
      "industries",
      "prompt-metrics",
      INDUSTRY_UUID,
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(0);
    const env = envelope(res);
    expect(env.warnings?.join(" ")).toContain("this endpoint never returns 404");
    expect(env.next).toBeUndefined();
  });

  it("offers the industry totals these prompts add up to", async () => {
    server.use(
      http.get(apiUrl("/partner/industries/:id/prompt-metrics"), () =>
        HttpResponse.json(PROMPT_METRICS),
      ),
    );

    const res = await runCli([
      "partner",
      "industries",
      "prompt-metrics",
      INDUSTRY_UUID,
      "--output",
      "json",
    ]);

    expect((envelope(res).next ?? []).map((s) => s.command)).toContain(
      `senso partner industries summary ${INDUSTRY_UUID}`,
    );
  });
});

describe("partner glossary", () => {
  it("GETs /partner/glossary, which takes no industry and no filters", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/partner/glossary"), ({ request }) => {
        seen = request;
        return HttpResponse.json(GLOSSARY);
      }),
    );

    const res = await runCli(["partner", "glossary", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(seen?.method).toBe("GET");
    expect(new URL(seen!.url).pathname).toBe("/api/v1/partner/glossary");
    expect(new URL(seen!.url).search).toBe("");
    expect(res.data()).toEqual(GLOSSARY);
  });

  it("keeps every gotcha intact in plain output, where nothing is truncated", async () => {
    // The gotcha is the load-bearing field and it is far longer than a cell.
    server.use(http.get(apiUrl("/partner/glossary"), () => HttpResponse.json(GLOSSARY)));

    const res = await runCli(["partner", "glossary"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("different questions, different denominator.");
    expect(res.stdout).not.toContain("…");
  });

  it("warns that --output table cuts the definitions short", async () => {
    server.use(http.get(apiUrl("/partner/glossary"), () => HttpResponse.json(GLOSSARY)));

    const res = await runCli(["partner", "glossary", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toMatch(/metric\s+definition\s+denominator\s+gotcha/);
    expect(res.stderr).toContain("truncates each cell at 48 characters");
    expect(res.stderr).not.toContain("which the API did not return");
  });

  it("does not warn about truncation in the formats that do not truncate", async () => {
    server.use(http.get(apiUrl("/partner/glossary"), () => HttpResponse.json(GLOSSARY)));

    const res = await runCli(["partner", "glossary", "--output", "json"]);

    expect(envelope(res).warnings).toBeUndefined();
  });
});
