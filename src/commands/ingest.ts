import { createHash } from "node:crypto";
import { access, readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { Command } from "commander";
import * as p from "@clack/prompts";
import pc from "picocolors";
import {
  ApiError,
  apiRequest,
  handleUploadError,
  printUploadSummary,
  uploadStatusToReason,
  type UploadResponse,
  type UploadResultItem,
} from "../lib/api-client.js";
import { CliError, EXIT } from "../lib/errors.js";
import { pickFolder } from "../lib/folder-picker.js";
import { emit } from "../lib/output.js";
import { spinner } from "../lib/progress.js";
import { runAction } from "../lib/run-action.js";
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

/**
 * A whole-batch rejection, as opposed to any other API failure.
 *
 * The upload endpoint refuses a batch by returning the same per-file `results`
 * array it returns on success, with a reason on each entry. That is the only
 * failure shape carrying detail worth unpacking; everything else is an ordinary
 * API or transport error and is handled as one.
 */
function isBatchRejection(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    typeof err.body === "object" &&
    err.body !== null &&
    "results" in err.body
  );
}

export function registerIngestCommands(program: Command): void {
  const ingest = program
    .command("ingest")
    .description(
      "Ingest files into the knowledge base. Upload documents (PDF, TXT, DOCX, etc.) to be parsed, chunked, and embedded for semantic search.",
    );

  ingest
    .command("upload <files...>")
    .description(
      "Upload files to the knowledge base. Accepts local file paths (up to 10). Files are hashed, uploaded to S3, then parsed and embedded by a background worker. Poll 'senso content get <content-id>' until processing_status is 'complete' before searching the uploaded content.",
    )
    .option("--folder-id <id>", "Destination folder ID (skip interactive prompt)")
    .action(
      runAction(program, async (ctx, files: string[], cmdOpts: { folderId?: string }) => {
        if (files.length > 10) {
          throw new CliError("Maximum 10 files per upload request.", EXIT.USAGE, {
            code: "usage",
            hint: "Split the upload into batches of 10 or fewer files.",
          });
        }

        // Validate all files exist before doing anything else
        for (const file of files) {
          try {
            await access(resolve(file));
          } catch (err) {
            throw new CliError(
              `File not found: "${file}". Please check the file name and try again.`,
              EXIT.USAGE,
              { code: "usage", cause: err },
            );
          }
        }

        // 0. Resolve destination folder
        let kbFolderNodeId: string | undefined;

        if (cmdOpts.folderId) {
          kbFolderNodeId = cmdOpts.folderId;
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
        }

        // 1. Read files and compute metadata
        const fileData = await Promise.all(files.map(getFileMetadata));

        const emptyFiles = fileData.filter((f) => f.meta.file_size_bytes < 1);
        if (emptyFiles.length > 0) {
          // One message rather than a line per file: runAction reports what is
          // thrown, so listing the names here keeps the whole failure in it.
          throw new CliError(
            `Empty file(s): ${emptyFiles.map((f) => f.meta.filename).join(", ")}.`,
            EXIT.USAGE,
            { code: "usage", hint: "Please select valid files with content." },
          );
        }

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
              failed.push({ filename: item.filename, reason: "Could not match to a local file." });
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

        // The human summary above is already on stderr, so `plain` adds nothing;
        // json and table callers still get the payload.
        emit(ctx, response, {
          table: {
            rows: items.map((i) => ({
              filename: i.filename,
              status: i.status,
              content_id: i.content_id,
            })),
            columns: ["filename", "status", "content_id"],
          },
          plain: [],
        });
      }),
    );

  ingest
    .command("reprocess <nodeId> <file>")
    .description(
      "Re-ingest an existing document with a new file version. Provide the KB node ID (kb_node_id) and the path to the replacement file.",
    )
    .action(
      runAction(program, async (ctx, nodeId: string, file: string) => {
        const { meta, buffer } = await getFileMetadata(file);

        const item = await apiRequest<UploadResultItem>({
          method: "PUT",
          path: `/org/kb/nodes/${nodeId}/file`,
          body: { file: meta },
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });

        if (item.status === "upload_pending" && item.upload_url) {
          await uploadToS3(item.upload_url, buffer, meta.content_type);
          if (!ctx.quiet) {
            log.success(
              `Uploaded ${meta.filename} for node ${nodeId}. Background re-processing started.`,
            );
          }
        } else if (!ctx.quiet) {
          log.warn(`Skipped: ${item.status}${item.error ? ` — ${item.error}` : ""}`);
        }

        // As above: the ✓/! line is the human rendering, so `plain` stays empty.
        emit(ctx, item, { plain: [] });
      }),
    );
}
