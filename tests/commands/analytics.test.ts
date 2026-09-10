/**
 * Command layer: `senso analytics`.
 *
 * Ten subcommands over nine read-only endpoints, and the half of this file that
 * earns its place is the request half. Every analytics command is a filter over
 * a rollup, and a filter the API does not recognize is not an error — it is
 * ignored, and the caller gets a WIDER result set back than they asked for. A
 * renamed query parameter therefore produces a plausible number rather than a
 * failure, so each subcommand's full query string is asserted here, by the
 * exact name the API reads, rather than left to be noticed in someone's
 * terminal.
 *
 * The rendering half protects the group's other promise: that a metric whose
 * denominator was zero prints as "—" and never as 0%, and that the `notes[]`
 * every response carries reach a human in plain and table output while staying
 * out of `--output json`, where they are already part of the payload and prose
 * after the document would break every parser downstream.
 *
 * Failure branches come first, on the group's representative command, exactly
 * as in tests/commands/roles.test.ts.
 */

import { describe, expect, it } from "vitest";
import { http, HttpResponse, type JsonBodyType } from "msw";
import { server, TEST_API_KEY } from "../setup.js";
import { apiUrl, runCli } from "../helpers.js";
import type {
  AnalyticsWindow,
  CitationSeriesPoint,
  CitedDomainItem,
  CitedPageItem,
  DataQuality,
  Deltas,
  Denominators,
  FilterOption,
  GlossaryEntry,
  LatestAnswerItem,
  MentionSeriesPoint,
  Metrics,
  PromptPerformanceItem,
  Rate,
  Totals,
} from "../../src/commands/analytics/types.js";

// ---------------------------------------------------------------------------
// Fixtures, built from the interfaces in src/commands/analytics/types.ts
// ---------------------------------------------------------------------------

const r = (value: number, display: string): Rate => ({ value, display });

const WINDOW: AnalyticsWindow = {
  from: "2025-08-01",
  to: "2025-08-30",
  days: 30,
  latest_data_day: "2025-08-29",
};

const QUALITY: DataQuality = { level: "good", answered_count: 460, reasons: [] };

const NOTES = [
  "Share of voice divides by mentions of every brand the models named, not only tracked competitors.",
  "A metric is null, and renders as an em dash, when its denominator was zero.",
];

const TOTALS: Totals = {
  run_count: 480,
  answered_count: 460,
  mentioned_count: 122,
  mention_total: 168,
  tracked_mention_total: 540,
  brand_mention_total: 1400,
  rank_sum: 390,
  sentiment: { positive: 70, neutral: 40, negative: 12 },
  cited_run_count: 300,
  primary_cited_run_count: 45,
  tracked_cited_run_count: 90,
  external_cited_run_count: 280,
  cited_total: 1200,
  primary_cited_total: 60,
  tracked_cited_total: 150,
  external_cited_total: 990,
  prompt_count: 24,
  model_count: 4,
  location_count: 2,
};

const METRICS: Metrics = {
  mention_rate: r(0.2652, "26.5%"),
  share_of_voice: r(0.12, "12.0%"),
  avg_rank: r(3.2, "#3.2"),
  primary_citation_rate: r(0.15, "15.0%"),
  tracked_citation_rate: r(0.3, "30.0%"),
  external_citation_rate: r(0.9333, "93.3%"),
  primary_citation_share: r(0.05, "5.0%"),
  tracked_citation_share: r(0.125, "12.5%"),
  external_citation_share: r(0.825, "82.5%"),
  citations_per_answer: r(4, "4.0"),
};

const DELTAS: Deltas = {
  mention_rate: { prev: 0.21, delta: 0.055, direction: "improved", display: "+5.5pp" },
  share_of_voice: { prev: 0.132, delta: -0.012, direction: "declined", display: "-1.2pp" },
  primary_citation_rate: null,
};

const SUMMARY = {
  window: WINDOW,
  totals: TOTALS,
  metrics: METRICS,
  deltas: DELTAS,
  data_quality: QUALITY,
  notes: NOTES,
};

const MENTION_POINT: MentionSeriesPoint = {
  period_start: "2025-08-29",
  run_count: 16,
  answered_count: 16,
  mentioned_count: 5,
  mention_total: 7,
  tracked_mention_total: 21,
  brand_mention_total: 54,
  rank_sum: 14,
  sentiment: { positive: 3, neutral: 2, negative: 0 },
  mention_rate: r(0.3125, "31.3%"),
  share_of_voice: r(0.1296, "13.0%"),
  avg_rank: r(2.8, "#2.8"),
};

const MENTIONS = {
  window: WINDOW,
  group_by: "day",
  totals: TOTALS,
  metrics: METRICS,
  series: [MENTION_POINT],
  data_quality: QUALITY,
  notes: NOTES,
};

const CITATION_POINT: CitationSeriesPoint = {
  period_start: "2025-08-29",
  run_count: 16,
  answered_count: 16,
  cited_run_count: 11,
  primary_cited_run_count: 2,
  tracked_cited_run_count: 3,
  external_cited_run_count: 10,
  cited_total: 44,
  primary_cited_total: 3,
  tracked_cited_total: 6,
  external_cited_total: 35,
  primary_citation_rate: r(0.1818, "18.2%"),
  tracked_citation_rate: r(0.2727, "27.3%"),
  external_citation_rate: r(0.9091, "90.9%"),
  primary_citation_share: r(0.0682, "6.8%"),
  tracked_citation_share: r(0.1364, "13.6%"),
  external_citation_share: r(0.7955, "79.5%"),
};

