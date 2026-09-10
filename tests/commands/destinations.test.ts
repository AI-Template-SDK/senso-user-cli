/**
 * Command layer: `senso destinations`.
 *
 * This is the one group in the CLI that validates its enums before touching the
 * network, and the one where getting it wrong is destructive: `remove --action
 * delete` unpublishes live articles AND hard-deletes the local records. So what
 * is worth protecting here is the guard rail as much as the request:
 *
 *   - an invalid `--type` or `--action` must exit 2, name the values that are
 *     valid, and make no request at all;
 *   - the value that does reach the API must be the lower-cased one, since the
 *     check is case-insensitive but the API is not;
 *   - `remove` must always send all three body fields, because the two boolean
 *     flags decide whether a domain registration survives, and an absent field
 *     is not the same promise as an explicit `false`.
 *
 * Failure branches come first, as in tests/commands/roles.test.ts.
 */

import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server, TEST_API_KEY } from "../setup.js";
import { apiUrl, runCli } from "../helpers.js";

const DESTINATIONS = {
  destinations: [
    {
      publisher_id: "pub-1",
      name: "Citeables",
      domain: "citeables.com",
      type: "citeables",
      selected_for_generation: true,
    },
    {
      publisher_id: "pub-2",
      name: "Example Citeables",
      domain: "content.example.com",
      type: "citeables",
      selected_for_generation: false,
    },
  ],
};

const ONE_DESTINATION = {
  publisher_id: "pub-2",
  name: "Example Citeables",
  domain: "content.example.com",
  type: "citeables",
  selected_for_generation: false,
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
        HttpResponse.json({ error: "write:destinations required" }, { status: 403 }),
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

  it("exits 4 when the destination does not exist", async () => {
    server.use(
      http.post(
        apiUrl("/org/destinations/:publisherId/remove"),
        () => new HttpResponse(null, { status: 404 }),
      ),
    );

    const res = await runCli(["destinations", "remove", "pub-missing", "--action", "leave"]);

    expect(res.exitCode).toBe(4);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Not found");
  });

  it("exits 1 on a 500 and says it is not the caller's fault", async () => {
    server.use(
      http.get(apiUrl("/org/destinations"), () => new HttpResponse(null, { status: 500 })),
    );

    const res = await runCli(["destinations", "list"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("not your fault");
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

    const reported: unknown = JSON.parse(res.stderr);
    expect(reported).toMatchObject({ error: { code: "forbidden", status: 403 } });
  });
});

describe("destinations add, on an invalid --type", () => {
  // No handler is registered in this block: setup.ts fails any request that
  // reaches the network, so each of these also proves the guard ran first.
  it("exits 2 and names all three valid types", async () => {
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
    expect(res.stderr).toContain('Invalid --type "wordpress"');
    expect(res.stderr).toContain("citeables");
    expect(res.stderr).toContain("codeables");
    expect(res.stderr).toContain("cucopilot");
  });

  it("reports the rejected type as usage, with the valid values, under --output json", async () => {
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

    const reported = JSON.parse(res.stderr) as { error: { code: string; hint: string } };
    expect(reported.error.code).toBe("usage");
    // The hint is the machine-readable half of "here is what you may pass".
    expect(reported.error.hint).toContain("citeables, codeables, cucopilot");
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
    expect(res.stderr).toContain("citeables, codeables, cucopilot");
  });

  it("exits 2 when a required flag is missing", async () => {
    const res = await runCli(["destinations", "add", "--domain", "content.example.com"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
  });
});

describe("destinations remove, on an invalid --action", () => {
  it("exits 2 and names all three valid actions", async () => {
    const res = await runCli(["destinations", "remove", "pub-2", "--action", "purge"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain('Invalid --action "purge"');
    expect(res.stderr).toContain("leave");
    expect(res.stderr).toContain("unpublish");
    expect(res.stderr).toContain("delete");
  });

  it("reports the rejected action as usage, with the valid values, under --output json", async () => {
    const res = await runCli([
      "destinations",
      "remove",
      "pub-2",
      "--action",
      "purge",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");

    const reported = JSON.parse(res.stderr) as { error: { code: string; hint: string } };
    expect(reported.error.code).toBe("usage");
    expect(reported.error.hint).toContain("leave, unpublish, delete");
  });

  it("exits 2 when --action is missing, since there is no safe default", async () => {
    const res = await runCli(["destinations", "remove", "pub-2"]);

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

  it("sends the lower-cased type, so --type CODEABLES is accepted and normalized", async () => {
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
      "code.example.com",
      "--name",
      "Example Codeables",
      "--type",
      "CODEABLES",
    ]);

    // The check is case-insensitive; the API is not. Sending "CODEABLES" here
    // would be accepted by the CLI and rejected by the server.
    expect(body).toMatchObject({ type: "codeables" });
  });

  it("carries a cucopilot destination through as itself", async () => {
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
      "copilot.example.com",
      "--name",
      "Example Copilot",
      "--type",
      "cucopilot",
    ]);

    expect(body).toEqual({
      type: "cucopilot",
      name: "Example Copilot",
      domain: "copilot.example.com",
    });
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
        return HttpResponse.json({ removed: true });
      }),
    );

    await runCli(["destinations", "remove", "pub-2", "--action", "leave"]);

    expect(seen?.method).toBe("POST");
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/destinations/pub-2/remove");
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
        return HttpResponse.json({ removed: true });
      }),
    );

    await runCli([
      "destinations",
      "remove",
      "pub-2",
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
        return HttpResponse.json({ removed: true });
      }),
    );

    await runCli(["destinations", "remove", "pub-2", "--action", "DELETE"]);

    expect(body).toMatchObject({ action: "delete" });
  });
});

