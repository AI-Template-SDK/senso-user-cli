/**
 * Command layer: `senso industries` — the org-key view of the industry catalog.
 *
 * Three things here are worth protecting.
 *
 * The first is that this group is NOT `senso partner industries`. It reads
 * `/org/industries/*` with the key `senso login` stores; the partner group reads
 * `/partner/*` and needs a partner key. The two are one word apart on the command
 * line, so every test below asserts the `/org/` path explicitly — a regression that
 * sent these at `/partner/` would authenticate fine for a partner and 401 for
 * everyone else.
 *
 * The second is flag validation. `--limit`, `--sort`, `--entity-type`, `--rollup`
 * and `--prompt-ids` all have closed value sets, and every one of them must fail
 * before a request is made. `--entity-type` matters most: it filters server-side
 * before paging, so a typo would come back as a perfectly plausible empty
 * leaderboard rather than an error.
 *
 * The third is `--no-canonicalize`. The server default is true, so the flag has to
 * send `canonicalize=false` when passed and send NOTHING when omitted; a command
 * that always sent the parameter would silently defeat the default.
 *
 * Failure branches come first, as in tests/commands/roles.test.ts.
 */

import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../setup.js";
import { apiUrl, runCli } from "../helpers.js";

/** A real UUID shape, so `resolveIndustryId` takes the no-search branch. */
const INDUSTRY_UUID = "3f7c1a2b-4d5e-4f60-9a1b-2c3d4e5f6071";
const PROMPT_A = "a4226991-3d00-49ec-b5cc-95642c946cc0";
const PROMPT_B = "ac8d66db-888d-4ae8-b806-cb02d19e8cc6";

const CATALOGUE = {
  industries: [
    {
      industry_id: INDUSTRY_UUID,
      name: "Airlines (Canada)",
      slug: "airlines-canada",
      active_prompt_count: 1000,
      model_count: 3,
      location_count: 1,
    },
  ],
  total: 1,
  limit: 50,
  offset: 0,
};

describe("industries list, when a flag is not a valid value", () => {
  it("exits 2 when --limit is above the maximum", async () => {
    const res = await runCli(["industries", "list", "--limit", "101"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("--limit");
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

  it("exits 2 and names the valid values when --sort is not one of them", async () => {
    const res = await runCli(["industries", "list", "--sort", "whenever"]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("name_asc");
  });
});

describe("industries list, when the API refuses", () => {
  it("exits 3 on a 401", async () => {
    server.use(
      http.get(apiUrl("/org/industries"), () =>
        HttpResponse.json({ message: "Unauthorized" }, { status: 401 }),
      ),
    );

    const res = await runCli(["industries", "list"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
  });

  it("exits 3 on a 403 from an organization without the GEO product", async () => {
    server.use(
      http.get(apiUrl("/org/industries/:id/prompts"), () =>
        HttpResponse.json(
          { message: "Your organization doesn't have access to this product" },
          { status: 403 },
        ),
      ),
    );

    const res = await runCli(["industries", "prompts", INDUSTRY_UUID]);

    expect(res.exitCode).toBe(3);
  });
});

describe("industries, resolving the <industry> argument", () => {
  it("exits 4 when no industry matches the name", async () => {
    server.use(
      http.get(apiUrl("/org/industries"), () =>
        HttpResponse.json({ industries: [], total: 0, limit: 50, offset: 0 }),
      ),
    );

    const res = await runCli(["industries", "prompts", "Nonexistent Sector"]);

    expect(res.exitCode).toBe(4);
    expect(res.stderr).toContain("No industry found");
  });

  it("searches the ORG catalog, not the partner one, to resolve a name", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/industries"), ({ request }) => {
        seen = request;
        return HttpResponse.json(CATALOGUE);
      }),
      http.get(apiUrl("/org/industries/:id/prompts"), () =>
        HttpResponse.json({ prompts: [], total: 0, limit: 50, offset: 0 }),
      ),
    );

    const res = await runCli(["industries", "prompts", "Airlines (Canada)"]);

    expect(res.exitCode).toBe(0);
    expect(new URL(seen!.url).pathname).toBe("/api/v1/org/industries");
    expect(new URL(seen!.url).searchParams.get("search")).toBe("Airlines (Canada)");
  });

  it("does NOT search when the argument is already a UUID", async () => {
    let searched = false;
    server.use(
      http.get(apiUrl("/org/industries"), () => {
        searched = true;
        return HttpResponse.json(CATALOGUE);
      }),
      http.get(apiUrl("/org/industries/:id/prompts"), () =>
        HttpResponse.json({ prompts: [], total: 0, limit: 50, offset: 0 }),
      ),
    );

    const res = await runCli(["industries", "prompts", INDUSTRY_UUID]);

    expect(res.exitCode).toBe(0);
    expect(searched).toBe(false);
  });
});

describe("industries list, on the wire", () => {
  it("sends search, limit, offset, sort and live as query parameters", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/industries"), ({ request }) => {
        seen = request;
        return HttpResponse.json(CATALOGUE);
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
        return HttpResponse.json(CATALOGUE);
      }),
    );

    await runCli(["industries", "list"]);

    expect(new URL(seen!.url).searchParams.has("live")).toBe(false);
  });
});

