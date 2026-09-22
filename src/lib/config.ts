/**
 * Where the API key lives.
 *
 * One small JSON file, written with mode 0600, in the platform's standard
 * configuration directory. It is plaintext, which is a deliberate decision
 * rather than an oversight — SECURITY.md records the reasoning and what would
 * have to change to use the OS keychain instead.
 */

import { readFileSync, writeFileSync, mkdirSync, unlinkSync, chmodSync, renameSync } from "node:fs";
import { basename, join } from "node:path";
import { randomBytes } from "node:crypto";
import envPaths from "env-paths";

/**
 * SENSO_CONFIG_DIR overrides the location entirely.
 *
 * It exists so the test suite and the smoke test can never read or write a real
 * developer's credentials: every test points it at a temporary directory. It is
 * also the supported way to keep separate credentials per project or per
 * environment, so it is documented rather than hidden.
 *
 * Resolved once at module load. Nothing in a single CLI invocation changes it,
 * and re-reading the environment per call invites a test that passes only
 * because of the order its cases ran in.
 */
const CONFIG_DIR = process.env.SENSO_CONFIG_DIR ?? envPaths("senso", { suffix: "" }).config;
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
/**
 * The in-flight device authorization, written by `senso login` and read by
 * `senso login --complete`.
 *
 * Beside config.json because it is the same kind of thing — a short-lived
 * secret in the directory SENSO_CONFIG_DIR already relocates — and because
 * `logout` and `uninstall` then clear it for free.
 */
const DEVICE_AUTH_FILE = join(CONFIG_DIR, "device-auth.json");

export interface SensoConfig {
  apiKey?: string;
  /**
   * Where the stored key came from, which decides what `logout` may do to it.
   *
   * `device-login` is a key this CLI minted for itself through the browser
   * flow: single-purpose, seven days long, and nobody else's — so `logout` and
   * `uninstall` revoke it rather than leave it live until it expires.
   * `supplied` is a key the user already held and handed over, possibly in use
   * elsewhere; it is only forgotten. **Absent means supplied**: a config written
   * before this field existed must never have its key revoked on a guess.
   */
  apiKeyProvenance?: "device-login" | "supplied";
  /**
   * ISO 8601, when the API said the stored key dies. Device-minted keys last
   * seven days, so `senso login` can report how long the credential it is
   * reusing has left, and an agent can see a session end coming rather than
   * meet it mid-task. Absent for a supplied key, whose expiry the CLI is never
   * told.
   */
  apiKeyExpiresAt?: string;
  baseUrl?: string;
  orgName?: string;
  orgId?: string;
  orgSlug?: string;
  isFreeTier?: boolean;
  lastUpdateCheck?: string;
  latestVersion?: string;
}

const DEFAULT_BASE_URL = "https://apiv2.senso.ai/api/v1";

/**
 * The stored configuration, or an empty object.
 *
 * A missing file is the normal first-run state, and a corrupt one is not worth
 * failing a command over — the fields are all optional and re-derivable, so the
 * useful behavior is to act as though nothing was stored.
 */
