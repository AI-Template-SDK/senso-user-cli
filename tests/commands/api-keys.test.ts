/**
 * Command layer: `senso api-keys`.
 *
 * This group hands out credentials, which makes two of its properties worth
 * more protection than the rendering of any one field:
 *
 *   - `create` returns the secret exactly once. It must reach stdout, and it
 *     must reach stdout alone — the success tick that accompanies it is a
 *     stderr diagnostic, so `senso api-keys create --output json > key.json`
 *     writes a key file rather than a key file with a ✓ in it.
 *   - `delete`, `revoke` and `kb-permissions-delete` are 204s with no payload.
 *     They go through `emitConfirmation`, which owes a JSON caller a parseable
 *     object and a human a tick on stderr.
 *
 * Everything else here is the wire contract: nine subcommands, nine methods and
 * paths, so a renamed route or a moved path parameter fails in this file rather
 * than the first time somebody rotates a key.
 *
 * Failure branches come first, as in tests/commands/roles.test.ts.
 */

import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../setup.js";
import { apiUrl, runCli } from "../helpers.js";

const KEYS = {
  api_keys: [
    {
      id: "k-1",
      name: "ci",
      scoped: false,
      expires_at: "2026-12-31T00:00:00Z",
      last_used_at: "2026-09-01T12:00:00Z",
    },
    {
      id: "k-2",
      name: "laptop",
      scoped: true,
      expires_at: null,
      last_used_at: null,
    },
  ],
};

