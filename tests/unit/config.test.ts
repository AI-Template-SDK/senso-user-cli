/**
 * Where the API key lives, and who wins when it is in more than one place.
 *
 * Two things are worth protecting here and both are security-adjacent:
 *
 *   1. The precedence order. A caller passing --api-key must not silently get
 *      the stored one, and an environment variable must not be shadowed by a
 *      stale config file. Getting this wrong authenticates as the wrong
 *      organization, which is worse than failing.
 *   2. The file mode. This file holds a credential and must be readable by its
 *      owner only.
 *
 * config.ts resolves SENSO_CONFIG_DIR once at module load, so every test here
 * resets the module registry and re-imports it with the directory it wants.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let dir: string;

/** A fresh config module bound to `dir`. */
async function loadConfig() {
  vi.resetModules();
  process.env.SENSO_CONFIG_DIR = dir;
  return import("../../src/lib/config.js");
}

function writeRawConfig(contents: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), contents);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "senso-config-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.resetModules();
});

describe("reading a config that is not there", () => {
  it("returns an empty config rather than failing", async () => {
    // The normal first-run state. A command should reach "no API key found",
    // not a stack trace about a missing file.
    const { readConfig } = await loadConfig();
    expect(readConfig()).toEqual({});
  });

  it("returns an empty config when the file is corrupt", async () => {
    // Every field is optional and re-derivable, so a truncated write should not
    // brick the CLI — it should behave as though nothing was stored.
    writeRawConfig("{ this is not json");
    const { readConfig } = await loadConfig();
    expect(readConfig()).toEqual({});
  });
});

describe("writing the config", () => {
  it("creates the directory and stores the values", async () => {
    const { writeConfig, readConfig } = await loadConfig();

    writeConfig({ apiKey: "tgr_abc", orgName: "Acme" });

    expect(readConfig()).toEqual({ apiKey: "tgr_abc", orgName: "Acme" });
  });

  it("writes the file owner-readable only", async () => {
    const { writeConfig, getConfigPath } = await loadConfig();

    writeConfig({ apiKey: "tgr_abc" });

    // 0600. This file holds a credential; on a shared machine any wider mode
    // hands it to every other account.
    const mode = statSync(getConfigPath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("ends the file with a newline, so it is not a broken text file", async () => {
    const { writeConfig, getConfigPath } = await loadConfig();
    writeConfig({ apiKey: "tgr_abc" });
    expect(readFileSync(getConfigPath(), "utf-8").endsWith("\n")).toBe(true);
  });
});

describe("updateConfig", () => {
  it("merges into what is on disk instead of replacing it", async () => {
    const { writeConfig, updateConfig, readConfig } = await loadConfig();
    writeConfig({ apiKey: "tgr_abc", orgName: "Acme" });

    updateConfig({ latestVersion: "9.9.9" });

    expect(readConfig()).toEqual({
      apiKey: "tgr_abc",
      orgName: "Acme",
      latestVersion: "9.9.9",
    });
  });

  it("re-reads immediately before writing, so a concurrent login is not lost", async () => {
    // This is the property that makes the background update check safe to run
    // alongside `senso login`. The checker reads the config early, awaits the
    // network, and writes late — if that write used its stale snapshot it would
    // erase the key login stored in the meantime.
    const { writeConfig, updateConfig, readConfig } = await loadConfig();
    writeConfig({});

    const staleSnapshot = readConfig();
    writeConfig({ apiKey: "tgr_written_by_login" });
    updateConfig({ lastUpdateCheck: "2026-09-09T00:00:00Z" });

    expect(staleSnapshot).toEqual({});
    expect(readConfig().apiKey).toBe("tgr_written_by_login");
  });
});

describe("clearConfig", () => {
  it("removes the stored credentials", async () => {
    const { writeConfig, clearConfig, readConfig } = await loadConfig();
    writeConfig({ apiKey: "tgr_abc" });

    clearConfig();

    expect(readConfig()).toEqual({});
  });

  it("is not an error when there is nothing to clear", async () => {
    // `senso logout` twice, or before ever logging in.
    const { clearConfig } = await loadConfig();
    expect(() => {
      clearConfig();
    }).not.toThrow();
  });
});

describe("resolving the API key", () => {
  it("prefers the flag over everything else", async () => {
    const { writeConfig, getApiKey } = await loadConfig();
    writeConfig({ apiKey: "from_file" });
    process.env.SENSO_API_KEY = "from_env";

    expect(getApiKey({ apiKey: "from_flag" })).toBe("from_flag");
  });

  it("prefers the environment over the stored file", async () => {
    const { writeConfig, getApiKey } = await loadConfig();
    writeConfig({ apiKey: "from_file" });
    process.env.SENSO_API_KEY = "from_env";

    expect(getApiKey()).toBe("from_env");
  });

  it("falls back to the stored file", async () => {
    const { writeConfig, getApiKey } = await loadConfig();
    writeConfig({ apiKey: "from_file" });

    expect(getApiKey()).toBe("from_file");
  });

  it("treats an empty environment variable as absent", async () => {
    // `SENSO_API_KEY=` is what an unset CI variable expands to. Using it would
    // authenticate with the empty string and produce a confusing 401 instead of
    // falling through to the key the user actually stored.
    const { writeConfig, getApiKey } = await loadConfig();
    writeConfig({ apiKey: "from_file" });
    process.env.SENSO_API_KEY = "";

    expect(getApiKey()).toBe("from_file");
  });

  it("treats an empty flag as absent", async () => {
    const { writeConfig, getApiKey } = await loadConfig();
    writeConfig({ apiKey: "from_file" });

    expect(getApiKey({ apiKey: "" })).toBe("from_file");
  });

  it("returns undefined when there is no key anywhere", async () => {
    const { getApiKey } = await loadConfig();
    expect(getApiKey()).toBeUndefined();
  });
});

describe("resolving the base URL", () => {
  it("falls back to production when nothing overrides it", async () => {
    const { getBaseUrl } = await loadConfig();
    expect(getBaseUrl()).toBe("https://apiv2.senso.ai/api/v1");
  });

  it("follows the same precedence as the key", async () => {
    const { writeConfig, getBaseUrl } = await loadConfig();
    writeConfig({ baseUrl: "https://from-file.test" });
    process.env.SENSO_BASE_URL = "https://from-env.test";

    expect(getBaseUrl({ baseUrl: "https://from-flag.test" })).toBe("https://from-flag.test");
    expect(getBaseUrl()).toBe("https://from-env.test");

    delete process.env.SENSO_BASE_URL;
    expect(getBaseUrl()).toBe("https://from-file.test");
  });
});

describe("SENSO_CONFIG_DIR", () => {
  it("relocates the config file entirely", async () => {
    // This is what lets the test suite and the smoke test run without any
    // chance of reading or writing a real developer's credentials.
    const { getConfigPath, getConfigDir } = await loadConfig();

    expect(getConfigDir()).toBe(dir);
    expect(getConfigPath()).toBe(join(dir, "config.json"));
  });
});