const CITATIONS = {
  window: WINDOW,
  group_by: "day",
  totals: TOTALS,
  metrics: METRICS,
  series: [CITATION_POINT],
  data_quality: QUALITY,
  notes: NOTES,
};

const DENOMINATORS: Denominators = {
  cited_run_count: 300,
  cited_total: 1200,
  unique_domains: 88,
  unique_pages: 412,
};

const DOMAIN_ROW: CitedDomainItem = {
  domain: "senso.ai",
  tier: "primary",
  tier_label: "Owned",
  cited_run_count: 45,
  cited_total: 60,
  citation_coverage: r(0.15, "15.0%"),
  citation_share: r(0.05, "5.0%"),
  avg_citation_rank: 2.4,
  rank_by_citations: 1,
};

const DOMAINS = {
  window: WINDOW,
  denominators: DENOMINATORS,
  total: 88,
  limit: 50,
  offset: 0,
  domains: [DOMAIN_ROW],
  data_quality: QUALITY,
  notes: NOTES,
};

const PAGE_ROW: CitedPageItem = {
  url: "https://senso.ai/blog/geo-metrics",
  domain: "senso.ai",
  tier: "primary",
  tier_label: "Owned",
  cited_run_count: 18,
  cited_total: 22,
  citation_coverage: r(0.06, "6.0%"),
  citation_share: r(0.0183, "1.8%"),
  avg_citation_rank: 3.1,
  top_prompts: [
    {
      prompt_id: "prm_a1",
      prompt_text: "what is generative engine optimization",
      cited_run_count: 9,
    },
  ],
};

const PAGES = {
  window: WINDOW,
  denominators: DENOMINATORS,
  total: 412,
  limit: 50,
  offset: 0,
  pages: [PAGE_ROW],
  data_quality: QUALITY,
  notes: NOTES,
};

const PROMPT_ROW: PromptPerformanceItem = {
  prompt_id: "prm_a1",
  prompt_text: "what is generative engine optimization",
  prompt_type: "awareness",
  tags: ["launch", "geo"],
  run_count: 40,
  answered_count: 38,
  mentioned_count: 11,
  cited_run_count: 24,
  primary_cited_run_count: 4,
  sentiment: { positive: 7, neutral: 3, negative: 1 },
  mention_rate: r(0.2895, "28.9%"),
  share_of_voice: r(0.104, "10.4%"),
  avg_rank: r(3.6, "#3.6"),
  primary_citation_rate: r(0.1667, "16.7%"),
  latest: {
    run_at: "2025-08-29T06:04:11Z",
    answer_count: 8,
    mentioned_count: 3,
    models: ["gpt-4o", "claude-sonnet"],
    share_of_voice: r(0.1875, "18.8%"),
  },
};

const PROMPTS = {
  window: WINDOW,
  totals: TOTALS,
  metrics: METRICS,
  total: 24,
  limit: 50,
  offset: 0,
  prompts: [PROMPT_ROW],
  data_quality: QUALITY,
  notes: NOTES,
};

const ANSWER_ROW: LatestAnswerItem = {
  prompt_id: "prm_a1",
  prompt_text: "what is generative engine optimization",
  prompt_type: "awareness",
  provider: "openai",
  model: "gpt-4o",
  location: "US/California",
  run_at: "2025-08-29T06:04:11Z",
  response_text: "Generative engine optimization is the practice of ...",
  empty: false,
  mentioned: true,
  rank: 2,
  sentiment: "positive",
  sov_pct: 18.75,
  citations: [
    { url: "https://senso.ai/blog/geo-metrics", domain: "senso.ai", citation_type: "primary" },
  ],
  competitor_mentions: { "acme.com": 2 },
  has_primary_citation: true,
  has_tracked_citation: false,
  has_external_citation: true,
};

const PROMPT_DETAIL = {
  prompt_id: "prm_a1",
  prompt_text: "what is generative engine optimization",
  prompt_type: "awareness",
  tags: ["launch"],
  window: WINDOW,
  totals: TOTALS,
  metrics: METRICS,
  series: [MENTION_POINT],
  latest_answers: [ANSWER_ROW],
  data_quality: QUALITY,
  notes: NOTES,
};

const ANSWERS = {
  total: 96,
  limit: 25,
  offset: 0,
  answers: [ANSWER_ROW],
  notes: NOTES,
};

const GLOSSARY_ENTRY: GlossaryEntry = {
  metric: "Citation Share",
  definition: "This tier's citation instances divided by every citation instance.",
  denominator: "S — total citation instances",
  gotcha: "Not interchangeable with Citation Rate, which divides by D.",
};

const GLOSSARY = {
  entries: [
    GLOSSARY_ENTRY,
    // No denominator and no gotcha: the placeholder path in the table renderer.
    { metric: "Run Count", definition: "Answers collected in the window." },
  ],
};

