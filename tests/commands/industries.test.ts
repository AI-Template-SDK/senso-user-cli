/**
 * Command layer: `senso industries`.
 *
 * This group is the odd one out, and both of its peculiarities are the reason
 * the file is worth its length.
 *
 * The first is authentication. Every command here reads a `/partner/*` route,
 * which rejects the organization key that `senso login` stores. The generic
 * handler would answer a 401 with "run `senso login`", which is the one thing
 * that can never fix it, so the group translates 401 and 403 into an
 * explanation naming partner authentication and pointing at `senso analytics`
 * for org-level metrics. That translation is the most user-visible behavior in
 * the file, and it must not leak to other statuses — a 404 is still a 404.
 *
 * The second is the `<industry>` argument, which accepts a UUID or a name. A
 * UUID is used as-is; a name costs an extra search request first, and the id it
 * resolves to has to appear in the path of the request that follows. Both
 * halves are asserted below, including the case where a UUID must NOT trigger a
 * search — the test registers a spy on the search route and asserts it was
 * never called, because a silent extra round trip per command is exactly the
 * kind of regression nobody notices.
 *
 * Failure branches come first, as in tests/commands/roles.test.ts.
 */

import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../setup.js";
import { apiUrl, runCli } from "../helpers.js";

/** A real UUID shape, so `resolveIndustryId` takes the no-search branch. */
const INDUSTRY_UUID = "3f7c1a2b-4d5e-4f60-9a1b-2c3d4e5f6071";

const INDUSTRIES = {
  industries: [
    { industry_id: INDUSTRY_UUID, name: "Automotive", slug: "automotive", active_prompt_count: 42 },
    {
      industry_id: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
      name: "Insurance",
      slug: "insurance",
      active_prompt_count: 17,
    },
  ],
};

const SUMMARY = { industry_id: INDUSTRY_UUID, brand_count: 12, share_of_voice: 0.31 };

