/**
 * Command layer: `senso content`, including the nested `content tags` group.
 *
 * This is the largest CRUD group in the CLI, and the one where a quietly
 * renamed parameter would do the most damage. Three things are worth more here
 * than any rendering:
 *
 *   - `content list` does not hit `/org/content` at all — it reads
 *     `/org/kb/my-files` and projects the KB node shape into its own columns.
 *     That indirection is invisible from the command line, so it is pinned on
 *     the wire, and the projection is pinned in all three formats.
 *   - The verification pipeline is driven entirely by query parameters
 *     (`--limit`, `--offset`, `--search`, `--status`, `--substatus`). A caller
 *     paging through a review queue depends on those names surviving; each one
 *     is asserted on the query string rather than on the response.
 *   - Half of this group writes: delete, unpublish, reject, restore, owners and
 *     tags all take a different method or a different path depending on the
 *     flags they were given. Those branches are asserted as requests, because
 *     the wrong one succeeds silently and destroys the wrong thing.
 *
 * The rest is the group's inherited contract: stdout carrying the payload and
 * nothing else, confirmations landing on stderr, and each failure exiting with
 * the code that says what happened.
 *
 * Failure branches come first, as in tests/commands/roles.test.ts.
 */

import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server, TEST_API_KEY } from "../setup.js";
import { apiUrl, runCli } from "../helpers.js";

const KB_FILES = {
  nodes: [
    {
      kb_node_id: "n-1",
      name: "Pricing page",
      type: "file",
      processing_status: "completed",
    },
    {
      kb_node_id: "n-2",
      name: "Onboarding",
      type: "folder",
      processing_status: "pending",
    },
  ],
};

const ONE_CONTENT = {
  content_id: "c-1",
  title: "Best CRMs for startups",
  status: "published",
  version: 3,
};

const VERIFICATION = {
  items: [
    { content_id: "c-1", title: "Best CRMs for startups", status: "review" },
    { content_id: "c-2", title: "CRM pricing compared", status: "draft" },
  ],
  total: 2,
};

const TAGS = { tags: [{ id: "t-1", name: "crm", curated: true }] };

