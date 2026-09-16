/**
 * Command layer: `senso users`.
 *
 * Three things are worth protecting here, and all three are invisible from the
 * command line.
 *
 * The bodies the CLI writes itself. Most of the group forwards a `--data` blob
 * the caller wrote, so the field names cannot drift. `invite`, `invite-existing`
 * and `set-current` are the exception: they build the request out of individual
 * flags, so `--given-name` becomes `given_name` and an absent `--is-current`
 * becomes an explicit `false` rather than a missing key. Nothing in the response
 * would reveal a rename. The assertions below are exact objects, not subsets: an
 * extra field is as much a drift as a missing one.
 *
 * `role_id`, which is PER ORGANIZATION. A role id copied from another org, or
 * from a stale script, is the commonest failure in this group, and the API
 * answers it with "Invalid role ID for this organization" naming neither the
 * field nor the value. Every path that carries one — `--data.role_id`,
 * `--role-id`, and the API's own 400 — has to end up naming `senso roles list`,
 * because that is the only command that resolves one. Those tests come first.
 *
 * The three id spaces. `user_id` is the person and the only id any command here
 * accepts on the path; `org_user_id` is the membership row and no command takes
 * it; `role_id` is a role. All are UUIDs, so a malformed one must cost exit 2
 * and never a round trip.
 *
 * The fixtures are dto.OrgUserResponse, which is what every read and every write
 * in this group returns: ids only, no email and no name. An earlier fixture put
 * an `email` on it — that field belongs to `senso members list`, and inventing it
 * here would hide the very reason the two groups both exist.
 *
 * Failure and usage branches come first, as in tests/commands/roles.test.ts.
 */

import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../setup.js";
import { apiUrl, envelope, errorEnvelope, runCli } from "../helpers.js";

const ORG_ID = "b1e9f6c2-7f4a-4d2e-9a3b-1c5d7e9f0a2b";
const USER_ADA = "2a9c1d3e-5f6a-4b7c-8d9e-0f1a2b3c4d5e";
const USER_ALAN = "7c6b5a49-3827-4615-9403-2f1e0d9c8b7a";
const ORG_USER_ADA = "d4e3f2a1-b0c9-4d8e-9f7a-6b5c4d3e2f1a";
const ORG_USER_ALAN = "e5f4a3b2-c1d0-4e9f-8a7b-6c5d4e3f2a1b";
const ROLE_ADMIN = "9e8d7c6b-5a49-4837-9625-14f3e2d1c0b9";
const ROLE_VIEWER = "1f2e3d4c-5b6a-4978-8695-a4b3c2d1e0f9";

/**
 * GET /org/users returns a BARE ARRAY of dto.OrgUserResponse.
 *
 * Not `{ users: [...] }` and not a paginated envelope: there is no total, which
 * is why the command's help says a full page may mean there are more.
 */
const USERS = [
  {
    org_user_id: ORG_USER_ADA,
    org_id: ORG_ID,
    user_id: USER_ADA,
    role_id: ROLE_ADMIN,
    is_current: true,
    created_at: "2026-01-05T00:00:00Z",
    updated_at: "2026-01-05T00:00:00Z",
  },
  {
    org_user_id: ORG_USER_ALAN,
    org_id: ORG_ID,
    user_id: USER_ALAN,
    role_id: ROLE_VIEWER,
    is_current: false,
    created_at: "2026-02-05T00:00:00Z",
    updated_at: "2026-02-05T00:00:00Z",
  },
];

/** One membership: what get, add, update, set-current and both invites return. */
const ONE_USER = {
  org_user_id: ORG_USER_ADA,
  org_id: ORG_ID,
  user_id: USER_ADA,
  role_id: ROLE_ADMIN,
  is_current: true,
  created_at: "2026-01-05T00:00:00Z",
  updated_at: "2026-09-01T12:00:00Z",
};

/** The API's answer to a role id belonging to some other organization. */
const BAD_ROLE = { status: 400, message: "Invalid role ID for this organization" };

