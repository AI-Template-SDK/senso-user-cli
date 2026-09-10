import * as p from "@clack/prompts";
import pc from "picocolors";
import { apiRequest, ApiError } from "./api-client.js";
import { CliError, EXIT } from "./errors.js";
import * as log from "../utils/logger.js";

/**
 * Thrown when the user cancels the picker with Ctrl-C or Escape.
 *
 * Canceling is not a failure, but the picker is several frames deep in an
 * interactive loop and cannot simply return "no folder" — its caller has files
 * to upload and nowhere to put them. The caller catches this and returns
 * cleanly, so the process exits 0 with no error printed.
 */
export class PickerCanceled extends Error {
  constructor() {
    super("Folder selection canceled.");
    this.name = "PickerCanceled";
  }
}

interface KBNode {
  kb_node_id: string;
  name: string;
  type: string;
}

interface KBNodeListResponse {
  nodes: KBNode[];
  total: number;
  limit: number;
  offset: number;
}

interface FolderPickerOptions {
  apiKey?: string;
  baseUrl?: string;
}

interface FolderPickerResult {
  folderId: string;
  folderName: string;
}

const PAGE_SIZE = 50;

async function fetchFolders(
  parentId: string | null,
  offset: number,
  opts: FolderPickerOptions,
): Promise<KBNodeListResponse> {
  if (parentId) {
    return apiRequest<KBNodeListResponse>({
      path: `/org/kb/nodes/${parentId}/children`,
      params: { type: "folder", limit: PAGE_SIZE, offset },
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl,
    });
  }
  return apiRequest<KBNodeListResponse>({
    path: "/org/kb/my-files",
    params: { type: "folder", limit: PAGE_SIZE, offset },
    apiKey: opts.apiKey,
    baseUrl: opts.baseUrl,
  });
}

async function createFolder(
  name: string,
  parentId: string | null,
  opts: FolderPickerOptions,
): Promise<FolderPickerResult> {
  const body: Record<string, unknown> = { name };
  if (parentId) body.parent_id = parentId;

  try {
    const data = await apiRequest<{ kb_node_id: string; name: string }>({
      method: "POST",
      path: "/org/kb/folders",
      body,
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl,
    });
    log.success(`Folder "${name}" created.`);
    return { folderId: data.kb_node_id, folderName: name };
  } catch (err) {
    // Re-raised with the hint that actually resolves it: at the root, this is
    // almost always a key without folder-creation scope rather than a wrong id.
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
      throw new CliError("Not allowed to create a folder here.", EXIT.AUTH, {
        code: err.status === 401 ? "unauthorized" : "forbidden",
        status: err.status,
        hint: "Ask an org admin to confirm this key has scope to create under the organization's root folder.",
        cause: err,
      });
    }
    throw err;
  }
}

async function promptCreateFolder(
  parentId: string | null,
  opts: FolderPickerOptions,
): Promise<FolderPickerResult> {
  const name = await p.text({
    message: "Enter a name for your new folder:",
    validate: (val) => {
      if (!val || val.trim().length === 0) return "Folder name is required";
    },
  });

  if (p.isCancel(name)) {
    p.cancel("Upload canceled.");
    throw new PickerCanceled();
  }

  return createFolder((name as string).trim(), parentId, opts);
}

