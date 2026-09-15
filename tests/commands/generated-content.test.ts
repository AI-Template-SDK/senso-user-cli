/**
 * Command layer: `senso generated-content`.
 *
 * The browse half of the content engine, and the place a blank column shipped
 * green. What is worth protecting:
 *
 *   - the table's columns are the ones the DTO actually carries —
 *     content_id, title, editorial_status, generated_at. The command used to
 *     declare `id` and `status`, which the API has never returned, so every row
 *     printed two blank cells and one of them was the id every following
 *     command needs. The fixtures below are built from
 *     GeneratedContentListItem / GeneratedContentDetailResponse in senso-api's
 *     internal/api/dto/generated_content_dto.go for exactly that reason;
 *   - `--status` picks a PATH segment, so an unrecognized value used to fall
 *     through to `published` and return a plausible-looking wrong list;
 *   - `--limit` outside 1-100 is not clamped by the API, it silently returns
 *     ten rows, so it is rejected here instead;
 *   - `get` shares its route with `senso content get`, which refuses knowledge
 *     base content with a 400. That is a wrong-command error (exit 2) naming
 *     `senso kb get`, not an API failure.
 *
 * Failure branches first.
 */

import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server, TEST_API_KEY } from "../setup.js";
import { apiUrl, envelope, errorEnvelope, runCli } from "../helpers.js";

const CONTENT_ID = "9d7e1c40-5b3a-4c22-8f16-0a3b7e5d2c81";
const DRAFT_CONTENT_ID = "3a5c7e91-2b48-4d06-8f13-6c9a0e4b7d52";
const VERSION_ID = "4a1b8c67-2d39-4e05-9f7a-6b2c8d0e1f34";
const KB_CONTENT_ID = "1e8b4f62-9c07-4a35-b2d8-5f70c3a9e614";

/** GeneratedContentListResponse: items plus the page window. */
const LIST = {
  items: [
    {
      content_id: CONTENT_ID,
      version_id: VERSION_ID,
      question_text: "How do refunds work at Acme?",
      title: "How refunds work",
      summary: "Refunds are issued within 14 days of the request.",
      editorial_status: "published",
      version_num: 3,
      generated_at: "2026-06-11T10:04:00Z",
      created_at: "2026-06-09T08:00:00Z",
      updated_at: "2026-06-11T10:04:00Z",
    },
    {
      content_id: DRAFT_CONTENT_ID,
      version_id: "8d0f2a47-5e31-4c99-a7b6-2f4c8e1d6053",
      // Empty for content written without an originating prompt — a blank
      // Builder document, or a recorded URL.
      question_text: "",
      title: "Shipping windows",
      editorial_status: "draft",
      version_num: 1,
      generated_at: "2026-06-12T09:30:00Z",
      created_at: "2026-06-12T09:30:00Z",
      updated_at: "2026-06-12T09:30:00Z",
    },
  ],
  total: 42,
  limit: 10,
  offset: 0,
};

const EMPTY_LIST = { items: [], total: 0, limit: 10, offset: 0 };

/** GeneratedContentDetailResponse: the same item plus the rendered body. */
const DETAIL = {
  content_id: CONTENT_ID,
  content_type: "article",
  editorial_status: "published",
  title: "How refunds work",
  summary: "Refunds are issued within 14 days of the request.",
  question_text: "How do refunds work at Acme?",
  version_num: 3,
  generated_at: "2026-06-11T10:04:00Z",
  created_at: "2026-06-09T08:00:00Z",
  updated_at: "2026-06-11T10:04:00Z",
  text: "# How refunds work\n\nRefunds are issued within 14 days.",
};

