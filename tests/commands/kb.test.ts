/**
 * Command layer: `senso kb`, including the nested `kb tags` and `kb permissions`
 * groups.
 *
 * The knowledge base is the widest command group in the CLI — twenty-odd
 * subcommands over one tree of nodes — and almost all of them differ from each
 * other only in a method and a path. That is exactly the kind of surface where a
 * renamed parameter is invisible: `move` sends `new_parent_id` while
 * `create-folder` sends `parent_id`, `find` sends the query as `q` while the
 * flag is `--query`, and `tags remove` chooses between two entirely different
 * requests depending on which flag it got. None of that is checked by the type
 * system or visible from the command line, so it is asserted on the wire here.
 *
 * What is worth protecting, beyond the wire format:
 *
 *   1. **Honest fixtures.** Every response below is built from the real shapes
 *      in senso-api — dto.KBNodeResponse, dto.TagResponse,
 *      dto.IngestionUploadResponse, dto.ContentResponse,
 *      dto.ContentDownloadURLResponse, dto.KBNodeGrant. The previous fixtures
 *      invented `tag_id` where the API returns `id`, dropped the `tags` array
 *      that every node carries, and answered `sync-status` with a field it does
 *      not have. A dishonest fixture is how a blank column and a node that
 *      rendered as "No tags found." both shipped green.
 *   2. **The envelope.** `--output json` is one `{ ok, command, data, page?,
 *      next?, warnings? }` object on stdout; a failure is `{ ok: false, command,
 *      error }` on stderr with stdout empty. `res.data()` asserts the former.
 *   3. **Validation before the request.** Every `<id>` here is a UUID, checked
 *      locally, so a typo costs exit 2 and no round trip. Tests for that branch
 *      register no MSW handler: setup.ts fails on an unhandled request, which is
 *      how "nothing was sent" is asserted.
 *   4. **The two-step upload.** POST the metadata, receive a presigned S3 URL
 *      per accepted file, PUT the bytes. The metadata is asserted against a real
 *      file on disk, because a hash or a size that disagrees with the bytes
 *      produces a request the API accepts and an object S3 rejects.
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
import { apiUrl, envelope, errorEnvelope, runCli } from "../helpers.js";

// ── Ids ──
//
// Real UUIDs, because `parseId` rejects anything else before the request. The
// four id spaces in play are kept visibly distinct: a test that swapped a
// content_id for a kb_node_id should read wrong.

const ROOT_ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const FOLDER_ID = "b204e7f1-5c6a-4d38-a9e2-71f0c3b85d6a";
const DOC_ID = "3f2a8c14-9e05-4b77-8d21-6c0b7a4e1f39";
const OTHER_DOC_ID = "7d10b3c5-8e42-4a6f-b913-2c58d0e7a4f6";
const MISSING_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const CONTENT_ID = "5c8e2f70-1a94-4d63-b02f-8e7c15a9d4b3";
const TAG_ID = "c3d9a0b2-6e11-4f77-8a25-0d4b9e6f2c18";
const OTHER_TAG_ID = "e51f7b48-30ac-4d92-9f16-4b8c2e70a5d1";
const GRANT_ID = "9e3b7c02-4a18-4f65-8d90-1c2e5b7a6f43";
const USER_ID = "d8e1f0a3-2b74-4c19-9e56-3a0f8b7d4c21";
const GROUP_ID = "6b0d9f23-7e41-4a85-93c7-25f1a8d40e6b";
const ORG_ID = "1f9c6d84-2e30-4b51-87a9-5d6e3c0f41b7";
const RUN_ID = "2b7e4a19-0c63-4d85-9f21-8a5c7d3e6b04";

/** dto.TagResponse. The id field is `id`, not `tag_id`. */
const TAG = {
  id: TAG_ID,
  org_id: ORG_ID,
  name: "handbook",
  curated: true,
  created_at: "2026-03-01T00:00:00Z",
  updated_at: "2026-03-01T00:00:00Z",
};

/** dto.KBNodeResponse for a folder. `tags` is always present, empty or not. */
const FOLDER_NODE = {
  kb_node_id: FOLDER_ID,
  org_id: ORG_ID,
  parent_id: ROOT_ID,
  type: "folder",
  name: "Handbook",
  tags: [],
  effective_role: "editor",
  is_public: false,
  is_public_root: false,
  created_at: "2026-03-01T00:00:00Z",
  updated_at: "2026-03-01T00:00:00Z",
};

/** dto.KBNodeResponse for a document, with the nested KBNodeContentInfo. */
const DOC_NODE = {
  kb_node_id: DOC_ID,
  org_id: ORG_ID,
  parent_id: FOLDER_ID,
  content_id: CONTENT_ID,
  type: "content",
  name: "Onboarding.pdf",
  content: {
    id: CONTENT_ID,
    type: "file",
    content_type: "application/pdf",
    title: "Onboarding",
    version_num: 2,
    processing_status: "complete",
  },
  tags: [TAG],
  effective_role: "editor",
  is_public: false,
  is_public_root: false,
  created_at: "2026-03-01T00:00:00Z",
  updated_at: "2026-03-02T00:00:00Z",
};

/** dto.KBNodeListResponse. */
const NODE_LIST = {
  nodes: [FOLDER_NODE, DOC_NODE],
  total: 2,
  limit: 50,
  offset: 0,
};

/** The same list, but one page of a larger result set. */
const PAGED_LIST = { nodes: [FOLDER_NODE, DOC_NODE], total: 120, limit: 50, offset: 0 };

const EMPTY_LIST = { nodes: [], total: 0, limit: 50, offset: 0 };

/** dto.KBNodeAncestorsResponse, root first. */
const ANCESTORS = {
  ancestors: [
    { ...FOLDER_NODE, kb_node_id: ROOT_ID, parent_id: null, name: "My Files" },
    FOLDER_NODE,
  ],
};

/** dto.ContentResponse as the raw endpoints return it, carrying kb_node_id. */
const RAW_CONTENT = {
  id: CONTENT_ID,
  org_id: ORG_ID,
  type: "raw",
  title: "Refund Policy",
  summary: "How refunds work.",
  version_num: 1,
  processing_status: "pending",
  content_type: "text/markdown",
  created_at: "2026-03-01T00:00:00Z",
  updated_at: "2026-03-01T00:00:00Z",
  kb_node_id: DOC_ID,
};

/** dto.ContentDetailResponse, which is what `kb get-content` reads. */
const CONTENT_DETAIL = {
  id: CONTENT_ID,
  org_id: ORG_ID,
  type: "raw",
  title: "Onboarding",
  summary: "Day one.",
  org_tags: [TAG],
  version_num: 2,
  editorial_status: "approved",
  processing_status: "complete",
  created_at: "2026-03-01T00:00:00Z",
  updated_at: "2026-03-02T00:00:00Z",
  text: "# Onboarding\n\nWelcome aboard.",
  content_type: "text/markdown",
};

/** dto.KBStatsResponse. */
const KB_STATS = { total_files: 42, total_folders: 7 };

/** dto.KBNodeGrantListResponse. */
const GRANTS = {
  grants: [
    {
      id: GRANT_ID,
      node_id: DOC_ID,
      role: "viewer",
      grantee: {
        type: "user",
        id: USER_ID,
        display_name: "Ada Lovelace",
        email: "ada@example.com",
      },
      granted_at: "2026-01-01T00:00:00Z",
    },
  ],
};

/** Where a presigned URL points. Nothing listens on it; MSW answers. */
const S3_URL = "https://s3.test.invalid/senso-uploads/abc123?X-Amz-Signature=deadbeef";
// MSW matches handlers on the path and warns if the pattern carries a query
// string, so handlers register on this and read the signature off request.url.
const S3_PATH = "https://s3.test.invalid/senso-uploads/abc123";

/** dto.ContentDownloadURLResponse. Both URLs, and the expiry in epoch ms. */
const DOWNLOAD = {
  url: S3_URL,
  download_url: `${S3_URL}&response-content-disposition=attachment`,
  filename: "Onboarding.pdf",
  content_type: "application/pdf",
  file_size_bytes: 20_480,
  expiry_utc_ms: 1_772_323_200_000,
};

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

/** The URL of a request MSW recorded, or a failure naming the omission. */
function urlOf(request: Request | undefined): URL {
  if (request === undefined) throw new Error("no request reached the mock server");
  return new URL(request.url);
}

/** dto.IngestionUploadResultItem for a file the API accepted. */
function accepted(
  filename: string,
  overrides: { url?: string; nodeId?: string; contentId?: string } = {},
) {
  return {
    filename,
    status: "upload_pending",
    upload_url: overrides.url ?? S3_URL,
    expires_in: 900,
    ingestion_run_id: RUN_ID,
    content_id: overrides.contentId ?? CONTENT_ID,
    kb_node_id: overrides.nodeId ?? DOC_ID,
  };
}