export async function pickFolder(opts: FolderPickerOptions): Promise<FolderPickerResult> {
  // The folders drilled into, deepest last. `.at(-1)` returning undefined *is*
  // the "we are at the root" case, so every read goes through this one accessor
  // rather than indexing by length-1 and assuming a hit.
  const navigationStack: { id: string; name: string }[] = [];
  const currentFolder = (): { id: string; name: string } | undefined => navigationStack.at(-1);
  let currentParentId: string | null = null;
  let currentOffset = 0;
  let loadedFolders: KBNode[] = [];
  let totalCount = 0;
  let needsFetch = true;

  // The loop exits by returning a folder or by throwing PickerCanceled; there is
  // no condition to test at the top, hence `for (;;)` rather than `while (true)`.
  for (;;) {
    if (needsFetch) {
      const spin = p.spinner();
      spin.start("Loading folders...");
      try {
        const response = await fetchFolders(currentParentId, currentOffset, opts);
        if (currentOffset === 0) {
          loadedFolders = response.nodes;
        } else {
          loadedFolders = [...loadedFolders, ...response.nodes];
        }
        totalCount = response.total;
        spin.stop(
          `${loadedFolders.length} folder(s) loaded${loadedFolders.length < totalCount ? ` of ${totalCount}` : ""}`,
        );
        needsFetch = false;

        // Empty state at root
        if (loadedFolders.length === 0 && currentParentId === null) {
          log.info("No folders found. Let's create one.");
          return await promptCreateFolder(null, opts);
        }
      } catch (err) {
        // Stop the spinner before rethrowing: an abandoned spinner leaves the
        // terminal with a spinning frame and a hidden cursor.
        spin.stop("Failed to load folders");
        throw err;
      }
    }

    // Build breadcrumb
    const breadcrumb =
      navigationStack.length === 0
        ? "My Files"
        : "My Files > " + navigationStack.map((s) => s.name).join(" > ");

    const currentFolderName = currentFolder()?.name ?? null;

    // Location and keyboard hints, on stderr like every other prompt: the picker
    // is interactive chrome, and the command that opened it also prints an
    // upload summary — the two must not interleave on stdout.
    log.raw("");
    log.raw(`  ${pc.bold("Location:")} ${breadcrumb}`);
    log.raw("");
    if (currentFolderName) {
      log.dim("Use arrow keys to navigate, Enter to select.");
      log.dim("Pick a folder to open it, or choose an action below the list.");
    } else {
      log.dim("Use arrow keys to navigate, Enter to select a folder to open it.");
    }
    log.raw("");

    // Build select options — folders only
    const options: { value: string; label: string }[] = [];

    for (const folder of loadedFolders) {
      options.push({ value: folder.kb_node_id, label: `📁 ${folder.name}` });
    }

    if (loadedFolders.length < totalCount) {
      options.push({ value: "__LOAD_MORE__", label: pc.dim("Load more...") });
    }

    if (currentFolderName) {
      options.push({
        value: "__SELECT_CURRENT__",
        label: pc.green(`✓ Select "${currentFolderName}"`),
      });
      options.push({ value: "__BACK__", label: pc.dim("← Go back") });
    }
    options.push({
      value: "__NEW_FOLDER__",
      label: pc.cyan("+ Create new folder here"),
    });

    const choice = await p.select({
      message: "Choose a folder or action:",
      options,
    });

    if (p.isCancel(choice)) {
      p.cancel("Upload canceled.");
      throw new PickerCanceled();
    }

    const selected = choice as string;

    if (selected === "__BACK__") {
      navigationStack.pop();
      currentParentId = currentFolder()?.id ?? null;
      currentOffset = 0;
      loadedFolders = [];
      needsFetch = true;
      continue;
    }

    if (selected === "__LOAD_MORE__") {
      currentOffset += PAGE_SIZE;
      needsFetch = true;
      continue;
    }

    if (selected === "__SELECT_CURRENT__") {
      // Only offered when there is a folder to select, but read defensively:
      // the option list and the stack are built in separate passes.
      const current = currentFolder();
      if (current) {
        return { folderId: current.id, folderName: current.name };
      }
      continue;
    }

    if (selected === "__NEW_FOLDER__") {
      return promptCreateFolder(currentParentId, opts);
    }

    // Drill into selected folder
    const folder = loadedFolders.find((f) => f.kb_node_id === selected);
    if (folder) {
      navigationStack.push({ id: folder.kb_node_id, name: folder.name });
      currentParentId = folder.kb_node_id;
      currentOffset = 0;
      loadedFolders = [];
      needsFetch = true;
    }
  }
}
