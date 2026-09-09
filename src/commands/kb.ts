import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { Command } from "commander";
import {
  apiRequest,
  handleUploadError,
  printUploadSummary,
  uploadStatusToReason,
  type UploadResponse,
} from "../lib/api-client.js";
import { CliError, EXIT } from "../lib/errors.js";
import { parseJsonFlag } from "../lib/json-arg.js";
import { emit, emitConfirmation } from "../lib/output.js";
import { runAction } from "../lib/run-action.js";
import { buildSetTagsBody, buildAttachTagBody } from "../lib/tag-args.js";
import * as log from "../utils/logger.js";

/** The fields worth seeing when a KB endpoint returns `{ nodes: [...] }`. */
const NODE_COLUMNS = ["kb_node_id", "name", "type"];

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
    body: new Uint8Array(buffer),
  });
  if (!res.ok) throw new Error(`S3 upload failed: ${res.status} ${res.statusText}`);
}

export function registerKBCommands(program: Command): void {
  const kb = program
    .command("kb")
    .description(
      "Manage the knowledge base. Browse nodes, upload files, create folders, create raw content, and manage the KB tree.",
    );

  kb.command("root")
    .description("Get the root KB node for the org.")
    .action(
      runAction(program, async (ctx) => {
        const data = await apiRequest({
          path: "/org/kb/root",
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emit(ctx, data);
      }),
    );

  kb.command("my-files")
    .description("List top-level files and folders in the knowledge base.")
    .option("--limit <n>", "Items per page", "50")
    .option("--offset <n>", "Pagination offset", "0")
    .option("--type <type>", "Filter by node type (folder or content)")
    .action(
      runAction(program, async (ctx, cmdOpts: Record<string, string>) => {
        const data = await apiRequest({
          path: "/org/kb/my-files",
          params: { limit: cmdOpts.limit, offset: cmdOpts.offset, type: cmdOpts.type },
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emit(ctx, data, { columns: NODE_COLUMNS });
      }),
    );

  kb.command("find")
    .description("Search KB nodes by name.")
    .requiredOption("--query <q>", "Name search query")
    .option("--limit <n>", "Items per page", "20")
    .option("--offset <n>", "Pagination offset", "0")
    .option("--type <type>", "Filter by node type (folder or content)")
    .action(
      runAction(program, async (ctx, cmdOpts: Record<string, string>) => {
        const data = await apiRequest({
          path: "/org/kb/find",
          params: {
            q: cmdOpts.query,
            limit: cmdOpts.limit,
            offset: cmdOpts.offset,
            type: cmdOpts.type,
          },
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emit(ctx, data, { columns: NODE_COLUMNS });
      }),
    );

  kb.command("sync-status")
    .description("Get the vector sync status for the org's knowledge base.")
    .action(
      runAction(program, async (ctx) => {
        const data = await apiRequest({
          path: "/org/kb/sync-status",
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emit(ctx, data);
      }),
    );

  kb.command("get <id>")
    .description("Get a KB node by ID.")
    .action(
      runAction(program, async (ctx, id: string) => {
        const data = await apiRequest({
          path: `/org/kb/nodes/${id}`,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emit(ctx, data);
      }),
    );

  kb.command("children <id>")
    .description("List children of a KB folder node.")
    .option("--limit <n>", "Items per page", "50")
    .option("--offset <n>", "Pagination offset", "0")
    .option("--type <type>", "Filter by node type (folder or content)")
    .action(
      runAction(program, async (ctx, id: string, cmdOpts: Record<string, string>) => {
        const data = await apiRequest({
          path: `/org/kb/nodes/${id}/children`,
          params: { limit: cmdOpts.limit, offset: cmdOpts.offset, type: cmdOpts.type },
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emit(ctx, data, { columns: NODE_COLUMNS });
      }),
    );

  kb.command("ancestors <id>")
    .description("Get the ancestor chain (breadcrumb) for a KB node.")
    .action(
      runAction(program, async (ctx, id: string) => {
        const data = await apiRequest({
          path: `/org/kb/nodes/${id}/ancestors`,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        // The breadcrumb reads root-first, so the row order is the path itself.
        emit(ctx, data, { columns: NODE_COLUMNS });
      }),
    );

  kb.command("get-content <id>")
    .description("Get the content detail for a KB content node.")
    .option("--version <version>", "Specific version to retrieve")
    .action(
      runAction(program, async (ctx, id: string, cmdOpts: { version?: string }) => {
        const data = await apiRequest({
          path: `/org/kb/nodes/${id}/content`,
          params: { version: cmdOpts.version },
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emit(ctx, data);
      }),
    );

  kb.command("download-url <id>")
    .description("Get a presigned S3 download URL for a KB file node.")
    .option("--version <version>", "Specific version to download")
    .action(
      runAction(program, async (ctx, id: string, cmdOpts: { version?: string }) => {
        const data = await apiRequest({
          path: `/org/kb/nodes/${id}/download-url`,
          params: { version: cmdOpts.version },
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emit(ctx, data);
      }),
    );

  kb.command("create-folder")
    .description("Create a new folder in the knowledge base.")
    .requiredOption("--name <name>", "Folder name")
    .option("--parent-id <id>", "Parent folder node ID (omit to create at root)")
    .action(
      runAction(program, async (ctx, cmdOpts: { name: string; parentId?: string }) => {
        const body: Record<string, unknown> = { name: cmdOpts.name };
        if (cmdOpts.parentId) body.parent_id = cmdOpts.parentId;
        const data = await apiRequest({
          method: "POST",
          path: "/org/kb/folders",
          body,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        if (!ctx.quiet) log.success(`Folder "${cmdOpts.name}" created.`);
        emit(ctx, data);
      }),
    );

  kb.command("rename <id>")
    .description("Rename a KB node.")
    .requiredOption("--name <name>", "New name")
    .action(
      runAction(program, async (ctx, id: string, cmdOpts: { name: string }) => {
        const data = await apiRequest({
          method: "PATCH",
          path: `/org/kb/nodes/${id}/rename`,
          body: { name: cmdOpts.name },
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        if (!ctx.quiet) log.success(`Node ${id} renamed to "${cmdOpts.name}".`);
        emit(ctx, data);
      }),
    );

  kb.command("move <id>")
    .description("Move a KB node to a different parent folder.")
    .requiredOption("--parent-id <parentId>", "Target parent folder node ID")
    .action(
      runAction(program, async (ctx, id: string, cmdOpts: { parentId: string }) => {
        const data = await apiRequest({
          method: "PATCH",
          path: `/org/kb/nodes/${id}/move`,
          body: { new_parent_id: cmdOpts.parentId },
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        if (!ctx.quiet) log.success(`Node ${id} moved.`);
        emit(ctx, data);
      }),
    );

  kb.command("delete <id>")
    .description("Delete a KB node (soft delete).")
    .action(
      runAction(program, async (ctx, id: string) => {
        await apiRequest({
          method: "DELETE",
          path: `/org/kb/nodes/${id}`,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emitConfirmation(ctx, `Node ${id} deleted.`);
      }),
    );

  kb.command("create-raw")
    .description("Create a raw (text/markdown) content item in the knowledge base.")
    .requiredOption(
      "--data <json>",
      'JSON: { "title": "My doc", "text": "# Hello", "kb_folder_node_id": "<uuid>", "tag_ids": ["<uuid>"] }',
    )
    .action(
      runAction(program, async (ctx, cmdOpts: { data: string }) => {
        const body = parseJsonFlag(cmdOpts.data);
        const data = await apiRequest({
          method: "POST",
          path: "/org/kb/raw",
          body,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        if (!ctx.quiet) log.success("Raw content node created.");
        emit(ctx, data);
      }),
    );

  kb.command("update-raw <id>")
    .description("Fully replace the text content of a raw KB node (creates a new version).")
    .requiredOption(
      "--data <json>",
      'JSON: { "title": "Title", "text": "# Updated content", "tag_ids": ["<uuid>"] }',
    )
    .action(
      runAction(program, async (ctx, id: string, cmdOpts: { data: string }) => {
        const body = parseJsonFlag(cmdOpts.data);
        const data = await apiRequest({
          method: "PUT",
          path: `/org/kb/nodes/${id}/raw`,
          body,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        if (!ctx.quiet) log.success(`Node ${id} content replaced.`);
        emit(ctx, data);
      }),
    );

  kb.command("patch-raw <id>")
    .description("Partially update the text content of a raw KB node.")
    .requiredOption(
      "--data <json>",
      'JSON: { "title": "New title", "text": "Updated text", "summary": "...", "tag_ids": ["<uuid>"] }',
    )
    .action(
      runAction(program, async (ctx, id: string, cmdOpts: { data: string }) => {
        const body = parseJsonFlag(cmdOpts.data);
        const data = await apiRequest({
          method: "PATCH",
          path: `/org/kb/nodes/${id}/raw`,
          body,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        if (!ctx.quiet) log.success(`Node ${id} content patched.`);
        emit(ctx, data);
      }),
    );

  kb.command("upload <files...>")
    .description(
      "Upload files to the knowledge base (up to 10). Files are hashed, uploaded to S3, then parsed and embedded by a background worker.",
    )
    .option("--folder-id <id>", "Parent folder node ID to place files in (omit for root)")
    .action(
      runAction(program, async (ctx, files: string[], cmdOpts: { folderId?: string }) => {
        if (files.length > 10) {
          throw new CliError("Maximum 10 files per upload request.", EXIT.USAGE, {
            code: "usage",
            hint: `You passed ${String(files.length)}. Split them across several uploads.`,
          });
        }

        const fileData = await Promise.all(files.map(getFileMetadata));
        const body: Record<string, unknown> = { files: fileData.map((f) => f.meta) };
        if (cmdOpts.folderId) body.kb_folder_node_id = cmdOpts.folderId;

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
          // A rejected upload carries a per-file reason for each file in the
          // error body, and handleUploadError is the only thing that unpacks
          // them. Print those, then rethrow so runAction owns the exit code.
          handleUploadError(err);
          throw new CliError("Upload failed.", EXIT.ERROR, { cause: err });
        }

        // `?? []` despite `results` being declared required: apiRequest casts,
        // it does not validate, so a response omitting the field would throw
        // "not iterable" here rather than report an empty upload.
        const items = response.results ?? [];
        let uploaded = 0;
        const failed: { filename: string; reason: string }[] = [];

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
        // The summary above IS the human rendering of this payload, so `plain`
        // is already served and repeating it on stdout would only be noise.
        // json and table still get the payload, so the flag is honored.
        if (ctx.format !== "plain") {
          emit(ctx, response, { columns: ["filename", "status", "content_id", "error"] });
        }
      }),
    );

  kb.command("update-file <id> <file>")
    .description("Replace the file on an existing KB file node with a new version.")
    .action(
      runAction(program, async (ctx, id: string, file: string) => {
        const { meta, buffer } = await getFileMetadata(file);
        const item = await apiRequest<{
          status: string;
          upload_url?: string;
          error?: string;
          content_id?: string;
          ingestion_run_id?: string;
        }>({
          method: "PUT",
          path: `/org/kb/nodes/${id}/file`,
          body: { file: meta },
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        if (item.status === "upload_pending" && item.upload_url) {
          await uploadToS3(item.upload_url, buffer, meta.content_type);
          if (!ctx.quiet) {
            log.success(
              `Uploaded ${meta.filename} for node ${id}. Background re-processing started.`,
            );
          }
        } else {
          // Not an error: the API declined this version (duplicate, conflict,
          // unsupported type) and the payload below says which.
          if (!ctx.quiet)
            log.warn(`Skipped: ${item.status}${item.error ? ` — ${item.error}` : ""}`);
        }
        emit(ctx, item);
      }),
    );

  const tags = kb
    .command("tags")
    .description(
      "Manage tags attached to a KB node. KB content is auto-tagged on creation (raw content on create, uploaded files once ingestion finishes) — use these commands to override, add, or remove tags afterwards. Tags can only be applied to content nodes, not folders. Names are resolved against the org's tag library; unknown names are created.",
    );

  tags
    .command("list <id>")
    .description("List tags attached to a KB node.")
    .action(
      runAction(program, async (ctx, id: string) => {
        const data = await apiRequest({
          path: `/org/kb/nodes/${id}/tags`,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emit(ctx, data, { columns: ["tag_id", "name", "created_at"] });
      }),
    );

  tags
    .command("set <id>")
    .description(
      "Replace the KB node's full tag collection. Provide --names (comma-separated) and/or --ids. Unknown names are created.",
    )
    .option("--names <list>", "Comma-separated tag names (created if missing)")
    .option("--ids <list>", "Comma-separated existing tag UUIDs")
    .action(
      runAction(program, async (ctx, id: string, cmdOpts: { names?: string; ids?: string }) => {
        const body = buildSetTagsBody(cmdOpts);
        const data = await apiRequest({
          method: "PUT",
          path: `/org/kb/nodes/${id}/tags`,
          body,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        if (!ctx.quiet) log.success(`KB node ${id} tags updated.`);
        emit(ctx, data, { columns: ["tag_id", "name", "created_at"] });
      }),
    );

  tags
    .command("add <id>")
    .description("Attach a single tag by --name (created if missing) or --id.")
    .option("--name <name>", "Tag name (created if missing)")
    .option("--id <tagId>", "Existing tag UUID")
    .action(
      runAction(program, async (ctx, id: string, cmdOpts: { name?: string; id?: string }) => {
        const body = buildAttachTagBody(cmdOpts);
        if (!body) {
          throw new CliError("Provide --name or --id.", EXIT.USAGE, {
            code: "usage",
            hint: "--name creates the tag if it does not exist; --id takes an existing tag UUID.",
          });
        }
        await apiRequest({
          method: "POST",
          path: `/org/kb/nodes/${id}/tags`,
          body,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emitConfirmation(ctx, `Tag attached to KB node ${id}.`);
      }),
    );

  tags
    .command("remove <id>")
    .description("Detach a single tag by --name or --id. Idempotent.")
    .option("--name <name>", "Tag name to detach")
    .option("--id <tagId>", "Existing tag UUID to detach")
    .action(
      runAction(program, async (ctx, id: string, cmdOpts: { name?: string; id?: string }) => {
        if (!cmdOpts.name && !cmdOpts.id) {
          throw new CliError("Provide --name or --id.", EXIT.USAGE, {
            code: "usage",
            hint: "Pass the tag UUID with --id, or the tag name with --name.",
          });
        }
        if (cmdOpts.id) {
          await apiRequest({
            method: "DELETE",
            path: `/org/kb/nodes/${id}/tags/${cmdOpts.id}`,
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
          });
        } else if (cmdOpts.name) {
          await apiRequest({
            method: "DELETE",
            path: `/org/kb/nodes/${id}/tags`,
            params: { name: cmdOpts.name },
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
          });
        }
        emitConfirmation(ctx, `Tag detached from KB node ${id}.`);
      }),
    );
}
