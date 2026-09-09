/**
 * Command layer: `senso ingest`.
 *
 * This is the only multi-request transaction in the CLI, and it is the reason
 * this file is long. Uploading a file is three steps that have to agree with
 * each other:
 *
 *   1. POST the file's metadata — name, size, content type, md5 — to
 *      /org/kb/upload;
 *   2. the API answers with one result per file, carrying a presigned S3 URL for
 *      each file it accepted and a status for each file it did not;
 *   3. PUT the bytes to that URL, per file.
 *
 * What is worth protecting is every place those three can silently disagree.
 * The metadata is asserted against the file on disk — a hash computed over the
 * wrong buffer, or a size read from the wrong stat, produces a request the API
 * accepts and an object S3 then rejects. A per-file `conflict`/`duplicate`/
 * `invalid` must be reported with its reason without aborting the files beside
 * it. And a failed S3 PUT must appear in the summary: silently counting it as
 * uploaded is a bug this command has actually had, and it leaves a user waiting
 * on a document that will never finish processing.
 *
 * The prompts are mocked. `spinner()` from @clack/prompts writes frames and
 * cursor escapes to stdout even when stdout is a pipe; src/lib/progress.ts is
 * what keeps those bytes away from the payload, by degrading to a stderr line
 * whenever stdout is not a terminal.
 *
 * Failure branches come first, as in tests/commands/roles.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { server } from "../setup.js";
import { apiUrl, runCli } from "../helpers.js";

/** The scripted terminal. See tests/unit/folder-picker.test.ts for the shape. */
const clack = vi.hoisted(() => ({
  CANCEL: Symbol("clack:cancel"),
  selectAnswers: [] as unknown[],
  textAnswers: [] as unknown[],
  textCalls: [] as { message: string; validate?: (v: string | undefined) => string | undefined }[],
  canceled: [] as string[],
}));

vi.mock("@clack/prompts", () => ({
  spinner: () => ({
    start: () => undefined,
    stop: () => undefined,
    message: () => undefined,
  }),
  select: (opts: { message: string; options: { value: string }[] }) => {
    if (clack.selectAnswers.length === 0) {
      throw new Error(`select() was called more times than the test scripted: ${opts.message}`);
    }
    return Promise.resolve(clack.selectAnswers.shift());
  },
  text: (opts: { message: string; validate?: (v: string | undefined) => string | undefined }) => {
    clack.textCalls.push({ message: opts.message, validate: opts.validate });
    if (clack.textAnswers.length === 0) {
      throw new Error(`text() was called more times than the test scripted: ${opts.message}`);
    }
    return Promise.resolve(clack.textAnswers.shift());
  },
  isCancel: (v: unknown) => v === clack.CANCEL,
  cancel: (msg: string) => clack.canceled.push(msg),
}));

/** Where the presigned URL points. Nothing listens on it; MSW answers. */
const S3_URL = "https://s3.test.invalid/senso-uploads/abc123?X-Amz-Signature=deadbeef";

let workDir: string;
/** Set to false for every test: a TTY would open the interactive folder picker. */
let realIsTTY: boolean | undefined;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "senso-ingest-"));
  clack.selectAnswers = [];
  clack.textAnswers = [];
  clack.textCalls = [];
  clack.canceled = [];
  realIsTTY = process.stdin.isTTY;
  process.stdin.isTTY = false;
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  process.stdin.isTTY = realIsTTY!;
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

