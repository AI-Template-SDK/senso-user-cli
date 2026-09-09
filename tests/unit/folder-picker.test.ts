/**
 * The interactive folder picker, driven without a terminal.
 *
 * `senso ingest upload` with no `--folder-id` opens this picker, and it is the
 * only place in the CLI where a loop of prompts drives a sequence of requests.
 * What is worth protecting is the navigation state, because every mistake in it
 * is silent: drilling into a folder must fetch *that* node's children, going
 * back must return to the parent and re-fetch rather than reuse the page it
 * already had, and "load more" must advance the offset instead of re-requesting
 * page one forever. A wrong id here does not fail — it uploads the user's files
 * into the wrong folder.
 *
 * The other half is the two exits that are not a folder: cancelling, which is a
 * clean exit rather than an error, and the 403 on folder creation, which is
 * re-raised with the hint that actually resolves it (a key without scope) rather
 * than as a bare API error about a parent id.
 *
 * @clack/prompts is mocked because it owns a real terminal: `select()` and
 * `text()` return scripted answers, and `spinner()` is inert — the real one
 * writes frames and cursor escapes to stdout, which would land in the payload.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server, TEST_API_KEY, TEST_BASE_URL } from "../setup.js";
import { apiUrl } from "../helpers.js";
import { pickFolder, PickerCanceled } from "../../src/lib/folder-picker.js";
import { CliError, EXIT } from "../../src/lib/errors.js";

/**
 * The scripted terminal.
 *
 * Answers are queues: each `select()` or `text()` shifts the next one, and
 * running out is an error rather than a hang, so a test that asserts the wrong
 * number of prompts says so instead of timing out.
 */
const clack = vi.hoisted(() => ({
  /** Stands in for clack's cancel symbol; `isCancel` recognizes only this. */
  CANCEL: Symbol("clack:cancel"),
  selectAnswers: [] as unknown[],
  textAnswers: [] as unknown[],
  /** Every option list the picker offered, in order. */
  selectCalls: [] as { message: string; values: string[] }[],
  textCalls: [] as { message: string; validate?: (v: string | undefined) => string | undefined }[],
  /** What each spinner was stopped with. An unstopped spinner is a hung terminal. */
  spinnerStops: [] as string[],
  canceled: [] as string[],
}));

