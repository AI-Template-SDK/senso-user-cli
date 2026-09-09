import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { Command } from "commander";
import {
  apiRequest,
  handleUploadError,
  isBatchRejection,
  printUploadSummary,
  uploadStatusToReason,
  type UploadResponse,
} from "../lib/api-client.js";
import { parseEnumFlag } from "../lib/enum-arg.js";
import { CliError, EXIT } from "../lib/errors.js";
import { assertFilesExist, assertFilesNotEmpty } from "../lib/file-args.js";
import { parseJsonFlag } from "../lib/json-arg.js";
import { emit, emitConfirmation } from "../lib/output.js";
import { runAction } from "../lib/run-action.js";
import { buildSetTagsBody, buildAttachTagBody } from "../lib/tag-args.js";
import * as log from "../utils/logger.js";

/** The roles a grant can confer. `owner` is reserved and rejected by the API. */
const GRANTABLE_ROLES = ["viewer", "editor"] as const;

/** What an access grant can be for. */
const GRANTEE_TYPES = ["user", "group"] as const;

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

  kb.command("stats")
    .description(
      "Get how many documents and folders the knowledge base holds, as total_files and total_folders (the root folder is not counted). A cheap way to check the size of the KB without paging through 'kb my-files'.",
    )
    .action(
      runAction(program, async (ctx) => {
        const data = await apiRequest({
          path: "/org/kb/stats",
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
    // `--rev`, not the obvious `--version`: the root command owns `-v,
    // --version` for the CLI's own version and Commander answers it wherever it
    // appears, so a `--version` here was intercepted before the action ever ran.
    // The API query parameter is still `version`; only the flag is renamed.
    .option("--rev <n>", "Retrieve a specific stored version of this content, by version number")
    .action(
      runAction(program, async (ctx, id: string, cmdOpts: { rev?: string }) => {
        const data = await apiRequest({
          path: `/org/kb/nodes/${id}/content`,
          params: { version: cmdOpts.rev },
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emit(ctx, data);
      }),
    );

  kb.command("download-url <id>")
    .description("Get a presigned S3 download URL for a KB file node.")
    // `--rev` for the same reason as `kb get-content` above: the root's `-v,
    // --version` shadows a `--version` on any subcommand. The wire parameter is
    // unchanged.
    .option("--rev <n>", "Download a specific stored version of this file, by version number")
    .action(
      runAction(program, async (ctx, id: string, cmdOpts: { rev?: string }) => {
        const data = await apiRequest({
          path: `/org/kb/nodes/${id}/download-url`,
          params: { version: cmdOpts.rev },
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

  kb.command("bulk-delete <nodeIds...>")
    .description(
      "Delete up to 100 KB nodes in one call. Folders take their whole subtree with them. The batch is all-or-nothing: if any node is missing, not permitted, a root, or still ingesting, nothing is deleted. Node IDs come from 'kb my-files', 'kb children' or 'kb find'. This cannot be undone.",
    )
    .action(
      runAction(program, async (ctx, nodeIds: string[]) => {
        // The API caps the batch at 100 and rejects the whole request past it.
        // Saying so here costs nothing and names the number the caller passed.
        if (nodeIds.length > 100) {
          throw new CliError("Maximum 100 nodes per bulk delete.", EXIT.USAGE, {
            code: "usage",
            hint: `You passed ${String(nodeIds.length)}. Split them across several calls.`,
          });
        }
        await apiRequest({
          method: "POST",
          path: "/org/kb/nodes/bulk-delete",
          body: { node_ids: nodeIds },
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emitConfirmation(ctx, `Deleted ${String(nodeIds.length)} node(s).`);
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

        // The same two pre-checks `ingest upload` makes, from the same place:
        // a bad path or an unparseable empty file is the caller's mistake, so it
        // costs a usage error naming the file rather than an ENOENT at exit 1 or
        // an upload the ingestion worker will silently fail to process.
        await assertFilesExist(files);

        const fileData = await Promise.all(files.map(getFileMetadata));
        assertFilesNotEmpty(fileData.map((f) => f.meta));

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
          // Narrowed to the batch-rejection shape, as in `ingest upload`: only
          // that body carries the per-file reasons handleUploadError unpacks.
          // Everything else is rethrown untouched so runAction gives it its real
          // exit code (401 → 3, 404 → 4, unreachable → 5) instead of flattening
          // every upload failure to 1, which is what a script branches on.
          if (isBatchRejection(err)) {
            handleUploadError(err);
            throw new CliError("Upload failed.", EXIT.ERROR, { cause: err });
          }
          throw err;
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

        printUploadSummary(uploaded, failed, items, ctx.quiet);

        // A batch where every file was rejected or every S3 PUT failed used to
        // exit 0: nothing was stored, but a script branching on the exit code saw
        // success and the only signal was English on stderr.
        if (uploaded === 0 && items.length > 0) {
          throw new CliError(`No files were uploaded (${items.length} attempted).`, EXIT.ERROR, {
            hint: "Each file's reason is listed above. Re-run with --output json for the machine-readable detail.",
          });
        }

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
  const permissions = kb
    .command("permissions")
    .description(
      "Manage who can see and edit a knowledge base node. A grant gives one user or group viewer or editor access to a node; owner is assigned by the platform and cannot be granted here. Node IDs come from 'kb my-files', 'kb children' or 'kb find'.",
    );

  permissions
    .command("list <id>")
    .description(
      "List the access grants on a KB node — who holds what role, with the grantee's name and (for users) email. Group grants you cannot see are omitted. This is where the permission ID for 'kb permissions update' and 'kb permissions remove' comes from.",
    )
    .action(
      runAction(program, async (ctx, id: string) => {
        const data = await apiRequest({
          path: `/org/kb/nodes/${id}/permissions`,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emit(ctx, data, { columns: ["id", "role", "grantee", "granted_at"] });
      }),
    );

  permissions
    .command("add <id>")
    .description(
      "Grant a user or group viewer or editor access to a KB node, and return the new grant with its ID. Use 'kb permissions update' to change the role of a grant that already exists. User IDs come from 'users list'; group IDs from 'permissions groups'.",
    )
    .requiredOption("--grantee-type <type>", "Who the grant is for: user | group")
    .requiredOption("--grantee-id <id>", "The user ID or group ID to grant access to")
    .requiredOption("--role <role>", "Access level to grant: viewer | editor")
    .action(
      runAction(
        program,
        async (
          ctx,
          id: string,
          cmdOpts: { granteeType: string; granteeId: string; role: string },
        ) => {
          const granteeType = parseEnumFlag("--grantee-type", cmdOpts.granteeType, GRANTEE_TYPES);
          const role = parseEnumFlag("--role", cmdOpts.role, GRANTABLE_ROLES);
          const data = await apiRequest({
            method: "POST",
            path: `/org/kb/nodes/${id}/permissions`,
            body: { grantee_type: granteeType, grantee_id: cmdOpts.granteeId, role },
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
          });
          if (!ctx.quiet) log.success(`Granted ${String(role)} on node ${id}.`);
          emit(ctx, data);
        },
      ),
    );

  permissions
    .command("update <id> <permissionId>")
    .description(
      "Change an existing grant's role to viewer or editor. You cannot change your own grant. The permission ID comes from 'kb permissions list <id>'.",
    )
    .requiredOption("--role <role>", "The new role: viewer | editor")
    .action(
      runAction(
        program,
        async (ctx, id: string, permissionId: string, cmdOpts: { role: string }) => {
          const role = parseEnumFlag("--role", cmdOpts.role, GRANTABLE_ROLES);
          const data = await apiRequest({
            method: "PATCH",
            path: `/org/kb/nodes/${id}/permissions/${permissionId}`,
            body: { role },
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
          });
          if (!ctx.quiet) log.success(`Grant ${permissionId} is now ${String(role)}.`);
          emit(ctx, data);
        },
      ),
    );

  permissions
    .command("remove <id> <permissionId>")
    .description(
      "Revoke an access grant on a KB node. You cannot revoke your own grant. The permission ID comes from 'kb permissions list <id>'.",
    )
    .action(
      runAction(program, async (ctx, id: string, permissionId: string) => {
        const data = await apiRequest({
          method: "DELETE",
          path: `/org/kb/nodes/${id}/permissions/${permissionId}`,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        // The endpoint answers with a message object rather than a 204, so
        // there is a payload for a JSON caller to read.
        emit(ctx, data);
      }),
    );
}
