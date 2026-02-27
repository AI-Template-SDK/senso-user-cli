import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { Command } from "commander";
import { apiRequest, formatApiError } from "../lib/api-client.js";
import * as log from "../utils/logger.js";

interface FileMetadata {
  filename: string;
  file_size_bytes: number;
  content_type: string;
  content_hash_md5: string;
}

interface UploadResultItem {
  ingestion_run_id?: string;
  content_id?: string;
  filename: string;
  status: "upload_pending" | "conflict" | "duplicate" | "invalid";
  upload_url?: string;
  message?: string;
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
    .description("Upload files to the knowledge base. Accepts local file paths (up to 10). Files are hashed, uploaded to S3, then parsed and embedded by a background worker.")
    .action(async (files: string[]) => {
      const opts = program.opts();
      if (files.length > 10) {
        log.error("Maximum 10 files per upload request.");
        process.exit(1);
      }

      try {
        // 1. Read files and compute metadata
        const fileData = await Promise.all(files.map(getFileMetadata));

        // 2. Request presigned upload URLs
        const results = await apiRequest<UploadResultItem[]>({
          method: "POST",
          path: "/org/ingestion/upload",
          body: { files: fileData.map((f) => f.meta) },
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });

        const items = Array.isArray(results) ? results : [];

        // 3. Upload accepted files to S3
        let uploaded = 0;
        for (const item of items) {
          if (item.status === "upload_pending" && item.upload_url) {
            const match = fileData.find((f) => f.meta.filename === item.filename);
            if (match) {
              await uploadToS3(item.upload_url, match.buffer, match.meta.content_type);
              uploaded++;
              log.success(`Uploaded ${item.filename} (content_id: ${item.content_id})`);
            }
          } else {
            log.warn(`Skipped ${item.filename}: ${item.status}${item.message ? ` — ${item.message}` : ""}`);
          }
        }

        if (uploaded > 0) {
          log.success(`${uploaded} file(s) uploaded. Background processing will parse, chunk, and embed them.`);
        }

        if (opts.output === "json") {
          console.log(JSON.stringify(results, null, 2));
        }
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  ingest
    .command("reprocess <contentId> <file>")
    .description("Re-ingest an existing content item with a new file version. Provide the content ID and the path to the replacement file.")
    .action(async (contentId: string, file: string) => {
      const opts = program.opts();
      try {
        const { meta, buffer } = await getFileMetadata(file);

        const results = await apiRequest<UploadResultItem[]>({
          method: "PUT",
          path: `/org/ingestion/content/${contentId}`,
          body: { file: meta },
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });

        const items = Array.isArray(results) ? results : [];
        for (const item of items) {
          if (item.status === "upload_pending" && item.upload_url) {
            await uploadToS3(item.upload_url, buffer, meta.content_type);
            log.success(`Uploaded ${meta.filename} for content ${contentId}. Background re-processing started.`);
          } else {
            log.warn(`Skipped: ${item.status}${item.message ? ` — ${item.message}` : ""}`);
          }
        }

        if (opts.output === "json") {
          console.log(JSON.stringify(results, null, 2));
        }
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });
}