describe("industries brands, on the wire", () => {
  const LEADERBOARD = {
    window: { from: "2026-08-15", to: "2026-09-14" },
    totals: { run_count: 1, answered_count: 1, brand_mention_total: 1 },
    total: 1,
    limit: 100,
    offset: 0,
    brands: [{ brand_id: "b1", brand_name: "Air Canada", mentions_count: 10, mentions_rank: 1 }],
  };

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
      "2026-09-01",
      "--to",
      "2026-09-14",
      "--models",
      "gpt-5",
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
    expect(url.searchParams.get("from")).toBe("2026-09-01");
    expect(url.searchParams.get("to")).toBe("2026-09-14");
    expect(url.searchParams.get("models")).toBe("gpt-5");
    expect(url.searchParams.get("location")).toBe("CA");
    expect(url.searchParams.get("limit")).toBe("5");
    expect(url.searchParams.get("offset")).toBe("2");
    expect(url.searchParams.get("rollup")).toBe("parent");
    expect(url.searchParams.get("entity_type")).toBe("brand,publisher");
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

  it("exits 2 when --entity-type is not a known type", async () => {
    const res = await runCli(["industries", "brands", INDUSTRY_UUID, "--entity-type", "brnad"]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("brnad");
  });

  it("exits 2 when one entry in --entity-type is unknown", async () => {
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
    const res = await runCli(["industries", "brands", INDUSTRY_UUID, "--rollup", "parents"]);

    expect(res.exitCode).toBe(2);
  });
});

describe("industries brand and brand-by-id, on the wire", () => {
  it("percent-encodes the brand name in the path", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/industries/:id/brands/:brand"), ({ request }) => {
        seen = request;
        return HttpResponse.json({ mentioned: false });
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
    expect(new URL(seen!.url).pathname).toBe(
      `/api/v1/org/industries/${INDUSTRY_UUID}/brands/${encodeURIComponent("Acme & Co")}`,
    );
    expect(new URL(seen!.url).searchParams.get("location")).toBe("US");
  });

  it("exits 0 and reports mentioned=false for a brand that was never named", async () => {
    server.use(
      http.get(apiUrl("/org/industries/:id/brands/:brand"), () =>
        HttpResponse.json({ mentioned: false, resolved: { brand_name: "Nobody" } }),
      ),
    );

    const res = await runCli(["industries", "brand", INDUSTRY_UUID, "Nobody", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(JSON.parse(res.stdout).mentioned).toBe(false);
  });

  it("uses the brands-by-id path for brand-by-id", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/industries/:id/brands-by-id/:brandId"), ({ request }) => {
        seen = request;
        return HttpResponse.json({ mentioned: true });
      }),
    );

    const res = await runCli(["industries", "brand-by-id", INDUSTRY_UUID, "b-123"]);

    expect(res.exitCode).toBe(0);
    expect(new URL(seen!.url).pathname).toBe(
      `/api/v1/org/industries/${INDUSTRY_UUID}/brands-by-id/b-123`,
    );
  });
});

