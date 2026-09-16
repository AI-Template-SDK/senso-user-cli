/**
 * Command layer: `senso destinations`.
 *
 * This is the one group in the CLI where getting a flag wrong is destructive:
 * `remove --action delete` unpublishes live articles AND hard-deletes the local
 * records. So what is worth protecting here is the guard rail as much as the
 * request:
 *
 *   - an unknown `--type` or `--action`, and a publisherId that is not a UUID,
 *     must exit 2, name the accepted set in `error.allowed`, and make no
 *     request at all;
 *   - `--type` accepts only `citeables`. `codeables` and `cucopilot` are SLUGS
 *     of shared destinations, not publisher types, and the API answers them
 *     with a 400 — the CLI has to say so before spending the round trip;
 *   - the value that does reach the API must be the lower-cased one, since the
 *     check is case-insensitive but the API is not;
 *   - `remove` must always send all three body fields, because the two boolean
 *     flags decide whether a domain registration survives, and an absent field
 *     is not the same promise as an explicit `false`;
 *   - a removal that unlinked the destination but left publish records behind
 *     must say so, rather than reporting a clean success.
 *
 * Failure branches come first, as in tests/commands/roles.test.ts.
 */

import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server, TEST_API_KEY } from "../setup.js";
import { apiUrl, envelope, errorEnvelope, runCli } from "../helpers.js";

/** Real publisher_id values: every id flag in this group is validated first. */
const SHARED_ID = "5d9c2e8a-1b3f-4a6c-9d2e-7f8a0b1c2d3e";
const OWN_ID = "c4d5e6f7-a8b9-4c0d-8e1f-2a3b4c5d6e7f";
const MISSING_ID = "0f1e2d3c-4b5a-4968-8877-665544332211";

/**
 * Built from dto.OrgDestinationResponse in senso-api. The field names matter
 * more than usual here: `slug` and `publisher_id` address the same destination
 * for different commands, and `display_url` — not `domain` — is what the list
 * renders.
 */
const DESTINATIONS = {
  destinations: [
    {
      publisher_id: SHARED_ID,
      scope: "shared",
      type: "citeables",
      name: "Citeables",
      slug: "citeables",
      display_url: "citeables.com",
      live_count: 12,
      last_publish_at: "2026-09-01T10:15:00Z",
      selected_for_generation: true,
    },
    {
      publisher_id: OWN_ID,
      scope: "org",
      type: "citeables",
      name: "Example Citeables",
      slug: "content-example-com",
      display_url: "content.example.com",
      live_count: 0,
      selected_for_generation: false,
    },
  ],
};

/** POST /org/destinations answers with one OrgDestinationResponse. */
const ONE_DESTINATION = {
  publisher_id: OWN_ID,
  scope: "org",
  type: "citeables",
  name: "Example Citeables",
  slug: "content-example-com",
  display_url: "content.example.com",
  live_count: 0,
  selected_for_generation: true,
};

/** dto.RemoveOrgDestinationResponse, with nothing left behind. */
const REMOVED = {
  affected_record_count: 4,
  unpublished_count: 4,
  deleted_content_count: 0,
  destination_removed: false,
  domain_deregistered: false,
};

