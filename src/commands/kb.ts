import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { Command } from "commander";
import {
  apiRequest,
  formatApiError,
  handleUploadError,
  printUploadSummary,
  uploadStatusToReason,
  type UploadResponse,
} from "../lib/api-client.js";
import * as log from "../utils/logger.js";

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

async function getFileMetadata(filePath: string) {
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
  if (!res.ok) throw new Error(`S3 upload failed: ${res.status} ${res.statusText}`);
}

export function registerKBCommands(program: Command): void {
  const kb = program
    .command("kb")
    .description("Manage the knowledge base. Browse nodes, upload files, create folders, create raw content, and manage the KB tree.");

  kb
    .command("root")
    .description("Get the root KB node for the org.")
    .action(async () => {
      const opts = program.opts();
      try {
        const data = await apiRequest({ path: "/org/kb/root", apiKey: opts.apiKey, baseUrl: opts.baseUrl });
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  kb
    .command("my-files")
    .description("List top-level files and folders in the knowledge base.")
    .option("--limit <n>", "Items per page", "50")
    .option("--offset <n>", "Pagination offset", "0")
    .option("--type <type>", "Filter by node type (folder or content)")
    .action(async (cmdOpts: Record<string, string>) => {
      const opts = program.opts();
      try {
        const data = await apiRequest({
          path: "/org/kb/my-files",
          params: { limit: cmdOpts.limit, offset: cmdOpts.offset, type: cmdOpts.type },
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  kb
    .command("find")
    .description("Search KB nodes by name.")
    .requiredOption("--query <q>", "Name search query")
    .option("--limit <n>", "Items per page", "20")
    .option("--offset <n>", "Pagination offset", "0")
    .option("--type <type>", "Filter by node type (folder or content)")
    .action(async (cmdOpts: Record<string, string>) => {
      const opts = program.opts();
      try {
        const data = await apiRequest({
          path: "/org/kb/find",
          params: { q: cmdOpts.query, limit: cmdOpts.limit, offset: cmdOpts.offset, type: cmdOpts.type },
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  kb
    .command("sync-status")
    .description("Get the vector sync status for the org's knowledge base.")
    .action(async () => {
      const opts = program.opts();
      try {
        const data = await apiRequest({ path: "/org/kb/sync-status", apiKey: opts.apiKey, baseUrl: opts.baseUrl });
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  kb
    .command("get <id>")
    .description("Get a KB node by ID.")
    .action(async (id: string) => {
      const opts = program.opts();
      try {
        const data = await apiRequest({ path: `/org/kb/nodes/${id}`, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  kb
    .command("children <id>")
    .description("List children of a KB folder node.")
    .option("--limit <n>", "Items per page", "50")
    .option("--offset <n>", "Pagination offset", "0")
    .option("--type <type>", "Filter by node type (folder or content)")
    .action(async (id: string, cmdOpts: Record<string, string>) => {
      const opts = program.opts();
      try {
        const data = await apiRequest({
          path: `/org/kb/nodes/${id}/children`,
          params: { limit: cmdOpts.limit, offset: cmdOpts.offset, type: cmdOpts.type },
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  kb
    .command("ancestors <id>")
    .description("Get the ancestor chain (breadcrumb) for a KB node.")
    .action(async (id: string) => {
      const opts = program.opts();
      try {
        const data = await apiRequest({ path: `/org/kb/nodes/${id}/ancestors`, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  kb
    .command("get-content <id>")
    .description("Get the content detail for a KB content node.")
    .option("--version <version>", "Specific version to retrieve")
    .action(async (id: string, cmdOpts: { version?: string }) => {
      const opts = program.opts();
      try {
        const data = await apiRequest({
          path: `/org/kb/nodes/${id}/content`,
          params: { version: cmdOpts.version },
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  kb
    .command("download-url <id>")
    .description("Get a presigned S3 download URL for a KB file node.")
    .option("--version <version>", "Specific version to download")
    .action(async (id: string, cmdOpts: { version?: string }) => {
      const opts = program.opts();
      try {
        const data = await apiRequest({
          path: `/org/kb/nodes/${id}/download-url`,
          params: { version: cmdOpts.version },
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  kb
    .command("create-folder")
    .description("Create a new folder in the knowledge base.")
    .requiredOption("--name <name>", "Folder name")
    .option("--parent-id <id>", "Parent folder node ID (omit to create at root)")
    .action(async (cmdOpts: { name: string; parentId?: string }) => {
      const opts = program.opts();
      try {
        const body: Record<string, unknown> = { name: cmdOpts.name };
        if (cmdOpts.parentId) body.parent_id = cmdOpts.parentId;
        const data = await apiRequest({ method: "POST", path: "/org/kb/folders", body, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
        log.success(`Folder "${cmdOpts.name}" created.`);
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  kb
    .command("rename <id>")
    .description("Rename a KB node.")
    .requiredOption("--name <name>", "New name")
    .action(async (id: string, cmdOpts: { name: string }) => {
      const opts = program.opts();
      try {
        const data = await apiRequest({ method: "PATCH", path: `/org/kb/nodes/${id}/rename`, body: { name: cmdOpts.name }, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
        log.success(`Node ${id} renamed to "${cmdOpts.name}".`);
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  kb
    .command("move <id>")
    .description("Move a KB node to a different parent folder.")
    .requiredOption("--parent-id <parentId>", "Target parent folder node ID")
    .action(async (id: string, cmdOpts: { parentId: string }) => {
      const opts = program.opts();
      try {
        const data = await apiRequest({ method: "PATCH", path: `/org/kb/nodes/${id}/move`, body: { new_parent_id: cmdOpts.parentId }, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
        log.success(`Node ${id} moved.`);
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  kb
    .command("delete <id>")
    .description("Delete a KB node (soft delete).")
    .action(async (id: string) => {
      const opts = program.opts();
      try {
        await apiRequest({ method: "DELETE", path: `/org/kb/nodes/${id}`, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
        log.success(`Node ${id} deleted.`);
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  kb
    .command("create-raw")
    .description("Create a raw (text/markdown) content item in the knowledge base.")
    .requiredOption("--data <json>", 'JSON: { "title": "My doc", "text": "# Hello", "kb_folder_node_id": "<uuid>", "tag_ids": ["<uuid>"] }')
    .action(async (cmdOpts: { data: string }) => {
      const opts = program.opts();
      try {
        const body = JSON.parse(cmdOpts.data);
        const data = await apiRequest({ method: "POST", path: "/org/kb/raw", body, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
        log.success("Raw content node created.");
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(err instanceof SyntaxError ? "Invalid JSON in --data" : formatApiError(err));
        process.exit(1);
      }
    });

  kb
    .command("update-raw <id>")
    .description("Fully replace the text content of a raw KB node (creates a new version).")
    .requiredOption("--data <json>", 'JSON: { "title": "Title", "text": "# Updated content", "tag_ids": ["<uuid>"] }')
    .action(async (id: string, cmdOpts: { data: string }) => {
      const opts = program.opts();
      try {
        const body = JSON.parse(cmdOpts.data);
        const data = await apiRequest({ method: "PUT", path: `/org/kb/nodes/${id}/raw`, body, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
        log.success(`Node ${id} content replaced.`);
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(err instanceof SyntaxError ? "Invalid JSON in --data" : formatApiError(err));
        process.exit(1);
      }
    });

  kb
    .command("patch-raw <id>")
    .description("Partially update the text content of a raw KB node.")
    .requiredOption("--data <json>", 'JSON: { "title": "New title", "text": "Updated text", "summary": "...", "tag_ids": ["<uuid>"] }')
    .action(async (id: string, cmdOpts: { data: string }) => {
      const opts = program.opts();
      try {
        const body = JSON.parse(cmdOpts.data);
        const data = await apiRequest({ method: "PATCH", path: `/org/kb/nodes/${id}/raw`, body, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
        log.success(`Node ${id} content patched.`);
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(err instanceof SyntaxError ? "Invalid JSON in --data" : formatApiError(err));
        process.exit(1);
      }
    });

  kb
    .command("upload <files...>")
    .description("Upload files to the knowledge base (up to 10). Files are hashed, uploaded to S3, then parsed and embedded by a background worker.")
    .option("--folder-id <id>", "Parent folder node ID to place files in (omit for root)")
    .action(async (files: string[], cmdOpts: { folderId?: string }) => {
      const opts = program.opts();
      if (files.length > 10) {
        log.error("Maximum 10 files per upload request.");
        process.exit(1);
      }
      try {
        const fileData = await Promise.all(files.map(getFileMetadata));
        const body: Record<string, unknown> = { files: fileData.map((f) => f.meta) };
        if (cmdOpts.folderId) body.kb_folder_node_id = cmdOpts.folderId;

        const response = await apiRequest<UploadResponse>({
          method: "POST",
          path: "/org/kb/upload",
          body,
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });

        const items = response.results ?? [];
        let uploaded = 0;
        const failed: Array<{ filename: string; reason: string }> = [];

        for (const item of items) {
          if (item.status === "upload_pending" && item.upload_url) {
            const match = fileData.find((f) => f.meta.filename === item.filename);
            if (!match) {
              failed.push({ filename: item.filename, reason: "Could not match to a local file." });
              continue;
            }
            try {
              await uploadToS3(item.upload_url, match.buffer, match.meta.content_type);
              uploaded++;
            } catch (uploadErr) {
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

        printUploadSummary(uploaded, failed, items);
        if (opts.output === "json") console.log(JSON.stringify(response, null, 2));
      } catch (err) {
        handleUploadError(err);
        process.exit(1);
      }
    });

  kb
    .command("update-file <id> <file>")
    .description("Replace the file on an existing KB file node with a new version.")
    .action(async (id: string, file: string) => {
      const opts = program.opts();
      try {
        const { meta, buffer } = await getFileMetadata(file);
        const item = await apiRequest<{ status: string; upload_url?: string; error?: string; content_id?: string; ingestion_run_id?: string }>({
          method: "PUT",
          path: `/org/kb/nodes/${id}/file`,
          body: { file: meta },
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        if (item.status === "upload_pending" && item.upload_url) {
          await uploadToS3(item.upload_url, buffer, meta.content_type);
          log.success(`Uploaded ${meta.filename} for node ${id}. Background re-processing started.`);
        } else {
          log.warn(`Skipped: ${item.status}${item.error ? ` — ${item.error}` : ""}`);
        }
        if (opts.output === "json") console.log(JSON.stringify(item, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });
}
