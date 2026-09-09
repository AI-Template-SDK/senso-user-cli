/**
 * Command layer: `senso kb`, including the nested `kb tags` group.
 *
 * The knowledge base is the widest command group in the CLI — twenty
 * subcommands over one tree of nodes — and almost all of them differ from each
 * other only in a method and a path. That is exactly the kind of surface where a
 * renamed parameter is invisible: `move` sends `new_parent_id` while
 * `create-folder` sends `parent_id`, `find` sends the query as `q` while the
 * flag is `--query`, and `tags remove` chooses between two entirely different
 * requests depending on which flag it got. None of that is checked by the type
 * system or visible from the command line, so it is asserted on the wire here.
 *
 * The other half of this file is `kb upload`, which shares a two-step upload
 * transaction with `senso ingest upload`: POST the file metadata, receive a
 * presigned S3 URL per accepted file, PUT the bytes to it. The metadata is
 * asserted against a real file on disk, because a hash or a size that disagrees
 * with the bytes produces a request the API accepts and an object S3 rejects.
 * Where this command's behavior differs from `ingest upload`'s — and it does, in
 * ways that cost a caller its exit code — the difference is marked BUG and the
 * CURRENT behavior is asserted.
 *
 * Failure branches come first, as in tests/commands/roles.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { server } from "../setup.js";
import { apiUrl, runCli } from "../helpers.js";

const NODES = {
  nodes: [
    { kb_node_id: "n-folder", name: "Handbook", type: "folder" },
    { kb_node_id: "n-doc", name: "Onboarding.pdf", type: "content" },
  ],
  total: 2,
  limit: 50,
  offset: 0,
};

const ONE_NODE = {
  kb_node_id: "n-doc",
  name: "Onboarding.pdf",
  type: "content",
  parent_id: "n-folder",
  created_at: "2026-03-01T00:00:00Z",
};

const TAGS = { tags: [{ tag_id: "t-1", name: "handbook", created_at: "2026-03-01T00:00:00Z" }] };

/** Where a presigned URL points. Nothing listens on it; MSW answers. */
const S3_URL = "https://s3.test.invalid/senso-uploads/abc123?X-Amz-Signature=deadbeef";

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "senso-kb-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** A real file on disk, because the metadata is asserted against its bytes. */
function tempFile(name: string, contents: string): string {
  const path = join(workDir, name);
  writeFileSync(path, contents);
  return path;
}

function md5(contents: string): string {
  return createHash("md5").update(Buffer.from(contents)).digest("hex");
}

function accepted(filename: string, url = S3_URL) {
  return {
    filename,
    status: "upload_pending",
    upload_url: url,
    content_id: `c-${filename}`,
  };
}

function rejected(filename: string, status: string, error?: string) {
  return { filename, status, ...(error === undefined ? {} : { error }) };
}

function uploadResponse(results: Record<string, unknown>[]) {
  return {
    summary: {
      total: results.length,
      success: results.filter((r) => r.status === "upload_pending").length,
      skipped: results.filter((r) => r.status !== "upload_pending").length,
    },
    results,
  };
}

/** Serves both halves of the upload transaction, recording each. */
function serveUpload(
  results: Record<string, unknown>[],
  opts: { s3Status?: number } = {},
): { prepBodies: unknown[]; puts: { request: Request; body: Buffer }[] } {
  const prepBodies: unknown[] = [];
  const puts: { request: Request; body: Buffer }[] = [];

  server.use(
    http.post(apiUrl("/org/kb/upload"), async ({ request }) => {
      prepBodies.push(await request.json());
      return HttpResponse.json(uploadResponse(results));
    }),
    http.put("https://s3.test.invalid/*", async ({ request }) => {
      const clone = request.clone();
      puts.push({ request: clone, body: Buffer.from(await request.arrayBuffer()) });
      if (opts.s3Status && opts.s3Status >= 400) {
        return new HttpResponse(null, { status: opts.s3Status });
      }
      return new HttpResponse(null, { status: 200 });
    }),
  );

  return { prepBodies, puts };
}

