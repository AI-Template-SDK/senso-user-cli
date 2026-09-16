/**
 * Command layer: `senso brand-kit`.
 *
 * A singleton with one read and two writes, and the two writes are not
 * interchangeable. What is worth protecting:
 *
 *   - `set` is a PUT. Every field absent from --data is REMOVED, and there is
 *     no undo, so the command has to say which fields its own request dropped;
 *   - `patch` is a MERGE, except for global_writing_rules, which it replaces
 *     wholesale. A caller who believes it appends silently deletes every rule
 *     but the one they sent;
 *   - the body is checked before the request. The API reports the same bad body
 *     two different ways — PATCH names the field, PUT flattens everything to
 *     "Invalid guidelines data" — and ignores keys outside `guidelines` with a
 *     200, which looks like a write that succeeded and changed nothing;
 *   - `get` never 404s. An organization with no brand kit gets a SYNTHESIZED
 *     record whose id is the zero UUID and whose timestamps are year 0001, and
 *     nothing in the payload says so.
 *
 * Fixtures are BrandKitResponse from senso-api's
 * internal/api/dto/brand_kit_dto.go: brand_kit_id, org_id, guidelines,
 * created_at, updated_at. Failure branches first.
 */

import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server, TEST_API_KEY } from "../setup.js";
import { apiUrl, envelope, errorEnvelope, runCli } from "../helpers.js";

const BRAND_KIT_ID = "5f1d3a08-6b27-4c94-8e0a-7d2b9c4f1e63";
const ORG_ID = "c4a91f27-38de-4b60-9a15-7e0d2c8b6f34";
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

const GUIDELINES = {
  brand_name: "Acme",
  brand_domain: "https://acme.com",
  brand_description: "Acme sells refundable widgets to small businesses.",
  voice_and_tone: "Warm and direct",
  author_persona: "A senior support engineer",
  global_writing_rules: ["Avoid superlatives unless backed by a number"],
};

/** A saved brand kit with every field filled in. */
const KIT = {
  brand_kit_id: BRAND_KIT_ID,
  org_id: ORG_ID,
  guidelines: GUIDELINES,
  created_at: "2026-05-02T09:15:00Z",
  updated_at: "2026-06-11T10:04:00Z",
};

/** The same kit missing two fields, which is the ordinary state of one. */
const PARTIAL_KIT = {
  ...KIT,
  guidelines: {
    brand_name: "Acme",
    brand_domain: "https://acme.com",
    brand_description: "Acme sells refundable widgets to small businesses.",
    global_writing_rules: ["Avoid superlatives unless backed by a number"],
  },
};

/** What the API synthesizes for an organization that never saved one. */
const UNSAVED_KIT = {
  brand_kit_id: ZERO_UUID,
  org_id: ORG_ID,
  guidelines: {},
  created_at: "0001-01-01T00:00:00Z",
  updated_at: "0001-01-01T00:00:00Z",
};