describe("generated-content list, when the request fails", () => {
  it("exits 3 and explains how to authenticate when there is no API key", async () => {
    const res = await runCli(["generated-content", "list"], { withKey: false });

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("no API key found");
    expect(res.stderr).toContain("SENSO_API_KEY");
  });

  it("exits 3 when the API rejects the key", async () => {
    server.use(
      http.get(apiUrl("/org/generated-content/published"), () =>
        HttpResponse.json({ error: "invalid key" }, { status: 401 }),
      ),
    );

    const res = await runCli(["generated-content", "list"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Authentication failed");
  });

  it("exits 3 when the key may not read content", async () => {
    server.use(
      http.get(apiUrl("/org/generated-content/published"), () =>
        HttpResponse.json({ error: "missing permission read:content" }, { status: 403 }),
      ),
    );

    const res = await runCli(["generated-content", "list"]);

    expect(res.exitCode).toBe(3);
    expect(res.stderr).toContain("Permission denied");
  });

  it("exits 1 on a 500 and offers a retry", async () => {
    server.use(
      http.get(
        apiUrl("/org/generated-content/published"),
        () => new HttpResponse(null, { status: 500 }),
      ),
    );

    const res = await runCli(["generated-content", "list"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Retry shortly");
  });

  it("exits 1 on a 501 and says retrying is NOT the answer", async () => {
    server.use(
      http.get(apiUrl("/org/generated-content/published"), () =>
        HttpResponse.json({ error: "generated content is not enabled here" }, { status: 501 }),
      ),
    );

    const res = await runCli(["generated-content", "list"]);

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("not a transient failure");
    expect(res.stderr).not.toContain("Retry shortly");
  });

  it("reports a malformed body rather than throwing a parse error at the user", async () => {
    server.use(
      http.get(apiUrl("/org/generated-content/published"), () =>
        HttpResponse.text("<html>nope</html>"),
      ),
    );

    const res = await runCli(["generated-content", "list"]);

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("Invalid JSON response");
  });

  it("writes the failure to stderr as an error envelope, leaving stdout empty", async () => {
    server.use(
      http.get(apiUrl("/org/generated-content/published"), () =>
        HttpResponse.json({ error: "nope" }, { status: 403 }),
      ),
    );

    const res = await runCli(["generated-content", "list", "--output", "json"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    const err = errorEnvelope(res);
    expect(err.command).toBe("generated-content list");
    expect(err.error).toMatchObject({
      code: "forbidden",
      status: 403,
      request: { method: "GET", path: "/org/generated-content/published" },
    });
  });
});

describe("generated-content list, when a flag is wrong", () => {
  // No handler registered here: a request would fail the test, which is how
  // "validated before the round trip" is proven.

  it("exits 2 on a --status the API has no path for, rather than listing published", async () => {
    const res = await runCli([
      "generated-content",
      "list",
      "--status",
      "pending",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    const err = errorEnvelope(res);
    expect(err.error.field).toBe("--status");
    expect(err.error.received).toBe("pending");
    expect(err.error.allowed).toEqual(["published", "drafts"]);
  });

  it("exits 2 when --limit is above 100, which the API answers with ten rows", async () => {
    const res = await runCli(["generated-content", "list", "--limit", "500", "--output", "json"]);

    expect(res.exitCode).toBe(2);
    const err = errorEnvelope(res);
    expect(err.error.field).toBe("--limit");
    expect(err.error.message).toContain("out of range");
  });

  it("exits 2 when --limit is not a whole number", async () => {
    const res = await runCli(["generated-content", "list", "--limit", "ten"]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("is not a whole number");
  });

  it("exits 2 on a negative --offset", async () => {
    const res = await runCli(["generated-content", "list", "--offset", "-1"]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("--offset");
  });
});

describe("generated-content list, on the wire", () => {
  it("reads the published listing by default, with the page window as parameters", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/generated-content/published"), ({ request }) => {
        seen = request;
        return HttpResponse.json(LIST);
      }),
    );

    await runCli(["generated-content", "list"]);

    const url = new URL(seen?.url ?? "");
    expect(url.pathname).toBe("/api/v1/org/generated-content/published");
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.get("offset")).toBe("0");
    // Absent, not empty: an empty search would be a filter matching nothing.
    expect(url.searchParams.has("search")).toBe(false);
    expect(seen?.headers.get("x-api-key")).toBe(TEST_API_KEY);
  });

  it("switches the PATH, not a parameter, for --status drafts", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/generated-content/drafts"), ({ request }) => {
        seen = request;
        return HttpResponse.json(LIST);
      }),
    );

    await runCli(["generated-content", "list", "--status", "drafts"]);

    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/generated-content/drafts");
  });

  it("accepts `draft` as a spelling of `drafts`", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/generated-content/drafts"), ({ request }) => {
        seen = request;
        return HttpResponse.json(LIST);
      }),
    );

    const res = await runCli(["generated-content", "list", "--status", "draft"]);

    expect(res.exitCode).toBe(0);
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/generated-content/drafts");
  });

  it("passes --search and the page window through", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/generated-content/published"), ({ request }) => {
        seen = request;
        return HttpResponse.json(LIST);
      }),
    );

    await runCli([
      "generated-content",
      "list",
      "--search",
      "refund",
      "--limit",
      "25",
      "--offset",
      "50",
    ]);

    const url = new URL(seen?.url ?? "");
    expect(url.searchParams.get("search")).toBe("refund");
    expect(url.searchParams.get("limit")).toBe("25");
    expect(url.searchParams.get("offset")).toBe("50");
  });
});

