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
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Tests that read a file mode, plant a symlink or compare inodes.
 *
 * Windows has none of the three in the POSIX sense — `stat` reports 0666 or
 * 0444 whatever was asked for, and creating a symlink needs a privilege — so
 * on that platform they are skipped, visibly, rather than failing or being
 * quietly satisfied. The same pattern guards the executable bit in
 * tests/e2e/cli.test.ts. CI runs the unit suite on ubuntu, so this is about
 * the tests telling the truth wherever they are run, not about CI.
 */
const posixOnly = it.skipIf(process.platform === "win32");

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

  posixOnly("writes the file owner-readable only", async () => {
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

describe("reporting where the API key came from", () => {
  /**
   * `senso login` writes the config file, but the environment outranks it. A
   * key exported in a shell profile makes every command talk to a different
   * organization than the one `login` just confirmed, and nothing said so.
   * `whoami` reports this, which is only worth anything if it reports the
   * source of the key the command actually used — hence one resolver for both.
   */
  it("names the flag when the flag supplied the key", async () => {
    const { writeConfig, resolveApiKey } = await loadConfig();
    writeConfig({ apiKey: "from_file" });
    process.env.SENSO_API_KEY = "from_env";

    expect(resolveApiKey({ apiKey: "from_flag" }).source).toBe("flag");
  });

  it("names the environment when it outranks the stored file", async () => {
    const { writeConfig, resolveApiKey } = await loadConfig();
    writeConfig({ apiKey: "from_file" });
    process.env.SENSO_API_KEY = "from_env";

    expect(resolveApiKey().source).toBe("env");
  });

  it("names the config file when nothing outranks it", async () => {
    const { writeConfig, resolveApiKey } = await loadConfig();
    writeConfig({ apiKey: "from_file" });

    expect(resolveApiKey().source).toBe("config");
  });

  it("is undefined when there is no key anywhere", async () => {
    const { resolveApiKey } = await loadConfig();
    expect(resolveApiKey().source).toBeUndefined();
  });

  /**
   * The source is only useful if it cannot disagree with the key. An empty
   * environment variable falls through for `getApiKey`, so it must fall through
   * here too — reporting "env" over a request that used the stored key would be
   * a worse answer than reporting nothing.
   */
  it("skips an empty environment variable, as the key resolution does", async () => {
    const { writeConfig, resolveApiKey } = await loadConfig();
    writeConfig({ apiKey: "from_file" });
    process.env.SENSO_API_KEY = "";

    expect(resolveApiKey().source).toBe("config");
  });

  it("skips an empty flag, as the key resolution does", async () => {
    const { writeConfig, resolveApiKey } = await loadConfig();
    writeConfig({ apiKey: "from_file" });
    process.env.SENSO_API_KEY = "from_env";

    expect(resolveApiKey({ apiKey: "" }).source).toBe("env");
  });

  it("returns the key and its source from one resolution, always agreeing", async () => {
    const { writeConfig, resolveApiKey, getApiKey } = await loadConfig();
    writeConfig({ apiKey: "from_file" });
    process.env.SENSO_API_KEY = "";

    const resolved = resolveApiKey();

    expect(resolved).toEqual({ key: "from_file", source: "config", shadowed: [] });
    expect(resolved.key).toBe(getApiKey());
  });
});

describe("reporting a key that is being shadowed", () => {
  /**
   * The scenario this exists for: someone runs `senso login` in a terminal that
   * already exports SENSO_API_KEY. `login` warns at the time, but the next
   * thing to use that shell — an agent, typically — never saw the warning. From
   * there, "SENSO_API_KEY is the only key here" (the ordinary CI setup) and
   * "SENSO_API_KEY is quietly shadowing the key this user just logged in with"
   * are indistinguishable without this.
   */
  it("names the stored key that the environment is shadowing", async () => {
    const { writeConfig, resolveApiKey } = await loadConfig();
    writeConfig({ apiKey: "from_file" });
    process.env.SENSO_API_KEY = "from_env";

    expect(resolveApiKey().shadowed).toEqual(["config"]);
  });

  it("names both when the flag shadows an environment and a stored key", async () => {
    const { writeConfig, resolveApiKey } = await loadConfig();
    writeConfig({ apiKey: "from_file" });
    process.env.SENSO_API_KEY = "from_env";

    expect(resolveApiKey({ apiKey: "from_flag" }).shadowed).toEqual(["env", "config"]);
  });

  /**
   * Two sources agreeing changes nothing about which organization is reached,
   * so reporting it would be a false alarm — and a warning that cries wolf is
   * one the next reader learns to skip.
   */
  it("says nothing when the sources hold the same key", async () => {
    const { writeConfig, resolveApiKey } = await loadConfig();
    writeConfig({ apiKey: "same_key" });
    process.env.SENSO_API_KEY = "same_key";

    expect(resolveApiKey().shadowed).toEqual([]);
  });

  it("says nothing when only one source holds a key", async () => {
    const { writeConfig, resolveApiKey } = await loadConfig();
    writeConfig({ apiKey: "from_file" });

    expect(resolveApiKey().shadowed).toEqual([]);
  });

  it("says nothing when there is no key at all", async () => {
    const { resolveApiKey } = await loadConfig();
    expect(resolveApiKey().shadowed).toEqual([]);
  });

  it("does not count an empty environment variable as a shadowed key", async () => {
    const { writeConfig, resolveApiKey } = await loadConfig();
    writeConfig({ apiKey: "from_file" });
    process.env.SENSO_API_KEY = "";

    expect(resolveApiKey().shadowed).toEqual([]);
  });

  it("reports the key, its source and what it outranked from one resolution", async () => {
    const { writeConfig, resolveApiKey } = await loadConfig();
    writeConfig({ apiKey: "from_file" });
    process.env.SENSO_API_KEY = "from_env";

    expect(resolveApiKey()).toEqual({
      key: "from_env",
      source: "env",
      shadowed: ["config"],
    });
  });
});

describe("a config file that is not an object", () => {
  /**
   * `JSON.parse("null")` SUCCEEDS, returning null — the catch in `readConfig`
   * never sees it, so every `readConfig().x` in the codebase threw instead.
   * That defeated the documented escape hatch: `--api-key` and SENSO_API_KEY
   * are exactly what you reach for when the stored config is broken, and they
   * stopped working precisely then.
   */
  it("treats a file containing `null` as no config at all", async () => {
    const { readConfig } = await loadConfig();
    writeRawConfig("null");

    expect(readConfig()).toEqual({});
  });

  it("still resolves a flag key when the file contains `null`", async () => {
    const { resolveApiKey } = await loadConfig();
    writeRawConfig("null");

    expect(resolveApiKey({ apiKey: "from_flag" })).toEqual({
      key: "from_flag",
      source: "flag",
      shadowed: [],
    });
  });

  it("still resolves an environment key when the file contains `null`", async () => {
    const { resolveApiKey } = await loadConfig();
    writeRawConfig("null");
    process.env.SENSO_API_KEY = "from_env";

    expect(resolveApiKey().key).toBe("from_env");
  });

  it.each([
    ["a number", '{"apiKey": 123}'],
    ["an object", '{"apiKey": {"k": 1}}'],
    ["a boolean", '{"apiKey": true}'],
    ["an array", '{"apiKey": ["x"]}'],
    ["null", '{"apiKey": null}'],
  ])("ignores a stored apiKey that is %s, rather than throwing", async (_label, body) => {
    // `SensoConfig` describes what this CLI writes, not what is on disk. The
    // file is user-editable, so the declared `string` is an assumption, and
    // acting on it threw out of every command — including ones handed a good
    // key by --api-key.
    const { resolveApiKey } = await loadConfig();
    writeRawConfig(body);

    expect(resolveApiKey({ apiKey: "from_flag" })).toEqual({
      key: "from_flag",
      source: "flag",
      shadowed: [],
    });
    expect(resolveApiKey()).toEqual({ shadowed: [] });
  });

  it.each([
    ["a bare string", '"just a string"'],
    ["an array", "[1,2,3]"],
    ["a number", "42"],
  ])("treats %s as no config at all", async (_label, body) => {
    const { readConfig } = await loadConfig();
    writeRawConfig(body);

    expect(readConfig()).toEqual({});
  });
});

describe("keys that differ only by surrounding whitespace", () => {
  /**
   * `SENSO_API_KEY=$(cat key.txt)` and a Docker --env-file both readily carry a
   * trailing newline. Node strips it from the header, so the request succeeds —
   * but an untrimmed comparison called the two keys different and warned about
   * a conflict that did not exist, in exactly the case the warning is meant to
   * stay silent about.
   */
  it("does not call an identical key shadowed because of a trailing newline", async () => {
    const { writeConfig, resolveApiKey } = await loadConfig();
    writeConfig({ apiKey: "tgr_same_key" });
    process.env.SENSO_API_KEY = "tgr_same_key\n";

    expect(resolveApiKey().shadowed).toEqual([]);
  });

  it("sends the trimmed key, which is what the header would carry anyway", async () => {
    const { writeConfig, resolveApiKey } = await loadConfig();
    writeConfig({ apiKey: "tgr_stored" });
    process.env.SENSO_API_KEY = "  tgr_padded  ";

    expect(resolveApiKey().key).toBe("tgr_padded");
  });

  it("treats a whitespace-only value as absent, as it does the empty string", async () => {
    const { writeConfig, resolveApiKey } = await loadConfig();
    writeConfig({ apiKey: "tgr_the_real_key" });
    process.env.SENSO_API_KEY = "   ";

    // Otherwise a stray space in a shell profile costs the user a working key.
    expect(resolveApiKey()).toEqual({
      key: "tgr_the_real_key",
      source: "config",
      shadowed: [],
    });
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

describe("the in-flight device authorization", () => {
  const PENDING = {
    deviceCode: "a-43-char-opaque-device-code-goes-right-here",
    userCode: "FXGQ-HKTG",
    verificationUri: "https://app.senso.ai/cli/verify",
    interval: 5,
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    baseUrl: "https://apiv2.senso.ai/api/v1",
  };

  function writeRawState(contents: string): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "device-auth.json"), contents);
  }

  it("round-trips what --complete needs to act alone", async () => {
    const { writeDeviceAuthState, readDeviceAuthState } = await loadConfig();

    writeDeviceAuthState(PENDING);

    expect(readDeviceAuthState()).toEqual(PENDING);
  });

  posixOnly("is readable by its owner only, like the credential it will become", async () => {
    const { writeDeviceAuthState, getDeviceAuthPath } = await loadConfig();

    writeDeviceAuthState(PENDING);

    expect(statSync(getDeviceAuthPath()).mode & 0o777).toBe(0o600);
  });

  posixOnly("tightens a file that already existed with a looser mode", async () => {
    // The bug this covers: `mode` on writeFileSync applies only when the file is
    // created. A file left world-readable by an older version, a restored backup
    // or a stray `touch` would otherwise keep those permissions and have a
    // secret written into it.
    writeRawState("{}");
    const { writeDeviceAuthState, getDeviceAuthPath } = await loadConfig();
    const { chmodSync } = await import("node:fs");
    chmodSync(getDeviceAuthPath(), 0o644);

    writeDeviceAuthState(PENDING);

    expect(statSync(getDeviceAuthPath()).mode & 0o777).toBe(0o600);
  });

  it("reads a missing file as nothing pending", async () => {
    const { readDeviceAuthState } = await loadConfig();

    expect(readDeviceAuthState()).toBeUndefined();
  });

  it("reads a half-written or hand-edited file as nothing pending", async () => {
    // A truncated write must not throw out of `--complete`. "Nothing pending"
    // sends the user to `senso login`, which is the right answer anyway.
    const { readDeviceAuthState } = await loadConfig();

    for (const contents of ["{ truncated", "null", "[]", '"a string"']) {
      writeRawState(contents);
      expect(readDeviceAuthState()).toBeUndefined();
    }
  });

  it("refuses a file with no device code, which is the only thing it cannot do without", async () => {
    writeRawState(JSON.stringify({ userCode: "FXGQ-HKTG", expiresAt: PENDING.expiresAt }));
    const { readDeviceAuthState } = await loadConfig();

    expect(readDeviceAuthState()).toBeUndefined();
  });

  it("refuses a file whose expiry is not a date", async () => {
    // Without a readable expiry there is no backstop on the poll loop.
    writeRawState(JSON.stringify({ deviceCode: "dc", expiresAt: "some time on Tuesday" }));
    const { readDeviceAuthState } = await loadConfig();

    expect(readDeviceAuthState()).toBeUndefined();
  });

  it("falls back to the protocol interval when the stored one is unusable", async () => {
    writeRawState(JSON.stringify({ deviceCode: "dc", expiresAt: PENDING.expiresAt, interval: 0 }));
    const { readDeviceAuthState } = await loadConfig();

    expect(readDeviceAuthState()?.interval).toBe(5);
  });
});

describe("sweeping an abandoned device authorization", () => {
  const stateAt = (expiresAt: string): string =>
    JSON.stringify({ deviceCode: "dc", userCode: "AAAA-BBBB", interval: 5, expiresAt });

  function writeStateExpiring(expiresAt: string): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "device-auth.json"), stateAt(expiresAt));
  }

  it("leaves a live authorization alone", async () => {
    writeStateExpiring(new Date(Date.now() + 120_000).toISOString());
    const { sweepDeviceAuthState, readDeviceAuthState } = await loadConfig();

    expect(sweepDeviceAuthState()).toBe(false);
    expect(readDeviceAuthState()).toBeDefined();
  });

  it("leaves one alone that only just expired", async () => {
    // The grace period is the point. Expiry is the server's to decide, and a
    // local clock running fast must not let `senso whoami` delete a login the
    // user is in the middle of approving.
    writeStateExpiring(new Date(Date.now() - 60_000).toISOString());
    const { sweepDeviceAuthState, readDeviceAuthState } = await loadConfig();

    expect(sweepDeviceAuthState()).toBe(false);
    expect(readDeviceAuthState()).toBeDefined();
  });

  it("collects one that is long dead", async () => {
    writeStateExpiring(new Date(Date.now() - 3_600_000).toISOString());
    const { sweepDeviceAuthState, readDeviceAuthState } = await loadConfig();

    expect(sweepDeviceAuthState()).toBe(true);
    expect(readDeviceAuthState()).toBeUndefined();
  });

  it("does nothing, cheaply, when there is no state file at all", async () => {
    const { sweepDeviceAuthState } = await loadConfig();

    expect(sweepDeviceAuthState()).toBe(false);
  });
});

