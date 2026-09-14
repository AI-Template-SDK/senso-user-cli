/**
 * Command layer: `senso org`.
 *
 * Three commands that between them cover the two shapes every write command in
 * this CLI takes: a raw `--data` body forwarded verbatim, and a typed flag
 * translated into a body the user never sees. Both are places where a rename is
 * invisible until production.
 *
 * `org set-runs` is the one worth being careful about. It is the org-wide kill
 * switch for every scheduled run, the flag is a string, and the body key
 * (`enable_runs`) does not match the flag name (`--enabled`). A test that only
 * checked the exit code would pass while the switch did the opposite of what was
 * asked, so the assertions below read the JSON body and the boolean inside it.
 *
 * Failure and usage branches come first: rejecting a malformed `--data` before
 * any request is made is the behavior, not an implementation detail.
 */

import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server, TEST_API_KEY } from "../setup.js";
import { apiUrl, runCli } from "../helpers.js";

const ORG = {
  org_id: "org-1",
  name: "Acme",
  slug: "acme",
  tier: "pro",
  websites: ["https://acme.example"],
  locations: [{ city: "Toronto", country: "CA" }],
};

/**
 * The same organization with no nested list, used for the rendering tests.
 *
 * See the BUG note under "org get, on success": a nested array of objects takes
 * over the table and plain renderings, so the field/value behavior can only be
 * observed on a payload that has none.
 */
const FLAT_ORG = {
  org_id: "org-1",
  name: "Acme",
  slug: "acme",
  tier: "pro",
  websites: ["https://acme.example"],
};

