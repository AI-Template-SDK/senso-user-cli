/**
 * Command layer: `senso login`, `senso logout`, `senso whoami`.
 *
 * This group owns the credential file, which makes it the one place where a
 * wrong decision follows the user into every later command. Four things are
 * worth protecting, in descending order of damage:
 *
 *   1. An unverified key is never written. `login` calls /org/me first and
 *      writes second — reverse the two and a typo'd key sits on disk making
 *      every subsequent command fail with a 401 the user cannot explain.
 *   2. A canceled prompt changes nothing. Ctrl-C at the paste step must leave
 *      whatever was already stored exactly as it was.
 *   3. Without a terminal, `login` fails immediately instead of waiting on a
 *      keypress nobody will make. It used to hang forever in CI and in an
 *      agent's shell.
 *   4. `whoami` answers offline. "Which organization am I pointed at" is
 *      answerable from the cache, and failing on it would be a worse answer
 *      than a slightly stale one.
 *
 * @clack/prompts is mocked because the real one reads a TTY. lib/config.ts is
 * not mocked: these tests write and read a real file in a real directory, which
 * is the only way to prove point 1.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { server, TEST_API_KEY, TEST_BASE_URL } from "../setup.js";
import { apiUrl, runCli } from "../helpers.js";
import { getConfigPath, writeConfig, type SensoConfig } from "../../src/lib/config.js";

/**
 * A real, writable config directory, pinned before the imports above run.
 *
 * lib/config.ts resolves SENSO_CONFIG_DIR once at module load — which happens
 * when this file imports the program, before the suite's `beforeEach` can point
 * it anywhere. Every other command test gets away with that because it passes
 * `--api-key`; this one writes the file, so it has to own the directory. The
 * path is derived rather than mkdtemp'd because a hoisted block runs before
 * node:fs has been imported.
 */
const CONFIG_DIR = vi.hoisted(() => {
  const tmp = (process.env.TMPDIR ?? process.env.TEMP ?? "/tmp").replace(/[/\\]+$/, "");
  const dir = `${tmp}/senso-auth-test-${process.pid}`;
  process.env.SENSO_CONFIG_DIR = dir;
  return dir;
});

/**
 * The prompt layer, replaced.
 *
 * `isCancel` is the real contract rather than a stub: clack returns a unique
 * symbol for Ctrl-C, and auth.ts narrows on it, so the mock has to answer the
 * same question the same way.
 */
const clack = vi.hoisted(() => ({
  CANCEL: Symbol("clack.cancel"),
  text: vi.fn<() => Promise<unknown>>(),
  cancel: vi.fn<(message: string) => void>(),
  spinner: { start: vi.fn(), stop: vi.fn(), message: vi.fn() },
}));

vi.mock("@clack/prompts", () => ({
  text: clack.text,
  cancel: clack.cancel,
  isCancel: (value: unknown) => value === clack.CANCEL,
  // Inert: the real spinner writes frames on an interval and hides the cursor,
  // which in a test run leaves the terminal broken if a test fails mid-spin.
  spinner: () => clack.spinner,
  select: vi.fn(),
}));

/** dto.OrgResponse from GET /org/me. org_id is a uuid.UUID. */
const ORG = {
  org_id: "018f3b2c-4d5e-4a6b-8c7d-9e0f1a2b3c4d",
  name: "Acme Corp",
  slug: "acme",
  is_free_tier: false,
};

/** What `login` pastes, deliberately different from the key runCli passes. */
const PASTED_KEY = "tgr_pasted_by_the_user";

const storedConfig = (): SensoConfig =>
  JSON.parse(readFileSync(getConfigPath(), "utf-8")) as SensoConfig;

const configExists = (): boolean => existsSync(getConfigPath());

/** `login` refuses to prompt without one of these. */
function withTerminal(isTTY: boolean): void {
  process.stdin.isTTY = isTTY;
}

const originalIsTTY = process.stdin.isTTY;

beforeEach(() => {
  rmSync(CONFIG_DIR, { recursive: true, force: true });
  clack.text.mockReset();
  clack.cancel.mockReset();
  clack.spinner.start.mockReset();
  clack.spinner.stop.mockReset();
  withTerminal(true);
});

