/**
 * Command layer: `senso product-lines`.
 *
 * A product line is a name plus an open-ended `details` blob that downstream
 * generation and evaluation pipelines carry around. Because the blob has no
 * schema, the CLI cannot validate it — which makes two things the only real
 * guarantees this group offers, and the ones worth protecting:
 *
 *   - whatever `--data` holds arrives at the API byte-for-byte, nested objects
 *     and arrays intact, so nothing is flattened or dropped in transit;
 *   - `update` is a PUT and `patch` is a PATCH, because sending a partial blob
 *     with the wrong one throws away every key the caller did not retype.
 *
 * Plus the usual: bad `--data` is a usage error before any request, and stdout
 * stays empty on failure.
 *
 * Failure branches come first, as in tests/commands/roles.test.ts.
 */

import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server, TEST_API_KEY } from "../setup.js";
import { apiUrl, runCli } from "../helpers.js";

const PRODUCT_LINES = {
  product_lines: [
    {
      product_line_id: "pl-1",
      name: "Pro Plan",
      created_at: "2026-01-02T03:04:05Z",
      updated_at: "2026-01-04T03:04:05Z",
    },
    {
      product_line_id: "pl-2",
      name: "Enterprise",
      created_at: "2026-01-05T03:04:05Z",
      updated_at: "2026-01-06T03:04:05Z",
    },
  ],
};

const ONE_LINE = {
  product_line_id: "pl-1",
  name: "Pro Plan",
  details: { price: 99, skus: ["PRO-M", "PRO-Y"], positioning: { segment: "SMB" } },
};

