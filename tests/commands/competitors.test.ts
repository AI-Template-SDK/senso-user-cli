/**
 * Command layer: `senso competitors`.
 *
 * The group is small but it exercises three things that are easy to break and
 * expensive to break silently:
 *
 *   - `add` and `update` assemble the request body by hand, so an omitted
 *     `--url` must leave `url` out of the JSON rather than send `undefined`;
 *   - `batch-add` forwards a raw `--data` blob, which makes it the group's
 *     usage-error surface: bad JSON has to fail before a request is made;
 *   - `delete` has no payload, so its confirmation must reach stderr in plain
 *     mode and stdout as a parseable object under `--output json`.
 *
 * Failure branches come first, as in tests/commands/roles.test.ts. They are the
 * cases a caller actually has to handle.
 */

import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server, TEST_API_KEY } from "../setup.js";
import { apiUrl, runCli } from "../helpers.js";

const COMPETITORS = {
  competitors: [
    {
      competitor_id: "c-1",
      name: "Acme",
      url: "https://acme.example",
      source: "manual",
      created_at: "2026-01-02T03:04:05Z",
    },
    {
      competitor_id: "c-2",
      name: "Globex",
      url: "https://globex.example",
      source: "suggested_web_search",
      created_at: "2026-01-03T03:04:05Z",
    },
  ],
};

const ONE_COMPETITOR = {
  competitor_id: "c-1",
  name: "Acme",
  url: "https://acme.example",
  source: "manual",
};

