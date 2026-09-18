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
  // `login` prompts with `password`, not `text`, so the key is never echoed
  // into stdout. One mock backs both: they have the same contract here.
  prompt: vi.fn<() => Promise<unknown>>(),
  cancel: vi.fn<(message: string) => void>(),
  spinner: { start: vi.fn(), stop: vi.fn(), message: vi.fn() },
}));

vi.mock("@clack/prompts", () => ({
  password: clack.prompt,
  text: clack.prompt,
  cancel: clack.cancel,
  isCancel: (value: unknown) => value === clack.CANCEL,
  // Inert: the real spinner writes frames on an interval and hides the cursor,
  // which in a test run leaves the terminal broken if a test fails mid-spin.
  spinner: () => clack.spinner,
  select: vi.fn(),
}));

const ORG = {
  org_id: "org-abc",
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
  clack.prompt.mockReset();
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

    expect(clack.prompt).not.toHaveBeenCalled();
    expect(configExists()).toBe(false);
  });
});

describe("login, when the prompt is canceled", () => {
  it("exits 0 — Ctrl-C is not a failure", async () => {
    clack.prompt.mockResolvedValue(clack.CANCEL);

    const res = await runCli(["login"]);

    expect(res.exitCode).toBe(0);
    expect(clack.cancel).toHaveBeenCalledWith("Login canceled.");
  });

  it("writes no config at all", async () => {
    clack.prompt.mockResolvedValue(clack.CANCEL);

    await runCli(["login"]);

    expect(configExists()).toBe(false);
  });

  it("leaves an existing credential untouched", async () => {
    // Backing out of a re-login must not log the user out of the organization
    // they were already in.
    writeConfig({ apiKey: "tgr_already_stored", orgName: "Previous Org" });
    clack.prompt.mockResolvedValue(clack.CANCEL);

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
    clack.prompt.mockResolvedValue("tgr_not_a_real_key");

    const res = await runCli(["login"]);

    expect(res.exitCode).toBe(3);
    expect(configExists()).toBe(false);
  });

  it("stops the spinner before the error surfaces", async () => {
    // Otherwise the terminal is left with a spinning frame and a hidden cursor
    // under the error message.
    server.use(http.get(apiUrl("/org/me"), () => new HttpResponse(null, { status: 401 })));
    clack.prompt.mockResolvedValue("tgr_not_a_real_key");

    await runCli(["login"]);

    expect(clack.spinner.stop).toHaveBeenCalledWith("Verification failed");
  });

  it("exits 5 and stores nothing when the API cannot be reached", async () => {
    server.use(http.get(apiUrl("/org/me"), () => HttpResponse.error()));
    clack.prompt.mockResolvedValue("tgr_offline_attempt");

    const res = await runCli(["login"]);

    expect(res.exitCode).toBe(5);
    expect(res.stdout).toBe("");
    expect(configExists()).toBe(false);
  });

  it("keeps the previously stored key when a new one is rejected", async () => {
    server.use(http.get(apiUrl("/org/me"), () => new HttpResponse(null, { status: 403 })));
    writeConfig({ apiKey: "tgr_already_stored", orgName: "Previous Org" });
    clack.prompt.mockResolvedValue("tgr_not_a_real_key");

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
    clack.prompt.mockResolvedValue(PASTED_KEY);

    await runCli(["login"]);

    expect(seen()?.headers.get("x-api-key")).toBe(PASTED_KEY);
  });

  it("stores the key alongside the organization it belongs to", async () => {
    orgResponds();
    clack.prompt.mockResolvedValue(PASTED_KEY);

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
    clack.prompt.mockResolvedValue(`  ${PASTED_KEY}\n`);

    await runCli(["login"]);

    expect(storedConfig().apiKey).toBe(PASTED_KEY);
  });

  it("says which organization it authenticated as, on stderr", async () => {
    orgResponds();
    clack.prompt.mockResolvedValue(PASTED_KEY);

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

  it("gives a JSON caller the fields under stable names", async () => {
    server.use(http.get(apiUrl("/org/me"), () => HttpResponse.json(ORG)));

    const res = await runCli(["whoami", "--output", "json"]);

    expect(res.json()).toMatchObject({
      orgId: ORG.org_id,
      orgName: ORG.name,
      orgSlug: ORG.slug,
      isFreeTier: false,
      apiKeyPrefix: `${TEST_API_KEY.slice(0, 8)}...`,
      configPath: getConfigPath(),
    });
    expect(res.stderr).toBe("");
  });

  it("renders as a table when asked", async () => {
    server.use(http.get(apiUrl("/org/me"), () => HttpResponse.json(ORG)));

    const res = await runCli(["whoami", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("orgName");
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
    expect(res.json()).toMatchObject({
      orgId: ORG.org_id,
      orgName: ORG.name,
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

describe("login, when SENSO_API_KEY is set in the environment", () => {
  /**
   * The environment outranks the config file, so the key `login` just stored
   * and confirmed on screen is NOT the key the next command will send. Left
   * unsaid, this is a silent wrong-organization bug: every command afterwards
   * reaches somewhere other than the organization the user was just told they
   * had authenticated as.
   */
  function orgResponds(): void {
    server.use(http.get(apiUrl("/org/me"), () => HttpResponse.json(ORG)));
  }

  it("warns that the stored key is not the one commands will use", async () => {
    orgResponds();
    process.env.SENSO_API_KEY = "tgr_a_different_key";
    clack.prompt.mockResolvedValue(PASTED_KEY);

    const res = await runCli(["login"]);

    expect(res.stderr).toContain("SENSO_API_KEY");
    expect(res.stderr).toContain("overrides the key just stored");
    // The fix, not just the diagnosis: logging in again is the reflex, and it
    // is exactly what does not work.
    expect(res.stderr).toContain("Logging in again will not change that");
    expect(res.stderr).toContain("unset SENSO_API_KEY");
  });

  it("points at whoami, which can say which organization they reach", async () => {
    orgResponds();
    process.env.SENSO_API_KEY = "tgr_a_different_key";
    clack.prompt.mockResolvedValue(PASTED_KEY);

    const res = await runCli(["login"]);

    expect(res.stderr).toContain("senso whoami");
  });

  it("still stores the key and exits 0 — the warning is not a failure", async () => {
    orgResponds();
    process.env.SENSO_API_KEY = "tgr_a_different_key";
    clack.prompt.mockResolvedValue(PASTED_KEY);

    const res = await runCli(["login"]);

    expect(res.exitCode).toBe(0);
    expect(storedConfig().apiKey).toBe(PASTED_KEY);
  });

  it("says nothing when the environment repeats the key with a trailing newline", async () => {
    // `SENSO_API_KEY=$(cat key.txt)` and a Docker --env-file both readily carry
    // one. The pasted key is trimmed, so an untrimmed comparison here called
    // two identical keys different and warned about nothing.
    orgResponds();
    process.env.SENSO_API_KEY = `${PASTED_KEY}\n`;
    clack.prompt.mockResolvedValue(PASTED_KEY);

    const res = await runCli(["login"]);

    expect(res.exitCode).toBe(0);
    expect(res.stderr).not.toContain("overrides the key just stored");
  });

  it("says nothing when the environment holds the same key", async () => {
    // Identical keys change no behavior, so the warning would be pure noise.
    orgResponds();
    process.env.SENSO_API_KEY = PASTED_KEY;
    clack.prompt.mockResolvedValue(PASTED_KEY);

    const res = await runCli(["login"]);

    expect(res.stderr).not.toContain("overrides the key just stored");
  });

  it("says nothing when the environment is empty, which is not a key", async () => {
    // `SENSO_API_KEY=` is what an unset CI variable expands to. It falls
    // through to the stored key, so there is nothing to warn about.
    orgResponds();
    process.env.SENSO_API_KEY = "";
    clack.prompt.mockResolvedValue(PASTED_KEY);

    const res = await runCli(["login"]);

    expect(res.stderr).not.toContain("overrides the key just stored");
  });

  it("says nothing at all when the environment is unset", async () => {
    orgResponds();
    clack.prompt.mockResolvedValue(PASTED_KEY);

    const res = await runCli(["login"]);

    expect(res.stderr).not.toContain("overrides the key just stored");
  });
});

describe("whoami, naming which source supplied the key", () => {
  function orgResponds(): void {
    server.use(http.get(apiUrl("/org/me"), () => HttpResponse.json(ORG)));
  }

  it("names the flag when --api-key supplied the key", async () => {
    orgResponds();

    const res = await runCli(["whoami", "--output", "json"]);

    expect(res.json()).toMatchObject({ apiKeySource: "flag" });
  });

  it("names the environment when it outranks the stored key", async () => {
    // The footgun in one test: a key is stored, but commands use the other one.
    orgResponds();
    writeConfig({ apiKey: "tgr_the_stored_key" });
    process.env.SENSO_API_KEY = TEST_API_KEY;

    const res = await runCli(["whoami", "--output", "json"], { withKey: false });

    expect(res.json()).toMatchObject({ apiKeySource: "env" });
  });

  it("names the config file when nothing outranks it", async () => {
    orgResponds();
    writeConfig({ apiKey: TEST_API_KEY });

    const res = await runCli(["whoami", "--output", "json"], { withKey: false });

    expect(res.json()).toMatchObject({ apiKeySource: "config" });
  });

  it("names the source next to the key in the plain rendering", async () => {
    orgResponds();
    writeConfig({ apiKey: "tgr_the_stored_key" });
    process.env.SENSO_API_KEY = TEST_API_KEY;

    const res = await runCli(["whoami"], { withKey: false });

    expect(res.stdout).toContain("SENSO_API_KEY");
  });

  it("keeps the source out of stderr — it is payload, not diagnostics", async () => {
    orgResponds();

    const res = await runCli(["whoami", "--output", "json"]);

    expect(res.stderr).toBe("");
  });
});

describe("whoami, when a key is available from more than one source", () => {
  /**
   * `login` warns about this at the time, but whoever works in that terminal
   * next never saw it — and for an agent, "the environment holds the only key"
   * and "the environment is shadowing the key this user just logged in with"
   * look identical. Both reach an organization; only one of them is what the
   * user intended.
   */
  function orgResponds(): void {
    server.use(http.get(apiUrl("/org/me"), () => HttpResponse.json(ORG)));
  }

  it("lists the shadowed source in the payload, for a caller reading JSON", async () => {
    orgResponds();
    writeConfig({ apiKey: "tgr_the_stored_key" });
    process.env.SENSO_API_KEY = TEST_API_KEY;

    const res = await runCli(["whoami", "--output", "json"], { withKey: false });

    expect(res.json()).toMatchObject({
      apiKeySource: "env",
      apiKeyShadowedSources: ["config"],
    });
  });

  it("lists both when the flag outranks an environment and a stored key", async () => {
    orgResponds();
    writeConfig({ apiKey: "tgr_the_stored_key" });
    process.env.SENSO_API_KEY = "tgr_the_env_key";

    const res = await runCli(["whoami", "--output", "json", "--api-key", TEST_API_KEY], {
      withKey: false,
    });

    expect(res.json()).toMatchObject({ apiKeyShadowedSources: ["env", "config"] });
  });

  it("says so on stderr, where a person reading the plain output will see it", async () => {
    orgResponds();
    writeConfig({ apiKey: "tgr_the_stored_key" });
    process.env.SENSO_API_KEY = TEST_API_KEY;

    const res = await runCli(["whoami"], { withKey: false });

    expect(res.stderr).toContain("More than one API key");
    expect(res.stderr).toContain("SENSO_API_KEY");
    expect(res.stderr).toContain("the config file");
  });

  /**
   * The whole point. Someone on an unexpected organization has to be able to
   * read, in one place: this is why, logging in will not fix it, and here is
   * what will.
   */
  it("says why the organization may be unexpected, and what actually changes it", async () => {
    orgResponds();
    writeConfig({ apiKey: "tgr_the_stored_key" });
    process.env.SENSO_API_KEY = TEST_API_KEY;

    const res = await runCli(["whoami"], { withKey: false });

    expect(res.stderr).toContain("not the organization you expected");
    // The reflex fix is to log in again, and that is exactly what cannot work
    // while the environment outranks the file.
    expect(res.stderr).toContain("will not change it while SENSO_API_KEY is set");
  });

  /**
   * The ordinary CI setup — one key, in the environment — must stay silent, or
   * the warning is noise on every run and gets filtered out before the one time
   * it matters.
   */
  it("stays quiet when the environment holds the only key", async () => {
    orgResponds();
    process.env.SENSO_API_KEY = TEST_API_KEY;

    const res = await runCli(["whoami"], { withKey: false });

    expect(res.stderr).not.toContain("More than one API key");
  });

  it("stays quiet when the sources agree on the same key", async () => {
    orgResponds();
    writeConfig({ apiKey: TEST_API_KEY });
    process.env.SENSO_API_KEY = TEST_API_KEY;

    const res = await runCli(["whoami"], { withKey: false });

    expect(res.stderr).not.toContain("More than one API key");
  });

  it("reports an empty list, not an absent field, when nothing is shadowed", async () => {
    // A uniform shape is a better contract for the agent doing the parsing
    // than a key that appears only sometimes.
    orgResponds();
    writeConfig({ apiKey: TEST_API_KEY });

    const res = await runCli(["whoami", "--output", "json"], { withKey: false });

    expect(res.json()).toMatchObject({ apiKeyShadowedSources: [] });
  });

  /**
   * `--output json` implies `--quiet`, and the payload already carries
   * `apiKeyShadowedSources`. Left unguarded, the warning printed ahead of the
   * JSON error object on stderr and `JSON.parse(stderr)` stopped working — the
   * machine-readable error channel, broken for the caller most likely to read
   * it.
   */
  it("stays off stderr under --output json, where the payload says it instead", async () => {
    orgResponds();
    writeConfig({ apiKey: "tgr_the_stored_key" });
    process.env.SENSO_API_KEY = TEST_API_KEY;

    const res = await runCli(["whoami", "--output", "json"], { withKey: false });

    expect(res.stderr).toBe("");
    expect(res.json()).toMatchObject({ apiKeyShadowedSources: ["config"] });
  });

  it("stays off stderr under --quiet", async () => {
    orgResponds();
    writeConfig({ apiKey: "tgr_the_stored_key" });
    process.env.SENSO_API_KEY = TEST_API_KEY;

    const res = await runCli(["whoami", "--quiet"], { withKey: false });

    expect(res.stderr).not.toContain("More than one API key");
  });

  it("leaves the JSON error on stderr parseable when the key is also rejected", async () => {
    server.use(
      http.get(apiUrl("/org/me"), () => HttpResponse.json({ error: "no" }, { status: 401 })),
    );
    writeConfig({ apiKey: "tgr_the_stored_key" });
    process.env.SENSO_API_KEY = TEST_API_KEY;

    const res = await runCli(["whoami", "--output", "json"], { withKey: false });

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
    const payload = JSON.parse(res.stderr) as { error: { code: string } };
    expect(payload.error.code).toBe("unauthorized");
  });

  it("keeps the warning off stdout, which stays parseable payload", async () => {
    orgResponds();
    writeConfig({ apiKey: "tgr_the_stored_key" });
    process.env.SENSO_API_KEY = TEST_API_KEY;

    const res = await runCli(["whoami"], { withKey: false });

    expect(res.stdout).not.toContain("More than one API key");
  });

  it("never names either key while explaining that two exist", async () => {
    orgResponds();
    const STORED = "tgr_stored_secret_never_printed";
    writeConfig({ apiKey: STORED });
    process.env.SENSO_API_KEY = TEST_API_KEY;

    const res = await runCli(["whoami"], { withKey: false });

    expect(res.stderr).not.toContain(STORED);
    expect(res.stderr).not.toContain(TEST_API_KEY);
    expect(res.stdout).not.toContain(STORED);
  });
});

describe("whoami never prints the key itself, whatever the source or format", () => {
  /**
   * The primary consumer of this CLI is an agent, and agent output is logged,
   * pasted into issues and fed back into prompts. `whoami` is the one command
   * that holds a credential and is also the one people are told to run when
   * something is wrong, so a full key reaching stdout or stderr here would leak
   * it into exactly the places a credential must never go.
   *
   * Adding the source label put new text next to the key, which is why this
   * sweeps every source against every format rather than trusting one case.
   */
  const FULL_KEY = "tgr_secret_key_that_must_never_be_printed_in_full";

  function orgResponds(): void {
    server.use(http.get(apiUrl("/org/me"), () => HttpResponse.json(ORG)));
  }

  for (const format of ["plain", "json", "table"] as const) {
    it(`redacts a key that came from the flag, as ${format}`, async () => {
      orgResponds();

      const res = await runCli(["whoami", "--api-key", FULL_KEY, "--output", format], {
        withKey: false,
      });

      expect(res.stdout).not.toContain(FULL_KEY);
      expect(res.stderr).not.toContain(FULL_KEY);
      expect(res.stdout).toContain(FULL_KEY.slice(0, 8));
    });

    it(`redacts a key that came from the environment, as ${format}`, async () => {
      orgResponds();
      process.env.SENSO_API_KEY = FULL_KEY;

      const res = await runCli(["whoami", "--output", format], { withKey: false });

      expect(res.stdout).not.toContain(FULL_KEY);
      expect(res.stderr).not.toContain(FULL_KEY);
    });

    it(`redacts a key that came from the config file, as ${format}`, async () => {
      orgResponds();
      writeConfig({ apiKey: FULL_KEY });

      const res = await runCli(["whoami", "--output", format], { withKey: false });

      expect(res.stdout).not.toContain(FULL_KEY);
      expect(res.stderr).not.toContain(FULL_KEY);
    });
  }

  it("redacts it on the offline path too, where the warning names the source", async () => {
    server.use(http.get(apiUrl("/org/me"), () => HttpResponse.error()));
    writeConfig({ apiKey: "tgr_the_stored_key", orgName: ORG.name, orgId: ORG.org_id });
    process.env.SENSO_API_KEY = FULL_KEY;

    const res = await runCli(["whoami"], { withKey: false });

    expect(res.stdout).not.toContain(FULL_KEY);
    expect(res.stderr).not.toContain(FULL_KEY);
    // The source is named by its mechanism, never by its value.
    expect(res.stderr).toContain("SENSO_API_KEY");
  });

  /**
   * `login` compares the environment key against the one just pasted to decide
   * whether to warn. Both are secrets; neither may appear in the warning.
   */
  it("keeps both keys out of the login precedence warning", async () => {
    orgResponds();
    const ENV_KEY = "tgr_env_key_that_must_never_be_printed";
    process.env.SENSO_API_KEY = ENV_KEY;
    clack.prompt.mockResolvedValue(FULL_KEY);

    const res = await runCli(["login"]);

    expect(res.stderr).toContain("overrides the key just stored");
    expect(res.stderr).not.toContain(ENV_KEY);
    expect(res.stderr).not.toContain(FULL_KEY);
    expect(res.stdout).not.toContain(ENV_KEY);
    expect(res.stdout).not.toContain(FULL_KEY);
  });
});

describe("whoami, offline with a key the cache does not describe", () => {
  /**
   * The cache was written by `login`, so it describes the STORED key. When the
   * key in use came from the environment, the cached organization may be an
   * entirely different one — the offline path is where the wrong-organization
   * confusion is at its worst, because there is no live answer to correct it.
   */
  function apiIsDown(): void {
    server.use(http.get(apiUrl("/org/me"), () => HttpResponse.error()));
  }

  it("says the cached values may name a different organization", async () => {
    apiIsDown();
    writeConfig({ apiKey: "tgr_the_stored_key", orgName: ORG.name, orgId: ORG.org_id });
    process.env.SENSO_API_KEY = TEST_API_KEY;

    const res = await runCli(["whoami"], { withKey: false });

    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain("may not be the organization the key in use belongs to");
    expect(res.stderr).toContain("SENSO_API_KEY");
  });

  /**
   * An environment variable holding the SAME key as the file is not a mismatch:
   * the cached values describe exactly the key in use. Warning there would be a
   * false alarm, which is how a real warning gets trained out of a reader.
   */
  it("does not say it when the environment merely repeats the stored key", async () => {
    apiIsDown();
    writeConfig({ apiKey: TEST_API_KEY, orgName: ORG.name, orgId: ORG.org_id });
    process.env.SENSO_API_KEY = TEST_API_KEY;

    const res = await runCli(["whoami"], { withKey: false });

    expect(res.exitCode).toBe(0);
    expect(res.stderr).not.toContain("may not be the organization");
  });

  it("does not say it when the stored key differs only by a trailing newline", async () => {
    // Same key, so the cached organization describes it exactly. An untrimmed
    // comparison here called them different and cast doubt on correct values.
    apiIsDown();
    writeConfig({ apiKey: `${TEST_API_KEY}\n`, orgName: ORG.name, orgId: ORG.org_id });
    process.env.SENSO_API_KEY = TEST_API_KEY;

    const res = await runCli(["whoami"], { withKey: false });

    expect(res.exitCode).toBe(0);
    expect(res.stderr).not.toContain("may not be the organization");
  });

  it("does not throw when the stored key is not a string", async () => {
    // The file is user-editable, so `apiKey` is only a string by convention.
    apiIsDown();
    writeConfig({ apiKey: 123 as unknown as string, orgName: ORG.name, orgId: ORG.org_id });
    process.env.SENSO_API_KEY = TEST_API_KEY;

    const res = await runCli(["whoami"], { withKey: false });

    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain("may not be the organization");
  });

  it("does not say it when the cache and the key came from the same file", async () => {
    apiIsDown();
    writeConfig({ apiKey: TEST_API_KEY, orgName: ORG.name, orgId: ORG.org_id });

    const res = await runCli(["whoami"], { withKey: false });

    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain("Could not reach the Senso API");
    expect(res.stderr).not.toContain("may not be the organization");
  });

  it("still carries the source in the cached payload", async () => {
    apiIsDown();
    writeConfig({ apiKey: "tgr_the_stored_key", orgName: ORG.name, orgId: ORG.org_id });
    process.env.SENSO_API_KEY = TEST_API_KEY;

    const res = await runCli(["whoami", "--output", "json"], { withKey: false });

    expect(res.json()).toMatchObject({ cached: true, apiKeySource: "env" });
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
    expect(res.stderr).toContain("Credentials removed.");
  });

  it("gives a JSON caller a parseable object instead of a tick", async () => {
    writeConfig({ apiKey: TEST_API_KEY });

    const res = await runCli(["logout", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.json()).toMatchObject({ ok: true, message: "Credentials removed." });
    expect(res.stderr).toBe("");
  });
});