/** The same item for a file the API refused; kb_node_id is absent by design. */
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
      if (opts.s3Status !== undefined && opts.s3Status >= 400) {
        return new HttpResponse(null, { status: opts.s3Status });
      }
      return new HttpResponse(null, { status: 200 });
    }),
  );

  return { prepBodies, puts };
}

describe("kb, when the command line is wrong", () => {
  // No MSW handler in this block unless a test says otherwise: setup.ts fails
  // the test on an unhandled request, so each of these also proves that a
  // malformed command line never reached the network.

  it("exits 2 when <id> is not a UUID, naming the argument and the id space", async () => {
    const res = await runCli(["kb", "get", "n-doc"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("not a UUID");
    expect(res.stderr).toContain("senso kb my-files");
  });

  it("puts the offending field and value in the JSON error, so an agent can fix itself", async () => {
    const res = await runCli(["kb", "get", "n-doc", "--output", "json"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(errorEnvelope(res).error).toMatchObject({
      code: "usage",
      field: "<id>",
      received: "n-doc",
    });
  });

  it("exits 2 when --parent-id is not a UUID on move", async () => {
    const res = await runCli([
      "kb",
      "move",
      DOC_ID,
      "--parent-id",
      "the-other-folder",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    // The node's own id was fine, so the error has to say which of the two was
    // not — the command takes one id in each position.
    expect(errorEnvelope(res).error).toMatchObject({
      field: "--parent-id",
      received: "the-other-folder",
    });
  });

  it("exits 2 when --parent-id is the node being moved", async () => {
    const res = await runCli(["kb", "move", DOC_ID, "--parent-id", DOC_ID]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("the node being moved");
  });

  it("exits 2 and names the allowed set when --status is not an ingestion state", async () => {
    const res = await runCli(["kb", "my-files", "--status", "archived", "--output", "json"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(errorEnvelope(res).error.allowed).toEqual([
      "pending",
      "processing",
      "complete",
      "failed",
    ]);
  });

  it("exits 2 when --limit is below the API's floor rather than sending it", async () => {
    const res = await runCli(["kb", "my-files", "--limit", "0"]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("out of range");
  });

  it("exits 2 when --tag-ids carries something that is not a UUID", async () => {
    const res = await runCli(["kb", "my-files", "--tag-ids", `${TAG_ID},handbook`, "--output", "json"]);

    expect(res.exitCode).toBe(2);
    expect(errorEnvelope(res).error).toMatchObject({ field: "--tag-ids", received: "handbook" });
  });

  it("exits 2 when find's --query is blank, rather than listing everything", async () => {
    const res = await runCli(["kb", "find", "--query", "   "]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("--query is empty");
  });

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

  it("exits 2 when create-raw's --data names a key the API would silently ignore", async () => {
    const res = await runCli([
      "kb",
      "create-raw",
      "--data",
      '{"text":"hi","titel":"typo"}',
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    expect(errorEnvelope(res).error).toMatchObject({ field: "--data", received: "titel" });
  });

  it("exits 2 when create-raw's text is an empty string", async () => {
    const res = await runCli(["kb", "create-raw", "--data", '{"text":"   "}']);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("empty `text`");
  });

  it("exits 2 when update-raw's --data is missing a required key", async () => {
    const res = await runCli(["kb", "update-raw", OTHER_DOC_ID, "--data", '{"title":"T"}']);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("text");
  });

  it("exits 2 when patch-raw's --data names none of title, summary or text", async () => {
    const res = await runCli([
      "kb",
      "patch-raw",
      OTHER_DOC_ID,
      "--data",
      `{"tag_ids":["${TAG_ID}"]}`,
    ]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("at least one of");
  });

  it("exits 2 when a --data tag_ids entry is not a UUID", async () => {
    const res = await runCli([
      "kb",
      "patch-raw",
      OTHER_DOC_ID,
      "--data",
      '{"title":"T","tag_ids":["handbook"]}',
    ]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("not a UUID");
  });

  it("exits 2 when tags add is given neither --name nor --id", async () => {
    const res = await runCli(["kb", "tags", "add", DOC_ID]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Provide --name or --id");
  });

  it("exits 2 when tags add is given both --name and --id, rather than picking one", async () => {
    // They can name two different tags, and only one would be attached.
    const res = await runCli(["kb", "tags", "add", DOC_ID, "--name", "hr", "--id", TAG_ID]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("not both");
  });

  it("exits 2 when tags remove is given neither --name nor --id", async () => {
    const res = await runCli(["kb", "tags", "remove", DOC_ID]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Provide --name or --id");
  });

  it("refuses tags set with neither --names nor --ids, instead of clearing every tag", async () => {
    // The API reads `{}` as "remove them all", so the old no-flag invocation
    // silently stripped a document's tags and reported success. This is the
    // regression the whole flag set exists to prevent.
    const res = await runCli(["kb", "tags", "set", DOC_ID]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Provide --names and/or --ids, or --clear");
  });

  it("exits 2 when tags set is given --clear alongside a replacement set", async () => {
    const res = await runCli(["kb", "tags", "set", DOC_ID, "--clear", "--names", "hr"]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("--clear cannot be combined");
  });

  it("exits 2 and names the grantable roles when --role is owner", async () => {
    const res = await runCli([
      "kb",
      "permissions",
      "add",
      DOC_ID,
      "--grantee-type",
      "user",
      "--grantee-id",
      USER_ID,
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
      DOC_ID,
      "--grantee-type",
      "team",
      "--grantee-id",
      USER_ID,
      "--role",
      "viewer",
    ]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("user, group");
  });

  it("exits 2 when the permission update names a role that cannot be assigned", async () => {
    const res = await runCli(["kb", "permissions", "update", DOC_ID, GRANT_ID, "--role", "owner"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
  });

  it("exits 2 without making a request when more than 100 nodes are named", async () => {
    const ids = Array.from({ length: 101 }, () => DOC_ID);

    const res = await runCli(["kb", "bulk-delete", ...ids]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Maximum 100");
    expect(res.stderr).toContain("You passed 101");
  });

  it("names the valid formats when --output is not one of them", async () => {
    const res = await runCli(["kb", "root", "--output", "yaml"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("json, table, plain");
  });
});

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

  it("points a 403 on a node at the per-node grant, not at the org admin", async () => {
    // A KB node's access is granted per node, so "ask an admin to widen your
    // key" is advice that cannot work here.
    server.use(
      http.get(apiUrl("/org/kb/nodes/:nodeId"), () =>
        HttpResponse.json({ error: "no grant on this node" }, { status: 403 }),
      ),
    );

    const res = await runCli(["kb", "get", DOC_ID]);

    expect(res.exitCode).toBe(3);
    expect(res.stderr).toContain("senso kb permissions add");
  });

  it("exits 4 naming the resource and the id, not a bare 'Not found'", async () => {
    server.use(
      http.get(apiUrl("/org/kb/nodes/:nodeId"), () => new HttpResponse(null, { status: 404 })),
    );

    const res = await runCli(["kb", "get", MISSING_ID]);

    expect(res.exitCode).toBe(4);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain(`KB node ${MISSING_ID} not found`);
    expect(res.stderr).toContain("senso kb my-files");
  });

  it("carries the id space in the JSON error, so a caller can see which id was wrong", async () => {
    server.use(
      http.get(apiUrl("/org/kb/nodes/:nodeId"), () => new HttpResponse(null, { status: 404 })),
    );

    const res = await runCli(["kb", "get", MISSING_ID, "--output", "json"]);

    expect(res.exitCode).toBe(4);
    expect(res.stdout).toBe("");
    expect(errorEnvelope(res).error).toMatchObject({
      code: "not_found",
      status: 404,
      field: "kb_node_id",
      received: MISSING_ID,
      request: { method: "GET", path: `/org/kb/nodes/${MISSING_ID}` },
    });
  });

  it("exits 1 on a 500 and says retrying may work", async () => {
    server.use(
      http.get(apiUrl("/org/kb/my-files"), () =>
        HttpResponse.json({ error: "boom" }, { status: 500 }),
      ),
    );

    const res = await runCli(["kb", "my-files"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("server-side failure");
    expect(res.stderr).toContain("Retry shortly");
  });

  it("exits 1 on a 503 and says retrying is precisely what will not work", async () => {
    // A deployment-level refusal, not a transient fault. Telling an agent to
    // retry here sends it into a loop that can never succeed.
    server.use(
      http.get(apiUrl("/org/kb/my-files"), () =>
        HttpResponse.json({ error: "The knowledge base is not enabled in this environment" }, { status: 503 }),
      ),
    );

    const res = await runCli(["kb", "my-files"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("not enabled in this environment");
    expect(res.stderr).toContain("not a transient failure");
    expect(res.stderr).not.toContain("Retry shortly");
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
    const failure = errorEnvelope(res);
    expect(failure.ok).toBe(false);
    expect(failure.command).toBe("kb root");
    expect(failure.error).toMatchObject({ code: "forbidden", status: 403 });
  });

  it("answers a 400 on children by naming the command that reads a document", async () => {
    server.use(
      http.get(apiUrl("/org/kb/nodes/:nodeId/children"), () =>
        HttpResponse.json({ error: "Node is not a folder" }, { status: 400 }),
      ),
    );

    const res = await runCli(["kb", "children", DOC_ID]);

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain(`senso kb get-content ${DOC_ID}`);
  });

  it("answers a 400 on get-content by naming the command that lists a folder", async () => {
    server.use(
      http.get(apiUrl("/org/kb/nodes/:nodeId/content"), () =>
        HttpResponse.json({ error: "Node has no associated content" }, { status: 400 }),
      ),
    );

    const res = await runCli(["kb", "get-content", FOLDER_ID]);

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain(`senso kb children ${FOLDER_ID}`);
  });

  it("answers a folder rejection on tags set by naming the documents inside it", async () => {
    server.use(
      http.put(apiUrl("/org/kb/nodes/:nodeId/tags"), () =>
        HttpResponse.json({ error: "Tags cannot be applied to folders" }, { status: 400 }),
      ),
    );

    const res = await runCli(["kb", "tags", "set", FOLDER_ID, "--names", "hr"]);

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain(`senso kb children ${FOLDER_ID} --type content`);
  });

  it("exits 1 when the bulk batch is refused because one node is still ingesting", async () => {
    server.use(
      http.post(apiUrl("/org/kb/nodes/bulk-delete"), () =>
        HttpResponse.json({ error: "node is still ingesting" }, { status: 409 }),
      ),
    );

    const res = await runCli(["kb", "bulk-delete", DOC_ID]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    // The API does not say which node, and the hint says so rather than
    // implying the CLI knows.
    expect(res.stderr).toContain("does not say which");
  });

  it("exits 3 when the API refuses to let the caller change their own grant", async () => {
    server.use(
      http.patch(apiUrl("/org/kb/nodes/:id/permissions/:permissionId"), () =>
        HttpResponse.json({ error: "you cannot modify your own grant" }, { status: 403 }),
      ),
    );

    const res = await runCli(["kb", "permissions", "update", DOC_ID, GRANT_ID, "--role", "viewer"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
  });
});

describe("kb browsing, on the wire", () => {
  it("GETs /org/kb/root with no query", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/kb/root"), ({ request }) => {
        seen = request;
        return HttpResponse.json({ ...FOLDER_NODE, kb_node_id: ROOT_ID, parent_id: null });
      }),
    );

    await runCli(["kb", "root"]);

    expect(seen?.method).toBe("GET");
    expect(urlOf(seen).pathname).toBe("/api/v1/org/kb/root");
    expect(urlOf(seen).search).toBe("");
  });

  it("GETs /org/kb/my-files with the default page window", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/kb/my-files"), ({ request }) => {
        seen = request;
        return HttpResponse.json(NODE_LIST);
      }),
    );

    await runCli(["kb", "my-files"]);

    const params = urlOf(seen).searchParams;
    expect(params.get("limit")).toBe("50");
    expect(params.get("offset")).toBe("0");
    // Absent rather than empty: an empty `type` would filter everything out.
    expect(params.has("type")).toBe(false);
  });

  it("passes every shared list flag through to my-files", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/kb/my-files"), ({ request }) => {
        seen = request;
        return HttpResponse.json(NODE_LIST);
      }),
    );

    await runCli([
      "kb",
      "my-files",
      "--limit",
      "5",
      "--offset",
      "10",
      "--type",
      "content",
      "--status",
      "failed",
      "--role",
      "editor",
      "--sort-by",
      "updated_at",
      "--sort-order",
      "desc",
      "--tag-ids",
      `${TAG_ID},${OTHER_TAG_ID}`,
    ]);

    const params = urlOf(seen).searchParams;
    expect(params.get("limit")).toBe("5");
    expect(params.get("offset")).toBe("10");
    expect(params.get("type")).toBe("content");
    expect(params.get("status")).toBe("failed");
    expect(params.get("role")).toBe("editor");
    expect(params.get("sort_by")).toBe("updated_at");
    expect(params.get("sort_order")).toBe("desc");
    // One comma-joined value, which is how the API reads a tag filter.
    expect(params.get("tag_ids")).toBe(`${TAG_ID},${OTHER_TAG_ID}`);
  });

  it("sends find's --query as the q parameter", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/kb/find"), ({ request }) => {
        seen = request;
        return HttpResponse.json({ ...NODE_LIST, limit: 20 });
      }),
    );

    await runCli(["kb", "find", "--query", "onboarding deck", "--type", "content"]);

    const params = urlOf(seen).searchParams;
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
        return HttpResponse.json({ syncing: false });
      }),
    );

    await runCli(["kb", "sync-status"]);

    expect(urlOf(seen).pathname).toBe("/api/v1/org/kb/sync-status");
  });

  it("GETs the node itself for get", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/kb/nodes/:nodeId"), ({ request }) => {
        seen = request;
        return HttpResponse.json(DOC_NODE);
      }),
    );

    await runCli(["kb", "get", DOC_ID]);

    expect(urlOf(seen).pathname).toBe(`/api/v1/org/kb/nodes/${DOC_ID}`);
  });

  it("GETs the children of a folder, with the page window", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/kb/nodes/:nodeId/children"), ({ request }) => {
        seen = request;
        return HttpResponse.json(NODE_LIST);
      }),
    );

    await runCli(["kb", "children", FOLDER_ID, "--type", "content"]);

    expect(urlOf(seen).pathname).toBe(`/api/v1/org/kb/nodes/${FOLDER_ID}/children`);
    expect(urlOf(seen).searchParams.get("type")).toBe("content");
    expect(urlOf(seen).searchParams.get("limit")).toBe("50");
  });

  it("GETs the ancestor chain for a node", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/kb/nodes/:nodeId/ancestors"), ({ request }) => {
        seen = request;
        return HttpResponse.json(ANCESTORS);
      }),
    );

    await runCli(["kb", "ancestors", DOC_ID]);

    expect(urlOf(seen).pathname).toBe(`/api/v1/org/kb/nodes/${DOC_ID}/ancestors`);
  });

  it("GETs a content node's detail with no query when no version is asked for", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/kb/nodes/:nodeId/content"), ({ request }) => {
        seen = request;
        return HttpResponse.json(CONTENT_DETAIL);
      }),
    );

    await runCli(["kb", "get-content", DOC_ID]);

    expect(urlOf(seen).pathname).toBe(`/api/v1/org/kb/nodes/${DOC_ID}/content`);
    expect(urlOf(seen).search).toBe("");
  });

  // `--rev`, not `--version`: the root declares `-v, --version` for the CLI's
  // own version and Commander answers it wherever it appears, so a `--version`
  // here never reached the action. The wire parameter is still `version`.
  it("sends --rev as the version query parameter on get-content", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/kb/nodes/:nodeId/content"), ({ request }) => {
        seen = request;
        return HttpResponse.json(CONTENT_DETAIL);
      }),
    );

    const res = await runCli(["kb", "get-content", DOC_ID, "--rev", "3"]);

    expect(res.exitCode).toBe(0);
    expect(urlOf(seen).searchParams.get("version")).toBe("3");
  });

  it("exits 2 when --rev is not a whole number, rather than sending NaN", async () => {
    const res = await runCli(["kb", "get-content", DOC_ID, "--rev", "latest"]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("not a whole number");
  });

  it("sends --rev as the version query parameter on download-url", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/kb/nodes/:nodeId/download-url"), ({ request }) => {
        seen = request;
        return HttpResponse.json(DOWNLOAD);
      }),
    );

    const res = await runCli(["kb", "download-url", DOC_ID, "--rev", "2"]);

    expect(res.exitCode).toBe(0);
    expect(urlOf(seen).searchParams.get("version")).toBe("2");
  });

  // The old spelling is gone, and Commander still answers it as the root's own
  // version flag — so it must not be documented on these subcommands again.
  it("still answers --version with the CLI's own version, making the rename necessary", async () => {
    const res = await runCli(["kb", "get-content", DOC_ID, "--version", "3"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("puts both presigned URLs on stdout, so a script can pick the attachment one", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/kb/nodes/:nodeId/download-url"), ({ request }) => {
        seen = request;
        return HttpResponse.json(DOWNLOAD);
      }),
    );

    const res = await runCli(["kb", "download-url", DOC_ID, "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(urlOf(seen).pathname).toBe(`/api/v1/org/kb/nodes/${DOC_ID}/download-url`);
    expect(res.data()).toEqual(DOWNLOAD);
  });
});