afterEach(() => {
  withTerminal(originalIsTTY);
  vi.clearAllMocks();
});

afterAll(() => {
  rmSync(CONFIG_DIR, { recursive: true, force: true });
});

describe("the tests own the config file they are about to write", () => {
  it("is pointed at a temporary directory, not the developer's own", () => {
    // A guard on the guard. If this ever fails, everything below is writing to
    // a real credential file.
    expect(getConfigPath()).toContain("senso-auth-test-");
    expect(getConfigPath()).not.toContain("/.config/senso/");
  });
});

describe("login, without a terminal to prompt on", () => {
  it("exits 2 immediately instead of waiting for a keypress", async () => {
    // The regression: clack waits on a TTY that is not there, so `senso login`
    // in CI or in an agent's shell hung until something killed it.
    withTerminal(false);

    const res = await runCli(["login"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("interactive terminal");
  });

  it("names the two ways to authenticate that need no terminal", async () => {
    withTerminal(false);

    const res = await runCli(["login"]);

    expect(res.stderr).toContain("SENSO_API_KEY");
    expect(res.stderr).toContain("--api-key");
  });

  it("never reaches the prompt, and writes nothing", async () => {
    withTerminal(false);

    await runCli(["login"]);

    expect(clack.text).not.toHaveBeenCalled();
    expect(configExists()).toBe(false);
  });
});

describe("login, when the prompt is canceled", () => {
  it("exits 0 — Ctrl-C is not a failure", async () => {
    clack.text.mockResolvedValue(clack.CANCEL);

    const res = await runCli(["login"]);

    expect(res.exitCode).toBe(0);
    expect(clack.cancel).toHaveBeenCalledWith("Login canceled.");
  });

  it("writes no config at all", async () => {
    clack.text.mockResolvedValue(clack.CANCEL);

    await runCli(["login"]);

    expect(configExists()).toBe(false);
  });

  it("leaves an existing credential untouched", async () => {
    // Backing out of a re-login must not log the user out of the organization
    // they were already in.
    writeConfig({ apiKey: "tgr_already_stored", orgName: "Previous Org" });
    clack.text.mockResolvedValue(clack.CANCEL);

    await runCli(["login"]);

    expect(storedConfig()).toMatchObject({
      apiKey: "tgr_already_stored",
      orgName: "Previous Org",
    });
  });
});

describe("login, when the key does not verify", () => {
  it("does NOT write the rejected key to disk", async () => {
    // The most important assertion in this file. A key stored before it was
    // proven makes every later command fail with an authentication error that
    // has nothing to do with the command the user typed.
    server.use(
      http.get(apiUrl("/org/me"), () =>
        HttpResponse.json({ error: "invalid key" }, { status: 401 }),
      ),
    );
    clack.text.mockResolvedValue("tgr_not_a_real_key");

    const res = await runCli(["login"]);

    expect(res.exitCode).toBe(3);
    expect(configExists()).toBe(false);
  });

  it("stops the spinner before the error surfaces", async () => {
    // Otherwise the terminal is left with a spinning frame and a hidden cursor
    // under the error message.
    server.use(http.get(apiUrl("/org/me"), () => new HttpResponse(null, { status: 401 })));
    clack.text.mockResolvedValue("tgr_not_a_real_key");

    await runCli(["login"]);

    expect(clack.spinner.stop).toHaveBeenCalledWith("Verification failed");
  });

  it("exits 5 and stores nothing when the API cannot be reached", async () => {
    server.use(http.get(apiUrl("/org/me"), () => HttpResponse.error()));
    clack.text.mockResolvedValue("tgr_offline_attempt");

    const res = await runCli(["login"]);

    expect(res.exitCode).toBe(5);
    expect(res.stdout).toBe("");
    expect(configExists()).toBe(false);
  });

  it("keeps the previously stored key when a new one is rejected", async () => {
    server.use(http.get(apiUrl("/org/me"), () => new HttpResponse(null, { status: 403 })));
    writeConfig({ apiKey: "tgr_already_stored", orgName: "Previous Org" });
    clack.text.mockResolvedValue("tgr_not_a_real_key");

    const res = await runCli(["login"]);

    expect(res.exitCode).toBe(3);
    expect(storedConfig().apiKey).toBe("tgr_already_stored");
  });
});

describe("login, on success", () => {
  function orgResponds(): { seen: () => Request | undefined } {
    let request: Request | undefined;
    server.use(
      http.get(apiUrl("/org/me"), ({ request: req }) => {
        request = req;
        return HttpResponse.json(ORG);
      }),
    );
    return { seen: () => request };
  }

  it("verifies with the key that was pasted, not the one on the command line", async () => {
    // runCli passes --api-key, as every other test needs it to. `login` must
    // ignore it: the whole point is to check the key the user just typed.
    const { seen } = orgResponds();
    clack.text.mockResolvedValue(PASTED_KEY);

    await runCli(["login"]);

    expect(seen()?.headers.get("x-api-key")).toBe(PASTED_KEY);
  });

  it("stores the key alongside the organization it belongs to", async () => {
    orgResponds();
    clack.text.mockResolvedValue(PASTED_KEY);

    const res = await runCli(["login"]);

    expect(res.exitCode).toBe(0);
    expect(storedConfig()).toMatchObject({
      apiKey: PASTED_KEY,
      orgId: ORG.org_id,
      orgName: ORG.name,
      orgSlug: ORG.slug,
      isFreeTier: ORG.is_free_tier,
      // Recorded so later commands keep talking to the host the key was
      // verified against.
      baseUrl: TEST_BASE_URL,
    });
  });

  it("trims what was pasted", async () => {
    // A key copied out of a dashboard arrives with a trailing newline more
    // often than not, and it would be sent verbatim in a header.
    orgResponds();
    clack.text.mockResolvedValue(`  ${PASTED_KEY}\n`);

    await runCli(["login"]);

    expect(storedConfig().apiKey).toBe(PASTED_KEY);
  });

  it("says which organization it authenticated as, on stderr", async () => {
    orgResponds();
    clack.text.mockResolvedValue(PASTED_KEY);

    const res = await runCli(["login"]);

    expect(res.stderr).toContain(ORG.name);
    expect(res.stderr).toContain(ORG.org_id);
    // Nothing here is payload — not the banner, not the confirmation.
    expect(res.stdout).toBe("");
  });
});

describe("whoami, when the API answers", () => {
  it("exits 3 when there is no key anywhere", async () => {
    const res = await runCli(["whoami"], { withKey: false });

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("no API key found");
    expect(res.stderr).toContain("senso login");
  });

  it("reports the organization the key belongs to", async () => {
    server.use(http.get(apiUrl("/org/me"), () => HttpResponse.json(ORG)));

    const res = await runCli(["whoami"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain(ORG.name);
    expect(res.stdout).toContain(ORG.org_id);
    expect(res.stdout).toContain("Paid");
  });

  it("prints a prefix of the key and never the key itself", async () => {
    // `whoami` is the command people paste into a support thread.
    server.use(http.get(apiUrl("/org/me"), () => HttpResponse.json(ORG)));

    const res = await runCli(["whoami"]);

    expect(res.stdout).toContain(TEST_API_KEY.slice(0, 8));
    expect(res.stdout).not.toContain(TEST_API_KEY);
  });

  it("names its fields in snake_case, like every other command", async () => {
    // `whoami` used to be the one command answering in camelCase, so a caller
    // with a working `jq -r \'.data.org_id\'` everywhere else got null here and
    // nothing said why. The API\'s own key names are what the payload uses.
    server.use(http.get(apiUrl("/org/me"), () => HttpResponse.json(ORG)));

    const res = await runCli(["whoami", "--output", "json"]);

    expect(res.data()).toMatchObject({
      org_id: ORG.org_id,
      name: ORG.name,
      slug: ORG.slug,
      is_free_tier: false,
      api_key_prefix: `${TEST_API_KEY.slice(0, 8)}...`,
      config_path: getConfigPath(),
      cached: false,
    });
    expect(res.stderr).toBe("");
  });

  it("says which of the three credential sources is in effect", async () => {
    // --api-key, SENSO_API_KEY and the stored config all authenticate, and the
    // commonest confusion here is not knowing which one won.
    server.use(http.get(apiUrl("/org/me"), () => HttpResponse.json(ORG)));

    const res = await runCli(["whoami", "--output", "json"]);

    expect(res.data()).toMatchObject({ credential_source: "flag" });
  });

  it("renders as a table when asked", async () => {
    server.use(http.get(apiUrl("/org/me"), () => HttpResponse.json(ORG)));

    const res = await runCli(["whoami", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("org_id");
    expect(res.stdout).toContain(ORG.name);
  });
});

describe("whoami, when the API cannot be reached", () => {
  /** A previous successful login, as it would have been left on disk. */
  function cachedLogin(): void {
    writeConfig({
      apiKey: TEST_API_KEY,
      orgId: ORG.org_id,
      orgName: ORG.name,
      orgSlug: ORG.slug,
      isFreeTier: ORG.is_free_tier,
    });
  }

  function apiIsDown(): void {
    server.use(http.get(apiUrl("/org/me"), () => HttpResponse.error()));
  }

  it("answers from the cache rather than failing", async () => {
    // "Which organization am I pointed at" does not need the network, and on a
    // plane a stale answer beats an error.
    cachedLogin();
    apiIsDown();

    const res = await runCli(["whoami"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain(ORG.name);
    expect(res.stdout).toContain(ORG.org_id);
  });

  it("says the values are cached, on both streams", async () => {
    // The caveat is the point. A stale org name presented as current is worse
    // than no answer.
    cachedLogin();
    apiIsDown();

    const res = await runCli(["whoami"]);

    expect(res.stderr).toContain("Could not reach the Senso API");
    expect(res.stdout).toContain("cached");
  });

  it("marks the payload as cached under --output json", async () => {
    cachedLogin();
    apiIsDown();

    const res = await runCli(["whoami", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toMatchObject({
      org_id: ORG.org_id,
      name: ORG.name,
      cached: true,
    });
  });

  it("exits 5 when there is nothing cached to fall back to", async () => {
    // Nothing true to say, so it says nothing and reports the network failure.
    apiIsDown();

    const res = await runCli(["whoami"]);

    expect(res.exitCode).toBe(5);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Could not reach the Senso API");
  });

  it("exits 3 on a rejected key rather than falling back to the cache", async () => {
    // The cache is for an unreachable API, not for a key the API answered
    // about. A revoked key that printed the cached organization and exited 0
    // would answer the one question `whoami` exists to answer wrongly.
    cachedLogin();
    server.use(http.get(apiUrl("/org/me"), () => new HttpResponse(null, { status: 401 })));

    const res = await runCli(["whoami"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stdout).not.toContain(ORG.name);
  });

  it("still falls back to the cache when the connection itself fails", async () => {
    // The counterpart to the test above: narrowing the fallback to non-auth
    // failures must not cost the offline answer.
    cachedLogin();
    apiIsDown();

    const res = await runCli(["whoami"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain(ORG.name);
  });
});

describe("logout", () => {
  it("removes the stored credential", async () => {
    writeConfig({ apiKey: TEST_API_KEY, orgName: ORG.name });

    const res = await runCli(["logout"]);

    expect(res.exitCode).toBe(0);
    expect(configExists()).toBe(false);
  });

  it("is not an error when there was nothing stored", async () => {
    const res = await runCli(["logout"]);

    expect(res.exitCode).toBe(0);
  });

  it("puts the confirmation on stderr, leaving stdout empty", async () => {
    writeConfig({ apiKey: TEST_API_KEY });

    const res = await runCli(["logout"]);

    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Removed stored credentials");
    // The path, because "removed from where" is the follow-up question.
    expect(res.stderr).toContain(getConfigPath());
  });

  it("says nothing was stored, rather than claiming a removal that did not happen", async () => {
    const res = await runCli(["logout", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toMatchObject({ action: "unchanged", had_credentials: false });
  });

  it("names what changed instead of handing back a sentence to parse", async () => {
    writeConfig({ apiKey: TEST_API_KEY });

    const res = await runCli(["logout", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toMatchObject({
      action: "deleted",
      resource: "credentials",
      had_credentials: true,
      path: getConfigPath(),
    });
    expect(res.stderr).toBe("");
  });
});
