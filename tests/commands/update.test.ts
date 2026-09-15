/**
 * Command layer: `senso update`.
 *
 * This is the only command that runs another program against the user's machine
 * — `npm install -g` — and the only one whose payload is nothing at all. What is
 * worth protecting is therefore not a rendering:
 *
 *   - it must not shell out when there is nothing to install. An `npm install`
 *     that reinstalls the version already present is a slow no-op at best, and
 *     at worst it runs as root in somebody's CI step for no reason;
 *   - it must exit 5, not 0, when the registry cannot be reached, so a caller
 *     can tell "already current" from "never found out";
 *   - a failed install must exit 1 and say how to finish the job by hand,
 *     because the CLI that would have retried is the one that just failed;
 *   - its progress narration is not payload, so stdout stays empty in plain —
 *     but the outcome is, so `--output json` puts a parseable object there and
 *     leaves stderr alone.
 *
 * `execSync` is mocked here rather than sandboxed: the alternative is a test
 * that installs a package globally. `execFile` is mocked alongside it only
 * because commands/skills.ts promisifies it at module load, and program.ts
 * imports every command.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../setup.js";
import { runCli } from "../helpers.js";
import { version } from "../../src/lib/version.js";

const child = vi.hoisted(() => ({
  execSync: vi.fn<(command: string, options?: unknown) => Buffer>(),
  execFile: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execSync: child.execSync,
  execFile: child.execFile,
}));

/** The package the CLI publishes itself as, and the registry document for it. */
const REGISTRY_URL = "https://registry.npmjs.org/@senso-ai/cli";

/** Comfortably newer than anything this package will ever be. */
const NEWER = "999.99.99";

/**
 * The JSON error object out of stderr.
 *
 * `--output json` implies quiet, so on a JSON run stderr carries the error
 * object and nothing else — the slice is a courtesy, not a workaround.
 */
function jsonErrorFrom(stderr: string): { error: { code: string; hint?: string } } {
  return JSON.parse(stderr.slice(stderr.indexOf("{"))) as {
    error: { code: string; hint?: string };
  };
}

/** Answers the registry with a `dist-tags.latest`, and counts the question. */
let registryHits: number;

function registryReturns(latest: string): void {
  server.use(
    http.get(REGISTRY_URL, () => {
      registryHits += 1;
      return HttpResponse.json({ "dist-tags": { latest } });
    }),
  );
}

function registryFails(respond: () => Response): void {
  server.use(
    http.get(REGISTRY_URL, () => {
      registryHits += 1;
      return respond();
    }),
  );
}