vi.mock("@clack/prompts", () => ({
  spinner: () => ({
    start: () => undefined,
    stop: (msg?: string) => clack.spinnerStops.push(msg ?? ""),
    message: () => undefined,
  }),
  select: (opts: { message: string; options: { value: string; label: string }[] }) => {
    clack.selectCalls.push({ message: opts.message, values: opts.options.map((o) => o.value) });
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

const OPTS = { apiKey: TEST_API_KEY, baseUrl: TEST_BASE_URL };

/** The picker prints its breadcrumb and hints through utils/logger, on stderr. */
let stderr: string[];

beforeEach(() => {
  clack.selectAnswers = [];
  clack.textAnswers = [];
  clack.selectCalls = [];
  clack.textCalls = [];
  clack.spinnerStops = [];
  clack.canceled = [];
  stderr = [];
  vi.spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
    stderr.push(parts.map(String).join(" "));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A folder node as the KB list endpoints return one. */
function folder(id: string, name: string) {
  return { kb_node_id: id, name, type: "folder" };
}

/**
 * Records every request the picker makes, and serves the queued pages.
 *
 * `myFiles` answers the root listing and `children` answers every drill-in, each
 * shifting its next queued response so a test can make the second page differ
 * from the first.
 */
function serveFolders(pages: {
  myFiles?: { nodes: ReturnType<typeof folder>[]; total: number }[];
  children?: { nodes: ReturnType<typeof folder>[]; total: number }[];
}): Request[] {
  const seen: Request[] = [];
  const myFiles = [...(pages.myFiles ?? [])];
  const children = [...(pages.children ?? [])];

  server.use(
    http.get(apiUrl("/org/kb/my-files"), ({ request }) => {
      seen.push(request);
      const page = myFiles.shift() ?? { nodes: [], total: 0 };
      return HttpResponse.json({ ...page, limit: 50, offset: 0 });
    }),
    http.get(apiUrl("/org/kb/nodes/:nodeId/children"), ({ request }) => {
      seen.push(request);
      const page = children.shift() ?? { nodes: [], total: 0 };
      return HttpResponse.json({ ...page, limit: 50, offset: 0 });
    }),
  );

  return seen;
}

describe("pickFolder, navigating the tree", () => {
  it("lists the org root through my-files, not through a node's children", async () => {
    const seen = serveFolders({
      myFiles: [{ nodes: [folder("f-docs", "Docs")], total: 1 }],
      children: [{ nodes: [], total: 0 }],
    });
    clack.selectAnswers = ["f-docs", "__SELECT_CURRENT__"];

    await pickFolder(OPTS);

    const first = new URL(seen[0]!.url);
    expect(first.pathname).toBe("/api/v1/org/kb/my-files");
    // Folders only, and the page size the picker pages by.
    expect(first.searchParams.get("type")).toBe("folder");
    expect(first.searchParams.get("limit")).toBe("50");
    expect(first.searchParams.get("offset")).toBe("0");
  });

  it("requests the children of the folder that was opened", async () => {
    const seen = serveFolders({
      myFiles: [{ nodes: [folder("f-docs", "Docs"), folder("f-legal", "Legal")], total: 2 }],
      children: [{ nodes: [], total: 0 }],
    });
    clack.selectAnswers = ["f-legal", "__SELECT_CURRENT__"];

    await pickFolder(OPTS);

    // The id in the path is the folder that was chosen, not the first one shown.
    expect(new URL(seen[1]!.url).pathname).toBe("/api/v1/org/kb/nodes/f-legal/children");
    expect(new URL(seen[1]!.url).searchParams.get("type")).toBe("folder");
  });

  it("returns the id and the name of the folder the user selects", async () => {
    serveFolders({
      myFiles: [{ nodes: [folder("f-docs", "Docs")], total: 1 }],
      children: [{ nodes: [], total: 0 }],
    });
    clack.selectAnswers = ["f-docs", "__SELECT_CURRENT__"];

    const picked = await pickFolder(OPTS);

    expect(picked).toEqual({ folderId: "f-docs", folderName: "Docs" });
  });

  it("offers 'select this folder' and 'go back' only once inside a folder", async () => {
    serveFolders({
      myFiles: [{ nodes: [folder("f-docs", "Docs")], total: 1 }],
      children: [{ nodes: [], total: 0 }],
    });
    clack.selectAnswers = ["f-docs", "__SELECT_CURRENT__"];

    await pickFolder(OPTS);

    // At the root there is nothing to select or to go back to; one level down
    // there is. Offering either at the root would return an undefined folder id.
    expect(clack.selectCalls[0]!.values).toEqual(["f-docs", "__NEW_FOLDER__"]);
    expect(clack.selectCalls[1]!.values).toEqual([
      "__SELECT_CURRENT__",
      "__BACK__",
      "__NEW_FOLDER__",
    ]);
  });

  it("goes back to the parent and re-fetches it rather than reusing the old page", async () => {
    const seen = serveFolders({
      myFiles: [
        { nodes: [folder("f-docs", "Docs"), folder("f-legal", "Legal")], total: 2 },
        { nodes: [folder("f-docs", "Docs"), folder("f-legal", "Legal")], total: 2 },
      ],
      children: [
        { nodes: [], total: 0 },
        { nodes: [], total: 0 },
      ],
    });
    clack.selectAnswers = ["f-docs", "__BACK__", "f-legal", "__SELECT_CURRENT__"];

    const picked = await pickFolder(OPTS);

    // my-files, children/f-docs, my-files again, children/f-legal. The second
    // root listing is the point: the picker drops what it loaded on the way in,
    // so a folder created or renamed meanwhile is visible on the way back.
    expect(seen.map((r) => new URL(r.url).pathname)).toEqual([
      "/api/v1/org/kb/my-files",
      "/api/v1/org/kb/nodes/f-docs/children",
      "/api/v1/org/kb/my-files",
      "/api/v1/org/kb/nodes/f-legal/children",
    ]);
    expect(picked.folderId).toBe("f-legal");
  });

  it("advances the offset by a page when the user loads more", async () => {
    const seen = serveFolders({
      myFiles: [
        { nodes: [folder("f-1", "One")], total: 60 },
        { nodes: [folder("f-2", "Two")], total: 60 },
      ],
      children: [{ nodes: [], total: 0 }],
    });
    clack.selectAnswers = ["__LOAD_MORE__", "f-2", "__SELECT_CURRENT__"];

    const picked = await pickFolder(OPTS);

    expect(new URL(seen[0]!.url).searchParams.get("offset")).toBe("0");
    expect(new URL(seen[1]!.url).searchParams.get("offset")).toBe("50");
    // Both pages are selectable afterwards: the second response is appended to
    // the list, not substituted for it.
    expect(clack.selectCalls[1]!.values).toEqual(["f-1", "f-2", "__LOAD_MORE__", "__NEW_FOLDER__"]);
    expect(picked.folderId).toBe("f-2");
  });

  it("offers 'load more' only while there are folders left to load", async () => {
    serveFolders({
      myFiles: [{ nodes: [folder("f-1", "One")], total: 1 }],
      children: [{ nodes: [], total: 0 }],
    });
    clack.selectAnswers = ["f-1", "__SELECT_CURRENT__"];

    await pickFolder(OPTS);

    expect(clack.selectCalls[0]!.values).not.toContain("__LOAD_MORE__");
  });
});

describe("pickFolder, when there is nowhere to put the files yet", () => {
  it("offers to create a folder instead of showing an empty list at the root", async () => {
    let body: unknown;
    serveFolders({ myFiles: [{ nodes: [], total: 0 }] });
    server.use(
      http.post(apiUrl("/org/kb/folders"), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ kb_node_id: "f-new", name: "Research" });
      }),
    );
    clack.textAnswers = ["  Research  "];

    const picked = await pickFolder(OPTS);

    // No list to choose from, so the picker never asks — it goes straight to the
    // name prompt. An empty select would be a dead end.
    expect(clack.selectCalls).toHaveLength(0);
    expect(body).toEqual({ name: "Research" });
    expect(picked).toEqual({ folderId: "f-new", folderName: "Research" });
  });

  it("creates inside the folder being browsed, passing it as parent_id", async () => {
    let body: unknown;
    serveFolders({
      myFiles: [{ nodes: [folder("f-docs", "Docs")], total: 1 }],
      children: [{ nodes: [], total: 0 }],
    });
    server.use(
      http.post(apiUrl("/org/kb/folders"), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ kb_node_id: "f-child", name: "Q3" });
      }),
    );
    clack.selectAnswers = ["f-docs", "__NEW_FOLDER__"];
    clack.textAnswers = ["Q3"];

    const picked = await pickFolder(OPTS);

    expect(body).toEqual({ name: "Q3", parent_id: "f-docs" });
    expect(picked).toEqual({ folderId: "f-child", folderName: "Q3" });
  });

  it("omits parent_id entirely when creating at the root", async () => {
    let body: Record<string, unknown> | undefined;
    serveFolders({ myFiles: [{ nodes: [folder("f-docs", "Docs")], total: 1 }] });
    server.use(
      http.post(apiUrl("/org/kb/folders"), async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ kb_node_id: "f-new", name: "Inbox" });
      }),
    );
    clack.selectAnswers = ["__NEW_FOLDER__"];
    clack.textAnswers = ["Inbox"];

    await pickFolder(OPTS);

    // Not `parent_id: null` — the API reads an absent key as "the org root".
    expect(body).not.toHaveProperty("parent_id");
  });

  it("refuses an empty folder name before anything is sent", async () => {
    serveFolders({ myFiles: [{ nodes: [], total: 0 }] });
    server.use(
      http.post(apiUrl("/org/kb/folders"), () =>
        HttpResponse.json({ kb_node_id: "f-new", name: "x" }),
      ),
    );
    clack.textAnswers = ["x"];

    await pickFolder(OPTS);

    // The prompt's own validator, exercised directly: clack re-prompts on a
    // returned string rather than submitting it.
    const { validate } = clack.textCalls[0]!;
    expect(validate?.("")).toMatch(/required/i);
    expect(validate?.("   ")).toMatch(/required/i);
    expect(validate?.("Research")).toBeUndefined();
  });
});