describe("product-lines, when the request fails", () => {
  it("exits 3 and explains how to authenticate when there is no API key", async () => {
    const res = await runCli(["product-lines", "list"], { withKey: false });

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("no API key found");
    expect(res.stderr).toContain("SENSO_API_KEY");
  });

  it("exits 3 when the API rejects the key", async () => {
    server.use(
      http.get(apiUrl("/org/product-lines"), () =>
        HttpResponse.json({ error: "invalid key" }, { status: 401 }),
      ),
    );

    const res = await runCli(["product-lines", "list"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Authentication failed");
  });

  it("exits 3 when the key is valid but lacks the scope", async () => {
    server.use(
      http.post(apiUrl("/org/product-lines"), () =>
        HttpResponse.json({ error: "write:product_lines required" }, { status: 403 }),
      ),
    );

    const res = await runCli(["product-lines", "create", "--data", '{"name":"Pro Plan"}']);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Permission denied");
  });

  it("exits 4 when the product line does not exist", async () => {
    server.use(
      http.get(apiUrl("/org/product-lines/:id"), () => new HttpResponse(null, { status: 404 })),
    );

    const res = await runCli(["product-lines", "get", "pl-missing"]);

    expect(res.exitCode).toBe(4);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Not found");
  });

  it("exits 1 on a 500 and says it is not the caller's fault", async () => {
    server.use(
      http.get(apiUrl("/org/product-lines"), () => new HttpResponse(null, { status: 503 })),
    );

    const res = await runCli(["product-lines", "list"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("not your fault");
  });

  it("exits 5 on a connection failure, however the runtime worded it", async () => {
    // toCliError decides "this was the network" from the message. Node's undici
    // says "fetch failed"; the WHATWG wording, which other fetch implementations
    // and test doubles use, is "Failed to fetch". Matching only Node's spelling
    // sent an equivalent failure down the generic exit-1 path, so a caller lost
    // the retry signal that exit 5 exists to carry.
    server.use(http.get(apiUrl("/org/product-lines"), () => HttpResponse.error()));

    const res = await runCli(["product-lines", "list"]);

    expect(res.exitCode).toBe(5);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Could not reach the Senso API");
  });

  it("writes the failure to stderr as JSON, leaving stdout empty, under --output json", async () => {
    server.use(
      http.get(apiUrl("/org/product-lines"), () =>
        HttpResponse.json({ error: "nope" }, { status: 403 }),
      ),
    );

    const res = await runCli(["product-lines", "list", "--output", "json"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");

    const reported: unknown = JSON.parse(res.stderr);
    expect(reported).toMatchObject({ error: { code: "forbidden", status: 403 } });
  });
});

describe("product-lines, on usage errors", () => {
  // No handler is registered in this block: setup.ts fails any request that
  // reaches the network, so these also prove nothing was sent.
  it("exits 2 when create --data is not valid JSON", async () => {
    const res = await runCli(["product-lines", "create", "--data", "{name: Pro}"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Invalid JSON in --data");
  });

  it("exits 2 when update --data is not valid JSON", async () => {
    const res = await runCli(["product-lines", "update", "pl-1", "--data", "{"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Invalid JSON in --data");
  });

  it("exits 2 when patch --data is not valid JSON", async () => {
    const res = await runCli(["product-lines", "patch", "pl-1", "--data", "99"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    // Valid JSON, but a number is not a body any of these endpoints accept.
    expect(res.stderr).toContain("--data must be a JSON object");
  });

  it("exits 2 when --data is valid JSON but an array", async () => {
    const res = await runCli(["product-lines", "create", "--data", '[{"name":"Pro Plan"}]']);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("--data must be a JSON object");
    expect(res.stderr).toContain("an array");
  });

  it("exits 2 when create is called without --data at all", async () => {
    const res = await runCli(["product-lines", "create"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
  });
});

describe("product-lines list, on the wire", () => {
  it("GETs /org/product-lines with no query string when no paging flags are given", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/product-lines"), ({ request }) => {
        seen = request;
        return HttpResponse.json(PRODUCT_LINES);
      }),
    );

    await runCli(["product-lines", "list"]);

    expect(seen?.method).toBe("GET");
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/product-lines");
    // An undefined param must be dropped, not sent as the string "undefined".
    expect(new URL(seen?.url ?? "").search).toBe("");
    expect(seen?.headers.get("x-api-key")).toBe(TEST_API_KEY);
  });

  it("sends --limit and --offset as the limit and offset query parameters", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/product-lines"), ({ request }) => {
        seen = request;
        return HttpResponse.json(PRODUCT_LINES);
      }),
    );

    await runCli(["product-lines", "list", "--limit", "10", "--offset", "20"]);

    const params = new URL(seen?.url ?? "").searchParams;
    expect(params.get("limit")).toBe("10");
    expect(params.get("offset")).toBe("20");
  });

  it("sends only the paging parameter that was given", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/product-lines"), ({ request }) => {
        seen = request;
        return HttpResponse.json(PRODUCT_LINES);
      }),
    );

    await runCli(["product-lines", "list", "--offset", "20"]);

    const params = new URL(seen?.url ?? "").searchParams;
    expect(params.get("offset")).toBe("20");
    expect(params.has("limit")).toBe(false);
  });
});

describe("product-lines create, on the wire", () => {
  it("POSTs the parsed --data object verbatim, nested details intact", async () => {
    let body: unknown;
    let seen: Request | undefined;
    server.use(
      http.post(apiUrl("/org/product-lines"), async ({ request }) => {
        seen = request;
        body = await request.json();
        return HttpResponse.json(ONE_LINE);
      }),
    );

    const payload = {
      name: "Pro Plan",
      details: { price: 99, skus: ["PRO-M", "PRO-Y"], positioning: { segment: "SMB" } },
    };
    await runCli(["product-lines", "create", "--data", JSON.stringify(payload)]);

    expect(seen?.method).toBe("POST");
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/product-lines");
    expect(seen?.headers.get("content-type")).toBe("application/json");
    // Byte-for-byte: the details blob has no schema, so anything the CLI
    // normalized on the way through would be silently lost data.
    expect(body).toEqual(payload);
  });
});

describe("product-lines get, on the wire", () => {
  it("GETs the product line's own path", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/product-lines/:id"), ({ request }) => {
        seen = request;
        return HttpResponse.json(ONE_LINE);
      }),
    );

    await runCli(["product-lines", "get", "pl-1"]);

    expect(seen?.method).toBe("GET");
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/product-lines/pl-1");
  });
});