describe("industries, when partner authentication rejects the key", () => {
  it("exits 3 on a 401 and blames partner auth rather than telling the user to log in again", async () => {
    server.use(
      http.get(apiUrl("/partner/industries"), () =>
        HttpResponse.json({ error: "partner auth required" }, { status: 401 }),
      ),
    );

    const res = await runCli(["industries", "list"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("partner authentication");
    // The hint is the whole point: it names what will not help, and what will.
    expect(res.stderr).toContain("/partner/*");
    expect(res.stderr).toContain("senso analytics");
    expect(res.stderr).not.toContain("Authentication failed");
  });

  it("exits 3 on a 403 with the same explanation", async () => {
    server.use(
      http.get(apiUrl("/partner/glossary"), () =>
        HttpResponse.json({ error: "forbidden" }, { status: 403 }),
      ),
    );

    const res = await runCli(["industries", "glossary"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("partner authentication");
    expect(res.stderr).not.toContain("Permission denied");
  });

  it("reports the partner failure as JSON on stderr, keeping the status and the hint", async () => {
    server.use(
      http.get(apiUrl("/partner/industries"), () =>
        HttpResponse.json({ error: "partner auth required" }, { status: 403 }),
      ),
    );

    const res = await runCli(["industries", "list", "--output", "json"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");

    const reported = JSON.parse(res.stderr) as {
      error: { code: string; status: number; message: string; hint: string };
    };
    // 403 keeps the "forbidden" code even though the message is rewritten, so a
    // script switching on the code sees the same value it would elsewhere.
    expect(reported.error.code).toBe("forbidden");
    expect(reported.error.status).toBe(403);
    expect(reported.error.message).toContain("partner authentication");
    expect(reported.error.hint).toContain("--api-key");
  });

  it("uses the unauthorized code for a 401 and the forbidden code for a 403", async () => {
    server.use(
      http.get(apiUrl("/partner/glossary"), () =>
        HttpResponse.json({ error: "nope" }, { status: 401 }),
      ),
    );

    const res = await runCli(["industries", "glossary", "--output", "json"]);

    expect(res.exitCode).toBe(3);
    const reported = JSON.parse(res.stderr) as { error: { code: string; status: number } };
    expect(reported.error.code).toBe("unauthorized");
    expect(reported.error.status).toBe(401);
  });

  it("translates the partner failure even when it happens during name resolution", async () => {
    // The 401 comes from the industries search, one request before the command's
    // own — the translation has to cover the whole action, not just the last call.
    server.use(
      http.get(apiUrl("/partner/industries"), () =>
        HttpResponse.json({ error: "partner auth required" }, { status: 401 }),
      ),
    );

    const res = await runCli(["industries", "summary", "Automotive"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("partner authentication");
  });
});

describe("industries, when the request fails for some other reason", () => {
  it("exits 3 and explains how to authenticate when there is no API key at all", async () => {
    const res = await runCli(["industries", "list"], { withKey: false });

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("no API key found");
  });

  it("leaves a 404 alone: it is not an auth problem and must not be described as one", async () => {
    server.use(
      http.get(
        apiUrl("/partner/industries/:id/summary"),
        () => new HttpResponse(null, { status: 404 }),
      ),
    );

    const res = await runCli(["industries", "summary", INDUSTRY_UUID]);

    expect(res.exitCode).toBe(4);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Not found");
    expect(res.stderr).not.toContain("partner authentication");
  });

  it("leaves a 500 alone", async () => {
    server.use(
      http.get(apiUrl("/partner/glossary"), () => new HttpResponse(null, { status: 500 })),
    );

    const res = await runCli(["industries", "glossary"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("not your fault");
    expect(res.stderr).not.toContain("partner authentication");
  });

  it("exits 5 on a 429, so a caller in a loop knows to back off", async () => {
    server.use(
      http.get(apiUrl("/partner/glossary"), () => new HttpResponse(null, { status: 429 })),
    );

    const res = await runCli(["industries", "glossary"]);

    expect(res.exitCode).toBe(5);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Rate limited");
  });

  it("names the valid formats when --output is not one of them", async () => {
    const res = await runCli(["industries", "list", "--output", "yaml"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("json, table, plain");
  });
});

describe("industries, resolving the <industry> argument", () => {
  it("uses a UUID directly, without a search request", async () => {
    let searched = false;
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/partner/industries"), () => {
        searched = true;
        return HttpResponse.json(INDUSTRIES);
      }),
      http.get(apiUrl("/partner/industries/:id/summary"), ({ request }) => {
        seen = request;
        return HttpResponse.json(SUMMARY);
      }),
    );

    const res = await runCli(["industries", "summary", INDUSTRY_UUID]);

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
        return HttpResponse.json(SUMMARY);
      }),
    );

    const res = await runCli(["industries", "summary", ` ${INDUSTRY_UUID.toUpperCase()} `]);

    expect(res.exitCode).toBe(0);
    expect(new URL(seen!.url).pathname).toBe(
      `/api/v1/partner/industries/${INDUSTRY_UUID.toUpperCase()}/summary`,
    );
  });

  it("searches first for a name, then uses the first match's industry_id", async () => {
    let search: Request | undefined;
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/partner/industries"), ({ request }) => {
        search = request;
        return HttpResponse.json(INDUSTRIES);
      }),
      http.get(apiUrl("/partner/industries/:id/summary"), ({ request }) => {
        seen = request;
        return HttpResponse.json(SUMMARY);
      }),
    );

    const res = await runCli(["industries", "summary", "Automotive"]);

    expect(res.exitCode).toBe(0);
    expect(search?.method).toBe("GET");
    expect(new URL(search!.url).pathname).toBe("/api/v1/partner/industries");
    expect(new URL(search!.url).searchParams.get("search")).toBe("Automotive");
    // The id came out of the search response, not out of the argument.
    expect(new URL(seen!.url).pathname).toBe(`/api/v1/partner/industries/${INDUSTRY_UUID}/summary`);
  });

  it("exits 4 and quotes the name back when the search matches nothing", async () => {
    server.use(
      http.get(apiUrl("/partner/industries"), () => HttpResponse.json({ industries: [] })),
    );

    const res = await runCli(["industries", "summary", "Underwater Basket Weaving"]);

    expect(res.exitCode).toBe(4);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain('No industry found matching "Underwater Basket Weaving"');
    expect(res.stderr).toContain("industries list");
  });

  it("exits 4 when the first match carries no industry_id", async () => {
    server.use(
      http.get(apiUrl("/partner/industries"), () =>
        HttpResponse.json({ industries: [{ name: "Automotive" }] }),
      ),
    );

    const res = await runCli(["industries", "summary", "Automotive"]);

    expect(res.exitCode).toBe(4);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("No industry found matching");
  });
});

describe("industries list, on the wire", () => {
  it("GETs /partner/industries with no query when --search is absent", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/partner/industries"), ({ request }) => {
        seen = request;
        return HttpResponse.json(INDUSTRIES);
      }),
    );

    await runCli(["industries", "list"]);

    expect(seen?.method).toBe("GET");
    expect(new URL(seen!.url).pathname).toBe("/api/v1/partner/industries");
    expect(new URL(seen!.url).search).toBe("");
  });

  it("passes --search through as the search parameter", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/partner/industries"), ({ request }) => {
        seen = request;
        return HttpResponse.json(INDUSTRIES);
      }),
    );

    await runCli(["industries", "list", "--search", "auto"]);

    expect(new URL(seen!.url).searchParams.get("search")).toBe("auto");
  });
});