function data(body: unknown): string {
  return JSON.stringify(body);
}

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

  it("exits 3 when a viewer key may not read the brand kit", async () => {
    server.use(
      http.get(apiUrl("/org/brand-kit"), () =>
        HttpResponse.json({ error: "missing permission read:brand_kit" }, { status: 403 }),
      ),
    );

    const res = await runCli(["brand-kit", "get"]);

    expect(res.exitCode).toBe(3);
    expect(res.stderr).toContain("Permission denied");
  });

  it("exits 1 on a 500 and offers a retry", async () => {
    server.use(http.get(apiUrl("/org/brand-kit"), () => new HttpResponse(null, { status: 500 })));

    const res = await runCli(["brand-kit", "get"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Retry shortly");
  });

  it("writes the failure to stderr as an error envelope, leaving stdout empty", async () => {
    server.use(
      http.get(apiUrl("/org/brand-kit"), () =>
        HttpResponse.json({ error: "nope" }, { status: 403 }),
      ),
    );

    const res = await runCli(["brand-kit", "get", "--output", "json"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    const err = errorEnvelope(res);
    expect(err.command).toBe("brand-kit get");
    expect(err.error).toMatchObject({
      code: "forbidden",
      status: 403,
      request: { method: "GET", path: "/org/brand-kit" },
    });
  });
});

describe("brand-kit get, on success", () => {
  it("prints the payload under data, with nothing beside it", async () => {
    server.use(http.get(apiUrl("/org/brand-kit"), () => HttpResponse.json(KIT)));

    const res = await runCli(["brand-kit", "get", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toEqual(KIT);
    expect(envelope(res).warnings).toBeUndefined();
    expect(res.stderr).toBe("");
  });

  it("renders the guidelines as a sub-block rather than one line of JSON", async () => {
    server.use(http.get(apiUrl("/org/brand-kit"), () => HttpResponse.json(KIT)));

    const res = await runCli(["brand-kit", "get"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("voice_and_tone");
    expect(res.stdout).toContain("Warm and direct");
    expect(res.stdout).toContain("Avoid superlatives unless backed by a number");
  });

  it("warns that an unsaved kit was synthesized, and that its id means nothing", async () => {
    // GET never 404s here, so without this an agent could reasonably store the
    // zero UUID as if it addressed something.
    server.use(http.get(apiUrl("/org/brand-kit"), () => HttpResponse.json(UNSAVED_KIT)));

    const res = await runCli(["brand-kit", "get", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    const warnings = (envelope(res).warnings ?? []).join(" ");
    expect(warnings).toContain("No brand kit has been saved");
    expect(warnings).toContain("zero UUID");
    const next = (envelope(res).next ?? []).map((s) => s.command).join(" ");
    expect(next).toContain("senso brand-kit set");
    expect(next).toContain("senso website-import start");
  });

  it("names the fields that are not set, and how to fill one in without the rest", async () => {
    server.use(http.get(apiUrl("/org/brand-kit"), () => HttpResponse.json(PARTIAL_KIT)));

    const res = await runCli(["brand-kit", "get", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    const warnings = (envelope(res).warnings ?? []).join(" ");
    expect(warnings).toContain("Not set: voice_and_tone, author_persona");
    expect((envelope(res).next ?? []).map((s) => s.command).join(" ")).toContain(
      "senso brand-kit patch",
    );
  });

  it("GETs /org/brand-kit with the key, and sends no id", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/brand-kit"), ({ request }) => {
        seen = request;
        return HttpResponse.json(KIT);
      }),
    );

    await runCli(["brand-kit", "get"]);

    expect(seen?.method).toBe("GET");
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/brand-kit");
    expect(new URL(seen?.url ?? "").search).toBe("");
    expect(seen?.headers.get("x-api-key")).toBe(TEST_API_KEY);
  });
});

describe("brand-kit set and patch, when --data is wrong", () => {
  // No handler registered in this block: a request would fail the test, which
  // is how "the body is checked before it is sent" is proven.

  it("exits 2 when --data is not valid JSON", async () => {
    const res = await runCli(["brand-kit", "set", "--data", "{guidelines: Acme}"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Invalid JSON in --data");
  });

  it("exits 2 when there is no guidelines object at the top level", async () => {
    const res = await runCli([
      "brand-kit",
      "set",
      "--data",
      data({ brand_name: "Acme" }),
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    const err = errorEnvelope(res);
    expect(err.error.field).toBe("--data");
    expect(err.error.allowed).toEqual(["guidelines"]);
  });

  it("exits 2 on a key beside guidelines, which the API would accept and drop", async () => {
    const res = await runCli([
      "brand-kit",
      "set",
      "--data",
      data({ guidelines: { brand_name: "Acme" }, brand_domain: "https://acme.com" }),
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    const err = errorEnvelope(res);
    expect(err.error.received).toBe("brand_domain");
    expect(err.error.hint).toContain("without reporting that it did");
  });

  it("exits 2 when guidelines is an array rather than an object", async () => {
    const res = await runCli(["brand-kit", "patch", "--data", data({ guidelines: ["Acme"] })]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("must be a JSON object, not an array");
  });

  it("suggests the closest field for an obvious misspelling", async () => {
    const res = await runCli([
      "brand-kit",
      "patch",
      "--data",
      data({ guidelines: { brand_nme: "Acme" } }),
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    const err = errorEnvelope(res);
    expect(err.error.field).toBe("--data guidelines.brand_nme");
    expect(err.error.hint).toContain('Did you mean "brand_name"?');
    expect(err.error.allowed).toContain("global_writing_rules");
  });

  it("suggests nothing for a field the caller invented outright", async () => {
    const res = await runCli([
      "brand-kit",
      "patch",
      "--data",
      data({ guidelines: { mascot: "A goat" } }),
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    expect(errorEnvelope(res).error.hint).not.toContain("Did you mean");
  });

  it("exits 2 when global_writing_rules is a string rather than an array", async () => {
    const res = await runCli([
      "brand-kit",
      "set",
      "--data",
      data({ guidelines: { global_writing_rules: "Be concise" } }),
    ]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("must be an array of strings, not a string");
  });

  it("exits 2 naming the index when a rule is not a string", async () => {
    // Accepted and stored as-is by the API, so a templating slip would leave a
    // null sitting in an array the spec declares as strings.
    const res = await runCli([
      "brand-kit",
      "set",
      "--data",
      data({ guidelines: { global_writing_rules: ["Be concise", null] } }),
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    expect(errorEnvelope(res).error.field).toBe("--data guidelines.global_writing_rules[1]");
  });

  it("exits 2 on a null value, and says how to remove a field instead", async () => {
    const res = await runCli([
      "brand-kit",
      "patch",
      "--data",
      data({ guidelines: { voice_and_tone: null } }),
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    const err = errorEnvelope(res);
    expect(err.error.message).toContain("must be a string, not null");
    expect(err.error.hint).toContain("No field may be null");
  });

  it("exits 2 when patch names no field, because it would change nothing", async () => {
    const res = await runCli([
      "brand-kit",
      "patch",
      "--data",
      data({ guidelines: {} }),
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    const err = errorEnvelope(res);
    expect(err.error.message).toContain("at least one field to patch");
    expect(err.error.hint).toContain("senso brand-kit set");
  });
});

describe("brand-kit set, when the API refuses the write", () => {
  it("exits 1 on a 400, passing the API's own message through", async () => {
    server.use(
      http.put(apiUrl("/org/brand-kit"), () =>
        HttpResponse.json({ error: "Invalid guidelines data" }, { status: 400 }),
      ),
    );

    const res = await runCli([
      "brand-kit",
      "set",
      "--data",
      data({ guidelines: { brand_name: "Acme" } }),
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    const err = errorEnvelope(res);
    expect(err.error.code).toBe("validation");
    expect(err.error.message).toContain("Invalid guidelines data");
  });

  it("exits 3 when the key may not write the brand kit", async () => {
    server.use(
      http.put(apiUrl("/org/brand-kit"), () =>
        HttpResponse.json({ error: "missing permission update:brand_kit" }, { status: 403 }),
      ),
    );

    const res = await runCli([
      "brand-kit",
      "set",
      "--data",
      data({ guidelines: { brand_name: "Acme" } }),
    ]);

    expect(res.exitCode).toBe(3);
    expect(res.stderr).toContain("Permission denied");
  });
});

describe("brand-kit set, on success", () => {
  it("PUTs the validated body verbatim", async () => {
    let seen: Request | undefined;
    server.use(
      http.put(apiUrl("/org/brand-kit"), ({ request }) => {
        seen = request.clone();
        return HttpResponse.json(KIT);
      }),
    );

    await runCli(["brand-kit", "set", "--data", data({ guidelines: GUIDELINES })]);

    expect(seen?.method).toBe("PUT");
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/brand-kit");
    await expect(seen?.json()).resolves.toEqual({ guidelines: GUIDELINES });
  });

  it("warns which fields its own PUT dropped, because there is no undo", async () => {
    // The whole hazard of `set`: the request succeeds, and four fields the
    // caller never mentioned are gone.
    server.use(
      http.put(apiUrl("/org/brand-kit"), () =>
        HttpResponse.json({ ...KIT, guidelines: { brand_name: "Acme" } }),
      ),
    );

    const res = await runCli([
      "brand-kit",
      "set",
      "--data",
      data({ guidelines: { brand_name: "Acme" } }),
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(0);
    const warnings = (envelope(res).warnings ?? []).join(" ");
    expect(warnings).toContain(
      "brand_domain, brand_description, voice_and_tone, author_persona, global_writing_rules",
    );
    expect(warnings).toContain("senso brand-kit patch");
  });

  it("drops nothing, and warns about nothing, when every field is sent", async () => {
    server.use(http.put(apiUrl("/org/brand-kit"), () => HttpResponse.json(KIT)));

    const res = await runCli([
      "brand-kit",
      "set",
      "--data",
      data({ guidelines: GUIDELINES }),
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toEqual(KIT);
    expect(envelope(res).warnings).toBeUndefined();
    expect(res.stderr).toBe("");
  });

  it("says the kit is now empty rather than refusing '{\"guidelines\":{}}'", async () => {
    server.use(
      http.put(apiUrl("/org/brand-kit"), () => HttpResponse.json({ ...KIT, guidelines: {} })),
    );

    const res = await runCli([
      "brand-kit",
      "set",
      "--data",
      data({ guidelines: {} }),
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(0);
    expect((envelope(res).warnings ?? []).join(" ")).toContain("every guideline was cleared");
  });

  it("puts the tick on stderr and the stored kit on stdout", async () => {
    server.use(http.put(apiUrl("/org/brand-kit"), () => HttpResponse.json(KIT)));

    const res = await runCli(["brand-kit", "set", "--data", data({ guidelines: GUIDELINES })]);

    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain("Brand kit updated.");
    expect(res.stdout).toContain(BRAND_KIT_ID);
    expect(res.stdout).not.toContain("Brand kit updated.");
  });
});

describe("brand-kit patch, on success", () => {
  it("PATCHes only the fields it was given", async () => {
    let seen: Request | undefined;
    server.use(
      http.patch(apiUrl("/org/brand-kit"), ({ request }) => {
        seen = request.clone();
        return HttpResponse.json({
          ...KIT,
          guidelines: { ...GUIDELINES, voice_and_tone: "Warmer" },
        });
      }),
    );

    const res = await runCli([
      "brand-kit",
      "patch",
      "--data",
      data({ guidelines: { voice_and_tone: "Warmer" } }),
    ]);

    expect(res.exitCode).toBe(0);
    expect(seen?.method).toBe("PATCH");
    await expect(seen?.json()).resolves.toEqual({ guidelines: { voice_and_tone: "Warmer" } });
    expect(res.stderr).toContain("Brand kit updated: voice_and_tone.");
  });

  it("warns that global_writing_rules is REPLACED, not appended to", async () => {
    // The one thing patch does not merge. A caller who believes it appends
    // deletes every rule but the one they sent.
    server.use(
      http.patch(apiUrl("/org/brand-kit"), () =>
        HttpResponse.json({
          ...KIT,
          guidelines: { ...GUIDELINES, global_writing_rules: ["Prefer concrete examples"] },
        }),
      ),
    );

    const res = await runCli([
      "brand-kit",
      "patch",
      "--data",
      data({ guidelines: { global_writing_rules: ["Prefer concrete examples"] } }),
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(0);
    const warnings = (envelope(res).warnings ?? []).join(" ");
    expect(warnings).toContain("replaced wholesale, not appended to");
    expect(warnings).toContain("any rule not in --data is gone");
  });

  it("warns about nothing when the patch does not touch the rules", async () => {
    server.use(
      http.patch(apiUrl("/org/brand-kit"), () =>
        HttpResponse.json({ ...KIT, guidelines: { ...GUIDELINES, voice_and_tone: "Warmer" } }),
      ),
    );

    const res = await runCli([
      "brand-kit",
      "patch",
      "--data",
      data({ guidelines: { voice_and_tone: "Warmer" } }),
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(0);
    expect(envelope(res).warnings).toBeUndefined();
    expect((envelope(res).next ?? []).map((s) => s.command)).toContain("senso brand-kit get");
    expect(res.stderr).toBe("");
  });

  it("renders the merged kit as a table of fields", async () => {
    server.use(http.patch(apiUrl("/org/brand-kit"), () => HttpResponse.json(KIT)));

    const res = await runCli([
      "brand-kit",
      "patch",
      "--data",
      data({ guidelines: { voice_and_tone: "Warm and direct" } }),
      "--output",
      "table",
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("brand_kit_id");
    expect(res.stdout).toContain("guidelines");
    expect(res.stderr).not.toContain("which the API did not return");
  });
});
