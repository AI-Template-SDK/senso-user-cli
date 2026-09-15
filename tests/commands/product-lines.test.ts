/**
 * Command layer: `senso product-lines`.
 *
 * A product line is a name plus an open-ended `details` blob, and that blob is
 * not inert: every scalar leaf of it becomes an APPROVED evidence item the
 * content generator may assert as fact. So losing a key out of `details` is not
 * a formatting problem, it is Senso publishing less than it knew — which makes
 * these the things worth protecting:
 *
 *   - THE SILENT REPLACE. `update` is a PUT whose `details` the API treats as
 *     required and does not enforce, so a body without it replaced the stored
 *     blob with {} and answered 200. The CLI refuses that body outright, and
 *     every call that replaces rather than merges says so in a warning the
 *     JSON envelope carries;
 *   - `patch` sends only the keys the caller passed, because the handler reads
 *     an absent key as "leave it alone" and one we invented would not;
 *   - whatever `--data` holds arrives byte-for-byte, nested objects and arrays
 *     intact, since the blob has no schema for the CLI to normalize against;
 *   - `list` reports that this endpoint's `total` is the size of the page and
 *     not the organization's row count.
 *
 * Failure branches come first, as in tests/commands/roles.test.ts.
 */

import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server, TEST_API_KEY } from "../setup.js";
import { apiUrl, envelope, errorEnvelope, runCli } from "../helpers.js";

const PL_1 = "4c8e1b2a-77d3-4f10-bb92-0e5d6a9c1f31";
const PL_2 = "7a2f9d64-3c81-4e57-b0a9-8d1c6e5f2b74";
const ORG = "0c9a1f47-2d58-4b3e-8a71-6f4d9e2c5b08";

/** dto.ProductLineResponse: the id field is `product_line_id`. */
const ONE_LINE = {
  product_line_id: PL_1,
  org_id: ORG,
  name: "Pro Plan",
  details: { positioning: { segment: "SMB" }, price_usd: 99, skus: ["PRO-M", "PRO-Y"] },
  created_at: "2026-01-02T03:04:05Z",
  updated_at: "2026-01-04T03:04:05Z",
};

