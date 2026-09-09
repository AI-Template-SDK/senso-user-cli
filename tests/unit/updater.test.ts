/**
 * The background update check — the one piece of the CLI that talks to a host
 * that is not the Senso API, writes to the credential file, and runs without
 * anybody asking it to.
 *
 * Four things are worth protecting, in descending order of how much damage
 * getting them wrong does:
 *
 *   1. It must not clobber the config. It reads the file early, awaits the
 *      network, and writes late — so a naive "read, mutate, write back" would
 *      erase an API key that `senso login` stored in between. The merge is what
 *      makes it safe, and the apiKey-survives test below is the regression that
 *      matters most in this file.
 *   2. It must be silenceable and cheap. SENSO_NO_UPDATE_CHECK=1 and `--quiet`
 *      mean no request at all, and the 24-hour gate means at most one request a
 *      day — this is fired without being awaited, so every request it makes is
 *      delay between a command printing and the process exiting.
 *   3. It must fail silently. A registry outage, a proxy returning HTML, a
 *      response with no dist-tags: none of them may surface as an error next to
 *      a command that otherwise succeeded.
 *   4. The notice goes to stderr. It is decoration, and stdout belongs to the
 *      payload — a box drawn across a `--output json` pipe breaks every caller.
 *
 * config.ts resolves SENSO_CONFIG_DIR once at module load, so every test here
 * resets the module registry and re-imports both modules against a fresh
 * directory, the way tests/unit/config.test.ts does.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { server } from "../setup.js";

/** The only URL this module is allowed to touch. Mocked, never reached. */
const REGISTRY_URL = "https://registry.npmjs.org/@senso-ai/cli";

/** Comfortably newer than anything this package will ever be. */
const NEWER = "999.99.99";

const A_DAY = 24 * 60 * 60 * 1000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

let dir: string;
let registryHits: number;
let stdout: string[];
let stderr: string[];

/** A fresh updater bound to a fresh config module, both pointed at `dir`. */
async function loadUpdater() {
  vi.resetModules();
  process.env.SENSO_CONFIG_DIR = dir;

  const { checkForUpdate } = await import("../../src/utils/updater.js");
  const { readConfig, writeConfig } = await import("../../src/lib/config.js");
  const { version } = await import("../../src/lib/version.js");

  return { checkForUpdate, readConfig, writeConfig, version };
}

/** Answers the registry, and counts the fact that it was asked. */
function mockRegistry(respond: () => Response): void {
  server.use(
    http.get(REGISTRY_URL, () => {
      registryHits += 1;
      return respond();
    }),
  );
}

const registryReturns = (latest: string) => {
  mockRegistry(() => HttpResponse.json({ "dist-tags": { latest } }));
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "senso-updater-"));
  registryHits = 0;
  stdout = [];
  stderr = [];

  // The suite sets this for every other test. These tests are the ones that
  // exercise the checker, so they opt back in and set it deliberately.
  delete process.env.SENSO_NO_UPDATE_CHECK;

  vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
    stdout.push(parts.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
    stderr.push(parts.map(String).join(" "));
  });
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  rmSync(dir, { recursive: true, force: true });
  process.env.SENSO_NO_UPDATE_CHECK = "1";
});