describe("industries summary, on the wire", () => {
  it("sends from, to, location and models as query parameters", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/partner/industries/:id/summary"), ({ request }) => {
        seen = request;
        return HttpResponse.json(SUMMARY);
      }),
    );

    await runCli([
      "industries",
      "summary",
      INDUSTRY_UUID,
      "--from",
      "2026-01-01",
      "--to",
      "2026-03-31",
      "--location",
      "US",
      "--models",
      "chatgpt,gemini",
    ]);

    const params = new URL(seen!.url).searchParams;
    expect(params.get("from")).toBe("2026-01-01");
    expect(params.get("to")).toBe("2026-03-31");
    expect(params.get("location")).toBe("US");
    expect(params.get("models")).toBe("chatgpt,gemini");
  });

  it("omits the filters entirely when they are not given", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/partner/industries/:id/summary"), ({ request }) => {
        seen = request;
        return HttpResponse.json(SUMMARY);
      }),
    );

    await runCli(["industries", "summary", INDUSTRY_UUID]);

    // Not `from=`, not `from=undefined`: absent.
    expect(new URL(seen!.url).search).toBe("");
  });
});

describe("industries brand, on the wire", () => {
  it("puts the brand name in the path, percent-encoded", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/partner/industries/:id/brands/:brand"), ({ request }) => {
        seen = request;
        return HttpResponse.json({ brand: "Acme & Co", mentioned: false });
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
      `/api/v1/partner/industries/${INDUSTRY_UUID}/brands/${encodeURIComponent("Acme & Co")}`,
    );
    expect(new URL(seen!.url).searchParams.get("location")).toBe("US");
  });

  it("resolves a named industry before fetching the brand", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/partner/industries"), () => HttpResponse.json(INDUSTRIES)),
      http.get(apiUrl("/partner/industries/:id/brands/:brand"), ({ request }) => {
        seen = request;
        return HttpResponse.json({ brand: "Acme", mentioned: true });
      }),
    );

    const res = await runCli(["industries", "brand", "Automotive", "Acme"]);

    expect(res.exitCode).toBe(0);
    expect(new URL(seen!.url).pathname).toBe(
      `/api/v1/partner/industries/${INDUSTRY_UUID}/brands/Acme`,
    );
  });
});

describe("industries domain, on the wire", () => {
  it("puts the domain in the path, percent-encoded", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/partner/industries/:id/domains/:domain"), ({ request }) => {
        seen = request;
        return HttpResponse.json({ domain: "example.com", cited: false });
      }),
    );

    const res = await runCli([
      "industries",
      "domain",
      INDUSTRY_UUID,
      "example.com",
      "--from",
      "2026-01-01",
    ]);

    expect(res.exitCode).toBe(0);
    expect(new URL(seen!.url).pathname).toBe(
      `/api/v1/partner/industries/${INDUSTRY_UUID}/domains/example.com`,
    );
    expect(new URL(seen!.url).searchParams.get("from")).toBe("2026-01-01");
  });
});

