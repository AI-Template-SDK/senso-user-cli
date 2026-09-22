/**
 * Command layer: `senso login` as a device-authorization flow.
 *
 * This is the command that turns a browser approval into a stored credential,
 * so what is worth protecting here is mostly about what must NOT happen:
 *
 *   1. **The device_code never leaves the state file.** It is a bearer secret
 *      with the same entropy as the API key it redeems. On stdout — in an
 *      agent's transcript, in a CI log — it is a credential anyone can replay
 *      for five minutes. Neither it nor the minted key may reach either stream.
 *   2. **A failure that is not an answer must not end the flow.** A 5xx or a
 *      dropped connection leaves the authorization live and approvable; giving
 *      up there throws away a login the user is in the middle of approving.
 *   3. **A 400 without an `error_code` is not `authorization_pending`.** The
 *      poll branches on the code, and the API returns plain envelopes for a
 *      rejected Content-Type and for every 500. Reading those as "keep going"
 *      is an infinite loop against a bug.
 *   4. **Terminal outcomes clean up after themselves**, or the next
 *      `--complete` reports a login that cannot be completed.
 *
 * Failure branches come first, as everywhere else in this suite. They are the
 * ones an agent has to react to, and each maps to a distinct exit code.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { server, TEST_BASE_URL } from "../setup.js";
import { apiUrl, runCli } from "../helpers.js";
import {
  getBaseUrl,
  getConfigPath,
  getDeviceAuthPath,
  type DeviceAuthState,
  type SensoConfig,
} from "../../src/lib/config.js";

/**
 * A real config directory, pinned before lib/config.ts is imported.
 *
 * Same reasoning as auth.test.ts: the module resolves SENSO_CONFIG_DIR once at
 * load, and these tests write and read two real files in it — proving the state
 * file is deleted is the whole point of half of them.
 */
const CONFIG_DIR = vi.hoisted(() => {
  const tmp = (process.env.TMPDIR ?? process.env.TEMP ?? "/tmp").replace(/[/\\]+$/, "");
  const dir = `${tmp}/senso-device-test-${process.pid}`;
  process.env.SENSO_CONFIG_DIR = dir;
  return dir;
});

/**
 * `node:os`, replaced.
 *
 * The device name is derived from the hostname and the user, and both differ on
 * every machine — including in the way that produced the bug these tests cover.
 */
const os = vi.hoisted(() => ({
  hostname: vi.fn(() => "tenz-macbook"),
  userInfo: vi.fn(() => ({ username: "tenz" })),
}));
vi.mock("node:os", async (importOriginal) => ({
  // Everything else stays real. Replacing the whole module would hand
  // `undefined` to any other `node:os` import the CLI grows later.
  ...(await importOriginal<typeof import("node:os")>()),
  hostname: os.hostname,
  userInfo: os.userInfo,
}));

/**
 * `process.platform`, pinned.
 *
 * The third input to the device name. Left to the machine, a test that expects
 * "macOS" passes on the developer's laptop and fails on the ubuntu runner — which
 * is exactly what happened. Every test that depends on it says which one.
 */
const REAL_PLATFORM = process.platform;
function onPlatform(platform: string): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

const ORG = {
  org_id: "org-device",
  name: "Acme Robotics",
  slug: "acme-robotics",
  is_free_tier: false,
};

/** The 43-character shape the API actually returns. Never printed anywhere. */
const DEVICE_CODE = "aVeryLongOpaqueDeviceCodeThatIsSecret123456";
const USER_CODE = "FXGQ-HKTG";
const VERIFY_URL = "https://app.senso.ai/cli/verify";
const MINTED_KEY = "tgr_minted_by_the_device_flow";
const KEY_EXPIRES_AT = "2026-09-28T17:04:00Z";

const originalIsTTY = process.stdin.isTTY;

function withTerminal(isTTY: boolean): void {
  process.stdin.isTTY = isTTY;
}

const stateExists = (): boolean => existsSync(getDeviceAuthPath());
const storedState = (): DeviceAuthState =>
  JSON.parse(readFileSync(getDeviceAuthPath(), "utf-8")) as DeviceAuthState;
const storedConfig = (): SensoConfig =>
  JSON.parse(readFileSync(getConfigPath(), "utf-8")) as SensoConfig;