describe("pickFolder, when the user gives up", () => {
  it("throws PickerCanceled when the folder list is escaped", async () => {
    serveFolders({ myFiles: [{ nodes: [folder("f-docs", "Docs")], total: 1 }] });
    clack.selectAnswers = [clack.CANCEL];

    // Not a CliError: cancelling is not a failure, and the caller turns this
    // into a clean exit 0 with nothing on stderr.
    await expect(pickFolder(OPTS)).rejects.toBeInstanceOf(PickerCanceled);
    expect(clack.canceled).toContain("Upload canceled.");
  });

  it("throws PickerCanceled when the new-folder name prompt is escaped", async () => {
    serveFolders({ myFiles: [{ nodes: [], total: 0 }] });
    clack.textAnswers = [clack.CANCEL];

    await expect(pickFolder(OPTS)).rejects.toBeInstanceOf(PickerCanceled);
  });
});

describe("pickFolder, when the API refuses", () => {
  it("turns a 403 on folder creation into an auth failure naming the scope", async () => {
    serveFolders({ myFiles: [{ nodes: [], total: 0 }] });
    server.use(
      http.post(apiUrl("/org/kb/folders"), () =>
        HttpResponse.json({ error: "insufficient scope" }, { status: 403 }),
      ),
    );
    clack.textAnswers = ["Research"];

    const err = await pickFolder(OPTS).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CliError);
    const cliError = err as CliError;
    expect(cliError.exitCode).toBe(EXIT.AUTH);
    expect(cliError.code).toBe("forbidden");
    expect(cliError.status).toBe(403);
    // The hint is the whole point of catching this: at the root a 403 is a key
    // without scope, not a wrong parent id, and the user cannot fix it alone.
    expect(cliError.hint).toContain("org admin");
  });

  it("reports a 401 on folder creation as unauthorized, with the same hint", async () => {
    serveFolders({ myFiles: [{ nodes: [], total: 0 }] });
    server.use(http.post(apiUrl("/org/kb/folders"), () => new HttpResponse(null, { status: 401 })));
    clack.textAnswers = ["Research"];

    const err = (await pickFolder(OPTS).catch((e: unknown) => e)) as CliError;

    expect(err).toBeInstanceOf(CliError);
    expect(err.code).toBe("unauthorized");
    expect(err.exitCode).toBe(EXIT.AUTH);
  });

  it("passes any other creation failure through untouched, so runAction maps it", async () => {
    serveFolders({ myFiles: [{ nodes: [], total: 0 }] });
    server.use(http.post(apiUrl("/org/kb/folders"), () => new HttpResponse(null, { status: 409 })));
    clack.textAnswers = ["Research"];

    const err = (await pickFolder(OPTS).catch((e: unknown) => e)) as Error;

    // Deliberately not a CliError: only 401/403 carry a hint worth adding here.
    expect(err).not.toBeInstanceOf(CliError);
    expect(err.name).toBe("ApiError");
  });

  it("stops the spinner before letting a listing failure propagate", async () => {
    server.use(http.get(apiUrl("/org/kb/my-files"), () => new HttpResponse(null, { status: 500 })));

    await expect(pickFolder(OPTS)).rejects.toThrow();

    // An abandoned spinner leaves the terminal with a hidden cursor and a frame
    // spinning over the error message.
    expect(clack.spinnerStops).toContain("Failed to load folders");
  });
});

describe("pickFolder, what it prints", () => {
  it("puts the breadcrumb and the keyboard hints on stderr, never on stdout", async () => {
    serveFolders({
      myFiles: [{ nodes: [folder("f-docs", "Docs")], total: 1 }],
      children: [{ nodes: [], total: 0 }],
    });
    clack.selectAnswers = ["f-docs", "__SELECT_CURRENT__"];

    await pickFolder(OPTS);

    const printed = stderr.join("\n");
    expect(printed).toContain("My Files");
    // The breadcrumb deepens as the user drills in, so the location is never
    // ambiguous when several folders share a name.
    expect(printed).toContain("My Files > Docs");
  });
});