describe("content, when the request fails", () => {
  it("exits 3 and explains how to authenticate when there is no API key", async () => {
    const res = await runCli(["content", "list"], { withKey: false });

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("no API key found");
    expect(res.stderr).toContain("SENSO_API_KEY");
  });

  it("exits 3 when the API rejects the key", async () => {
    server.use(
      http.get(apiUrl("/org/kb/my-files"), () =>
        HttpResponse.json({ error: "invalid key" }, { status: 401 }),
      ),
    );

    const res = await runCli(["content", "list"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Authentication failed");
  });

  it("exits 3 when the key is valid but lacks the scope", async () => {
    server.use(
      http.get(apiUrl("/org/content/verification"), () =>
        HttpResponse.json({ error: "not your org" }, { status: 403 }),
      ),
    );

    const res = await runCli(["content", "verification"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Permission denied");
  });

  it("exits 4 when the content item does not exist", async () => {
    server.use(http.get(apiUrl("/org/content/:id"), () => new HttpResponse(null, { status: 404 })));

    const res = await runCli(["content", "get", "missing"]);

    expect(res.exitCode).toBe(4);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Not found");
  });

  it("exits 1 on a 500 and says it is not the caller's fault", async () => {
    server.use(
      http.delete(apiUrl("/org/content/:id"), () => new HttpResponse(null, { status: 500 })),
    );

    const res = await runCli(["content", "delete", "c-1"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("not your fault");
  });

  it("exits 5 when the API rate-limits the caller", async () => {
    server.use(http.get(apiUrl("/org/kb/my-files"), () => new HttpResponse(null, { status: 429 })));

    const res = await runCli(["content", "list"]);

    expect(res.exitCode).toBe(5);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Rate limited");
  });

  it("writes the failure to stderr as JSON, leaving stdout empty, under --output json", async () => {
    server.use(
      http.get(apiUrl("/org/content/:id"), () =>
        HttpResponse.json({ error: "nope" }, { status: 403 }),
      ),
    );

    const res = await runCli(["content", "get", "c-1", "--output", "json"]);

    expect(res.exitCode).toBe(3);
    // The important half: a caller redirecting stdout to a file gets an empty
    // file, not a file containing an error object it would later read as data.
    expect(res.stdout).toBe("");

    const reported: unknown = JSON.parse(res.stderr);
    expect(reported).toMatchObject({
      error: { code: "forbidden", status: 403 },
    });
  });
});

describe("content, when the command line is wrong", () => {
  it("exits 2 when tags add is given neither --name nor --id", async () => {
    const res = await runCli(["content", "tags", "add", "c-1"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Provide --name or --id");
  });

  it("exits 2 when tags remove is given neither --name nor --id", async () => {
    const res = await runCli(["content", "tags", "remove", "c-1"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Provide --name or --id");
  });

  it("exits 2 when set-owners is missing its required --user-ids", async () => {
    const res = await runCli(["content", "set-owners", "c-1"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
  });

  it("exits 2 on a flag the group does not define", async () => {
    // `--sort` exists on `prompts list` and `members list` but not here, so it
    // is a usage error rather than a parameter that reaches the API.
    const res = await runCli(["content", "verification", "--sort", "created_at"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
  });

  it("names the valid formats when --output is not one of them", async () => {
    const res = await runCli(["content", "list", "--output", "yaml"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("json, table, plain");
  });
});

describe("content list, on the wire", () => {
  it("reads the knowledge base file listing, with the paging defaults applied", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/kb/my-files"), ({ request }) => {
        seen = request;
        return HttpResponse.json(KB_FILES);
      }),
    );

    await runCli(["content", "list"]);

    const url = new URL(seen?.url ?? "");
    expect(seen?.method).toBe("GET");
    expect(url.pathname).toBe("/api/v1/org/kb/my-files");
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.get("offset")).toBe("0");
    expect(seen?.headers.get("x-api-key")).toBe(TEST_API_KEY);
  });

  it("passes --limit and --offset through as limit and offset", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/kb/my-files"), ({ request }) => {
        seen = request;
        return HttpResponse.json(KB_FILES);
      }),
    );

    await runCli(["content", "list", "--limit", "50", "--offset", "100"]);

    const url = new URL(seen?.url ?? "");
    expect(url.searchParams.get("limit")).toBe("50");
    expect(url.searchParams.get("offset")).toBe("100");
  });
});

describe("content get, on the wire", () => {
  it("requests the content item by ID", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/content/:id"), ({ request }) => {
        seen = request;
        return HttpResponse.json(ONE_CONTENT);
      }),
    );

    await runCli(["content", "get", "c-1"]);

    expect(seen?.method).toBe("GET");
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/content/c-1");
  });
});

describe("content versions, on the wire", () => {
  it("requests the version history sub-resource", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/content/:id/versions"), ({ request }) => {
        seen = request;
        return HttpResponse.json({ versions: [{ version_id: "v-1", is_current: true }] });
      }),
    );

    await runCli(["content", "versions", "c-1"]);

    expect(seen?.method).toBe("GET");
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/content/c-1/versions");
  });
});