/**
 * A pending authorization on disk, as `senso login` would have left one.
 *
 * `interval` is a tenth of a second rather than the server's five, which is
 * what makes a two-poll test finish in milliseconds. The CLI honors whatever
 * the server sent, so this is a real configuration rather than a test hook.
 */
function givenPendingLogin(overrides: Partial<DeviceAuthState> = {}): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(
    getDeviceAuthPath(),
    JSON.stringify({
      deviceCode: DEVICE_CODE,
      userCode: USER_CODE,
      verificationUri: VERIFY_URL,
      interval: 0.1,
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      baseUrl: TEST_BASE_URL,
      ...overrides,
    }),
  );
}

function authorizeReturns(body: Record<string, unknown>, status = 200): void {
  server.use(http.post(apiUrl("/device/authorize"), () => HttpResponse.json(body, { status })));
}

/** The body the CLI sent to open the flow, for asserting on device_name. */
let sentAuthorizeBody: { device_name?: string };

/** How many times the CLI opened a NEW authorization. */
let authorizeCalls: number;

function authorizeRecordingBody(): void {
  server.use(
    http.post(apiUrl("/device/authorize"), async ({ request }) => {
      sentAuthorizeBody = (await request.json()) as { device_name?: string };
      return HttpResponse.json({
        device_code: DEVICE_CODE,
        user_code: USER_CODE,
        verification_uri: VERIFY_URL,
        expires_in: 300,
        interval: 0.1,
      });
    }),
  );
}

function authorizeOk(): void {
  authorizeCalls = 0;
  server.use(
    http.post(apiUrl("/device/authorize"), () => {
      authorizeCalls += 1;
      return HttpResponse.json({
        device_code: DEVICE_CODE,
        user_code: USER_CODE,
        verification_uri: VERIFY_URL,
        expires_in: 300,
        interval: 0.1,
      });
    }),
  );
}

/** Answers the poll with each response in turn, repeating the last one. */
function tokenAnswers(...responses: { status: number; body: Record<string, unknown> }[]): void {
  let i = 0;
  server.use(
    http.post(apiUrl("/device/token"), () => {
      const next = responses[Math.min(i, responses.length - 1)]!;
      i += 1;
      return HttpResponse.json(next.body, { status: next.status });
    }),
  );
}

const PENDING = {
  status: 400,
  body: { status: 400, message: "not yet", error_code: "authorization_pending" },
};
const DENIED = {
  status: 403,
  body: { status: 403, message: "denied", error_code: "access_denied" },
};
const EXPIRED = {
  status: 400,
  body: { status: 400, message: "gone", error_code: "expired_token" },
};
const AUTHORIZED = {
  status: 200,
  body: { api_key: MINTED_KEY, org_id: ORG.org_id, org_name: ORG.name, expires_at: KEY_EXPIRES_AT },
};

function orgMeOk(): void {
  server.use(http.get(apiUrl("/org/me"), () => HttpResponse.json(ORG)));
}

beforeEach(() => {
  rmSync(CONFIG_DIR, { recursive: true, force: true });
  withTerminal(true);
  os.hostname.mockReturnValue("tenz-macbook");
  os.userInfo.mockReturnValue({ username: "tenz" });
});

afterEach(() => {
  withTerminal(originalIsTTY);
  onPlatform(REAL_PLATFORM);
  vi.clearAllMocks();
});

afterAll(() => {
  rmSync(CONFIG_DIR, { recursive: true, force: true });
});

describe("login, when the flow cannot even be opened", () => {
  it("exits 1 and names the server setting when the API has browser login turned off", async () => {
    // 503 is what an API with no DEVICE_VERIFICATION_URL answers, rather than
    // issue a code that no page could approve. It is the default state of a
    // freshly booted local backend, so the message has to say what to set.
    authorizeReturns({ status: 503, message: "not available" }, 503);

    const res = await runCli(["login"], { withKey: false });

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("browser login");
    expect(res.stderr).toContain("DEVICE_VERIFICATION_URL");
    // Nothing was opened, so nothing is pending.
    expect(stateExists()).toBe(false);
  });

  it("exits 1 on a 400 that carries no error_code, rather than treating it as pending", async () => {
    // A rejected Content-Type answers exactly like this: 400, prose, no code.
    // Read as "keep polling" it would spin forever; read as "expired" it would
    // hide a bug. It is neither.
    authorizeReturns({ status: 400, message: "Content-Type must be application/json" }, 400);

    const res = await runCli(["login"], { withKey: false });

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("Unexpected response");
    expect(stateExists()).toBe(false);
  });

  it("exits 1 when the response is missing the fields the flow needs", async () => {
    // apiRequest casts, it does not validate. Without this check a body with no
    // device_code would be written to the state file and polled with
    // `undefined` for five minutes.
    authorizeReturns({ user_code: USER_CODE, verification_uri: VERIFY_URL });

    const res = await runCli(["login"], { withKey: false });

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("device_code");
    expect(stateExists()).toBe(false);
  });
});

