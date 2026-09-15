/**
 * Command layer: `senso members`.
 *
 * The group is one read-only list command, and what is worth protecting about it
 * is in three places.
 *
 * The query string: `--limit`, `--offset`, `--search` and `--sort` are
 * translated one-for-one into API parameters of the same name. Nothing in the
 * command file would fail if that mapping drifted, and nothing a user sees would
 * change until a search silently returned the whole directory instead. So the
 * wire tests assert the parameter names and — just as important — that a flag
 * the user did not pass is absent from the URL rather than sent as the string
 * "undefined".
 *
 * The declared columns: they are the fields of OrgMemberResponse, and the
 * fixtures below are that DTO. An earlier fixture invented `name` and
 * `created_at`, which the API does not return, so `--output table` printed two
 * blank columns and left the role invisible while the test stayed green. The
 * table test now asserts the real fields AND that no column warning was raised.
 *
 * The guidance: this directory is the only place a `user_id` can be resolved
 * from an email, so the empty case and the `next` steps are the command's real
 * output for an agent, not decoration.
 *
 * Failure and usage branches come first: a `--sort` typo must cost exit 2 rather
 * than a plausible list in the wrong order.
 */

import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server, TEST_API_KEY } from "../setup.js";
import { apiUrl, envelope, errorEnvelope, runCli } from "../helpers.js";

const ORG_ID = "b1e9f6c2-7f4a-4d2e-9a3b-1c5d7e9f0a2b";
const USER_ADA = "2a9c1d3e-5f6a-4b7c-8d9e-0f1a2b3c4d5e";
const USER_ALAN = "7c6b5a49-3827-4615-9403-2f1e0d9c8b7a";
const ORG_USER_ADA = "d4e3f2a1-b0c9-4d8e-9f7a-6b5c4d3e2f1a";
const ORG_USER_ALAN = "e5f4a3b2-c1d0-4e9f-8a7b-6c5d4e3f2a1b";
const ROLE_ADMIN = "9e8d7c6b-5a49-4837-9625-14f3e2d1c0b9";
const ROLE_VIEWER = "1f2e3d4c-5b6a-4978-8695-a4b3c2d1e0f9";
const GROUP_EDITORS = "3c4d5e6f-7a8b-49c0-8d1e-2f3a4b5c6d7e";

/**
 * dto.OrgMemberListResponse, field for field.
 *
 * `groups` is always an array and never null — the DTO says so — and
 * `role_display_name` is the only place a role's name appears in this CLI.
 */