/** dto.ProductLineListResponse. `total` is len(page), which the CLI warns about. */
const PRODUCT_LINES = {
  product_lines: [
    ONE_LINE,
    {
      product_line_id: PL_2,
      org_id: ORG,
      name: "Enterprise",
      details: {},
      created_at: "2026-01-05T03:04:05Z",
      updated_at: "2026-01-06T03:04:05Z",
    },
  ],
  total: 2,
  limit: 50,
  offset: 0,
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

  it("exits 3 and blames the plan when the 403 is about a missing product", async () => {
    // The commonest 403 here is not a scope: product lines belong to the GEO
    // product, and "ask an admin to widen your key" is advice that cannot work.
    server.use(
      http.post(apiUrl("/org/product-lines"), () =>
        HttpResponse.json({ error: "organization lacks product geo" }, { status: 403 }),
      ),
    );

    const res = await runCli([
      "product-lines",
      "create",
      "--data",
      '{"name":"Pro Plan","details":{}}',
    ]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Permission denied");
    expect(res.stderr).toContain("does not have the product");
  });

  it("names the product line and the id in the 404", async () => {
    server.use(
      http.get(apiUrl("/org/product-lines/:id"), () => new HttpResponse(null, { status: 404 })),
    );

    const res = await runCli(["product-lines", "get", PL_1, "--output", "json"]);

    expect(res.exitCode).toBe(4);
    expect(res.stdout).toBe("");
    const { error } = errorEnvelope(res);
    expect(error.code).toBe("not_found");
    expect(error.message).toContain(`Product line ${PL_1}`);
    expect(error.field).toBe("product_line_id");
    expect(error.hint).toContain("senso product-lines list");
  });

  it("exits 1 on a 409 when another product line already has that name", async () => {
    server.use(
      http.post(apiUrl("/org/product-lines"), () =>
        HttpResponse.json({ error: "product line already exists" }, { status: 409 }),
      ),
    );

    const res = await runCli([
      "product-lines",
      "create",
      "--data",
      '{"name":"Pro Plan","details":{}}',
    ]);

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("Conflict");
    expect(res.stderr).toContain("product line already exists");
  });

  it("exits 1 on a 503 and says retrying is not the answer", async () => {
    server.use(
      http.get(apiUrl("/org/product-lines"), () => new HttpResponse(null, { status: 503 })),
    );

    const res = await runCli(["product-lines", "list"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("not a transient failure");
  });

  it("exits 1 on a 502 and keeps the retry hint", async () => {
    server.use(
      http.get(apiUrl("/org/product-lines"), () => new HttpResponse(null, { status: 502 })),
    );

    const res = await runCli(["product-lines", "list"]);

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("Retry shortly");
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

  it("writes the failure to stderr as an error envelope, leaving stdout empty", async () => {
    server.use(
      http.get(apiUrl("/org/product-lines"), () =>
        HttpResponse.json({ error: "nope" }, { status: 403 }),
      ),
    );

    const res = await runCli(["product-lines", "list", "--output", "json"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");

    const reported = errorEnvelope(res);
    expect(reported.ok).toBe(false);
    expect(reported.command).toBe("product-lines list");
    expect(reported.error).toMatchObject({
      code: "forbidden",
      status: 403,
      request: { method: "GET", path: "/org/product-lines" },
    });
  });
});

describe("product-lines update, on the body that would have cleared details", () => {
  // The silent-success bug, and the reason `update` refuses a body it could
  // have sent: the API declares `details` required, never enforces it, and
  // answers 200 having replaced the stored blob with {}. No handler is
  // registered here, so these also prove the refusal happens before the call.
  it("exits 2 rather than sending a PUT that would replace the blob with {}", async () => {
    const res = await runCli([
      "product-lines",
      "update",
      PL_1,
      "--data",
      '{"name":"Pro Plan"}',
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    const { error } = errorEnvelope(res);
    expect(error.code).toBe("usage");
    expect(error.field).toBe("--data.details");
    expect(error.message).toContain("replace the stored details with {}");
  });

  it("offers patch for a name-only change, and the explicit body for a deliberate clear", async () => {
    const res = await runCli(["product-lines", "update", PL_1, "--data", '{"name":"Pro Plan"}']);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain(`senso product-lines patch ${PL_1}`);
    expect(res.stderr).toContain('"details":{}');
  });
});

describe("product-lines, on usage errors", () => {
  // Still no handler: nothing in this block may reach the network.
  it("exits 2 when create --data is not valid JSON", async () => {
    const res = await runCli(["product-lines", "create", "--data", "{name: Pro}"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Invalid JSON in --data");
  });

  it("exits 2 when --data is valid JSON but an array", async () => {
    const res = await runCli(["product-lines", "create", "--data", '[{"name":"Pro Plan"}]']);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("--data must be a JSON object");
    expect(res.stderr).toContain("an array");
  });

  it("exits 2 when patch --data is a bare number", async () => {
    const res = await runCli(["product-lines", "patch", PL_1, "--data", "99"]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("--data must be a JSON object");
  });

  it("names the key it did not recognize, because the API would ignore it", async () => {
    const res = await runCli([
      "product-lines",
      "create",
      "--data",
      '{"name":"Pro Plan","details":{},"detials":{}}',
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    const { error } = errorEnvelope(res);
    expect(error.received).toBe("detials");
    expect(error.allowed).toEqual(["name", "details"]);
  });

  it("exits 2 when `name` is blank after trimming", async () => {
    const res = await runCli([
      "product-lines",
      "create",
      "--data",
      '{"name":"   ","details":{}}',
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    expect(errorEnvelope(res).error.field).toBe("--data.name");
  });

  it("exits 2 when `details` is an array rather than an object", async () => {
    // All three of an array, a string and a number parse cleanly and all three
    // fail at the API as "invalid product line details JSON" — a 400, exit 1,
    // naming a cause that is not the real one.
    const res = await runCli([
      "product-lines",
      "create",
      "--data",
      '{"name":"Pro Plan","details":["PRO-M"]}',
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    const { error } = errorEnvelope(res);
    expect(error.field).toBe("--data.details");
    expect(error.message).toContain("got an array");
  });

  it("exits 2 when patch names neither `name` nor `details`", async () => {
    const res = await runCli(["product-lines", "patch", PL_1, "--data", "{}", "--output", "json"]);

    expect(res.exitCode).toBe(2);
    expect(errorEnvelope(res).error.allowed).toEqual(["name", "details"]);
  });

  it("exits 2 when the id is not a UUID", async () => {
    const res = await runCli(["product-lines", "get", "pl-1", "--output", "json"]);

    expect(res.exitCode).toBe(2);
    const { error } = errorEnvelope(res);
    expect(error.field).toBe("<id>");
    expect(error.received).toBe("pl-1");
  });

  it("exits 2 when --limit is not a whole number, rather than letting the API default it", async () => {
    // The API replaces a value it cannot parse with its default and echoes the
    // default back, so `--limit abc` returned 50 rows and reported limit 50.
    const res = await runCli(["product-lines", "list", "--limit", "abc"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("--limit");
  });

  it("exits 2 when --offset is negative", async () => {
    const res = await runCli(["product-lines", "list", "--offset", "-1"]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("--offset");
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

describe("product-lines create, update, patch and delete, on the wire", () => {
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
      details: { price_usd: 99, skus: ["PRO-M", "PRO-Y"], positioning: { segment: "SMB" } },
    };
    await runCli(["product-lines", "create", "--data", JSON.stringify(payload)]);

    expect(seen?.method).toBe("POST");
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/product-lines");
    expect(seen?.headers.get("content-type")).toBe("application/json");
    // Byte-for-byte: the blob has no schema, so anything the CLI normalized on
    // the way through would be silently lost evidence.
    expect(body).toEqual(payload);
  });

  it("GETs the product line's own path", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/product-lines/:id"), ({ request }) => {
        seen = request;
        return HttpResponse.json(ONE_LINE);
      }),
    );

    await runCli(["product-lines", "get", PL_1]);

    expect(seen?.method).toBe("GET");
    expect(new URL(seen?.url ?? "").pathname).toBe(`/api/v1/org/product-lines/${PL_1}`);
  });

  it("uses PUT for update, with both keys present", async () => {
    let seen: Request | undefined;
    let body: unknown;
    server.use(
      http.put(apiUrl("/org/product-lines/:id"), async ({ request }) => {
        seen = request;
        body = await request.json();
        return HttpResponse.json(ONE_LINE);
      }),
    );

    const payload = { name: "Pro Plan", details: { price_usd: 129 } };
    await runCli(["product-lines", "update", PL_1, "--data", JSON.stringify(payload)]);

    expect(seen?.method).toBe("PUT");
    expect(new URL(seen?.url ?? "").pathname).toBe(`/api/v1/org/product-lines/${PL_1}`);
    expect(body).toEqual(payload);
  });

  it("sends only the keys patch was given, because an absent one means 'leave it alone'", async () => {
    let seen: Request | undefined;
    let body: Record<string, unknown> | undefined;
    server.use(
      http.patch(apiUrl("/org/product-lines/:id"), async ({ request }) => {
        seen = request;
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ...ONE_LINE, name: "Pro Plan (2026)" });
      }),
    );

    await runCli(["product-lines", "patch", PL_1, "--data", '{"name":"Pro Plan (2026)"}']);

    // The whole reason both commands exist. A PUT here would erase `details`,
    // and a PATCH carrying an invented `details` would too.
    expect(seen?.method).toBe("PATCH");
    expect(body).toEqual({ name: "Pro Plan (2026)" });
    expect(body).not.toHaveProperty("details");
  });

  it("DELETEs the product line's own path", async () => {
    let seen: Request | undefined;
    server.use(
      http.delete(apiUrl("/org/product-lines/:id"), ({ request }) => {
        seen = request;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await runCli(["product-lines", "delete", PL_2]);

    expect(seen?.method).toBe("DELETE");
    expect(new URL(seen?.url ?? "").pathname).toBe(`/api/v1/org/product-lines/${PL_2}`);
  });
});

describe("product-lines list, on success", () => {
  it("prints the payload unmodified inside the envelope, and pages it", async () => {
    server.use(http.get(apiUrl("/org/product-lines"), () => HttpResponse.json(PRODUCT_LINES)));

    const res = await runCli(["product-lines", "list", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    const env = envelope<typeof PRODUCT_LINES>(res);
    expect(env.command).toBe("product-lines list");
    expect(env.data).toEqual(PRODUCT_LINES);
    expect(env.page).toMatchObject({ returned: 2, limit: 50, offset: 0, total: 2 });
    expect(res.stderr).toBe("");
  });

  it("warns a JSON caller that `total` here is the size of the page", async () => {
    // An org with 90 product lines reports "total": 2 on a 2-row page. A caller
    // that stopped at `total` would silently work from a tenth of the evidence.
    server.use(http.get(apiUrl("/org/product-lines"), () => HttpResponse.json(PRODUCT_LINES)));

    const res = await runCli(["product-lines", "list", "--output", "json"]);

    expect(envelope(res).warnings?.join(" ")).toContain("size of this page");
  });

  it("fills the product_line_id column under --output table", async () => {
    server.use(http.get(apiUrl("/org/product-lines"), () => HttpResponse.json(PRODUCT_LINES)));

    const res = await runCli(["product-lines", "list", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("product_line_id");
    expect(res.stdout).toContain(PL_1);
    expect(res.stdout).toContain("Enterprise");
    expect(res.stderr).not.toContain("which the API did not return");
  });

  it("renders a readable block per product line by default", async () => {
    server.use(http.get(apiUrl("/org/product-lines"), () => HttpResponse.json(PRODUCT_LINES)));

    const res = await runCli(["product-lines", "list"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Pro Plan");
    expect(res.stdout).toContain("Enterprise");
  });

  it("says so plainly, with the command that creates one, when there are none", async () => {
    server.use(
      http.get(apiUrl("/org/product-lines"), () =>
        HttpResponse.json({ product_lines: [], total: 0, limit: 50, offset: 0 }),
      ),
    );

    const res = await runCli(["product-lines", "list"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("No product lines found.");
    expect(res.stderr).toContain("senso product-lines create");
  });
});

describe("product-lines get, create, update and patch, on success", () => {
  it("prints one product line, details blob and all, under --output json", async () => {
    server.use(http.get(apiUrl("/org/product-lines/:id"), () => HttpResponse.json(ONE_LINE)));

    const res = await runCli(["product-lines", "get", PL_1, "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toEqual(ONE_LINE);
    expect(res.stderr).toBe("");
  });

  it("renders the nested details as sub-blocks rather than [object Object]", async () => {
    // `details` is the point of this command: burying it in a stringified blob
    // puts the evidence an agent came for inside a string it has to re-parse.
    server.use(http.get(apiUrl("/org/product-lines/:id"), () => HttpResponse.json(ONE_LINE)));

    const res = await runCli(["product-lines", "get", PL_1]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("segment");
    expect(res.stdout).toContain("SMB");
    expect(res.stdout).toContain("PRO-M");
    expect(res.stdout).not.toContain("[object Object]");
  });

  it("renders one product line as field/value rows under --output table", async () => {
    server.use(http.get(apiUrl("/org/product-lines/:id"), () => HttpResponse.json(ONE_LINE)));

    const res = await runCli(["product-lines", "get", PL_1, "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("field");
    expect(res.stdout).toContain("name");
    expect(res.stdout).toContain("Pro Plan");
  });

  it("prints the created product line on stdout and the tick on stderr", async () => {
    server.use(http.post(apiUrl("/org/product-lines"), () => HttpResponse.json(ONE_LINE)));

    const res = await runCli([
      "product-lines",
      "create",
      "--data",
      '{"name":"Pro Plan","details":{}}',
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain(PL_1);
    expect(res.stdout).not.toContain("✓");
    expect(res.stderr).toContain("Created product line");
  });

  it("tells a JSON caller that the new details are now approved evidence", async () => {
    server.use(http.post(apiUrl("/org/product-lines"), () => HttpResponse.json(ONE_LINE)));

    const res = await runCli([
      "product-lines",
      "create",
      "--data",
      '{"name":"Pro Plan","details":{"price_usd":99}}',
      "--output",
      "json",
    ]);

    expect(envelope(res).warnings?.join(" ")).toContain("approved evidence");
  });

  it("warns that update replaced the whole blob, not merged into it", async () => {
    server.use(http.put(apiUrl("/org/product-lines/:id"), () => HttpResponse.json(ONE_LINE)));

    const res = await runCli([
      "product-lines",
      "update",
      PL_1,
      "--data",
      '{"name":"Pro Plan","details":{"price_usd":129}}',
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(0);
    const env = envelope(res);
    expect(env.warnings?.join(" ")).toContain("replaced `details` wholesale");
    expect(env.next?.[0]?.command).toBe(`senso product-lines get ${PL_1}`);
  });

  it("warns that patch REPLACED details, and shows the jq that merges instead", async () => {
    server.use(http.patch(apiUrl("/org/product-lines/:id"), () => HttpResponse.json(ONE_LINE)));

    const res = await runCli([
      "product-lines",
      "patch",
      PL_1,
      "--data",
      '{"details":{"price_usd":129}}',
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(0);
    const warnings = envelope(res).warnings?.join(" ") ?? "";
    expect(warnings).toContain("replaced, not merged");
    expect(warnings).toContain(".data.details");
  });

  it("says nothing about details when patch did not touch them", async () => {
    server.use(
      http.patch(apiUrl("/org/product-lines/:id"), () =>
        HttpResponse.json({ ...ONE_LINE, name: "Pro Plan (2026)" }),
      ),
    );

    const res = await runCli([
      "product-lines",
      "patch",
      PL_1,
      "--data",
      '{"name":"Pro Plan (2026)"}',
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(0);
    expect(envelope(res).warnings).toBeUndefined();
  });

  it("names the fields it patched on stderr", async () => {
    server.use(http.patch(apiUrl("/org/product-lines/:id"), () => HttpResponse.json(ONE_LINE)));

    const res = await runCli(["product-lines", "patch", PL_1, "--data", '{"name":"Pro Plan"}']);

    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain("fields: name");
    expect(res.stdout).not.toContain("✓");
  });
});

describe("product-lines delete, on confirmation", () => {
  it("puts the tick on stderr and leaves stdout empty in plain mode", async () => {
    server.use(
      http.delete(apiUrl("/org/product-lines/:id"), () => new HttpResponse(null, { status: 204 })),
    );

    const res = await runCli(["product-lines", "delete", PL_1]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Deleted product line");
    expect(res.stderr).toContain("--product-line-ids");
  });

  it("gives a JSON caller a record of what went, not a sentence to parse", async () => {
    server.use(
      http.delete(apiUrl("/org/product-lines/:id"), () => new HttpResponse(null, { status: 204 })),
    );

    const res = await runCli(["product-lines", "delete", PL_1, "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toEqual({ action: "deleted", resource: "product_line", id: PL_1 });
    expect(res.stderr).toBe("");
  });
});