describe("the ways to turn the check off", () => {
  it("does nothing when SENSO_NO_UPDATE_CHECK is set", async () => {
    process.env.SENSO_NO_UPDATE_CHECK = "1";
    registryReturns(NEWER);
    const { checkForUpdate, writeConfig } = await loadUpdater();
    // Cached and newer, so the only reason nothing is printed is the opt-out.
    writeConfig({ latestVersion: NEWER, lastUpdateCheck: iso(0) });

    await checkForUpdate(false);

    // The suite's network ban is the belt; this is the braces. Neither the
    // request nor the cached notice may happen.
    expect(registryHits).toBe(0);
    expect(stderr.join("\n")).toBe("");
    expect(stdout.join("\n")).toBe("");
  });

  it("does nothing when the caller asked for quiet", async () => {
    // `--quiet` and `--output json` both arrive here as this argument. A box
    // drawn next to machine-readable output is noise an agent has to be told
    // to ignore.
    registryReturns(NEWER);
    const { checkForUpdate, writeConfig } = await loadUpdater();
    writeConfig({ latestVersion: NEWER, lastUpdateCheck: iso(0) });

    await checkForUpdate(true);

    expect(registryHits).toBe(0);
    expect(stderr.join("\n")).toBe("");
    expect(stdout.join("\n")).toBe("");
  });

  it("does not record a check it never made", async () => {
    process.env.SENSO_NO_UPDATE_CHECK = "1";
    const { checkForUpdate, readConfig } = await loadUpdater();

    await checkForUpdate(false);

    expect(readConfig()).toEqual({});
  });
});

describe("within a day of the last check", () => {
  it("does not ask the registry again", async () => {
    // The gate that keeps this at one request a day. Without it every command
    // invocation pays for a network round trip before the process can exit.
    registryReturns(NEWER);
    const { checkForUpdate, writeConfig } = await loadUpdater();
    writeConfig({ lastUpdateCheck: iso(A_DAY - 60_000) });

    await checkForUpdate(false);

    expect(registryHits).toBe(0);
  });

  it("still shows the notice when the cached version is newer", async () => {
    // Cheap and offline: the whole point of storing latestVersion is that the
    // notice keeps appearing on the other 23 hours' worth of invocations.
    registryReturns(NEWER);
    const { checkForUpdate, writeConfig, version } = await loadUpdater();
    writeConfig({ lastUpdateCheck: iso(60_000), latestVersion: NEWER });

    await checkForUpdate(false);

    expect(registryHits).toBe(0);
    expect(stderr.join("\n")).toContain("Update available");
    expect(stderr.join("\n")).toContain(NEWER);
    expect(stderr.join("\n")).toContain(version);
  });

  it("stays quiet when the cached version is the one already installed", async () => {
    const { checkForUpdate, writeConfig, version } = await loadUpdater();
    writeConfig({ lastUpdateCheck: iso(60_000), latestVersion: version });

    await checkForUpdate(false);

    expect(stderr.join("\n")).toBe("");
  });

  it("stays quiet when nothing was cached at all", async () => {
    // A check that ran and found nothing newer stores only the timestamp on
    // some paths; reading an absent latestVersion must not throw in semver.
    const { checkForUpdate, writeConfig } = await loadUpdater();
    writeConfig({ lastUpdateCheck: iso(60_000) });

    await checkForUpdate(false);

    expect(stderr.join("\n")).toBe("");
  });
});