describe("kb, when the request fails", () => {
  it("exits 3 and explains how to authenticate when there is no API key", async () => {
    const res = await runCli(["kb", "root"], { withKey: false });

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("no API key found");
    expect(res.stderr).toContain("SENSO_API_KEY");
  });

  it("exits 3 when the API rejects the key", async () => {
    server.use(
      http.get(apiUrl("/org/kb/root"), () =>
        HttpResponse.json({ error: "invalid key" }, { status: 401 }),
      ),
    );

    const res = await runCli(["kb", "root"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Authentication failed");
  });

  it("exits 3 when the key lacks the scope for the operation", async () => {
    server.use(
      http.post(apiUrl("/org/kb/folders"), () =>
        HttpResponse.json({ error: "read-only key" }, { status: 403 }),
      ),
    );

    const res = await runCli(["kb", "create-folder", "--name", "Legal"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Permission denied");
  });

  it("exits 4 when the node id does not exist", async () => {
    server.use(
      http.get(apiUrl("/org/kb/nodes/:nodeId"), () => new HttpResponse(null, { status: 404 })),
    );

    const res = await runCli(["kb", "get", "n-missing"]);

    expect(res.exitCode).toBe(4);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Not found");
  });

  it("exits 1 on a 500 and says it is not the caller's fault", async () => {
    server.use(http.get(apiUrl("/org/kb/my-files"), () => new HttpResponse(null, { status: 503 })));

    const res = await runCli(["kb", "my-files"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("not your fault");
  });

  it("exits 5 when the API rate-limits, because retrying is the right response", async () => {
    server.use(http.get(apiUrl("/org/kb/my-files"), () => new HttpResponse(null, { status: 429 })));

    const res = await runCli(["kb", "my-files"]);

    expect(res.exitCode).toBe(5);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Rate limited");
  });

  it("reports a malformed body rather than throwing a parse error at the user", async () => {
    server.use(http.get(apiUrl("/org/kb/root"), () => new HttpResponse("<html>nope</html>")));

    const res = await runCli(["kb", "root"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Invalid JSON response");
  });

  it("writes the failure to stderr as JSON, leaving stdout empty, under --output json", async () => {
    server.use(
      http.get(apiUrl("/org/kb/root"), () => HttpResponse.json({ error: "nope" }, { status: 403 })),
    );

    const res = await runCli(["kb", "root", "--output", "json"]);

    expect(res.exitCode).toBe(3);
    // A caller redirecting stdout to a file gets an empty file, not a file
    // holding an error object it would later read as data.
    expect(res.stdout).toBe("");
    expect(JSON.parse(res.stderr)).toMatchObject({ error: { code: "forbidden", status: 403 } });
  });
});

describe("kb, when the command line is wrong", () => {
  it("exits 2 when create-raw's --data is not valid JSON", async () => {
    const res = await runCli(["kb", "create-raw", "--data", "{title: hi}"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Invalid JSON in --data");
  });

  it("exits 2 when create-raw's --data is an array rather than an object", async () => {
    const res = await runCli(["kb", "create-raw", "--data", '[{"title":"hi"}]']);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("must be a JSON object");
  });

  it("exits 2 when update-raw's --data is not valid JSON", async () => {
    const res = await runCli(["kb", "update-raw", "n-doc", "--data", "not json"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Invalid JSON in --data");
  });

  it("exits 2 when patch-raw's --data is not valid JSON", async () => {
    const res = await runCli(["kb", "patch-raw", "n-doc", "--data", "{"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Invalid JSON in --data");
  });

  it("exits 2 when tags add is given neither --name nor --id", async () => {
    const res = await runCli(["kb", "tags", "add", "n-doc"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Provide --name or --id");
  });

  it("exits 2 when tags remove is given neither --name nor --id", async () => {
    const res = await runCli(["kb", "tags", "remove", "n-doc"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Provide --name or --id");
  });

  it("names the valid formats when --output is not one of them", async () => {
    const res = await runCli(["kb", "root", "--output", "yaml"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("json, table, plain");
  });
});

describe("kb browsing, on the wire", () => {
  it("GETs /org/kb/root with no query", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/kb/root"), ({ request }) => {
        seen = request;
        return HttpResponse.json({ kb_node_id: "n-root", name: "My Files", type: "folder" });
      }),
    );

    await runCli(["kb", "root"]);

    expect(seen?.method).toBe("GET");
    expect(new URL(seen!.url).pathname).toBe("/api/v1/org/kb/root");
    expect(new URL(seen!.url).search).toBe("");
  });

  it("GETs /org/kb/my-files with the default page window", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/kb/my-files"), ({ request }) => {
        seen = request;
        return HttpResponse.json(NODES);
      }),
    );

    await runCli(["kb", "my-files"]);

    const params = new URL(seen!.url).searchParams;
    expect(params.get("limit")).toBe("50");
    expect(params.get("offset")).toBe("0");
    // Absent rather than empty: an empty `type` would filter everything out.
    expect(params.has("type")).toBe(false);
  });

  it("passes --limit, --offset and --type through to my-files", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/kb/my-files"), ({ request }) => {
        seen = request;
        return HttpResponse.json(NODES);
      }),
    );

    await runCli(["kb", "my-files", "--limit", "5", "--offset", "10", "--type", "folder"]);

    const params = new URL(seen!.url).searchParams;
    expect(params.get("limit")).toBe("5");
    expect(params.get("offset")).toBe("10");
    expect(params.get("type")).toBe("folder");
  });

  it("sends find's --query as the q parameter", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/kb/find"), ({ request }) => {
        seen = request;
        return HttpResponse.json(NODES);
      }),
    );

    await runCli(["kb", "find", "--query", "onboarding deck", "--type", "content"]);

    const params = new URL(seen!.url).searchParams;
    // The flag is --query and the parameter is q. Renaming either without the
    // other produces a search that silently matches everything.
    expect(params.get("q")).toBe("onboarding deck");
    expect(params.get("limit")).toBe("20");
    expect(params.get("offset")).toBe("0");
    expect(params.get("type")).toBe("content");
  });

  it("GETs /org/kb/sync-status with no query", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/kb/sync-status"), ({ request }) => {
        seen = request;
        return HttpResponse.json({ status: "synced", pending: 0 });
      }),
    );

    await runCli(["kb", "sync-status"]);

    expect(new URL(seen!.url).pathname).toBe("/api/v1/org/kb/sync-status");
  });

  it("GETs the node itself for get", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/kb/nodes/:nodeId"), ({ request }) => {
        seen = request;
        return HttpResponse.json(ONE_NODE);
      }),
    );

    await runCli(["kb", "get", "n-doc"]);

    expect(new URL(seen!.url).pathname).toBe("/api/v1/org/kb/nodes/n-doc");
  });

  it("GETs the children of a folder, with the page window", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/kb/nodes/:nodeId/children"), ({ request }) => {
        seen = request;
        return HttpResponse.json(NODES);
      }),
    );

    await runCli(["kb", "children", "n-folder", "--type", "content"]);

    expect(new URL(seen!.url).pathname).toBe("/api/v1/org/kb/nodes/n-folder/children");
    expect(new URL(seen!.url).searchParams.get("type")).toBe("content");
    expect(new URL(seen!.url).searchParams.get("limit")).toBe("50");
  });

  it("GETs the ancestor chain for a node", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/kb/nodes/:nodeId/ancestors"), ({ request }) => {
        seen = request;
        return HttpResponse.json(NODES);
      }),
    );

    await runCli(["kb", "ancestors", "n-doc"]);

    expect(new URL(seen!.url).pathname).toBe("/api/v1/org/kb/nodes/n-doc/ancestors");
  });

  it("GETs a content node's detail with no query when no version is asked for", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/kb/nodes/:nodeId/content"), ({ request }) => {
        seen = request;
        return HttpResponse.json({ kb_node_id: "n-doc", text: "# Onboarding" });
      }),
    );

    await runCli(["kb", "get-content", "n-doc"]);

    expect(new URL(seen!.url).pathname).toBe("/api/v1/org/kb/nodes/n-doc/content");
    expect(new URL(seen!.url).search).toBe("");
  });

  // `--rev`, not `--version`: the root declares `-v, --version` for the CLI's
  // own version and Commander answers it wherever it appears, so a `--version`
  // here never reached the action. The wire parameter is still `version`.
  it("sends --rev as the version query parameter on get-content", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/kb/nodes/:nodeId/content"), ({ request }) => {
        seen = request;
        return HttpResponse.json({ kb_node_id: "n-doc", text: "# Onboarding" });
      }),
    );

    const res = await runCli(["kb", "get-content", "n-doc", "--rev", "3"]);

    expect(res.exitCode).toBe(0);
    expect(new URL(seen!.url).pathname).toBe("/api/v1/org/kb/nodes/n-doc/content");
    expect(new URL(seen!.url).searchParams.get("version")).toBe("3");
  });

  it("sends --rev as the version query parameter on download-url", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/kb/nodes/:nodeId/download-url"), ({ request }) => {
        seen = request;
        return HttpResponse.json({ url: S3_URL, expires_in: 900 });
      }),
    );

    const res = await runCli(["kb", "download-url", "n-doc", "--rev", "2"]);

    expect(res.exitCode).toBe(0);
    expect(new URL(seen!.url).searchParams.get("version")).toBe("2");
  });

  // The old spelling is gone, and Commander still answers it as the root's own
  // version flag — so it must not be documented on these subcommands again.
  it("still answers --version with the CLI's own version, making the rename necessary", async () => {
    const res = await runCli(["kb", "get-content", "n-doc", "--version", "3"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("GETs a presigned download URL and puts it on stdout", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/kb/nodes/:nodeId/download-url"), ({ request }) => {
        seen = request;
        return HttpResponse.json({ url: S3_URL, expires_in: 900 });
      }),
    );

    const res = await runCli(["kb", "download-url", "n-doc", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(new URL(seen!.url).pathname).toBe("/api/v1/org/kb/nodes/n-doc/download-url");
    // The URL is the payload: it goes to stdout so it can be piped to curl.
    expect(res.json<{ url: string }>().url).toBe(S3_URL);
  });
});