const ONE_KEY = { id: "k-1", name: "ci", scoped: false, key: "tgr_live_secret_shown_once" };

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

  it("exits 3 when the key is valid but lacks the scope", async () => {
    server.use(
      http.get(apiUrl("/org/api-keys"), () =>
        HttpResponse.json({ error: "not permitted" }, { status: 403 }),
      ),
    );

    const res = await runCli(["api-keys", "list"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Permission denied");
  });

  it("exits 4 when the key id does not exist", async () => {
    server.use(
      http.get(apiUrl("/org/api-keys/:keyId"), () => new HttpResponse(null, { status: 404 })),
    );

    const res = await runCli(["api-keys", "get", "k-missing"]);

    expect(res.exitCode).toBe(4);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Not found");
  });

  it("exits 1 on a 500 and says it is not the caller's fault", async () => {
    server.use(http.get(apiUrl("/org/api-keys"), () => new HttpResponse(null, { status: 500 })));

    const res = await runCli(["api-keys", "list"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("not your fault");
  });

  it("writes the failure to stderr as JSON, leaving stdout empty, under --output json", async () => {
    server.use(
      http.post(apiUrl("/org/api-keys"), () =>
        HttpResponse.json({ error: "nope" }, { status: 403 }),
      ),
    );

    const res = await runCli(["api-keys", "create", "--data", '{"name":"ci"}', "--output", "json"]);

    expect(res.exitCode).toBe(3);
    // A caller redirecting stdout to a file gets an empty file, never a file
    // holding an error object it would later read back as a key.
    expect(res.stdout).toBe("");

    const reported: unknown = JSON.parse(res.stderr);
    expect(reported).toMatchObject({ error: { code: "forbidden", status: 403 } });
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
    const res = await runCli(["api-keys", "update", "k-1", "--data", "[1,2]"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("must be a JSON object");
  });

  it("exits 2 when kb-permissions-set's --data is not valid JSON", async () => {
    const res = await runCli(["api-keys", "kb-permissions-set", "k-1", "--data", "not json"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Invalid JSON in --data");
  });

  it("names the valid formats when --output is not one of them", async () => {
    const res = await runCli(["api-keys", "list", "--output", "yaml"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("json, table, plain");
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
    expect(new URL(seen!.url).pathname).toBe("/api/v1/org/api-keys");
    expect(new URL(seen!.url).search).toBe("");
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

    const params = new URL(seen!.url).searchParams;
    expect(params.get("limit")).toBe("5");
    expect(params.get("offset")).toBe("10");
  });
});

describe("api-keys create, on the wire", () => {
  it("POSTs the parsed --data object to /org/api-keys unchanged", async () => {
    let body: unknown;
    let seen: Request | undefined;
    server.use(
      http.post(apiUrl("/org/api-keys"), async ({ request }) => {
        seen = request;
        body = await request.json();
        return HttpResponse.json(ONE_KEY, { status: 201 });
      }),
    );

    await runCli([
      "api-keys",
      "create",
      "--data",
      '{"name":"ci","expires_at":"2026-12-31T00:00:00Z"}',
    ]);

    expect(seen?.method).toBe("POST");
    expect(seen?.headers.get("content-type")).toBe("application/json");
    expect(body).toEqual({ name: "ci", expires_at: "2026-12-31T00:00:00Z" });
  });
});

describe("api-keys get, on the wire", () => {
  it("GETs /org/api-keys/<keyId>", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/api-keys/:keyId"), ({ request }) => {
        seen = request;
        return HttpResponse.json(ONE_KEY);
      }),
    );

    await runCli(["api-keys", "get", "k-1"]);

    expect(seen?.method).toBe("GET");
    expect(new URL(seen!.url).pathname).toBe("/api/v1/org/api-keys/k-1");
  });
});

describe("api-keys update, on the wire", () => {
  it("PUTs the parsed --data object to /org/api-keys/<keyId>", async () => {
    let body: unknown;
    let seen: Request | undefined;
    server.use(
      http.put(apiUrl("/org/api-keys/:keyId"), async ({ request }) => {
        seen = request;
        body = await request.json();
        return HttpResponse.json({ id: "k-1", name: "renamed" });
      }),
    );

    await runCli(["api-keys", "update", "k-1", "--data", '{"name":"renamed"}']);

    expect(seen?.method).toBe("PUT");
    expect(new URL(seen!.url).pathname).toBe("/api/v1/org/api-keys/k-1");
    expect(body).toEqual({ name: "renamed" });
  });
});

describe("api-keys delete, on the wire", () => {
  it("DELETEs /org/api-keys/<keyId> with no body", async () => {
    let seen: Request | undefined;
    server.use(
      http.delete(apiUrl("/org/api-keys/:keyId"), ({ request }) => {
        seen = request;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const res = await runCli(["api-keys", "delete", "k-1"]);

    expect(res.exitCode).toBe(0);
    expect(seen?.method).toBe("DELETE");
    expect(new URL(seen!.url).pathname).toBe("/api/v1/org/api-keys/k-1");
    expect(seen?.headers.get("content-type")).toBeNull();
  });
});

describe("api-keys revoke, on the wire", () => {
  it("POSTs to /org/api-keys/<keyId>/revoke", async () => {
    let seen: Request | undefined;
    server.use(
      http.post(apiUrl("/org/api-keys/:keyId/revoke"), ({ request }) => {
        seen = request;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const res = await runCli(["api-keys", "revoke", "k-2"]);

    expect(res.exitCode).toBe(0);
    expect(seen?.method).toBe("POST");
    expect(new URL(seen!.url).pathname).toBe("/api/v1/org/api-keys/k-2/revoke");
  });
});

describe("api-keys kb-permissions, on the wire", () => {
  it("GETs the grants from /org/api-keys/<keyId>/kb-permissions", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/api-keys/:keyId/kb-permissions"), ({ request }) => {
        seen = request;
        return HttpResponse.json({ grants: [{ node_id: "n-1", role: "viewer" }] });
      }),
    );

    const res = await runCli(["api-keys", "kb-permissions-get", "k-1"]);

    expect(res.exitCode).toBe(0);
    expect(seen?.method).toBe("GET");
    expect(new URL(seen!.url).pathname).toBe("/api/v1/org/api-keys/k-1/kb-permissions");
  });

  it("PUTs the grants array verbatim, keeping node_id and role", async () => {
    let body: unknown;
    let seen: Request | undefined;
    server.use(
      http.put(apiUrl("/org/api-keys/:keyId/kb-permissions"), async ({ request }) => {
        seen = request;
        body = await request.json();
        return HttpResponse.json({ grants: [{ node_id: "n-1", role: "editor" }] });
      }),
    );

    await runCli([
      "api-keys",
      "kb-permissions-set",
      "k-1",
      "--data",
      '{"grants":[{"node_id":"n-1","role":"editor"}]}',
    ]);

    expect(seen?.method).toBe("PUT");
    expect(body).toEqual({ grants: [{ node_id: "n-1", role: "editor" }] });
  });

  it("DELETEs /org/api-keys/<keyId>/kb-permissions to restore org-level access", async () => {
    let seen: Request | undefined;
    server.use(
      http.delete(apiUrl("/org/api-keys/:keyId/kb-permissions"), ({ request }) => {
        seen = request;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const res = await runCli(["api-keys", "kb-permissions-delete", "k-1"]);

    expect(res.exitCode).toBe(0);
    expect(seen?.method).toBe("DELETE");
    expect(new URL(seen!.url).pathname).toBe("/api/v1/org/api-keys/k-1/kb-permissions");
  });
});

describe("api-keys list, on success", () => {
  it("prints the payload unmodified under --output json", async () => {
    server.use(http.get(apiUrl("/org/api-keys"), () => HttpResponse.json(KEYS)));

    const res = await runCli(["api-keys", "list", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.json()).toEqual(KEYS);
    expect(res.stderr).toBe("");
  });

  it("renders one row per key under --output table", async () => {
    server.use(http.get(apiUrl("/org/api-keys"), () => HttpResponse.json(KEYS)));

    const res = await runCli(["api-keys", "list", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("name");
    expect(res.stdout).toContain("ci");
    expect(res.stdout).toContain("laptop");
  });

  it("renders a readable block per key by default", async () => {
    server.use(http.get(apiUrl("/org/api-keys"), () => HttpResponse.json(KEYS)));

    const res = await runCli(["api-keys", "list"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("k-1");
    expect(res.stdout).toContain("laptop");
  });
});

describe("api-keys get, on success", () => {
  it("prints the single object unmodified under --output json", async () => {
    server.use(http.get(apiUrl("/org/api-keys/:keyId"), () => HttpResponse.json(ONE_KEY)));

    const res = await runCli(["api-keys", "get", "k-1", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.json()).toEqual(ONE_KEY);
    expect(res.stderr).toBe("");
  });

  it("renders a single object as field/value rows under --output table", async () => {
    server.use(http.get(apiUrl("/org/api-keys/:keyId"), () => HttpResponse.json(ONE_KEY)));

    const res = await runCli(["api-keys", "get", "k-1", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("field");
    expect(res.stdout).toContain("value");
    expect(res.stdout).toContain("k-1");
  });

  it("renders key/value lines by default", async () => {
    server.use(http.get(apiUrl("/org/api-keys/:keyId"), () => HttpResponse.json(ONE_KEY)));

    const res = await runCli(["api-keys", "get", "k-1"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("name");
    expect(res.stdout).toContain("ci");
  });
});

describe("api-keys create, on success", () => {
  it("puts the once-only secret on stdout and the tick on stderr", async () => {
    server.use(http.post(apiUrl("/org/api-keys"), () => HttpResponse.json(ONE_KEY)));

    const res = await runCli(["api-keys", "create", "--data", '{"name":"ci"}']);

    expect(res.exitCode).toBe(0);
    // The secret is shown once. It has to be on the stream a caller captures.
    expect(res.stdout).toContain("tgr_live_secret_shown_once");
    expect(res.stderr).toContain("API key created.");
    expect(res.stdout).not.toContain("API key created.");
  });

  it("emits only the payload under --output json, with no tick alongside it", async () => {
    server.use(http.post(apiUrl("/org/api-keys"), () => HttpResponse.json(ONE_KEY)));

    const res = await runCli(["api-keys", "create", "--data", '{"name":"ci"}', "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.json()).toEqual(ONE_KEY);
    expect(res.stderr).toBe("");
  });
});

describe("api-keys delete and revoke, confirming without a payload", () => {
  it("prints a parseable object on stdout under --output json", async () => {
    server.use(
      http.delete(apiUrl("/org/api-keys/:keyId"), () => new HttpResponse(null, { status: 204 })),
    );

    const res = await runCli(["api-keys", "delete", "k-1", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.json()).toMatchObject({ ok: true });
    expect(res.stderr).toBe("");
  });

  it("puts the ✓ on stderr and leaves stdout empty in plain mode", async () => {
    server.use(
      http.delete(apiUrl("/org/api-keys/:keyId"), () => new HttpResponse(null, { status: 204 })),
    );

    const res = await runCli(["api-keys", "delete", "k-1"]);

    expect(res.exitCode).toBe(0);
    // There is no payload here, so a caller piping this command gets nothing.
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("API key k-1 deleted.");
  });

  it("confirms a revoke on stderr, not stdout", async () => {
    server.use(
      http.post(
        apiUrl("/org/api-keys/:keyId/revoke"),
        () => new HttpResponse(null, { status: 204 }),
      ),
    );

    const res = await runCli(["api-keys", "revoke", "k-2"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("revoked");
  });

  it("confirms a kb-permissions delete as a JSON object on stdout", async () => {
    server.use(
      http.delete(
        apiUrl("/org/api-keys/:keyId/kb-permissions"),
        () => new HttpResponse(null, { status: 204 }),
      ),
    );

    const res = await runCli(["api-keys", "kb-permissions-delete", "k-1", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.json()).toMatchObject({ ok: true });
  });
});