describe("login --complete, when there is nothing to complete", () => {
  it("exits 2 and prints the path it looked at", async () => {
    // The path is the diagnosis. An agent that hit a permission error and
    // retried `senso login` under sudo left its state file in root's config
    // directory, and this is the only clue that says so.
    const res = await runCli(["login", "--complete"], { withKey: false });

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain(getDeviceAuthPath());
    expect(res.stderr).toContain("sudo");
  });
});

describe("login --complete, when the request is refused", () => {
  it("exits 3 and stops when the approval was denied", async () => {
    givenPendingLogin();
    tokenAnswers(DENIED);

    const res = await runCli(["login", "--complete"], { withKey: false });

    expect(res.exitCode).toBe(3);
    expect(res.stderr).toContain("denied");
    // Terminal: the authorization is dead and must not be polled again.
    expect(stateExists()).toBe(false);
    expect(existsSync(getConfigPath())).toBe(false);
  });

  it("gives a JSON caller a code it can branch on for a denial", async () => {
    givenPendingLogin();
    tokenAnswers(DENIED);

    const res = await runCli(["login", "--complete", "--output", "json"], { withKey: false });

    expect(res.stderr).toContain("device_denied");
    expect(res.stdout).toBe("");
  });

  it("exits 1 and says to start over when the code expired", async () => {
    givenPendingLogin();
    tokenAnswers(EXPIRED);

    const res = await runCli(["login", "--complete"], { withKey: false });

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("expired");
    expect(res.stderr).toContain("senso login");
    expect(stateExists()).toBe(false);
  });

  it("reports a malformed request as a CLI bug rather than retrying it", async () => {
    givenPendingLogin();
    tokenAnswers({
      status: 400,
      body: { status: 400, message: "device_code is required", error_code: "invalid_request" },
    });

    const res = await runCli(["login", "--complete"], { withKey: false });

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("bug in the CLI");
  });
});

describe("login --complete, when the API is having a bad day", () => {
  it("keeps polling through a 500 and completes when it recovers", async () => {
    // The authorization is untouched by a 5xx. Stopping here would throw away a
    // login the user may be approving at that moment.
    givenPendingLogin();
    tokenAnswers({ status: 500, body: { status: 500, message: "boom" } }, AUTHORIZED);
    orgMeOk();

    const res = await runCli(["login", "--complete"], { withKey: false });

    expect(res.exitCode).toBe(0);
    expect(storedConfig().apiKey).toBe(MINTED_KEY);
  });

  it("reports the network failure rather than calling the login expired", async () => {
    // The clock has run out AND the API is unreachable. "Expired" would send
    // the user to start a new login against an API that cannot answer; the
    // connection error is the true explanation and exit 5 says "retryable".
    givenPendingLogin({ expiresAt: new Date(Date.now() - 600_000).toISOString() });
    server.use(http.post(apiUrl("/device/token"), () => HttpResponse.error()));

    const res = await runCli(["login", "--complete"], { withKey: false });

    expect(res.exitCode).toBe(5);
    expect(res.stderr).toContain("Could not reach");
  });

  it("polls at least once even when the local clock says the code is dead", async () => {
    // Expiry belongs to the server. A machine running fast must not decide a
    // live authorization is over without asking.
    givenPendingLogin({ expiresAt: new Date(Date.now() - 600_000).toISOString() });
    tokenAnswers(AUTHORIZED);
    orgMeOk();

    const res = await runCli(["login", "--complete"], { withKey: false });

    expect(res.exitCode).toBe(0);
    expect(storedConfig().apiKey).toBe(MINTED_KEY);
  });
});