describe("competitors, when the request fails", () => {
  it("exits 3 and explains how to authenticate when there is no API key", async () => {
    const res = await runCli(["competitors", "list"], { withKey: false });

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("no API key found");
    expect(res.stderr).toContain("SENSO_API_KEY");
  });

  it("exits 3 when the API rejects the key", async () => {
    server.use(
      http.get(apiUrl("/org/competitors"), () =>
        HttpResponse.json({ error: "invalid key" }, { status: 401 }),
      ),
    );

    const res = await runCli(["competitors", "list"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Authentication failed");
  });

  it("exits 3 when the key is valid but lacks the scope", async () => {
    server.use(
      http.post(apiUrl("/org/competitors"), () =>
        HttpResponse.json({ error: "write:competitors required" }, { status: 403 }),
      ),
    );

    const res = await runCli(["competitors", "add", "--name", "Acme"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Permission denied");
  });

  it("exits 4 when the competitor does not exist", async () => {
    server.use(
      http.delete(apiUrl("/org/competitors/:id"), () => new HttpResponse(null, { status: 404 })),
    );

    const res = await runCli(["competitors", "delete", "c-missing"]);

    expect(res.exitCode).toBe(4);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Not found");
  });

  it("exits 1 on a 500 and says it is not the caller's fault", async () => {
    server.use(http.get(apiUrl("/org/competitors"), () => new HttpResponse(null, { status: 500 })));

    const res = await runCli(["competitors", "list"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("not your fault");
  });

  it("exits 5 when the API rate limits the caller", async () => {
    server.use(
      http.post(apiUrl("/org/competitors/suggest"), () => new HttpResponse(null, { status: 429 })),
    );

    const res = await runCli(["competitors", "suggest"]);

    expect(res.exitCode).toBe(5);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Rate limited");
  });

  it("writes the failure to stderr as JSON, leaving stdout empty, under --output json", async () => {
    server.use(
      http.get(apiUrl("/org/competitors"), () =>
        HttpResponse.json({ error: "nope" }, { status: 403 }),
      ),
    );

    const res = await runCli(["competitors", "list", "--output", "json"]);

    expect(res.exitCode).toBe(3);
    // A caller redirecting stdout to a file gets an empty file, not a file
    // containing an error object it would later read as data.
    expect(res.stdout).toBe("");

    const reported: unknown = JSON.parse(res.stderr);
    expect(reported).toMatchObject({ error: { code: "forbidden", status: 403 } });
  });
});

describe("competitors, on usage errors", () => {
  it("exits 2 when --data is not valid JSON, without making a request", async () => {
    // No handler is registered: setup.ts fails any request that reaches the
    // network, so this test also proves the parse happens first.
    const res = await runCli(["competitors", "batch-add", "--data", "{items:[]}"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Invalid JSON in --data");
  });

  it("exits 2 when --data is valid JSON but not an object", async () => {
    const res = await runCli(["competitors", "batch-add", "--data", '[{"name":"Acme"}]']);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("--data must be a JSON object");
  });

  it("exits 2 when a required flag is missing, and names the flag", async () => {
    // The message is assertable because tests/helpers.ts routes Commander's own
    // output into the captured streams. Commander writes usage errors straight
    // to process.stderr rather than through console, so before that these cases
    // could only check the exit code — and the text leaked into the runner's
    // output as unattributed noise.
    const res = await runCli(["competitors", "add"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("--name");
  });

  it("exits 2 on a flag the command does not have", async () => {
    const res = await runCli(["competitors", "list", "--nonsense"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("--nonsense");
  });
});

describe("competitors list, on the wire", () => {
  it("GETs /org/competitors with the API key and no query string", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/competitors"), ({ request }) => {
        seen = request;
        return HttpResponse.json(COMPETITORS);
      }),
    );

    await runCli(["competitors", "list"]);

    expect(seen?.method).toBe("GET");
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/competitors");
    expect(new URL(seen?.url ?? "").search).toBe("");
    expect(seen?.headers.get("x-api-key")).toBe(TEST_API_KEY);
  });
});

describe("competitors add, on the wire", () => {
  it("POSTs the name, and omits url entirely when --url was not passed", async () => {
    let body: unknown;
    let seen: Request | undefined;
    server.use(
      http.post(apiUrl("/org/competitors"), async ({ request }) => {
        seen = request;
        body = await request.json();
        return HttpResponse.json(ONE_COMPETITOR);
      }),
    );

    await runCli(["competitors", "add", "--name", "Acme"]);

    expect(seen?.method).toBe("POST");
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/competitors");
    // Exactly `{ name }` — an absent optional flag must not become a null or
    // an "undefined" string in the body.
    expect(body).toEqual({ name: "Acme" });
  });

  it("includes url when --url is passed", async () => {
    let body: unknown;
    server.use(
      http.post(apiUrl("/org/competitors"), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(ONE_COMPETITOR);
      }),
    );

    await runCli(["competitors", "add", "--name", "Acme", "--url", "https://acme.example"]);

    expect(body).toEqual({ name: "Acme", url: "https://acme.example" });
  });
});

describe("competitors batch-add, on the wire", () => {
  it("POSTs the parsed --data object verbatim to /org/competitors/batch", async () => {
    let body: unknown;
    let seen: Request | undefined;
    server.use(
      http.post(apiUrl("/org/competitors/batch"), async ({ request }) => {
        seen = request;
        body = await request.json();
        return HttpResponse.json({ created: 2 });
      }),
    );

    const payload = {
      items: [
        { name: "Acme", url: "https://acme.example", source: "manual" },
        { name: "Globex", source: "suggested_run_text", confidence: 0.85 },
      ],
    };
    await runCli(["competitors", "batch-add", "--data", JSON.stringify(payload)]);

    expect(seen?.method).toBe("POST");
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/competitors/batch");
    expect(seen?.headers.get("content-type")).toBe("application/json");
    // Verbatim: the CLI is a transport here, not a translator.
    expect(body).toEqual(payload);
  });
});

describe("competitors suggest, on the wire", () => {
  it("POSTs to /org/competitors/suggest with no body", async () => {
    let seen: Request | undefined;
    let raw = "unset";
    server.use(
      http.post(apiUrl("/org/competitors/suggest"), async ({ request }) => {
        seen = request;
        raw = await request.text();
        return HttpResponse.json({ suggestions: [] });
      }),
    );

    await runCli(["competitors", "suggest"]);

    expect(seen?.method).toBe("POST");
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/competitors/suggest");
    expect(raw).toBe("");
  });
});

describe("competitors update, on the wire", () => {
  it("PUTs to the competitor's own path with the new name", async () => {
    let body: unknown;
    let seen: Request | undefined;
    server.use(
      http.put(apiUrl("/org/competitors/:id"), async ({ request }) => {
        seen = request;
        body = await request.json();
        return HttpResponse.json({ ...ONE_COMPETITOR, name: "Acme Corp" });
      }),
    );

    await runCli(["competitors", "update", "c-1", "--name", "Acme Corp"]);

    expect(seen?.method).toBe("PUT");
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/competitors/c-1");
    expect(body).toEqual({ name: "Acme Corp" });
  });

  it("carries --url through when given", async () => {
    let body: unknown;
    server.use(
      http.put(apiUrl("/org/competitors/:id"), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(ONE_COMPETITOR);
      }),
    );

    await runCli([
      "competitors",
      "update",
      "c-1",
      "--name",
      "Acme Corp",
      "--url",
      "https://acme.example/new",
    ]);

    expect(body).toEqual({ name: "Acme Corp", url: "https://acme.example/new" });
  });
});

describe("competitors delete, on the wire", () => {
  it("DELETEs the competitor's own path with no body", async () => {
    let seen: Request | undefined;
    server.use(
      http.delete(apiUrl("/org/competitors/:id"), ({ request }) => {
        seen = request;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await runCli(["competitors", "delete", "c-1"]);

    expect(seen?.method).toBe("DELETE");
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/competitors/c-1");
  });
});

describe("competitors, on success", () => {
  it("prints the list payload unmodified under --output json", async () => {
    server.use(http.get(apiUrl("/org/competitors"), () => HttpResponse.json(COMPETITORS)));

    const res = await runCli(["competitors", "list", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.json()).toEqual(COMPETITORS);
    // json implies quiet: no banner, no success tick alongside it.
    expect(res.stderr).toBe("");
  });

  it("renders one row per competitor under --output table", async () => {
    server.use(http.get(apiUrl("/org/competitors"), () => HttpResponse.json(COMPETITORS)));

    const res = await runCli(["competitors", "list", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("competitor_id");
    expect(res.stdout).toContain("c-1");
    expect(res.stdout).toContain("Globex");
  });

  it("renders a readable block per competitor by default", async () => {
    server.use(http.get(apiUrl("/org/competitors"), () => HttpResponse.json(COMPETITORS)));

    const res = await runCli(["competitors", "list"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Acme");
    expect(res.stdout).toContain("https://globex.example");
  });

  it("prints the created competitor on stdout and the tick on stderr", async () => {
    server.use(http.post(apiUrl("/org/competitors"), () => HttpResponse.json(ONE_COMPETITOR)));

    const res = await runCli(["competitors", "add", "--name", "Acme"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Acme");
    expect(res.stdout).not.toContain("✓");
    expect(res.stderr).toContain("added");
  });

  it("renders a single competitor as field/value rows under --output table", async () => {
    server.use(http.post(apiUrl("/org/competitors"), () => HttpResponse.json(ONE_COMPETITOR)));

    const res = await runCli(["competitors", "add", "--name", "Acme", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("field");
    expect(res.stdout).toContain("competitor_id");
    expect(res.stdout).toContain("c-1");
  });

  it("returns the created competitor unmodified under --output json", async () => {
    server.use(http.post(apiUrl("/org/competitors"), () => HttpResponse.json(ONE_COMPETITOR)));

    const res = await runCli(["competitors", "add", "--name", "Acme", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.json()).toEqual(ONE_COMPETITOR);
    expect(res.stderr).toBe("");
  });
});

describe("competitors delete, on confirmation", () => {
  it("puts the tick on stderr and leaves stdout empty in plain mode", async () => {
    server.use(
      http.delete(apiUrl("/org/competitors/:id"), () => new HttpResponse(null, { status: 204 })),
    );

    const res = await runCli(["competitors", "delete", "c-1"]);

    expect(res.exitCode).toBe(0);
    // Nothing was returned, so nothing is payload. A caller piping this gets an
    // empty stream rather than a sentence.
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("removed");
  });

  it("prints a parseable object on stdout under --output json", async () => {
    server.use(
      http.delete(apiUrl("/org/competitors/:id"), () => new HttpResponse(null, { status: 204 })),
    );

    const res = await runCli(["competitors", "delete", "c-1", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.json()).toMatchObject({ ok: true });
    expect(res.stderr).toBe("");
  });
});