describe("content delete, on the wire", () => {
  it("sends a DELETE to the content item and no body", async () => {
    let seen: Request | undefined;
    server.use(
      http.delete(apiUrl("/org/content/:id"), ({ request }) => {
        seen = request;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const res = await runCli(["content", "delete", "c-1"]);

    expect(res.exitCode).toBe(0);
    expect(seen?.method).toBe("DELETE");
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/content/c-1");
    expect(await seen?.text()).toBe("");
  });
});

describe("content unpublish, on the wire", () => {
  it("posts to the unpublish sub-resource with no body when no records are named", async () => {
    let seen: Request | undefined;
    let body: string | undefined;
    server.use(
      http.post(apiUrl("/org/content/:id/unpublish"), async ({ request }) => {
        seen = request;
        body = await request.text();
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const res = await runCli(["content", "unpublish", "c-1"]);

    expect(res.exitCode).toBe(0);
    expect(seen?.method).toBe("POST");
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/content/c-1/unpublish");
    // No body at all, not `{}`: the API reads an absent body as "every
    // destination", which is a different operation from an empty list.
    expect(body).toBe("");
  });

  it("sends the named records as publish_record_ids when the flag is given", async () => {
    let body: unknown;
    server.use(
      http.post(apiUrl("/org/content/:id/unpublish"), async ({ request }) => {
        body = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const res = await runCli([
      "content",
      "unpublish",
      "c-1",
      "--publish-record-ids",
      "pr-1",
      "pr-2",
    ]);

    expect(res.exitCode).toBe(0);
    expect(body).toEqual({ publish_record_ids: ["pr-1", "pr-2"] });
  });

  it("reports how many records were retracted when a subset was named", async () => {
    server.use(
      http.post(
        apiUrl("/org/content/:id/unpublish"),
        () => new HttpResponse(null, { status: 204 }),
      ),
    );

    const res = await runCli(["content", "unpublish", "c-1", "--publish-record-ids", "pr-1"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("1 record(s)");
  });

  it("prints the response as the payload when the endpoint returns one", async () => {
    server.use(
      http.post(apiUrl("/org/content/:id/unpublish"), () =>
        HttpResponse.json({ content_id: "c-1", status: "draft" }),
      ),
    );

    const res = await runCli(["content", "unpublish", "c-1", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.json()).toEqual({ content_id: "c-1", status: "draft" });
    expect(res.stderr).toBe("");
  });
});

describe("content verification, on the wire", () => {
  it("requests the verification queue with no filters by default", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/content/verification"), ({ request }) => {
        seen = request;
        return HttpResponse.json(VERIFICATION);
      }),
    );

    await runCli(["content", "verification"]);

    const url = new URL(seen?.url ?? "");
    expect(seen?.method).toBe("GET");
    expect(url.pathname).toBe("/api/v1/org/content/verification");
    // Unset options must not become empty parameters: `?status=` means
    // something different to the API from an absent `status`.
    expect(url.search).toBe("");
  });

  it("maps every filter flag onto the query parameter the API expects", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/content/verification"), ({ request }) => {
        seen = request;
        return HttpResponse.json(VERIFICATION);
      }),
    );

    await runCli([
      "content",
      "verification",
      "--limit",
      "25",
      "--offset",
      "50",
      "--search",
      "crm pricing",
      "--status",
      "published",
      "--substatus",
      "pending_draft",
    ]);

    const params = new URL(seen?.url ?? "").searchParams;
    expect(params.get("limit")).toBe("25");
    expect(params.get("offset")).toBe("50");
    expect(params.get("search")).toBe("crm pricing");
    expect(params.get("status")).toBe("published");
    expect(params.get("substatus")).toBe("pending_draft");
  });

  it("forwards an unrecognized --status rather than validating it locally", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/content/verification"), ({ request }) => {
        seen = request;
        return HttpResponse.json(VERIFICATION);
      }),
    );

    const res = await runCli(["content", "verification", "--status", "nonsense"]);

    // BUG: --status documents a closed set (all, draft, review,
    // rejected, published) but is not declared as a choice, so a typo costs a
    // round trip and surfaces as an API error instead of exit 2. Asserted as it
    // behaves today.
    expect(res.exitCode).toBe(0);
    expect(new URL(seen?.url ?? "").searchParams.get("status")).toBe("nonsense");
  });
});

describe("content verification-counts, on the wire", () => {
  it("requests the counts sub-resource", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/content/verification/counts"), ({ request }) => {
        seen = request;
        return HttpResponse.json({ draft: 4, published: 12, rejected: 1 });
      }),
    );

    const res = await runCli(["content", "verification-counts", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(seen?.method).toBe("GET");
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/content/verification/counts");
    expect(res.json()).toEqual({ draft: 4, published: 12, rejected: 1 });
  });
});