describe("login --complete, on success", () => {
  it("waits through pending polls, then verifies and stores the key", async () => {
    givenPendingLogin();
    tokenAnswers(PENDING, PENDING, AUTHORIZED);
    orgMeOk();

    const res = await runCli(["login", "--complete"], { withKey: false });

    expect(res.exitCode).toBe(0);
    expect(storedConfig()).toMatchObject({
      apiKey: MINTED_KEY,
      orgId: ORG.org_id,
      orgName: ORG.name,
      orgSlug: ORG.slug,
    });
    // The flow is over; nothing is left to complete.
    expect(stateExists()).toBe(false);
  });

  it("records that this CLI minted the key, so logout may revoke it", async () => {
    givenPendingLogin();
    tokenAnswers(AUTHORIZED);
    orgMeOk();

    await runCli(["login", "--complete"], { withKey: false });

    expect(storedConfig().apiKeyProvenance).toBe("device-login");
  });

  it("names the organization it authenticated to", async () => {
    // Load-bearing, not cosmetic: an admin who guesses a pending user_code can
    // approve it against their own org, and this line is the only thing that
    // shows the victim they are now holding a key to a stranger's.
    givenPendingLogin();
    tokenAnswers(AUTHORIZED);
    orgMeOk();

    const res = await runCli(["login", "--complete"], { withKey: false });

    expect(res.stderr).toContain(ORG.name);
    expect(res.stderr).toContain("revoke");
  });

  it("says when the key expires, because a device key does", async () => {
    givenPendingLogin();
    tokenAnswers(AUTHORIZED);
    orgMeOk();

    const res = await runCli(["login", "--complete"], { withKey: false });

    expect(res.stderr).toContain("expires");
  });

  it("puts neither the minted key nor the device code on any stream", async () => {
    givenPendingLogin();
    tokenAnswers(AUTHORIZED);
    orgMeOk();

    const res = await runCli(["login", "--complete", "--output", "json"], { withKey: false });

    expect(res.stdout).not.toContain(MINTED_KEY);
    expect(res.stderr).not.toContain(MINTED_KEY);
    expect(res.stdout).not.toContain(DEVICE_CODE);
    expect(res.stderr).not.toContain(DEVICE_CODE);
    // The org is still the payload, so a caller knows where it landed.
    expect(res.json()).toMatchObject({ orgName: ORG.name, orgId: ORG.org_id });
  });

  it("polls the API the flow was opened against, not whatever is configured now", async () => {
    // `login` and `--complete` are two processes and the second may not be
    // given the same flag or environment. A poll sent elsewhere finds nothing.
    givenPendingLogin({ baseUrl: TEST_BASE_URL });
    tokenAnswers(AUTHORIZED);
    orgMeOk();

    const res = await runCli(["login", "--complete"], { withKey: false, baseUrl: false });

    expect(res.exitCode).toBe(0);
    expect(storedConfig().apiKey).toBe(MINTED_KEY);
  });
});

describe("login without a terminal", () => {
  it("prints the code and exits instead of blocking on a poll nobody can see", async () => {
    // An agent host generally surfaces stdout only once the command exits, so
    // one blocking process would hide the code until the five minutes were up.
    withTerminal(false);
    authorizeOk();

    const res = await runCli(["login"], { withKey: false });

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain(USER_CODE);
    expect(res.stdout).toContain(VERIFY_URL);
    expect(res.stdout).toContain("senso login --complete");
  });

  it("keeps the device code out of the output and in the state file", async () => {
    withTerminal(false);
    authorizeOk();

    const res = await runCli(["login"], { withKey: false });

    expect(res.stdout).not.toContain(DEVICE_CODE);
    expect(res.stderr).not.toContain(DEVICE_CODE);
    expect(storedState().deviceCode).toBe(DEVICE_CODE);
  });

  it("gives a JSON caller the fields under stable names", async () => {
    withTerminal(false);
    authorizeOk();

    const res = await runCli(["login", "--output", "json"], { withKey: false });

    expect(res.json()).toMatchObject({
      verificationUri: VERIFY_URL,
      userCode: USER_CODE,
      expiresIn: 300,
      nextCommand: "senso login --complete",
    });
  });

  it("records where to poll and how often, so --complete needs no arguments", async () => {
    withTerminal(false);
    authorizeOk();

    await runCli(["login"], { withKey: false });

    expect(storedState()).toMatchObject({
      userCode: USER_CODE,
      verificationUri: VERIFY_URL,
      interval: 0.1,
      baseUrl: TEST_BASE_URL,
    });
    expect(Date.parse(storedState().expiresAt)).toBeGreaterThan(Date.now());
  });
});

