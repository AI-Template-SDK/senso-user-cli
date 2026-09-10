/**
 * Command layer: `senso brand-kit`.
 *
 * `set` and `patch` differ in exactly one character on the wire — PUT versus
 * PATCH — and in everything that matters to a user: `set` replaces the whole
 * brand kit, `patch` merges. Nothing else distinguishes them. Their flags are
 * identical, their success messages are identical, and their responses are
 * identical, so a swapped method would silently erase a customer's brand voice
 * and still print "Brand kit updated."
 *
 * That is what this file exists to protect. The method assertions in "on the
 * wire" are the load-bearing ones; the rest is the shared contract — usage
 * errors before any request, stdout carrying only the payload, and an exit code
 * that says what happened.
 */

import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server, TEST_API_KEY } from "../setup.js";
import { apiUrl, runCli } from "../helpers.js";

const BRAND_KIT = {
  guidelines: {
    brand_name: "Acme",
    brand_domain: "acme.example",
    brand_description: "Tools that do not explode",
    voice_and_tone: "Direct, warm, never breathless",
    author_persona: "A senior engineer who has shipped",
    global_writing_rules: ["No exclamation marks", "Spell out numbers under ten"],
  },
};

describe("brand-kit get, when the request fails", () => {
  it("exits 3 and explains how to authenticate when there is no API key", async () => {
    const res = await runCli(["brand-kit", "get"], { withKey: false });

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("no API key found");
    expect(res.stderr).toContain("SENSO_API_KEY");
  });

  it("exits 3 when the API rejects the key", async () => {
    server.use(
      http.get(apiUrl("/org/brand-kit"), () =>
        HttpResponse.json({ error: "invalid key" }, { status: 401 }),
      ),
    );

    const res = await runCli(["brand-kit", "get"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Authentication failed");
  });

  it("exits 3 when the key is valid but lacks the scope", async () => {
    server.use(
      http.get(apiUrl("/org/brand-kit"), () =>
        HttpResponse.json({ error: "not permitted" }, { status: 403 }),
      ),
    );

    const res = await runCli(["brand-kit", "get"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Permission denied");
  });

  it("exits 4 when the organization has no brand kit yet", async () => {
    server.use(http.get(apiUrl("/org/brand-kit"), () => new HttpResponse(null, { status: 404 })));

    const res = await runCli(["brand-kit", "get"]);

    expect(res.exitCode).toBe(4);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Not found");
  });

  it("exits 1 on a 500 and says it is not the caller's fault", async () => {
    server.use(http.get(apiUrl("/org/brand-kit"), () => new HttpResponse(null, { status: 500 })));

    const res = await runCli(["brand-kit", "get"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("not your fault");
  });

  it("writes the failure to stderr as JSON, leaving stdout empty, under --output json", async () => {
    server.use(
      http.get(apiUrl("/org/brand-kit"), () =>
        HttpResponse.json({ error: "nope" }, { status: 403 }),
      ),
    );

    const res = await runCli(["brand-kit", "get", "--output", "json"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");

    const reported: unknown = JSON.parse(res.stderr);
    expect(reported).toMatchObject({
      error: { code: "forbidden", status: 403 },
    });
  });
});

describe("brand-kit set, when the write is rejected", () => {
  it("surfaces the API's field-level complaint about an unknown key", async () => {
    // The endpoint rejects keys outside the defined set. That message is the
    // only thing telling the user which key was wrong, so it must reach stderr
    // rather than being flattened into a generic failure.
    server.use(
      http.put(apiUrl("/org/brand-kit"), () =>
        HttpResponse.json(
          { errors: [{ field: "guidelines.mascot", message: "unknown key" }] },
          { status: 400 },
        ),
      ),
    );

    const res = await runCli(["brand-kit", "set", "--data", '{"guidelines":{"mascot":"a goat"}}']);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("guidelines.mascot");
    expect(res.stderr).toContain("unknown key");
  });
});

describe("brand-kit set and patch, when the flag is wrong", () => {
  it("exits 2 when set's --data is not valid JSON, without making a request", async () => {
    // No handler registered: reaching the network would fail this test.
    const res = await runCli(["brand-kit", "set", "--data", "{guidelines:}"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Invalid JSON in --data");
  });

  it("exits 2 when patch's --data is not valid JSON, without making a request", async () => {
    const res = await runCli(["brand-kit", "patch", "--data", "not json at all"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Invalid JSON in --data");
  });

  it("exits 2 when --data is valid JSON but not an object", async () => {
    const res = await runCli(["brand-kit", "patch", "--data", '"warm and approachable"']);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("--data must be a JSON object");
  });

  it("reports the usage failure as JSON on stderr under --output json", async () => {
    const res = await runCli(["brand-kit", "set", "--data", "{", "--output", "json"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(JSON.parse(res.stderr)).toMatchObject({ error: { code: "invalid_json" } });
  });
});

describe("brand-kit get, on the wire", () => {
  it("issues a plain GET to /org/brand-kit with no query and no body", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/brand-kit"), ({ request }) => {
        seen = request;
        return HttpResponse.json(BRAND_KIT);
      }),
    );

    await runCli(["brand-kit", "get"]);

    expect(seen?.method).toBe("GET");
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/brand-kit");
    expect(new URL(seen?.url ?? "").search).toBe("");
    expect(seen?.headers.get("x-api-key")).toBe(TEST_API_KEY);
    expect(seen?.body).toBeNull();
  });
});

describe("brand-kit set, on the wire", () => {
  it("PUTs — a full replacement — with the --data object forwarded verbatim", async () => {
    let seen: Request | undefined;
    server.use(
      http.put(apiUrl("/org/brand-kit"), ({ request }) => {
        seen = request.clone();
        return HttpResponse.json(BRAND_KIT);
      }),
    );

    await runCli(["brand-kit", "set", "--data", JSON.stringify(BRAND_KIT)]);

    // PUT, not PATCH. Swapping them turns a replace into a merge.
    expect(seen?.method).toBe("PUT");
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/brand-kit");
    expect(seen?.headers.get("content-type")).toBe("application/json");
    await expect(seen?.json()).resolves.toEqual(BRAND_KIT);
  });

  it("does not wrap, rename or add to what the user passed", async () => {
    let seen: Request | undefined;
    server.use(
      http.put(apiUrl("/org/brand-kit"), ({ request }) => {
        seen = request.clone();
        return HttpResponse.json(BRAND_KIT);
      }),
    );

    await runCli(["brand-kit", "set", "--data", '{"guidelines":{"global_writing_rules":[]}}']);

    await expect(seen?.json()).resolves.toEqual({ guidelines: { global_writing_rules: [] } });
  });
});

describe("brand-kit patch, on the wire", () => {
  it("PATCHes — a partial update — with the --data object forwarded verbatim", async () => {
    let seen: Request | undefined;
    server.use(
      http.patch(apiUrl("/org/brand-kit"), ({ request }) => {
        seen = request.clone();
        return HttpResponse.json(BRAND_KIT);
      }),
    );

    const body = { guidelines: { voice_and_tone: "Warm and approachable" } };
    await runCli(["brand-kit", "patch", "--data", JSON.stringify(body)]);

    // PATCH, not PUT. Swapping them erases every field the user did not send.
    expect(seen?.method).toBe("PATCH");
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/brand-kit");
    await expect(seen?.json()).resolves.toEqual(body);
  });
});

describe("brand-kit get, on success", () => {
  it("prints the payload unmodified under --output json", async () => {
    server.use(http.get(apiUrl("/org/brand-kit"), () => HttpResponse.json(BRAND_KIT)));

    const res = await runCli(["brand-kit", "get", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.json()).toEqual(BRAND_KIT);
    expect(res.stderr).toBe("");
  });

  it("renders the guidelines as a field/value table under --output table", async () => {
    server.use(http.get(apiUrl("/org/brand-kit"), () => HttpResponse.json(BRAND_KIT)));

    const res = await runCli(["brand-kit", "get", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("guidelines");
    expect(res.stdout).toContain("Acme");
  });

  it("renders the guidelines readably by default", async () => {
    server.use(http.get(apiUrl("/org/brand-kit"), () => HttpResponse.json(BRAND_KIT)));

    const res = await runCli(["brand-kit", "get"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("guidelines");
    // plain never truncates, so the full voice_and_tone line survives.
    expect(res.stdout).toContain("Direct, warm, never breathless");
  });

  it("exits 0 when the brand kit is present but empty", async () => {
    server.use(http.get(apiUrl("/org/brand-kit"), () => HttpResponse.json({ guidelines: {} })));

    const res = await runCli(["brand-kit", "get"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("guidelines");
  });
});

describe("brand-kit set and patch, on success", () => {
  it("puts the tick on stderr and the updated kit on stdout", async () => {
    server.use(http.put(apiUrl("/org/brand-kit"), () => HttpResponse.json(BRAND_KIT)));

    const res = await runCli(["brand-kit", "set", "--data", '{"guidelines":{}}']);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("guidelines");
    expect(res.stderr).toContain("Brand kit updated");
    expect(res.stdout).not.toContain("Brand kit updated");
  });

  it("prints the payload alone under --output json, with no tick beside it", async () => {
    server.use(http.patch(apiUrl("/org/brand-kit"), () => HttpResponse.json(BRAND_KIT)));

    const res = await runCli([
      "brand-kit",
      "patch",
      "--data",
      '{"guidelines":{"author_persona":"x"}}',
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.json()).toEqual(BRAND_KIT);
    expect(res.stderr).toBe("");
  });
});
