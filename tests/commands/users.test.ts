/**
 * Command layer: `senso users`.
 *
 * Most of this group forwards a `--data` blob the caller wrote, so the CLI
 * cannot get the field names wrong. Two commands are the exception, and they
 * are why this file exists: `invite` and `invite-existing` build the request
 * body themselves out of individual flags. `--given-name` becomes `given_name`,
 * `--role-id` becomes `role_id`, and an absent `--is-current` becomes an
 * explicit `false` rather than a missing key.
 *
 * That mapping is invisible from the command line and unverifiable from the
 * response, so the assertions on the body below are the only thing standing
 * between a renamed API parameter and a user watching `senso users invite`
 * return 400 with nothing to grep. They assert the exact object, not a subset,
 * on purpose: an extra field is as much a drift as a missing one.
 *
 * `set-current` is the third body the CLI writes, and the smallest — one field.
 *
 * Failure branches come first, as in tests/commands/roles.test.ts.
 */

import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../setup.js";
import { apiUrl, runCli } from "../helpers.js";

const USERS = {
  users: [
    {
      org_user_id: "ou-1",
      user_id: "u-1",
      role_id: "r-admin",
      is_current: true,
      created_at: "2026-01-05T00:00:00Z",
    },
    {
      org_user_id: "ou-2",
      user_id: "u-2",
      role_id: "r-view",
      is_current: false,
      created_at: "2026-02-05T00:00:00Z",
    },
  ],
};