describe("login in a terminal", () => {
  it("prints the code, then waits for the approval in the same process", async () => {
    withTerminal(true);
    authorizeOk();
    tokenAnswers(PENDING, AUTHORIZED);
    orgMeOk();

    const res = await runCli(["login", "--no-browser"], { withKey: false });

    expect(res.exitCode).toBe(0);
    // The code goes to stderr here: the payload of a completed login is the
    // organization, and the code is progress on the way to it.
    expect(res.stderr).toContain(USER_CODE);
    expect(res.stderr).toContain(VERIFY_URL);
    expect(storedConfig().apiKey).toBe(MINTED_KEY);
    expect(stateExists()).toBe(false);
  });
});

describe("login --api-key, for someone who already holds one", () => {
  it("verifies and stores it without a terminal or a browser", async () => {
    // The gap this closes: `login` always prompted, so there was no way to
    // verify and persist a key non-interactively. An agent told "here is my
    // key" could only pass it per command, which breaks the moment it forgets.
    withTerminal(false);
    orgMeOk();

    const res = await runCli(["login", "--api-key", "tgr_handed_over"], { withKey: false });

    expect(res.exitCode).toBe(0);
    expect(storedConfig().apiKey).toBe("tgr_handed_over");
    // No authorization was opened: nothing needed approving.
    expect(stateExists()).toBe(false);
  });

  it("records that the key was supplied, so logout will leave it valid", async () => {
    withTerminal(false);
    orgMeOk();

    await runCli(["login", "--api-key", "tgr_handed_over"], { withKey: false });

    expect(storedConfig().apiKeyProvenance).toBe("supplied");
  });

  it("does not store a key the API rejects", async () => {
    withTerminal(false);
    server.use(
      http.get(apiUrl("/org/me"), () => HttpResponse.json({ error: "nope" }, { status: 401 })),
    );

    const res = await runCli(["login", "--api-key", "tgr_bad"], { withKey: false });

    expect(res.exitCode).toBe(3);
    expect(existsSync(getConfigPath())).toBe(false);
  });
});

describe("the name this device is approved under", () => {
  beforeEach(() => {
    sentAuthorizeBody = {};
    withTerminal(false);
  });

  it("names the user and the machine", async () => {
    authorizeRecordingBody();

    await runCli(["login"], { withKey: false });

    expect(sentAuthorizeBody.device_name).toBe("tenz@tenz-macbook");
  });

  it("discards a hostname that is an address rather than a name", async () => {
    // The bug, found by running the flow: macOS returns the network name, and
    // on a machine whose name was never set that is the MAC address. The
    // approval card then read `senso-cli 82:5b:bd:cc:62:3d`, which tells the
    // person approving it nothing at all — and telling them something is the
    // field's only job.
    os.hostname.mockReturnValue("82:5b:bd:cc:62:3d");
    onPlatform("darwin");
    authorizeRecordingBody();

    await runCli(["login"], { withKey: false });

    expect(sentAuthorizeBody.device_name).toBe("tenz (macOS)");
  });

  it.each([
    ["linux", "tenz (Linux)"],
    ["win32", "tenz (Windows)"],
    // A platform the label table does not know is still better said than
    // hidden: the raw identifier goes through.
    ["freebsd", "tenz (freebsd)"],
  ])(
    "labels the platform for a person when the hostname is useless — %s",
    async (platform, expected) => {
      os.hostname.mockReturnValue("10.0.0.7");
      onPlatform(platform);
      authorizeRecordingBody();

      await runCli(["login"], { withKey: false });

      expect(sentAuthorizeBody.device_name).toBe(expected);
    },
  );

  it("falls back to the platform alone when neither the host nor the user can be named", async () => {
    os.hostname.mockReturnValue("82:5b:bd:cc:62:3d");
    os.userInfo.mockImplementation(() => {
      throw new Error("uid not found");
    });
    onPlatform("linux");
    authorizeRecordingBody();

    await runCli(["login"], { withKey: false });

    expect(sentAuthorizeBody.device_name).toBe("Linux");
  });

  it("drops the mDNS suffix nobody calls their machine by", async () => {
    os.hostname.mockReturnValue("tenz-macbook.local");
    authorizeRecordingBody();

    await runCli(["login"], { withKey: false });

    expect(sentAuthorizeBody.device_name).toBe("tenz@tenz-macbook");
  });

  it("still sends something when the machine has no passwd entry", async () => {
    // A container running as an arbitrary UID: userInfo() throws outright.
    os.userInfo.mockImplementation(() => {
      throw new Error("uid not found");
    });
    os.hostname.mockReturnValue("runner-7f3a");
    authorizeRecordingBody();

    await runCli(["login"], { withKey: false });

    expect(sentAuthorizeBody.device_name).toBe("runner-7f3a");
  });

  it("lets the caller say it better", async () => {
    authorizeRecordingBody();

    await runCli(["login", "--device-name", "CI runner 4"], { withKey: false });

    expect(sentAuthorizeBody.device_name).toBe("CI runner 4");
  });
});

