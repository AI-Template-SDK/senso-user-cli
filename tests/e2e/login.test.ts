/**
 * The credential lifecycle, in the only place its failure modes are visible.
 *
 * `login` is the one command that reads a terminal, and the one command that
 * can hang. In-process it cannot be tested honestly: the unit suite owns the
 * event loop and `process.stdin.isTTY` is whatever the runner left it as, so a
 * regression that reinstates the interactive prompt for a non-TTY caller would
 * be green there and would stall a CI job or an agent's shell forever. Here
 * stdin really is a pipe — a spawned child never has a TTY — and a hang is a
 * failed test with a message rather than a pipeline that has to be cancelled.
 *
 * `logout` is the other half: it deletes a real file from a real directory, and
 * only a subprocess with its own SENSO_CONFIG_DIR proves the file is gone
 * afterwards rather than that `unlinkSync` was called.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { TEST_API_KEY, freshConfigDir, runSenso, startMockApi, type MockApi } from "./helpers.js";

const ORG = {
  org_id: "org-e2e-1",
  name: "Acme Robotics",
  slug: "acme-robotics",
  is_free_tier: false,
};

let api: MockApi;

beforeAll(async () => {
  api = await startMockApi();
});

afterAll(async () => {
  await api.close();
});

beforeEach(() => {
  api.reset();
});

describe("`senso login --interactive` without a terminal", () => {
  it("fails fast with a usage error instead of waiting for a keypress that cannot come", async () => {
    // Five seconds, not the file's thirty. The whole point of this test is that
    // the command returns promptly; given the default budget, a regression that
    // reinstates the prompt would look like a slow suite rather than a bug, and
    // would cost half a minute on every CI run before saying so.
    const res = await runSenso(["login", "--interactive"], {
      baseUrl: api.url,
      timeoutMs: 5_000,
    });

    expect(res.code).toBe(2);
    // The message has to carry the way out. A caller in CI cannot answer a
    // prompt, so naming what needs no terminal is the entire fix.
    expect(res.stderr).toContain("interactive terminal");
    expect(res.stderr).toContain("SENSO_API_KEY");
    expect(res.stdout).toBe("");
    // Nothing was verified, so nothing was asked of the API.
    expect(api.requests).toEqual([]);
  });

  it("stores no credential when it refuses", async () => {
    const res = await runSenso(["login", "--interactive"], {
      baseUrl: api.url,
      timeoutMs: 5_000,
    });

    expect(existsSync(res.configFile)).toBe(false);
  });
});

describe("`senso login` without a terminal, which is the agent's path", () => {
  const DEVICE_CODE = "an-opaque-43-character-device-code-goes-here";
  const USER_CODE = "FXGQ-HKTG";
  const VERIFY_URL = "https://app.senso.ai/cli/verify";
  const MINTED_KEY = "tgr_minted_by_the_device_flow";

  function apiOpensAFlow(): void {
    api.respondWith("/device/authorize", {
      status: 200,
      body: {
        device_code: DEVICE_CODE,
        user_code: USER_CODE,
        verification_uri: VERIFY_URL,
        expires_in: 300,
        // Tenths of a second: this is what stops a two-poll test taking ten.
        interval: 0.1,
      },
    });
  }

  it("prints the code and returns, instead of blocking on a poll nobody can see", async () => {
    // The reason the flow is two commands. A child process's stdout is not
    // surfaced until it exits — which is exactly how an agent host behaves —
    // so a single blocking process would hide the code for the whole five
    // minutes it was good for.
    apiOpensAFlow();
    const configDir = freshConfigDir();

    const res = await runSenso(["login"], { baseUrl: api.url, configDir, timeoutMs: 10_000 });

    expect(res.code).toBe(0);
    expect(res.stdout).toContain(USER_CODE);
    expect(res.stdout).toContain(VERIFY_URL);
    expect(res.stdout).toContain("senso login --complete");
    // The secret stays in the state file. On stdout it is a bearer credential
    // in a transcript, which is the thing this whole design exists to avoid.
    expect(res.stdout).not.toContain(DEVICE_CODE);
    expect(res.stderr).not.toContain(DEVICE_CODE);
  });

  it("completes in a second process and stores the key it is given", async () => {
    // The handoff is the design: two invocations, one state file, and a
    // credential that never crosses a stream.
    apiOpensAFlow();
    api.respondWith("/device/token", {
      status: 400,
      body: { status: 400, message: "not yet", error_code: "authorization_pending" },
    });
    api.respondWith("/device/token", {
      status: 200,
      body: {
        api_key: MINTED_KEY,
        org_id: ORG.org_id,
        org_name: ORG.name,
        expires_at: "2026-09-28T17:04:00Z",
      },
    });
    api.respondWith("/org/me", { body: ORG });
    const configDir = freshConfigDir();

    const started = await runSenso(["login"], { baseUrl: api.url, configDir, timeoutMs: 10_000 });
    expect(started.code).toBe(0);
    expect(existsSync(join(configDir, "device-auth.json"))).toBe(true);

    const completed = await runSenso(["login", "--complete"], {
      baseUrl: api.url,
      configDir,
      timeoutMs: 10_000,
    });

    expect(completed.code).toBe(0);
    expect(completed.stderr).toContain(ORG.name);
    // The key reaches the config file and nothing else.
    expect(completed.stdout).not.toContain(MINTED_KEY);
    expect(completed.stderr).not.toContain(MINTED_KEY);
    const stored = JSON.parse(readFileSync(join(configDir, "config.json"), "utf-8")) as {
      apiKey?: string;
    };
    expect(stored.apiKey).toBe(MINTED_KEY);
    // Nothing is left to complete, and the directory is clean enough for
    // `senso uninstall` to remove it.
    expect(existsSync(join(configDir, "device-auth.json"))).toBe(false);
  });

  it("exits 2 and names the path when there is nothing to complete", async () => {
    const res = await runSenso(["login", "--complete"], {
      baseUrl: api.url,
      timeoutMs: 5_000,
    });

    expect(res.code).toBe(2);
    expect(res.stderr).toContain("device-auth.json");
    expect(api.requests).toEqual([]);
  });
});

describe("`senso whoami`", () => {
  it("reads the organization from the API and prints its name", async () => {
    api.respondWith("/org/me", { body: ORG });

    const res = await runSenso(["whoami"], { apiKey: TEST_API_KEY, baseUrl: api.url });

    expect(res.code).toBe(0);
    expect(res.stdout).toContain("Acme Robotics");
    expect(res.stdout).toContain("org-e2e-1");
    expect(api.requests[0]?.path).toBe("/org/me");
  });

  it("shows a prefix of the key and never the key itself", async () => {
    api.respondWith("/org/me", { body: ORG });

    const res = await runSenso(["whoami"], { apiKey: TEST_API_KEY, baseUrl: api.url });

    // `whoami` is the command people paste into a support thread, so the full
    // credential must not be reachable from its output on either stream.
    expect(res.stdout).not.toContain(TEST_API_KEY);
    expect(res.stderr).not.toContain(TEST_API_KEY);
    expect(res.stdout).toContain(TEST_API_KEY.slice(0, 8));
  });

  it("exits 3 with no credential anywhere", async () => {
    const res = await runSenso(["whoami"], { baseUrl: api.url });

    expect(res.code).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("SENSO_API_KEY");
  });
});

describe("`senso logout`", () => {
  it("removes the config file from disk", async () => {
    const configDir = freshConfigDir();
    mkdirSync(configDir, { recursive: true });
    const configFile = join(configDir, "config.json");
    writeFileSync(configFile, JSON.stringify({ apiKey: TEST_API_KEY, orgName: "Acme" }), {
      mode: 0o600,
    });

    const res = await runSenso(["logout"], { configDir, baseUrl: api.url });

    expect(res.code).toBe(0);
    expect(existsSync(configFile)).toBe(false);
    // A confirmation, on stderr: there is no payload here, so a caller piping
    // this command should receive an empty stream rather than a sentence.
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Credentials removed");
  });

  it("succeeds when there was nothing stored, because logging out twice is not an error", async () => {
    const res = await runSenso(["logout"], { baseUrl: api.url });

    expect(res.code).toBe(0);
  });
});