const ONE_USER = {
  org_user_id: "ou-1",
  user_id: "u-1",
  role_id: "r-admin",
  email: "ada@example.com",
  is_current: true,
};

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

  it("exits 3 when the key may not manage members", async () => {
    server.use(
      http.get(apiUrl("/org/users"), () =>
        HttpResponse.json({ error: "members:write required" }, { status: 403 }),
      ),
    );

    const res = await runCli(["users", "list"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Permission denied");
  });

  it("exits 4 when invite-existing finds no user with that email", async () => {
    // The documented failure for this command: the email belongs to nobody, and
    // the answer is `users invite` instead.
    server.use(
      http.post(apiUrl("/org/users/invite/existing"), () =>
        HttpResponse.json({ error: "user not found" }, { status: 404 }),
      ),
    );

    const res = await runCli([
      "users",
      "invite-existing",
      "--email",
      "nobody@example.com",
      "--role-id",
      "r-view",
    ]);

    expect(res.exitCode).toBe(4);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Not found");
  });

  it("exits 1 on a 500 and says it is not the caller's fault", async () => {
    server.use(http.get(apiUrl("/org/users"), () => new HttpResponse(null, { status: 502 })));

    const res = await runCli(["users", "list"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("not your fault");
  });

  it("writes the failure to stderr as JSON, leaving stdout empty, under --output json", async () => {
    server.use(
      http.get(apiUrl("/org/users"), () => HttpResponse.json({ error: "nope" }, { status: 403 })),
    );

    const res = await runCli(["users", "list", "--output", "json"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");

    const reported: unknown = JSON.parse(res.stderr);
    expect(reported).toMatchObject({ error: { code: "forbidden", status: 403 } });
  });
});

describe("users, when the command line is wrong", () => {
  it("exits 2 when add's --data is not valid JSON", async () => {
    const res = await runCli(["users", "add", "--data", "{user_id: u-1}"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Invalid JSON in --data");
  });

  it("exits 2 when update's --data parses to something that is not an object", async () => {
    const res = await runCli(["users", "update", "u-1", "--data", '"r-admin"']);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("must be a JSON object");
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
    expect(new URL(seen!.url).pathname).toBe("/api/v1/org/users");
    expect(new URL(seen!.url).search).toBe("");
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

    const params = new URL(seen!.url).searchParams;
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
        seen = request;
        body = await request.json();
        return HttpResponse.json(ONE_USER, { status: 201 });
      }),
    );

    await runCli([
      "users",
      "add",
      "--data",
      '{"user_id":"u-9","role_id":"r-view","is_current":false}',
    ]);

    expect(seen?.method).toBe("POST");
    expect(body).toEqual({ user_id: "u-9", role_id: "r-view", is_current: false });
  });

  it("GETs /org/users/<userId>", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/users/:userId"), ({ request }) => {
        seen = request;
        return HttpResponse.json(ONE_USER);
      }),
    );

    await runCli(["users", "get", "u-1"]);

    expect(seen?.method).toBe("GET");
    expect(new URL(seen!.url).pathname).toBe("/api/v1/org/users/u-1");
  });

  it("PUTs the parsed --data object to /org/users/<userId>", async () => {
    let body: unknown;
    let seen: Request | undefined;
    server.use(
      http.put(apiUrl("/org/users/:userId"), async ({ request }) => {
        seen = request;
        body = await request.json();
        return HttpResponse.json({ ...ONE_USER, role_id: "r-view" });
      }),
    );

    await runCli(["users", "update", "u-1", "--data", '{"role_id":"r-view"}']);

    expect(seen?.method).toBe("PUT");
    expect(new URL(seen!.url).pathname).toBe("/api/v1/org/users/u-1");
    expect(body).toEqual({ role_id: "r-view" });
  });

  it("DELETEs /org/users/<userId> with no body", async () => {
    let seen: Request | undefined;
    server.use(
      http.delete(apiUrl("/org/users/:userId"), ({ request }) => {
        seen = request;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const res = await runCli(["users", "remove", "u-1"]);

    expect(res.exitCode).toBe(0);
    expect(seen?.method).toBe("DELETE");
    expect(new URL(seen!.url).pathname).toBe("/api/v1/org/users/u-1");
    expect(seen?.headers.get("content-type")).toBeNull();
  });
});

describe("users set-current, on the wire", () => {
  it("PATCHes /org/users/<userId>/current with is_current true", async () => {
    let body: unknown;
    let seen: Request | undefined;
    server.use(
      http.patch(apiUrl("/org/users/:userId/current"), async ({ request }) => {
        seen = request;
        body = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const res = await runCli(["users", "set-current", "u-1"]);

    expect(res.exitCode).toBe(0);
    expect(seen?.method).toBe("PATCH");
    expect(new URL(seen!.url).pathname).toBe("/api/v1/org/users/u-1/current");
    expect(body).toEqual({ is_current: true });
  });
});

describe("users invite, on the wire", () => {
  it("maps each flag onto its snake_case body field", async () => {
    let body: unknown;
    let seen: Request | undefined;
    server.use(
      http.post(apiUrl("/org/users/invite"), async ({ request }) => {
        seen = request;
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
      "r-admin",
    ]);

    expect(seen?.method).toBe("POST");
    expect(new URL(seen!.url).pathname).toBe("/api/v1/org/users/invite");
    // Exact, not a subset: an added field is as much a drift as a renamed one.
    expect(body).toEqual({
      email: "ada@example.com",
      given_name: "Ada",
      family_name: "Lovelace",
      role_id: "r-admin",
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
      "r-admin",
      "--is-current",
    ]);

    expect(body).toMatchObject({ is_current: true });
  });

  it("sends the email verbatim rather than lowercasing or trimming it", async () => {
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
      "r-admin",
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
        seen = request;
        body = await request.json();
        return HttpResponse.json(ONE_USER, { status: 201 });
      }),
    );

    await runCli(["users", "invite-existing", "--email", "ada@example.com", "--role-id", "r-view"]);

    expect(seen?.method).toBe("POST");
    expect(new URL(seen!.url).pathname).toBe("/api/v1/org/users/invite/existing");
    // No given_name or family_name: the user already exists, and sending empty
    // names here would overwrite the ones they have.
    expect(body).toEqual({
      email: "ada@example.com",
      role_id: "r-view",
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
      "r-view",
      "--is-current",
    ]);

    expect(body).toMatchObject({ is_current: true });
  });
});

describe("users list, on success", () => {
  it("prints the payload unmodified under --output json", async () => {
    server.use(http.get(apiUrl("/org/users"), () => HttpResponse.json(USERS)));

    const res = await runCli(["users", "list", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.json()).toEqual(USERS);
    expect(res.stderr).toBe("");
  });

  it("renders one row per user under --output table", async () => {
    server.use(http.get(apiUrl("/org/users"), () => HttpResponse.json(USERS)));

    const res = await runCli(["users", "list", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("org_user_id");
    expect(res.stdout).toContain("ou-1");
    expect(res.stdout).toContain("r-view");
  });

  it("renders a readable block per user by default", async () => {
    server.use(http.get(apiUrl("/org/users"), () => HttpResponse.json(USERS)));

    const res = await runCli(["users", "list"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("u-1");
    expect(res.stdout).toContain("r-admin");
  });
});

describe("users get, on success", () => {
  it("prints the single object unmodified under --output json", async () => {
    server.use(http.get(apiUrl("/org/users/:userId"), () => HttpResponse.json(ONE_USER)));

    const res = await runCli(["users", "get", "u-1", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.json()).toEqual(ONE_USER);
    expect(res.stderr).toBe("");
  });

  it("renders a single object as field/value rows under --output table", async () => {
    server.use(http.get(apiUrl("/org/users/:userId"), () => HttpResponse.json(ONE_USER)));

    const res = await runCli(["users", "get", "u-1", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("field");
    expect(res.stdout).toContain("ada@example.com");
  });

  it("renders key/value lines by default", async () => {
    server.use(http.get(apiUrl("/org/users/:userId"), () => HttpResponse.json(ONE_USER)));

    const res = await runCli(["users", "get", "u-1"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("role_id");
    expect(res.stdout).toContain("r-admin");
  });
});

describe("users remove and set-current, confirming without a payload", () => {
  it("prints a parseable object on stdout when removing under --output json", async () => {
    server.use(
      http.delete(apiUrl("/org/users/:userId"), () => new HttpResponse(null, { status: 204 })),
    );

    const res = await runCli(["users", "remove", "u-1", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.json()).toMatchObject({ ok: true });
    expect(res.stderr).toBe("");
  });

  it("puts the ✓ on stderr and leaves stdout empty in plain mode", async () => {
    server.use(
      http.delete(apiUrl("/org/users/:userId"), () => new HttpResponse(null, { status: 204 })),
    );

    const res = await runCli(["users", "remove", "u-1"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("User u-1 removed.");
  });

  it("confirms set-current on stderr, not stdout", async () => {
    server.use(
      http.patch(
        apiUrl("/org/users/:userId/current"),
        () => new HttpResponse(null, { status: 204 }),
      ),
    );

    const res = await runCli(["users", "set-current", "u-1"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("current");
  });
});

describe("users invite, on success", () => {
  it("puts the created user on stdout and the tick on stderr", async () => {
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
      "r-admin",
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("ou-1");
    expect(res.stderr).toContain("Invited ada@example.com");
    expect(res.stdout).not.toContain("Invited");
  });

  it("emits only the payload under --output json", async () => {
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
      "r-admin",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.json()).toEqual(ONE_USER);
    expect(res.stderr).toBe("");
  });
});