/** One entry of the API's per-file `results` array. */
function accepted(filename: string, url = S3_URL) {
  return {
    filename,
    status: "upload_pending",
    upload_url: url,
    content_id: `c-${filename}`,
    ingestion_run_id: `run-${filename}`,
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

/**
 * Serves the metadata POST and the S3 PUT, recording both.
 *
 * Everything in this file is an assertion about one of those two requests, so
 * they are captured together: it is the relationship between them — the same
 * file, the same bytes, the URL the first one handed out — that matters.
 */
function serveUpload(
  results: Record<string, unknown>[],
  opts: { s3Status?: number } = {},
): { prep: Request[]; prepBodies: unknown[]; puts: { request: Request; body: Buffer }[] } {
  const prep: Request[] = [];
  const prepBodies: unknown[] = [];
  const puts: { request: Request; body: Buffer }[] = [];

  server.use(
    http.post(apiUrl("/org/kb/upload"), async ({ request }) => {
      prep.push(request.clone());
      prepBodies.push(await request.json());
      return HttpResponse.json(uploadResponse(results));
    }),
    http.put("https://s3.test.invalid/*", async ({ request }) => {
      const clone = request.clone();
      puts.push({ request: clone, body: Buffer.from(await request.arrayBuffer()) });
      if (opts.s3Status && opts.s3Status >= 400) {
        return new HttpResponse(null, { status: opts.s3Status, statusText: "Forbidden" });
      }
      return new HttpResponse(null, { status: 200 });
    }),
  );

  return { prep, prepBodies, puts };
}

describe("ingest upload, when the command line is wrong", () => {
  it("exits 2 before reading anything when more than 10 files are passed", async () => {
    const files = Array.from({ length: 11 }, (_, i) => tempFile(`f${i}.txt`, "x"));

    const res = await runCli(["ingest", "upload", ...files, "--folder-id", "f-1"]);

    // No handler is registered: the limit is checked before any request, and an
    // unmocked request would fail this test rather than pass it quietly.
    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Maximum 10 files");
    expect(res.stderr).toContain("batches of 10");
  });

  it("exits 2 naming the file that does not exist", async () => {
    const real = tempFile("present.txt", "hello");

    const res = await runCli([
      "ingest",
      "upload",
      real,
      join(workDir, "absent.txt"),
      "--folder-id",
      "f-1",
    ]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("File not found");
    expect(res.stderr).toContain("absent.txt");
  });

  it("exits 2 and names every empty file rather than uploading a zero-byte object", async () => {
    const res = await runCli([
      "ingest",
      "upload",
      tempFile("empty.txt", ""),
      tempFile("also-empty.md", ""),
      "--folder-id",
      "f-1",
    ]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Empty file(s)");
    // Both in one message: the whole failure is one thrown error, so listing
    // them here is the only place the user sees the second name.
    expect(res.stderr).toContain("empty.txt");
    expect(res.stderr).toContain("also-empty.md");
  });

  it("names the valid formats when --output is not one of them", async () => {
    const res = await runCli([
      "ingest",
      "upload",
      tempFile("a.txt", "hi"),
      "--folder-id",
      "f-1",
      "--output",
      "yaml",
    ]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("json, table, plain");
  });
});

describe("ingest upload, when the request fails", () => {
  it("exits 3 and explains how to authenticate when there is no API key", async () => {
    const res = await runCli(["ingest", "upload", tempFile("a.txt", "hi"), "--folder-id", "f-1"], {
      withKey: false,
    });

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("no API key found");
    expect(res.stderr).toContain("SENSO_API_KEY");
  });

  it("exits 3 when the API rejects the key", async () => {
    server.use(
      http.post(apiUrl("/org/kb/upload"), () =>
        HttpResponse.json({ error: "invalid key" }, { status: 401 }),
      ),
    );

    const res = await runCli(["ingest", "upload", tempFile("a.txt", "hi"), "--folder-id", "f-1"]);

    // The exit code survives the upload's own error handling: a rejected key is
    // 3, not the flat 1 that every upload failure used to produce.
    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Authentication failed");
  });

  it("exits 3 when the key lacks the scope for the destination folder", async () => {
    server.use(
      http.post(apiUrl("/org/kb/upload"), () =>
        HttpResponse.json({ error: "read-only key" }, { status: 403 }),
      ),
    );

    const res = await runCli(["ingest", "upload", tempFile("a.txt", "hi"), "--folder-id", "f-1"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Permission denied");
  });

  it("exits 4 when the destination folder does not exist", async () => {
    server.use(http.post(apiUrl("/org/kb/upload"), () => new HttpResponse(null, { status: 404 })));

    const res = await runCli([
      "ingest",
      "upload",
      tempFile("a.txt", "hi"),
      "--folder-id",
      "f-gone",
    ]);

    expect(res.exitCode).toBe(4);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Not found");
  });

  it("exits 1 on a 500 and says it is not the caller's fault", async () => {
    server.use(http.post(apiUrl("/org/kb/upload"), () => new HttpResponse(null, { status: 503 })));

    const res = await runCli(["ingest", "upload", tempFile("a.txt", "hi"), "--folder-id", "f-1"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("not your fault");
  });

  it("exits 5 when the API rate-limits, because retrying is the right response", async () => {
    server.use(http.post(apiUrl("/org/kb/upload"), () => new HttpResponse(null, { status: 429 })));

    const res = await runCli(["ingest", "upload", tempFile("a.txt", "hi"), "--folder-id", "f-1"]);

    expect(res.exitCode).toBe(5);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Rate limited");
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

    const res = await runCli([
      "ingest",
      "upload",
      tempFile("a.txt", "hi"),
      tempFile("b.exe", "MZ"),
      "--folder-id",
      "f-1",
    ]);

    // A 409 carrying `results` is the batch-rejection shape, and it is the only
    // failure body with detail worth unpacking: the caller gets a line per file
    // rather than "Conflict".
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("already been uploaded");
    expect(res.stderr).toContain("Executables are not supported.");
    expect(res.stderr).toContain("No files were uploaded");
  });

  it("writes the failure to stderr as JSON, leaving stdout empty, under --output json", async () => {
    server.use(
      http.post(apiUrl("/org/kb/upload"), () =>
        HttpResponse.json({ error: "nope" }, { status: 403 }),
      ),
    );

    const res = await runCli([
      "ingest",
      "upload",
      tempFile("a.txt", "hi"),
      "--folder-id",
      "f-1",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(3);
    // A caller redirecting stdout to a file gets an empty file, not a file
    // holding an error object it would later read as data.
    expect(res.stdout).toBe("");
    expect(JSON.parse(res.stderr)).toMatchObject({ error: { code: "forbidden", status: 403 } });
  });
});

describe("ingest upload, the metadata it sends", () => {
  it("POSTs the name, size, type and md5 of the file actually on disk", async () => {
    const contents = "# Notes\n\nThe quick brown fox.\n";
    const path = tempFile("notes.md", contents);
    const { prep, prepBodies } = serveUpload([accepted("notes.md")]);

    const res = await runCli(["ingest", "upload", path, "--folder-id", "f-docs"]);

    expect(res.exitCode).toBe(0);
    expect(prep[0]?.method).toBe("POST");
    expect(new URL(prep[0]!.url).pathname).toBe("/api/v1/org/kb/upload");
    expect(prepBodies[0]).toEqual({
      files: [
        {
          // The basename, not the path the user typed: the server has no use
          // for the caller's directory layout.
          filename: "notes.md",
          file_size_bytes: Buffer.byteLength(contents),
          content_type: "text/markdown",
          // Computed over the same bytes that are PUT below. If these two ever
          // disagree, S3 rejects the object and the file never processes.
          content_hash_md5: md5(contents),
        },
      ],
      kb_folder_node_id: "f-docs",
    });
  });

  it("sends one metadata entry per file, in the order given", async () => {
    const { prepBodies } = serveUpload([accepted("a.txt"), accepted("b.pdf")]);

    await runCli([
      "ingest",
      "upload",
      tempFile("a.txt", "alpha"),
      tempFile("b.pdf", "%PDF-1.4"),
      "--folder-id",
      "f-1",
    ]);

    expect(prepBodies[0]).toMatchObject({
      files: [
        { filename: "a.txt", content_type: "text/plain", content_hash_md5: md5("alpha") },
        { filename: "b.pdf", content_type: "application/pdf", content_hash_md5: md5("%PDF-1.4") },
      ],
    });
  });

  it("falls back to application/octet-stream for an extension it does not know", async () => {
    const { prepBodies } = serveUpload([accepted("archive.zzz")]);

    await runCli(["ingest", "upload", tempFile("archive.zzz", "data"), "--folder-id", "f-1"]);

    expect(prepBodies[0]).toMatchObject({
      files: [{ content_type: "application/octet-stream" }],
    });
  });

  it("omits kb_folder_node_id entirely when no folder was chosen", async () => {
    const { prepBodies } = serveUpload([accepted("a.txt")]);

    await runCli(["ingest", "upload", tempFile("a.txt", "hi")]);

    // Absent rather than null or empty: the API reads a missing key as "the
    // org's root folder", and an empty string is a lookup that fails.
    expect(prepBodies[0]).not.toHaveProperty("kb_folder_node_id");
  });
});

describe("ingest upload, the second request", () => {
  it("PUTs the file's bytes to the presigned URL the API handed back", async () => {
    const contents = "the quick brown fox";
    const { puts } = serveUpload([accepted("fox.txt")]);

    const res = await runCli([
      "ingest",
      "upload",
      tempFile("fox.txt", contents),
      "--folder-id",
      "f-1",
    ]);

    expect(res.exitCode).toBe(0);
    expect(puts).toHaveLength(1);
    expect(puts[0]!.request.method).toBe("PUT");
    // The exact URL, signature included: a presigned URL that has been rebuilt
    // or re-encoded no longer verifies.
    expect(puts[0]!.request.url).toBe(S3_URL);
    expect(puts[0]!.request.headers.get("content-type")).toBe("text/plain");
    // The bytes hashed in step one are the bytes sent in step three.
    expect(puts[0]!.body.toString("utf-8")).toBe(contents);
    expect(md5(puts[0]!.body.toString("utf-8"))).toBe(md5(contents));
  });

  it("sends each file to its own URL, matching results to files by name", async () => {
    const second = "https://s3.test.invalid/senso-uploads/second?X-Amz-Signature=cafe";
    // Deliberately out of order: the response is matched to the local files by
    // filename, not by position, because the API may reorder its results.
    const { puts } = serveUpload([accepted("b.txt", second), accepted("a.txt")]);

    await runCli([
      "ingest",
      "upload",
      tempFile("a.txt", "alpha"),
      tempFile("b.txt", "bravo"),
      "--folder-id",
      "f-1",
    ]);

    expect(puts.map((p) => [p.request.url, p.body.toString("utf-8")])).toEqual([
      [second, "bravo"],
      [S3_URL, "alpha"],
    ]);
  });

  it("reports a file the API accepted but did not match to anything local", async () => {
    const { puts } = serveUpload([accepted("a.txt"), accepted("ghost.txt")]);

    const res = await runCli([
      "ingest",
      "upload",
      tempFile("a.txt", "alpha"),
      "--folder-id",
      "f-1",
    ]);

    expect(res.exitCode).toBe(0);
    expect(puts).toHaveLength(1);
    expect(res.stderr).toContain("ghost.txt");
    expect(res.stderr).toContain("Could not match to a local file");
  });
});

describe("ingest upload, when the API declines some of the files", () => {
  it("explains a conflict and still uploads the files beside it", async () => {
    const { puts } = serveUpload([accepted("new.txt"), rejected("old.txt", "conflict")]);

    const res = await runCli([
      "ingest",
      "upload",
      tempFile("new.txt", "fresh"),
      tempFile("old.txt", "stale"),
      "--folder-id",
      "f-1",
    ]);

    // One rejected file does not abort the batch: the accepted one is still PUT.
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
      "ingest",
      "upload",
      tempFile("new.txt", "fresh"),
      tempFile("dupe.txt", "again"),
      "--folder-id",
      "f-1",
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain("dupe.txt");
    expect(res.stderr).toContain("already been uploaded");
  });

  it("prefers the API's own message for an invalid file over the generic one", async () => {
    serveUpload([
      accepted("ok.txt"),
      rejected("bad.bin", "invalid", "File exceeds the 50MB limit."),
    ]);

    const res = await runCli([
      "ingest",
      "upload",
      tempFile("ok.txt", "fine"),
      tempFile("bad.bin", "junk"),
      "--folder-id",
      "f-1",
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain("File exceeds the 50MB limit.");
  });

  it("falls back to a readable reason for an unrecognized status", async () => {
    serveUpload([rejected("odd.txt", "quarantined")]);

    const res = await runCli(["ingest", "upload", tempFile("odd.txt", "x"), "--folder-id", "f-1"]);

    expect(res.stderr).toContain("Unexpected status: quarantined");
    expect(res.stderr).toContain("No files were uploaded");
  });
});

describe("ingest upload, when S3 refuses the bytes", () => {
  it("reports the failing file instead of counting it as uploaded", async () => {
    const { puts } = serveUpload([accepted("a.txt")], { s3Status: 403 });

    const res = await runCli([
      "ingest",
      "upload",
      tempFile("a.txt", "alpha"),
      "--folder-id",
      "f-1",
    ]);

    expect(puts).toHaveLength(1);
    // The regression this guards: the PUT was once fire-and-forget, so a
    // rejected object was summarized as a success and the user waited forever
    // for a document that was never stored.
    expect(res.stderr).toContain("a.txt");
    expect(res.stderr).toContain("S3 upload failed: 403");
    expect(res.stderr).toContain("0/1 file(s) uploaded");
    expect(res.stderr).not.toContain("Background processing");
  });

  it("exits 1 when nothing was stored, naming how many it tried", async () => {
    // A batch where every PUT failed used to exit 0, so a script branching on
    // the exit code saw success and moved on; the only signal was English on
    // stderr.
    serveUpload([accepted("a.txt")], { s3Status: 500 });

    const res = await runCli([
      "ingest",
      "upload",
      tempFile("a.txt", "alpha"),
      "--folder-id",
      "f-1",
    ]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("No files were uploaded (1 attempted)");
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
      "ingest",
      "upload",
      tempFile("a.txt", "alpha"),
      tempFile("b.txt", "bravo"),
      "--folder-id",
      "f-1",
    ]);

    expect(res.exitCode).toBe(0);
    expect(puts).toEqual(["bravo"]);
    expect(res.stderr).toContain("1/2 file(s) uploaded");
  });
});

describe("ingest upload, choosing a destination interactively", () => {
  it("opens the folder picker and sends the folder it returns", async () => {
    server.use(
      http.get(apiUrl("/org/kb/my-files"), () =>
        HttpResponse.json({
          nodes: [{ kb_node_id: "f-docs", name: "Docs", type: "folder" }],
          total: 1,
          limit: 50,
          offset: 0,
        }),
      ),
      http.get(apiUrl("/org/kb/nodes/:nodeId/children"), () =>
        HttpResponse.json({ nodes: [], total: 0, limit: 50, offset: 0 }),
      ),
    );
    const { prepBodies } = serveUpload([accepted("a.txt")]);
    process.stdin.isTTY = true;
    clack.selectAnswers = ["f-docs", "__SELECT_CURRENT__"];
    clack.textAnswers = ["yes"];

    const res = await runCli(["ingest", "upload", tempFile("a.txt", "alpha")]);

    expect(res.exitCode).toBe(0);
    expect(prepBodies[0]).toMatchObject({ kb_folder_node_id: "f-docs" });
  });

  it("uploads nothing and exits 0 when the confirmation is declined", async () => {
    server.use(
      http.get(apiUrl("/org/kb/my-files"), () =>
        HttpResponse.json({
          nodes: [{ kb_node_id: "f-docs", name: "Docs", type: "folder" }],
          total: 1,
          limit: 50,
          offset: 0,
        }),
      ),
      http.get(apiUrl("/org/kb/nodes/:nodeId/children"), () =>
        HttpResponse.json({ nodes: [], total: 0, limit: 50, offset: 0 }),
      ),
    );
    process.stdin.isTTY = true;
    clack.selectAnswers = ["f-docs", "__SELECT_CURRENT__"];
    clack.textAnswers = ["No"];

    const res = await runCli(["ingest", "upload", tempFile("a.txt", "alpha")]);

    // Declining is not a failure. No POST is registered, so reaching the upload
    // endpoint here would fail this test.
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("");
    expect(clack.canceled).toContain("Upload canceled.");
  });

  it("re-prompts rather than throwing when the confirmation is submitted empty", async () => {
    server.use(
      http.get(apiUrl("/org/kb/my-files"), () =>
        HttpResponse.json({
          nodes: [{ kb_node_id: "f-docs", name: "Docs", type: "folder" }],
          total: 1,
          limit: 50,
          offset: 0,
        }),
      ),
      http.get(apiUrl("/org/kb/nodes/:nodeId/children"), () =>
        HttpResponse.json({ nodes: [], total: 0, limit: 50, offset: 0 }),
      ),
    );
    process.stdin.isTTY = true;
    clack.selectAnswers = ["f-docs", "__SELECT_CURRENT__"];
    clack.textAnswers = ["no"];

    await runCli(["ingest", "upload", tempFile("a.txt", "alpha")]);

    // The validator used to call .trim() on the value, and an empty submission
    // passes undefined — a TypeError in place of a re-prompt.
    const { validate } = clack.textCalls[0]!;
    expect(validate?.(undefined)).toMatch(/yes/);
    expect(validate?.("maybe")).toMatch(/yes/);
    expect(validate?.("YES")).toBeUndefined();
    expect(validate?.(" no ")).toBeUndefined();
  });

  it("skips the picker entirely when stdin is not a terminal", async () => {
    const { prepBodies } = serveUpload([accepted("a.txt")]);

    // No folder id and no TTY: the files go to the org root rather than the
    // command blocking forever on a prompt nobody can answer. This is the path
    // an agent or a CI job takes.
    const res = await runCli(["ingest", "upload", tempFile("a.txt", "alpha")]);

    expect(res.exitCode).toBe(0);
    expect(prepBodies[0]).not.toHaveProperty("kb_folder_node_id");
  });
});

describe("ingest upload, on success", () => {
  it("prints the API response unmodified on stdout under --output json", async () => {
    const payload = uploadResponse([accepted("a.txt")]);
    serveUpload([accepted("a.txt")]);

    const res = await runCli([
      "ingest",
      "upload",
      tempFile("a.txt", "alpha"),
      "--folder-id",
      "f-1",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.json()).toEqual(payload);
  });

  it("says nothing on stderr under --output json", async () => {
    // `--output json` implies quiet, and printUploadSummary honors it: a caller
    // asking for a machine-readable result did not ask for a per-file
    // commentary next to it.
    serveUpload([accepted("a.txt")]);

    const res = await runCli([
      "ingest",
      "upload",
      tempFile("a.txt", "alpha"),
      "--folder-id",
      "f-1",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.stderr).toBe("");
  });

  it("renders one row per file under --output table", async () => {
    serveUpload([accepted("a.txt"), rejected("b.txt", "duplicate")]);

    const res = await runCli([
      "ingest",
      "upload",
      tempFile("a.txt", "alpha"),
      tempFile("b.txt", "bravo"),
      "--folder-id",
      "f-1",
      "--output",
      "table",
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("filename");
    expect(res.stdout).toContain("a.txt");
    expect(res.stdout).toContain("duplicate");
    expect(res.stdout).toContain("c-a.txt");
  });

  it("writes nothing to stdout in plain mode, because the summary is the rendering", async () => {
    serveUpload([accepted("a.txt")]);

    const res = await runCli([
      "ingest",
      "upload",
      tempFile("a.txt", "alpha"),
      "--folder-id",
      "f-1",
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("1/1 file(s) uploaded");
    expect(res.stderr).toContain("Background processing");
  });

  it("summarizes an empty results array rather than throwing on it", async () => {
    server.use(
      http.post(apiUrl("/org/kb/upload"), () => HttpResponse.json({ summary: { total: 0 } })),
    );

    const res = await runCli([
      "ingest",
      "upload",
      tempFile("a.txt", "alpha"),
      "--folder-id",
      "f-1",
    ]);

    // apiRequest casts the body, it does not validate it. A response missing
    // `results` must summarize nothing, not throw "not iterable".
    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain("0/0 file(s) uploaded");
  });
});

describe("ingest reprocess, on the wire", () => {
  it("PUTs the new file's metadata to the node, then the bytes to S3", async () => {
    const contents = "version two";
    let body: unknown;
    let seen: Request | undefined;
    const puts: { url: string; body: string }[] = [];
    server.use(
      http.put(apiUrl("/org/kb/nodes/:nodeId/file"), async ({ request }) => {
        seen = request.clone();
        body = await request.json();
        return HttpResponse.json(accepted("doc.txt"));
      }),
      http.put(S3_URL, async ({ request }) => {
        puts.push({ url: request.url, body: Buffer.from(await request.arrayBuffer()).toString() });
        return new HttpResponse(null, { status: 200 });
      }),
    );

    const res = await runCli(["ingest", "reprocess", "n-1", tempFile("doc.txt", contents)]);

    expect(res.exitCode).toBe(0);
    expect(seen?.method).toBe("PUT");
    expect(new URL(seen!.url).pathname).toBe("/api/v1/org/kb/nodes/n-1/file");
    // A single `file` object, not the `files` array the batch endpoint takes.
    expect(body).toEqual({
      file: {
        filename: "doc.txt",
        file_size_bytes: Buffer.byteLength(contents),
        content_type: "text/plain",
        content_hash_md5: md5(contents),
      },
    });
    expect(puts).toEqual([{ url: S3_URL, body: contents }]);
  });

  it("puts the tick on stderr and the item on stdout", async () => {
    server.use(
      http.put(apiUrl("/org/kb/nodes/:nodeId/file"), () => HttpResponse.json(accepted("doc.txt"))),
      http.put(S3_URL, () => new HttpResponse(null, { status: 200 })),
    );

    const res = await runCli(["ingest", "reprocess", "n-1", tempFile("doc.txt", "v2")]);

    expect(res.stderr).toContain("Background re-processing started");
    expect(res.stdout).toBe("");
  });

  it("warns and skips the S3 PUT when the API declines the new version", async () => {
    server.use(
      http.put(apiUrl("/org/kb/nodes/:nodeId/file"), () =>
        HttpResponse.json(rejected("doc.txt", "duplicate", "Same content as the current version.")),
      ),
    );

    // No S3 handler: a PUT here would be an unmocked request and fail the test,
    // which is the assertion — nothing is uploaded for a declined version.
    const res = await runCli(["ingest", "reprocess", "n-1", tempFile("doc.txt", "v2")]);

    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain("Skipped: duplicate");
    expect(res.stderr).toContain("Same content as the current version.");
  });

  it("exits 4 when the node does not exist", async () => {
    server.use(
      http.put(apiUrl("/org/kb/nodes/:nodeId/file"), () => new HttpResponse(null, { status: 404 })),
    );

    const res = await runCli(["ingest", "reprocess", "n-gone", tempFile("doc.txt", "v2")]);

    expect(res.exitCode).toBe(4);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Not found");
  });

  it("exits 1 with the file's own message when the path does not exist", async () => {
    const res = await runCli(["ingest", "reprocess", "n-1", join(workDir, "absent.txt")]);

    // BUG: `ingest upload` checks the paths first and exits 2 for a missing
    // file; `reprocess` lets readFile throw, which lands on the generic runtime
    // path and exits 1. Same mistake, two different exit codes.
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("ENOENT");
  });

  it("prints the item unmodified under --output json", async () => {
    const item = accepted("doc.txt");
    server.use(
      http.put(apiUrl("/org/kb/nodes/:nodeId/file"), () => HttpResponse.json(item)),
      http.put(S3_URL, () => new HttpResponse(null, { status: 200 })),
    );

    const res = await runCli([
      "ingest",
      "reprocess",
      "n-1",
      tempFile("doc.txt", "v2"),
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.json()).toEqual(item);
    expect(res.stderr).toBe("");
  });
});
