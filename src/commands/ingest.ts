import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { Command } from "commander";
import * as p from "@clack/prompts";
import pc from "picocolors";
import {
  apiRequest,
  handleUploadError,
  isBatchRejection,
  printUploadSummary,
  uploadStatusToReason,
  type UploadResponse,
  type UploadResultItem,
} from "../lib/api-client.js";
import { CliError, EXIT } from "../lib/errors.js";
import { assertFilesExist, assertFilesNotEmpty } from "../lib/file-args.js";
import { pickFolder } from "../lib/folder-picker.js";
import { describeCommand, idExits } from "../lib/help.js";
import { parseId } from "../lib/id-arg.js";
import { emit, type NextStep } from "../lib/output.js";
import { spinner } from "../lib/progress.js";
import { runAction } from "../lib/run-action.js";
import type { ResourceRef } from "../lib/resource.js";
import * as log from "../utils/logger.js";

interface FileMetadata {
  filename: string;
  file_size_bytes: number;
  content_type: string;
  content_hash_md5: string;
}

const MIME_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".html": "text/html",
  ".htm": "text/html",
  ".md": "text/markdown",
  ".json": "application/json",
  ".xml": "application/xml",
};

/** The folder an upload lands in. Its id is a kb_node_id, of a folder node. */
const FOLDER_SPEC = {
  label: "--folder-id",
  type: "KB folder",
  idField: "kb_folder_node_id",
  list: "senso kb my-files",
};

/** The document node a re-ingest replaces the file on. */
const KB_NODE_SPEC = {
  label: "<kb_node_id>",
  type: "KB node",
  idField: "kb_node_id",
  list: "senso kb my-files",
};

/**
 * What every upload result carries, and which id feeds which command.
 *
 * `kb_node_id` is repeated in three places on purpose. It is the id the poll
 * takes, it is the id this command's help used to name without ever printing,
 * and it is the id a caller reaching for `content_id` gets wrong — `senso
 * content get` serves non-KB content and answers 400 for anything uploaded
 * here.
 */
const UPLOAD_RETURNS = [
  "summary.total / summary.success / summary.skipped — the counts for this batch",
  "results[].filename — the file, as it was named on disk",
  "results[].status — upload_pending (accepted, bytes sent) | conflict (same content already in the knowledge base) | duplicate (already uploaded) | invalid (unsupported type) | markdown_requires_raw_ingestion (.md and .markdown go through `senso kb create-raw`)",
  "results[].kb_node_id — present on accepted files ONLY. This is the id to poll: `senso kb get <kb_node_id>` until content.processing_status is complete",
  "results[].content_id — the stored document. NOT interchangeable with kb_node_id; `senso content get` rejects knowledge base content by design",
  "results[].existing_content_id — on a conflict, the content already holding those bytes",
  "results[].error — the API's reason, when it gave one",
];

function getMimeType(filename: string): string {
  const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  return MIME_TYPES[ext] ?? "application/octet-stream";
}

async function getFileMetadata(filePath: string): Promise<{ meta: FileMetadata; buffer: Buffer }> {
  const absPath = resolve(filePath);
  const buffer = await readFile(absPath);
  const stats = await stat(absPath);
  const hash = createHash("md5").update(buffer).digest("hex");

  return {
    meta: {
      filename: basename(absPath),
      file_size_bytes: stats.size,
      content_type: getMimeType(basename(absPath)),
      content_hash_md5: hash,
    },
    buffer,
  };
}

async function uploadToS3(url: string, buffer: Buffer, contentType: string): Promise<void> {
  const res = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: new Uint8Array(buffer),
  });
  if (!res.ok) {
    throw new Error(`S3 upload failed: ${res.status} ${res.statusText}`);
  }
}

/** One result as a plain-text block, on stdout, ids included. */
function uploadBlock(item: UploadResultItem, index: number): string {
  const lines = [`  ${String(index + 1)}. ${item.filename}`, `     status       ${item.status}`];
  if (item.kb_node_id) lines.push(`     kb_node_id   ${item.kb_node_id}`);
  if (item.content_id) lines.push(`     content_id   ${item.content_id}`);
  if (item.existing_content_id) {
    lines.push(`     existing_content_id  ${item.existing_content_id}`);
  }
  if (item.error) lines.push(`     error        ${item.error}`);
  return lines.join("\n");
}

/** `senso kb get <kb_node_id>` for each accepted file — the documented poll. */
function pollSteps(items: UploadResultItem[]): NextStep[] {
  return items
    .filter((i) => typeof i.kb_node_id === "string" && i.kb_node_id !== "")
    .map((i) => ({
      why: `Poll ${i.filename} until content.processing_status is complete`,
      command: `senso kb get ${i.kb_node_id ?? ""}`,
    }));
}

