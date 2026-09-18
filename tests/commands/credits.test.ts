/**
 * Command layer: `senso credits`.
 *
 * One read-only subcommand, which makes this the place to pin down the parts of
 * the contract that have nothing to do with credits: that a balance lookup asks
 * for exactly `/org/credits/balance` with no query string and no body, that a
 * rejected key is distinguishable from a missing one by exit code alone, and
 * that a single object — not a list — still renders in all three formats.
 *
 * `credits balance` is the command a billing script polls in a loop, so the two
 * things it must never do are print an error object onto stdout and exit 0 on a
 * failure. Both are asserted below.
 */

import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server, TEST_API_KEY } from "../setup.js";
import { apiUrl, runCli } from "../helpers.js";

const BALANCE = {
  org_id: "org-1",
  available_credits: 4210,
  spend_limit: 10000,
  period_end: "2026-10-01T00:00:00Z",
};

describe("credits balance, when the request fails", () => {
  it("exits 3 and explains how to authenticate when there is no API key", async () => {
    const res = await runCli(["credits", "balance"], { withKey: false });

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("no API key found");
    expect(res.stderr).toContain("SENSO_API_KEY");
  });

  it("exits 3 when the API rejects the key", async () => {
    server.use(
      http.get(apiUrl("/org/credits/balance"), () =>
        HttpResponse.json({ error: "invalid key" }, { status: 401 }),
      ),
    );

    const res = await runCli(["credits", "balance"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Authentication failed");
  });

  it("exits 3 when the key is valid but lacks the scope", async () => {
    server.use(
      http.get(apiUrl("/org/credits/balance"), () =>
        HttpResponse.json({ error: "billing scope required" }, { status: 403 }),
      ),
    );

    const res = await runCli(["credits", "balance"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Permission denied");
  });

  it("exits 4 on a 404", async () => {
    server.use(
      http.get(apiUrl("/org/credits/balance"), () => new HttpResponse(null, { status: 404 })),
    );

    const res = await runCli(["credits", "balance"]);

    expect(res.exitCode).toBe(4);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Not found");
  });

  it("exits 1 on a 500 and says it is not the caller's fault", async () => {
    server.use(
      http.get(apiUrl("/org/credits/balance"), () => new HttpResponse(null, { status: 500 })),
    );

    const res = await runCli(["credits", "balance"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("not your fault");
  });

  it("exits 5 when the API rate-limits the poll, because retrying is the right answer", async () => {
    server.use(
      http.get(apiUrl("/org/credits/balance"), () => new HttpResponse(null, { status: 429 })),
    );

    const res = await runCli(["credits", "balance"]);

    expect(res.exitCode).toBe(5);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Rate limited");
  });

  it("writes the failure to stderr as JSON, leaving stdout empty, under --output json", async () => {
    server.use(
      http.get(apiUrl("/org/credits/balance"), () =>
        HttpResponse.json({ error: "nope" }, { status: 403 }),
      ),
    );

    const res = await runCli(["credits", "balance", "--output", "json"]);

    expect(res.exitCode).toBe(3);
    // A script doing `credits balance --output json > balance.json` gets an
    // empty file rather than a file it would later read back as a balance.
    expect(res.stdout).toBe("");

    const reported: unknown = JSON.parse(res.stderr);
    expect(reported).toMatchObject({
      error: { code: "forbidden", status: 403 },
    });
  });
});

describe("credits balance, on the wire", () => {
  it("issues a plain GET to /org/credits/balance with no query and no body", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/credits/balance"), ({ request }) => {
        seen = request;
        return HttpResponse.json(BALANCE);
      }),
    );

    await runCli(["credits", "balance"]);

    expect(seen?.method).toBe("GET");
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/credits/balance");
    expect(new URL(seen?.url ?? "").search).toBe("");
    expect(seen?.headers.get("x-api-key")).toBe(TEST_API_KEY);
    expect(seen?.body).toBeNull();
  });
});

describe("credits balance, on success", () => {
  it("prints the payload unmodified under --output json", async () => {
    server.use(http.get(apiUrl("/org/credits/balance"), () => HttpResponse.json(BALANCE)));

    const res = await runCli(["credits", "balance", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.json()).toEqual(BALANCE);
    // json implies quiet: no banner and no commentary next to the payload.
    expect(res.stderr).toBe("");
  });

  it("renders the balance as a field/value table under --output table", async () => {
    server.use(http.get(apiUrl("/org/credits/balance"), () => HttpResponse.json(BALANCE)));

    const res = await runCli(["credits", "balance", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("available_credits");
    expect(res.stdout).toContain("4210");
  });

  it("renders one key/value line per field by default", async () => {
    server.use(http.get(apiUrl("/org/credits/balance"), () => HttpResponse.json(BALANCE)));

    const res = await runCli(["credits", "balance"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("available_credits");
    expect(res.stdout).toContain("spend_limit");
    expect(res.stdout).toContain("10000");
  });

  it("still exits 0 when the organization has no spend limit configured", async () => {
    server.use(
      http.get(apiUrl("/org/credits/balance"), () =>
        HttpResponse.json({ available_credits: 0, spend_limit: null }),
      ),
    );

    const res = await runCli(["credits", "balance"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("available_credits");
  });
});

describe("credits history, when the window is not a usable number", () => {
  /**
   * `--days` is validated here rather than round-tripped: the server rejects
   * anything outside 1-365 with a 400, and a billing script deserves exit 2 for
   * its own typo rather than an API error it has to parse.
   */
  const CASES: [string, string][] = [
    ["not a number", "thirty"],
    ["zero", "0"],
    ["negative", "-5"],
    ["over the 365-day ceiling", "400"],
    ["fractional", "1.5"],
  ];

  for (const [label, value] of CASES) {
    it(`exits 2 when --days is ${label}, without making a request`, async () => {
      let called = false;
      server.use(
        http.get(apiUrl("/org/credits/history"), () => {
          called = true;
          return HttpResponse.json({});
        }),
      );

      const res = await runCli(["credits", "history", "--days", value]);

      expect(res.exitCode).toBe(2);
      expect(res.stdout).toBe("");
      expect(called).toBe(false);
    });
  }
});

describe("credits history, on success", () => {
  const HISTORY = {
    org_id: "org-1",
    days: 3,
    period_usage: 12.5,
    history: [
      { date: "2026-09-16", usage: 4 },
      { date: "2026-09-17", usage: 0 },
      { date: "2026-09-18", usage: 8.5 },
    ],
  };

  function historyResponds(): { seen: () => URL | undefined } {
    let url: URL | undefined;
    server.use(
      http.get(apiUrl("/org/credits/history"), ({ request }) => {
        url = new URL(request.url);
        return HttpResponse.json(HISTORY);
      }),
    );
    return { seen: () => url };
  }

  it("sends no days parameter at all when the flag is omitted", async () => {
    // The server's own default is 30; sending one would override a default the
    // API is free to change.
    const { seen } = historyResponds();

    await runCli(["credits", "history"]);

    expect(seen()?.searchParams.has("days")).toBe(false);
  });

  it("passes the window through when given", async () => {
    const { seen } = historyResponds();

    await runCli(["credits", "history", "--days", "7"]);

    expect(seen()?.searchParams.get("days")).toBe("7");
  });

  it("gives a JSON caller the whole envelope, totals included", async () => {
    // The per-day rows are what the table shows, but `period_usage` is the
    // number a script actually wants and it is not one of the rows.
    historyResponds();

    const res = await runCli(["credits", "history", "--output", "json"]);

    expect(res.json()).toEqual(HISTORY);
  });

  it("renders the days as rows rather than collapsing them into one cell", async () => {
    // `org_id` and `period_usage` are not envelope keys, so the generic list
    // detection does not find `history` on its own.
    historyResponds();

    const res = await runCli(["credits", "history", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("date");
    expect(res.stdout).toContain("2026-09-17");
    expect(res.stdout).toContain("8.5");
  });

  it("keeps a zero-usage day, which is a real day and not a gap", async () => {
    historyResponds();

    const res = await runCli(["credits", "history"]);

    expect(res.stdout).toContain("2026-09-17");
  });

  it("does not fall over when the body carries no history", async () => {
    server.use(http.get(apiUrl("/org/credits/history"), () => HttpResponse.json({ org_id: "o" })));

    const res = await runCli(["credits", "history", "--output", "table"]);

    expect(res.exitCode).toBe(0);
  });
});
