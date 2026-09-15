/**
 * Command layer: `senso api-keys`.
 *
 * This group hands out credentials and narrows what they can reach, which makes
 * four properties worth more protection than the rendering of any one field.
 *
 * `create` returns the secret exactly once. It must reach stdout, it must be
 * announced as unrepeatable, and it must reach NOTHING else: not the success
 * line, not a warning, not the debug log. `senso api-keys create --output json >
 * key.json` has to write a key file, and the terminal the command ran in must
 * not keep a second copy of the secret in its scrollback.
 *
 * Scope is a closed set. A grant's role is viewer, editor or owner; `admin` reads
 * like a fourth level, is the org-admin bypass, is never stored, and used to
 * travel to the database and come back as a 500. An unaccepted role has to cost
 * exit 2 with the three real ones in `error.allowed`, before any request.
 *
 * `kb-permissions-set` REPLACES the whole scope, so a grant left out of the list
 * is a folder the key can no longer reach.
 *
 * And the key's id is not its secret. `SENSO_API_KEY` holds a secret and an agent
 * with one to hand will try it as the argument; the id is a UUID and the secret
 * is not, so that mistake exits 2 rather than 404.
 *
 * The fixtures are dto.APIKeyResponse and dto.APIKeyCreateResponse. They differ,
 * and the difference matters: the create response carries `key` and carries
 * neither `scoped` nor `revoked_at`, so a fixture that reused one shape for both
 * would hide a column that is blank for every row.
 *
 * Failure branches come first, as in tests/commands/roles.test.ts.
 */

import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../setup.js";
import { apiUrl, envelope, errorEnvelope, runCli } from "../helpers.js";

const ORG_ID = "b1e9f6c2-7f4a-4d2e-9a3b-1c5d7e9f0a2b";
const CI_ID = "c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f";
const LAPTOP_ID = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
const NODE_POLICIES = "3f2a1b0c-9d8e-4f7a-b6c5-d4e3f2a1b0c9";
const NODE_RATES = "d4e3f2a1-b0c9-4d8e-9f7a-6b5c4d3e2f1a";

/** The secret, which must appear on stdout and on no other stream. */
const SECRET = "tgr_test_xxxxxxxxxxxxxxxxxxxx";

/**
 * GET /org/api-keys: `{ items, total, limit, offset }` of dto.APIKeyResponse.
 *
 * Null timestamps are omitted rather than sent as null — no `last_used_at` key
 * means the key has never authenticated — so the second row leaves them out and
 * the first carries them. `revoked_at` is on one row only, which is what makes
 * the declared `revoked_at` column real.
 */
const KEYS = {
  items: [
    {
      id: CI_ID,
      organization_id: ORG_ID,
      name: "ci-deploy",
      scoped: false,
      expires_at: "2026-12-31T00:00:00Z",
      last_used_at: "2026-09-01T12:00:00Z",
      created_at: "2026-01-02T00:00:00Z",
      updated_at: "2026-01-02T00:00:00Z",
    },
    {
      id: LAPTOP_ID,
      organization_id: ORG_ID,
      name: "laptop",
      scoped: true,
      revoked_at: "2026-08-14T09:30:00Z",
      created_at: "2026-03-04T00:00:00Z",
      updated_at: "2026-08-14T09:30:00Z",
    },
  ],
  total: 2,
  limit: 10,
  offset: 0,
};

/** dto.APIKeyResponse — what get, update and list rows look like. No secret. */
const ONE_KEY = KEYS.items[0];

/**
 * dto.APIKeyCreateResponse, which is a DIFFERENT shape.
 *
 * It carries `key` and carries neither `scoped` nor `revoked_at` nor
 * `last_used_at`: a key that has just been created has never been used.
 */
const CREATED_KEY = {
  id: CI_ID,
  organization_id: ORG_ID,
  name: "ci-deploy",
  key: SECRET,
  expires_at: "2026-12-31T00:00:00Z",
  created_at: "2026-01-02T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
};

/** GET/PUT kb-permissions return a BARE ARRAY of dto.APIKeyScopeGrant. */
const GRANTS = [
  { node_id: NODE_POLICIES, role: "viewer" },
  { node_id: NODE_RATES, role: "editor" },
];

