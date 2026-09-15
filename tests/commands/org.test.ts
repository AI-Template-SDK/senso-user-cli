/**
 * Command layer: `senso org`.
 *
 * Four commands that between them cover the two shapes every write in this CLI
 * takes — a raw `--data` body forwarded verbatim, and a typed flag translated
 * into a body the user never sees — plus the one call in the group that deletes
 * data nobody asked it to delete.
 *
 * That last one is what this file mostly protects. `org update` REPLACES the
 * whole `websites` and `locations` lists whenever either key is present, so
 * sending one website deletes every other. The API answers 200 with the
 * shortened list and says nothing; the help said so and the output did not. The
 * command now reads the record first purely so it can name what the write
 * removed, and the tests below assert that sentence, its count, and the entries
 * it names — in plain on stderr and in `warnings` for a json caller, who cannot
 * see stderr at all.
 *
 * `org set-runs` is the second: it is the org-wide kill switch for every
 * scheduled run, the flag is a string, and the body key (`enable_runs`) does not
 * match the flag name (`--enabled`). A test that only checked the exit code
 * would pass while the switch did the opposite of what was asked.
 *
 * `org set-industry` is the third: the API accepts it once and answers every
 * later attempt with a 409 that no retry can clear.
 *
 * The fixtures are dto.PartnerOrgResponse, which is what `/org/me` returns —
 * websites and locations are arrays of OBJECTS carrying their own read-only ids,
 * not arrays of strings. An earlier fixture invented `tier` and string websites,
 * which is how a command could have mishandled the real shape and stayed green.
 *
 * Failure and usage branches come first: rejecting a malformed `--data` before
 * any request is made is the behavior, not an implementation detail.
 */

import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server, TEST_API_KEY } from "../setup.js";
import { apiUrl, envelope, errorEnvelope, runCli } from "../helpers.js";

const ORG_ID = "b1e9f6c2-7f4a-4d2e-9a3b-1c5d7e9f0a2b";
const PARTNER_ID = "8a7b6c5d-4e3f-4a2b-9c8d-7e6f5a4b3c2d";
const INDUSTRY_ID = "5d6e7f80-9a0b-4c1d-8e2f-3a4b5c6d7e8f";
const WEBSITE_MAIN = "3f2a1b0c-9d8e-4f7a-b6c5-d4e3f2a1b0c9";
const WEBSITE_BLOG = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
const LOCATION_ON = "d4e3f2a1-b0c9-4d8e-9f7a-6b5c4d3e2f1a";
const LOCATION_CA = "e5f4a3b2-c1d0-4e9f-8a7b-6c5d4e3f2a1b";
const MODEL_ID = "1f2e3d4c-5b6a-4978-8695-a4b3c2d1e0f9";

/** dto.PartnerOrgResponse, which is what GET and PUT /org/me both return. */
const ORG = {
  org_id: ORG_ID,
  name: "Acme Credit Union",
  slug: "acme",
  logo_url: "https://acme.example/logo.png",
  primary_website_url: "https://acme.example",
  network_name: "",
  industry_id: INDUSTRY_ID,
  industry_name: "Credit Unions (Canada)",
  partner_id: PARTNER_ID,
  is_free_tier: false,
  enable_runs: true,
  is_activated: true,
  websites: [
    { org_website_id: WEBSITE_MAIN, url: "https://acme.example" },
    { org_website_id: WEBSITE_BLOG, url: "https://blog.acme.example" },
  ],
  locations: [
    { org_location_id: LOCATION_ON, country_code: "CA", region_name: "Ontario" },
    { org_location_id: LOCATION_CA, country_code: "US", region_name: "California" },
  ],
  models: [{ geo_model_id: MODEL_ID, name: "gpt-4o" }],
  schedule: [1, 4],
  content_schedule: [2],
  enable_content_generation: true,
  content_auto_publish: false,
  created_at: "2026-01-02T00:00:00Z",
  updated_at: "2026-09-01T12:00:00Z",
};