describe("what login writes to the config file", () => {
  /**
   * The bug these pin: login built a fresh object and wrote it, so everything
   * it did not name vanished — a stored baseUrl above all. The login had just
   * USED that URL to verify the key, then erased the pointer to it, and the
   * next command carried a key from one environment to another.
   */
  function givenStoredConfig(config: SensoConfig): void {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(getConfigPath(), JSON.stringify(config));
  }

  const orgAt = (baseUrl: string): void => {
    server.use(http.get(`${baseUrl}/org/me`, () => HttpResponse.json(ORG)));
  };

  beforeEach(() => {
    withTerminal(false);
  });

  it("keeps a stored baseUrl, and everything else it did not set", async () => {
    // No flag, no environment: the stored URL is what the login resolves to,
    // verifies against, and must still be pointing at afterwards.
    givenStoredConfig({
      apiKey: "tgr_old",
      baseUrl: TEST_BASE_URL,
      lastUpdateCheck: "2026-09-20T00:00:00.000Z",
      latestVersion: "0.99.0",
    });
    orgAt(TEST_BASE_URL);

    const res = await runCli(["login", "--api-key", "tgr_new"], { withKey: false, baseUrl: false });

    expect(res.exitCode).toBe(0);
    expect(storedConfig()).toMatchObject({
      apiKey: "tgr_new",
      baseUrl: TEST_BASE_URL,
      lastUpdateCheck: "2026-09-20T00:00:00.000Z",
      latestVersion: "0.99.0",
      orgName: ORG.name,
    });
  });

  it("records the API the key was verified against, not only the flag", async () => {
    // `SENSO_BASE_URL=staging senso login` mints a staging key. A later command
    // in a shell without the variable must reach staging, not production.
    process.env.SENSO_BASE_URL = TEST_BASE_URL;
    orgAt(TEST_BASE_URL);
    try {
      await runCli(["login", "--api-key", "tgr_env_bound"], { withKey: false, baseUrl: false });
    } finally {
      delete process.env.SENSO_BASE_URL;
    }

    expect(storedConfig().baseUrl).toBe(TEST_BASE_URL);
  });

  it("does not pin the default API into the file", async () => {
    // Written explicitly, today's default would outlive a future change to it
    // and strand the user on the old endpoint. Absence means "the default".
    const DEFAULT = getBaseUrl();
    orgAt(DEFAULT);

    await runCli(["login", "--api-key", "tgr_default"], { withKey: false, baseUrl: false });

    expect(storedConfig().apiKey).toBe("tgr_default");
    expect(storedConfig().baseUrl).toBeUndefined();
  });

  it("clears a stale baseUrl when logging in to the default API", async () => {
    // The mirror image: a pointer at staging must not survive a login to the
    // default, or the new key is sent to the old environment.
    const DEFAULT = getBaseUrl();
    givenStoredConfig({ apiKey: "tgr_old", baseUrl: "https://stale.example/api/v1" });
    orgAt(DEFAULT);

    await runCli(["login", "--api-key", "tgr_new"], { withKey: false, baseUrl: DEFAULT });

    expect(storedConfig().apiKey).toBe("tgr_new");
    expect(storedConfig().baseUrl).toBeUndefined();
  });
});