const MODEL: FilterOption = { id: "gpt-4o", display_name: "GPT-4o" };

const FILTERS = {
  models: [MODEL],
  locations: ["US", "US/California"],
  prompt_types: ["awareness", "decision"],
  tags: ["launch"],
  tracked_competitors: [{ id: "cmp_1", display_name: "Acme" }],
  date_range: { earliest_day: "2025-06-01", latest_day: "2025-08-29" },
  notes: NOTES,
};

// ---------------------------------------------------------------------------
// Capturing what went on the wire
// ---------------------------------------------------------------------------

interface Capture {
  req?: Request;
}

/** Registers a GET handler that records the request and answers with `payload`. */
function stub(path: string, payload: JsonBodyType): Capture {
  const captured: Capture = {};
  server.use(
    http.get(apiUrl(path), ({ request }) => {
      captured.req = request;
      return HttpResponse.json(payload);
    }),
  );
  return captured;
}

/** The method, path and query of the captured request, for one assertion each. */
function requested(captured: Capture): {
  method: string;
  path: string;
  params: Record<string, string>;
} {
  if (!captured.req) throw new Error("no request reached the handler");
  const url = new URL(captured.req.url);
  return {
    method: captured.req.method,
    path: url.pathname,
    params: Object.fromEntries(url.searchParams),
  };
}

/** The pathname an endpoint lives at, independent of the test base URL. */
const pathOf = (path: string): string => new URL(apiUrl(path)).pathname;

/** The six window filters, as a user would type them. */
const WINDOW_FLAGS = [
  "--from",
  "2025-08-01",
  "--to",
  "2025-08-30",
  "--models",
  "gpt-4o,claude-sonnet",
  "--location",
  "US,US/California",
  "--prompt-type",
  "consideration",
];

/** What those flags must become on the query string. */
const WINDOW_PARAMS = {
  from: "2025-08-01",
  to: "2025-08-30",
  models: "gpt-4o,claude-sonnet",
  location: "US,US/California",
  prompt_type: "consideration",
};

// ---------------------------------------------------------------------------
// Failure branches
// ---------------------------------------------------------------------------

