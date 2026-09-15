/**
 * Command layer: `senso roles`.
 *
 * This is the smallest command group in the CLI, which makes it the reference
 * for what every other command test should cover. What is worth protecting here
 * is not "roles list returns roles" — it is the contract the group inherits from
 * lib/run-action.ts and lib/output.ts:
 *
 *   - the exact request that goes on the wire, so a renamed API parameter fails
 *     here rather than in a user's terminal;
 *   - stdout carrying the payload and nothing else, in all three formats;
 *   - each failure exiting with the code that says what happened.
 *
 * Failure branches come first, on purpose. They are the cases a caller actually
 * has to handle, and they were the ones with no coverage at all.
 */

import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server, TEST_API_KEY } from "../setup.js";
import { apiUrl, runCli } from "../helpers.js";

const ROLES = {
  roles: [
    { role_id: "r-admin", name: "admin", description: "Full access" },
    { role_id: "r-view", name: "viewer", description: "Read only" },
  ],
};

describe("roles list, when the request fails", () => {
  it("exits 3 and explains how to authenticate when there is no API key", async () => {
    const res = await runCli(["roles", "list"], { withKey: false });

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("no API key found");
    expect(res.stderr).toContain("SENSO_API_KEY");
  });

  it("exits 3 when the API rejects the key", async () => {
    server.use(
      http.get(apiUrl("/org/roles"), () =>
        HttpResponse.json({ error: "invalid key" }, { status: 401 }),
      ),
    );

    const res = await runCli(["roles", "list"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Authentication failed");
  });

  it("exits 4 on a 404", async () => {
    server.use(http.get(apiUrl("/org/roles"), () => new HttpResponse(null, { status: 404 })));

    const res = await runCli(["roles", "list"]);

    expect(res.exitCode).toBe(4);
    expect(res.stderr).toContain("Not found");
  });

  it("exits 1 on a 500 and says it is not the caller's fault", async () => {
    server.use(http.get(apiUrl("/org/roles"), () => new HttpResponse(null, { status: 503 })));

    const res = await runCli(["roles", "list"]);

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("not a transient failure");
  });

  it("reports a malformed body rather than throwing a parse error at the user", async () => {
    server.use(http.get(apiUrl("/org/roles"), () => new HttpResponse("<html>nope</html>")));

    const res = await runCli(["roles", "list"]);

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("Invalid JSON response");
  });

  it("writes the failure to stderr as JSON, leaving stdout empty, under --output json", async () => {
    server.use(
      http.get(apiUrl("/org/roles"), () => HttpResponse.json({ error: "nope" }, { status: 403 })),
    );

    const res = await runCli(["roles", "list", "--output", "json"]);

    expect(res.exitCode).toBe(3);
    // The important half: a caller redirecting stdout to a file gets an empty
    // file, not a file containing an error object it would later read as data.
    expect(res.stdout).toBe("");

    const reported: unknown = JSON.parse(res.stderr);
    expect(reported).toMatchObject({
      error: { code: "forbidden", status: 403 },
    });
  });
});

describe("roles list, on the wire", () => {
  it("sends the API key as X-API-Key and identifies itself", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/roles"), ({ request }) => {
        seen = request;
        return HttpResponse.json(ROLES);
      }),
    );

    await runCli(["roles", "list"]);

    expect(seen?.headers.get("x-api-key")).toBe(TEST_API_KEY);
    expect(seen?.headers.get("user-agent")).toMatch(/^senso-cli\//);
    expect(seen?.headers.get("accept")).toBe("application/json");
  });
});

describe("roles list, on success", () => {
  it("prints the payload unmodified under --output json", async () => {
    server.use(http.get(apiUrl("/org/roles"), () => HttpResponse.json(ROLES)));

    const res = await runCli(["roles", "list", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toEqual(ROLES);
    // Nothing decorative alongside it: no banner, no success tick.
    expect(res.stderr).toBe("");
  });

  it("renders one aligned row per role under --output table", async () => {
    server.use(http.get(apiUrl("/org/roles"), () => HttpResponse.json(ROLES)));

    const res = await runCli(["roles", "list", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("role_id");
    expect(res.stdout).toContain("r-admin");
    expect(res.stdout).toContain("viewer");
  });

  it("renders a readable block per role by default", async () => {
    server.use(http.get(apiUrl("/org/roles"), () => HttpResponse.json(ROLES)));

    const res = await runCli(["roles", "list"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("admin");
    expect(res.stdout).toContain("Full access");
  });

  it("says so plainly when the organization has no roles", async () => {
    server.use(http.get(apiUrl("/org/roles"), () => HttpResponse.json({ roles: [] })));

    const res = await runCli(["roles", "list"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("roles");
  });
});