describe("destinations, on success", () => {
  it("prints the list payload unmodified under --output json", async () => {
    server.use(http.get(apiUrl("/org/destinations"), () => HttpResponse.json(DESTINATIONS)));

    const res = await runCli(["destinations", "list", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.json()).toEqual(DESTINATIONS);
    expect(res.stderr).toBe("");
  });

  it("renders one row per destination under --output table", async () => {
    server.use(http.get(apiUrl("/org/destinations"), () => HttpResponse.json(DESTINATIONS)));

    const res = await runCli(["destinations", "list", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    // publisher_id, because that is the value `remove` takes.
    expect(res.stdout).toContain("publisher_id");
    expect(res.stdout).toContain("pub-1");
    expect(res.stdout).toContain("content.example.com");
  });

  it("renders a readable block per destination by default", async () => {
    server.use(http.get(apiUrl("/org/destinations"), () => HttpResponse.json(DESTINATIONS)));

    const res = await runCli(["destinations", "list"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Citeables");
    expect(res.stdout).toContain("selected_for_generation");
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
    expect(res.stdout).toContain("pub-2");
    expect(res.stdout).not.toContain("✓");
    expect(res.stderr).toContain("registered");
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
      http.post(apiUrl("/org/destinations/:publisherId/remove"), () =>
        HttpResponse.json({ removed: true, unpublished: 4 }),
      ),
    );

    const res = await runCli(["destinations", "remove", "pub-2", "--action", "unpublish"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("unpublished");
    expect(res.stdout).not.toContain("✓");
    expect(res.stderr).toContain("removed");
  });

  it("returns the removal result unmodified under --output json", async () => {
    const result = { removed: true, unpublished: 4 };
    server.use(
      http.post(apiUrl("/org/destinations/:publisherId/remove"), () => HttpResponse.json(result)),
    );

    const res = await runCli([
      "destinations",
      "remove",
      "pub-2",
      "--action",
      "delete",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.json()).toEqual(result);
    expect(res.stderr).toBe("");
  });
});