describe("once the last check is a day old", () => {
  it("asks the registry", async () => {
    registryReturns(NEWER);
    const { checkForUpdate, writeConfig } = await loadUpdater();
    writeConfig({ lastUpdateCheck: iso(A_DAY + 60_000) });

    await checkForUpdate(false);

    expect(registryHits).toBe(1);
  });

  it("asks the registry on a first run, when nothing was ever stored", async () => {
    registryReturns(NEWER);
    const { checkForUpdate } = await loadUpdater();

    await checkForUpdate(false);

    expect(registryHits).toBe(1);
  });

  it("stores both the timestamp and the version it found", async () => {
    // Both, not one: the timestamp alone would re-query tomorrow with nothing
    // to show in between, and the version alone would re-query every run.
    registryReturns(NEWER);
    const { checkForUpdate, readConfig } = await loadUpdater();

    await checkForUpdate(false);

    const config = readConfig();
    expect(config.latestVersion).toBe(NEWER);
    expect(config.lastUpdateCheck).toBeTypeOf("string");
    expect(Date.now() - new Date(config.lastUpdateCheck!).getTime()).toBeLessThan(A_DAY);
  });

  it("shows the notice when the registry has something newer", async () => {
    registryReturns(NEWER);
    const { checkForUpdate, version } = await loadUpdater();

    await checkForUpdate(false);

    expect(stderr.join("\n")).toContain("Update available");
    expect(stderr.join("\n")).toContain(version);
  });

  it("stays quiet when the registry agrees with what is installed", async () => {
    const { checkForUpdate, version } = await loadUpdater();
    registryReturns(version);

    await checkForUpdate(false);

    expect(stderr.join("\n")).toBe("");
  });

  it("does NOT clobber the rest of the config when it records the check", async () => {
    // The regression that matters most in this file. The checker reads the
    // config, awaits the network, then writes — so a write built from its own
    // stale snapshot would erase a key that `senso login` stored while the
    // request was in flight. Every other field has to survive too, or an
    // update check silently logs the user out.
    registryReturns(NEWER);
    const { checkForUpdate, writeConfig, readConfig } = await loadUpdater();
    writeConfig({
      apiKey: "tgr_written_by_login",
      baseUrl: "https://from-file.test",
      orgName: "Acme",
      orgId: "org-1",
      lastUpdateCheck: iso(A_DAY + 60_000),
    });

    await checkForUpdate(false);

    const config = readConfig();
    expect(config.apiKey).toBe("tgr_written_by_login");
    expect(config.baseUrl).toBe("https://from-file.test");
    expect(config.orgName).toBe("Acme");
    expect(config.orgId).toBe("org-1");
    expect(config.latestVersion).toBe(NEWER);
  });
});

describe("when the registry is unhelpful", () => {
  const expectSilence = async (respond: () => Response) => {
    mockRegistry(respond);
    const { checkForUpdate, readConfig } = await loadUpdater();

    // Best-effort: a failure here must never surface next to a command that
    // otherwise succeeded, and must never reach stdout.
    await expect(checkForUpdate(false)).resolves.toBeUndefined();

    expect(stdout.join("\n")).toBe("");
    expect(stderr.join("\n")).toBe("");
    return readConfig();
  };

  it("swallows a 500 and stores nothing", async () => {
    // Nothing stored, so tomorrow's run retries rather than caching a failure.
    const config = await expectSilence(() => new HttpResponse(null, { status: 500 }));
    expect(config).toEqual({});
  });

  it("swallows a 404", async () => {
    await expectSilence(() => new HttpResponse(null, { status: 404 }));
    expect(registryHits).toBe(1);
  });

  it("swallows a body that is not JSON at all", async () => {
    // A captive portal or a corporate proxy answering with HTML.
    await expectSilence(() => new HttpResponse("<html>login required</html>"));
  });

  it("swallows a JSON body with no dist-tags in it", async () => {
    // The response type says dist-tags is always there. It is a cast over an
    // untyped body, so the optional chain guarding it is load-bearing.
    await expectSilence(() => HttpResponse.json({ name: "@senso-ai/cli" }));
  });

  it("swallows a dist-tags entry that is not a version", async () => {
    mockRegistry(() => HttpResponse.json({ "dist-tags": { latest: "not-a-version" } }));
    const { checkForUpdate } = await loadUpdater();

    await expect(checkForUpdate(false)).resolves.toBeUndefined();

    expect(stdout.join("\n")).toBe("");
  });
});

describe("which stream the notice lands on", () => {
  it("writes the box to stderr and leaves stdout untouched", async () => {
    // stdout carries the payload and nothing else. This box used to be the
    // reason `senso ... --output json | jq` needed --quiet as well.
    registryReturns(NEWER);
    const { checkForUpdate } = await loadUpdater();

    await checkForUpdate(false);

    expect(stderr.join("\n")).toContain("Update available");
    expect(stdout.join("\n")).toBe("");
  });

  it("writes the cached box to stderr too", async () => {
    const { checkForUpdate, writeConfig } = await loadUpdater();
    writeConfig({ lastUpdateCheck: iso(60_000), latestVersion: NEWER });

    await checkForUpdate(false);

    expect(stderr.join("\n")).toContain("senso update");
    expect(stdout.join("\n")).toBe("");
  });
});