describe("destinations, when the request fails", () => {
  it("exits 3 and explains how to authenticate when there is no API key", async () => {
    const res = await runCli(["destinations", "list"], { withKey: false });

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("no API key found");
    expect(res.stderr).toContain("SENSO_API_KEY");
  });

  it("exits 3 when the API rejects the key", async () => {
    server.use(
      http.get(apiUrl("/org/destinations"), () =>
        HttpResponse.json({ error: "invalid key" }, { status: 401 }),
      ),
    );

    const res = await runCli(["destinations", "list"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Authentication failed");
  });

  it("exits 3 when the key is valid but lacks the scope", async () => {
    server.use(
      http.post(apiUrl("/org/destinations"), () =>
        HttpResponse.json({ error: "update:org required" }, { status: 403 }),
      ),
    );

    const res = await runCli([
      "destinations",
      "add",
      "--domain",
      "content.example.com",
      "--name",
      "Example Citeables",
    ]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Permission denied");
  });

  it("exits 4 naming the destination and the id when it does not exist", async () => {
    server.use(
      http.post(
        apiUrl("/org/destinations/:publisherId/remove"),
        () => new HttpResponse(null, { status: 404 }),
      ),
    );

    const res = await runCli(["destinations", "remove", MISSING_ID, "--action", "leave"]);

    expect(res.exitCode).toBe(4);
    expect(res.stdout).toBe("");
    // A bare "Not found." leaves a caller unable to tell a wrong id from a
    // wrong id SPACE — a slug passed where a publisher_id belongs.
    expect(res.stderr).toContain(`Destination ${MISSING_ID} not found`);
    expect(res.stderr).toContain("senso destinations list");
  });

  it("names the resource, the field and the id in the JSON error for a 404", async () => {
    server.use(
      http.post(
        apiUrl("/org/destinations/:publisherId/remove"),
        () => new HttpResponse(null, { status: 404 }),
      ),
    );

    const res = await runCli([
      "destinations",
      "remove",
      MISSING_ID,
      "--action",
      "leave",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(4);
    expect(res.stdout).toBe("");
    expect(errorEnvelope(res).error).toMatchObject({
      code: "not_found",
      status: 404,
      field: "publisher_id",
      received: MISSING_ID,
    });
  });

  it("exits 1 on a 500 and says it is not the caller's fault", async () => {
    server.use(
      http.get(apiUrl("/org/destinations"), () => new HttpResponse(null, { status: 500 })),
    );

    const res = await runCli(["destinations", "list"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("server-side failure");
  });

  it("exits 1 on a 503 WITHOUT offering a retry, because retrying cannot work", async () => {
    // A deployment-level refusal is not a transient failure: telling an agent
    // to retry sends it into a loop that can never succeed.
    server.use(
      http.get(apiUrl("/org/destinations"), () =>
        HttpResponse.json({ message: "Destinations are not enabled here" }, { status: 503 }),
      ),
    );

    const res = await runCli(["destinations", "list"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("not a transient failure");
    expect(res.stderr).not.toContain("Retry shortly");
  });

  it("exits 1 on a 409 when the domain is already registered", async () => {
    server.use(
      http.post(apiUrl("/org/destinations"), () =>
        HttpResponse.json({ error: "domain already registered" }, { status: 409 }),
      ),
    );

    const res = await runCli([
      "destinations",
      "add",
      "--domain",
      "content.example.com",
      "--name",
      "Example Citeables",
    ]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Conflict");
  });

  it("writes the failure to stderr as JSON, leaving stdout empty, under --output json", async () => {
    server.use(
      http.get(apiUrl("/org/destinations"), () =>
        HttpResponse.json({ error: "nope" }, { status: 403 }),
      ),
    );

    const res = await runCli(["destinations", "list", "--output", "json"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(errorEnvelope(res)).toMatchObject({
      ok: false,
      command: "destinations list",
      error: { code: "forbidden", status: 403 },
    });
  });
});

describe("destinations add, on an invalid --type", () => {
  // No handler is registered in this block: setup.ts fails any request that
  // reaches the network, so each of these also proves the guard ran first.
  it("exits 2 and names citeables as the only type that can be registered", async () => {
    const res = await runCli([
      "destinations",
      "add",
      "--domain",
      "content.example.com",
      "--name",
      "Example",
      "--type",
      "wordpress",
    ]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain('Invalid --type: "wordpress"');
    expect(res.stderr).toContain("citeables");
  });

  it("rejects codeables, which is a shared destination's slug and not a type", async () => {
    // It appears in `destinations list`, so it reads like a type. The API
    // answers it with a 400, which an agent would otherwise pay to discover.
    const res = await runCli([
      "destinations",
      "add",
      "--domain",
      "code.example.com",
      "--name",
      "Example Codeables",
      "--type",
      "codeables",
    ]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain('Invalid --type: "codeables"');
  });

  it("rejects cucopilot for the same reason", async () => {
    const res = await runCli([
      "destinations",
      "add",
      "--domain",
      "copilot.example.com",
      "--name",
      "Example Copilot",
      "--type",
      "cucopilot",
    ]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain('Invalid --type: "cucopilot"');
  });

  it("reports the rejected type as usage, with the accepted set, under --output json", async () => {
    const res = await runCli([
      "destinations",
      "add",
      "--domain",
      "content.example.com",
      "--name",
      "Example",
      "--type",
      "wordpress",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");

    const { error } = errorEnvelope(res);
    expect(error.code).toBe("usage");
    expect(error.field).toBe("--type");
    expect(error.received).toBe("wordpress");
    // `allowed` is what lets an agent fix its own command line without reading
    // the sentence the hint is written in.
    expect(error.allowed).toEqual(["citeables"]);
  });

  it("exits 2 on an empty --type rather than sending one", async () => {
    const res = await runCli([
      "destinations",
      "add",
      "--domain",
      "content.example.com",
      "--name",
      "Example",
      "--type",
      "",
    ]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("citeables");
  });

  it("exits 2 when --domain is a URL rather than a bare hostname", async () => {
    const res = await runCli([
      "destinations",
      "add",
      "--domain",
      "https://content.example.com/blog",
      "--name",
      "Example",
    ]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("bare hostname");
  });

  it("exits 2 when a required flag is missing", async () => {
    const res = await runCli(["destinations", "add", "--domain", "content.example.com"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
  });
});

describe("destinations remove, on an invalid argument", () => {
  it("exits 2 and names all three valid actions", async () => {
    const res = await runCli(["destinations", "remove", OWN_ID, "--action", "purge"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain('Invalid --action: "purge"');
    expect(res.stderr).toContain("leave");
    expect(res.stderr).toContain("unpublish");
    expect(res.stderr).toContain("delete");
  });

  it("reports the rejected action as usage, with the valid values, under --output json", async () => {
    const res = await runCli([
      "destinations",
      "remove",
      OWN_ID,
      "--action",
      "purge",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");

    const { error } = errorEnvelope(res);
    expect(error.code).toBe("usage");
    expect(error.field).toBe("--action");
    expect(error.allowed).toEqual(["leave", "unpublish", "delete"]);
  });

  it("exits 2 when a slug is passed where a publisher_id belongs", async () => {
    // `citeables` is a real destination, addressed by a real id — just not this
    // one. Forwarding it would produce a 404 about an id the caller never typed.
    const res = await runCli(["destinations", "remove", "citeables", "--action", "leave"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("not a UUID");
    expect(res.stderr).toContain("senso destinations list");
  });

  it("exits 2 when --keep-domain is given without --also-remove-destination", async () => {
    // keep_domain is only read when the destination itself is being deleted, so
    // accepting it alone would let a caller believe a domain had been spared
    // that was never at risk.
    const res = await runCli([
      "destinations",
      "remove",
      OWN_ID,
      "--action",
      "leave",
      "--keep-domain",
    ]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("--keep-domain only applies");
  });

  it("exits 2 when --action is missing, since there is no safe default", async () => {
    const res = await runCli(["destinations", "remove", OWN_ID]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
  });
});

describe("destinations list, on the wire", () => {
  it("GETs /org/destinations with the API key and no query string", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/destinations"), ({ request }) => {
        seen = request;
        return HttpResponse.json(DESTINATIONS);
      }),
    );

    await runCli(["destinations", "list"]);

    expect(seen?.method).toBe("GET");
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/destinations");
    expect(new URL(seen?.url ?? "").search).toBe("");
    expect(seen?.headers.get("x-api-key")).toBe(TEST_API_KEY);
  });
});

describe("destinations add, on the wire", () => {
  it("POSTs type, name and domain, defaulting the type to citeables", async () => {
    let body: unknown;
    let seen: Request | undefined;
    server.use(
      http.post(apiUrl("/org/destinations"), async ({ request }) => {
        seen = request;
        body = await request.json();
        return HttpResponse.json(ONE_DESTINATION);
      }),
    );

    await runCli([
      "destinations",
      "add",
      "--domain",
      "content.example.com",
      "--name",
      "Example Citeables",
    ]);

    expect(seen?.method).toBe("POST");
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/destinations");
    expect(seen?.headers.get("content-type")).toBe("application/json");
    expect(body).toEqual({
      type: "citeables",
      name: "Example Citeables",
      domain: "content.example.com",
    });
  });

  it("sends the lower-cased type, so --type CITEABLES is accepted and normalized", async () => {
    let body: unknown;
    server.use(
      http.post(apiUrl("/org/destinations"), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(ONE_DESTINATION);
      }),
    );

    await runCli([
      "destinations",
      "add",
      "--domain",
      "content.example.com",
      "--name",
      "Example Citeables",
      "--type",
      "CITEABLES",
    ]);

    // The check is case-insensitive; the API is not. Sending "CITEABLES" here
    // would be accepted by the CLI and rejected by the server.
    expect(body).toMatchObject({ type: "citeables" });
  });

  it("trims the domain rather than registering one with whitespace in it", async () => {
    let body: unknown;
    server.use(
      http.post(apiUrl("/org/destinations"), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(ONE_DESTINATION);
      }),
    );

    await runCli([
      "destinations",
      "add",
      "--domain",
      "  content.example.com  ",
      "--name",
      "Example Citeables",
    ]);

    expect(body).toMatchObject({ domain: "content.example.com" });
  });
});

describe("destinations remove, on the wire", () => {
  it("POSTs to the destination's remove path with both booleans defaulted to false", async () => {
    let body: unknown;
    let seen: Request | undefined;
    server.use(
      http.post(apiUrl("/org/destinations/:publisherId/remove"), async ({ request }) => {
        seen = request;
        body = await request.json();
        return HttpResponse.json(REMOVED);
      }),
    );

    await runCli(["destinations", "remove", OWN_ID, "--action", "leave"]);

    expect(seen?.method).toBe("POST");
    expect(new URL(seen?.url ?? "").pathname).toBe(`/api/v1/org/destinations/${OWN_ID}/remove`);
    // All three fields, always: an omitted `keep_domain` would let the server's
    // default decide whether a domain registration survives.
    expect(body).toEqual({
      action: "leave",
      also_remove_destination: false,
      keep_domain: false,
    });
  });

  it("sends the flags the caller set, under their snake_case API names", async () => {
    let body: unknown;
    server.use(
      http.post(apiUrl("/org/destinations/:publisherId/remove"), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ ...REMOVED, destination_removed: true });
      }),
    );

    await runCli([
      "destinations",
      "remove",
      OWN_ID,
      "--action",
      "unpublish",
      "--also-remove-destination",
      "--keep-domain",
    ]);

    expect(body).toEqual({
      action: "unpublish",
      also_remove_destination: true,
      keep_domain: true,
    });
  });

  it("sends the lower-cased action, so --action DELETE is normalized", async () => {
    let body: unknown;
    server.use(
      http.post(apiUrl("/org/destinations/:publisherId/remove"), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ ...REMOVED, deleted_content_count: 4 });
      }),
    );

    await runCli(["destinations", "remove", OWN_ID, "--action", "DELETE"]);

    expect(body).toMatchObject({ action: "delete" });
  });

  it("explains that a shared destination cannot be deleted, rather than repeating the 404", async () => {
    server.use(
      http.post(apiUrl("/org/destinations/:publisherId/remove"), () =>
        HttpResponse.json({ message: "cannot delete shared publisher" }, { status: 404 }),
      ),
    );

    const res = await runCli([
      "destinations",
      "remove",
      SHARED_ID,
      "--action",
      "leave",
      "--also-remove-destination",
    ]);

    // Exit 1, not 4: the id is right there in `destinations list`, and sending
    // the caller to look for a missing one is the wrong instruction.
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("can be unlinked but not deleted");
  });
});

describe("destinations, on success", () => {
  it("prints the list payload unmodified under --output json", async () => {
    server.use(http.get(apiUrl("/org/destinations"), () => HttpResponse.json(DESTINATIONS)));

    const res = await runCli(["destinations", "list", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toEqual(DESTINATIONS);
    expect(res.stderr).toBe("");
  });

  it("renders one row per destination under --output table", async () => {
    server.use(http.get(apiUrl("/org/destinations"), () => HttpResponse.json(DESTINATIONS)));

    const res = await runCli(["destinations", "list", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    // publisher_id, because that is the value `remove` takes; slug beside it,
    // because that is the value `generate sample --destination` takes.
    expect(res.stdout).toContain("publisher_id");
    expect(res.stdout).toContain("slug");
    expect(res.stdout).toContain(SHARED_ID);
    expect(res.stdout).toContain("content.example.com");
    // Every declared column exists on a row, so the renderer has nothing to
    // warn about. A warning here means the CLI is naming a field the API does
    // not return.
    expect(res.stderr).not.toContain("did not return");
  });

  it("renders a readable block per destination by default", async () => {
    server.use(http.get(apiUrl("/org/destinations"), () => HttpResponse.json(DESTINATIONS)));

    const res = await runCli(["destinations", "list"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Citeables");
    expect(res.stdout).toContain("selected_for_generation");
  });

  it("says nothing is selected for generation, and what to run about it", async () => {
    server.use(
      http.get(apiUrl("/org/destinations"), () =>
        HttpResponse.json({
          destinations: DESTINATIONS.destinations.map((d) => ({
            ...d,
            selected_for_generation: false,
          })),
        }),
      ),
    );

    const res = await runCli(["destinations", "list", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(envelope(res).next?.[0]?.command).toContain("senso generate update-settings");
  });

  it("prints the registered destination on stdout and the tick on stderr", async () => {
    server.use(http.post(apiUrl("/org/destinations"), () => HttpResponse.json(ONE_DESTINATION)));

    const res = await runCli([
      "destinations",
      "add",
      "--domain",
      "content.example.com",
      "--name",
      "Example Citeables",
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain(OWN_ID);
    expect(res.stdout).not.toContain("✓");
    expect(res.stderr).toContain("Registered destination");
  });

  it("warns that the new destination is already selected for generation", async () => {
    server.use(http.post(apiUrl("/org/destinations"), () => HttpResponse.json(ONE_DESTINATION)));

    const res = await runCli([
      "destinations",
      "add",
      "--domain",
      "content.example.com",
      "--name",
      "Example Citeables",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(0);
    expect(envelope(res).warnings?.[0]).toContain("selected for generation immediately");
  });

  it("renders the registered destination as field/value rows under --output table", async () => {
    server.use(http.post(apiUrl("/org/destinations"), () => HttpResponse.json(ONE_DESTINATION)));

    const res = await runCli([
      "destinations",
      "add",
      "--domain",
      "content.example.com",
      "--name",
      "Example Citeables",
      "--output",
      "table",
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("field");
    expect(res.stdout).toContain("publisher_id");
  });

  it("prints the removal result on stdout and the tick on stderr", async () => {
    server.use(
      http.post(apiUrl("/org/destinations/:publisherId/remove"), () => HttpResponse.json(REMOVED)),
    );

    const res = await runCli(["destinations", "remove", OWN_ID, "--action", "unpublish"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("unpublished_count");
    expect(res.stdout).not.toContain("✓");
    expect(res.stderr).toContain("Removed destination");
  });

  it("returns the removal result unmodified under --output json", async () => {
    server.use(
      http.post(apiUrl("/org/destinations/:publisherId/remove"), () => HttpResponse.json(REMOVED)),
    );

    const res = await runCli([
      "destinations",
      "remove",
      OWN_ID,
      "--action",
      "delete",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toEqual(REMOVED);
    expect(res.stderr).toBe("");
  });

  it("warns, rather than reporting a clean success, when records were left behind", async () => {
    // The service unlinks the destination even when individual pages could not
    // be retracted, so a bare tick would tell an agent every page was taken
    // down while some are still live.
    const partial = {
      ...REMOVED,
      unpublished_count: 2,
      partial_failures: ["publish record 9f3 timed out", "publish record a12 was rejected"],
    };
    server.use(
      http.post(apiUrl("/org/destinations/:publisherId/remove"), () => HttpResponse.json(partial)),
    );

    const res = await runCli([
      "destinations",
      "remove",
      OWN_ID,
      "--action",
      "unpublish",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(0);
    expect(envelope(res).warnings?.[0]).toContain(
      "2 of 4 publish records could not be unpublished",
    );
    expect(envelope(res).next?.map((n) => n.command)).toContain(
      "senso publish-records retry <publish_record_id>",
    );
  });
});