export function readConfig(): SensoConfig {
  try {
    const parsed: unknown = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
    // `JSON.parse("null")` SUCCEEDS and returns null, so the catch never sees
    // it and every `readConfig().x` in the codebase throws instead. A file
    // holding `null`, a string or an array is as unusable as a missing one —
    // and the whole point of `--api-key` and SENSO_API_KEY is to keep working
    // when the stored config is broken.
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

/**
 * Writes a file in the config directory so that only its owner can ever read it.
 *
 * Not `writeFileSync(path)`. That has three problems for a file holding a
 * credential, and one mechanism fixes all of them: write a fresh file beside
 * the target, then rename it over the top.
 *
 *   1. **It is atomic.** A plain write truncates first and fills second, so a
 *      Ctrl-C, an OOM kill or a full disk in between leaves a truncated file
 *      that reads as `{}`. For a pasted key that costs a re-login. For a key
 *      the device flow minted it is unrecoverable — the authorization was
 *      consumed to produce it and that response was the only copy. `rename`
 *      replaces the whole file or nothing.
 *   2. **It never follows a symlink.** `writeFileSync` on a path that is a
 *      symlink writes through it, so a link planted at `config.json` captures
 *      the key wherever it points. The temp file is created with `wx`
 *      (`O_CREAT|O_EXCL`), which refuses to open a symlink at all, and `rename`
 *      replaces a symlink at the destination rather than writing through it.
 *   3. **The secret is never on disk with loose permissions.** `mode` on
 *      `writeFileSync` applies only when the file is *created*, so a
 *      `config.json` left `0644` by an older version kept those bits for the
 *      write and only a later `chmod` fixed them — a window, however brief.
 *      The temp file is new, so its mode applies from the first byte.
 *
 * The rename is atomic only within one filesystem, which is why the temp file
 * lives in the same directory. On Windows a rename over a file an antivirus
 * scanner has open can fail with EPERM or EBUSY; that is retried briefly, and a
 * failure after that throws rather than falling back to a non-atomic write.
 *
 * POSIX modes are effectively ignored on Windows, where protection comes from
 * the per-user ACL on %APPDATA% instead. SECURITY.md states this rather than
 * implying a guarantee the platform does not give.
 */
function writeSecretFile(path: string, contents: string): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  try {
    // `mode` on mkdirSync applies only to directories it creates. One from an
    // older version is 0755 and would stay that way.
    chmodSync(CONFIG_DIR, 0o700);
  } catch {
    // Not ours to chmod, or a filesystem without modes. The file mode is what
    // actually protects the secret.
  }

  const tmp = join(CONFIG_DIR, `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
  writeFileSync(tmp, contents, { mode: 0o600, flag: "wx" });
  try {
    renameWithRetry(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // The rename failed and so did the cleanup; the original error is the
      // one worth reporting.
    }
    throw err;
  }
}

/**
 * `renameSync`, tolerating the transient EPERM/EBUSY Windows produces when
 * another process — typically an antivirus scanner — has the destination open.
 */
function renameWithRetry(from: string, to: string): void {
  const attempts = 5;
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const transient = code === "EPERM" || code === "EBUSY";
      if (!transient || attempt === attempts) throw err;
      // A synchronous pause. This runs once per login, not in a hot path.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40 * attempt);
    }
  }
}

export function writeConfig(config: SensoConfig): void {
  writeSecretFile(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n");
}

/**
 * Merge fields into the stored configuration.
 *
 * The read and the write are one synchronous block on purpose. The update
 * checker runs concurrently with the command that invoked it, and re-reading
 * immediately before writing is what stops it from writing back a snapshot
 * taken before `login` stored a key.
 */
export function updateConfig(partial: Partial<SensoConfig>): void {
  writeConfig({ ...readConfig(), ...partial });
}

export function clearConfig(): void {
  try {
    unlinkSync(CONFIG_FILE);
  } catch {
    // Already absent. `logout` when logged out is not an error.
  }
  // A half-finished login is a credential in progress, so `logout` ends it too.
  // `uninstall` also depends on this: it rmdir's the config directory, which
  // fails if anything is left in it.
  clearDeviceAuthState();
}

/**
 * Where a resolved API key came from.
 *
 * Part of the `whoami` payload, so these spellings are a stable interface.
 */
export type ApiKeySource = "flag" | "env" | "config";

/**
 * How each source is named to a reader. The payloads carry the bare enum; this
 * is what appears in a sentence.
 */
export const API_KEY_SOURCE_LABELS: Record<ApiKeySource, string> = {
  flag: "--api-key",
  env: "SENSO_API_KEY",
  config: "the config file",
};

export interface ResolvedApiKey {
  key?: string;
  source?: ApiKeySource;
  /**
   * Sources that also hold a key, hold a DIFFERENT one, and were outranked.
   *
   * The interesting case is someone running `senso login` in a terminal that
   * already exports SENSO_API_KEY. `login` warns at the time, but whoever works
   * in that shell next — an agent, most of all — never saw the warning and
   * cannot otherwise tell "SENSO_API_KEY is the only key here", which is the
   * normal CI setup, from "SENSO_API_KEY is quietly shadowing the key this user
   * just logged in with", which is almost always a mistake.
   *
   * Identical keys are not listed: two sources agreeing changes nothing.
   */
  shadowed: ApiKeySource[];
}

/**
 * The API key, where it came from, and what it outranked — by precedence:
 * flag, then environment, then the stored file.
 *
 * Resolved in one pass, because the whole point of reporting the source is to
 * answer "which key is this command actually using" — and two separate walks
 * down the same precedence chain are two things that can drift apart and
 * answer differently.
 *
 * A source counts only when it holds a non-empty string. `SENSO_API_KEY=` in a
 * CI environment, or `--api-key ""` from a shell variable that did not expand,
 * falls through to the next source rather than authenticating with "" and
 * producing a confusing 401.
 *
 * Every source is read rather than short-circuited at the winner, which costs
 * one small synchronous file read on a path that already does several. Knowing
 * what was outranked is the entire feature, and it cannot be known lazily.
 */
export function resolveApiKey(opts?: { apiKey?: string }): ResolvedApiKey {
  // Trimmed once, here, so a key is judged by what would actually be sent.
  // `SENSO_API_KEY=$(cat key.txt)` and a Docker --env-file both readily carry a
  // trailing newline; Node strips it from the header anyway, so an untrimmed
  // comparison reported a key as "shadowed" by an identical one and warned
  // about a conflict that did not exist. Whitespace-only is not a key at all,
  // and falls through to the next source exactly as the empty string does.
  const candidates: { source: ApiKeySource; key: string }[] = [];
  // `raw` is typed `unknown` on purpose. `SensoConfig` describes what this CLI
  // writes, not what is on disk: the file is user-editable, so `apiKey` can be
  // a number, an object or null however the type reads. Trusting the type here
  // meant `{"apiKey": 123}` threw ".trim is not a function" out of EVERY
  // command, including ones given a perfectly good key by --api-key.
  const consider = (source: ApiKeySource, raw: unknown): void => {
    if (typeof raw !== "string") return;
    const key = raw.trim();
    if (key) candidates.push({ source, key });
  };

  consider("flag", opts?.apiKey);
  consider("env", process.env.SENSO_API_KEY);
  consider("config", readConfig().apiKey);

  const winner = candidates[0];
  if (!winner) return { shadowed: [] };

  return {
    key: winner.key,
    source: winner.source,
    shadowed: candidates
      .slice(1)
      .filter((c) => c.key !== winner.key)
      .map((c) => c.source),
  };
}

export function getApiKey(opts?: { apiKey?: string }): string | undefined {
  return resolveApiKey(opts).key;
}

/* eslint-disable @typescript-eslint/prefer-nullish-coalescing --
   `||` is the correct operator below, and `??` would be a bug, for the same
   reason resolveApiKey tests truthiness: an empty string is not a usable URL,
   and `SENSO_BASE_URL=` must fall through to the next source rather than
   produce a request against "". `??` only falls through on null and undefined,
   so it would accept the empty string. */

export function getBaseUrl(opts?: { baseUrl?: string }): string {
  return opts?.baseUrl || process.env.SENSO_BASE_URL || readConfig().baseUrl || DEFAULT_BASE_URL;
}

/* eslint-enable @typescript-eslint/prefer-nullish-coalescing */

/**
 * Whether a URL is the built-in default, which `login` represents in the config
 * file as *absence*: a stored `baseUrl` means "this key belongs to a non-default
 * API", and writing the default in explicitly would pin a user to whatever it
 * happens to be today.
 */
export function isDefaultBaseUrl(url: string): boolean {
  return url === DEFAULT_BASE_URL;
}

export function getConfigPath(): string {
  return CONFIG_FILE;
}

export function getConfigDir(): string {
  return CONFIG_DIR;
}

// ── The in-flight device authorization ──────────────────────────────────────
//
// `senso login` and `senso login --complete` are two processes, and the second
// needs the device_code the first was given. It goes in a file rather than on
// stdout because stdout in an agent's shell is a transcript: a live bearer
// secret printed there outlives the five minutes it is good for, possibly in a
// model provider's logs. The file is 0600 and deleted the moment the flow ends.

/**
 * What `senso login` hands to `senso login --complete`.
 *
 * `deviceCode` is the secret. Everything else is there so `--complete` can act
 * alone: `interval` paces the poll, `expiresAt` tells it when to stop, and
 * `baseUrl` pins it to the API the authorization was opened against — reading
 * the flag or the environment again could point the second process somewhere
 * the code was never issued.
 *
 * `userCode` is stored to be *displayed*, not sent: two logins race on one path
 * and the second wins, so `--complete` printing the code it is waiting for is
 * what makes "this is not the code on my screen" visible rather than mystifying.
 */
export interface DeviceAuthState {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  interval: number;
  /** ISO 8601. A hint for when to stop polling, never a gate on starting. */
  expiresAt: string;
  baseUrl?: string;
}

export function getDeviceAuthPath(): string {
  return DEVICE_AUTH_FILE;
}

/**
 * The pending authorization, or undefined.
 *
 * Every field is checked rather than trusted. This file is as editable as
 * config.json, and a half-written or hand-edited one must read as "nothing
 * pending" — the next `senso login` then starts a clean flow, which is the
 * right answer — instead of throwing a TypeError out of `--complete` or
 * polling with `undefined` as the device code.
 */
export function readDeviceAuthState(): DeviceAuthState | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(DEVICE_AUTH_FILE, "utf-8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;

  const raw = parsed as Record<string, unknown>;
  const str = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

  const deviceCode = str(raw.deviceCode);
  const expiresAt = str(raw.expiresAt);
  // Without these two there is nothing to poll with and no way to know when to
  // give up. The rest have workable fallbacks.
  if (!deviceCode || !expiresAt || Number.isNaN(Date.parse(expiresAt))) return undefined;

  const interval = typeof raw.interval === "number" && raw.interval > 0 ? raw.interval : 5;
  const baseUrl = str(raw.baseUrl);

  return {
    deviceCode,
    userCode: str(raw.userCode),
    verificationUri: str(raw.verificationUri),
    interval,
    expiresAt,
    ...(baseUrl ? { baseUrl } : {}),
  };
}

export function writeDeviceAuthState(state: DeviceAuthState): void {
  writeSecretFile(DEVICE_AUTH_FILE, JSON.stringify(state, null, 2) + "\n");
}

export function clearDeviceAuthState(): void {
  try {
    unlinkSync(DEVICE_AUTH_FILE);
  } catch {
    // Nothing pending. Deleting what is not there is the desired end state.
  }
}

/**
 * Deletes an abandoned authorization, on any command.
 *
 * Ctrl-C during a poll, an agent that never ran `--complete`, a flow the user
 * walked away from: each leaves a file whose code is already dead. Nothing
 * dangerous — the code is single-use and five minutes old — but the next
 * `--complete` would report a pending authorization that cannot be completed.
 * Sweeping on every invocation collects them without a daemon, at the cost of
 * one read on commands that have no state file at all.
 *
 * The grace period is the point of the design. Expiry is the server's to
 * decide, and a local clock running fast would otherwise let `senso whoami`
 * delete a flow that is still live — so this reaps only what is past expiry by
 * a full TTL, and `senso login` is exempt from the sweep entirely.
 *
 * @returns whether a file was deleted, which only the tests care about.
 */
export function sweepDeviceAuthState(nowMs = Date.now()): boolean {
  const state = readDeviceAuthState();
  if (!state) return false;
  const graceMs = 5 * 60 * 1000;
  if (nowMs <= Date.parse(state.expiresAt) + graceMs) return false;
  clearDeviceAuthState();
  return true;
}