beforeEach(() => {
  registryHits = 0;
  child.execSync.mockReset();
  child.execSync.mockReturnValue(Buffer.from(""));
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("update, when there is nothing to do", () => {
  it("says it is already current and installs nothing", async () => {
    // The branch that matters most for cost: `senso update` on a current
    // install must not shell out to npm at all.
    registryReturns(version);

    const res = await runCli(["update"]);

    expect(res.exitCode).toBe(0);
    expect(child.execSync).not.toHaveBeenCalled();
    expect(res.stderr).toContain("Already on the latest version");
    expect(res.stderr).toContain(version);
  });

  it("keeps stdout empty, because it has no payload to give", async () => {
    // Everything this command prints is progress. A caller piping it gets an
    // empty stream rather than a sentence it would have to filter out.
    registryReturns(version);

    const res = await runCli(["update"]);

    expect(res.stdout).toBe("");
  });

  it("puts the outcome on stdout as JSON and says nothing on stderr", async () => {
    // `--output json` implies quiet, so the two progress sentences are
    // suppressed and `senso update --output json | jq` has one document to
    // read.
    registryReturns(version);

    const res = await runCli(["update", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toMatchObject({
      updated: false,
      current: version,
      latest: version,
    });
    expect(res.stderr).toBe("");
  });

  it("does not treat an older published version as an update", async () => {
    // semver.gt, not inequality: a registry that has rolled back must not send
    // the user backwards.
    registryReturns("0.0.1");

    const res = await runCli(["update"]);

    expect(res.exitCode).toBe(0);
    expect(child.execSync).not.toHaveBeenCalled();
  });
});

describe("update, when the registry has something newer", () => {
  it("runs the global install for the published package", async () => {
    registryReturns(NEWER);

    const res = await runCli(["update"]);

    expect(res.exitCode).toBe(0);
    expect(child.execSync).toHaveBeenCalledTimes(1);
    // The exact command, because a renamed package here silently installs
    // nothing — or, worse, installs something else.
    expect(child.execSync.mock.calls[0]?.[0]).toBe("npm install -g @senso-ai/cli@latest 2>&1");
  });

  it("captures npm's output instead of letting it reach stdout", async () => {
    // npm's log used to be inherited, which put it on stdout and meant
    // `senso update --output json` did not emit one JSON document. It is
    // captured and relayed to stderr instead, where commentary belongs.
    registryReturns(NEWER);

    await runCli(["update"]);

    expect(child.execSync.mock.calls[0]?.[1]).toMatchObject({
      stdio: ["ignore", "pipe", "pipe"],
    });
  });

  it("names the version it moved to, on stderr", async () => {
    registryReturns(NEWER);

    const res = await runCli(["update"]);

    expect(res.stderr).toContain(NEWER);
    expect(res.stderr).toContain("Updated to");
    expect(res.stdout).toBe("");
  });

  it("reports what it moved between on stdout under --output json", async () => {
    registryReturns(NEWER);

    const res = await runCli(["update", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toMatchObject({
      updated: true,
      previous: version,
      latest: NEWER,
    });
    expect(res.stderr).toBe("");
  });
});

describe("update, when the registry cannot be reached", () => {
  it("exits 5 rather than reporting success it never confirmed", async () => {
    // The distinction a script needs: "you are current" and "I could not find
    // out" are different answers, and both used to exit 0.
    registryFails(() => HttpResponse.error());

    const res = await runCli(["update"]);

    expect(registryHits).toBe(1);
    expect(res.exitCode).toBe(5);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Could not check for updates");
    expect(child.execSync).not.toHaveBeenCalled();
  });

  it("exits 5 when the registry answers, but not with a version", async () => {
    // A corporate proxy answering with HTML is the common shape of this.
    registryFails(() => new HttpResponse("<html>login required</html>"));

    const res = await runCli(["update"]);

    expect(res.exitCode).toBe(5);
    expect(child.execSync).not.toHaveBeenCalled();
  });

  it("reports the failure on stderr as JSON under --output json", async () => {
    registryFails(() => new HttpResponse(null, { status: 500 }));

    const res = await runCli(["update", "--output", "json"]);

    expect(res.exitCode).toBe(5);
    expect(res.stdout).toBe("");

    expect(jsonErrorFrom(res.stderr)).toMatchObject({ error: { code: "network" } });
  });
});

describe("update, when the install itself fails", () => {
  it("exits 1 and hands back the command to run by hand", async () => {
    // The CLI that would retry is the one that just failed, so the hint has to
    // be a command the user can paste somewhere else.
    registryReturns(NEWER);
    child.execSync.mockImplementation(() => {
      throw new Error("EACCES: permission denied, mkdir '/usr/local/lib/node_modules'");
    });

    const res = await runCli(["update"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Update failed");
    expect(res.stderr).toContain("npm install -g @senso-ai/cli");
  });

  it("does not claim to have updated", async () => {
    registryReturns(NEWER);
    child.execSync.mockImplementation(() => {
      throw new Error("npm ERR! code EACCES");
    });

    const res = await runCli(["update"]);

    expect(res.stderr).not.toContain("Updated to");
  });

  it("carries the hint into the JSON error payload", async () => {
    registryReturns(NEWER);
    child.execSync.mockImplementation(() => {
      throw new Error("npm ERR! code EACCES");
    });

    const res = await runCli(["update", "--output", "json"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");

    expect(jsonErrorFrom(res.stderr).error.hint).toContain("npm install -g @senso-ai/cli");
  });
});