describe("login, when a working key is already in hand", () => {
  /**
   * `senso login` has to be safe to run twice. An agent that opens every
   * session with it, or re-runs a command it is not sure finished, must not
   * cost the user a second browser trip, a second code to type, and a second
   * seven-day key that nothing revokes. Signing in again is `logout` then
   * `login` — deliberately explicit, because that is the act that gives up a
   * credential.
   */
  function givenStoredKey(config: Partial<SensoConfig> = {}): void {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(
      getConfigPath(),
      JSON.stringify({
        apiKey: "tgr_the_key_already_here",
        apiKeyProvenance: "device-login",
        ...config,
      }),
    );
  }

  beforeEach(() => {
    withTerminal(false);
    authorizeCalls = 0;
  });

  it("does nothing, and says so, rather than opening a second flow", async () => {
    givenStoredKey();
    orgMeOk();
    authorizeOk();

    const res = await runCli(["login"], { withKey: false });

    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain("Already authenticated");
    expect(res.stderr).toContain(ORG.name);
    // The point of the whole feature: no authorization was opened, so nobody
    // was asked to approve anything.
    expect(authorizeCalls).toBe(0);
    expect(stateExists()).toBe(false);
  });

  it("tells a JSON caller it was a reuse, not a fresh sign-in", async () => {
    // An agent has to be able to tell "a human just approved something" from
    // "nothing happened", because only one of those needs reporting upward.
    givenStoredKey();
    orgMeOk();

    const res = await runCli(["login", "--output", "json"], { withKey: false });

    expect(res.json()).toMatchObject({
      orgName: ORG.name,
      orgId: ORG.org_id,
      apiKeySource: "config",
      reused: true,
    });
  });

  it("points at logout as the way to sign in as someone else", async () => {
    givenStoredKey();
    orgMeOk();

    const res = await runCli(["login"], { withKey: false });

    expect(res.stderr).toContain("senso logout");
  });

  it("checks the key commands would really send, not only the stored one", async () => {
    // SENSO_API_KEY outranks the file. Minting a new key while the environment
    // shadows it would help nobody — the new key would never be sent.
    givenStoredKey();
    process.env.SENSO_API_KEY = "tgr_from_the_environment";
    let sawKey: string | null = null;
    server.use(
      http.get(apiUrl("/org/me"), ({ request }) => {
        sawKey = request.headers.get("x-api-key");
        return HttpResponse.json(ORG);
      }),
    );
    authorizeOk();
    try {
      const res = await runCli(["login", "--output", "json"], { withKey: false });
      expect(res.json()).toMatchObject({ apiKeySource: "env", reused: true });
    } finally {
      delete process.env.SENSO_API_KEY;
    }

    expect(sawKey).toBe("tgr_from_the_environment");
    expect(authorizeCalls).toBe(0);
  });

  it("opens a flow when the key is no longer accepted", async () => {
    // Revoked, expired, or belonging to another API. This is exactly when a
    // new login is the right answer.
    givenStoredKey();
    server.use(
      http.get(apiUrl("/org/me"), () => HttpResponse.json({ error: "nope" }, { status: 401 })),
    );
    authorizeOk();

    const res = await runCli(["login"], { withKey: false });

    expect(res.exitCode).toBe(0);
    expect(authorizeCalls).toBe(1);
    expect(res.stdout).toContain(USER_CODE);
  });

  it("reports a network failure instead of starting a flow that needs the same network", async () => {
    givenStoredKey();
    server.use(http.get(apiUrl("/org/me"), () => HttpResponse.error()));
    authorizeOk();

    const res = await runCli(["login"], { withKey: false });

    expect(res.exitCode).toBe(5);
    expect(authorizeCalls).toBe(0);
  });

  it("says how long the key has left", async () => {
    // Six days and an hour, not six days exactly. The remaining time is
    // floored — a deadline should never be overstated — so a fixture sitting on
    // the boundary would read as five the moment any time passed.
    givenStoredKey({
      apiKeyExpiresAt: new Date(Date.now() + 6 * 86_400_000 + 3_600_000).toISOString(),
    });
    orgMeOk();

    const res = await runCli(["login"], { withKey: false });

    expect(res.stderr).toContain("expires in 6 days");
  });

  it("warns when the key expires within a day, which an agent will otherwise meet mid-task", async () => {
    givenStoredKey({
      apiKeyExpiresAt: new Date(Date.now() + 4 * 3_600_000 + 60_000).toISOString(),
    });
    orgMeOk();

    const res = await runCli(["login"], { withKey: false });

    expect(res.stderr).toContain("expires in 4 hours");
    expect(res.stderr).toContain("expires within a day");
    expect(res.stderr).toContain("senso logout");
  });

  it("refreshes the cached organization, so a rename does not read stale forever", async () => {
    givenStoredKey({ orgName: "The Old Name", orgSlug: "old" });
    orgMeOk();

    await runCli(["login"], { withKey: false });

    expect(storedConfig()).toMatchObject({ orgName: ORG.name, orgSlug: ORG.slug });
  });

  it("leaves an explicit --api-key to do what it says", async () => {
    // A flag is an instruction, not a hint. It replaces the stored key even
    // though that key works.
    givenStoredKey();
    orgMeOk();

    const res = await runCli(["login", "--api-key", "tgr_a_different_key"], { withKey: false });

    expect(res.exitCode).toBe(0);
    expect(storedConfig().apiKey).toBe("tgr_a_different_key");
    expect(res.stderr).not.toContain("Already authenticated");
  });

  it("warns that the key it just replaced is still live", async () => {
    // Only `logout` revokes. A device key replaced by a pasted one is
    // abandoned rather than ended, and saying so is the difference between a
    // decision and an accident.
    givenStoredKey();
    orgMeOk();

    const res = await runCli(["login", "--api-key", "tgr_a_different_key"], { withKey: false });

    expect(res.stderr).toContain("stays valid until it expires");
    expect(res.stderr).toContain("senso api-keys revoke");
  });

  it("says nothing about a replaced key that was the user's own", async () => {
    givenStoredKey({ apiKeyProvenance: "supplied" });
    orgMeOk();

    const res = await runCli(["login", "--api-key", "tgr_a_different_key"], { withKey: false });

    expect(res.stderr).not.toContain("stays valid until it expires");
  });

  it("does not leave a supplied key wearing the expiry of the device key it replaced", async () => {
    givenStoredKey({ apiKeyExpiresAt: new Date(Date.now() + 86_400_000).toISOString() });
    orgMeOk();

    await runCli(["login", "--api-key", "tgr_a_different_key"], { withKey: false });

    expect(storedConfig().apiKeyExpiresAt).toBeUndefined();
  });
});