describe("org get, when the request fails", () => {
  it("exits 3 and explains how to authenticate when there is no API key", async () => {
    const res = await runCli(["org", "get"], { withKey: false });

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("no API key found");
    expect(res.stderr).toContain("SENSO_API_KEY");
  });

  it("exits 3 when the API rejects the key", async () => {
    server.use(
      http.get(apiUrl("/org/me"), () =>
        HttpResponse.json({ error: "invalid key" }, { status: 401 }),
      ),
    );

    const res = await runCli(["org", "get"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Authentication failed");
  });

  it("exits 3 when the key is valid but lacks the scope", async () => {
    server.use(
      http.get(apiUrl("/org/me"), () =>
        HttpResponse.json({ error: "not permitted" }, { status: 403 }),
      ),
    );

    const res = await runCli(["org", "get"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Permission denied");
  });

  it("exits 4 on a 404", async () => {
    server.use(http.get(apiUrl("/org/me"), () => new HttpResponse(null, { status: 404 })));

    const res = await runCli(["org", "get"]);

    expect(res.exitCode).toBe(4);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Not found");
  });

  it("exits 1 on a 500 and says it is not the caller's fault", async () => {
    server.use(http.get(apiUrl("/org/me"), () => new HttpResponse(null, { status: 500 })));

    const res = await runCli(["org", "get"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("not your fault");
  });

  it("writes the failure to stderr as JSON, leaving stdout empty, under --output json", async () => {
    server.use(
      http.get(apiUrl("/org/me"), () => HttpResponse.json({ error: "nope" }, { status: 403 })),
    );

    const res = await runCli(["org", "get", "--output", "json"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");

    const reported: unknown = JSON.parse(res.stderr);
    expect(reported).toMatchObject({
      error: { code: "forbidden", status: 403 },
    });
  });
});

describe("org update, when the flag is wrong", () => {
  it("exits 2 when --data is not valid JSON, without making a request", async () => {
    // No handler is registered: if the command reached the network, MSW's
    // unhandled-request rule would fail this test. That is the point.
    const res = await runCli(["org", "update", "--data", "{name: Acme}"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Invalid JSON in --data");
  });

  it("exits 2 when --data is valid JSON but not an object", async () => {
    const res = await runCli(["org", "update", "--data", '["Acme"]']);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("--data must be a JSON object");
  });

  it("reports the usage failure as JSON on stderr under --output json", async () => {
    const res = await runCli(["org", "update", "--data", "nope", "--output", "json"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(JSON.parse(res.stderr)).toMatchObject({ error: { code: "invalid_json" } });
  });
});

describe("org set-runs, when the flag is wrong", () => {
  it("exits 2 and names the valid values when --enabled is not a boolean", async () => {
    const res = await runCli(["org", "set-runs", "--enabled", "yes"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("--enabled must be");
    expect(res.stderr).toContain("true");
    expect(res.stderr).toContain("false");
  });

  it("reports the usage failure as JSON on stderr under --output json", async () => {
    const res = await runCli(["org", "set-runs", "--enabled", "1", "--output", "json"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(JSON.parse(res.stderr)).toMatchObject({ error: { code: "usage" } });
  });
});

describe("org get, on the wire", () => {
  it("issues a plain GET to /org/me with no query and no body", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/me"), ({ request }) => {
        seen = request;
        return HttpResponse.json(ORG);
      }),
    );

    await runCli(["org", "get"]);

    expect(seen?.method).toBe("GET");
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/me");
    expect(new URL(seen?.url ?? "").search).toBe("");
    expect(seen?.headers.get("x-api-key")).toBe(TEST_API_KEY);
    expect(seen?.body).toBeNull();
  });
});

describe("org update, on the wire", () => {
  it("PUTs /org/me with the --data object forwarded verbatim", async () => {
    let seen: Request | undefined;
    server.use(
      http.put(apiUrl("/org/me"), ({ request }) => {
        seen = request.clone();
        return HttpResponse.json(ORG);
      }),
    );

    const body = {
      name: "Acme Inc",
      slug: "acme-inc",
      logo_url: "https://acme.example/logo.png",
      websites: ["https://acme.example"],
      locations: [],
    };
    await runCli(["org", "update", "--data", JSON.stringify(body)]);

    expect(seen?.method).toBe("PUT");
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/me");
    expect(seen?.headers.get("content-type")).toBe("application/json");
    // Verbatim: the CLI adds no fields of its own, and drops none. An empty
    // array means "clear them", so it must survive the round trip.
    await expect(seen?.json()).resolves.toEqual(body);
  });
});

describe("org set-runs, on the wire", () => {
  it("PATCHes /org/me/runs-enabled with enable_runs true", async () => {
    let seen: Request | undefined;
    server.use(
      http.patch(apiUrl("/org/me/runs-enabled"), ({ request }) => {
        seen = request.clone();
        return HttpResponse.json({ enable_runs: true });
      }),
    );

    await runCli(["org", "set-runs", "--enabled", "true"]);

    expect(seen?.method).toBe("PATCH");
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/me/runs-enabled");
    // The flag is `--enabled`; the API parameter is `enable_runs`, and it is a
    // boolean rather than the string the user typed.
    await expect(seen?.json()).resolves.toEqual({ enable_runs: true });
  });

  it("PATCHes enable_runs false when asked to pause every scheduled run", async () => {
    let seen: Request | undefined;
    server.use(
      http.patch(apiUrl("/org/me/runs-enabled"), ({ request }) => {
        seen = request.clone();
        return HttpResponse.json({ enable_runs: false });
      }),
    );

    await runCli(["org", "set-runs", "--enabled", "false"]);

    await expect(seen?.json()).resolves.toEqual({ enable_runs: false });
  });

  it("accepts the value in any case", async () => {
    let seen: Request | undefined;
    server.use(
      http.patch(apiUrl("/org/me/runs-enabled"), ({ request }) => {
        seen = request.clone();
        return HttpResponse.json({ enable_runs: false });
      }),
    );

    await runCli(["org", "set-runs", "--enabled", "FALSE"]);

    await expect(seen?.json()).resolves.toEqual({ enable_runs: false });
  });
});

describe("org get, on success", () => {
  it("prints the payload unmodified under --output json", async () => {
    server.use(http.get(apiUrl("/org/me"), () => HttpResponse.json(ORG)));

    const res = await runCli(["org", "get", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.json()).toEqual(ORG);
    expect(res.stderr).toBe("");
  });

  it("renders the organization as a field/value table under --output table", async () => {
    server.use(http.get(apiUrl("/org/me"), () => HttpResponse.json(FLAT_ORG)));

    const res = await runCli(["org", "get", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("slug");
    expect(res.stdout).toContain("acme");
  });

  it("renders one key/value line per field by default", async () => {
    server.use(http.get(apiUrl("/org/me"), () => HttpResponse.json(FLAT_ORG)));

    const res = await runCli(["org", "get"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("tier");
    expect(res.stdout).toContain("pro");
    // Scalar arrays are joined rather than shown as "[object Object]".
    expect(res.stdout).toContain("https://acme.example");
  });

  it("shows the organization's own fields even when it carries a nested list", async () => {
    // Regression: emit() used to render the first array-of-objects property it
    // found, so an org with `locations: [...]` printed the locations and dropped
    // the name, slug and tier. Only --output json was unaffected.
    server.use(http.get(apiUrl("/org/me"), () => HttpResponse.json(ORG)));

    const res = await runCli(["org", "get"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("slug");
    expect(res.stdout).toContain("Toronto");
  });
});

describe("org update, on success", () => {
  it("prints the updated organization on stdout and the tick on stderr", async () => {
    server.use(http.put(apiUrl("/org/me"), () => HttpResponse.json(ORG)));

    const res = await runCli(["org", "update", "--data", '{"name":"Acme"}']);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Toronto");
    expect(res.stderr).toContain("Organization updated");
    // The confirmation is a diagnostic, never part of the payload.
    expect(res.stdout).not.toContain("Organization updated");
  });

  it("prints the payload alone under --output json, with no tick beside it", async () => {
    server.use(http.put(apiUrl("/org/me"), () => HttpResponse.json(ORG)));

    const res = await runCli(["org", "update", "--data", '{"name":"Acme"}', "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.json()).toEqual(ORG);
    expect(res.stderr).toBe("");
  });
});

describe("org set-runs, on success", () => {
  it("says which way the switch was thrown, on stderr", async () => {
    server.use(
      http.patch(apiUrl("/org/me/runs-enabled"), () => HttpResponse.json({ enable_runs: false })),
    );

    const res = await runCli(["org", "set-runs", "--enabled", "false"]);

    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain("disabled");
    expect(res.stdout).toContain("enable_runs");
  });

  it("prints the payload alone under --output json", async () => {
    server.use(
      http.patch(apiUrl("/org/me/runs-enabled"), () => HttpResponse.json({ enable_runs: true })),
    );

    const res = await runCli(["org", "set-runs", "--enabled", "true", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.json()).toEqual({ enable_runs: true });
    expect(res.stderr).toBe("");
  });
});

/**
 * `org set-industry` is the one irreversible call in this group: the API accepts
 * it once and answers every later attempt with a 409. The 409 therefore is not a
 * transient conflict a caller should retry — the message has to say so, and the
 * server's own message names the industry already in place, which is the detail
 * worth keeping.
 */
describe("org set-industry", () => {
  const INDUSTRY_UUID = "367d71d1-0fd4-4050-9f6c-a2346cbd8fbc";

  it("exits 1 and passes the server's message through on a 409", async () => {
    server.use(
      http.put(apiUrl("/org/me/industry"), () =>
        HttpResponse.json(
          { message: "Your organization's industry is already set to abc and cannot be changed" },
          { status: 409 },
        ),
      ),
    );

    const res = await runCli(["org", "set-industry", INDUSTRY_UUID]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("already set");
    expect(res.stderr).toContain("only once");
  });

  it("exits 4 when no industry in the catalog has that id", async () => {
    server.use(
      http.put(apiUrl("/org/me/industry"), () =>
        HttpResponse.json({ message: "Not found" }, { status: 404 }),
      ),
    );

    const res = await runCli(["org", "set-industry", INDUSTRY_UUID]);

    expect(res.exitCode).toBe(4);
  });

  it("exits 3 on a 401", async () => {
    server.use(
      http.put(apiUrl("/org/me/industry"), () =>
        HttpResponse.json({ message: "Unauthorized" }, { status: 401 }),
      ),
    );

    const res = await runCli(["org", "set-industry", INDUSTRY_UUID]);

    expect(res.exitCode).toBe(3);
  });

  it("puts the industry id in the body as industry_id", async () => {
    let body: unknown;
    server.use(
      http.put(apiUrl("/org/me/industry"), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ ...ORG, industry_id: INDUSTRY_UUID });
      }),
    );

    const res = await runCli(["org", "set-industry", INDUSTRY_UUID]);

    expect(res.exitCode).toBe(0);
    expect(body).toEqual({ industry_id: INDUSTRY_UUID });
  });

  it("confirms on stderr and prints the organization on stdout", async () => {
    server.use(
      http.put(apiUrl("/org/me/industry"), () =>
        HttpResponse.json({ ...ORG, industry_name: "Airlines (Canada)" }),
      ),
    );

    const res = await runCli(["org", "set-industry", INDUSTRY_UUID]);

    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain("industry set");
    expect(res.stdout).toContain("Airlines (Canada)");
  });

  it("prints the payload alone under --output json", async () => {
    server.use(
      http.put(apiUrl("/org/me/industry"), () =>
        HttpResponse.json({ ...ORG, industry_name: "Airlines (Canada)" }),
      ),
    );

    const res = await runCli(["org", "set-industry", INDUSTRY_UUID, "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.json<{ industry_name: string }>().industry_name).toBe("Airlines (Canada)");
    expect(res.stderr).toBe("");
  });
});