export function registerIngestCommands(program: Command): void {
  const ingest = program
    .command("ingest")
    .description(
      "Ingest files into the knowledge base. Upload documents (PDF, TXT, DOCX, etc.) to be parsed, chunked, and embedded for semantic search. Ingestion is asynchronous: the id to keep is kb_node_id, and `senso kb get <kb_node_id>` says when the file is searchable.",
    )
    .addHelpText(
      "after",
      [
        "",
        "Workflow:",
        "  1. senso ingest upload ./policy.pdf --folder-id <kb_node_id>",
        "  2. note results[].kb_node_id for each accepted file",
        "  3. senso kb get <kb_node_id>   until content.processing_status is complete",
        '  4. senso search "..."          the file is searchable only after that',
        "",
        "Limits and surprises:",
        "  * 10 files per call, and no empty files. Both are checked before any request.",
        "  * .md and .markdown are refused by the API — create those with `senso kb create-raw`.",
        "  * .json and .xml are not accepted content types, although the extension is known here.",
        "  * `senso kb upload` is this same command under the kb group.",
        "  * content_id is NOT the poll id. `senso content get` serves non-KB content and",
        "    answers 400 for anything in the knowledge base; poll with `senso kb get`.",
      ].join("\n"),
    );

  describeCommand(
    ingest
      .command("upload")
      .description(
        "Upload files to the knowledge base. Accepts local file paths (up to 10). Files are hashed, uploaded to S3, then parsed and embedded by a background worker. Poll 'senso kb get <kb_node_id>' — the kb_node_id printed for each accepted file — until content.processing_status is 'complete' before searching the uploaded content.",
      )
      .argument("<files...>", "Local file paths, 1-10. Each must exist and be non-empty")
      .option(
        "--folder-id <id>",
        "Destination folder, as its kb_node_id (from `senso kb my-files`). Without it: the interactive picker on a terminal, the organization's root folder otherwise",
      )
      .action(
        runAction(program, async (ctx, files: string[], cmdOpts: { folderId?: string }) => {
          if (files.length > 10) {
            throw new CliError("Maximum 10 files per upload request.", EXIT.USAGE, {
              code: "usage",
              hint: "Split the upload into batches of 10 or fewer files.",
            });
          }

          // Validate all files exist before doing anything else — shared with
          // `kb upload` and `ingest reprocess` so the three cannot disagree about
          // what a bad path costs.
          await assertFilesExist(files);

          // 0. Resolve destination folder
          let kbFolderNodeId: string | undefined;

          if (cmdOpts.folderId) {
            // Checked here rather than left to the API: a mistyped folder id used
            // to round-trip to a 400 "Invalid request payload" and exit 1, which
            // reads like a server problem rather than a typo.
            kbFolderNodeId = parseId(cmdOpts.folderId, FOLDER_SPEC);
          } else if (process.stdin.isTTY) {
            const folder = await pickFolder({ apiKey: ctx.apiKey, baseUrl: ctx.baseUrl });

            const fileList = files.map((f) => basename(f)).join(", ");
            const answer = await p.text({
              message: `You want to upload ${pc.bold(`"${fileList}"`)} to the folder ${pc.bold(pc.cyan(`"${folder.folderName}"`))}? Type 'yes' or 'no' to continue:`,
              // `val` is optional: submitting an empty prompt passes undefined, and
              // calling .trim() on it threw a TypeError instead of re-prompting.
              validate: (val) => {
                const v = (val ?? "").trim().toLowerCase();
                if (v !== "yes" && v !== "no") return "Please type 'yes' or 'no'";
              },
            });

            if (p.isCancel(answer) || (answer as string).trim().toLowerCase() === "no") {
              p.cancel("Upload canceled.");
              return;
            }

            kbFolderNodeId = folder.folderId;
          } else if (!ctx.quiet) {
            // Silence here was a trap: with no terminal and no --folder-id the
            // files land in the root, and nothing said so — a caller who expected
            // the picker found its documents somewhere it had not chosen.
            log.info("Uploading to the organization's root folder (no --folder-id, no terminal).");
          }

          // 1. Read files and compute metadata
          const fileData = await Promise.all(files.map(getFileMetadata));

          assertFilesNotEmpty(fileData.map((f) => f.meta));

          // 2. Request presigned upload URLs
          const body: Record<string, unknown> = { files: fileData.map((f) => f.meta) };
          if (kbFolderNodeId) body.kb_folder_node_id = kbFolderNodeId;

          const prepSpin = spinner(ctx.quiet);
          prepSpin.start("Preparing upload...");

          let response: UploadResponse;
          try {
            response = await apiRequest<UploadResponse>({
              method: "POST",
              path: "/org/kb/upload",
              body,
              // Only when a folder was named: without one the request addresses
              // no record, and a 404 naming a folder id that was never sent would
              // be a lie.
              ...(kbFolderNodeId
                ? { resource: { ...FOLDER_SPEC, id: kbFolderNodeId } satisfies ResourceRef }
                : {}),
              apiKey: ctx.apiKey,
              baseUrl: ctx.baseUrl,
            });
          } catch (err) {
            // Narrow on purpose: the spinner has to be stopped or it keeps
            // spinning over the error, and this is the only awaited call it is
            // running across.
            prepSpin.stop("Upload failed");
            // handleUploadError is the only thing that knows how to unpack the
            // per-file reasons, so it keeps that reporting and the throw supplies
            // the exit code. Anything else is rethrown untouched so runAction maps
            // it to its real code (401 → 3, 404 → 4, unreachable → 5) rather than
            // flattening every upload failure to 1.
            if (isBatchRejection(err)) {
              handleUploadError(err);
              throw new CliError("No files were uploaded.", EXIT.ERROR, { cause: err });
            }
            throw err;
          }

          // `?? []` although `results` reads as required: apiRequest casts the
          // body rather than validating it, so a malformed response must produce
          // an empty summary here, not a "not iterable" TypeError.
          const items = response.results ?? [];
          const pendingCount = items.filter(
            (i) => i.status === "upload_pending" && i.upload_url,
          ).length;
          prepSpin.stop(`${pendingCount} file(s) ready for upload`);

          // 3. Upload accepted files to S3
          let uploaded = 0;
          const failed: { filename: string; reason: string }[] = [];

          for (const item of items) {
            if (item.status === "upload_pending" && item.upload_url) {
              const match = fileData.find((f) => f.meta.filename === item.filename);
              if (!match) {
                failed.push({
                  filename: item.filename,
                  reason: "Could not match to a local file.",
                });
                continue;
              }
              const uploadSpin = spinner(ctx.quiet);
              uploadSpin.start(`Uploading ${item.filename}...`);
              try {
                await uploadToS3(item.upload_url, match.buffer, match.meta.content_type);
                uploaded++;
                uploadSpin.stop(`Uploaded ${item.filename}`);
              } catch (uploadErr) {
                // Recovered from: one file failing is reported in the summary and
                // the remaining files are still uploaded.
                uploadSpin.stop(`Failed to upload ${item.filename}`);
                failed.push({
                  filename: item.filename,
                  reason: `Upload failed: ${uploadErr instanceof Error ? uploadErr.message : String(uploadErr)}`,
                });
              }
            } else {
              failed.push({
                filename: item.filename,
                reason: uploadStatusToReason(item.status, item.error),
              });
            }
          }

          // 4. Summary
          printUploadSummary(uploaded, failed, items, ctx.quiet);

          // A batch where every file was rejected or every S3 PUT failed used to
          // exit 0: nothing was stored, but a script branching on the exit code saw
          // success and the only signal was English on stderr.
          if (uploaded === 0 && items.length > 0) {
            throw new CliError(`No files were uploaded (${items.length} attempted).`, EXIT.ERROR, {
              hint: "Each file's reason is listed above. Re-run with --output json for the machine-readable detail.",
            });
          }

          // Every format now carries the ids. `plain` used to print nothing at all
          // on stdout — so the one format an agent gets by default never showed
          // the kb_node_id this command's own help tells it to poll.
          emit(ctx, response, {
            table: {
              rows: items.map((i) => ({
                filename: i.filename,
                status: i.status,
                // The id `senso kb get` takes. `content_id` is not interchangeable
                // with it: polling a KB upload through `senso content get` hits an
                // endpoint that serves non-KB content only and answers 400.
                kb_node_id: i.kb_node_id,
                content_id: i.content_id,
              })),
              columns: ["filename", "status", "kb_node_id", "content_id"],
            },
            plain: ["", ...items.map((item, i) => uploadBlock(item, i)), ""],
            // A partial batch is reported, not hidden: the exit code stays 0
            // because files WERE stored, so the skipped ones have to be visible in
            // the payload a JSON caller reads.
            warnings: failed.map((f) => `${f.filename} — ${f.reason}`),
            next: pollSteps(items),
          });
        }),
      ),
    {
      returns: UPLOAD_RETURNS,
      exitCodes: {
        ...idExits,
        1: "nothing was stored: every file was skipped by the API, or every S3 upload failed. A partial batch exits 0 with a warning per skipped file",
        2: "more than 10 files, a path that does not exist, an empty file, or --folder-id that is not a UUID",
        4: "the destination folder does not exist, or is not shared with this API key",
      },
      notes: [
        "Ingestion is asynchronous. A file is searchable only once `senso kb get <kb_node_id>` reports content.processing_status complete.",
        "`senso kb upload` is the same command.",
        ".md and .markdown are refused by the API; create those documents with `senso kb create-raw`.",
        "Without --folder-id: the interactive picker on a terminal, the organization's root folder otherwise.",
      ],
      examples: [
        {
          comment: "Upload into a known folder",
          command:
            "senso ingest upload ./policy.pdf --folder-id 3f2a9b8c-7d6e-4f5a-9b0c-1d2e3f4a5b6c",
        },
        {
          comment: "Collect the ids to poll",
          command:
            "senso ingest upload ./a.pdf ./b.pdf --output json | jq -r '.data.results[].kb_node_id'",
        },
      ],
      seeAlso: ["senso kb get <kb_node_id>", "senso kb my-files", "senso ingest reprocess"],
    },
  );

  describeCommand(
    ingest
      .command("reprocess")
      .description(
        "Re-ingest an existing document with a new file version. The node keeps its kb_node_id and content_id; a new version and a new ingestion run are created.",
      )
      // Named for the field it is, not for a camelCase variable: every response
      // and every other command calls this id kb_node_id.
      .argument(
        "<kb_node_id>",
        "The document node to replace the file on, from `senso kb my-files`",
      )
      .argument("<file>", "Path to the replacement file")
      .action(
        runAction(program, async (ctx, nodeId: string, file: string) => {
          const kbNodeId = parseId(nodeId, KB_NODE_SPEC);
          // Checked before the request rather than left to readFile: a mistyped
          // path is the user's mistake, so it exits 2 naming the file here, the
          // same as `ingest upload`, instead of surfacing as a runtime ENOENT.
          await assertFilesExist([file]);
          const { meta, buffer } = await getFileMetadata(file);

          const item = await apiRequest<UploadResultItem>({
            method: "PUT",
            path: `/org/kb/nodes/${kbNodeId}/file`,
            body: { file: meta },
            resource: { ...KB_NODE_SPEC, id: kbNodeId },
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
          });

          if (item.status === "upload_pending" && item.upload_url) {
            await uploadToS3(item.upload_url, buffer, meta.content_type);
            if (!ctx.quiet) {
              log.success(
                `Uploaded ${meta.filename} for KB node ${kbNodeId}. Background re-processing started.`,
              );
            }
          } else if (!ctx.quiet) {
            log.warn(`Skipped: ${item.status}${item.error ? ` — ${item.error}` : ""}`);
          }

          // stdout carries the ids, in every format: the poll command needs
          // kb_node_id and the ✓ line on stderr is not a payload.
          emit(ctx, item, {
            plain: ["", uploadBlock(item, 0), ""],
            next:
              item.status === "upload_pending"
                ? [
                    {
                      why: "Poll until content.processing_status is complete",
                      command: `senso kb get ${kbNodeId}`,
                    },
                  ]
                : [],
          });
        }),
      ),
    {
      returns: [
        "kb_node_id — unchanged; the id to poll with `senso kb get <kb_node_id>`",
        "content_id — unchanged; the document keeps its identity across versions",
        "ingestion_run_id — the run that will parse, chunk and embed the new version",
        "status — upload_pending (accepted, bytes sent) | conflict (the same content is already in the knowledge base) | duplicate (already uploaded) | invalid (unsupported type or over the size limit). Only upload_pending means the new version was stored.",
      ],
      exitCodes: {
        ...idExits,
        2: "<kb_node_id> is not a UUID, or the file does not exist",
        4: "no KB node with this id in your organization",
      },
      notes: [
        "Replacing a file keeps kb_node_id and content_id and adds a version; it does not create a new document.",
        "A folder node has no file to replace: the API answers 404 for one.",
        ".md and .markdown are refused here too — use `senso kb update-raw <kb_node_id>`.",
      ],
      examples: [
        {
          comment: "Replace a document's file",
          command: "senso ingest reprocess 3f2a9b8c-7d6e-4f5a-9b0c-1d2e3f4a5b6c ./policy-v2.pdf",
        },
      ],
      seeAlso: ["senso kb get <kb_node_id>", "senso ingest upload"],
    },
  );
}