describe("kb browsing, what it renders", () => {
  it("wraps the node list in the envelope, with the payload unmodified", async () => {
    server.use(http.get(apiUrl("/org/kb/my-files"), () => HttpResponse.json(NODE_LIST)));

    const res = await runCli(["kb", "my-files", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    const env = envelope(res);
    expect(env.ok).toBe(true);
    expect(env.command).toBe("kb my-files");
    expect(env.data).toEqual(NODE_LIST);
    // Nothing decorative alongside it: no banner, no success tick.
    expect(res.stderr).toBe("");
  });

  it("derives the page window, and rebuilds a next-page command carrying the caller's filters", async () => {
    server.use(http.get(apiUrl("/org/kb/my-files"), () => HttpResponse.json(PAGED_LIST)));

    const res = await runCli(["kb", "my-files", "--status", "complete", "--output", "json"]);

    const { page } = envelope(res);
    expect(page).toMatchObject({ offset: 0, limit: 50, returned: 2, total: 120, has_more: true });
    // Runnable as written, filters included — a next-page hint that drops
    // --status pages through a different result set.
    expect(page?.next).toContain("--status complete");
    expect(page?.next).toContain("--offset 2");
  });

  it("carries what to do next in the envelope, where a json caller can read it", async () => {
    // stderr is silent under --output json, so guidance written only there
    // reaches nobody — and every published Senso skill passes --output json.
    server.use(http.get(apiUrl("/org/kb/my-files"), () => HttpResponse.json(NODE_LIST)));

    const res = await runCli(["kb", "my-files", "--output", "json"]);

    expect(envelope(res).next).toContainEqual({
      why: "Read one node in full",
      command: `senso kb get ${FOLDER_ID}`,
    });
  });

  it("warns when --limit asks for a page the API will silently cap", async () => {
    server.use(http.get(apiUrl("/org/kb/my-files"), () => HttpResponse.json(NODE_LIST)));

    const res = await runCli(["kb", "my-files", "--limit", "500", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(envelope(res).warnings?.[0]).toContain("capped at 50");
  });

  it("renders one row per node, in the KB's own columns, under --output table", async () => {
    server.use(http.get(apiUrl("/org/kb/my-files"), () => HttpResponse.json(NODE_LIST)));

    const res = await runCli(["kb", "my-files", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("kb_node_id");
    expect(res.stdout).toContain("Handbook");
    expect(res.stdout).toContain("folder");
    // The ingestion state, flattened into a column for the table alone.
    expect(res.stdout).toContain("status");
    expect(res.stdout).toContain("complete");
    // Every declared column exists on the rows, so nothing is blank.
    expect(res.stderr).not.toContain("did not return");
  });

  it("renders a readable block per node by default", async () => {
    server.use(http.get(apiUrl("/org/kb/my-files"), () => HttpResponse.json(NODE_LIST)));

    const res = await runCli(["kb", "my-files"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Onboarding.pdf");
    expect(res.stdout).toContain(DOC_ID);
    expect(res.stderr).toContain("Showing 1–2 of 2.");
  });

  it("says a list is empty, and names the filter that may have hidden the rows", async () => {
    server.use(http.get(apiUrl("/org/kb/my-files"), () => HttpResponse.json(EMPTY_LIST)));

    const res = await runCli(["kb", "my-files", "--status", "failed"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("No files found.");
    // Why it might be empty belongs on stderr, where it does not pollute the
    // payload a caller is parsing.
    expect(res.stderr).toContain("Active filters: --status");
    expect(res.stderr).toContain("drop them to widen the search");
  });

  it("says so plainly when a folder has no children, and how to put something in it", async () => {
    server.use(
      http.get(apiUrl("/org/kb/nodes/:nodeId/children"), () => HttpResponse.json(EMPTY_LIST)),
    );

    const res = await runCli(["kb", "children", FOLDER_ID]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("No children found.");
    expect(res.stderr).toContain(`senso kb upload <file> --folder-id ${FOLDER_ID}`);
  });

  it("says a name search matched nothing, and points at the full-text search", async () => {
    server.use(http.get(apiUrl("/org/kb/find"), () => HttpResponse.json({ ...EMPTY_LIST, limit: 20 })));

    const res = await runCli(["kb", "find", "--query", "refund"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('No nodes matching "refund" found.');
    expect(res.stderr).toContain('senso search --query "refund"');
  });

  it("renders content.processing_status readably, not buried in a JSON string", async () => {
    // This is the whole point of `kb get`: an agent polls it until ingestion
    // finishes. It used to come back inside a stringified `content` blob that
    // the caller then had to parse out of a key/value line.
    server.use(http.get(apiUrl("/org/kb/nodes/:nodeId"), () => HttpResponse.json(DOC_NODE)));

    const res = await runCli(["kb", "get", DOC_ID]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("processing_status");
    expect(res.stdout).toContain("complete");
    expect(res.stdout).not.toContain('{"id"');
    // And the node itself is still the payload: a node carries a `tags` array,
    // which must not be mistaken for the thing being rendered.
    expect(res.stdout).toContain(DOC_ID);
    expect(res.stdout).toContain("Onboarding.pdf");
  });

  it("still renders a node that has no tags at all", async () => {
    // `tags: []` is the normal state of a freshly created node, and an empty
    // array must not be read as "this payload is an empty list".
    server.use(http.get(apiUrl("/org/kb/nodes/:nodeId"), () => HttpResponse.json(FOLDER_NODE)));

    const res = await runCli(["kb", "get", FOLDER_ID]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain(FOLDER_ID);
    expect(res.stdout).toContain("Handbook");
    expect(res.stdout).not.toContain("No tags found.");
  });

  it("prints a single node unmodified under --output json", async () => {
    server.use(http.get(apiUrl("/org/kb/nodes/:nodeId"), () => HttpResponse.json(DOC_NODE)));

    const res = await runCli(["kb", "get", DOC_ID, "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toEqual(DOC_NODE);
    expect(res.stderr).toBe("");
  });

  it("renders a single node as field/value rows under --output table", async () => {
    server.use(http.get(apiUrl("/org/kb/nodes/:nodeId"), () => HttpResponse.json(DOC_NODE)));

    const res = await runCli(["kb", "get", DOC_ID, "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("field");
    expect(res.stdout).toContain("Onboarding.pdf");
    expect(res.stderr).not.toContain("did not return");
  });

  it("offers the poll command for a document and the listing for a folder", async () => {
    server.use(
      http.get(apiUrl("/org/kb/nodes/:nodeId"), () =>
        HttpResponse.json({
          ...DOC_NODE,
          content: { ...DOC_NODE.content, processing_status: "processing" },
        }),
      ),
    );

    const doc = await runCli(["kb", "get", DOC_ID, "--output", "json"]);
    expect(envelope(doc).next).toEqual([
      {
        why: "Poll until content.processing_status is complete",
        command: `senso kb get ${DOC_ID}`,
      },
    ]);

    server.use(http.get(apiUrl("/org/kb/nodes/:nodeId"), () => HttpResponse.json(FOLDER_NODE)));

    const folder = await runCli(["kb", "get", FOLDER_ID, "--output", "json"]);
    expect(envelope(folder).next).toEqual([
      { why: "List what is inside", command: `senso kb children ${FOLDER_ID}` },
    ]);
  });

  it("prints the breadcrumb path on stderr and the rows on stdout", async () => {
    server.use(
      http.get(apiUrl("/org/kb/nodes/:nodeId/ancestors"), () => HttpResponse.json(ANCESTORS)),
    );

    const res = await runCli(["kb", "ancestors", DOC_ID]);

    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain("Path: My Files / Handbook");
    expect(res.stdout).toContain(FOLDER_ID);
    expect(res.stdout).not.toContain("Path:");
  });

  it("says an empty ancestor list means the node sits at the top", async () => {
    server.use(
      http.get(apiUrl("/org/kb/nodes/:nodeId/ancestors"), () =>
        HttpResponse.json({ ancestors: [] }),
      ),
    );

    const res = await runCli(["kb", "ancestors", DOC_ID]);

    expect(res.stdout).toContain("No ancestors found.");
    expect(res.stderr).toContain("directly under the organization root");
  });

  it("warns that a pending move is still propagating to the search index", async () => {
    server.use(http.get(apiUrl("/org/kb/sync-status"), () => HttpResponse.json({ syncing: true })));

    const res = await runCli(["kb", "sync-status", "--output", "json"]);

    expect(res.data()).toEqual({ syncing: true });
    expect(envelope(res).warnings?.[0]).toContain("still propagating");
  });

  it("offers the download command when a document has no stored text", async () => {
    server.use(
      http.get(apiUrl("/org/kb/nodes/:nodeId/content"), () =>
        HttpResponse.json({ ...CONTENT_DETAIL, text: "", content_type: "application/pdf" }),
      ),
    );

    const res = await runCli(["kb", "get-content", DOC_ID, "--output", "json"]);

    expect(envelope(res).next).toEqual([
      {
        why: "This document has no stored text — fetch the file instead",
        command: `senso kb download-url ${DOC_ID}`,
      },
    ]);
  });
});

describe("kb tree edits, on the wire", () => {
  it("POSTs a folder with just a name when no parent is given", async () => {
    let body: unknown;
    let seen: Request | undefined;
    server.use(
      http.post(apiUrl("/org/kb/folders"), async ({ request }) => {
        seen = request.clone();
        body = await request.json();
        return HttpResponse.json({ ...FOLDER_NODE, name: "Legal" });
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
        return HttpResponse.json({ ...FOLDER_NODE, name: "Q3" });
      }),
    );

    await runCli(["kb", "create-folder", "--name", "Q3", "--parent-id", FOLDER_ID]);

    expect(body).toEqual({ name: "Q3", parent_id: FOLDER_ID });
  });

  it("PATCHes the rename sub-resource with the new name", async () => {
    let body: unknown;
    let seen: Request | undefined;
    server.use(
      http.patch(apiUrl("/org/kb/nodes/:nodeId/rename"), async ({ request }) => {
        seen = request.clone();
        body = await request.json();
        return HttpResponse.json({ ...DOC_NODE, name: "Handbook v2.pdf" });
      }),
    );

    await runCli(["kb", "rename", DOC_ID, "--name", "Handbook v2.pdf"]);

    expect(seen?.method).toBe("PATCH");
    expect(urlOf(seen).pathname).toBe(`/api/v1/org/kb/nodes/${DOC_ID}/rename`);
    expect(body).toEqual({ name: "Handbook v2.pdf" });
  });

  it("PATCHes the move sub-resource with new_parent_id, not parent_id", async () => {
    let body: unknown;
    let seen: Request | undefined;
    server.use(
      http.patch(apiUrl("/org/kb/nodes/:nodeId/move"), async ({ request }) => {
        seen = request.clone();
        body = await request.json();
        return HttpResponse.json({ ...DOC_NODE, parent_id: FOLDER_ID });
      }),
    );

    await runCli(["kb", "move", DOC_ID, "--parent-id", FOLDER_ID]);

    expect(urlOf(seen).pathname).toBe(`/api/v1/org/kb/nodes/${DOC_ID}/move`);
    // create-folder says `parent_id` and move says `new_parent_id`. The flag is
    // spelled the same for both, so only this assertion keeps them apart.
    expect(body).toEqual({ new_parent_id: FOLDER_ID });
  });

  it("DELETEs the node with no body", async () => {
    let seen: Request | undefined;
    server.use(
      http.delete(apiUrl("/org/kb/nodes/:nodeId"), ({ request }) => {
        seen = request;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const res = await runCli(["kb", "delete", DOC_ID]);

    expect(res.exitCode).toBe(0);
    expect(seen?.method).toBe("DELETE");
    expect(urlOf(seen).pathname).toBe(`/api/v1/org/kb/nodes/${DOC_ID}`);
    expect(seen?.headers.get("content-type")).toBeNull();
  });

  it("puts the created folder on stdout and the tick on stderr", async () => {
    server.use(
      http.post(apiUrl("/org/kb/folders"), () => HttpResponse.json({ ...FOLDER_NODE, name: "Legal" })),
    );

    const res = await runCli(["kb", "create-folder", "--name", "Legal"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain(FOLDER_ID);
    expect(res.stderr).toContain('Folder "Legal" created.');
    expect(res.stdout).not.toContain("created.");
  });

  it("keeps the rename tick off stdout", async () => {
    server.use(
      http.patch(apiUrl("/org/kb/nodes/:nodeId/rename"), () => HttpResponse.json(DOC_NODE)),
    );

    const res = await runCli(["kb", "rename", DOC_ID, "--name", "New name"]);

    expect(res.stderr).toContain("renamed");
    expect(res.stdout).not.toContain("renamed");
  });

  it("suppresses the tick entirely under --output json", async () => {
    server.use(http.patch(apiUrl("/org/kb/nodes/:nodeId/move"), () => HttpResponse.json(DOC_NODE)));

    const res = await runCli([
      "kb",
      "move",
      DOC_ID,
      "--parent-id",
      FOLDER_ID,
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toEqual(DOC_NODE);
    // json implies quiet, so the progress line is not merely moved — it is gone.
    expect(res.stderr).toBe("");
  });

  it("tells a caller to wait for the index after a move", async () => {
    server.use(http.patch(apiUrl("/org/kb/nodes/:nodeId/move"), () => HttpResponse.json(DOC_NODE)));

    const res = await runCli(["kb", "move", DOC_ID, "--parent-id", FOLDER_ID, "--output", "json"]);

    expect(envelope(res).next).toContainEqual({
      why: "Reindexing is asynchronous — wait for syncing to be false before searching",
      command: "senso kb sync-status",
    });
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
        return HttpResponse.json(RAW_CONTENT, { status: 202 });
      }),
    );

    await runCli([
      "kb",
      "create-raw",
      "--data",
      `{"title":"My doc","text":"# Hello","kb_folder_node_id":"${FOLDER_ID}","tag_ids":["${TAG_ID}"]}`,
    ]);

    expect(seen?.method).toBe("POST");
    expect(urlOf(seen).pathname).toBe("/api/v1/org/kb/raw");
    // Forwarded verbatim: the CLI does not know the schema and must not edit it.
    expect(body).toEqual({
      title: "My doc",
      text: "# Hello",
      kb_folder_node_id: FOLDER_ID,
      tag_ids: [TAG_ID],
    });
  });

  it("warns that tag_ids is accepted and ignored on create", async () => {
    server.use(
      http.post(apiUrl("/org/kb/raw"), () => HttpResponse.json(RAW_CONTENT, { status: 202 })),
    );

    const res = await runCli([
      "kb",
      "create-raw",
      "--data",
      `{"text":"# Hello","tag_ids":["${TAG_ID}"]}`,
      "--output",
      "json",
    ]);

    expect(envelope(res).warnings?.[0]).toContain("accepted and ignored on create");
  });

  it("points the next step at kb_node_id, not at the content id it sits beside", async () => {
    // `id` in this payload is a content_id. Piping it into `senso kb get` is a
    // 404, and the two ids sit side by side in the same object.
    server.use(
      http.post(apiUrl("/org/kb/raw"), () => HttpResponse.json(RAW_CONTENT, { status: 202 })),
    );

    const res = await runCli(["kb", "create-raw", "--data", '{"text":"# Hello"}', "--output", "json"]);

    expect(envelope(res).next).toEqual([
      {
        why: "Poll until content.processing_status is complete",
        command: `senso kb get ${DOC_ID}`,
      },
    ]);
  });

  it("PUTs a full replacement to the node's raw sub-resource", async () => {
    let body: unknown;
    let seen: Request | undefined;
    server.use(
      http.put(apiUrl("/org/kb/nodes/:nodeId/raw"), async ({ request }) => {
        seen = request.clone();
        body = await request.json();
        return HttpResponse.json({ ...RAW_CONTENT, version_num: 2 });
      }),
    );

    await runCli(["kb", "update-raw", DOC_ID, "--data", '{"title":"T","text":"# Updated"}']);

    expect(seen?.method).toBe("PUT");
    expect(urlOf(seen).pathname).toBe(`/api/v1/org/kb/nodes/${DOC_ID}/raw`);
    expect(body).toEqual({ title: "T", text: "# Updated" });
  });

  it("PATCHes a partial update to the same sub-resource", async () => {
    let body: unknown;
    let seen: Request | undefined;
    server.use(
      http.patch(apiUrl("/org/kb/nodes/:nodeId/raw"), async ({ request }) => {
        seen = request.clone();
        body = await request.json();
        return HttpResponse.json({ ...RAW_CONTENT, version_num: 3 });
      }),
    );

    await runCli(["kb", "patch-raw", DOC_ID, "--data", '{"summary":"Shorter"}']);

    // Same path as update-raw, different method: PUT replaces the document and
    // PATCH edits it, so swapping them silently discards the rest of the text.
    expect(seen?.method).toBe("PATCH");
    expect(urlOf(seen).pathname).toBe(`/api/v1/org/kb/nodes/${DOC_ID}/raw`);
    expect(body).toEqual({ summary: "Shorter" });
  });

  it("names the command that replaces a file when the node is not raw", async () => {
    server.use(
      http.put(apiUrl("/org/kb/nodes/:nodeId/raw"), () =>
        HttpResponse.json({ error: "Content is not of type raw" }, { status: 400 }),
      ),
    );

    const res = await runCli(["kb", "update-raw", DOC_ID, "--data", '{"title":"T","text":"x"}']);

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain(`senso kb update-file ${DOC_ID} <file>`);
  });

  it("exits 1 and keeps the machine-readable remainder of a 409 body", async () => {
    server.use(
      http.post(apiUrl("/org/kb/raw"), () =>
        HttpResponse.json(
          { error: "duplicate content", existing_content_id: CONTENT_ID },
          { status: 409 },
        ),
      ),
    );

    const res = await runCli(["kb", "create-raw", "--data", '{"text":"x"}', "--output", "json"]);

    expect(res.exitCode).toBe(1);
    expect(errorEnvelope(res).error).toMatchObject({
      code: "conflict",
      status: 409,
      details: { existing_content_id: CONTENT_ID },
    });
  });
});

describe("kb tags, on the wire", () => {
  it("GETs the node's tags for a list", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/kb/nodes/:nodeId/tags"), ({ request }) => {
        seen = request;
        return HttpResponse.json([TAG]);
      }),
    );

    await runCli(["kb", "tags", "list", DOC_ID]);

    expect(seen?.method).toBe("GET");
    expect(urlOf(seen).pathname).toBe(`/api/v1/org/kb/nodes/${DOC_ID}/tags`);
  });

  it("renders the tag id under the column the API actually returns", async () => {
    // The endpoint answers with a bare array of dto.TagResponse, whose id field
    // is `id`. The CLI asked for `tag_id`, so every row printed a blank first
    // column and the command looked finished.
    server.use(http.get(apiUrl("/org/kb/nodes/:nodeId/tags"), () => HttpResponse.json([TAG])));

    const res = await runCli(["kb", "tags", "list", DOC_ID, "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain(TAG_ID);
    expect(res.stdout).toContain("handbook");
    expect(res.stderr).not.toContain("did not return");
  });

  it("says why a document has no tags yet", async () => {
    server.use(http.get(apiUrl("/org/kb/nodes/:nodeId/tags"), () => HttpResponse.json([])));

    const res = await runCli(["kb", "tags", "list", DOC_ID]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("No tags found.");
    expect(res.stderr).toContain("Auto-tagging runs after ingestion");
  });

  it("splits --names and --ids into tag_names and tag_ids on a PUT", async () => {
    let body: unknown;
    let seen: Request | undefined;
    server.use(
      http.put(apiUrl("/org/kb/nodes/:nodeId/tags"), async ({ request }) => {
        seen = request.clone();
        body = await request.json();
        return HttpResponse.json([TAG]);
      }),
    );

    await runCli([
      "kb",
      "tags",
      "set",
      DOC_ID,
      "--names",
      "handbook, hr ,",
      "--ids",
      OTHER_TAG_ID,
    ]);

    expect(seen?.method).toBe("PUT");
    // Whitespace trimmed and empty segments dropped, so a trailing comma in a
    // shell-quoted list does not become an empty tag name.
    expect(body).toEqual({ tag_names: ["handbook", "hr"], tag_ids: [OTHER_TAG_ID] });
  });

  it("PUTs an empty object only when --clear says so", async () => {
    let body: unknown;
    server.use(
      http.put(apiUrl("/org/kb/nodes/:nodeId/tags"), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json([]);
      }),
    );

    const res = await runCli(["kb", "tags", "set", DOC_ID, "--clear"]);

    expect(res.exitCode).toBe(0);
    expect(body).toEqual({});
    expect(res.stdout).toContain("No tags found.");
    expect(res.stderr).toContain("tags cleared");
  });

  it("attaches by name as tag_name, and reports the tag the API created", async () => {
    let body: unknown;
    let seen: Request | undefined;
    server.use(
      http.post(apiUrl("/org/kb/nodes/:nodeId/tags"), async ({ request }) => {
        seen = request.clone();
        body = await request.json();
        return HttpResponse.json(TAG, { status: 201 });
      }),
    );

    const res = await runCli(["kb", "tags", "add", DOC_ID, "--name", "handbook", "--output", "json"]);

    expect(seen?.method).toBe("POST");
    expect(body).toEqual({ tag_name: "handbook" });
    // The only place a newly minted tag's id is reported.
    expect(res.data()).toEqual(TAG);
  });

  it("attaches by id as tag_id, and confirms a 204 with an object rather than a sentence", async () => {
    let body: unknown;
    server.use(
      http.post(apiUrl("/org/kb/nodes/:nodeId/tags"), async ({ request }) => {
        body = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const res = await runCli(["kb", "tags", "add", DOC_ID, "--id", TAG_ID, "--output", "json"]);

    expect(body).toEqual({ tag_id: TAG_ID });
    expect(res.data()).toEqual({
      action: "tag_attached",
      resource: "kb_node_tag",
      id: DOC_ID,
      kb_node_id: DOC_ID,
      tag_id: TAG_ID,
    });
  });

  it("detaches by id through the sub-resource path", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/kb/nodes/:nodeId/tags"), () => HttpResponse.json([TAG])),
      http.delete(apiUrl("/org/kb/nodes/:nodeId/tags/:tagId"), ({ request }) => {
        seen = request;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const res = await runCli(["kb", "tags", "remove", DOC_ID, "--id", TAG_ID]);

    expect(res.exitCode).toBe(0);
    expect(urlOf(seen).pathname).toBe(`/api/v1/org/kb/nodes/${DOC_ID}/tags/${TAG_ID}`);
  });

  it("detaches by name through a query parameter on the collection", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/kb/nodes/:nodeId/tags"), () => HttpResponse.json([TAG])),
      http.delete(apiUrl("/org/kb/nodes/:nodeId/tags"), ({ request }) => {
        seen = request;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const res = await runCli(["kb", "tags", "remove", DOC_ID, "--name", "handbook"]);

    expect(res.exitCode).toBe(0);
    // Two different requests behind one command: swapping them detaches the
    // wrong tag, and neither call fails loudly.
    expect(urlOf(seen).pathname).toBe(`/api/v1/org/kb/nodes/${DOC_ID}/tags`);
    expect(urlOf(seen).searchParams.get("name")).toBe("handbook");
  });

  it("reports changed: false when the node never had the tag", async () => {
    // Removing a tag the node has and removing one it does not are the same 204
    // with the same message, which made a typo in --name indistinguishable from
    // a successful detach.
    server.use(
      http.get(apiUrl("/org/kb/nodes/:nodeId/tags"), () => HttpResponse.json([TAG])),
      http.delete(
        apiUrl("/org/kb/nodes/:nodeId/tags"),
        () => new HttpResponse(null, { status: 204 }),
      ),
    );

    const res = await runCli(["kb", "tags", "remove", DOC_ID, "--name", "legal", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toMatchObject({ action: "tag_detached", changed: false, tag_name: "legal" });
  });

  it("reports changed: true when it really came off", async () => {
    server.use(
      http.get(apiUrl("/org/kb/nodes/:nodeId/tags"), () => HttpResponse.json([TAG])),
      http.delete(
        apiUrl("/org/kb/nodes/:nodeId/tags/:tagId"),
        () => new HttpResponse(null, { status: 204 }),
      ),
    );

    const res = await runCli(["kb", "tags", "remove", DOC_ID, "--id", TAG_ID, "--output", "json"]);

    expect(res.data()).toMatchObject({ changed: true, tag_id: TAG_ID });
  });
});

describe("kb upload, the two-step transaction", () => {
  it("POSTs the name, size, type and md5 of the file actually on disk", async () => {
    const contents = "# Handbook\n\nWelcome aboard.\n";
    const { prepBodies } = serveUpload([accepted("handbook.txt")]);

    const res = await runCli([
      "kb",
      "upload",
      tempFile("handbook.txt", contents),
      "--folder-id",
      FOLDER_ID,
    ]);

    expect(res.exitCode).toBe(0);
    expect(prepBodies[0]).toEqual({
      files: [
        {
          filename: "handbook.txt",
          file_size_bytes: Buffer.byteLength(contents),
          content_type: "text/plain",
          // Over the same bytes that are PUT below: if these disagree, S3
          // rejects the object and the file never finishes processing.
          content_hash_md5: md5(contents),
        },
      ],
      kb_folder_node_id: FOLDER_ID,
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
    const { puts } = serveUpload([
      accepted("b.txt", { url: second, nodeId: OTHER_DOC_ID }),
      accepted("a.txt"),
    ]);

    await runCli(["kb", "upload", tempFile("a.txt", "alpha"), tempFile("b.txt", "bravo")]);

    expect(puts.map((p) => [p.request.url, p.body.toString("utf-8")])).toEqual([
      [second, "bravo"],
      [S3_URL, "alpha"],
    ]);
  });

  it("prints each file's kb_node_id in plain mode, which is the id its help says to poll", async () => {
    // The payload's own fields were previously printed nowhere at all in plain
    // mode, so an agent told to "poll the kb_node_id" had nothing to poll.
    serveUpload([accepted("a.txt")]);

    const res = await runCli(["kb", "upload", tempFile("a.txt", "alpha")]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("kb_node_id");
    expect(res.stdout).toContain(DOC_ID);
    expect(res.stdout).toContain("a.txt");
    // The consumed presigned URL is not echoed alongside it.
    expect(res.stdout).not.toContain("X-Amz-Signature");
  });

  it("says nothing on stderr under --output json, and carries the poll command in the envelope", async () => {
    serveUpload([accepted("a.txt")]);

    const res = await runCli(["kb", "upload", tempFile("a.txt", "alpha"), "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toMatchObject({ results: [{ filename: "a.txt", kb_node_id: DOC_ID }] });
    expect(res.stderr).toBe("");
    expect(envelope(res).next).toEqual([
      {
        why: "Poll until content.processing_status is complete",
        command: `senso kb get ${DOC_ID}`,
      },
    ]);
  });

  it("summarizes a response with no results array rather than throwing on it", async () => {
    server.use(
      http.post(apiUrl("/org/kb/upload"), () =>
        HttpResponse.json({ summary: { total: 0, success: 0, skipped: 0 } }),
      ),
    );

    const res = await runCli(["kb", "upload", tempFile("a.txt", "alpha")]);

    // apiRequest casts the body, it does not validate it. A malformed response
    // must summarize nothing, not throw "not iterable".
    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain("0/0 file(s) uploaded");
  });
});

describe("kb upload, when a file is not accepted", () => {
  it("exits 2 before hashing anything when a file is markdown", async () => {
    // The ingestion service rejects markdown by filename and answers with an
    // error naming an HTTP endpoint rather than a command — and "add these
    // notes to the KB" is exactly what an agent reaches for this command with.
    const res = await runCli(["kb", "upload", tempFile("notes.md", "# Notes")]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Markdown is not accepted here");
    expect(res.stderr).toContain("senso kb create-raw");
  });

  it("exits 2 for a type the API is certain to refuse, without a round trip", async () => {
    const res = await runCli(["kb", "upload", tempFile("data.json", "{}")]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("Unsupported file type");
    expect(res.stderr).toContain("application/json");
  });

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

  it("carries the skipped file as a warning in the envelope", async () => {
    serveUpload([accepted("new.txt"), rejected("dupe.txt", "duplicate")]);

    const res = await runCli([
      "kb",
      "upload",
      tempFile("new.txt", "fresh"),
      tempFile("dupe.txt", "again"),
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(0);
    expect(envelope(res).warnings).toEqual([
      "dupe.txt was not stored — This file has already been uploaded.",
    ]);
  });

  it("prefers the API's own message for an invalid file over the generic one", async () => {
    // The only file in the batch was rejected, so nothing was stored and the
    // command exits 1 — but the API's specific reason must still reach stderr
    // instead of uploadStatusToReason's generic "This file type is not
    // supported."
    serveUpload([rejected("big.pdf", "invalid", "File exceeds the 100MB limit.")]);

    const res = await runCli(["kb", "upload", tempFile("big.pdf", "%PDF-1.4")]);

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("File exceeds the 100MB limit.");
    expect(res.stderr).not.toContain("This file type is not supported.");
    expect(res.stderr).toContain("No files were uploaded");
  });

  it("unpacks the per-file reasons when the API rejects the whole batch", async () => {
    server.use(
      http.post(apiUrl("/org/kb/upload"), () =>
        HttpResponse.json(
          uploadResponse([
            rejected("a.txt", "duplicate"),
            rejected("b.pdf", "invalid", "Password-protected documents are not supported."),
          ]),
          { status: 409 },
        ),
      ),
    );

    const res = await runCli(["kb", "upload", tempFile("a.txt", "hi"), tempFile("b.pdf", "%PDF")]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("already been uploaded");
    expect(res.stderr).toContain("Password-protected documents are not supported.");
  });

  it("reports a result that matches no local file instead of uploading nothing quietly", async () => {
    const { puts } = serveUpload([accepted("a.txt"), accepted("ghost.txt")]);

    const res = await runCli(["kb", "upload", tempFile("a.txt", "alpha")]);

    expect(puts).toHaveLength(1);
    expect(res.stderr).toContain("ghost.txt");
    expect(res.stderr).toContain("Could not match to a local file");
  });
});

describe("kb upload, when S3 refuses the bytes", () => {
  it("reports the failing file instead of counting it as uploaded", async () => {
    const { puts } = serveUpload([accepted("a.txt"), accepted("b.txt")], { s3Status: 403 });

    const res = await runCli(["kb", "upload", tempFile("a.txt", "alpha"), tempFile("b.txt", "bravo")]);

    expect(puts).toHaveLength(2);
    // The regression this guards: the PUT was once fire-and-forget, so a
    // rejected object was summarized as a success and the user waited forever
    // for a document that was never stored.
    expect(res.stderr).toContain("a.txt");
    expect(res.stderr).toContain("S3 upload failed: 403");
  });

  it("keeps uploading the remaining files after one of them fails", async () => {
    const failing = "https://s3.test.invalid/senso-uploads/broken";
    const puts: string[] = [];
    server.use(
      http.post(apiUrl("/org/kb/upload"), () =>
        HttpResponse.json(
          uploadResponse([accepted("a.txt", { url: failing }), accepted("b.txt")]),
        ),
      ),
      http.put(failing, () => new HttpResponse(null, { status: 500 })),
      http.put(S3_PATH, async ({ request }) => {
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
    const files = Array.from({ length: 11 }, (_, i) => tempFile(`f${String(i)}.txt`, "x"));

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

  it("exits 4 naming the destination folder when it does not exist", async () => {
    server.use(http.post(apiUrl("/org/kb/upload"), () => new HttpResponse(null, { status: 404 })));

    const res = await runCli([
      "kb",
      "upload",
      tempFile("a.txt", "alpha"),
      "--folder-id",
      MISSING_ID,
    ]);

    expect(res.exitCode).toBe(4);
    expect(res.stderr).toContain(`Folder ${MISSING_ID} not found`);
  });

  it("exits 3 when there is no API key at all", async () => {
    const res = await runCli(["kb", "upload", tempFile("a.txt", "alpha")], { withKey: false });

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("no API key found");
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
      http.put(S3_PATH, async ({ request }) => {
        puts.push(Buffer.from(await request.arrayBuffer()).toString("utf-8"));
        return new HttpResponse(null, { status: 200 });
      }),
    );

    const res = await runCli(["kb", "update-file", DOC_ID, tempFile("doc.txt", contents)]);

    expect(res.exitCode).toBe(0);
    expect(urlOf(seen).pathname).toBe(`/api/v1/org/kb/nodes/${DOC_ID}/file`);
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
    expect(res.stderr).toContain("Re-processing started");
  });

  it("drops the consumed presigned URL from the payload", async () => {
    server.use(
      http.put(apiUrl("/org/kb/nodes/:nodeId/file"), () => HttpResponse.json(accepted("doc.txt"))),
      http.put(S3_PATH, () => new HttpResponse(null, { status: 200 })),
    );

    const res = await runCli([
      "kb",
      "update-file",
      DOC_ID,
      tempFile("doc.txt", "v2"),
      "--output",
      "json",
    ]);

    // It has already been used, and a credential-bearing URL in an agent's log
    // is worth nothing and costs something.
    expect(res.data()).not.toHaveProperty("upload_url");
    expect(res.data()).toMatchObject({ kb_node_id: DOC_ID, status: "upload_pending" });
  });

  it("exits 1 and skips the S3 PUT when the API declines the new version", async () => {
    server.use(
      http.put(apiUrl("/org/kb/nodes/:nodeId/file"), () =>
        HttpResponse.json(rejected("doc.txt", "duplicate", "Same content as the current version.")),
      ),
    );

    // No S3 handler: a PUT here would be an unmocked request and fail the test,
    // which is the assertion — nothing is uploaded for a declined version.
    const res = await runCli(["kb", "update-file", DOC_ID, tempFile("doc.txt", "v2")]);

    // Nothing was stored, so reporting this as a warning and exiting 0 told a
    // script the new version had been accepted.
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("was not accepted (duplicate)");
    expect(res.stderr).toContain("Same content as the current version.");
  });

  it("exits 2 for a markdown replacement, before any request", async () => {
    const res = await runCli(["kb", "update-file", DOC_ID, tempFile("notes.md", "# Notes")]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("Markdown is not accepted here");
  });
});

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
    expect(res.stdout).toContain("total_files");
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

    await runCli(["kb", "bulk-delete", DOC_ID, OTHER_DOC_ID, FOLDER_ID]);

    expect(body).toEqual({ node_ids: [DOC_ID, OTHER_DOC_ID, FOLDER_ID] });
  });

  it("drops a repeated id and says so, so the reported count is the count deleted", async () => {
    let body: unknown;
    server.use(
      http.post(apiUrl("/org/kb/nodes/bulk-delete"), async ({ request }) => {
        body = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const res = await runCli(["kb", "bulk-delete", DOC_ID, DOC_ID, "--output", "json"]);

    expect(body).toEqual({ node_ids: [DOC_ID] });
    expect(res.data()).toEqual({ action: "deleted", resource: "kb_node", id: [DOC_ID] });
    expect(envelope(res).warnings).toEqual(["1 duplicate id(s) were dropped before the request."]);
  });

  it("confirms the delete on stderr and gives a JSON caller an object", async () => {
    server.use(
      http.post(apiUrl("/org/kb/nodes/bulk-delete"), () => new HttpResponse(null, { status: 204 })),
    );

    const plain = await runCli(["kb", "bulk-delete", DOC_ID, OTHER_DOC_ID]);
    expect(plain.stdout).toBe("");
    expect(plain.stderr).toContain("Deleted 2 node(s).");
  });
});

describe("kb delete and tags remove, confirming without a payload", () => {
  it("names what was deleted rather than handing back a sentence to parse", async () => {
    server.use(
      http.delete(apiUrl("/org/kb/nodes/:nodeId"), () => new HttpResponse(null, { status: 204 })),
    );

    const res = await runCli(["kb", "delete", DOC_ID, "--output", "json"]);

    expect(res.exitCode).toBe(0);
    // A 204 has no payload, so the command reports what changed rather than a
    // success sentence a caller would have to parse the id out of.
    expect(res.data()).toEqual({ action: "deleted", resource: "kb_node", id: DOC_ID });
    expect(res.stderr).toBe("");
  });

  it("puts the tick on stderr and leaves stdout empty in plain mode", async () => {
    server.use(
      http.delete(apiUrl("/org/kb/nodes/:nodeId"), () => new HttpResponse(null, { status: 204 })),
    );

    const res = await runCli(["kb", "delete", DOC_ID]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain(`Node ${DOC_ID} deleted.`);
  });

  it("names the poll command when a delete is refused mid-ingestion", async () => {
    server.use(
      http.delete(apiUrl("/org/kb/nodes/:nodeId"), () =>
        HttpResponse.json({ error: "document is still ingesting" }, { status: 409 }),
      ),
    );

    const res = await runCli(["kb", "delete", DOC_ID]);

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain(`senso kb get ${DOC_ID}`);
  });

  it("stays quiet on stdout when a tag is attached by id", async () => {
    server.use(
      http.post(
        apiUrl("/org/kb/nodes/:nodeId/tags"),
        () => new HttpResponse(null, { status: 204 }),
      ),
    );

    const res = await runCli(["kb", "tags", "add", DOC_ID, "--id", TAG_ID]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain(`Tag attached to KB node ${DOC_ID}.`);
  });
});

describe("kb permissions, on the wire", () => {
  it("lists the grants on a node", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(apiUrl("/org/kb/nodes/:id/permissions"), ({ request }) => {
        seen = request;
        return HttpResponse.json(GRANTS);
      }),
    );

    await runCli(["kb", "permissions", "list", DOC_ID]);

    expect(urlOf(seen).pathname).toBe(`/api/v1/org/kb/nodes/${DOC_ID}/permissions`);
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
      DOC_ID,
      "--grantee-type",
      "group",
      "--grantee-id",
      GROUP_ID,
      "--role",
      "editor",
    ]);

    expect(body).toEqual({ grantee_type: "group", grantee_id: GROUP_ID, role: "editor" });
  });

  it("patches only the role, at the permission's own route", async () => {
    let seen: Request | undefined;
    let body: unknown;
    server.use(
      http.patch(apiUrl("/org/kb/nodes/:id/permissions/:permissionId"), async ({ request }) => {
        seen = request.clone();
        body = await request.json();
        return HttpResponse.json({ message: "Permission updated" });
      }),
    );

    await runCli(["kb", "permissions", "update", DOC_ID, GRANT_ID, "--role", "viewer"]);

    expect(seen?.method).toBe("PATCH");
    expect(urlOf(seen).pathname).toBe(`/api/v1/org/kb/nodes/${DOC_ID}/permissions/${GRANT_ID}`);
    expect(body).toEqual({ role: "viewer" });
  });

  it("revokes a grant with a DELETE to the permission's route", async () => {
    let seen: Request | undefined;
    server.use(
      http.delete(apiUrl("/org/kb/nodes/:id/permissions/:permissionId"), ({ request }) => {
        seen = request;
        return HttpResponse.json({ message: "Permission revoked" });
      }),
    );

    await runCli(["kb", "permissions", "remove", DOC_ID, GRANT_ID]);

    expect(urlOf(seen).pathname).toBe(`/api/v1/org/kb/nodes/${DOC_ID}/permissions/${GRANT_ID}`);
  });
});

describe("kb permissions, what it renders", () => {
  it("prints the grants unmodified under --output json", async () => {
    server.use(http.get(apiUrl("/org/kb/nodes/:id/permissions"), () => HttpResponse.json(GRANTS)));

    const res = await runCli(["kb", "permissions", "list", DOC_ID, "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toEqual(GRANTS);
    expect(res.stderr).toBe("");
  });

  it("flattens the grantee into its own columns under --output table", async () => {
    // `grantee` is the payload's point and a nested object, so an unflattened
    // cell renders it as truncated JSON.
    server.use(http.get(apiUrl("/org/kb/nodes/:id/permissions"), () => HttpResponse.json(GRANTS)));

    const res = await runCli(["kb", "permissions", "list", DOC_ID, "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("grantee_email");
    expect(res.stdout).toContain("ada@example.com");
    expect(res.stdout).toContain("viewer");
    expect(res.stderr).not.toContain("did not return");
  });

  it("says an empty grant list may still mean inherited access", async () => {
    server.use(
      http.get(apiUrl("/org/kb/nodes/:id/permissions"), () => HttpResponse.json({ grants: [] })),
    );

    const res = await runCli(["kb", "permissions", "list", DOC_ID]);

    expect(res.stdout).toContain("No grants found.");
    expect(res.stderr).toContain(`senso kb ancestors ${DOC_ID}`);
  });

  it("keeps the tick off stdout when a grant is created, and offers the permission id back", async () => {
    server.use(
      http.post(apiUrl("/org/kb/nodes/:id/permissions"), () =>
        HttpResponse.json(GRANTS.grants[0], { status: 201 }),
      ),
    );

    const res = await runCli([
      "kb",
      "permissions",
      "add",
      DOC_ID,
      "--grantee-type",
      "user",
      "--grantee-id",
      USER_ID,
      "--role",
      "viewer",
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain(`Granted viewer on node ${DOC_ID}.`);
    expect(res.stdout).not.toContain("Granted viewer");
    expect(res.stderr).toContain(`senso kb permissions remove ${DOC_ID} ${GRANT_ID}`);
  });

  it("reports what a role change actually changed, not the API's bare message", async () => {
    server.use(
      http.patch(apiUrl("/org/kb/nodes/:id/permissions/:permissionId"), () =>
        HttpResponse.json({ message: "Permission updated" }),
      ),
    );

    const res = await runCli([
      "kb",
      "permissions",
      "update",
      DOC_ID,
      GRANT_ID,
      "--role",
      "editor",
      "--output",
      "json",
    ]);

    expect(res.data()).toEqual({
      action: "role_changed",
      resource: "kb_permission",
      id: GRANT_ID,
      node_id: DOC_ID,
      role: "editor",
    });
  });

  it("warns that a revoke leaves inherited access in place", async () => {
    server.use(
      http.delete(apiUrl("/org/kb/nodes/:id/permissions/:permissionId"), () =>
        HttpResponse.json({ message: "Permission revoked" }),
      ),
    );

    const res = await runCli(["kb", "permissions", "remove", DOC_ID, GRANT_ID]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Inherited access survives a revoke");
  });
});
