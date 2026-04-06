import { createHash } from "node:crypto";
import { access, readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { Command } from "commander";
import * as p from "@clack/prompts";
import pc from "picocolors";
import {
  apiRequest,
  formatApiError,
  handleUploadError,
  printUploadSummary,
  uploadStatusToReason,
  type UploadResponse,
  type UploadResultItem,
} from "../lib/api-client.js";
import { pickFolder } from "../lib/folder-picker.js";
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
  return MIME_TYPES[ext] || "application/octet-stream";
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
    body: buffer,
  });
  if (!res.ok) {
    throw new Error(`S3 upload failed: ${res.status} ${res.statusText}`);
  }
}

export function registerIngestCommands(program: Command): void {
  const ingest = program
    .command("ingest")
    .description("Ingest files into the knowledge base. Upload documents (PDF, TXT, DOCX, etc.) to be parsed, chunked, and embedded for semantic search.");

  ingest
    .command("upload <files...>")
    .description("Upload files to the knowledge base. Accepts local file paths (up to 10). Files are hashed, uploaded to S3, then parsed and embedded by a background worker. Poll 'senso content get <content-id>' until processing_status is 'complete' before searching the uploaded content.")
    .option("--folder-id <id>", "Destination folder ID (skip interactive prompt)")
    .action(async (files: string[], cmdOpts: { folderId?: string }) => {
      const opts = program.opts();
      if (files.length > 10) {
        log.error("Maximum 10 files per upload request.");
        process.exit(1);
      }

      // Validate all files exist before doing anything else
      for (const file of files) {
        try {
          await access(resolve(file));
        } catch {
          log.error(`File not found: "${file}". Please check the file name and try again.`);
          process.exit(1);
        }
      }

      const prepSpin = p.spinner();
      try {
        // 0. Resolve destination folder
        let kbFolderNodeId: string | undefined;

        if (cmdOpts.folderId) {
          kbFolderNodeId = cmdOpts.folderId;
        } else if (process.stdin.isTTY) {
          const folder = await pickFolder({ apiKey: opts.apiKey, baseUrl: opts.baseUrl });

          const fileList = files.map((f) => basename(f)).join(", ");
          const answer = await p.text({
            message: `You want to upload ${pc.bold(`"${fileList}"`)} to the folder ${pc.bold(pc.cyan(`"${folder.folderName}"`))}? Type 'yes' or 'no' to continue:`,
            validate: (val) => {
              const v = val.trim().toLowerCase();
              if (v !== "yes" && v !== "no") return "Please type 'yes' or 'no'";
            },
          });

          if (p.isCancel(answer) || (answer as string).trim().toLowerCase() === "no") {
            p.cancel("Upload cancelled.");
            process.exit(0);
          }

          kbFolderNodeId = folder.folderId;
        }

        // 1. Read files and compute metadata
        const fileData = await Promise.all(files.map(getFileMetadata));

        const emptyFiles = fileData.filter((f) => f.meta.file_size_bytes < 1);
        if (emptyFiles.length > 0) {
          for (const f of emptyFiles) {
            log.error(`File "${f.meta.filename}" is empty. Please select a valid file with content.`);
          }
          process.exit(1);
        }

        // 2. Request presigned upload URLs
        const body: Record<string, unknown> = { files: fileData.map((f) => f.meta) };
        if (kbFolderNodeId) body.kb_folder_node_id = kbFolderNodeId;

        prepSpin.start("Preparing upload...");

        const response = await apiRequest<UploadResponse>({
          method: "POST",
          path: "/org/kb/upload",
          body,
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });

        const items = response.results ?? [];
        const pendingCount = items.filter((i) => i.status === "upload_pending" && i.upload_url).length;
        prepSpin.stop(`${pendingCount} file(s) ready for upload`);

        // 3. Upload accepted files to S3
        let uploaded = 0;
        const failed: Array<{ filename: string; reason: string }> = [];

        for (const item of items) {
          if (item.status === "upload_pending" && item.upload_url) {
            const match = fileData.find((f) => f.meta.filename === item.filename);
            if (!match) {
              failed.push({ filename: item.filename, reason: "Could not match to a local file." });
              continue;
            }
            const uploadSpin = p.spinner();
            uploadSpin.start(`Uploading ${item.filename}...`);
            try {
              await uploadToS3(item.upload_url, match.buffer, match.meta.content_type);
              uploaded++;
              uploadSpin.stop(`Uploaded ${item.filename}`);
            } catch (uploadErr) {
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
        printUploadSummary(uploaded, failed, items);

        if (opts.output === "json") {
          console.log(JSON.stringify(response, null, 2));
        }
      } catch (err) {
        prepSpin.stop("Upload failed");
        handleUploadError(err);
        process.exit(1);
      }
    });

  ingest
    .command("reprocess <nodeId> <file>")
    .description("Re-ingest an existing document with a new file version. Provide the KB node ID (kb_node_id) and the path to the replacement file.")
    .action(async (nodeId: string, file: string) => {
      const opts = program.opts();
      try {
        const { meta, buffer } = await getFileMetadata(file);

        const item = await apiRequest<UploadResultItem>({
          method: "PUT",
          path: `/org/kb/nodes/${nodeId}/file`,
          body: { file: meta },
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });

        if (item.status === "upload_pending" && item.upload_url) {
          await uploadToS3(item.upload_url, buffer, meta.content_type);
          log.success(`Uploaded ${meta.filename} for node ${nodeId}. Background re-processing started.`);
        } else {
          log.warn(`Skipped: ${item.status}${item.error ? ` — ${item.error}` : ""}`);
        }

        if (opts.output === "json") {
          console.log(JSON.stringify(item, null, 2));
        }
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });
}
