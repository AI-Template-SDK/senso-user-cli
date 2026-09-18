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

describe("industries answers, when a filter is not a usable value", () => {
  /**
   * Every one of these filters is applied server-side before paging, so a typo
   * that reached the API would come back as a plausible empty answer list
   * rather than an error — the same trap `--entity-type` sets above. All of
   * them must fail before any request, including the industry lookup, which is
   * itself a round trip when the argument is a name rather than a UUID.
   */
  const CASES: [string, string[]][] = [
    ["--mentioned is not a boolean", ["--mentioned", "yes"]],
    ["--models names a model that does not exist", ["--models", "gpt-9"]],
    ["--models is empty", ["--models", ""]],
    ["--prompt-ids holds something that is not a UUID", ["--prompt-ids", "not-a-uuid"]],
    ["--since is not a date", ["--since", "last tuesday"]],
    ["--since is an instant rather than a day", ["--since", "2026-09-18T00:00:00Z"]],
    ["--limit is above the 100 ceiling", ["--limit", "101"]],
    ["--limit is zero", ["--limit", "0"]],
    ["--offset is negative", ["--offset", "-1"]],
  ];

  for (const [label, flags] of CASES) {
    it(`exits 2 when ${label}, without making any request`, async () => {
      let called = false;
      server.use(
        http.get(apiUrl("/org/industries"), () => {
          called = true;
          return HttpResponse.json({ industries: [] });
        }),
        http.get(apiUrl("/org/industries/:id/answers/latest"), () => {
          called = true;
          return HttpResponse.json({});
        }),
      );

      const res = await runCli(["industries", "answers", "Airlines", ...flags]);

      expect(res.exitCode).toBe(2);
      expect(res.stdout).toBe("");
      expect(called).toBe(false);
    });
  }

  it("names the models it will accept, so the typo is correctable", async () => {
    const res = await runCli(["industries", "answers", INDUSTRY_UUID, "--models", "gpt-9"]);

    expect(res.stderr).toContain("perplexity");
  });
});

