/**
 * Command layer: `senso members`.
 *
 * The group is one list command, and almost everything worth protecting about it
 * lives in the query string. `--limit`, `--offset`, `--search` and `--sort` are
 * translated one-for-one into API parameters of the same name; nothing in the
 * command file would fail if that mapping drifted, and nothing a user sees would
 * change until a search silently returned the whole directory instead.
 *
 * So the wire tests below assert the parameter names, and — just as important —
 * that a flag the user did not pass is absent from the URL rather than sent as
 * the string "undefined".
 */

import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server, TEST_API_KEY } from "../setup.js";
import { apiUrl, runCli } from "../helpers.js";

const MEMBERS = {
  members: [
    {
      user_id: "u-1",
      name: "Ada Lovelace",
      email: "ada@example.com",
      created_at: "2026-01-02T00:00:00Z",
    },
    {
      user_id: "u-2",
      name: "Alan Turing",
      email: "alan@example.com",
      created_at: "2026-02-03T00:00:00Z",
    },
  ],
  total: 2,
};

/** Registers a handler that records the request and returns the directory. */
function captureMembers(): { seen: () => Request | undefined } {
  let request: Request | undefined;
  server.use(
    http.get(apiUrl("/org/members"), (info) => {
      request = info.request;
      return HttpResponse.json(MEMBERS);
    }),
  );
  return { seen: () => request };
}

describe("members list, when the request fails", () => {
  it("exits 3 and explains how to authenticate when there is no API key", async () => {
    const res = await runCli(["members", "list"], { withKey: false });

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("no API key found");
    expect(res.stderr).toContain("SENSO_API_KEY");
  });

  it("exits 3 when the API rejects the key", async () => {
    server.use(
      http.get(apiUrl("/org/members"), () =>
        HttpResponse.json({ error: "invalid key" }, { status: 401 }),
      ),
    );

    const res = await runCli(["members", "list"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Authentication failed");
  });

  it("exits 3 when the key is valid but lacks the scope", async () => {
    server.use(
      http.get(apiUrl("/org/members"), () =>
        HttpResponse.json({ error: "member directory is admin-only" }, { status: 403 }),
      ),
    );

    const res = await runCli(["members", "list"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Permission denied");
  });

  it("exits 4 on a 404", async () => {
    server.use(http.get(apiUrl("/org/members"), () => new HttpResponse(null, { status: 404 })));

    const res = await runCli(["members", "list"]);

    expect(res.exitCode).toBe(4);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Not found");
  });

  it("exits 1 on a 500 and says it is not the caller's fault", async () => {
    server.use(http.get(apiUrl("/org/members"), () => new HttpResponse(null, { status: 500 })));

    const res = await runCli(["members", "list"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("not your fault");
  });

  it("writes the failure to stderr as JSON, leaving stdout empty, under --output json", async () => {
    server.use(
      http.get(apiUrl("/org/members"), () => HttpResponse.json({ error: "nope" }, { status: 403 })),
    );

    const res = await runCli(["members", "list", "--output", "json"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");

    const reported: unknown = JSON.parse(res.stderr);
    expect(reported).toMatchObject({
      error: { code: "forbidden", status: 403 },
    });
  });
});

describe("members list, on the wire", () => {
  it("sends no query parameters at all when no flags are given", async () => {
    const cap = captureMembers();

    await runCli(["members", "list"]);

    expect(cap.seen()?.method).toBe("GET");
    const url = new URL(cap.seen()?.url ?? "");
    expect(url.pathname).toBe("/api/v1/org/members");
    // Not `?limit=undefined`: an omitted flag must not become a literal.
    expect(url.search).toBe("");
  });

  it("maps every flag onto the API parameter of the same name", async () => {
    const cap = captureMembers();

    await runCli([
      "members",
      "list",
      "--limit",
      "50",
      "--offset",
      "100",
      "--search",
      "ada",
      "--sort",
      "email_desc",
    ]);

    const url = new URL(cap.seen()?.url ?? "");
    expect(url.searchParams.get("limit")).toBe("50");
    expect(url.searchParams.get("offset")).toBe("100");
    expect(url.searchParams.get("search")).toBe("ada");
    expect(url.searchParams.get("sort")).toBe("email_desc");
  });

  it("URL-encodes a search term containing a space or an @", async () => {
    const cap = captureMembers();

    await runCli(["members", "list", "--search", "ada lovelace@example.com"]);

    const url = new URL(cap.seen()?.url ?? "");
    expect(url.searchParams.get("search")).toBe("ada lovelace@example.com");
    expect(url.search).not.toContain(" ");
  });

  it("sends only the flags that were given", async () => {
    const cap = captureMembers();

    await runCli(["members", "list", "--limit", "10"]);

    const url = new URL(cap.seen()?.url ?? "");
    expect([...url.searchParams.keys()]).toEqual(["limit"]);
  });

  it("sends the API key as X-API-Key and identifies itself", async () => {
    const cap = captureMembers();

    await runCli(["members", "list"]);

    expect(cap.seen()?.headers.get("x-api-key")).toBe(TEST_API_KEY);
    expect(cap.seen()?.headers.get("user-agent")).toMatch(/^senso-cli\//);
    expect(cap.seen()?.headers.get("accept")).toBe("application/json");
  });
});

describe("members list, on success", () => {
  it("prints the payload unmodified under --output json", async () => {
    server.use(http.get(apiUrl("/org/members"), () => HttpResponse.json(MEMBERS)));

    const res = await runCli(["members", "list", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.json()).toEqual(MEMBERS);
    expect(res.stderr).toBe("");
  });

  it("shows the directory columns under --output table", async () => {
    server.use(http.get(apiUrl("/org/members"), () => HttpResponse.json(MEMBERS)));

    const res = await runCli(["members", "list", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    for (const column of ["user_id", "name", "email", "created_at"]) {
      expect(res.stdout).toContain(column);
    }
    expect(res.stdout).toContain("ada@example.com");
    expect(res.stdout).toContain("Alan Turing");
  });

  it("renders a readable block per member by default", async () => {
    server.use(http.get(apiUrl("/org/members"), () => HttpResponse.json(MEMBERS)));

    const res = await runCli(["members", "list"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Ada Lovelace");
    expect(res.stdout).toContain("alan@example.com");
  });

  it("exits 0 when a search matches nobody", async () => {
    server.use(
      http.get(apiUrl("/org/members"), () => HttpResponse.json({ members: [], total: 0 })),
    );

    const res = await runCli(["members", "list", "--search", "nobody"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("members");
  });
});