/** The same organization after a write that kept only the first entry of each. */
const TRIMMED_ORG = {
  ...ORG,
  websites: [{ org_website_id: WEBSITE_MAIN, url: "https://acme.example" }],
  locations: [{ org_location_id: LOCATION_ON, country_code: "CA", region_name: "Ontario" }],
};

/** GET /org/me answers with the full record; PUT answers with whatever is given. */
function onUpdate(after: Record<string, unknown>, before: Record<string, unknown> = ORG): void {
  server.use(
    http.get(apiUrl("/org/me"), () => HttpResponse.json(before)),
    http.put(apiUrl("/org/me"), () => HttpResponse.json(after)),
  );
}

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

  it("says a 403 naming a partner route cannot be reached with an org key", async () => {
    server.use(
      http.get(apiUrl("/org/me"), () =>
        HttpResponse.json({ message: "partner key required" }, { status: 403 }),
      ),
    );

    const res = await runCli(["org", "get", "--output", "json"]);

    expect(res.exitCode).toBe(3);
    expect(errorEnvelope(res).error.hint).toContain("partner API key");
  });

  it("names the organization, not just 'not found', on a 404", async () => {
    server.use(http.get(apiUrl("/org/me"), () => new HttpResponse(null, { status: 404 })));

    const res = await runCli(["org", "get"]);

    expect(res.exitCode).toBe(4);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Organization not found");
    expect(res.stderr).toContain("senso whoami");
  });

  it("exits 1 on a 500 and offers a retry", async () => {
    server.use(http.get(apiUrl("/org/me"), () => new HttpResponse(null, { status: 500 })));

    const res = await runCli(["org", "get"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Retry shortly");
  });

  it("refuses to suggest a retry on a 501, which retrying cannot fix", async () => {
    server.use(
      http.get(apiUrl("/org/me"), () =>
        HttpResponse.json({ message: "Not implemented in this deployment" }, { status: 501 }),
      ),
    );

    const res = await runCli(["org", "get"]);

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("not a transient failure");
    expect(res.stderr).not.toContain("Retry shortly");
  });

  it("writes one error envelope to stderr and leaves stdout empty under --output json", async () => {
    server.use(
      http.get(apiUrl("/org/me"), () => HttpResponse.json({ error: "nope" }, { status: 403 })),
    );

    const res = await runCli(["org", "get", "--output", "json"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");

    const reported = errorEnvelope(res);
    expect(reported.ok).toBe(false);
    expect(reported.command).toBe("org get");
    expect(reported.error).toMatchObject({
      code: "forbidden",
      status: 403,
      request: { method: "GET", path: "/org/me" },
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

  it("names the accepted keys when --data carries one the API would silently drop", async () => {
    // The Go binder ignores an unrecognized key, so `{"website": …}` would be a
    // 200 that changed nothing — a write that reads as a success.
    const res = await runCli(["org", "update", "--data", '{"website":"https://acme.example"}', "--output", "json"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");

    const { error } = errorEnvelope(res);
    expect(error.code).toBe("usage");
    expect(error.received).toBe("website");
    expect(error.allowed).toEqual(["name", "slug", "logo_url", "websites", "locations"]);
  });

  it("exits 2 on an empty object rather than sending a write that changes nothing", async () => {
    const res = await runCli(["org", "update", "--data", "{}", "--output", "json"]);

    expect(res.exitCode).toBe(2);
    expect(errorEnvelope(res).error.hint).toContain("would change nothing");
  });

  it("exits 2 when a website entry carries the read-only id from `org get`", async () => {
    // org_website_id looks round-trippable and is not: the binder drops it, so
    // a caller pasting `org get` output back would believe it was honored.
    const res = await runCli([
      "org",
      "update",
      "--data",
      `{"websites":[{"org_website_id":"${WEBSITE_MAIN}","url":"https://acme.example"}]}`,
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    const { error } = errorEnvelope(res);
    expect(error.field).toBe("--data.websites[0].org_website_id");
    expect(error.allowed).toEqual(["url"]);
  });

  it("exits 2 when a website entry's url is not http(s)", async () => {
    const res = await runCli([
      "org",
      "update",
      "--data",
      '{"websites":[{"url":"acme.example"}]}',
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    const { error } = errorEnvelope(res);
    expect(error.field).toBe("--data.websites[0].url");
    expect(error.received).toBe("acme.example");
  });

  it("exits 2 when a country_code is not exactly two letters", async () => {
    const res = await runCli([
      "org",
      "update",
      "--data",
      '{"locations":[{"country_code":"USA","region_name":"California"}]}',
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    const { error } = errorEnvelope(res);
    expect(error.field).toBe("--data.locations[0].country_code");
    expect(error.received).toBe("USA");
  });

  it("exits 2 when websites is not an array, and says how to clear the list", async () => {
    const res = await runCli([
      "org",
      "update",
      "--data",
      '{"websites":"https://acme.example"}',
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    const { error } = errorEnvelope(res);
    expect(error.field).toBe("--data.websites");
    expect(error.hint).toContain("Pass [] to clear the list");
  });

  it("reports the usage failure as JSON on stderr under --output json", async () => {
    const res = await runCli(["org", "update", "--data", "nope", "--output", "json"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(errorEnvelope(res).error.code).toBe("invalid_json");
  });
});

describe("org set-runs, when the flag is wrong", () => {
  it("exits 2 and puts both values in error.allowed when --enabled is not a boolean", async () => {
    const res = await runCli(["org", "set-runs", "--enabled", "yes", "--output", "json"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");

    const { error } = errorEnvelope(res);
    expect(error.code).toBe("usage");
    expect(error.field).toBe("--enabled");
    expect(error.received).toBe("yes");
    expect(error.allowed).toEqual(["true", "false"]);
  });

  it("refuses 1 and 0, which look like booleans and are not", async () => {
    const res = await runCli(["org", "set-runs", "--enabled", "1"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("--enabled must be");
  });
});

describe("org set-industry, when the argument is wrong", () => {
  it("exits 2 before any request when the id is not a UUID", async () => {
    const res = await runCli(["org", "set-industry", "credit-unions", "--output", "json"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");

    const { error } = errorEnvelope(res);
    expect(error.field).toBe("<industryId>");
    expect(error.received).toBe("credit-unions");
    expect(error.hint).toContain("senso industries list");
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
      http.get(apiUrl("/org/me"), () => HttpResponse.json(ORG)),
      http.put(apiUrl("/org/me"), ({ request }) => {
        seen = request.clone();
        return HttpResponse.json(TRIMMED_ORG);
      }),
    );

    const body = {
      name: "Acme Inc",
      slug: "acme-inc",
      logo_url: "https://acme.example/logo.png",
      websites: [{ url: "https://acme.example" }],
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

  it("does not read the record first when neither list is being replaced", async () => {
    // The pre-read exists only to name what a replacement deleted. A caller
    // renaming the organization should not pay for a second request — and no GET
    // handler is registered here, so one would fail this test.
    let seen: Request | undefined;
    server.use(
      http.put(apiUrl("/org/me"), ({ request }) => {
        seen = request.clone();
        return HttpResponse.json(ORG);
      }),
    );

    const res = await runCli(["org", "update", "--data", '{"name":"Acme Inc"}']);

    expect(res.exitCode).toBe(0);
    expect(seen?.method).toBe("PUT");
  });
});

describe("org set-runs, on the wire", () => {
  it("PATCHes /org/me/runs-enabled with enable_runs true", async () => {
    let seen: Request | undefined;
    server.use(
      http.patch(apiUrl("/org/me/runs-enabled"), ({ request }) => {
        seen = request.clone();
        return HttpResponse.json({ ...ORG, enable_runs: true });
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
        return HttpResponse.json({ ...ORG, enable_runs: false });
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
        return HttpResponse.json({ ...ORG, enable_runs: false });
      }),
    );

    await runCli(["org", "set-runs", "--enabled", "FALSE"]);

    await expect(seen?.json()).resolves.toEqual({ enable_runs: false });
  });
});

describe("org get, on success", () => {
  it("wraps the payload unmodified in the success envelope under --output json", async () => {
    server.use(http.get(apiUrl("/org/me"), () => HttpResponse.json(ORG)));

    const res = await runCli(["org", "get", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toEqual(ORG);
    expect(envelope(res).command).toBe("org get");
    expect(res.stderr).toBe("");
  });

  it("offers the update command in next, where a json caller can see it", async () => {
    server.use(http.get(apiUrl("/org/me"), () => HttpResponse.json(ORG)));

    const res = await runCli(["org", "get", "--output", "json"]);

    const steps = envelope(res).next ?? [];
    expect(steps.some((step) => step.command.startsWith("senso org update"))).toBe(true);
  });

  it("offers set-industry only when the organization has no industry yet", async () => {
    // The command can be run once and never again, so suggesting it to an
    // organization that already has one is an instruction that ends in a 409.
    server.use(
      http.get(apiUrl("/org/me"), () =>
        HttpResponse.json({ ...ORG, industry_id: undefined, industry_name: "" }),
      ),
    );

    const withoutIndustry = await runCli(["org", "get", "--output", "json"]);
    expect((withoutIndustry.data<{ industry_id?: string }>()).industry_id).toBeUndefined();
    expect((envelope(withoutIndustry).next ?? []).map((s) => s.command)).toContain(
      "senso org set-industry <industry_id>",
    );

    server.use(http.get(apiUrl("/org/me"), () => HttpResponse.json(ORG)));

    const withIndustry = await runCli(["org", "get", "--output", "json"]);
    expect((envelope(withIndustry).next ?? []).map((s) => s.command)).not.toContain(
      "senso org set-industry <industry_id>",
    );
  });

  it("shows the organization's own fields, not only the lists it carries", async () => {
    // Regression: the renderer used to take the first array-of-objects property
    // it found as the payload, so an org with `locations: [...]` printed the
    // locations and dropped the name, slug and tier. Only json was unaffected.
    server.use(http.get(apiUrl("/org/me"), () => HttpResponse.json(ORG)));

    const res = await runCli(["org", "get"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("slug");
    expect(res.stdout).toContain("Acme Credit Union");
    expect(res.stdout).toContain("Credit Unions (Canada)");
    // And the nested lists are still readable rather than stringified JSON.
    expect(res.stdout).toContain("https://blog.acme.example");
    expect(res.stdout).toContain("Ontario");
    expect(res.stdout).not.toContain('[{"org_website_id"');
  });

  it("joins the weekday schedule instead of printing [object Object]", async () => {
    server.use(http.get(apiUrl("/org/me"), () => HttpResponse.json(ORG)));

    const res = await runCli(["org", "get"]);

    expect(res.stdout).toContain("1, 4");
    expect(res.stdout).not.toContain("[object Object]");
  });

  it("renders the organization under --output table without a blank-column warning", async () => {
    server.use(http.get(apiUrl("/org/me"), () => HttpResponse.json(ORG)));

    const res = await runCli(["org", "get", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("slug");
    expect(res.stdout).toContain("acme");
    expect(res.stderr).not.toContain("did not return");
  });
});

describe("org update, on what a replacement deleted", () => {
  it("names the websites the write removed, and how many", async () => {
    // The one destructive-by-omission call in this group. The API replaces the
    // whole list and answers 200; nothing but this sentence says an entry is
    // gone.
    onUpdate(TRIMMED_ORG);

    const res = await runCli([
      "org",
      "update",
      "--data",
      '{"websites":[{"url":"https://acme.example"}]}',
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain("websites replaced the whole list");
    expect(res.stderr).toContain("1 entry removed");
    expect(res.stderr).toContain("https://blog.acme.example");
  });

  it("names the locations a location write removed, in country/region form", async () => {
    onUpdate(TRIMMED_ORG);

    const res = await runCli([
      "org",
      "update",
      "--data",
      '{"locations":[{"country_code":"CA","region_name":"Ontario"}]}',
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain("locations replaced the whole list");
    expect(res.stderr).toContain("US/California");
  });

  it("puts the warning in the envelope under --output json, where stderr is silent", async () => {
    // Every published Senso skill passes --output json, which implies --quiet.
    // A warning written only to stderr would reach nobody.
    onUpdate(TRIMMED_ORG);

    const res = await runCli([
      "org",
      "update",
      "--data",
      '{"websites":[{"url":"https://acme.example"}],"locations":[{"country_code":"CA","region_name":"Ontario"}]}',
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.stderr).toBe("");

    const warnings = envelope(res).warnings ?? [];
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("1 entry removed (https://blog.acme.example)");
    expect(warnings[1]).toContain("1 entry removed (US/California)");
  });

  it("counts entries in the plural when a write clears the list outright", async () => {
    onUpdate({ ...ORG, websites: [] });

    const res = await runCli(["org", "update", "--data", '{"websites":[]}', "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(envelope(res).warnings?.[0]).toContain("2 entries removed");
  });

  it("says the previous list could not be read rather than claiming nothing was removed", async () => {
    // A failed pre-read must not fail the write the caller asked for, and it
    // must not be reported as "nothing was deleted" either.
    server.use(
      http.get(apiUrl("/org/me"), () => new HttpResponse(null, { status: 500 })),
      http.put(apiUrl("/org/me"), () => HttpResponse.json(TRIMMED_ORG)),
    );

    const res = await runCli([
      "org",
      "update",
      "--data",
      '{"websites":[{"url":"https://acme.example"}]}',
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(0);
    expect(envelope(res).warnings?.[0]).toContain("could not be read");
  });

  it("stays silent when the write replaced a list with itself", async () => {
    onUpdate(ORG);

    const res = await runCli([
      "org",
      "update",
      "--data",
      '{"websites":[{"url":"https://acme.example"},{"url":"https://blog.acme.example"}]}',
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(0);
    expect(envelope(res).warnings).toBeUndefined();
  });

  it("warns about neither list when the write touched neither", async () => {
    server.use(http.put(apiUrl("/org/me"), () => HttpResponse.json(ORG)));

    const res = await runCli(["org", "update", "--data", '{"name":"Acme"}', "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(envelope(res).warnings).toBeUndefined();
  });
});

describe("org update, on success", () => {
  it("prints the updated organization on stdout and the tick on stderr", async () => {
    server.use(http.put(apiUrl("/org/me"), () => HttpResponse.json(ORG)));

    const res = await runCli(["org", "update", "--data", '{"name":"Acme"}']);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Acme Credit Union");
    expect(res.stderr).toContain("Organization updated");
    // The confirmation is a diagnostic, never part of the payload.
    expect(res.stdout).not.toContain("Organization updated");
  });

  it("prints the payload alone under --output json, with no tick beside it", async () => {
    server.use(http.put(apiUrl("/org/me"), () => HttpResponse.json(ORG)));

    const res = await runCli(["org", "update", "--data", '{"name":"Acme"}', "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toEqual(ORG);
    expect(res.stderr).toBe("");
  });

  it("exits 1 and passes the API's own message through on a taken slug", async () => {
    server.use(
      http.put(apiUrl("/org/me"), () =>
        HttpResponse.json({ message: "Organization with that slug already exists" }, { status: 409 }),
      ),
    );

    const res = await runCli(["org", "update", "--data", '{"slug":"acme"}', "--output", "json"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    const { error } = errorEnvelope(res);
    expect(error.code).toBe("conflict");
    expect(error.message).toContain("slug already exists");
  });
});

describe("org set-runs, on success", () => {
  it("says which way the switch was thrown, on stderr", async () => {
    server.use(
      http.patch(apiUrl("/org/me/runs-enabled"), () =>
        HttpResponse.json({ ...ORG, enable_runs: false }),
      ),
    );

    const res = await runCli(["org", "set-runs", "--enabled", "false"]);

    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain("disabled");
    expect(res.stdout).toContain("enable_runs");
  });

  it("offers the opposite command next, so the switch can be thrown back", async () => {
    server.use(
      http.patch(apiUrl("/org/me/runs-enabled"), () =>
        HttpResponse.json({ ...ORG, enable_runs: false }),
      ),
    );

    const res = await runCli(["org", "set-runs", "--enabled", "false", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect((envelope(res).next ?? []).map((s) => s.command)).toContain(
      "senso org set-runs --enabled true",
    );
  });

  it("prints the payload alone under --output json", async () => {
    server.use(
      http.patch(apiUrl("/org/me/runs-enabled"), () =>
        HttpResponse.json({ ...ORG, enable_runs: true }),
      ),
    );

    const res = await runCli(["org", "set-runs", "--enabled", "true", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.data<{ enable_runs: boolean }>().enable_runs).toBe(true);
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
  it("exits 1 and says a retry can never work on a 409", async () => {
    server.use(
      http.put(apiUrl("/org/me/industry"), () =>
        HttpResponse.json(
          {
            message: `Your organization's industry is already set to ${INDUSTRY_ID} and cannot be changed`,
          },
          { status: 409 },
        ),
      ),
    );

    const res = await runCli(["org", "set-industry", INDUSTRY_ID, "--output", "json"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");

    const { error } = errorEnvelope(res);
    expect(error.code).toBe("conflict");
    expect(error.status).toBe(409);
    // The server names the industry already in place; that is the one detail
    // worth keeping rather than flattening into a generic conflict.
    expect(error.message).toContain(INDUSTRY_ID);
    expect(error.hint).toContain("only once");
    expect(error.hint).toContain("senso org get");
  });

  it("names the industry and the catalog when no industry has that id", async () => {
    server.use(
      http.put(apiUrl("/org/me/industry"), () =>
        HttpResponse.json({ message: "Industry not found" }, { status: 404 }),
      ),
    );

    const res = await runCli(["org", "set-industry", INDUSTRY_ID, "--output", "json"]);

    expect(res.exitCode).toBe(4);
    const { error } = errorEnvelope(res);
    expect(error.code).toBe("not_found");
    expect(error.field).toBe("industry_id");
    expect(error.received).toBe(INDUSTRY_ID);
    expect(error.message).toContain(`Industry ${INDUSTRY_ID}`);
    expect(error.hint).toContain("senso industries list");
  });

  it("exits 3 on a 401", async () => {
    server.use(
      http.put(apiUrl("/org/me/industry"), () =>
        HttpResponse.json({ message: "Unauthorized" }, { status: 401 }),
      ),
    );

    const res = await runCli(["org", "set-industry", INDUSTRY_ID]);

    expect(res.exitCode).toBe(3);
  });

  it("puts the industry id in the body as industry_id", async () => {
    let body: unknown;
    server.use(
      http.put(apiUrl("/org/me/industry"), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ ...ORG, industry_id: INDUSTRY_ID });
      }),
    );

    const res = await runCli(["org", "set-industry", INDUSTRY_ID]);

    expect(res.exitCode).toBe(0);
    expect(body).toEqual({ industry_id: INDUSTRY_ID });
  });

  it("confirms on stderr, prints the organization on stdout, and offers the import", async () => {
    server.use(
      http.put(apiUrl("/org/me/industry"), () =>
        HttpResponse.json({ ...ORG, industry_name: "Airlines (Canada)" }),
      ),
    );

    const res = await runCli(["org", "set-industry", INDUSTRY_ID]);

    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain("industry set");
    expect(res.stdout).toContain("Airlines (Canada)");
    expect(res.stderr).toContain(`senso industries import-prompts ${INDUSTRY_ID}`);
  });

  it("prints the payload alone under --output json", async () => {
    server.use(
      http.put(apiUrl("/org/me/industry"), () =>
        HttpResponse.json({ ...ORG, industry_name: "Airlines (Canada)" }),
      ),
    );

    const res = await runCli(["org", "set-industry", INDUSTRY_ID, "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.data<{ industry_name: string }>().industry_name).toBe("Airlines (Canada)");
    expect(res.stderr).toBe("");
  });
});