describe("login, when a login is already waiting for approval", () => {
  /**
   * The other half of "safe to run twice": before any key exists. An agent that
   * re-runs `senso login` mid-flow used to open a second authorization and show
   * a second code, orphaning the one the user was at that moment typing in.
   */
  beforeEach(() => {
    withTerminal(false);
    authorizeCalls = 0;
  });

  it("re-prints the same code instead of opening another flow", async () => {
    givenPendingLogin();
    authorizeOk();

    const res = await runCli(["login"], { withKey: false });

    expect(res.exitCode).toBe(0);
    expect(authorizeCalls).toBe(0);
    expect(res.stdout).toContain(USER_CODE);
    expect(res.stderr).toContain("already waiting for approval");
    expect(storedState().deviceCode).toBe(DEVICE_CODE);
  });

  it("reports the time the code has left, not a fresh five minutes", async () => {
    givenPendingLogin({ expiresAt: new Date(Date.now() + 120_000).toISOString() });
    authorizeOk();

    const res = await runCli(["login", "--output", "json"], { withKey: false });

    const payload = res.json<{ expiresIn: number }>();
    expect(payload.expiresIn).toBeLessThanOrEqual(120);
    expect(payload.expiresIn).toBeGreaterThan(60);
  });

  it("opens a new flow when the pending one has run out", async () => {
    givenPendingLogin({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    authorizeOk();

    const res = await runCli(["login"], { withKey: false });

    expect(authorizeCalls).toBe(1);
    expect(res.stdout).toContain(USER_CODE);
  });

  it("ignores a pending login opened against a different API", async () => {
    // A code issued elsewhere cannot be completed here, so it is no reason to
    // skip opening one that can be.
    givenPendingLogin({ baseUrl: "https://somewhere-else.test/api/v1" });
    authorizeOk();

    await runCli(["login"], { withKey: false });

    expect(authorizeCalls).toBe(1);
  });
});