describe("kb tree edits, on the wire", () => {
  it("POSTs a folder with just a name when no parent is given", async () => {
    let body: Record<string, unknown> | undefined;
    let seen: Request | undefined;
    server.use(
      http.post(apiUrl("/org/kb/folders"), async ({ request }) => {
        seen = request.clone();
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ kb_node_id: "n-new", name: "Legal" });
      }),
    );

    await runCli(["kb", "create-folder", "--name", "Legal"]);

    expect(seen?.method).toBe("POST");
    expect(seen?.headers.get("content-type")).toBe("application/json");
    // Absent, not null: the API reads a missing parent as "the org's root".
    expect(body).toEqual({ name: "Legal" });
  });

  it("POSTs parent_id when a destination folder is given", async () => {
    let body: unknown;
    server.use(
      http.post(apiUrl("/org/kb/folders"), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ kb_node_id: "n-new", name: "Q3" });
      }),
    );

    await runCli(["kb", "create-folder", "--name", "Q3", "--parent-id", "n-folder"]);

    expect(body).toEqual({ name: "Q3", parent_id: "n-folder" });
  });

  it("PATCHes the rename sub-resource with the new name", async () => {
    let body: unknown;
    let seen: Request | undefined;
    server.use(
      http.patch(apiUrl("/org/kb/nodes/:nodeId/rename"), async ({ request }) => {
        seen = request.clone();
        body = await request.json();
        return HttpResponse.json({ ...ONE_NODE, name: "Handbook v2.pdf" });
      }),
    );

    await runCli(["kb", "rename", "n-doc", "--name", "Handbook v2.pdf"]);

    expect(seen?.method).toBe("PATCH");
    expect(new URL(seen!.url).pathname).toBe("/api/v1/org/kb/nodes/n-doc/rename");
    expect(body).toEqual({ name: "Handbook v2.pdf" });
  });

  it("PATCHes the move sub-resource with new_parent_id, not parent_id", async () => {
    let body: unknown;
    let seen: Request | undefined;
    server.use(
      http.patch(apiUrl("/org/kb/nodes/:nodeId/move"), async ({ request }) => {
        seen = request.clone();
        body = await request.json();
        return HttpResponse.json(ONE_NODE);
      }),
    );

    await runCli(["kb", "move", "n-doc", "--parent-id", "n-folder"]);

    expect(new URL(seen!.url).pathname).toBe("/api/v1/org/kb/nodes/n-doc/move");
    // create-folder says `parent_id` and move says `new_parent_id`. The flag is
    // spelled the same for both, so only this assertion keeps them apart.
    expect(body).toEqual({ new_parent_id: "n-folder" });
  });

  it("DELETEs the node with no body", async () => {
    let seen: Request | undefined;
    server.use(
      http.delete(apiUrl("/org/kb/nodes/:nodeId"), ({ request }) => {
        seen = request;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const res = await runCli(["kb", "delete", "n-doc"]);

    expect(res.exitCode).toBe(0);
    expect(seen?.method).toBe("DELETE");
    expect(new URL(seen!.url).pathname).toBe("/api/v1/org/kb/nodes/n-doc");
    expect(seen?.headers.get("content-type")).toBeNull();
  });
});

describe("kb raw content, on the wire", () => {
  it("POSTs the parsed --data object to /org/kb/raw unchanged", async () => {
    let body: unknown;
    let seen: Request | undefined;
    server.use(
      http.post(apiUrl("/org/kb/raw"), async ({ request }) => {
        seen = request.clone();
        body = await request.json();
        return HttpResponse.json({ kb_node_id: "n-raw", name: "My doc" });
      }),
    );

    await runCli([
      "kb",
      "create-raw",
      "--data",
      '{"title":"My doc","text":"# Hello","kb_folder_node_id":"n-folder","tag_ids":["t-1"]}',
    ]);

    expect(seen?.method).toBe("POST");
    expect(new URL(seen!.url).pathname).toBe("/api/v1/org/kb/raw");
    // Forwarded verbatim: the CLI does not know the schema and must not edit it.
    expect(body).toEqual({
      title: "My doc",
      text: "# Hello",
      kb_folder_node_id: "n-folder",
      tag_ids: ["t-1"],
    });
  });

  it("PUTs a full replacement to the node's raw sub-resource", async () => {
    let body: unknown;
    let seen: Request | undefined;
    server.use(
      http.put(apiUrl("/org/kb/nodes/:nodeId/raw"), async ({ request }) => {
        seen = request.clone();
        body = await request.json();
        return HttpResponse.json({ kb_node_id: "n-raw", version: 2 });
      }),
    );

    await runCli(["kb", "update-raw", "n-raw", "--data", '{"title":"T","text":"# Updated"}']);

    expect(seen?.method).toBe("PUT");
    expect(new URL(seen!.url).pathname).toBe("/api/v1/org/kb/nodes/n-raw/raw");
    expect(body).toEqual({ title: "T", text: "# Updated" });
  });

  it("PATCHes a partial update to the same sub-resource", async () => {
    let body: unknown;
    let seen: Request | undefined;
    server.use(
      http.patch(apiUrl("/org/kb/nodes/:nodeId/raw"), async ({ request }) => {
        seen = request.clone();
        body = await request.json();
        return HttpResponse.json({ kb_node_id: "n-raw", version: 3 });
      }),
    );

    await runCli(["kb", "patch-raw", "n-raw", "--data", '{"summary":"Shorter"}']);

    // Same path as update-raw, different method: PUT replaces the document and
    // PATCH edits it, so swapping them silently discards the rest of the text.
    expect(seen?.method).toBe("PATCH");
    expect(new URL(seen!.url).pathname).toBe("/api/v1/org/kb/nodes/n-raw/raw");
    expect(body).toEqual({ summary: "Shorter" });
  });
});

describe("kb tags, on the wire", () => {
  it("GETs the node's tags for a list", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/kb/nodes/:nodeId/tags"), ({ request }) => {
        seen = request;
        return HttpResponse.json(TAGS);
      }),
    );

    await runCli(["kb", "tags", "list", "n-doc"]);

    expect(seen?.method).toBe("GET");
    expect(new URL(seen!.url).pathname).toBe("/api/v1/org/kb/nodes/n-doc/tags");
  });

  it("splits --names and --ids into tag_names and tag_ids on a PUT", async () => {
    let body: unknown;
    let seen: Request | undefined;
    server.use(
      http.put(apiUrl("/org/kb/nodes/:nodeId/tags"), async ({ request }) => {
        seen = request.clone();
        body = await request.json();
        return HttpResponse.json(TAGS);
      }),
    );

    await runCli(["kb", "tags", "set", "n-doc", "--names", "handbook, hr ,", "--ids", "t-9"]);

    expect(seen?.method).toBe("PUT");
    // Whitespace trimmed and empty segments dropped, so a trailing comma in a
    // shell-quoted list does not become an empty tag name.
    expect(body).toEqual({ tag_names: ["handbook", "hr"], tag_ids: ["t-9"] });
  });

  it("PUTs an empty object when tags set is given neither list, which clears them", async () => {
    let body: unknown;
    server.use(
      http.put(apiUrl("/org/kb/nodes/:nodeId/tags"), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ tags: [] });
      }),
    );

    const res = await runCli(["kb", "tags", "set", "n-doc"]);

    expect(res.exitCode).toBe(0);
    expect(body).toEqual({});
  });

  it("attaches by name as tag_name", async () => {
    let body: unknown;
    let seen: Request | undefined;
    server.use(
      http.post(apiUrl("/org/kb/nodes/:nodeId/tags"), async ({ request }) => {
        seen = request.clone();
        body = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await runCli(["kb", "tags", "add", "n-doc", "--name", "handbook"]);

    expect(seen?.method).toBe("POST");
    expect(body).toEqual({ tag_name: "handbook" });
  });

  it("attaches by id as tag_id, and prefers --id when both are given", async () => {
    let body: unknown;
    server.use(
      http.post(apiUrl("/org/kb/nodes/:nodeId/tags"), async ({ request }) => {
        body = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await runCli(["kb", "tags", "add", "n-doc", "--name", "handbook", "--id", "t-1"]);

    expect(body).toEqual({ tag_id: "t-1" });
  });

  it("detaches by id through the sub-resource path", async () => {
    let seen: Request | undefined;
    server.use(
      http.delete(apiUrl("/org/kb/nodes/:nodeId/tags/:tagId"), ({ request }) => {
        seen = request;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const res = await runCli(["kb", "tags", "remove", "n-doc", "--id", "t-1"]);

    expect(res.exitCode).toBe(0);
    expect(new URL(seen!.url).pathname).toBe("/api/v1/org/kb/nodes/n-doc/tags/t-1");
  });

  it("detaches by name through a query parameter on the collection", async () => {
    let seen: Request | undefined;
    server.use(
      http.delete(apiUrl("/org/kb/nodes/:nodeId/tags"), ({ request }) => {
        seen = request;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const res = await runCli(["kb", "tags", "remove", "n-doc", "--name", "handbook"]);

    expect(res.exitCode).toBe(0);
    // Two different requests behind one command: swapping them detaches the
    // wrong tag, and neither call fails loudly.
    expect(new URL(seen!.url).pathname).toBe("/api/v1/org/kb/nodes/n-doc/tags");
    expect(new URL(seen!.url).searchParams.get("name")).toBe("handbook");
  });
});

describe("kb upload, the two-step transaction", () => {
  it("POSTs the name, size, type and md5 of the file actually on disk", async () => {
    const contents = "# Handbook\n\nWelcome aboard.\n";
    const { prepBodies } = serveUpload([accepted("handbook.md")]);

    const res = await runCli([
      "kb",
      "upload",
      tempFile("handbook.md", contents),
      "--folder-id",
      "n-folder",
    ]);

    expect(res.exitCode).toBe(0);
    expect(prepBodies[0]).toEqual({
      files: [
        {
          filename: "handbook.md",
          file_size_bytes: Buffer.byteLength(contents),
          content_type: "text/markdown",
          // Over the same bytes that are PUT below: if these disagree, S3
          // rejects the object and the file never finishes processing.
          content_hash_md5: md5(contents),
        },
      ],
      kb_folder_node_id: "n-folder",
    });
  });

  it("omits kb_folder_node_id when no folder was given, so the file lands at the root", async () => {
    const { prepBodies } = serveUpload([accepted("a.txt")]);

    await runCli(["kb", "upload", tempFile("a.txt", "alpha")]);

    expect(prepBodies[0]).not.toHaveProperty("kb_folder_node_id");
  });

  it("PUTs the file's bytes to the presigned URL the API handed back", async () => {
    const contents = "the quick brown fox";
    const { puts } = serveUpload([accepted("fox.txt")]);

    const res = await runCli(["kb", "upload", tempFile("fox.txt", contents)]);

    expect(res.exitCode).toBe(0);
    expect(puts).toHaveLength(1);
    expect(puts[0]!.request.method).toBe("PUT");
    // The exact URL, signature included: a rebuilt presigned URL no longer
    // verifies.
    expect(puts[0]!.request.url).toBe(S3_URL);
    expect(puts[0]!.request.headers.get("content-type")).toBe("text/plain");
    expect(puts[0]!.body.toString("utf-8")).toBe(contents);
  });

  it("matches each result to its local file by name, not by position", async () => {
    const second = "https://s3.test.invalid/senso-uploads/second?X-Amz-Signature=cafe";
    const { puts } = serveUpload([accepted("b.txt", second), accepted("a.txt")]);

    await runCli(["kb", "upload", tempFile("a.txt", "alpha"), tempFile("b.txt", "bravo")]);

    expect(puts.map((p) => [p.request.url, p.body.toString("utf-8")])).toEqual([
      [second, "bravo"],
      [S3_URL, "alpha"],
    ]);
  });

  it("reports a result that matches no local file instead of uploading nothing quietly", async () => {
    const { puts } = serveUpload([accepted("a.txt"), accepted("ghost.txt")]);

    const res = await runCli(["kb", "upload", tempFile("a.txt", "alpha")]);

    expect(puts).toHaveLength(1);
    expect(res.stderr).toContain("ghost.txt");
    expect(res.stderr).toContain("Could not match to a local file");
  });

  it("says nothing on stderr under --output json", async () => {
    // `--output json` implies quiet, and printUploadSummary honors it, so the
    // machine-readable run is the payload and nothing else.
    serveUpload([accepted("a.txt")]);

    const res = await runCli(["kb", "upload", tempFile("a.txt", "alpha"), "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.json()).toMatchObject({ results: [{ filename: "a.txt" }] });
    expect(res.stderr).toBe("");
  });

  it("summarizes a response with no results array rather than throwing on it", async () => {
    server.use(
      http.post(apiUrl("/org/kb/upload"), () => HttpResponse.json({ summary: { total: 0 } })),
    );

    const res = await runCli(["kb", "upload", tempFile("a.txt", "alpha")]);

    // apiRequest casts the body, it does not validate it. A malformed response
    // must summarize nothing, not throw "not iterable".
    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain("0/0 file(s) uploaded");
  });
});

describe("kb upload, when a file is not accepted", () => {
  it("explains a conflict and still uploads the files beside it", async () => {
    const { puts } = serveUpload([accepted("new.txt"), rejected("old.txt", "conflict")]);

    const res = await runCli([
      "kb",
      "upload",
      tempFile("new.txt", "fresh"),
      tempFile("old.txt", "stale"),
    ]);

    expect(res.exitCode).toBe(0);
    expect(puts).toHaveLength(1);
    expect(puts[0]!.body.toString("utf-8")).toBe("fresh");
    expect(res.stderr).toContain("old.txt");
    expect(res.stderr).toContain("same content already exists");
    expect(res.stderr).toContain("1/2 file(s) uploaded");
  });

  it("explains a duplicate with the reason for that status", async () => {
    serveUpload([accepted("new.txt"), rejected("dupe.txt", "duplicate")]);

    const res = await runCli([
      "kb",
      "upload",
      tempFile("new.txt", "fresh"),
      tempFile("dupe.txt", "again"),
    ]);

    expect(res.stderr).toContain("dupe.txt");
    expect(res.stderr).toContain("already been uploaded");
  });

  it("prefers the API's own message for an invalid file over the generic one", async () => {
    // The only file in the batch was rejected, so nothing was stored and the
    // command now exits 1 rather than 0 — the assertion that matters here is
    // still that the API's specific reason reaches stderr instead of
    // uploadStatusToReason's generic "This file type is not supported."
    serveUpload([rejected("bad.bin", "invalid", "File exceeds the 50MB limit.")]);

    const res = await runCli(["kb", "upload", tempFile("bad.bin", "junk")]);

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("File exceeds the 50MB limit.");
    expect(res.stderr).not.toContain("This file type is not supported.");
    expect(res.stderr).toContain("No files were uploaded");
  });

  it("unpacks the per-file reasons when the API rejects the whole batch", async () => {
    server.use(
      http.post(apiUrl("/org/kb/upload"), () =>
        HttpResponse.json(
          uploadResponse([
            rejected("a.txt", "duplicate"),
            rejected("b.exe", "invalid", "Executables are not supported."),
          ]),
          { status: 409 },
        ),
      ),
    );

    const res = await runCli(["kb", "upload", tempFile("a.txt", "hi"), tempFile("b.exe", "MZ")]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("already been uploaded");
    expect(res.stderr).toContain("Executables are not supported.");
  });
});

describe("kb upload, when S3 refuses the bytes", () => {
  it("reports the failing file instead of counting it as uploaded", async () => {
    const { puts } = serveUpload([accepted("a.txt")], { s3Status: 403 });

    const res = await runCli(["kb", "upload", tempFile("a.txt", "alpha")]);

    expect(puts).toHaveLength(1);
    // The regression this guards: the PUT was once fire-and-forget, so a
    // rejected object was summarized as a success and the user waited forever
    // for a document that was never stored.
    expect(res.stderr).toContain("a.txt");
    expect(res.stderr).toContain("S3 upload failed: 403");
    expect(res.stderr).toContain("0/1 file(s) uploaded");
  });

  it("keeps uploading the remaining files after one of them fails", async () => {
    const failing = "https://s3.test.invalid/senso-uploads/broken";
    const puts: string[] = [];
    server.use(
      http.post(apiUrl("/org/kb/upload"), () =>
        HttpResponse.json(uploadResponse([accepted("a.txt", failing), accepted("b.txt")])),
      ),
      http.put(failing, () => new HttpResponse(null, { status: 500 })),
      http.put(S3_URL, async ({ request }) => {
        puts.push(Buffer.from(await request.arrayBuffer()).toString("utf-8"));
        return new HttpResponse(null, { status: 200 });
      }),
    );

    const res = await runCli([
      "kb",
      "upload",
      tempFile("a.txt", "alpha"),
      tempFile("b.txt", "bravo"),
    ]);

    expect(res.exitCode).toBe(0);
    expect(puts).toEqual(["bravo"]);
    expect(res.stderr).toContain("1/2 file(s) uploaded");
  });

  it("exits 1 when nothing was stored, naming how many it tried", async () => {
    // A batch where nothing was stored used to exit 0, so a script branching on
    // the exit code saw success. Same fix in `senso ingest upload`.
    serveUpload([accepted("a.txt")], { s3Status: 500 });

    const res = await runCli(["kb", "upload", tempFile("a.txt", "alpha")]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("No files were uploaded (1 attempted)");
  });
});

describe("kb upload, where it differs from ingest upload", () => {
  it("exits 2 and says how many files were passed when there are more than 10", async () => {
    const files = Array.from({ length: 11 }, (_, i) => tempFile(`f${i}.txt`, "x"));

    const res = await runCli(["kb", "upload", ...files]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Maximum 10 files");
    expect(res.stderr).toContain("You passed 11");
  });

  // The same pre-checks `ingest upload` makes: a path the caller got wrong is a
  // usage error naming the file, not an ENOENT off the runtime path.
  it("exits 2 naming the file when a path does not exist", async () => {
    const res = await runCli(["kb", "upload", join(workDir, "absent.txt")]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("File not found");
    expect(res.stderr).toContain("absent.txt");
  });

  // No handler is registered: a request here would be unmocked and fail the
  // test, which is the assertion — nothing is sent for a zero-byte file.
  it("exits 2 and sends nothing for an empty file", async () => {
    const res = await runCli(["kb", "upload", tempFile("empty.txt", "")]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Empty file(s)");
    expect(res.stderr).toContain("empty.txt");
  });

  // Every failure of the metadata POST used to be funneled through
  // handleUploadError and rethrown as EXIT.ERROR, so a rejected key, a missing
  // folder and a missing credential all reached a script as 1. Only the
  // batch-rejection body is unpacked now; the rest keep their own exit code.
  it("exits 3 on a rejected API key", async () => {
    server.use(
      http.post(apiUrl("/org/kb/upload"), () =>
        HttpResponse.json({ error: "invalid key" }, { status: 401 }),
      ),
    );

    const res = await runCli(["kb", "upload", tempFile("a.txt", "alpha")]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Authentication failed");
  });

  it("exits 4 on a missing destination folder", async () => {
    server.use(http.post(apiUrl("/org/kb/upload"), () => new HttpResponse(null, { status: 404 })));

    const res = await runCli(["kb", "upload", tempFile("a.txt", "alpha"), "--folder-id", "n-gone"]);

    expect(res.exitCode).toBe(4);
    expect(res.stderr).toContain("Not found");
  });

  it("exits 3 when there is no API key at all", async () => {
    const res = await runCli(["kb", "upload", tempFile("a.txt", "alpha")], { withKey: false });

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("no API key found");
  });

  // The one failure shape that still reports per-file reasons and exits 1: the
  // endpoint refused the whole batch and said why for each file.
  it("still unpacks a whole-batch rejection and exits 1", async () => {
    server.use(
      http.post(apiUrl("/org/kb/upload"), () =>
        HttpResponse.json(uploadResponse([rejected("a.txt", "quota_exceeded", "Over quota.")]), {
          status: 400,
        }),
      ),
    );

    const res = await runCli(["kb", "upload", tempFile("a.txt", "alpha")]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("a.txt");
    expect(res.stderr).toContain("Over quota.");
  });
});

describe("kb update-file, on the wire", () => {
  it("PUTs the new file's metadata to the node, then the bytes to S3", async () => {
    const contents = "version two";
    let body: unknown;
    let seen: Request | undefined;
    const puts: string[] = [];
    server.use(
      http.put(apiUrl("/org/kb/nodes/:nodeId/file"), async ({ request }) => {
        seen = request.clone();
        body = await request.json();
        return HttpResponse.json(accepted("doc.txt"));
      }),
      http.put(S3_URL, async ({ request }) => {
        puts.push(Buffer.from(await request.arrayBuffer()).toString("utf-8"));
        return new HttpResponse(null, { status: 200 });
      }),
    );

    const res = await runCli(["kb", "update-file", "n-doc", tempFile("doc.txt", contents)]);

    expect(res.exitCode).toBe(0);
    expect(new URL(seen!.url).pathname).toBe("/api/v1/org/kb/nodes/n-doc/file");
    // A single `file` object, not the `files` array the batch endpoint takes.
    expect(body).toEqual({
      file: {
        filename: "doc.txt",
        file_size_bytes: Buffer.byteLength(contents),
        content_type: "text/plain",
        content_hash_md5: md5(contents),
      },
    });
    expect(puts).toEqual([contents]);
    expect(res.stderr).toContain("Background re-processing started");
  });

  it("warns and skips the S3 PUT when the API declines the new version", async () => {
    server.use(
      http.put(apiUrl("/org/kb/nodes/:nodeId/file"), () =>
        HttpResponse.json(rejected("doc.txt", "duplicate", "Same content as the current version.")),
      ),
    );

    // No S3 handler: a PUT here would be an unmocked request and fail the test,
    // which is the assertion — nothing is uploaded for a declined version.
    const res = await runCli(["kb", "update-file", "n-doc", tempFile("doc.txt", "v2")]);

    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain("Skipped: duplicate");
    expect(res.stderr).toContain("Same content as the current version.");
  });
});

describe("kb, on success", () => {
  it("prints the node list unmodified under --output json", async () => {
    server.use(http.get(apiUrl("/org/kb/my-files"), () => HttpResponse.json(NODES)));

    const res = await runCli(["kb", "my-files", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.json()).toEqual(NODES);
    // Nothing decorative alongside it: no banner, no success tick.
    expect(res.stderr).toBe("");
  });

  it("renders one row per node, in the KB's own columns, under --output table", async () => {
    server.use(http.get(apiUrl("/org/kb/my-files"), () => HttpResponse.json(NODES)));

    const res = await runCli(["kb", "my-files", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("kb_node_id");
    expect(res.stdout).toContain("Handbook");
    expect(res.stdout).toContain("folder");
  });

  it("renders a readable block per node by default", async () => {
    server.use(http.get(apiUrl("/org/kb/my-files"), () => HttpResponse.json(NODES)));

    const res = await runCli(["kb", "my-files"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Onboarding.pdf");
    expect(res.stdout).toContain("n-doc");
  });

  it("says so plainly when a folder has no children", async () => {
    server.use(
      http.get(apiUrl("/org/kb/nodes/:nodeId/children"), () =>
        HttpResponse.json({ nodes: [], total: 0, limit: 50, offset: 0 }),
      ),
    );

    const res = await runCli(["kb", "children", "n-folder"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("nodes");
  });

  it("prints a single node unmodified under --output json", async () => {
    server.use(http.get(apiUrl("/org/kb/nodes/:nodeId"), () => HttpResponse.json(ONE_NODE)));

    const res = await runCli(["kb", "get", "n-doc", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.json()).toEqual(ONE_NODE);
    expect(res.stderr).toBe("");
  });

  it("renders a single node as field/value rows under --output table", async () => {
    server.use(http.get(apiUrl("/org/kb/nodes/:nodeId"), () => HttpResponse.json(ONE_NODE)));

    const res = await runCli(["kb", "get", "n-doc", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("field");
    expect(res.stdout).toContain("Onboarding.pdf");
  });

  it("renders key/value lines for a single node by default", async () => {
    server.use(http.get(apiUrl("/org/kb/nodes/:nodeId"), () => HttpResponse.json(ONE_NODE)));

    const res = await runCli(["kb", "get", "n-doc"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("parent_id");
    expect(res.stdout).toContain("n-folder");
  });

  it("puts the created folder on stdout and the tick on stderr", async () => {
    server.use(
      http.post(apiUrl("/org/kb/folders"), () =>
        HttpResponse.json({ kb_node_id: "n-new", name: "Legal" }),
      ),
    );

    const res = await runCli(["kb", "create-folder", "--name", "Legal"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("n-new");
    expect(res.stderr).toContain('Folder "Legal" created.');
    expect(res.stdout).not.toContain("created.");
  });

  it("keeps the rename tick off stdout", async () => {
    server.use(
      http.patch(apiUrl("/org/kb/nodes/:nodeId/rename"), () => HttpResponse.json(ONE_NODE)),
    );

    const res = await runCli(["kb", "rename", "n-doc", "--name", "New name"]);

    expect(res.stderr).toContain("renamed");
    expect(res.stdout).not.toContain("renamed");
  });

  it("suppresses the tick entirely under --output json", async () => {
    server.use(http.patch(apiUrl("/org/kb/nodes/:nodeId/move"), () => HttpResponse.json(ONE_NODE)));

    const res = await runCli([
      "kb",
      "move",
      "n-doc",
      "--parent-id",
      "n-folder",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.json()).toEqual(ONE_NODE);
    // json implies quiet, so the progress line is not merely moved — it is gone.
    expect(res.stderr).toBe("");
  });
});

describe("kb delete and tags remove, confirming without a payload", () => {
  it("prints a parseable object on stdout under --output json", async () => {
    server.use(
      http.delete(apiUrl("/org/kb/nodes/:nodeId"), () => new HttpResponse(null, { status: 204 })),
    );

    const res = await runCli(["kb", "delete", "n-doc", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    // A 204 has no payload, so the command invents one rather than emitting a
    // success sentence that `jq` cannot parse.
    expect(res.json()).toMatchObject({ ok: true });
    expect(res.stderr).toBe("");
  });

  it("puts the ✓ on stderr and leaves stdout empty in plain mode", async () => {
    server.use(
      http.delete(apiUrl("/org/kb/nodes/:nodeId"), () => new HttpResponse(null, { status: 204 })),
    );

    const res = await runCli(["kb", "delete", "n-doc"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Node n-doc deleted.");
  });

  it("confirms a tag detach the same way", async () => {
    server.use(
      http.delete(
        apiUrl("/org/kb/nodes/:nodeId/tags/:tagId"),
        () => new HttpResponse(null, { status: 204 }),
      ),
    );

    const res = await runCli(["kb", "tags", "remove", "n-doc", "--id", "t-1", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.json()).toMatchObject({ ok: true });
  });

  it("stays quiet on stdout when a tag is attached", async () => {
    server.use(
      http.post(
        apiUrl("/org/kb/nodes/:nodeId/tags"),
        () => new HttpResponse(null, { status: 204 }),
      ),
    );

    const res = await runCli(["kb", "tags", "add", "n-doc", "--name", "handbook"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Tag attached to KB node n-doc.");
  });
});

/**
 * The three additions that reach past a single node: `stats`, `bulk-delete`,
 * and the `kb permissions` subgroup.
 *
 * `bulk-delete` is the most destructive command in the group — folders take
 * their subtree with them and the batch is all-or-nothing — so what is asserted
 * here is that the ids reach the API as `node_ids` and that a batch past the
 * documented ceiling of 100 never leaves the machine.
 *
 * The permissions subgroup is four commands over two routes that differ only by
 * a trailing id, with a PATCH and a DELETE sharing the longer one. The role
 * flag is closed at viewer|editor because `owner` is reserved and the API
 * answers a request for it with a 400 that reads like a server fault.
 */

const KB_STATS = { total_files: 42, total_folders: 7 };

const GRANTS = {
  grants: [
    {
      id: "g-1",
      node_id: "n-doc",
      role: "viewer",
      grantee: { type: "user", id: "u-1", display_name: "Ada", email: "ada@example.com" },
      granted_at: "2026-01-01T00:00:00Z",
    },
  ],
};

describe("kb stats and bulk-delete, on the wire", () => {
  it("reads the counts from /org/kb/stats", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/kb/stats"), ({ request }) => {
        seen = request;
        return HttpResponse.json(KB_STATS);
      }),
    );

    const res = await runCli(["kb", "stats"]);

    expect(res.exitCode).toBe(0);
    expect(seen?.method).toBe("GET");
    expect(res.stdout).toContain("42");
  });

  it("posts every id as node_ids to /org/kb/nodes/bulk-delete", async () => {
    let body: unknown;
    server.use(
      http.post(apiUrl("/org/kb/nodes/bulk-delete"), async ({ request }) => {
        body = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await runCli(["kb", "bulk-delete", "n-1", "n-2", "n-3"]);

    expect(body).toEqual({ node_ids: ["n-1", "n-2", "n-3"] });
  });

  it("exits 2 without making a request when more than 100 nodes are named", async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `n-${String(i)}`);

    // No handler registered: setup.ts fails the test on an unhandled request,
    // so this also proves nothing was sent.
    const res = await runCli(["kb", "bulk-delete", ...ids]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Maximum 100");
  });

  it("exits 1 when the batch is refused because one node is still ingesting", async () => {
    server.use(
      http.post(apiUrl("/org/kb/nodes/bulk-delete"), () =>
        HttpResponse.json({ error: "node is still ingesting" }, { status: 409 }),
      ),
    );

    const res = await runCli(["kb", "bulk-delete", "n-1"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
  });

  it("confirms the delete on stderr and gives a JSON caller an object", async () => {
    server.use(
      http.post(apiUrl("/org/kb/nodes/bulk-delete"), () => new HttpResponse(null, { status: 204 })),
    );

    const plain = await runCli(["kb", "bulk-delete", "n-1", "n-2"]);
    expect(plain.stdout).toBe("");
    expect(plain.stderr).toContain("Deleted 2 node(s).");

    server.use(
      http.post(apiUrl("/org/kb/nodes/bulk-delete"), () => new HttpResponse(null, { status: 204 })),
    );

    const json = await runCli(["kb", "bulk-delete", "n-1", "n-2", "--output", "json"]);
    expect(json.json()).toMatchObject({ ok: true });
  });
});

describe("kb permissions, on the wire", () => {
  it("lists the grants on a node", async () => {
    let url: string | undefined;
    server.use(
      http.get(apiUrl("/org/kb/nodes/:id/permissions"), ({ request }) => {
        url = request.url;
        return HttpResponse.json(GRANTS);
      }),
    );

    await runCli(["kb", "permissions", "list", "n-doc"]);

    expect(url).toContain("/org/kb/nodes/n-doc/permissions");
  });

  it("sends grantee_type, grantee_id and role in snake_case on add", async () => {
    let body: unknown;
    server.use(
      http.post(apiUrl("/org/kb/nodes/:id/permissions"), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(GRANTS.grants[0], { status: 201 });
      }),
    );

    await runCli([
      "kb",
      "permissions",
      "add",
      "n-doc",
      "--grantee-type",
      "group",
      "--grantee-id",
      "grp-1",
      "--role",
      "editor",
    ]);

    expect(body).toEqual({ grantee_type: "group", grantee_id: "grp-1", role: "editor" });
  });

  it("patches only the role, at the permission's own route", async () => {
    let url: string | undefined;
    let method: string | undefined;
    let body: unknown;
    server.use(
      http.patch(apiUrl("/org/kb/nodes/:id/permissions/:permissionId"), async ({ request }) => {
        url = request.url;
        method = request.method;
        body = await request.json();
        return HttpResponse.json({ message: "ok" });
      }),
    );

    await runCli(["kb", "permissions", "update", "n-doc", "g-1", "--role", "viewer"]);

    expect(method).toBe("PATCH");
    expect(url).toContain("/org/kb/nodes/n-doc/permissions/g-1");
    expect(body).toEqual({ role: "viewer" });
  });

  it("revokes a grant with a DELETE to the permission's route", async () => {
    let url: string | undefined;
    server.use(
      http.delete(apiUrl("/org/kb/nodes/:id/permissions/:permissionId"), ({ request }) => {
        url = request.url;
        return HttpResponse.json({ message: "revoked" });
      }),
    );

    await runCli(["kb", "permissions", "remove", "n-doc", "g-1"]);

    expect(url).toContain("/org/kb/nodes/n-doc/permissions/g-1");
  });
});

describe("kb permissions, refusing a request before making it", () => {
  it("exits 2 and names the grantable roles when --role is owner", async () => {
    const res = await runCli([
      "kb",
      "permissions",
      "add",
      "n-doc",
      "--grantee-type",
      "user",
      "--grantee-id",
      "u-1",
      "--role",
      "owner",
    ]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("viewer, editor");
  });

  it("exits 2 when --grantee-type is neither user nor group", async () => {
    const res = await runCli([
      "kb",
      "permissions",
      "add",
      "n-doc",
      "--grantee-type",
      "team",
      "--grantee-id",
      "t-1",
      "--role",
      "viewer",
    ]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("user, group");
  });

  it("exits 2 when the update names a role that cannot be assigned", async () => {
    const res = await runCli(["kb", "permissions", "update", "n-doc", "g-1", "--role", "owner"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
  });
});

describe("kb permissions, on success and on refusal", () => {
  it("prints the grants unmodified under --output json", async () => {
    server.use(http.get(apiUrl("/org/kb/nodes/:id/permissions"), () => HttpResponse.json(GRANTS)));

    const res = await runCli(["kb", "permissions", "list", "n-doc", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.json()).toEqual(GRANTS);
    expect(res.stderr).toBe("");
  });

  it("renders one row per grant under --output table", async () => {
    server.use(http.get(apiUrl("/org/kb/nodes/:id/permissions"), () => HttpResponse.json(GRANTS)));

    const res = await runCli(["kb", "permissions", "list", "n-doc", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("role");
    expect(res.stdout).toContain("viewer");
  });

  it("keeps the tick off stdout when a grant is created", async () => {
    server.use(
      http.post(apiUrl("/org/kb/nodes/:id/permissions"), () =>
        HttpResponse.json(GRANTS.grants[0], { status: 201 }),
      ),
    );

    const res = await runCli([
      "kb",
      "permissions",
      "add",
      "n-doc",
      "--grantee-type",
      "user",
      "--grantee-id",
      "u-1",
      "--role",
      "viewer",
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain("Granted viewer on node n-doc.");
    expect(res.stdout).not.toContain("Granted viewer");
  });

  it("exits 3 when the API refuses to let the caller change their own grant", async () => {
    server.use(
      http.patch(apiUrl("/org/kb/nodes/:id/permissions/:permissionId"), () =>
        HttpResponse.json({ error: "you cannot modify your own grant" }, { status: 403 }),
      ),
    );

    const res = await runCli(["kb", "permissions", "update", "n-doc", "g-1", "--role", "viewer"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
  });
});