describe("users, when a role_id is wrong", () => {
  it("exits 2 before any request when --data.role_id is not a UUID", async () => {
    // No handler is registered: a request here would fail the test under MSW's
    // unhandled-request rule, which is the assertion.
    const res = await runCli([
      "users",
      "update",
      USER_ADA,
      "--data",
      '{"role_id":"admin"}',
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");

    const { error } = errorEnvelope(res);
    expect(error.code).toBe("usage");
    expect(error.field).toBe("--data.role_id");
    expect(error.received).toBe("admin");
    // The only command that resolves a role name to an id for THIS org.
    expect(error.hint).toContain("senso roles list");
  });

  it("exits 2 when --data.role_id is not even a string", async () => {
    const res = await runCli([
      "users",
      "update",
      USER_ADA,
      "--data",
      '{"role_id":3}',
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    const { error } = errorEnvelope(res);
    expect(error.field).toBe("--data.role_id");
    expect(error.hint).toContain("senso roles list");
  });

  it("exits 2 before any request when --role-id on invite is not a UUID", async () => {
    const res = await runCli([
      "users",
      "invite",
      "--email",
      "ada@example.com",
      "--given-name",
      "Ada",
      "--family-name",
      "Lovelace",
      "--role-id",
      "admin",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    const { error } = errorEnvelope(res);
    expect(error.field).toBe("--role-id");
    expect(error.received).toBe("admin");
    expect(error.hint).toContain("senso roles list");
  });

  it("turns the API's fieldless 400 into one that names role_id and the value", async () => {
    // "Invalid role ID for this organization" names neither the field nor the
    // id, and roles are per organization, so this 400 has exactly one cause and
    // one fix.
    server.use(
      http.put(apiUrl("/org/users/:userId"), () =>
        HttpResponse.json({ message: BAD_ROLE.message }, { status: BAD_ROLE.status }),
      ),
    );

    const res = await runCli([
      "users",
      "update",
      USER_ADA,
      "--data",
      `{"role_id":"${ROLE_VIEWER}"}`,
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");

    const { error } = errorEnvelope(res);
    expect(error.code).toBe("validation");
    expect(error.status).toBe(400);
    expect(error.field).toBe("role_id");
    expect(error.received).toBe(ROLE_VIEWER);
    expect(error.message).toContain(BAD_ROLE.message);
    expect(error.hint).toContain("senso roles list");
  });

  it("names role_id the same way when adding an existing account", async () => {
    server.use(
      http.post(apiUrl("/org/users"), () =>
        HttpResponse.json({ message: BAD_ROLE.message }, { status: BAD_ROLE.status }),
      ),
    );

    const res = await runCli([
      "users",
      "add",
      "--data",
      `{"user_id":"${USER_ALAN}","role_id":"${ROLE_VIEWER}"}`,
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(1);
    expect(errorEnvelope(res).error).toMatchObject({
      field: "role_id",
      received: ROLE_VIEWER,
    });
  });

  it("names role_id the same way when inviting", async () => {
    server.use(
      http.post(apiUrl("/org/users/invite"), () =>
        HttpResponse.json({ message: BAD_ROLE.message }, { status: BAD_ROLE.status }),
      ),
    );

    const res = await runCli([
      "users",
      "invite",
      "--email",
      "ada@example.com",
      "--given-name",
      "Ada",
      "--family-name",
      "Lovelace",
      "--role-id",
      ROLE_VIEWER,
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(1);
    const { error } = errorEnvelope(res);
    expect(error.field).toBe("role_id");
    expect(error.hint).toContain("senso roles list");
  });

  it("leaves a 400 that is not about a role alone", async () => {
    // The rewrite is keyed on the word "role" precisely so it cannot swallow an
    // unrelated validation failure and report the wrong field.
    server.use(
      http.put(apiUrl("/org/users/:userId"), () =>
        HttpResponse.json({ message: "is_current must be a boolean" }, { status: 400 }),
      ),
    );

    const res = await runCli([
      "users",
      "update",
      USER_ADA,
      "--data",
      `{"role_id":"${ROLE_VIEWER}","is_current":true}`,
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(1);
    const { error } = errorEnvelope(res);
    expect(error.code).toBe("validation");
    expect(error.field).toBeUndefined();
  });
});

describe("users, when an id or a flag is wrong", () => {
  it("exits 2 before any request when <userId> is not a UUID", async () => {
    const res = await runCli(["users", "get", "u-1", "--output", "json"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");

    const { error } = errorEnvelope(res);
    expect(error.field).toBe("<userId>");
    expect(error.received).toBe("u-1");
    expect(error.hint).toContain("senso members list");
  });

  it("exits 2 when the org_user_id is passed where a user_id belongs", async () => {
    // Both are UUIDs, so this one cannot be caught before the request — but the
    // 404 has to name which id space was wanted.
    server.use(
      http.get(apiUrl("/org/users/:userId"), () =>
        HttpResponse.json(
          { message: "User is not a member of this organization" },
          { status: 404 },
        ),
      ),
    );

    const res = await runCli(["users", "get", ORG_USER_ADA, "--output", "json"]);

    expect(res.exitCode).toBe(4);
    const { error } = errorEnvelope(res);
    expect(error.code).toBe("not_found");
    expect(error.field).toBe("user_id");
    expect(error.received).toBe(ORG_USER_ADA);
    expect(error.message).toContain(`User ${ORG_USER_ADA}`);
    expect(error.hint).toContain("senso members list");
  });

  it("exits 2 when add's --data is not valid JSON", async () => {
    const res = await runCli(["users", "add", "--data", "{user_id: u-1}"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Invalid JSON in --data");
  });

  it("exits 2 when update's --data parses to something that is not an object", async () => {
    const res = await runCli(["users", "update", USER_ADA, "--data", '"r-admin"']);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("must be a JSON object");
  });

  it("names both required keys when add's --data has neither", async () => {
    const res = await runCli(["users", "add", "--data", '{"is_current":true}', "--output", "json"]);

    expect(res.exitCode).toBe(2);
    const { error } = errorEnvelope(res);
    expect(error.message).toContain("user_id");
    expect(error.message).toContain("role_id");
    expect(error.allowed).toEqual(["user_id", "role_id", "is_current"]);
  });

  it("exits 2 when add's --data.user_id is not a UUID", async () => {
    const res = await runCli([
      "users",
      "add",
      "--data",
      `{"user_id":"ada","role_id":"${ROLE_ADMIN}"}`,
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    expect(errorEnvelope(res).error.field).toBe("--data.user_id");
  });

  it("exits 2 when --email is not an email address", async () => {
    const res = await runCli([
      "users",
      "invite-existing",
      "--email",
      "ada-at-example.com",
      "--role-id",
      ROLE_VIEWER,
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    const { error } = errorEnvelope(res);
    expect(error.field).toBe("--email");
    expect(error.received).toBe("ada-at-example.com");
  });

  it("exits 2 when invite is missing a required flag", async () => {
    const res = await runCli(["users", "invite", "--email", "ada@example.com"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
  });

  it("exits 2 when invite-existing is missing --role-id", async () => {
    const res = await runCli(["users", "invite-existing", "--email", "ada@example.com"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
  });

  it("names the valid formats when --output is not one of them", async () => {
    const res = await runCli(["users", "list", "--output", "csv"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("json, table, plain");
  });
});

describe("users, when the request fails", () => {
  it("exits 3 and explains how to authenticate when there is no API key", async () => {
    const res = await runCli(["users", "list"], { withKey: false });

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("no API key found");
    expect(res.stderr).toContain("SENSO_API_KEY");
  });

  it("exits 3 when the API rejects the key", async () => {
    server.use(
      http.get(apiUrl("/org/users"), () =>
        HttpResponse.json({ error: "invalid key" }, { status: 401 }),
      ),
    );

    const res = await runCli(["users", "list"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Authentication failed");
  });

  it("says a 403 is a missing permission an admin can widen", async () => {
    server.use(
      http.get(apiUrl("/org/users"), () =>
        HttpResponse.json({ message: "members:write required" }, { status: 403 }),
      ),
    );

    const res = await runCli(["users", "list"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Permission denied");
    expect(res.stderr).toContain("An org admin can widen it");
  });

  it("points at `users invite` when invite-existing finds no account for the email", async () => {
    // The documented failure for this command: the email belongs to nobody, and
    // the answer is to create the account rather than to list anything.
    server.use(
      http.post(apiUrl("/org/users/invite/existing"), () =>
        HttpResponse.json({ message: "user not found" }, { status: 404 }),
      ),
    );

    const res = await runCli([
      "users",
      "invite-existing",
      "--email",
      "nobody@example.com",
      "--role-id",
      ROLE_VIEWER,
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(4);
    expect(res.stdout).toBe("");

    const { error } = errorEnvelope(res);
    expect(error.message).toContain("Senso user with email nobody@example.com not found");
    expect(error.hint).toContain("senso users invite --email nobody@example.com");
  });

  it("exits 1 on a 502 and offers a retry", async () => {
    server.use(http.get(apiUrl("/org/users"), () => new HttpResponse(null, { status: 502 })));

    const res = await runCli(["users", "list"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Retry shortly");
  });

  it("refuses to suggest a retry on a 503, which retrying cannot fix", async () => {
    server.use(
      http.get(apiUrl("/org/users"), () =>
        HttpResponse.json({ message: "User management is not enabled here" }, { status: 503 }),
      ),
    );

    const res = await runCli(["users", "list"]);

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("not a transient failure");
    expect(res.stderr).not.toContain("Retry shortly");
  });

  it("exits 1 when the person is already a member", async () => {
    server.use(
      http.post(apiUrl("/org/users"), () =>
        HttpResponse.json({ message: "User is already a member" }, { status: 409 }),
      ),
    );

    const res = await runCli([
      "users",
      "add",
      "--data",
      `{"user_id":"${USER_ALAN}","role_id":"${ROLE_VIEWER}"}`,
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(1);
    expect(errorEnvelope(res).error).toMatchObject({ code: "conflict", status: 409 });
  });

  it("writes one error envelope to stderr and leaves stdout empty under --output json", async () => {
    server.use(
      http.get(apiUrl("/org/users"), () => HttpResponse.json({ error: "nope" }, { status: 403 })),
    );

    const res = await runCli(["users", "list", "--output", "json"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");

    const reported = errorEnvelope(res);
    expect(reported.ok).toBe(false);
    expect(reported.command).toBe("users list");
    expect(reported.error).toMatchObject({
      code: "forbidden",
      status: 403,
      request: { method: "GET", path: "/org/users" },
    });
  });
});

describe("users list, on the wire", () => {
  it("GETs /org/users with no query when neither page flag is given", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/users"), ({ request }) => {
        seen = request;
        return HttpResponse.json(USERS);
      }),
    );

    await runCli(["users", "list"]);

    expect(seen?.method).toBe("GET");
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/users");
    expect(new URL(seen?.url ?? "").search).toBe("");
  });

  it("passes --limit and --offset through as limit and offset", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/users"), ({ request }) => {
        seen = request;
        return HttpResponse.json(USERS);
      }),
    );

    await runCli(["users", "list", "--limit", "25", "--offset", "50"]);

    const params = new URL(seen?.url ?? "").searchParams;
    expect(params.get("limit")).toBe("25");
    expect(params.get("offset")).toBe("50");
  });
});

describe("users add, get, update and remove, on the wire", () => {
  it("POSTs the parsed --data object to /org/users unchanged", async () => {
    let body: unknown;
    let seen: Request | undefined;
    server.use(
      http.post(apiUrl("/org/users"), async ({ request }) => {
        seen = request.clone();
        body = await request.json();
        return HttpResponse.json(ONE_USER, { status: 201 });
      }),
    );

    await runCli([
      "users",
      "add",
      "--data",
      `{"user_id":"${USER_ALAN}","role_id":"${ROLE_VIEWER}","is_current":false}`,
    ]);

    expect(seen?.method).toBe("POST");
    expect(body).toEqual({ user_id: USER_ALAN, role_id: ROLE_VIEWER, is_current: false });
  });

  it("GETs /org/users/<userId>", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/users/:userId"), ({ request }) => {
        seen = request;
        return HttpResponse.json(ONE_USER);
      }),
    );

    await runCli(["users", "get", USER_ADA]);

    expect(seen?.method).toBe("GET");
    expect(new URL(seen?.url ?? "").pathname).toBe(`/api/v1/org/users/${USER_ADA}`);
  });

  it("PUTs the parsed --data object to /org/users/<userId>", async () => {
    let body: unknown;
    let seen: Request | undefined;
    server.use(
      http.put(apiUrl("/org/users/:userId"), async ({ request }) => {
        seen = request.clone();
        body = await request.json();
        return HttpResponse.json({ ...ONE_USER, role_id: ROLE_VIEWER });
      }),
    );

    await runCli(["users", "update", USER_ADA, "--data", `{"role_id":"${ROLE_VIEWER}"}`]);

    expect(seen?.method).toBe("PUT");
    expect(new URL(seen?.url ?? "").pathname).toBe(`/api/v1/org/users/${USER_ADA}`);
    expect(body).toEqual({ role_id: ROLE_VIEWER });
  });

  it("DELETEs /org/users/<userId> with no body", async () => {
    let seen: Request | undefined;
    server.use(
      http.delete(apiUrl("/org/users/:userId"), ({ request }) => {
        seen = request;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const res = await runCli(["users", "remove", USER_ADA]);

    expect(res.exitCode).toBe(0);
    expect(seen?.method).toBe("DELETE");
    expect(new URL(seen?.url ?? "").pathname).toBe(`/api/v1/org/users/${USER_ADA}`);
    expect(seen?.headers.get("content-type")).toBeNull();
  });
});

describe("users set-current, on the wire", () => {
  it("PATCHes /org/users/<userId>/current with is_current true", async () => {
    let body: unknown;
    let seen: Request | undefined;
    server.use(
      http.patch(apiUrl("/org/users/:userId/current"), async ({ request }) => {
        seen = request.clone();
        body = await request.json();
        return HttpResponse.json(ONE_USER);
      }),
    );

    const res = await runCli(["users", "set-current", USER_ADA]);

    expect(res.exitCode).toBe(0);
    expect(seen?.method).toBe("PATCH");
    expect(new URL(seen?.url ?? "").pathname).toBe(`/api/v1/org/users/${USER_ADA}/current`);
    expect(body).toEqual({ is_current: true });
  });
});

describe("users invite, on the wire", () => {
  it("maps each flag onto its snake_case body field", async () => {
    let body: unknown;
    let seen: Request | undefined;
    server.use(
      http.post(apiUrl("/org/users/invite"), async ({ request }) => {
        seen = request.clone();
        body = await request.json();
        return HttpResponse.json(ONE_USER, { status: 201 });
      }),
    );

    await runCli([
      "users",
      "invite",
      "--email",
      "ada@example.com",
      "--given-name",
      "Ada",
      "--family-name",
      "Lovelace",
      "--role-id",
      ROLE_ADMIN,
    ]);

    expect(seen?.method).toBe("POST");
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/users/invite");
    // Exact, not a subset: an added field is as much a drift as a renamed one.
    expect(body).toEqual({
      email: "ada@example.com",
      given_name: "Ada",
      family_name: "Lovelace",
      role_id: ROLE_ADMIN,
      is_current: false,
    });
  });

  it("sends is_current true only when --is-current is passed", async () => {
    let body: unknown;
    server.use(
      http.post(apiUrl("/org/users/invite"), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(ONE_USER, { status: 201 });
      }),
    );

    await runCli([
      "users",
      "invite",
      "--email",
      "ada@example.com",
      "--given-name",
      "Ada",
      "--family-name",
      "Lovelace",
      "--role-id",
      ROLE_ADMIN,
      "--is-current",
    ]);

    expect(body).toMatchObject({ is_current: true });
  });

  it("sends the email verbatim rather than lowercasing it", async () => {
    let body: unknown;
    server.use(
      http.post(apiUrl("/org/users/invite"), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(ONE_USER, { status: 201 });
      }),
    );

    await runCli([
      "users",
      "invite",
      "--email",
      "Ada.Lovelace+ci@Example.COM",
      "--given-name",
      "Ada",
      "--family-name",
      "Lovelace",
      "--role-id",
      ROLE_ADMIN,
    ]);

    expect(body).toMatchObject({ email: "Ada.Lovelace+ci@Example.COM" });
  });
});

describe("users invite-existing, on the wire", () => {
  it("POSTs email, role_id and is_current to /org/users/invite/existing", async () => {
    let body: unknown;
    let seen: Request | undefined;
    server.use(
      http.post(apiUrl("/org/users/invite/existing"), async ({ request }) => {
        seen = request.clone();
        body = await request.json();
        return HttpResponse.json(ONE_USER, { status: 201 });
      }),
    );

    await runCli([
      "users",
      "invite-existing",
      "--email",
      "ada@example.com",
      "--role-id",
      ROLE_VIEWER,
    ]);

    expect(seen?.method).toBe("POST");
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/users/invite/existing");
    // No given_name or family_name: the user already exists, and sending empty
    // names here would overwrite the ones they have.
    expect(body).toEqual({
      email: "ada@example.com",
      role_id: ROLE_VIEWER,
      is_current: false,
    });
  });

  it("sends is_current true when --is-current is passed", async () => {
    let body: unknown;
    server.use(
      http.post(apiUrl("/org/users/invite/existing"), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(ONE_USER, { status: 201 });
      }),
    );

    await runCli([
      "users",
      "invite-existing",
      "--email",
      "ada@example.com",
      "--role-id",
      ROLE_VIEWER,
      "--is-current",
    ]);

    expect(body).toMatchObject({ is_current: true });
  });
});

describe("users list, on success", () => {
  it("wraps the bare array unmodified in the success envelope under --output json", async () => {
    server.use(http.get(apiUrl("/org/users"), () => HttpResponse.json(USERS)));

    const res = await runCli(["users", "list", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toEqual(USERS);
    expect(envelope(res).command).toBe("users list");
    expect(res.stderr).toBe("");
  });

  it("reports no page, because the endpoint sends no total to derive one from", async () => {
    // A full page may mean there are more. Inventing a page here would tell a
    // caller it had reached the end when it had not.
    server.use(http.get(apiUrl("/org/users"), () => HttpResponse.json(USERS)));

    const res = await runCli(["users", "list", "--output", "json"]);

    expect(envelope(res).page).toBeUndefined();
  });

  it("points a json caller at the group that has the emails and role names", async () => {
    server.use(http.get(apiUrl("/org/users"), () => HttpResponse.json(USERS)));

    const res = await runCli(["users", "list", "--output", "json"]);

    const commands = (envelope(res).next ?? []).map((step) => step.command);
    expect(commands).toContain("senso members list");
    expect(commands).toContain("senso roles list");
  });

  it("renders one row per membership under --output table, with no blank column", async () => {
    server.use(http.get(apiUrl("/org/users"), () => HttpResponse.json(USERS)));

    const res = await runCli(["users", "list", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    for (const column of ["user_id", "org_user_id", "role_id", "is_current", "created_at"]) {
      expect(res.stdout).toContain(column);
    }
    expect(res.stdout).toContain(ORG_USER_ADA);
    expect(res.stdout).toContain(ROLE_VIEWER);
    expect(res.stderr).not.toContain("did not return");
  });

  it("renders a readable block per membership by default", async () => {
    server.use(http.get(apiUrl("/org/users"), () => HttpResponse.json(USERS)));

    const res = await runCli(["users", "list"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain(USER_ADA);
    expect(res.stdout).toContain(ROLE_ADMIN);
  });

  it("says how to widen a page that came back empty", async () => {
    server.use(http.get(apiUrl("/org/users"), () => HttpResponse.json([])));

    const res = await runCli(["users", "list"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("No memberships found.");
    // The API pages at 10 by default, so "empty" is often "you skipped them".
    expect(res.stderr).toContain("--limit 100");
  });
});

describe("users get, on success", () => {
  it("prints the single object unmodified under --output json", async () => {
    server.use(http.get(apiUrl("/org/users/:userId"), () => HttpResponse.json(ONE_USER)));

    const res = await runCli(["users", "get", USER_ADA, "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toEqual(ONE_USER);
    expect(res.stderr).toBe("");
  });

  it("offers the update command with the id already substituted", async () => {
    server.use(http.get(apiUrl("/org/users/:userId"), () => HttpResponse.json(ONE_USER)));

    const res = await runCli(["users", "get", USER_ADA, "--output", "json"]);

    const commands = (envelope(res).next ?? []).map((step) => step.command);
    expect(commands.some((c) => c.includes(`senso users update ${USER_ADA}`))).toBe(true);
  });

  it("renders a single object as field/value rows under --output table", async () => {
    server.use(http.get(apiUrl("/org/users/:userId"), () => HttpResponse.json(ONE_USER)));

    const res = await runCli(["users", "get", USER_ADA, "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("field");
    expect(res.stdout).toContain("role_id");
  });

  it("renders key/value lines by default", async () => {
    server.use(http.get(apiUrl("/org/users/:userId"), () => HttpResponse.json(ONE_USER)));

    const res = await runCli(["users", "get", USER_ADA]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("role_id");
    expect(res.stdout).toContain(ROLE_ADMIN);
  });
});

describe("users update and set-current, on success", () => {
  it("names the role the membership now carries, on stderr", async () => {
    server.use(
      http.put(apiUrl("/org/users/:userId"), () =>
        HttpResponse.json({ ...ONE_USER, role_id: ROLE_VIEWER }),
      ),
    );

    const res = await runCli([
      "users",
      "update",
      USER_ADA,
      "--data",
      `{"role_id":"${ROLE_VIEWER}"}`,
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain(`role_id → ${ROLE_VIEWER}`);
    expect(res.stdout).toContain(ROLE_VIEWER);
    expect(res.stdout).not.toContain("Updated user");
  });

  it("returns the API's own membership record from set-current, not a synthetic one", async () => {
    // This was the one command in the group whose JSON was not the API's
    // payload: it discarded the response in favor of a confirmation object.
    server.use(http.patch(apiUrl("/org/users/:userId/current"), () => HttpResponse.json(ONE_USER)));

    const res = await runCli(["users", "set-current", USER_ADA, "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toEqual(ONE_USER);
    expect(res.stderr).toBe("");
  });

  it("confirms set-current on stderr and prints the membership on stdout", async () => {
    server.use(http.patch(apiUrl("/org/users/:userId/current"), () => HttpResponse.json(ONE_USER)));

    const res = await runCli(["users", "set-current", USER_ADA]);

    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain("current");
    expect(res.stdout).toContain("is_current");
    expect(res.stdout).not.toContain("Organization is now current");
  });
});

describe("users remove, confirming without a payload", () => {
  it("names what was removed rather than handing back a sentence to parse", async () => {
    server.use(
      http.delete(apiUrl("/org/users/:userId"), () => new HttpResponse(null, { status: 204 })),
    );

    const res = await runCli(["users", "remove", USER_ADA, "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toEqual({
      action: "removed",
      resource: "org_user",
      id: USER_ADA,
      user_id: USER_ADA,
    });
    expect(res.stderr).toBe("");
  });

  it("puts the ✓ on stderr and leaves stdout empty in plain mode", async () => {
    server.use(
      http.delete(apiUrl("/org/users/:userId"), () => new HttpResponse(null, { status: 204 })),
    );

    const res = await runCli(["users", "remove", USER_ADA]);

    expect(res.exitCode).toBe(0);
    // There is no payload here, so a caller piping this command gets nothing.
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain(`Removed user ${USER_ADA} from the organization.`);
  });
});

describe("users invite, on success", () => {
  it("puts the created membership on stdout and the tick on stderr", async () => {
    server.use(http.post(apiUrl("/org/users/invite"), () => HttpResponse.json(ONE_USER)));

    const res = await runCli([
      "users",
      "invite",
      "--email",
      "ada@example.com",
      "--given-name",
      "Ada",
      "--family-name",
      "Lovelace",
      "--role-id",
      ROLE_ADMIN,
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain(ORG_USER_ADA);
    expect(res.stderr).toContain("Invited ada@example.com");
    expect(res.stdout).not.toContain("Invited");
  });

  it("says where to find the person again, since the email is not echoed back", async () => {
    server.use(http.post(apiUrl("/org/users/invite"), () => HttpResponse.json(ONE_USER)));

    const res = await runCli([
      "users",
      "invite",
      "--email",
      "ada@example.com",
      "--given-name",
      "Ada",
      "--family-name",
      "Lovelace",
      "--role-id",
      ROLE_ADMIN,
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toEqual(ONE_USER);
    expect((envelope(res).next ?? []).map((s) => s.command)).toContain(
      "senso members list --search ada@example.com",
    );
    expect(res.stderr).toBe("");
  });
});