describe("content reject, on the wire", () => {
  it("posts to the version's reject route with no body when no reason is given", async () => {
    let seen: Request | undefined;
    let body: string | undefined;
    server.use(
      http.post(apiUrl("/org/content/versions/:versionId/reject"), async ({ request }) => {
        seen = request;
        body = await request.text();
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const res = await runCli(["content", "reject", "v-1"]);

    expect(res.exitCode).toBe(0);
    expect(seen?.method).toBe("POST");
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/content/versions/v-1/reject");
    expect(body).toBe("");
  });

  it("sends --reason as reason", async () => {
    let body: unknown;
    server.use(
      http.post(apiUrl("/org/content/versions/:versionId/reject"), async ({ request }) => {
        body = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await runCli(["content", "reject", "v-1", "--reason", "off brand"]);

    expect(body).toEqual({ reason: "off brand" });
  });
});

describe("content restore, on the wire", () => {
  it("posts to the version's restore route", async () => {
    let seen: Request | undefined;
    server.use(
      http.post(apiUrl("/org/content/versions/:versionId/restore"), ({ request }) => {
        seen = request;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const res = await runCli(["content", "restore", "v-1"]);

    expect(res.exitCode).toBe(0);
    expect(seen?.method).toBe("POST");
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/content/versions/v-1/restore");
  });
});

describe("content owners, on the wire", () => {
  it("lists the owners of a content item", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/content/:id/owners"), ({ request }) => {
        seen = request;
        return HttpResponse.json({ owners: [{ user_id: "u-1", email: "a@example.com" }] });
      }),
    );

    await runCli(["content", "owners", "c-1"]);

    expect(seen?.method).toBe("GET");
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/content/c-1/owners");
  });

  it("replaces the whole owner set with a PUT carrying user_ids", async () => {
    let seen: Request | undefined;
    let body: unknown;
    server.use(
      http.put(apiUrl("/org/content/:id/owners"), async ({ request }) => {
        seen = request;
        body = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const res = await runCli(["content", "set-owners", "c-1", "--user-ids", "u-1", "u-2"]);

    expect(res.exitCode).toBe(0);
    expect(seen?.method).toBe("PUT");
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/content/c-1/owners");
    expect(body).toEqual({ user_ids: ["u-1", "u-2"] });
  });

  it("removes one owner by deleting the nested owner path", async () => {
    let seen: Request | undefined;
    server.use(
      http.delete(apiUrl("/org/content/:id/owners/:userId"), ({ request }) => {
        seen = request;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const res = await runCli(["content", "remove-owner", "c-1", "u-2"]);

    expect(res.exitCode).toBe(0);
    expect(seen?.method).toBe("DELETE");
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/content/c-1/owners/u-2");
  });
});

describe("content tags, on the wire", () => {
  it("lists the tags attached to a content item", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/content/:id/tags"), ({ request }) => {
        seen = request;
        return HttpResponse.json(TAGS);
      }),
    );

    await runCli(["content", "tags", "list", "c-1"]);

    expect(seen?.method).toBe("GET");
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/content/c-1/tags");
  });

  it("splits --names and --ids into tag_names and tag_ids on a PUT", async () => {
    let seen: Request | undefined;
    let body: unknown;
    server.use(
      http.put(apiUrl("/org/content/:id/tags"), async ({ request }) => {
        seen = request;
        body = await request.json();
        return HttpResponse.json(TAGS);
      }),
    );

    const res = await runCli([
      "content",
      "tags",
      "set",
      "c-1",
      "--names",
      "crm, pricing",
      "--ids",
      "t-9",
    ]);

    expect(res.exitCode).toBe(0);
    expect(seen?.method).toBe("PUT");
    // Whitespace around a comma is a shell artifact, not part of the tag name.
    expect(body).toEqual({ tag_names: ["crm", "pricing"], tag_ids: ["t-9"] });
  });

  it("sends an empty body when tags set is given neither list, which clears them", async () => {
    let body: unknown;
    server.use(
      http.put(apiUrl("/org/content/:id/tags"), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ tags: [] });
      }),
    );

    const res = await runCli(["content", "tags", "set", "c-1"]);

    expect(res.exitCode).toBe(0);
    expect(body).toEqual({});
  });

  it("attaches a tag by name as tag_name", async () => {
    let body: unknown;
    server.use(
      http.post(apiUrl("/org/content/:id/tags"), async ({ request }) => {
        body = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const res = await runCli(["content", "tags", "add", "c-1", "--name", "crm"]);

    expect(res.exitCode).toBe(0);
    expect(body).toEqual({ tag_name: "crm" });
  });

  it("prefers --id over --name when both are given", async () => {
    let body: unknown;
    server.use(
      http.post(apiUrl("/org/content/:id/tags"), async ({ request }) => {
        body = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await runCli(["content", "tags", "add", "c-1", "--name", "crm", "--id", "t-1"]);

    expect(body).toEqual({ tag_id: "t-1" });
  });

  it("detaches by --id through the nested tag path", async () => {
    let seen: Request | undefined;
    server.use(
      http.delete(apiUrl("/org/content/:id/tags/:tagId"), ({ request }) => {
        seen = request;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const res = await runCli(["content", "tags", "remove", "c-1", "--id", "t-1"]);

    expect(res.exitCode).toBe(0);
    expect(seen?.method).toBe("DELETE");
    expect(new URL(seen?.url ?? "").pathname).toBe("/api/v1/org/content/c-1/tags/t-1");
  });

  it("detaches by --name through the collection with a name parameter", async () => {
    let seen: Request | undefined;
    server.use(
      http.delete(apiUrl("/org/content/:id/tags"), ({ request }) => {
        seen = request;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const res = await runCli(["content", "tags", "remove", "c-1", "--name", "crm"]);

    expect(res.exitCode).toBe(0);
    // A different request from the --id case, and detaching the wrong tag is
    // silent, so the route and the parameter are both pinned.
    const url = new URL(seen?.url ?? "");
    expect(url.pathname).toBe("/api/v1/org/content/c-1/tags");
    expect(url.searchParams.get("name")).toBe("crm");
  });
});

describe("content list, on success", () => {
  it("prints the payload unmodified under --output json", async () => {
    server.use(http.get(apiUrl("/org/kb/my-files"), () => HttpResponse.json(KB_FILES)));

    const res = await runCli(["content", "list", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    // The raw response, not the projection the other two formats render.
    expect(res.json()).toEqual(KB_FILES);
    expect(res.stderr).toBe("");
  });

  it("renders the projected columns under --output table", async () => {
    server.use(http.get(apiUrl("/org/kb/my-files"), () => HttpResponse.json(KB_FILES)));

    const res = await runCli(["content", "list", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    for (const column of ["id", "name", "type", "status"]) {
      expect(res.stdout).toContain(column);
    }
    expect(res.stdout).toContain("n-1");
    expect(res.stdout).toContain("Pricing page");
    expect(res.stdout).toContain("completed");
  });

  it("renders a name-and-ID line per node by default", async () => {
    server.use(http.get(apiUrl("/org/kb/my-files"), () => HttpResponse.json(KB_FILES)));

    const res = await runCli(["content", "list"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Onboarding");
    expect(res.stdout).toContain("(n-2)");
    expect(res.stdout).toContain("[folder]");
  });

  it("reads a bare array response as the node list", async () => {
    // Some deployments return the array unwrapped; both shapes must render.
    server.use(http.get(apiUrl("/org/kb/my-files"), () => HttpResponse.json(KB_FILES.nodes)));

    const res = await runCli(["content", "list"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Pricing page");
  });

  it("calls an unnamed node Untitled rather than printing nothing", async () => {
    server.use(
      http.get(apiUrl("/org/kb/my-files"), () =>
        HttpResponse.json({ nodes: [{ kb_node_id: "n-3", name: "" }] }),
      ),
    );

    const res = await runCli(["content", "list"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Untitled");
    expect(res.stdout).toContain("(n-3)");
  });

  it("says so plainly when the knowledge base is empty", async () => {
    server.use(http.get(apiUrl("/org/kb/my-files"), () => HttpResponse.json({ nodes: [] })));

    const res = await runCli(["content", "list"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("No content found.");
  });
});

describe("content get, on success", () => {
  it("prints the payload unmodified under --output json", async () => {
    server.use(http.get(apiUrl("/org/content/:id"), () => HttpResponse.json(ONE_CONTENT)));

    const res = await runCli(["content", "get", "c-1", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.json()).toEqual(ONE_CONTENT);
    expect(res.stderr).toBe("");
  });

  it("renders the single object as field/value rows under --output table", async () => {
    server.use(http.get(apiUrl("/org/content/:id"), () => HttpResponse.json(ONE_CONTENT)));

    const res = await runCli(["content", "get", "c-1", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("field");
    expect(res.stdout).toContain("value");
    expect(res.stdout).toContain("content_id");
    expect(res.stdout).toContain("Best CRMs for startups");
  });

  it("renders key/value lines by default", async () => {
    server.use(http.get(apiUrl("/org/content/:id"), () => HttpResponse.json(ONE_CONTENT)));

    const res = await runCli(["content", "get", "c-1"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("title");
    expect(res.stdout).toContain("Best CRMs for startups");
    expect(res.stdout).toContain("published");
  });
});

describe("content verification, on success", () => {
  it("renders one row per queued item under --output table", async () => {
    server.use(
      http.get(apiUrl("/org/content/verification"), () => HttpResponse.json(VERIFICATION)),
    );

    const res = await runCli(["content", "verification", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("c-1");
    expect(res.stdout).toContain("CRM pricing compared");
    expect(res.stdout).toContain("review");
  });
});

describe("content, when a command only confirms", () => {
  it("prints a parseable object on stdout for a 204 delete under --output json", async () => {
    server.use(
      http.delete(apiUrl("/org/content/:id"), () => new HttpResponse(null, { status: 204 })),
    );

    const res = await runCli(["content", "delete", "c-1", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    // A 204 has no payload, so the caller gets an object it can check rather
    // than an empty stream or an unparseable success line.
    expect(res.json()).toMatchObject({ ok: true });
    expect(res.stderr).toBe("");
  });

  it("puts the delete confirmation on stderr, leaving stdout empty", async () => {
    server.use(
      http.delete(apiUrl("/org/content/:id"), () => new HttpResponse(null, { status: 204 })),
    );

    const res = await runCli(["content", "delete", "c-1"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("✓");
    expect(res.stderr).toContain("c-1");
  });

  it("puts the reject confirmation on stderr, leaving stdout empty", async () => {
    server.use(
      http.post(
        apiUrl("/org/content/versions/:versionId/reject"),
        () => new HttpResponse(null, { status: 204 }),
      ),
    );

    const res = await runCli(["content", "reject", "v-1"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("rejected");
  });

  it("says nothing at all under --quiet", async () => {
    server.use(
      http.delete(
        apiUrl("/org/content/:id/owners/:userId"),
        () => new HttpResponse(null, { status: 204 }),
      ),
    );

    const res = await runCli(["content", "remove-owner", "c-1", "u-2", "--quiet"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("");
    expect(res.stderr).toBe("");
  });
});

/**
 * The five GEO reporting and telemetry additions.
 *
 * Four of them are reads whose whole interface is a query string —
 * `provenance` sends the URL as `published_url` while the flag is `--url`, and
 * the two citation commands rename four kebab-case flags into snake_case
 * parameters. None of that is visible from the command line or checked by the
 * type system, so each parameter name is asserted on the wire.
 *
 * `record-edits` is the one write: the endpoint records events in order and
 * fails on the first invalid one with the earlier events already stored, so a
 * batch that is obviously the wrong shape is refused here rather than
 * half-applied there.
 */

const PROVENANCE = {
  published_url: "https://example.com/post",
  content_id: "c-1",
  content_version_id: "v-1",
  overall_status: "partial",
  stages: { ingestion: { status: "complete" } },
};

const VELOCITY = {
  pages_with_citations: 4,
  total_live_pages: 10,
  avg_days_to_first_citation: 6.5,
  destinations: [
    {
      publisher_id: "p-1",
      publisher_name: "Company Blog",
      publisher_slug: "company-blog",
      total_live_pages: 10,
      pages_with_citations: 4,
    },
  ],
};

const CITATION_DETAILS = {
  content_id: "c-1",
  title: "How we do onboarding",
  date_range: { start_date: "2026-01-01", end_date: "2026-01-31" },
  models: ["chatgpt"],
  earliest_publish_at: "2026-01-02T00:00:00Z",
  first_citation_at: "2026-01-09T00:00:00Z",
  days_to_first_citation: 7,
  summary: { citation_count: 12 },
  destinations: [],
  trend: [],
};

const CITATION_PROMPTS = {
  content_id: "c-1",
  date_range: { start_date: "2026-01-01", end_date: "2026-01-31" },
  models: ["chatgpt"],
  external_urls: ["https://example.com/post"],
  prompts: [
    {
      prompt: "best onboarding software",
      prompt_funnel_stage: "consideration",
      model: "chatgpt",
      source_id: "s-1",
      mention_rate: 0.4,
      avg_sov: 0.2,
      common_sentiment: "positive",
      eval_count: 10,
      citation_count: 4,
      mention_rate_lift: 0.1,
      avg_sov_lift: 0.05,
    },
  ],
};

describe("content provenance and the citation reports, on the wire", () => {
  it("sends --url as published_url on the query string", async () => {
    let url: URL | undefined;
    server.use(
      http.get(apiUrl("/org/content/provenance"), ({ request }) => {
        url = new URL(request.url);
        return HttpResponse.json(PROVENANCE);
      }),
    );

    await runCli(["content", "provenance", "--url", "https://example.com/post"]);

    expect(url?.pathname).toContain("/org/content/provenance");
    expect(url?.searchParams.get("published_url")).toBe("https://example.com/post");
  });

  it("exits 2 when provenance is asked for without a URL", async () => {
    const res = await runCli(["content", "provenance"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
  });

  it("reads the velocity metrics from the nested verification route", async () => {
    let path: string | undefined;
    server.use(
      http.get(apiUrl("/org/content/verification/velocity"), ({ request }) => {
        path = new URL(request.url).pathname;
        return HttpResponse.json(VELOCITY);
      }),
    );

    const res = await runCli(["content", "verification-velocity"]);

    expect(res.exitCode).toBe(0);
    // Not /org/content/verification, which is the paginated review queue.
    expect(path).toMatch(/\/org\/content\/verification\/velocity$/);
  });

  it("renames every citation-details filter into its API parameter", async () => {
    let url: URL | undefined;
    server.use(
      http.get(apiUrl("/org/content/:id/citation-details"), ({ request }) => {
        url = new URL(request.url);
        return HttpResponse.json(CITATION_DETAILS);
      }),
    );

    await runCli([
      "content",
      "citation-details",
      "c-1",
      "--start-date",
      "2026-01-01",
      "--end-date",
      "2026-01-31",
      "--models",
      "chatgpt,perplexity",
      "--locations",
      "us,ca",
    ]);

    expect(url?.pathname).toContain("/org/content/c-1/citation-details");
    expect(url?.searchParams.get("start_date")).toBe("2026-01-01");
    expect(url?.searchParams.get("end_date")).toBe("2026-01-31");
    expect(url?.searchParams.get("models")).toBe("chatgpt,perplexity");
    expect(url?.searchParams.get("locations")).toBe("us,ca");
  });

  it("sends no filter parameters at all when none were given", async () => {
    let url: URL | undefined;
    server.use(
      http.get(apiUrl("/org/content/:id/citation-details"), ({ request }) => {
        url = new URL(request.url);
        return HttpResponse.json(CITATION_DETAILS);
      }),
    );

    await runCli(["content", "citation-details", "c-1"]);

    // An empty `start_date=` is not the same request as no start_date at all.
    expect([...(url?.searchParams.keys() ?? [])]).toEqual([]);
  });

  it("carries --destinations through on citation-prompts, which citation-details has no filter for", async () => {
    let url: URL | undefined;
    server.use(
      http.get(apiUrl("/org/content/:id/citation-prompts"), ({ request }) => {
        url = new URL(request.url);
        return HttpResponse.json(CITATION_PROMPTS);
      }),
    );

    await runCli([
      "content",
      "citation-prompts",
      "c-1",
      "--destinations",
      "company-blog",
      "--models",
      "chatgpt",
    ]);

    expect(url?.pathname).toContain("/org/content/c-1/citation-prompts");
    expect(url?.searchParams.get("destinations")).toBe("company-blog");
    expect(url?.searchParams.get("models")).toBe("chatgpt");
  });
});

describe("content record-edits, on the wire and before it", () => {
  it("posts the events body verbatim to the bulk edit-events route", async () => {
    let body: unknown;
    let url: string | undefined;
    server.use(
      http.post(apiUrl("/org/content/:id/edit-events/bulk"), async ({ request }) => {
        body = await request.json();
        url = request.url;
        return HttpResponse.json({ inserted_count: 1, duplicate_count: 0 });
      }),
    );

    await runCli([
      "content",
      "record-edits",
      "c-1",
      "--data",
      '{"events":[{"event_type":"draft_saved","edit_source":"manual"}]}',
    ]);

    expect(url).toContain("/org/content/c-1/edit-events/bulk");
    expect(body).toEqual({
      events: [{ event_type: "draft_saved", edit_source: "manual" }],
    });
  });

  it("exits 2 when --data is not valid JSON", async () => {
    const res = await runCli(["content", "record-edits", "c-1", "--data", "{oops"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("--data");
  });

  it("exits 2 when the body carries no events array", async () => {
    const res = await runCli(["content", "record-edits", "c-1", "--data", '{"event":"saved"}']);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("events");
  });

  it("exits 2 rather than sending an empty batch", async () => {
    const res = await runCli(["content", "record-edits", "c-1", "--data", '{"events":[]}']);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
  });
});

describe("the GEO reports, on success and on refusal", () => {
  it("prints the provenance audit unmodified under --output json", async () => {
    server.use(http.get(apiUrl("/org/content/provenance"), () => HttpResponse.json(PROVENANCE)));

    const res = await runCli([
      "content",
      "provenance",
      "--url",
      "https://example.com/post",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.json()).toEqual(PROVENANCE);
    expect(res.stderr).toBe("");
  });

  it("renders the audit as key/value lines by default", async () => {
    server.use(http.get(apiUrl("/org/content/provenance"), () => HttpResponse.json(PROVENANCE)));

    const res = await runCli(["content", "provenance", "--url", "https://example.com/post"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("overall_status");
    expect(res.stdout).toContain("partial");
  });

  it("exits 4 when no live publish record matches the URL", async () => {
    server.use(
      http.get(apiUrl("/org/content/provenance"), () => new HttpResponse(null, { status: 404 })),
    );

    const res = await runCli(["content", "provenance", "--url", "https://example.com/gone"]);

    expect(res.exitCode).toBe(4);
    expect(res.stdout).toBe("");
  });

  it("renders one row per prompt under --output table", async () => {
    server.use(
      http.get(apiUrl("/org/content/:id/citation-prompts"), () =>
        HttpResponse.json(CITATION_PROMPTS),
      ),
    );

    const res = await runCli(["content", "citation-prompts", "c-1", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("mention_rate");
    expect(res.stdout).toContain("best onboarding software");
  });

  it("puts the insert counts on stdout and the tick on stderr for record-edits", async () => {
    server.use(
      http.post(apiUrl("/org/content/:id/edit-events/bulk"), () =>
        HttpResponse.json({ inserted_count: 2, duplicate_count: 1 }),
      ),
    );

    const res = await runCli([
      "content",
      "record-edits",
      "c-1",
      "--data",
      '{"events":[{"event_type":"draft_saved","edit_source":"manual"}]}',
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("duplicate_count");
    expect(res.stderr).toContain("Edit events recorded");
    expect(res.stdout).not.toContain("Edit events recorded");
  });

  it("exits 3 when the organization does not have the GEO product", async () => {
    server.use(
      http.get(apiUrl("/org/content/verification/velocity"), () =>
        HttpResponse.json({ error: "GEO product required" }, { status: 403 }),
      ),
    );

    const res = await runCli(["content", "verification-velocity"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
  });
});