describe("analytics summary, when the request fails", () => {
  it("exits 3 and explains how to authenticate when there is no API key", async () => {
    const res = await runCli(["analytics", "summary"], { withKey: false });

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("no API key found");
    expect(res.stderr).toContain("SENSO_API_KEY");
  });

  it("exits 3 when the API rejects the key", async () => {
    server.use(
      http.get(apiUrl("/org/analytics/summary"), () =>
        HttpResponse.json({ error: "invalid key" }, { status: 401 }),
      ),
    );

    const res = await runCli(["analytics", "summary"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Authentication failed");
  });

  it("exits 3 when the key is valid but lacks analytics access", async () => {
    server.use(
      http.get(apiUrl("/org/analytics/summary"), () =>
        HttpResponse.json({ error: "analytics not enabled" }, { status: 403 }),
      ),
    );

    const res = await runCli(["analytics", "summary"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Permission denied");
  });

  it("exits 4 when the prompt being drilled into does not exist", async () => {
    server.use(
      http.get(
        apiUrl("/org/analytics/prompts/:promptId"),
        () => new HttpResponse(null, { status: 404 }),
      ),
    );

    const res = await runCli(["analytics", "prompt", "prm_missing"]);

    expect(res.exitCode).toBe(4);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Not found");
  });

  it("exits 1 on a 500 and says it is not the caller's fault", async () => {
    server.use(
      http.get(apiUrl("/org/analytics/summary"), () => new HttpResponse(null, { status: 502 })),
    );

    const res = await runCli(["analytics", "summary"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("not your fault");
  });

  it("reports a malformed body rather than throwing a parse error at the user", async () => {
    server.use(
      http.get(apiUrl("/org/analytics/summary"), () => new HttpResponse("<html>nope</html>")),
    );

    const res = await runCli(["analytics", "summary"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Invalid JSON response");
  });

  it("writes the failure to stderr as JSON, leaving stdout empty, under --output json", async () => {
    server.use(
      http.get(apiUrl("/org/analytics/summary"), () =>
        HttpResponse.json({ error: "nope" }, { status: 403 }),
      ),
    );

    const res = await runCli(["analytics", "summary", "--output", "json"]);

    expect(res.exitCode).toBe(3);
    // A caller redirecting stdout to a file gets an empty file, not a file
    // containing an error object it would later read as analytics data.
    expect(res.stdout).toBe("");
    expect(JSON.parse(res.stderr)).toMatchObject({ error: { code: "forbidden", status: 403 } });
  });
});

// ---------------------------------------------------------------------------
// The exact request, for every subcommand
// ---------------------------------------------------------------------------

describe("analytics summary, on the wire", () => {
  it("GETs the summary endpoint with no query at all when no filters are given", async () => {
    const seen = stub("/org/analytics/summary", SUMMARY);

    await runCli(["analytics", "summary"]);

    expect(requested(seen)).toEqual({
      method: "GET",
      path: pathOf("/org/analytics/summary"),
      // Not `from=&to=`: an empty value is a filter on the empty string, and
      // the API's default window is what an unfiltered call is asking for.
      params: {},
    });
  });

  it("sends every window filter under the name the API reads", async () => {
    const seen = stub("/org/analytics/summary", SUMMARY);

    await runCli(["analytics", "summary", ...WINDOW_FLAGS, "--tag", "launch"]);

    expect(requested(seen).params).toEqual({ ...WINDOW_PARAMS, tag: "launch" });
  });

  it("sends the API key as X-API-Key and identifies itself", async () => {
    const seen = stub("/org/analytics/summary", SUMMARY);

    await runCli(["analytics", "summary"]);

    expect(seen.req?.headers.get("x-api-key")).toBe(TEST_API_KEY);
    expect(seen.req?.headers.get("user-agent")).toMatch(/^senso-cli\//);
    expect(seen.req?.headers.get("accept")).toBe("application/json");
  });
});

describe("analytics mentions, on the wire", () => {
  it("sends the window filters and the time bucket", async () => {
    const seen = stub("/org/analytics/mentions", MENTIONS);

    await runCli([
      "analytics",
      "mentions",
      ...WINDOW_FLAGS,
      "--tag",
      "launch",
      "--group-by",
      "week",
    ]);

    expect(requested(seen)).toEqual({
      method: "GET",
      path: pathOf("/org/analytics/mentions"),
      // group_by, not groupBy: Commander's camelCase must not reach the API.
      params: { ...WINDOW_PARAMS, tag: "launch", group_by: "week" },
    });
  });

  it("omits the bucket entirely when --group-by is not passed", async () => {
    const seen = stub("/org/analytics/mentions", MENTIONS);

    await runCli(["analytics", "mentions"]);

    expect(requested(seen).params).toEqual({});
  });
});

describe("analytics citations, on the wire", () => {
  it("sends the window filters and the time bucket", async () => {
    const seen = stub("/org/analytics/citations", CITATIONS);

    await runCli([
      "analytics",
      "citations",
      ...WINDOW_FLAGS,
      "--tag",
      "launch",
      "--group-by",
      "day",
    ]);

    expect(requested(seen)).toEqual({
      method: "GET",
      path: pathOf("/org/analytics/citations"),
      params: { ...WINDOW_PARAMS, tag: "launch", group_by: "day" },
    });
  });
});

describe("analytics domains, on the wire", () => {
  it("sends the window, the cited-source filters and the paging", async () => {
    const seen = stub("/org/analytics/citations/domains", DOMAINS);

    await runCli([
      "analytics",
      "domains",
      ...WINDOW_FLAGS,
      "--tier",
      "primary",
      "--domain-contains",
      "senso",
      "--sort",
      "coverage",
      "--limit",
      "10",
      "--offset",
      "20",
    ]);

    expect(requested(seen)).toEqual({
      method: "GET",
      path: pathOf("/org/analytics/citations/domains"),
      params: {
        ...WINDOW_PARAMS,
        tier: "primary",
        domain_contains: "senso",
        sort: "coverage",
        limit: "10",
        offset: "20",
      },
    });
  });

  it("never sends a tag, because the domain rollup cannot resolve one", async () => {
    // The flag is not offered here at all — see addWindowOptions. Asserted as a
    // usage error rather than a missing parameter, because a filter that is
    // accepted and ignored returns more rows than asked for and looks fine.
    const res = await runCli(["analytics", "domains", "--tag", "launch"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
  });
});

describe("analytics pages, on the wire", () => {
  it("sends the window, both domain filters, the URL filter and the paging", async () => {
    const seen = stub("/org/analytics/citations/pages", PAGES);

    await runCli([
      "analytics",
      "pages",
      ...WINDOW_FLAGS,
      "--tier",
      "secondary",
      "--domain",
      "senso.ai",
      "--domain-contains",
      "sens",
      "--url-contains",
      "/blog/",
      "--sort",
      "citations",
      "--limit",
      "5",
      "--offset",
      "0",
    ]);

    expect(requested(seen)).toEqual({
      method: "GET",
      path: pathOf("/org/analytics/citations/pages"),
      params: {
        ...WINDOW_PARAMS,
        tier: "secondary",
        // Two different filters that read alike; swapping them would quietly
        // change an exact match into a substring one.
        domain: "senso.ai",
        domain_contains: "sens",
        url_contains: "/blog/",
        sort: "citations",
        limit: "5",
        offset: "0",
      },
    });
  });

  it("does not offer a tag filter either", async () => {
    const res = await runCli(["analytics", "pages", "--tag", "launch"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
  });
});

describe("analytics prompts, on the wire", () => {
  it("sends the window, the search, the sort, the direction and the paging", async () => {
    const seen = stub("/org/analytics/prompts", PROMPTS);

    await runCli([
      "analytics",
      "prompts",
      ...WINDOW_FLAGS,
      "--tag",
      "launch",
      "--search",
      "generative engine",
      "--sort",
      "mention_rate",
      "--order",
      "asc",
      "--limit",
      "100",
      "--offset",
      "50",
    ]);

    expect(requested(seen)).toEqual({
      method: "GET",
      path: pathOf("/org/analytics/prompts"),
      params: {
        ...WINDOW_PARAMS,
        tag: "launch",
        search: "generative engine",
        sort: "mention_rate",
        // The pairing that finds the prompts you are invisible on.
        order: "asc",
        limit: "100",
        offset: "50",
      },
    });
  });
});

describe("analytics prompt <promptId>, on the wire", () => {
  it("puts the prompt id in the path and sends its narrower filter set", async () => {
    const seen = stub("/org/analytics/prompts/:promptId", PROMPT_DETAIL);

    await runCli([
      "analytics",
      "prompt",
      "prm_a1",
      "--from",
      "2025-08-01",
      "--to",
      "2025-08-30",
      "--models",
      "gpt-4o",
      "--location",
      "US",
    ]);

    expect(requested(seen)).toEqual({
      method: "GET",
      path: pathOf("/org/analytics/prompts/prm_a1"),
      params: {
        from: "2025-08-01",
        to: "2025-08-30",
        models: "gpt-4o",
        location: "US",
      },
    });
  });

  it("asks for the answer bodies by saying nothing, since they are the default", async () => {
    const seen = stub("/org/analytics/prompts/:promptId", PROMPT_DETAIL);

    await runCli(["analytics", "prompt", "prm_a1"]);

    // include_answers is absent rather than "true": the server's default is the
    // behavior being asked for, and sending it would freeze that default here.
    expect(requested(seen).params).toEqual({});
  });

  it("sends include_answers=false when --no-include-answers is passed", async () => {
    const seen = stub("/org/analytics/prompts/:promptId", PROMPT_DETAIL);

    await runCli(["analytics", "prompt", "prm_a1", "--no-include-answers"]);

    expect(requested(seen).params).toEqual({ include_answers: "false" });
  });

  it("exits 2 when no prompt id is given", async () => {
    const res = await runCli(["analytics", "prompt"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
  });
});

describe("analytics answers, on the wire", () => {
  it("sends its own snapshot filters, the booleans and the paging", async () => {
    const seen = stub("/org/analytics/answers/latest", ANSWERS);

    await runCli([
      "analytics",
      "answers",
      "--from",
      "2025-08-01",
      "--to",
      "2025-08-30",
      "--models",
      "gpt-4o",
      "--location",
      "US/California",
      "--prompt-type",
      "decision",
      "--tag",
      "launch",
      "--mentioned",
      "true",
      "--cited",
      "false",
      "--citation-tier",
      "primary",
      "--limit",
      "5",
      "--offset",
      "10",
    ]);

    expect(requested(seen)).toEqual({
      method: "GET",
      path: pathOf("/org/analytics/answers/latest"),
      params: {
        from: "2025-08-01",
        to: "2025-08-30",
        models: "gpt-4o",
        location: "US/California",
        prompt_type: "decision",
        tag: "launch",
        mentioned: "true",
        cited: "false",
        citation_tier: "primary",
        limit: "5",
        offset: "10",
      },
    });
  });

  it("normalizes the boolean spellings a human types", async () => {
    const seen = stub("/org/analytics/answers/latest", ANSWERS);

    await runCli(["analytics", "answers", "--mentioned", "YES", "--cited", "0"]);

    // One spelling on the wire regardless of which one was typed.
    expect(requested(seen).params).toEqual({ mentioned: "yes", cited: "0" });
  });

  it("sends neither boolean when neither flag is passed", async () => {
    const seen = stub("/org/analytics/answers/latest", ANSWERS);

    await runCli(["analytics", "answers"]);

    // Omitting --mentioned means "do not filter on it", which is a different
    // request from asking for the answers that did not mention the brand.
    expect(requested(seen).params).toEqual({});
  });
});

describe("analytics glossary, on the wire", () => {
  it("GETs the glossary with no parameters, because it takes no filters", async () => {
    const seen = stub("/org/analytics/glossary", GLOSSARY);

    await runCli(["analytics", "glossary"]);

    expect(requested(seen)).toEqual({
      method: "GET",
      path: pathOf("/org/analytics/glossary"),
      params: {},
    });
  });
});

describe("analytics filters, on the wire", () => {
  it("GETs the filters endpoint with no parameters", async () => {
    const seen = stub("/org/analytics/filters", FILTERS);

    await runCli(["analytics", "filters"]);

    expect(requested(seen)).toEqual({
      method: "GET",
      path: pathOf("/org/analytics/filters"),
      params: {},
    });
  });
});

// ---------------------------------------------------------------------------
// Usage errors
// ---------------------------------------------------------------------------

describe("analytics answers, when a boolean flag is wrong", () => {
  it("exits 2 and names the accepted values when --mentioned is not a boolean", async () => {
    const res = await runCli(["analytics", "answers", "--mentioned", "maybe"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("--mentioned");
    // The list, not just "invalid": a caller cannot guess between true/false,
    // 1/0 and yes/no.
    for (const value of ["true", "false", "1", "0", "yes", "no"]) {
      expect(res.stderr).toContain(value);
    }
  });

  it("exits 2 when --cited is not a boolean, naming that flag rather than the other", async () => {
    const res = await runCli(["analytics", "answers", "--cited", "sometimes"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("--cited");
    expect(res.stderr).not.toContain("--mentioned");
  });

  it("rejects the bad value before making the request", async () => {
    // No handler is registered, so an early return here is what keeps this test
    // from failing on an unmocked request. That is the assertion.
    const res = await runCli(["analytics", "answers", "--cited", "nope"]);

    expect(res.exitCode).toBe(2);
  });

  it("reports the usage failure as JSON on stderr under --output json", async () => {
    const res = await runCli(["analytics", "answers", "--mentioned", "maybe", "--output", "json"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(JSON.parse(res.stderr)).toMatchObject({ error: { code: "usage" } });
  });
});

describe("analytics, when --output is not a format", () => {
  it("exits 2 and names the valid formats", async () => {
    const res = await runCli(["analytics", "summary", "--output", "yaml"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("json, table, plain");
  });
});

describe("analytics, when a closed-set flag is misspelled", () => {
  // Every case below deliberately registers no MSW handler. An unmocked request
  // fails the test, so passing is itself the assertion that the guard runs
  // before anything is sent — which is the point: the API ignores a filter it
  // cannot read, so a forwarded typo comes back as a wider result set that
  // looks fine, or costs a round trip to be told what the CLI already knew.

  it("exits 2 on an unrecognized --group-by, naming day and week", async () => {
    const res = await runCli(["analytics", "mentions", "--group-by", "weekly"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("--group-by");
    expect(res.stderr).toContain("weekly");
    expect(res.stderr).toContain("day");
    expect(res.stderr).toContain("week");
  });

  it("checks --group-by on citations too, not only on mentions", async () => {
    // The two commands declare the flag separately; both are guarded.
    const res = await runCli(["analytics", "citations", "--group-by", "monthly"]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("--group-by");
  });

  it("exits 2 on an unrecognized --tier, naming the three tiers", async () => {
    const res = await runCli(["analytics", "domains", "--tier", "gold"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("--tier");
    for (const value of ["primary", "tracked", "secondary"]) {
      expect(res.stderr).toContain(value);
    }
  });

  it("checks --tier on pages too", async () => {
    const res = await runCli(["analytics", "pages", "--tier", "owned"]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("--tier");
  });

  it("exits 2 on an unrecognized --sort for the cited-source rollups", async () => {
    const res = await runCli(["analytics", "domains", "--sort", "coverages"]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("--sort");
    expect(res.stderr).toContain("citations");
    expect(res.stderr).toContain("coverage");
  });

  it("checks --sort on pages too", async () => {
    const res = await runCli(["analytics", "pages", "--sort", "cites"]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("--sort");
  });

  it("exits 2 on an unrecognized --sort for prompts, naming its own five fields", async () => {
    // A different set from the cited-source --sort, which is why each command
    // names the values its own help text lists.
    const res = await runCli(["analytics", "prompts", "--sort", "mentions"]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("--sort");
    for (const value of ["mention_rate", "share_of_voice", "citations", "answered", "text"]) {
      expect(res.stderr).toContain(value);
    }
  });

  it("exits 2 on an unrecognized --order, naming asc and desc", async () => {
    const res = await runCli(["analytics", "prompts", "--order", "ascending"]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("--order");
    expect(res.stderr).toContain("asc");
    expect(res.stderr).toContain("desc");
  });

  it("exits 2 on an unrecognized --prompt-type, naming the four funnel stages", async () => {
    const res = await runCli(["analytics", "summary", "--prompt-type", "awarenes"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("--prompt-type");
    for (const value of ["awareness", "consideration", "evaluation", "decision"]) {
      expect(res.stderr).toContain(value);
    }
  });

  it("checks --prompt-type on every windowed command, not just the one", async () => {
    // The flag is declared once in addWindowOptions and read once in
    // windowParams, so the check there covers all of them.
    for (const command of ["mentions", "citations", "domains", "pages", "prompts"]) {
      const res = await runCli(["analytics", command, "--prompt-type", "purchase"]);

      expect(res.exitCode).toBe(2);
      expect(res.stderr).toContain("--prompt-type");
    }
  });

  it("checks --prompt-type on answers, which declares its own window flags", async () => {
    const res = await runCli(["analytics", "answers", "--prompt-type", "evaluate"]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("--prompt-type");
  });

  it("exits 2 on an unrecognized --citation-tier, naming the three tiers", async () => {
    const res = await runCli(["analytics", "answers", "--citation-tier", "owned"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("--citation-tier");
    for (const value of ["primary", "tracked", "secondary"]) {
      expect(res.stderr).toContain(value);
    }
  });

  it("accepts a valid value typed in the wrong case rather than being pedantic", async () => {
    // The canonical lowercase form is what reaches the API, so casing is the
    // one difference parseEnumFlag forgives.
    const seen = stub("/org/analytics/citations/domains", DOMAINS);

    const res = await runCli(["analytics", "domains", "--tier", "PRIMARY"]);

    expect(res.exitCode).toBe(0);
    expect(requested(seen).params).toEqual({ tier: "primary" });
  });
});

// ---------------------------------------------------------------------------
// Rendering: summary, in all three formats
// ---------------------------------------------------------------------------

describe("analytics summary, on success", () => {
  it("prints the payload unmodified under --output json", async () => {
    stub("/org/analytics/summary", SUMMARY);

    const res = await runCli(["analytics", "summary", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    // Byte-for-byte the API's document: the raw counts, the nulls and the
    // notes all survive, which is what makes this the contract for an agent.
    expect(res.json()).toEqual(SUMMARY);
    expect(res.stderr).toBe("");
  });

  it("renders the metric table with its counts under --output table", async () => {
    stub("/org/analytics/summary", SUMMARY);

    const res = await runCli(["analytics", "summary", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Mention Rate");
    expect(res.stdout).toContain("26.5%");
    // The counts column, so the reader can redo the division.
    expect(res.stdout).toContain("122 / 460 answers");
    expect(res.stdout).toContain("+5.5pp (improved)");
  });

  it("carries the window and data quality above the table, which cannot hold them", async () => {
    stub("/org/analytics/summary", SUMMARY);

    const res = await runCli(["analytics", "summary", "--output", "table"]);

    expect(res.stdout).toContain("2025-08-01");
    expect(res.stdout).toContain("latest data 2025-08-29");
    expect(res.stdout).toContain("Data quality: good");
  });

  it("renders a readable block with the monitoring footprint by default", async () => {
    stub("/org/analytics/summary", SUMMARY);

    const res = await runCli(["analytics", "summary"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Analytics summary");
    expect(res.stdout).toContain("Mention Rate");
    expect(res.stdout).toContain("26.5%");
    expect(res.stdout).toContain("24 prompts");
    expect(res.stdout).toContain("460 of 480 runs answered");
  });

  it('renders a null metric as "—" and never as a zero percentage', async () => {
    // The misreading this whole command group exists to prevent: "—" means the
    // denominator was zero, so nothing was measured. 0% would mean it was
    // measured and the answer was none.
    const empty = {
      ...SUMMARY,
      totals: {
        ...TOTALS,
        answered_count: 0,
        mentioned_count: 0,
        cited_run_count: 0,
        cited_total: 0,
      },
      metrics: Object.fromEntries(
        Object.keys(METRICS).map((key) => [key, null]),
      ) as unknown as Metrics,
      deltas: null,
    };
    stub("/org/analytics/summary", empty);

    const res = await runCli(["analytics", "summary"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("—");
    expect(res.stdout).not.toMatch(/\b0(\.0)?%/);
    // And the denominator is still shown, so the placeholder explains itself.
    expect(res.stdout).toContain("0 / 0 answers");
  });
});

// ---------------------------------------------------------------------------
// Rendering: a paged command, in all three formats
// ---------------------------------------------------------------------------

describe("analytics prompts, on success", () => {
  it("prints the payload unmodified under --output json", async () => {
    stub("/org/analytics/prompts", PROMPTS);

    const res = await runCli(["analytics", "prompts", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.json()).toEqual(PROMPTS);
    expect(res.stderr).toBe("");
  });

  it("renders one row per prompt under --output table", async () => {
    stub("/org/analytics/prompts", PROMPTS);

    const res = await runCli(["analytics", "prompts", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("mention_rate");
    expect(res.stdout).toContain("prm_a1");
    expect(res.stdout).toContain("28.9%");
    // The window figure and the "right now" figure are different numbers and
    // both are shown, because reconciling with the app needs the latter.
    expect(res.stdout).toContain("10.4%");
    expect(res.stdout).toContain("18.8%");
  });

  it("says how many of the total were returned, and from what offset", async () => {
    stub("/org/analytics/prompts", { ...PROMPTS, total: 24, offset: 50 });

    const res = await runCli(["analytics", "prompts", "--output", "table"]);

    expect(res.stdout).toContain("1 of 24");
    expect(res.stdout).toContain("offset 50");
  });

  it("renders a readable block per prompt by default, with its tags and id", async () => {
    stub("/org/analytics/prompts", PROMPTS);

    const res = await runCli(["analytics", "prompts"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("what is generative engine optimization");
    expect(res.stdout).toContain("28.9% (11/38)");
    expect(res.stdout).toContain("ID: prm_a1");
    expect(res.stdout).toContain("tags: launch, geo");
  });

  it("says so plainly when nothing matched the filter", async () => {
    stub("/org/analytics/prompts", { ...PROMPTS, total: 0, prompts: [] });

    const res = await runCli(["analytics", "prompts"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("No prompts matched this filter.");
  });
});

// ---------------------------------------------------------------------------
// The rest of the group renders too
// ---------------------------------------------------------------------------

describe("the remaining subcommands render their own view", () => {
  it("mentions prints one row per bucket, with the window totals above them", async () => {
    stub("/org/analytics/mentions", MENTIONS);

    const res = await runCli(["analytics", "mentions"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("2025-08-29");
    expect(res.stdout).toContain("31.3%");
    expect(res.stdout).toContain("share of voice 12.0%");
  });

  it("citations spells out both denominators before quoting a rate or a share", async () => {
    // D and S are the whole point of this view: a rate and a share are
    // different metrics on different denominators.
    stub("/org/analytics/citations", CITATIONS);

    const res = await runCli(["analytics", "citations"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("D = 300 cited answers");
    expect(res.stdout).toContain("S = 1,200 citation instances");
    expect(res.stdout).toContain("Owned rate 15.0%");
    expect(res.stdout).toContain("Owned share 5.0%");
  });

  it("domains ranks each row and labels its tier", async () => {
    stub("/org/analytics/citations/domains", DOMAINS);

    const res = await runCli(["analytics", "domains"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("senso.ai");
    expect(res.stdout).toContain("[Owned]");
    expect(res.stdout).toContain("coverage 15.0%");
    expect(res.stdout).toContain("share 5.0%");
    expect(res.stdout).toContain("avg position #2.4");
  });

  it("pages lists the prompts driving each page's citations", async () => {
    stub("/org/analytics/citations/pages", PAGES);

    const res = await runCli(["analytics", "pages"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("https://senso.ai/blog/geo-metrics");
    expect(res.stdout).toContain("what is generative engine optimization");
    expect(res.stdout).toContain("9 cited answers");
  });

  it("prompt <promptId> prints the metric table, the series and the answer bodies", async () => {
    stub("/org/analytics/prompts/:promptId", PROMPT_DETAIL);

    const res = await runCli(["analytics", "prompt", "prm_a1"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Mention Rate");
    expect(res.stdout).toContain("Series");
    expect(res.stdout).toContain("Latest answers");
    expect(res.stdout).toContain("gpt-4o · US/California");
    expect(res.stdout).toContain("Generative engine optimization is the practice");
  });

  it("answers warns that narrowing the dates hides combinations rather than aging them", async () => {
    // The single most misread behavior in the group: this is a snapshot, so a
    // tighter window returns fewer rows, not older answers.
    stub("/org/analytics/answers/latest", ANSWERS);

    const res = await runCli(["analytics", "answers", "--from", "2025-08-28"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Snapshot of the newest answer");
    expect(res.stdout).toContain("hidden, not replaced by older answers");
  });

  it("answers renders a missing rank and sentiment as the placeholder, not as zero", async () => {
    stub("/org/analytics/answers/latest", {
      ...ANSWERS,
      answers: [{ ...ANSWER_ROW, mentioned: false, rank: null, sentiment: null }],
    });

    const res = await runCli(["analytics", "answers", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("—");
    expect(res.stdout).not.toContain("#0");
  });

  it("glossary prints each metric's definition, denominator and gotcha", async () => {
    stub("/org/analytics/glossary", GLOSSARY);

    const res = await runCli(["analytics", "glossary"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Citation Share");
    expect(res.stdout).toContain("Denominator: S — total citation instances");
    expect(res.stdout).toContain("Gotcha:");
  });

  it("glossary shows the placeholder for an entry with no denominator, in table form", async () => {
    stub("/org/analytics/glossary", GLOSSARY);

    const res = await runCli(["analytics", "glossary", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Run Count");
    expect(res.stdout).toContain("—");
  });

  it("filters lists the values that have data, next to the flag that takes them", async () => {
    stub("/org/analytics/filters", FILTERS);

    const res = await runCli(["analytics", "filters"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("--models");
    // The display name, which is what a user reads, next to the location codes,
    // which are case-sensitive and must be echoed exactly.
    expect(res.stdout).toContain("GPT-4o");
    expect(res.stdout).toContain("US/California");
    expect(res.stdout).toContain("2025-06-01 → 2025-08-29");
  });

  it("filters says outright when the org has no rollup days yet", async () => {
    stub("/org/analytics/filters", {
      ...FILTERS,
      locations: [],
      date_range: { earliest_day: null, latest_day: null },
    });

    const res = await runCli(["analytics", "filters"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("no rollup days yet");
    expect(res.stdout).toContain("—");
  });
});

// ---------------------------------------------------------------------------
// notes[] — printed for a human, never inside the payload
// ---------------------------------------------------------------------------

describe("the notes every analytics response carries", () => {
  it("prints them under a Notes heading in plain output", async () => {
    stub("/org/analytics/summary", SUMMARY);

    const res = await runCli(["analytics", "summary"]);

    expect(res.stdout).toContain("Notes");
    for (const note of NOTES) expect(res.stdout).toContain(note);
  });

  it("prints them in table output, where the table itself cannot carry them", async () => {
    stub("/org/analytics/citations", CITATIONS);

    const res = await runCli(["analytics", "citations", "--output", "table"]);

    expect(res.stdout).toContain("Notes");
    expect(res.stdout).toContain(NOTES[0]!);
  });

  it("never prints them alongside the JSON document, where they already are", async () => {
    // Prose after the payload would break every caller piping stdout into a
    // parser, and the notes are a field of the object anyway.
    stub("/org/analytics/summary", SUMMARY);

    const res = await runCli(["analytics", "summary", "--output", "json"]);

    expect(res.json<typeof SUMMARY>().notes).toEqual(NOTES);
    expect(res.stdout.trimEnd().endsWith("}")).toBe(true);
    expect(res.stdout).not.toContain("Notes");
    expect(res.stderr).toBe("");
  });

  it("prints no empty heading when a response carries none", async () => {
    stub("/org/analytics/summary", { ...SUMMARY, notes: [] });

    const res = await runCli(["analytics", "summary"]);

    expect(res.stdout).not.toContain("Notes");
  });
});