describe("industries domain, on the wire", () => {
  it("keeps the domain in the path and sends --url as a query parameter", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/industries/:id/domains/:domain"), ({ request }) => {
        seen = request;
        return HttpResponse.json({ cited: true });
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

  it("exits 0 and reports cited=false for a domain that was never cited", async () => {
    server.use(
      http.get(apiUrl("/org/industries/:id/domains/:domain"), () =>
        HttpResponse.json({ cited: false }),
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
    expect(JSON.parse(res.stdout).cited).toBe(false);
  });
});

describe("industries import-prompts, validating --prompt-ids", () => {
  it("exits 2 without sending a request when an id is not a UUID", async () => {
    const res = await runCli([
      "industries",
      "import-prompts",
      INDUSTRY_UUID,
      "--prompt-ids",
      `${PROMPT_A},nope`,
    ]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("not a UUID");
  });

  it("exits 2 when an id appears more than once", async () => {
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

  it("exits 2 when more than 100 ids are given", async () => {
    const ids = Array.from(
      { length: 101 },
      (_, i) => `3f7c1a2b-4d5e-4f60-9a1b-${String(i).padStart(12, "0")}`,
    ).join(",");

    const res = await runCli(["industries", "import-prompts", INDUSTRY_UUID, "--prompt-ids", ids]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("maximum is 100");
  });

  it("exits 2 when --prompt-ids is empty", async () => {
    const res = await runCli(["industries", "import-prompts", INDUSTRY_UUID, "--prompt-ids", ""]);

    expect(res.exitCode).toBe(2);
  });

  it("exits 3 when the industry is not the organization's own", async () => {
    server.use(
      http.post(apiUrl("/org/industries/:id/prompts/import"), () =>
        HttpResponse.json(
          { message: "Industry does not match the organization's industry" },
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
    ]);

    expect(res.exitCode).toBe(3);
  });
});

describe("industries import-prompts, on success", () => {
  const IMPORTED = {
    outcomes: [{ industry_prompt_id: PROMPT_A, status: "created" }],
    created: 1,
    skipped: 0,
    defaults_seeded: { models: [], schedule_dows: [], locations: [] },
    history_import: { status: "queued", import_id: "imp-1", days: 7 },
  };

  it("posts prompt_ids as an array", async () => {
    let body: unknown;
    server.use(
      http.post(apiUrl("/org/industries/:id/prompts/import"), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(IMPORTED);
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

  it("returns the payload on stdout and the confirmation on stderr", async () => {
    server.use(
      http.post(apiUrl("/org/industries/:id/prompts/import"), () => HttpResponse.json(IMPORTED)),
    );

    const res = await runCli([
      "industries",
      "import-prompts",
      INDUSTRY_UUID,
      "--prompt-ids",
      PROMPT_A,
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain("imported");
    expect(res.stdout).toContain("created");
  });

  it("keeps stdout pure JSON under --output json", async () => {
    server.use(
      http.post(apiUrl("/org/industries/:id/prompts/import"), () => HttpResponse.json(IMPORTED)),
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
    expect(JSON.parse(res.stdout).history_import.import_id).toBe("imp-1");
  });
});

describe("industries list, rendering", () => {
  it("renders a table under --output table", async () => {
    server.use(http.get(apiUrl("/org/industries"), () => HttpResponse.json(CATALOGUE)));

    const res = await runCli(["industries", "list", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("industry_id");
    expect(res.stdout).toContain("Airlines (Canada)");
  });

  it("names the valid formats when --output is not one of them", async () => {
    const res = await runCli(["industries", "list", "--output", "yaml"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("json, table, plain");
  });
});