describe("api-keys, when the request fails", () => {
  it("exits 3 and explains how to authenticate when there is no API key", async () => {
    const res = await runCli(["api-keys", "list"], { withKey: false });

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("no API key found");
    expect(res.stderr).toContain("SENSO_API_KEY");
  });

  it("exits 3 when the API rejects the key", async () => {
    server.use(
      http.get(apiUrl("/org/api-keys"), () =>
        HttpResponse.json({ error: "invalid key" }, { status: 401 }),
      ),
    );

    const res = await runCli(["api-keys", "list"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Authentication failed");
  });

  it("says a 403 on create is a missing permission an admin can widen", async () => {
    // Every write here sits behind RequireJWTOnly, so this is the answer an API
    // key always gets — and the reason the help sends the caller to the dashboard.
    server.use(
      http.post(apiUrl("/org/api-keys"), () =>
        HttpResponse.json({ message: "This action requires user authentication" }, { status: 403 }),
      ),
    );

    const res = await runCli(["api-keys", "create", "--data", '{"name":"ci-deploy"}']);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Permission denied");
    expect(res.stderr).toContain("An org admin can widen it");
  });

  it("names the key and the list command on a 404", async () => {
    server.use(
      http.get(apiUrl("/org/api-keys/:keyId"), () => new HttpResponse(null, { status: 404 })),
    );

    const res = await runCli(["api-keys", "get", LAPTOP_ID, "--output", "json"]);

    expect(res.exitCode).toBe(4);
    expect(res.stdout).toBe("");

    const { error } = errorEnvelope(res);
    expect(error.code).toBe("not_found");
    expect(error.field).toBe("id");
    expect(error.received).toBe(LAPTOP_ID);
    expect(error.message).toContain(`API key ${LAPTOP_ID}`);
    expect(error.hint).toContain("senso api-keys list");
  });

  it("exits 1 on a 500 and offers a retry", async () => {
    server.use(http.get(apiUrl("/org/api-keys"), () => new HttpResponse(null, { status: 500 })));

    const res = await runCli(["api-keys", "list"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Retry shortly");
  });

  it("refuses to suggest a retry on a 503, which retrying cannot fix", async () => {
    server.use(
      http.get(apiUrl("/org/api-keys"), () =>
        HttpResponse.json({ message: "API key management is not enabled here" }, { status: 503 }),
      ),
    );

    const res = await runCli(["api-keys", "list"]);

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("not a transient failure");
    expect(res.stderr).not.toContain("Retry shortly");
  });

  it("leaves stdout empty on a failed create, so no key file is ever written", async () => {
    server.use(
      http.post(apiUrl("/org/api-keys"), () =>
        HttpResponse.json({ error: "nope" }, { status: 403 }),
      ),
    );

    const res = await runCli([
      "api-keys",
      "create",
      "--data",
      '{"name":"ci-deploy"}',
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(3);
    // A caller redirecting stdout to a file gets an empty file, never a file
    // holding an error object it would later read back as a key.
    expect(res.stdout).toBe("");

    const reported = errorEnvelope(res);
    expect(reported.ok).toBe(false);
    expect(reported.command).toBe("api-keys create");
    expect(reported.error).toMatchObject({
      code: "forbidden",
      status: 403,
      request: { method: "POST", path: "/org/api-keys" },
    });
  });
});

describe("api-keys, when the key id is wrong", () => {
  it("exits 2 before any request when the secret is passed instead of the id", async () => {
    // The mistake an agent with SENSO_API_KEY to hand actually makes. The id is
    // a UUID and the secret is not, so this never reaches the API.
    const res = await runCli(["api-keys", "get", SECRET, "--output", "json"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");

    const { error } = errorEnvelope(res);
    expect(error.code).toBe("usage");
    expect(error.field).toBe("<keyId>");
    expect(error.received).toBe(SECRET);
    expect(error.hint).toContain("senso api-keys list");
  });

  it("exits 2 on a malformed id for every command that takes one", async () => {
    for (const args of [
      ["api-keys", "get", "k-1"],
      ["api-keys", "update", "k-1", "--data", '{"name":"x"}'],
      ["api-keys", "delete", "k-1"],
      ["api-keys", "revoke", "k-1"],
      ["api-keys", "kb-permissions-get", "k-1"],
      ["api-keys", "kb-permissions-delete", "k-1"],
    ]) {
      const res = await runCli([...args, "--output", "json"]);
      expect(res.exitCode).toBe(2);
      expect(errorEnvelope(res).error.field).toBe("<keyId>");
    }
  });
});

describe("api-keys, when the command line is wrong", () => {
  it("exits 2 when create's --data is not valid JSON", async () => {
    const res = await runCli(["api-keys", "create", "--data", "{name: ci}"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Invalid JSON in --data");
  });

  it("exits 2 when update's --data is valid JSON but not an object", async () => {
    const res = await runCli(["api-keys", "update", CI_ID, "--data", "[1,2]"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("must be a JSON object");
  });

  it("names the accepted keys when create's --data carries an unknown one", async () => {
    const res = await runCli([
      "api-keys",
      "create",
      "--data",
      '{"name":"ci-deploy","scopes":["read"]}',
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    const { error } = errorEnvelope(res);
    expect(error.received).toBe("scopes");
    expect(error.allowed).toEqual(["name", "expires_at"]);
  });

  it("exits 2 when expires_at is a date a human typed rather than a timestamp", async () => {
    const res = await runCli([
      "api-keys",
      "create",
      "--data",
      '{"name":"ci-deploy","expires_at":"31/12/2026"}',
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    const { error } = errorEnvelope(res);
    expect(error.field).toBe("--data.expires_at");
    expect(error.received).toBe("31/12/2026");
  });

  it("names the valid formats when --output is not one of them", async () => {
    const res = await runCli(["api-keys", "list", "--output", "yaml"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("json, table, plain");
  });
});

describe("api-keys kb-permissions-set, when a scope is not one this API grants", () => {
  it("exits 2 with the three grantable roles in error.allowed", async () => {
    // `admin` is the org-admin bypass, is never stored, and the DB CHECK
    // constraint refuses it — it used to reach the database and return a 500.
    const res = await runCli([
      "api-keys",
      "kb-permissions-set",
      CI_ID,
      "--data",
      `{"grants":[{"node_id":"${NODE_POLICIES}","role":"admin"}]}`,
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");

    const { error } = errorEnvelope(res);
    expect(error.code).toBe("usage");
    expect(error.field).toBe("--data.grants[0].role");
    expect(error.received).toBe("admin");
    expect(error.allowed).toEqual(["viewer", "editor", "owner"]);
    expect(error.hint).toContain("not a grantable role");
  });

  it("names the offending grant by index when a later one is wrong", async () => {
    const res = await runCli([
      "api-keys",
      "kb-permissions-set",
      CI_ID,
      "--data",
      `{"grants":[{"node_id":"${NODE_POLICIES}","role":"viewer"},{"node_id":"${NODE_RATES}","role":"reader"}]}`,
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    const { error } = errorEnvelope(res);
    expect(error.field).toBe("--data.grants[1].role");
    expect(error.allowed).toEqual(["viewer", "editor", "owner"]);
  });

  it("exits 2 when a grant's node_id is not a kb_node_id", async () => {
    const res = await runCli([
      "api-keys",
      "kb-permissions-set",
      CI_ID,
      "--data",
      '{"grants":[{"node_id":"policies","role":"viewer"}]}',
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    const { error } = errorEnvelope(res);
    expect(error.field).toBe("--data.grants[0].node_id");
    expect(error.hint).toContain("senso kb my-files");
  });

  it("exits 2 on a grant key the API would silently drop", async () => {
    const res = await runCli([
      "api-keys",
      "kb-permissions-set",
      CI_ID,
      "--data",
      `{"grants":[{"node_id":"${NODE_POLICIES}","role":"viewer","recursive":true}]}`,
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    const { error } = errorEnvelope(res);
    expect(error.field).toBe("--data.grants[0].recursive");
    expect(error.allowed).toEqual(["node_id", "role"]);
  });

  it("exits 2 on an empty grants list, and says which command clears a scope", async () => {
    // The API refuses an empty list, and "clear the scope" is a different
    // command — one that WIDENS the key's access.
    const res = await runCli([
      "api-keys",
      "kb-permissions-set",
      CI_ID,
      "--data",
      '{"grants":[]}',
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    const { error } = errorEnvelope(res);
    expect(error.field).toBe("--data.grants");
    expect(error.hint).toContain("senso api-keys kb-permissions-delete");
  });

  it("exits 2 when --data has no grants key at all", async () => {
    const res = await runCli([
      "api-keys",
      "kb-permissions-set",
      CI_ID,
      "--data",
      '{"node_id":"x"}',
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    expect(errorEnvelope(res).error.message).toContain("grants");
  });

  it("exits 2 when kb-permissions-set's --data is not valid JSON", async () => {
    const res = await runCli(["api-keys", "kb-permissions-set", CI_ID, "--data", "not json"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Invalid JSON in --data");
  });
});

describe("api-keys list, on the wire", () => {
  it("GETs /org/api-keys with no query when neither page flag is given", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/api-keys"), ({ request }) => {
        seen = request;
        return HttpResponse.json(KEYS);
      }),
    );

    await runCli(["api-keys", "list"]);

    expect(seen?.method).toBe("GET");
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/api-keys");
    expect(new URL(seen?.url ?? "").search).toBe("");
  });

  it("passes --limit and --offset through as limit and offset", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/api-keys"), ({ request }) => {
        seen = request;
        return HttpResponse.json(KEYS);
      }),
    );

    await runCli(["api-keys", "list", "--limit", "5", "--offset", "10"]);

    const params = new URL(seen?.url ?? "").searchParams;
    expect(params.get("limit")).toBe("5");
    expect(params.get("offset")).toBe("10");
  });
});

describe("api-keys create, get, update, delete and revoke, on the wire", () => {
  it("POSTs the parsed --data object to /org/api-keys unchanged", async () => {
    let body: unknown;
    let seen: Request | undefined;
    server.use(
      http.post(apiUrl("/org/api-keys"), async ({ request }) => {
        seen = request.clone();
        body = await request.json();
        return HttpResponse.json(CREATED_KEY, { status: 201 });
      }),
    );

    await runCli([
      "api-keys",
      "create",
      "--data",
      '{"name":"ci-deploy","expires_at":"2026-12-31T00:00:00Z"}',
    ]);

    expect(seen?.method).toBe("POST");
    expect(seen?.headers.get("content-type")).toBe("application/json");
    expect(body).toEqual({ name: "ci-deploy", expires_at: "2026-12-31T00:00:00Z" });
  });

  it("GETs /org/api-keys/<keyId>", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/api-keys/:keyId"), ({ request }) => {
        seen = request;
        return HttpResponse.json(ONE_KEY);
      }),
    );

    await runCli(["api-keys", "get", CI_ID]);

    expect(seen?.method).toBe("GET");
    expect(new URL(seen?.url ?? "").pathname).toBe(`/api/v1/org/api-keys/${CI_ID}`);
  });

  it("PUTs the parsed --data object to /org/api-keys/<keyId>", async () => {
    let body: unknown;
    let seen: Request | undefined;
    server.use(
      http.put(apiUrl("/org/api-keys/:keyId"), async ({ request }) => {
        seen = request.clone();
        body = await request.json();
        return HttpResponse.json({ ...ONE_KEY, name: "ci-deploy-2" });
      }),
    );

    await runCli(["api-keys", "update", CI_ID, "--data", '{"name":"ci-deploy-2"}']);

    expect(seen?.method).toBe("PUT");
    expect(new URL(seen?.url ?? "").pathname).toBe(`/api/v1/org/api-keys/${CI_ID}`);
    expect(body).toEqual({ name: "ci-deploy-2" });
  });

  it("DELETEs /org/api-keys/<keyId> with no body", async () => {
    let seen: Request | undefined;
    server.use(
      http.delete(apiUrl("/org/api-keys/:keyId"), ({ request }) => {
        seen = request;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const res = await runCli(["api-keys", "delete", CI_ID]);

    expect(res.exitCode).toBe(0);
    expect(seen?.method).toBe("DELETE");
    expect(new URL(seen?.url ?? "").pathname).toBe(`/api/v1/org/api-keys/${CI_ID}`);
    expect(seen?.headers.get("content-type")).toBeNull();
  });

  it("POSTs to /org/api-keys/<keyId>/revoke", async () => {
    let seen: Request | undefined;
    server.use(
      http.post(apiUrl("/org/api-keys/:keyId/revoke"), ({ request }) => {
        seen = request;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const res = await runCli(["api-keys", "revoke", LAPTOP_ID]);

    expect(res.exitCode).toBe(0);
    expect(seen?.method).toBe("POST");
    expect(new URL(seen?.url ?? "").pathname).toBe(`/api/v1/org/api-keys/${LAPTOP_ID}/revoke`);
  });
});

describe("api-keys kb-permissions, on the wire", () => {
  it("GETs the grants from /org/api-keys/<keyId>/kb-permissions", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/api-keys/:keyId/kb-permissions"), ({ request }) => {
        seen = request;
        return HttpResponse.json(GRANTS);
      }),
    );

    const res = await runCli(["api-keys", "kb-permissions-get", CI_ID]);

    expect(res.exitCode).toBe(0);
    expect(seen?.method).toBe("GET");
    expect(new URL(seen?.url ?? "").pathname).toBe(
      `/api/v1/org/api-keys/${CI_ID}/kb-permissions`,
    );
  });

  it("PUTs the grants array verbatim, keeping node_id and role", async () => {
    let body: unknown;
    let seen: Request | undefined;
    server.use(
      http.put(apiUrl("/org/api-keys/:keyId/kb-permissions"), async ({ request }) => {
        seen = request.clone();
        body = await request.json();
        return HttpResponse.json([{ node_id: NODE_POLICIES, role: "editor" }]);
      }),
    );

    await runCli([
      "api-keys",
      "kb-permissions-set",
      CI_ID,
      "--data",
      `{"grants":[{"node_id":"${NODE_POLICIES}","role":"editor"}]}`,
    ]);

    expect(seen?.method).toBe("PUT");
    expect(body).toEqual({ grants: [{ node_id: NODE_POLICIES, role: "editor" }] });
  });

  it("DELETEs /org/api-keys/<keyId>/kb-permissions to restore org-level access", async () => {
    let seen: Request | undefined;
    server.use(
      http.delete(apiUrl("/org/api-keys/:keyId/kb-permissions"), ({ request }) => {
        seen = request;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const res = await runCli(["api-keys", "kb-permissions-delete", CI_ID]);

    expect(res.exitCode).toBe(0);
    expect(seen?.method).toBe("DELETE");
    expect(new URL(seen?.url ?? "").pathname).toBe(
      `/api/v1/org/api-keys/${CI_ID}/kb-permissions`,
    );
  });
});

describe("api-keys create, on the secret it shows once", () => {
  it("says the secret will never be shown again", async () => {
    server.use(http.post(apiUrl("/org/api-keys"), () => HttpResponse.json(CREATED_KEY)));

    const res = await runCli(["api-keys", "create", "--data", '{"name":"ci-deploy"}']);

    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain("shown once");
    expect(res.stderr).toContain("never returned again");
  });

  it("carries that warning in the envelope, where a json caller can see it", async () => {
    // --output json implies --quiet, so a warning written only to stderr would
    // reach nobody — and json is what every published Senso skill passes.
    server.use(http.post(apiUrl("/org/api-keys"), () => HttpResponse.json(CREATED_KEY)));

    const res = await runCli([
      "api-keys",
      "create",
      "--data",
      '{"name":"ci-deploy"}',
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(0);
    const warnings = envelope(res).warnings ?? [];
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("shown once");
    expect(warnings[0]).toContain("never returned again");
  });

  it("puts the secret on stdout and NOWHERE else", async () => {
    // The whole point of the command. A secret echoed into a log line or a
    // warning leaves a second copy in the terminal's scrollback, in CI output,
    // and in whatever collects it.
    server.use(http.post(apiUrl("/org/api-keys"), () => HttpResponse.json(CREATED_KEY)));

    const res = await runCli(["api-keys", "create", "--data", '{"name":"ci-deploy"}']);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain(SECRET);
    expect(res.stderr).not.toContain(SECRET);
  });

  it("keeps the secret off stderr under --output json too", async () => {
    server.use(http.post(apiUrl("/org/api-keys"), () => HttpResponse.json(CREATED_KEY)));

    const res = await runCli([
      "api-keys",
      "create",
      "--data",
      '{"name":"ci-deploy"}',
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.data<{ key: string }>().key).toBe(SECRET);
    expect(res.stderr).toBe("");
  });

  it("keeps the secret out of the debug log, which records method, URL and status only", async () => {
    server.use(http.post(apiUrl("/org/api-keys"), () => HttpResponse.json(CREATED_KEY)));
    process.env.SENSO_DEBUG = "1";
    try {
      const res = await runCli(["api-keys", "create", "--data", '{"name":"ci-deploy"}']);

      expect(res.exitCode).toBe(0);
      // The debug channel really is on, so the assertion below is a real one.
      expect(res.stderr).toContain("POST https://api.test.invalid/api/v1/org/api-keys");
      expect(res.stdout).toContain(SECRET);
      expect(res.stderr).not.toContain(SECRET);
    } finally {
      delete process.env.SENSO_DEBUG;
    }
  });

  it("names the key it created on stderr, without repeating the secret", async () => {
    server.use(http.post(apiUrl("/org/api-keys"), () => HttpResponse.json(CREATED_KEY)));

    const res = await runCli(["api-keys", "create", "--data", '{"name":"ci-deploy"}']);

    expect(res.stderr).toContain("Created API key ci-deploy");
    expect(res.stderr).toContain(CI_ID);
    expect(res.stdout).not.toContain("Created API key");
  });

  it("wraps the create response unmodified, keeping the shape jq is pointed at", async () => {
    server.use(http.post(apiUrl("/org/api-keys"), () => HttpResponse.json(CREATED_KEY)));

    const res = await runCli([
      "api-keys",
      "create",
      "--data",
      '{"name":"ci-deploy"}',
      "--output",
      "json",
    ]);

    expect(res.data()).toEqual(CREATED_KEY);
    expect(envelope(res).command).toBe("api-keys create");
  });

  it("offers the scoping command with the new key's id already substituted", async () => {
    server.use(http.post(apiUrl("/org/api-keys"), () => HttpResponse.json(CREATED_KEY)));

    const res = await runCli([
      "api-keys",
      "create",
      "--data",
      '{"name":"ci-deploy"}',
      "--output",
      "json",
    ]);

    const commands = (envelope(res).next ?? []).map((step) => step.command);
    expect(commands.some((c) => c.includes(`senso api-keys kb-permissions-set ${CI_ID}`))).toBe(
      true,
    );
  });
});

describe("api-keys list and get, on success", () => {
  it("wraps the payload unmodified in the success envelope under --output json", async () => {
    server.use(http.get(apiUrl("/org/api-keys"), () => HttpResponse.json(KEYS)));

    const res = await runCli(["api-keys", "list", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toEqual(KEYS);
    expect(envelope(res).page).toMatchObject({ offset: 0, limit: 10, returned: 2, total: 2 });
    expect(res.stderr).toBe("");
  });

  it("shows revoked_at under --output table, so a dead key is not mistaken for a live one", async () => {
    server.use(http.get(apiUrl("/org/api-keys"), () => HttpResponse.json(KEYS)));

    const res = await runCli(["api-keys", "list", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    for (const column of ["id", "name", "scoped", "revoked_at", "expires_at", "last_used_at"]) {
      expect(res.stdout).toContain(column);
    }
    expect(res.stdout).toContain("ci-deploy");
    expect(res.stdout).toContain("2026-08-14T09:30:00Z");
    // Every declared column exists on at least one row, so nothing is blank.
    expect(res.stderr).not.toContain("did not return");
  });

  it("renders a readable block per key by default", async () => {
    server.use(http.get(apiUrl("/org/api-keys"), () => HttpResponse.json(KEYS)));

    const res = await runCli(["api-keys", "list"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain(CI_ID);
    expect(res.stdout).toContain("laptop");
  });

  it("says where keys are created when the organization has none", async () => {
    server.use(
      http.get(apiUrl("/org/api-keys"), () =>
        HttpResponse.json({ items: [], total: 0, limit: 10, offset: 0 }),
      ),
    );

    const res = await runCli(["api-keys", "list"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("No API keys found.");
    expect(res.stderr).toContain("app.senso.ai");
  });

  it("prints the single key unmodified under --output json, with no secret in it", async () => {
    server.use(http.get(apiUrl("/org/api-keys/:keyId"), () => HttpResponse.json(ONE_KEY)));

    const res = await runCli(["api-keys", "get", CI_ID, "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toEqual(ONE_KEY);
    expect(res.stdout).not.toContain(SECRET);
    expect(res.stderr).toBe("");
  });

  it("renders a single key as field/value rows under --output table", async () => {
    server.use(http.get(apiUrl("/org/api-keys/:keyId"), () => HttpResponse.json(ONE_KEY)));

    const res = await runCli(["api-keys", "get", CI_ID, "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("field");
    expect(res.stdout).toContain("value");
    expect(res.stdout).toContain(CI_ID);
  });

  it("adapts the next step to whether the key is scoped", async () => {
    server.use(
      http.get(apiUrl("/org/api-keys/:keyId"), () =>
        HttpResponse.json({ ...ONE_KEY, scoped: true }),
      ),
    );

    const res = await runCli(["api-keys", "get", CI_ID, "--output", "json"]);

    const steps = envelope(res).next ?? [];
    expect(steps[0]?.why).toContain("which knowledge base folders");
    expect(steps[0]?.command).toBe(`senso api-keys kb-permissions-get ${CI_ID}`);
  });
});

describe("api-keys kb-permissions, on success", () => {
  it("prints the grants under --output table without a blank column", async () => {
    server.use(
      http.get(apiUrl("/org/api-keys/:keyId/kb-permissions"), () => HttpResponse.json(GRANTS)),
    );

    const res = await runCli(["api-keys", "kb-permissions-get", CI_ID, "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("node_id");
    expect(res.stdout).toContain("role");
    expect(res.stdout).toContain("viewer");
    expect(res.stderr).not.toContain("did not return");
  });

  it("says an empty scope may also mean no key has that id", async () => {
    // This endpoint does not 404: an unknown key id and an unscoped key are the
    // same empty array, so the hint has to name both.
    server.use(
      http.get(apiUrl("/org/api-keys/:keyId/kb-permissions"), () => HttpResponse.json([])),
    );

    const res = await runCli(["api-keys", "kb-permissions-get", CI_ID]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("No KB grants found.");
    expect(res.stderr).toContain("full organization access");
    expect(res.stderr).toContain(`senso api-keys get ${CI_ID}`);
  });

  it("warns that the grants sent replaced the key's whole scope", async () => {
    // Anything left out of the list is a folder the key can no longer reach,
    // and the API answers 200 with the shortened list.
    server.use(
      http.put(apiUrl("/org/api-keys/:keyId/kb-permissions"), () =>
        HttpResponse.json([{ node_id: NODE_POLICIES, role: "viewer" }]),
      ),
    );

    const res = await runCli([
      "api-keys",
      "kb-permissions-set",
      CI_ID,
      "--data",
      `{"grants":[{"node_id":"${NODE_POLICIES}","role":"viewer"}]}`,
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(0);
    expect(envelope(res).warnings?.[0]).toContain("replaced the key's whole scope");
    expect(res.stderr).toBe("");
  });

  it("warns that clearing the scope WIDENS the key", async () => {
    server.use(
      http.delete(
        apiUrl("/org/api-keys/:keyId/kb-permissions"),
        () => new HttpResponse(null, { status: 204 }),
      ),
    );

    const res = await runCli(["api-keys", "kb-permissions-delete", CI_ID]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("now unscoped");
    expect(res.stderr).toContain("whole knowledge base");
  });
});

describe("api-keys delete and revoke, confirming without a payload", () => {
  it("names what was deleted rather than handing back a sentence to parse", async () => {
    server.use(
      http.delete(apiUrl("/org/api-keys/:keyId"), () => new HttpResponse(null, { status: 204 })),
    );

    const res = await runCli(["api-keys", "delete", CI_ID, "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toEqual({ action: "deleted", resource: "api_key", id: CI_ID });
    expect(res.stderr).toBe("");
  });

  it("puts the ✓ on stderr and leaves stdout empty in plain mode", async () => {
    server.use(
      http.delete(apiUrl("/org/api-keys/:keyId"), () => new HttpResponse(null, { status: 204 })),
    );

    const res = await runCli(["api-keys", "delete", CI_ID]);

    expect(res.exitCode).toBe(0);
    // There is no payload here, so a caller piping this command gets nothing.
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain(`API key ${CI_ID} deleted.`);
  });

  it("distinguishes a revoke from a delete in the confirmation object", async () => {
    server.use(
      http.post(
        apiUrl("/org/api-keys/:keyId/revoke"),
        () => new HttpResponse(null, { status: 204 }),
      ),
    );

    const res = await runCli(["api-keys", "revoke", LAPTOP_ID, "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toEqual({ action: "revoked", resource: "api_key", id: LAPTOP_ID });
  });

  it("confirms a kb-permissions delete as its own resource, not the key itself", async () => {
    server.use(
      http.delete(
        apiUrl("/org/api-keys/:keyId/kb-permissions"),
        () => new HttpResponse(null, { status: 204 }),
      ),
    );

    const res = await runCli(["api-keys", "kb-permissions-delete", CI_ID, "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toEqual({
      action: "deleted",
      resource: "api_key_kb_scope",
      id: CI_ID,
    });
  });
});