describe("industries answers, on success", () => {
  const ANSWERS = {
    total: 2,
    limit: 25,
    offset: 0,
    answers: [
      {
        prompt_id: "11111111-1111-1111-1111-111111111111",
        prompt_text: "best airline for families",
        model: "chatgpt",
        location: "CA",
        mentioned: true,
        rank: 2,
        sentiment: "positive",
        sov_pct: 33.3,
        run_at: "2026-09-18T10:00:00Z",
        response_text: "A long answer.",
      },
      {
        prompt_id: "22222222-2222-2222-2222-222222222222",
        prompt_text: "cheapest transatlantic carrier",
        model: "perplexity",
        location: "CA",
        mentioned: false,
        rank: 0,
        sentiment: "neutral",
        sov_pct: 0,
        run_at: "2026-09-18T10:00:00Z",
        response_text: "Another answer.",
      },
    ],
    notes: ["Answers are the newest per prompt, model and location."],
    definitions: { sov_pct: "Share of brand mentions in this answer." },
  };

  function answersRespond(): { seen: () => URL | undefined } {
    let url: URL | undefined;
    server.use(
      http.get(apiUrl(`/org/industries/${INDUSTRY_UUID}/answers/latest`), ({ request }) => {
        url = new URL(request.url);
        return HttpResponse.json(ANSWERS);
      }),
    );
    return { seen: () => url };
  }

  it("reads the org-scoped path, not the partner one", async () => {
    const { seen } = answersRespond();

    await runCli(["industries", "answers", INDUSTRY_UUID]);

    expect(seen()?.pathname).toContain(`/org/industries/${INDUSTRY_UUID}/answers/latest`);
  });

  it("sends no filters at all when none were given", async () => {
    // Every one of these has a server-side default, and sending one would pin a
    // default the API is free to change.
    const { seen } = answersRespond();

    await runCli(["industries", "answers", INDUSTRY_UUID]);

    const q = seen()?.searchParams;
    for (const key of ["mentioned", "models", "location", "prompt_ids", "since", "limit", "offset"])
      expect(q?.has(key)).toBe(false);
  });

  it("sends include_empty only when the flag is passed", async () => {
    // An explicit `false` would read as a deliberate choice rather than the
    // server's own default.
    const { seen } = answersRespond();

    await runCli(["industries", "answers", INDUSTRY_UUID]);
    expect(seen()?.searchParams.has("include_empty")).toBe(false);

    await runCli(["industries", "answers", INDUSTRY_UUID, "--include-empty"]);
    expect(seen()?.searchParams.get("include_empty")).toBe("true");
  });

  it("passes mentioned=false through, which is a filter and not an omission", async () => {
    // "Which prompts does the model answer without naming me" is the whole
    // point of the command, and it is spelled `--mentioned false`.
    const { seen } = answersRespond();

    await runCli(["industries", "answers", INDUSTRY_UUID, "--mentioned", "false"]);

    expect(seen()?.searchParams.get("mentioned")).toBe("false");
  });

  it("normalizes and forwards the remaining filters", async () => {
    const { seen } = answersRespond();

    await runCli([
      "industries",
      "answers",
      INDUSTRY_UUID,
      "--models",
      "ChatGPT, Perplexity",
      "--location",
      "US/California",
      "--prompt-ids",
      "11111111-1111-1111-1111-111111111111",
      "--since",
      "2026-09-01",
      "--limit",
      "10",
      "--offset",
      "5",
    ]);

    const q = seen()?.searchParams;
    expect(q?.get("models")).toBe("chatgpt,perplexity");
    expect(q?.get("location")).toBe("US/California");
    expect(q?.get("prompt_ids")).toBe("11111111-1111-1111-1111-111111111111");
    expect(q?.get("since")).toBe("2026-09-01");
    expect(q?.get("limit")).toBe("10");
    expect(q?.get("offset")).toBe("5");
  });

  it("gives a JSON caller the whole envelope, notes and definitions included", async () => {
    answersRespond();

    const res = await runCli(["industries", "answers", INDUSTRY_UUID, "--output", "json"]);

    expect(res.json()).toEqual(ANSWERS);
  });

  it("renders the answers as rows rather than one cell", async () => {
    // `notes` and `definitions` are not envelope keys, so the generic list
    // detection does not find `answers` on its own.
    answersRespond();

    const res = await runCli(["industries", "answers", INDUSTRY_UUID, "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("prompt_text");
    expect(res.stdout).toContain("best airline for families");
    expect(res.stdout).toContain("perplexity");
  });

  it("does not fall over when the body carries no answers", async () => {
    server.use(
      http.get(apiUrl(`/org/industries/${INDUSTRY_UUID}/answers/latest`), () =>
        HttpResponse.json({ total: 0, limit: 25, offset: 0 }),
      ),
    );

    const res = await runCli(["industries", "answers", INDUSTRY_UUID, "--output", "table"]);

    expect(res.exitCode).toBe(0);
  });

  /**
   * The generic 404 hint sends the caller to `senso industries list` to check
   * the id — which is the one thing that will not help, because the industry IS
   * in the public catalog and the listing shows it. It is simply not theirs.
   */
  it("exits 4 when the industry is not the organization's own", async () => {
    server.use(
      http.get(apiUrl(`/org/industries/${INDUSTRY_UUID}/answers/latest`), () =>
        HttpResponse.json({ error: "not found" }, { status: 404 }),
      ),
    );

    const res = await runCli(["industries", "answers", INDUSTRY_UUID]);

    expect(res.exitCode).toBe(4);
    expect(res.stdout).toBe("");
  });

  it("explains that a 404 here means the industry is not yours", async () => {
    server.use(
      http.get(apiUrl(`/org/industries/${INDUSTRY_UUID}/answers/latest`), () =>
        HttpResponse.json({ error: "not found" }, { status: 404 }),
      ),
    );

    const res = await runCli(["industries", "answers", INDUSTRY_UUID]);

    expect(res.stderr).toContain("only your own organization's industry");
    expect(res.stderr).toContain("senso org get");
    // The misleading advice must not survive.
    expect(res.stderr).not.toContain("A list command in the same group");
  });

  it("leaves other failures to the generic handler", async () => {
    server.use(
      http.get(apiUrl(`/org/industries/${INDUSTRY_UUID}/answers/latest`), () =>
        HttpResponse.json({ error: "boom" }, { status: 500 }),
      ),
    );

    const res = await runCli(["industries", "answers", INDUSTRY_UUID]);

    expect(res.exitCode).toBe(1);
    expect(res.stderr).not.toContain("only your own organization's industry");
  });
});