describe("product-lines update and patch, on the wire", () => {
  it("uses PUT for update, so the body replaces the record", async () => {
    let seen: Request | undefined;
    let body: unknown;
    server.use(
      http.put(apiUrl("/org/product-lines/:id"), async ({ request }) => {
        seen = request;
        body = await request.json();
        return HttpResponse.json(ONE_LINE);
      }),
    );

    const payload = { name: "Pro Plan", details: { price: 129 } };
    await runCli(["product-lines", "update", "pl-1", "--data", JSON.stringify(payload)]);

    expect(seen?.method).toBe("PUT");
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/product-lines/pl-1");
    expect(body).toEqual(payload);
  });

  it("uses PATCH for patch, so untouched fields survive", async () => {
    let seen: Request | undefined;
    let body: unknown;
    server.use(
      http.patch(apiUrl("/org/product-lines/:id"), async ({ request }) => {
        seen = request;
        body = await request.json();
        return HttpResponse.json(ONE_LINE);
      }),
    );

    const payload = { details: { price: 129 } };
    await runCli(["product-lines", "patch", "pl-1", "--data", JSON.stringify(payload)]);

    // The whole reason both commands exist. A PUT here would erase `name`.
    expect(seen?.method).toBe("PATCH");
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/product-lines/pl-1");
    expect(body).toEqual(payload);
  });
});

describe("product-lines delete, on the wire", () => {
  it("DELETEs the product line's own path", async () => {
    let seen: Request | undefined;
    server.use(
      http.delete(apiUrl("/org/product-lines/:id"), ({ request }) => {
        seen = request;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await runCli(["product-lines", "delete", "pl-2"]);

    expect(seen?.method).toBe("DELETE");
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/product-lines/pl-2");
  });
});

describe("product-lines, on success", () => {
  it("prints the list payload unmodified under --output json", async () => {
    server.use(http.get(apiUrl("/org/product-lines"), () => HttpResponse.json(PRODUCT_LINES)));

    const res = await runCli(["product-lines", "list", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.json()).toEqual(PRODUCT_LINES);
    expect(res.stderr).toBe("");
  });

  it("renders one row per product line under --output table", async () => {
    server.use(http.get(apiUrl("/org/product-lines"), () => HttpResponse.json(PRODUCT_LINES)));

    const res = await runCli(["product-lines", "list", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("product_line_id");
    expect(res.stdout).toContain("pl-1");
    expect(res.stdout).toContain("Enterprise");
  });

  it("renders a readable block per product line by default", async () => {
    server.use(http.get(apiUrl("/org/product-lines"), () => HttpResponse.json(PRODUCT_LINES)));

    const res = await runCli(["product-lines", "list"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Pro Plan");
    expect(res.stdout).toContain("Enterprise");
  });

  it("prints one product line, details blob and all, under --output json", async () => {
    server.use(http.get(apiUrl("/org/product-lines/:id"), () => HttpResponse.json(ONE_LINE)));

    const res = await runCli(["product-lines", "get", "pl-1", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.json()).toEqual(ONE_LINE);
    expect(res.stderr).toBe("");
  });

  it("renders one product line as field/value rows under --output table", async () => {
    server.use(http.get(apiUrl("/org/product-lines/:id"), () => HttpResponse.json(ONE_LINE)));

    const res = await runCli(["product-lines", "get", "pl-1", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("field");
    expect(res.stdout).toContain("name");
    expect(res.stdout).toContain("Pro Plan");
  });

  it("serializes the nested details blob rather than printing [object Object]", async () => {
    server.use(http.get(apiUrl("/org/product-lines/:id"), () => HttpResponse.json(ONE_LINE)));

    const res = await runCli(["product-lines", "get", "pl-1"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("PRO-M");
    expect(res.stdout).not.toContain("[object Object]");
  });

  it("prints the created product line on stdout and the tick on stderr", async () => {
    server.use(http.post(apiUrl("/org/product-lines"), () => HttpResponse.json(ONE_LINE)));

    const res = await runCli(["product-lines", "create", "--data", '{"name":"Pro Plan"}']);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("pl-1");
    expect(res.stdout).not.toContain("✓");
    expect(res.stderr).toContain("created");
  });
});

describe("product-lines delete, on confirmation", () => {
  it("puts the tick on stderr and leaves stdout empty in plain mode", async () => {
    server.use(
      http.delete(apiUrl("/org/product-lines/:id"), () => new HttpResponse(null, { status: 204 })),
    );

    const res = await runCli(["product-lines", "delete", "pl-1"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("deleted");
  });

  it("prints a parseable object on stdout under --output json", async () => {
    server.use(
      http.delete(apiUrl("/org/product-lines/:id"), () => new HttpResponse(null, { status: 204 })),
    );

    const res = await runCli(["product-lines", "delete", "pl-1", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.json()).toMatchObject({ ok: true });
    expect(res.stderr).toBe("");
  });
});