describe("industries prompt-metrics, on the wire", () => {
  it("sends the shared filters plus limit and offset", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/partner/industries/:id/prompt-metrics"), ({ request }) => {
        seen = request;
        return HttpResponse.json({ prompts: [] });
      }),
    );

    await runCli([
      "industries",
      "prompt-metrics",
      INDUSTRY_UUID,
      "--from",
      "2026-01-01",
      "--models",
      "chatgpt",
      "--limit",
      "50",
      "--offset",
      "100",
    ]);

    const params = new URL(seen!.url).searchParams;
    expect(new URL(seen!.url).pathname).toBe(
      `/api/v1/partner/industries/${INDUSTRY_UUID}/prompt-metrics`,
    );
    expect(params.get("from")).toBe("2026-01-01");
    expect(params.get("models")).toBe("chatgpt");
    expect(params.get("limit")).toBe("50");
    expect(params.get("offset")).toBe("100");
  });
});

describe("industries glossary, on the wire", () => {
  it("GETs /partner/glossary, which takes no industry and no filters", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/partner/glossary"), ({ request }) => {
        seen = request;
        return HttpResponse.json({ metrics: [] });
      }),
    );

    await runCli(["industries", "glossary"]);

    expect(seen?.method).toBe("GET");
    expect(new URL(seen!.url).pathname).toBe("/api/v1/partner/glossary");
    expect(new URL(seen!.url).search).toBe("");
  });
});

describe("industries list, on success", () => {
  it("prints the payload unmodified under --output json", async () => {
    server.use(http.get(apiUrl("/partner/industries"), () => HttpResponse.json(INDUSTRIES)));

    const res = await runCli(["industries", "list", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.json()).toEqual(INDUSTRIES);
    expect(res.stderr).toBe("");
  });

  it("renders one row per industry under --output table", async () => {
    server.use(http.get(apiUrl("/partner/industries"), () => HttpResponse.json(INDUSTRIES)));

    const res = await runCli(["industries", "list", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("industry_id");
    expect(res.stdout).toContain("Automotive");
    expect(res.stdout).toContain("insurance");
  });

  it("renders a readable block per industry by default", async () => {
    server.use(http.get(apiUrl("/partner/industries"), () => HttpResponse.json(INDUSTRIES)));

    const res = await runCli(["industries", "list"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Automotive");
    expect(res.stdout).toContain("Insurance");
  });

  it("says so plainly when the partner can see no industries", async () => {
    server.use(
      http.get(apiUrl("/partner/industries"), () => HttpResponse.json({ industries: [] })),
    );

    const res = await runCli(["industries", "list"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("industries");
  });
});

describe("industries summary, on success", () => {
  it("prints the single object unmodified under --output json", async () => {
    server.use(
      http.get(apiUrl("/partner/industries/:id/summary"), () => HttpResponse.json(SUMMARY)),
    );

    const res = await runCli(["industries", "summary", INDUSTRY_UUID, "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.json()).toEqual(SUMMARY);
    expect(res.stderr).toBe("");
  });

  it("renders a single object as field/value rows under --output table", async () => {
    server.use(
      http.get(apiUrl("/partner/industries/:id/summary"), () => HttpResponse.json(SUMMARY)),
    );

    const res = await runCli(["industries", "summary", INDUSTRY_UUID, "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("field");
    expect(res.stdout).toContain("brand_count");
  });

  it("renders key/value lines by default", async () => {
    server.use(
      http.get(apiUrl("/partner/industries/:id/summary"), () => HttpResponse.json(SUMMARY)),
    );

    const res = await runCli(["industries", "summary", INDUSTRY_UUID]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("share_of_voice");
    expect(res.stdout).toContain("0.31");
  });
});