describe("generated-content list, on success", () => {
  it("prints the payload under data, with the page window derived from it", async () => {
    server.use(http.get(apiUrl("/org/generated-content/published"), () => HttpResponse.json(LIST)));

    const res = await runCli(["generated-content", "list", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toEqual(LIST);
    expect(envelope(res).page).toMatchObject({
      offset: 0,
      limit: 10,
      returned: 2,
      total: 42,
      has_more: true,
    });
    expect(res.stderr).toBe("");
  });

  it("gives the next page as a command that can be run as written", async () => {
    server.use(http.get(apiUrl("/org/generated-content/published"), () => HttpResponse.json(LIST)));

    const res = await runCli([
      "generated-content",
      "list",
      "--search",
      "refund",
      "--output",
      "json",
    ]);

    const next = envelope(res).page?.next ?? "";
    expect(next).toContain("--offset 2");
    expect(next).toContain("--search refund");
  });

  it("renders content_id, title, editorial_status and generated_at under --output table", async () => {
    // The regression this file exists for: `id` and `status` are not fields of
    // this DTO, and declaring them printed two blank columns.
    server.use(http.get(apiUrl("/org/generated-content/published"), () => HttpResponse.json(LIST)));

    const res = await runCli(["generated-content", "list", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    for (const column of ["content_id", "title", "editorial_status", "generated_at"]) {
      expect(res.stdout).toContain(column);
    }
    expect(res.stdout).toContain(CONTENT_ID);
    expect(res.stdout).toContain("How refunds work");
    expect(res.stdout).toContain("published");
    expect(res.stdout).toContain("2026-06-11T10:04:00Z");
  });

  it("does not warn about an absent column, because every declared one is real", async () => {
    // The table renderer warns when a declared column exists on no row. If this
    // fires, the columns and the DTO have drifted apart again.
    server.use(http.get(apiUrl("/org/generated-content/published"), () => HttpResponse.json(LIST)));

    const res = await runCli(["generated-content", "list", "--output", "table"]);

    expect(res.stderr).not.toContain("which the API did not return");
  });

  it("renders a readable block per item by default", async () => {
    server.use(http.get(apiUrl("/org/generated-content/published"), () => HttpResponse.json(LIST)));

    const res = await runCli(["generated-content", "list"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("How refunds work");
    expect(res.stdout).toContain("How do refunds work at Acme?");
    expect(res.stderr).toContain("Showing 1–2 of 42.");
  });

  it("says an empty page is empty, and why it might be", async () => {
    server.use(
      http.get(apiUrl("/org/generated-content/drafts"), () => HttpResponse.json(EMPTY_LIST)),
    );

    const res = await runCli(["generated-content", "list", "--status", "drafts"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("No generated content found.");
    expect(res.stderr).toContain("senso engine draft");
  });

  it("points at the first item's id as the next thing to read", async () => {
    server.use(http.get(apiUrl("/org/generated-content/published"), () => HttpResponse.json(LIST)));

    const res = await runCli(["generated-content", "list", "--output", "json"]);

    const next = (envelope(res).next ?? []).map((s) => s.command).join(" ");
    expect(next).toContain(`senso generated-content get ${CONTENT_ID}`);
    expect(next).toContain(`senso content citation-details ${CONTENT_ID}`);
  });
});

describe("generated-content get, when the id is wrong", () => {
  it("exits 2 without a request when <id> is not a UUID", async () => {
    const res = await runCli(["generated-content", "get", "c-1", "--output", "json"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    const err = errorEnvelope(res);
    expect(err.error.field).toBe("<id>");
    expect(err.error.received).toBe("c-1");
    expect(err.error.hint).toContain("senso generated-content list --status drafts");
  });

  it("names the resource and the id on a 404", async () => {
    server.use(
      http.get(apiUrl(`/org/generated-content/${CONTENT_ID}`), () =>
        HttpResponse.json({ error: "not found" }, { status: 404 }),
      ),
    );

    const res = await runCli(["generated-content", "get", CONTENT_ID, "--output", "json"]);

    expect(res.exitCode).toBe(4);
    const err = errorEnvelope(res);
    expect(err.error.code).toBe("not_found");
    expect(err.error.message).toContain(`Generated content ${CONTENT_ID} not found`);
    expect(err.error.field).toBe("content_id");
  });

  it("re-reports a knowledge base document as a usage error naming `senso kb get`", async () => {
    // The id is a perfectly good content_id from the other half of the system.
    // Passing the API's 400 through reads as a bug in this command; the real
    // fix is a different command, so it exits 2 rather than 1.
    server.use(
      http.get(apiUrl(`/org/generated-content/${KB_CONTENT_ID}`), () =>
        HttpResponse.json(
          { error: "Knowledge base content must be accessed through KB node endpoints" },
          { status: 400 },
        ),
      ),
    );

    const res = await runCli(["generated-content", "get", KB_CONTENT_ID, "--output", "json"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    const err = errorEnvelope(res);
    expect(err.error.code).toBe("usage");
    expect(err.error.status).toBe(400);
    expect(err.error.received).toBe(KB_CONTENT_ID);
    expect(err.error.message).toContain("knowledge base document");
    expect(err.error.hint).toContain("senso kb get <kb_node_id>");
    expect(err.error.hint).toContain("senso kb find");
  });

  it("leaves any other 400 as an API rejection, which is exit 1", async () => {
    server.use(
      http.get(apiUrl(`/org/generated-content/${CONTENT_ID}`), () =>
        HttpResponse.json({ error: "invalid content id" }, { status: 400 }),
      ),
    );

    const res = await runCli(["generated-content", "get", CONTENT_ID, "--output", "json"]);

    expect(res.exitCode).toBe(1);
    expect(errorEnvelope(res).error.code).toBe("validation");
  });
});

describe("generated-content get, on success", () => {
  it("returns the item with its body under data", async () => {
    server.use(
      http.get(apiUrl(`/org/generated-content/${CONTENT_ID}`), () => HttpResponse.json(DETAIL)),
    );

    const res = await runCli(["generated-content", "get", CONTENT_ID, "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toEqual(DETAIL);
    expect(res.stderr).toBe("");
  });

  it("prints the markdown body, not a stringified blob, in plain output", async () => {
    server.use(
      http.get(apiUrl(`/org/generated-content/${CONTENT_ID}`), () => HttpResponse.json(DETAIL)),
    );

    const res = await runCli(["generated-content", "get", CONTENT_ID]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("text");
    expect(res.stdout).toContain("How refunds work");
    expect(res.stdout).toContain("How do refunds work at Acme?");
  });

  it("offers the citation view for a published item and publishing for a draft", async () => {
    server.use(
      http.get(apiUrl(`/org/generated-content/${CONTENT_ID}`), () => HttpResponse.json(DETAIL)),
      http.get(apiUrl(`/org/generated-content/${DRAFT_CONTENT_ID}`), () =>
        HttpResponse.json({ ...DETAIL, content_id: DRAFT_CONTENT_ID, editorial_status: "draft" }),
      ),
    );

    const published = await runCli(["generated-content", "get", CONTENT_ID, "--output", "json"]);
    const draft = await runCli(["generated-content", "get", DRAFT_CONTENT_ID, "--output", "json"]);

    expect((envelope(published).next ?? []).map((s) => s.command).join(" ")).toContain(
      `senso content citation-details ${CONTENT_ID}`,
    );
    expect((envelope(draft).next ?? []).map((s) => s.command).join(" ")).toContain(
      `senso engine publish --data '{"content_id":"${DRAFT_CONTENT_ID}"`,
    );
  });
});