const MEMBERS = {
  members: [
    {
      org_user_id: ORG_USER_ADA,
      org_id: ORG_ID,
      user_id: USER_ADA,
      email: "ada@example.com",
      given_name: "Ada",
      family_name: "Lovelace",
      role_id: ROLE_ADMIN,
      role_display_name: "admin",
      groups: [{ group_id: GROUP_EDITORS, name: "Editors" }],
    },
    {
      org_user_id: ORG_USER_ALAN,
      org_id: ORG_ID,
      user_id: USER_ALAN,
      email: "alan@example.com",
      given_name: "Alan",
      family_name: "Turing",
      role_id: ROLE_VIEWER,
      role_display_name: "viewer",
      groups: [],
    },
  ],
  total: 2,
  limit: 50,
  offset: 0,
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

  it("says a 403 is a missing permission when the API blames the scope", async () => {
    // A 403 is four different failures wearing one status. This one is the
    // ordinary case: the key is real, an admin can widen it.
    server.use(
      http.get(apiUrl("/org/members"), () =>
        HttpResponse.json({ message: "member directory is admin-only" }, { status: 403 }),
      ),
    );

    const res = await runCli(["members", "list"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Permission denied");
    expect(res.stderr).toContain("An org admin can widen it");
  });

  it("says a 403 about a product is a plan question, not a scope question", async () => {
    server.use(
      http.get(apiUrl("/org/members"), () =>
        HttpResponse.json({ message: "organization is not entitled to this product" }, { status: 403 }),
      ),
    );

    const res = await runCli(["members", "list", "--output", "json"]);

    expect(res.exitCode).toBe(3);
    expect(errorEnvelope(res).error.hint).toContain("does not have the product");
  });

  it("names the organization, not just 'not found', on a 404", async () => {
    server.use(http.get(apiUrl("/org/members"), () => new HttpResponse(null, { status: 404 })));

    const res = await runCli(["members", "list"]);

    expect(res.exitCode).toBe(4);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Organization not found");
    expect(res.stderr).toContain("senso whoami");
  });

  it("exits 1 on a 500 and offers a retry", async () => {
    server.use(http.get(apiUrl("/org/members"), () => new HttpResponse(null, { status: 500 })));

    const res = await runCli(["members", "list"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Retry shortly");
  });

  it("refuses to suggest a retry on a 503, which retrying cannot fix", async () => {
    // 503 here is a deployment that does not offer the endpoint, not a busy
    // server. Telling a caller to retry is advice that can never work.
    server.use(
      http.get(apiUrl("/org/members"), () =>
        HttpResponse.json({ message: "Members are not enabled in this environment" }, { status: 503 }),
      ),
    );

    const res = await runCli(["members", "list"]);

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("not a transient failure");
    expect(res.stderr).not.toContain("Retry shortly");
  });

  it("writes one error envelope to stderr and leaves stdout empty under --output json", async () => {
    server.use(
      http.get(apiUrl("/org/members"), () => HttpResponse.json({ error: "nope" }, { status: 403 })),
    );

    const res = await runCli(["members", "list", "--output", "json"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");

    const reported = errorEnvelope(res);
    expect(reported.ok).toBe(false);
    expect(reported.command).toBe("members list");
    expect(reported.error).toMatchObject({
      code: "forbidden",
      status: 403,
      request: { method: "GET", path: "/org/members" },
    });
  });
});

describe("members list, when the command line is wrong", () => {
  it("exits 2 and puts the six orders in error.allowed when --sort is a typo", async () => {
    // No handler is registered: reaching the network would fail this test under
    // MSW's unhandled-request rule, which is the assertion that matters.
    const res = await runCli(["members", "list", "--sort", "name_ascending", "--output", "json"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");

    const { error } = errorEnvelope(res);
    expect(error.code).toBe("usage");
    expect(error.field).toBe("--sort");
    expect(error.received).toBe("name_ascending");
    expect(error.allowed).toEqual([
      "name_asc",
      "name_desc",
      "email_asc",
      "email_desc",
      "created_asc",
      "created_desc",
    ]);
  });

  it("exits 2 when --limit is above the range the endpoint accepts", async () => {
    const res = await runCli(["members", "list", "--limit", "5000", "--output", "json"]);

    expect(res.exitCode).toBe(2);
    expect(errorEnvelope(res).error.field).toBe("--limit");
  });

  it("exits 2 when --offset is negative", async () => {
    const res = await runCli(["members", "list", "--offset", "-1", "--output", "json"]);

    expect(res.exitCode).toBe(2);
    expect(errorEnvelope(res).error.field).toBe("--offset");
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
  it("wraps the payload unmodified in the success envelope under --output json", async () => {
    server.use(http.get(apiUrl("/org/members"), () => HttpResponse.json(MEMBERS)));

    const res = await runCli(["members", "list", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toEqual(MEMBERS);
    expect(envelope(res).command).toBe("members list");
    expect(res.stderr).toBe("");
  });

  it("carries the page position in the envelope, where a json caller can read it", async () => {
    server.use(http.get(apiUrl("/org/members"), () => HttpResponse.json(MEMBERS)));

    const res = await runCli(["members", "list", "--output", "json"]);

    expect(envelope(res).page).toMatchObject({
      offset: 0,
      limit: 50,
      returned: 2,
      total: 2,
      has_more: false,
    });
  });

  it("tells a json caller how to change a role, since stderr is silent there", async () => {
    server.use(http.get(apiUrl("/org/members"), () => HttpResponse.json(MEMBERS)));

    const res = await runCli(["members", "list", "--output", "json"]);

    const commands = (envelope(res).next ?? []).map((step) => step.command);
    expect(commands.some((c) => c.startsWith("senso users update"))).toBe(true);
    expect(commands).toContain("senso roles list");
  });

  it("shows the fields the API actually returns under --output table", async () => {
    server.use(http.get(apiUrl("/org/members"), () => HttpResponse.json(MEMBERS)));

    const res = await runCli(["members", "list", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    for (const column of ["user_id", "email", "given_name", "family_name", "role_display_name"]) {
      expect(res.stdout).toContain(column);
    }
    expect(res.stdout).toContain("ada@example.com");
    expect(res.stdout).toContain("Turing");
    // The role is the reason anyone reads this table; it must not be blank.
    expect(res.stdout).toContain("admin");
  });

  it("does not warn about a missing column, because every declared column exists", async () => {
    // The guard that caught the invented `name` and `created_at` columns this
    // group used to declare. If it fires, the fixture is lying or the command is.
    server.use(http.get(apiUrl("/org/members"), () => HttpResponse.json(MEMBERS)));

    const res = await runCli(["members", "list", "--output", "table"]);

    expect(res.stderr).not.toContain("did not return");
  });

  it("renders a readable block per member by default", async () => {
    server.use(http.get(apiUrl("/org/members"), () => HttpResponse.json(MEMBERS)));

    const res = await runCli(["members", "list"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Ada");
    expect(res.stdout).toContain("alan@example.com");
    expect(res.stdout).toContain("Editors");
    expect(res.stderr).toContain("Showing 1–2 of 2.");
  });

  it("says the search matched nobody, and how to widen it", async () => {
    server.use(
      http.get(apiUrl("/org/members"), () =>
        HttpResponse.json({ members: [], total: 0, limit: 50, offset: 0 }),
      ),
    );

    const res = await runCli(["members", "list", "--search", "nobody@example.com"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("No members found.");
    // Why it might be empty belongs on stderr, with the command that widens it.
    expect(res.stderr).toContain("senso members list");
    expect(res.stderr).toContain("nobody@example.com");
  });

  it("blames the key's organization when an unfiltered list comes back empty", async () => {
    server.use(
      http.get(apiUrl("/org/members"), () =>
        HttpResponse.json({ members: [], total: 0, limit: 50, offset: 0 }),
      ),
    );

    const res = await runCli(["members", "list"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("No members found.");
    expect(res.stderr).toContain("senso whoami");
  });
});
