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