describe("logging out", () => {
  it("ends a login in progress as well as one already stored", async () => {
    // A pending authorization is a credential in flight. It also has to go for
    // `senso uninstall` to work at all: it rmdir's the config directory, which
    // fails while anything is left in it.
    const { writeConfig, writeDeviceAuthState, clearConfig, readConfig, readDeviceAuthState } =
      await loadConfig();
    writeConfig({ apiKey: "tgr_abc" });
    writeDeviceAuthState({
      deviceCode: "dc",
      userCode: "AAAA-BBBB",
      verificationUri: "https://app.senso.ai/cli/verify",
      interval: 5,
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    });

    clearConfig();

    expect(readConfig()).toEqual({});
    expect(readDeviceAuthState()).toBeUndefined();
  });
});

describe("writing a secret to disk", () => {
  /**
   * These are about the mechanism, not the contents. A credential file has
   * three ways to go wrong that an ordinary `writeFileSync` does nothing about,
   * and the tests below each pin one of them.
   */
  const stored = (): string => readFileSync(join(dir, "config.json"), "utf-8");

  posixOnly("replaces a symlink at the path instead of writing the secret through it", async () => {
    // A link planted at config.json would otherwise carry the key to wherever
    // it points — a shared SENSO_CONFIG_DIR is enough to make that plausible.
    mkdirSync(dir, { recursive: true });
    const elsewhere = join(dir, "captured.json");
    symlinkSync(elsewhere, join(dir, "config.json"));
    const { writeConfig } = await loadConfig();

    writeConfig({ apiKey: "tgr_secret" });

    expect(lstatSync(join(dir, "config.json")).isSymbolicLink()).toBe(false);
    expect(() => statSync(elsewhere)).toThrow();
    expect(JSON.parse(stored())).toEqual({ apiKey: "tgr_secret" });
  });

  posixOnly("never has the secret on disk under the old file's looser permissions", async () => {
    // `mode` applies only when a file is created. Rewriting a 0644 file in
    // place left the key world-readable until a later chmod — a window. A new
    // inode proves the old file was replaced, never written into.
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), "{}");
    chmodSync(join(dir, "config.json"), 0o644);
    const before = statSync(join(dir, "config.json"));
    const { writeConfig } = await loadConfig();

    writeConfig({ apiKey: "tgr_secret" });

    const after = statSync(join(dir, "config.json"));
    expect(after.mode & 0o777).toBe(0o600);
    expect(after.ino).not.toBe(before.ino);
  });

  it("leaves nothing behind but the file itself", async () => {
    const { writeConfig, writeDeviceAuthState } = await loadConfig();

    writeConfig({ apiKey: "tgr_secret" });
    writeDeviceAuthState({
      deviceCode: "dc",
      userCode: "AAAA-BBBB",
      verificationUri: "https://app.senso.ai/cli/verify",
      interval: 5,
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    });

    expect(readdirSync(dir).sort()).toEqual(["config.json", "device-auth.json"]);
  });

  /**
   * A config module whose `renameSync` fails as scripted, everything else real.
   *
   * The directory cannot simply be made unwritable: the helper re-chmods it to
   * 0700 as its first act, which an owner is always allowed to do. Failing the
   * rename itself is both deterministic and the honest test — it is the one
   * step whose failure has to leave the old file exactly as it was.
   */
  async function loadConfigWithRename(renameSync: (from: string, to: string) => void) {
    vi.resetModules();
    process.env.SENSO_CONFIG_DIR = dir;
    vi.doMock("node:fs", async (importOriginal) => ({
      ...(await importOriginal<typeof import("node:fs")>()),
      renameSync,
    }));
    try {
      return await import("../../src/lib/config.js");
    } finally {
      vi.doUnmock("node:fs");
    }
  }

  const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });

  it("keeps the previous credential intact when the replacement cannot land", async () => {
    // The interrupted-write case, made deterministic: the new file is written,
    // the swap fails, and the credential that worked a moment ago must still
    // work — with nothing half-written left beside it.
    const { writeConfig } = await loadConfig();
    writeConfig({ apiKey: "tgr_the_key_that_works" });
    const failing = await loadConfigWithRename(() => {
      throw errno("ENOSPC");
    });

    expect(() => {
      failing.writeConfig({ apiKey: "tgr_never_lands" });
    }).toThrow(/ENOSPC/);

    expect(JSON.parse(stored())).toEqual({ apiKey: "tgr_the_key_that_works" });
    expect(readdirSync(dir)).toEqual(["config.json"]);
  });

  it("rides out the transient EPERM a Windows antivirus scanner produces", async () => {
    // Two refusals, then the real rename. The write must succeed rather than
    // report a failed login on a machine where nothing is actually wrong.
    const { renameSync: realRename } = await import("node:fs");
    let attempts = 0;
    const flaky = await loadConfigWithRename((from, to) => {
      attempts += 1;
      if (attempts <= 2) throw errno("EPERM");
      realRename(from, to);
    });

    flaky.writeConfig({ apiKey: "tgr_eventually" });

    expect(JSON.parse(stored())).toEqual({ apiKey: "tgr_eventually" });
    expect(attempts).toBe(3);
  });

  it("gives up on a failure that is not transient, rather than retrying it", async () => {
    let calls = 0;
    const broken = await loadConfigWithRename(() => {
      calls += 1;
      throw errno("EACCES");
    });

    expect(() => {
      broken.writeConfig({ apiKey: "tgr_x" });
    }).toThrow(/EACCES/);
    expect(calls).toBe(1);
  });

  posixOnly("protects the in-flight device code the same way", async () => {
    mkdirSync(dir, { recursive: true });
    const elsewhere = join(dir, "captured-code.json");
    symlinkSync(elsewhere, join(dir, "device-auth.json"));
    const { writeDeviceAuthState } = await loadConfig();

    writeDeviceAuthState({
      deviceCode: "the-secret-device-code",
      userCode: "AAAA-BBBB",
      verificationUri: "https://app.senso.ai/cli/verify",
      interval: 5,
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    });

    expect(lstatSync(join(dir, "device-auth.json")).isSymbolicLink()).toBe(false);
    expect(() => statSync(elsewhere)).toThrow();
  });
});
