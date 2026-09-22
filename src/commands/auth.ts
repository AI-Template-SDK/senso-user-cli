import { Command } from "commander";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { accessSync, constants, mkdirSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { apiRequest } from "../lib/api-client.js";
import {
  readConfig,
  writeConfig,
  updateConfig,
  clearConfig,
  clearDeviceAuthState,
  readDeviceAuthState,
  writeDeviceAuthState,
  getDeviceAuthPath,
  resolveApiKey,
  getBaseUrl,
  getConfigDir,
  getConfigPath,
  isDefaultBaseUrl,
  API_KEY_SOURCE_LABELS,
  type ApiKeySource,
  type DeviceAuthState,
  type SensoConfig,
} from "../lib/config.js";
import {
  clampInterval,
  openBrowser,
  pollDeviceToken,
  revokeStoredDeviceKey,
  startDeviceAuthorization,
  type DeviceKey,
} from "../lib/device-auth.js";
import { CliError, EXIT, toCliError } from "../lib/errors.js";
import { emit, emitConfirmation } from "../lib/output.js";
import { runAction, type Ctx } from "../lib/run-action.js";
import { banner } from "../utils/branding.js";
import * as log from "../utils/logger.js";

interface OrgMeResponse {
  org_id: string;
  name: string;
  slug: string;
  is_free_tier: boolean;
  [key: string]: unknown;
}

async function verifyApiKey(apiKey: string, baseUrl?: string): Promise<OrgMeResponse> {
  return apiRequest<OrgMeResponse>({
    path: "/org/me",
    apiKey,
    baseUrl,
  });
}

function sourceSuffix(source: ApiKeySource | undefined): string {
  return source ? pc.dim(` (from ${API_KEY_SOURCE_LABELS[source]})`) : "";
}

/** How the platform reads on an approval card seen by a person. */
const OS_LABELS: Record<string, string> = {
  darwin: "macOS",
  win32: "Windows",
  linux: "Linux",
};

/**
 * How this device is labeled on the approval page and on the key it mints.
 *
 * Display-only, and the page says so: it is self-reported by a caller holding
 * no credential, so it can say anything. Its only job is to help a person
 * decide whether the request in front of them is the terminal they just typed
 * in — which is why what it says matters even though nothing trusts it.
 *
 * The hostname alone is not good enough. On macOS `os.hostname()` returns the
 * network name, and on a machine whose name was never set that is the MAC
 * address or an IP — the approval card then reads `senso-cli
 * 82:5b:bd:cc:62:3d`, which tells the approver nothing. So an address-shaped
 * hostname is discarded in favor of the user and the platform, which always
 * say something.
 */
function defaultDeviceName(): string | undefined {
  const host = usableHostname();
  const user = safely(() => userInfo().username.trim());
  const os = OS_LABELS[process.platform] ?? process.platform;

  if (host) return user ? `${user}@${host}` : host;
  return user ? `${user} (${os})` : os;
}

/** The hostname, unless it is an address rather than a name. */
function usableHostname(): string {
  // `.local` is mDNS decoration, not part of what anyone calls the machine.
  const host = safely(() =>
    hostname()
      .trim()
      .replace(/\.local$/i, ""),
  );
  if (!host) return "";
  const isMacAddress = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(host);
  const isIpAddress = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  return isMacAddress || isIpAddress ? "" : host;
}

/**
 * Runs a lookup that has no business failing a login.
 *
 * `os.userInfo()` throws when the user has no passwd entry, which happens in a
 * container running as an arbitrary UID — a place this CLI is expected to work.
 */
function safely(read: () => string): string {
  try {
    return read();
  } catch {
    return "";
  }
}

/**
 * Whether a credential can be stored here at all — checked before anything is
 * opened server-side.
 *
 * No HOME, a read-only filesystem, a locked-down container: `login` cannot do
 * its job in any of them, and finding out afterwards means having minted a key
 * that cannot be saved and must not be printed. So the check runs first, and
 * the flow never starts.
 *
 * The PRD's alternative was to fall back to a single blocking process here.
 * That assumes the key can go somewhere the user can reach it, and the one
 * place left is stdout — which is the thing this whole design exists to avoid.
 * Failing with the path and the variable that fixes it is the better trade.
 */
function assertConfigDirWritable(): void {
  try {
    mkdirSync(getConfigDir(), { recursive: true, mode: 0o700 });
    accessSync(getConfigDir(), constants.W_OK);
  } catch (err) {
    throw new CliError(`Cannot write to the config directory: ${getConfigDir()}`, EXIT.ERROR, {
      code: "error",
      hint: "`login` stores the key it obtains, so it needs a writable directory. Set SENSO_CONFIG_DIR to one, or use SENSO_API_KEY per shell instead of logging in.",
      cause: err,
    });
  }
}

/**
 * The warning that outlives login: the environment outranks the file.
 *
 * Someone who exports SENSO_API_KEY and then logs in has stored a key that no
 * command will use. Only a *different* key is worth saying anything about —
 * the same key from two sources changes nothing.
 */
function warnIfEnvKeyShadows(apiKey: string): void {
  const envKey = (process.env.SENSO_API_KEY ?? "").trim();
  if (envKey && envKey !== apiKey) {
    log.warn(
      "SENSO_API_KEY is set in this environment and overrides the key just stored, so commands will keep using it and not the key you logged in with. Logging in again will not change that: unset SENSO_API_KEY to use the stored key, or set it to the key you want. Run `senso whoami` to see which organization commands reach.",
    );
  }
}

/**
 * Verify a key against `/org/me`, then store it. The only way a key is written.
 *
 * Verify-then-write, never the reverse: a key that does not work must not reach
 * disk, or every later command fails with a 401 the user cannot explain.
 */
async function storeVerifiedKey(
  ctx: Ctx,
  apiKey: string,
  opts: PersistOptions & { baseUrl?: string } = {},
): Promise<void> {
  const org = await verifyApiKey(apiKey, opts.baseUrl ?? ctx.baseUrl);
  persistVerifiedKey(ctx, apiKey, org, opts);
}

interface PersistOptions {
  /**
   * The API the key was verified against, when it was not the `--base-url`
   * flag: the device flow pins its poll to the URL the authorization was opened
   * on, and that — not whatever the flag says now — is where the key works.
   */
  baseUrl?: string;
  /** When the minted key dies. Device-flow keys expire; pasted ones may not. */
  keyExpiresAt?: string;
  /** Adds the line that makes a confused-deputy approval visible. */
  fromDeviceFlow?: boolean;
}

/**
 * Writes the verified key and says what happened.
 *
 * Split from the verification so the interactive path can keep its spinner
 * around the network call without this function knowing anything about clack.
 */
function persistVerifiedKey(
  ctx: Ctx,
  apiKey: string,
  org: OrgMeResponse,
  opts: PersistOptions = {},
): void {
  // Merge, never replace. The old write built a fresh object, which silently
  // dropped everything it did not name — a stored `baseUrl` most of all. The
  // login itself had just used that URL to verify the key, then erased the
  // pointer to it, so the next command went to production carrying a key from
  // somewhere else. (It also reset the update-check cache, which was harmless
  // but pointless.)
  //
  // What login records about the API is the URL the key was *verified against*,
  // resolved the same way the request was, not the `--base-url` flag alone. A
  // key belongs to the environment that minted it: `SENSO_BASE_URL=staging
  // senso login` stores a staging key, and a later command without the variable
  // must not send it to production. The default is represented as absence, so
  // logging in to the default API clears a stale pointer rather than pinning
  // the current default into the file for good.
  const verifiedAgainst = getBaseUrl({ baseUrl: opts.baseUrl ?? ctx.baseUrl });
  const previous = readConfig();
  const next: SensoConfig = {
    ...previous,
    apiKey,
    // Recorded here because this is the only place a key is ever written, and
    // it is the one moment the CLI knows where the key came from. `logout`
    // reads it to decide whether the key is its to revoke.
    apiKeyProvenance: opts.fromDeviceFlow ? "device-login" : "supplied",
    orgName: org.name,
    orgId: org.org_id,
    orgSlug: org.slug,
    isFreeTier: org.is_free_tier,
  };
  if (isDefaultBaseUrl(verifiedAgainst)) {
    delete next.baseUrl;
  } else {
    next.baseUrl = verifiedAgainst;
  }
  // Absence means "not known to expire". A supplied key inheriting the expiry
  // of the device key it replaced would report a deadline that is not its own.
  if (opts.keyExpiresAt) {
    next.apiKeyExpiresAt = opts.keyExpiresAt;
  } else {
    delete next.apiKeyExpiresAt;
  }
  writeConfig(next);

  // The single confirmation: the ✓ line in plain output, the payload under
  // --output json. Everything after it is prose for a person, and is suppressed
  // when nobody is reading prose.
  emitConfirmation(ctx, `Authenticated as "${org.name}" (${org.org_id})`, {
    orgId: org.org_id,
    orgName: org.name,
    orgSlug: org.slug,
    isFreeTier: org.is_free_tier,
    ...(opts.keyExpiresAt ? { apiKeyExpiresAt: opts.keyExpiresAt } : {}),
    configPath: getConfigPath(),
  });

  if (!ctx.quiet) {
    log.dim(`Config saved to ${getConfigPath()}`);

    // Not decoration. An admin who guesses a pending user_code can approve it
    // against their OWN organization, and the victim's CLI would then hold a
    // key to a stranger's org without anything looking wrong. The name on
    // screen is the only thing that shows it, which is why it is printed even
    // when nothing is suspicious.
    if (opts.fromDeviceFlow) {
      log.dim(
        `If "${org.name}" is not your organization, revoke that key now: senso api-keys list`,
      );
    }
    if (opts.keyExpiresAt) {
      log.info(
        `This key expires ${formatExpiry(opts.keyExpiresAt)}. Run \`senso logout\`, then \`senso login\`, to renew it.`,
      );
    }
  }

  // Replacing a key this CLI minted, without going through the flow that would
  // have reused it — so nothing revoked the old one. Only `logout` revokes, by
  // design, and a key nobody holds any more is exactly the kind that
  // accumulates unnoticed.
  if (
    !opts.fromDeviceFlow &&
    previous.apiKeyProvenance === "device-login" &&
    previous.apiKey !== apiKey
  ) {
    log.warn(
      "This replaced a key that `senso login` had minted. That key stays valid until it expires — revoke it with `senso api-keys revoke <id>` if you want it gone now.",
    );
  }

  // Warnings, not commentary: both survive --quiet, because each describes a
  // problem the caller has to act on rather than progress it can ignore.
  warnIfEnvKeyShadows(apiKey);
}

/**
 * `senso login` when a working credential is already in hand.
 *
 * The reason this exists is that `login` should be safe to run twice. An agent
 * that opens every session with it, or one that re-runs a command it is not
 * sure finished, should get "you are already signed in" — not a second browser
 * trip, a second code for the user to type, and a second seven-day key that
 * nothing revokes. `login` is for re-authenticating and for switching
 * organizations; everything else is already done.
 *
 * The key it checks is the one commands would actually send — `SENSO_API_KEY`
 * outranks the stored file — because minting a key the environment would then
 * shadow is the one outcome that helps nobody.
 *
 * @returns whether the CLI is already authenticated and there is nothing to do.
 */
async function reuseWorkingKey(ctx: Ctx): Promise<boolean> {
  const { key, source } = resolveApiKey();
  if (!key || !source) return false;

  let org: OrgMeResponse;
  try {
    org = await verifyApiKey(key, ctx.baseUrl);
  } catch (err) {
    const mapped = toCliError(err);
    // Rejected: the key is dead, revoked, or belongs to another API. That is
    // exactly when a new login is the right answer, so fall through to it.
    if (mapped.exitCode === EXIT.AUTH) return false;
    // Anything else — offline, a 500 — is not evidence about the key, and a
    // device flow needs the same network this check just failed on. Say what
    // happened instead of starting something that cannot finish.
    throw mapped;
  }

  const config = readConfig();
  const expiresAt = typeof config.apiKeyExpiresAt === "string" ? config.apiKeyExpiresAt : undefined;
  // Only for the stored key: these fields describe what `login` put there, and
  // a key from the environment is not ours to write a cache for. Refreshed so a
  // renamed organization does not read stale in `whoami` forever.
  if (source === "config") {
    updateConfig({
      orgName: org.name,
      orgId: org.org_id,
      orgSlug: org.slug,
      isFreeTier: org.is_free_tier,
    });
  }

  // The confirmation first, and only once. It is the ✓ line in plain output and
  // the payload under --output json, so a second log.success saying the same
  // thing is duplication a reader has to parse twice.
  emitConfirmation(ctx, `Already authenticated as "${org.name}" (${org.org_id})`, {
    orgId: org.org_id,
    orgName: org.name,
    orgSlug: org.slug,
    isFreeTier: org.is_free_tier,
    apiKeySource: source,
    ...(expiresAt ? { apiKeyExpiresAt: expiresAt } : {}),
    configPath: getConfigPath(),
    // The one field that distinguishes this from a fresh login, for a caller
    // that needs to know whether a human was just asked to approve something.
    reused: true,
  });

  // Prose for a person. Suppressed under --quiet and --output json, which
  // implies it: everything below is in the payload above, and an agent told to
  // ignore three lines of commentary is three lines of commentary too many.
  if (!ctx.quiet) {
    log.dim(
      `Key from ${API_KEY_SOURCE_LABELS[source]}${expiresAt ? `, ${remaining(expiresAt)}` : ""}`,
    );
    log.dim(
      source === "env"
        ? "Unset SENSO_API_KEY to use a different credential."
        : "To sign in as a different organization, run `senso logout` first.",
    );
  }

  // A warning, not commentary, so it survives --quiet: an agent starting a long
  // task on a key with hours left will meet the expiry mid-way, and the fix
  // takes a human. The exact timestamp is in the payload either way.
  if (expiresAt && expiringSoon(expiresAt)) {
    log.warn(
      "That key expires within a day. Run `senso logout`, then `senso login`, to replace it before it does.",
    );
  }
  return true;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function expiringSoon(iso: string): boolean {
  const ms = Date.parse(iso);
  return !Number.isNaN(ms) && ms - Date.now() < DAY_MS;
}

/** "expires in 6 days", in the largest unit that is still honest. */
function remaining(iso: string): string {
  const ms = Date.parse(iso) - Date.now();
  if (Number.isNaN(ms)) return `expires ${iso}`;
  if (ms <= 0) return "expired";
  const days = Math.floor(ms / DAY_MS);
  if (days >= 1) return `expires in ${String(days)} day${days === 1 ? "" : "s"}`;
  const hours = Math.floor(ms / (60 * 60 * 1000));
  if (hours >= 1) return `expires in ${String(hours)} hour${hours === 1 ? "" : "s"}`;
  const minutes = Math.max(1, Math.floor(ms / 60_000));
  return `expires in ${String(minutes)} minute${minutes === 1 ? "" : "s"}`;
}

/** An ISO timestamp as a date, or as itself if the server sent something else. */
function formatExpiry(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? `on ${iso}` : `on ${new Date(ms).toLocaleDateString()}`;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** How far past the stored expiry the poll keeps trying. One full TTL. */
const SKEW_GRACE_MS = 5 * 60 * 1000;

/**
 * Polls until the authorization resolves, or until its five minutes are up.
 *
 * Three rules worth stating, because each fixes a way this could go wrong:
 *
 *   - **At least one poll, always.** The deadline is a local clock reading of a
 *     server-side expiry. A machine running fast must not decide a live flow is
 *     dead without asking; `expired_token` from the server is the authority.
 *   - **A transient failure is not an answer.** A 5xx or a dropped connection
 *     leaves the authorization exactly as it was, so polling continues and the
 *     error is only reported if the clock runs out with nothing better to say.
 *   - **Ctrl-C cleans up.** Without the signal handler every interrupted login
 *     leaves a state file behind, which is the most common way the next
 *     `--complete` finds a stale one.
 */
async function pollUntilResolved(args: {
  deviceCode: string;
  baseUrl?: string;
  intervalSeconds: number;
  /** The server's expiry, read by the local clock. A backstop, not a gate. */
  expiresAtMs: number;
}): Promise<DeviceKey> {
  const intervalMs = args.intervalSeconds * 1000;
  // The server decides expiry, and it says so with `expired_token`. This
  // deadline only stops the loop if that answer never comes, so it carries a
  // full TTL of slack: a local clock running fast must not end a flow the user
  // is in the middle of approving.
  const deadlineMs =
    (Number.isNaN(args.expiresAtMs) ? Date.now() : args.expiresAtMs) + SKEW_GRACE_MS;
  let lastTransient: CliError | undefined;

  const onSignal = (signal: NodeJS.Signals): void => {
    clearDeviceAuthState();
    process.removeListener(signal, onSignal);
    // Re-raise rather than exit: src/cli.ts is the only file allowed to end
    // the process, and the default handler is what produces the right code.
    process.kill(process.pid, signal);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    for (;;) {
      const result = await pollDeviceToken({ deviceCode: args.deviceCode, baseUrl: args.baseUrl });

      switch (result.status) {
        case "authorized":
          clearDeviceAuthState();
          return result.key;
        case "denied":
          clearDeviceAuthState();
          throw new CliError("The login request was denied in the browser.", EXIT.AUTH, {
            code: "device_denied",
            hint: "Nothing was granted. If that was not you, someone else has the code from this login — start a new one with `senso login` and approve only that one.",
          });
        case "expired":
          clearDeviceAuthState();
          throw expiredAuthorizationError();
        case "pending":
          lastTransient = undefined;
          break;
        case "transient":
          // Remembered, not thrown: the row is untouched and the next poll is
          // seconds away. It becomes the reported failure only if time runs out
          // while the API is still unreachable, which is a truer explanation
          // than "expired".
          lastTransient = result.error;
          break;
      }

      if (Date.now() + intervalMs >= deadlineMs) {
        clearDeviceAuthState();
        throw lastTransient ?? expiredAuthorizationError();
      }
      await sleep(intervalMs);
    }
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
}

function expiredAuthorizationError(): CliError {
  return new CliError("This login request expired before it was approved.", EXIT.ERROR, {
    code: "device_expired",
    hint: "Codes last five minutes, and each one can be used once. Run `senso login` for a new one.",
  });
}

interface LoginOptions {
  complete?: boolean;
  interactive?: boolean;
  deviceName?: string;
  /** `--no-browser` arrives as `browser: false`; absent means "open it". */
  browser?: boolean;
}

/**
 * Paste a key at a prompt. The escape hatch, unchanged.
 *
 * For anyone who already holds a key and cannot open a browser. It still needs
 * a terminal, because it still prompts — `--api-key` is the way to store a key
 * without one.
 */
async function interactiveLogin(ctx: Ctx): Promise<void> {
  // Without a terminal there is nobody to answer the prompt, and clack waits on
  // a keypress that will never arrive. Only `--interactive` fails here now: a
  // bare `senso login` treats the absence of a TTY as the signal to split into
  // two processes rather than as an error.
  if (!process.stdin.isTTY) {
    throw new CliError("`senso login --interactive` needs an interactive terminal.", EXIT.USAGE, {
      code: "usage",
      hint: "Run `senso login` for browser approval, pass --api-key to store a key you hold, or set SENSO_API_KEY in the environment.",
    });
  }

  banner();

  log.raw(`  ${pc.bold("Welcome to Senso CLI!")}\n`);
  log.raw(`  ${pc.dim("1.")} Go to ${pc.cyan("https://docs.senso.ai")} to create an account`);
  log.raw(`  ${pc.dim("2.")} Generate an API key from your dashboard\n`);

  // `password`, not `text`: clack redraws the prompt into stdout on every
  // keystroke, so `text` wrote the whole key there one character at a time —
  // `senso login > install.log`, a CI capture or an asciinema recording would
  // persist the credential. `password` masks it.
  const result = await p.password({
    message: "Paste your API key:",
    validate: (val) => {
      if (!val || val.trim().length < 4) return "API key is required";
    },
  });

  // `isCancel` narrows to clack's unique cancel symbol, which does not remove
  // `symbol` from the union — hence the explicit typeof, which both satisfies
  // the compiler and is true rather than an `as string` cast.
  if (p.isCancel(result) || typeof result !== "string") {
    p.cancel("Login canceled.");
    return;
  }

  const apiKey = result.trim();
  const spin = p.spinner();
  spin.start("Verifying API key...");

  let org: OrgMeResponse;
  try {
    org = await verifyApiKey(apiKey, ctx.baseUrl);
  } catch (err) {
    // Stop the spinner before the error surfaces, or the terminal is left with
    // a spinning frame and a hidden cursor.
    spin.stop("Verification failed");
    throw err;
  }
  spin.stop("API key verified");

  persistVerifiedKey(ctx, apiKey, org);
}

/**
 * Open an authorization and either wait for it or hand it off.
 *
 * The TTY check does not choose the mechanism — browser approval is what both
 * humans and agents do, so there is one flow to maintain and one set of bugs.
 * All it chooses is the process shape: a terminal streams output, so one
 * process can print the code and then block on it; an agent host typically
 * surfaces stdout only after the command exits, so the same shape would hide
 * the code until the five minutes had run out.
 */
async function startDeviceLogin(ctx: Ctx, opts: LoginOptions): Promise<void> {
  // Before the network call, not after: this is what stops the CLI opening an
  // authorization server-side that it could never have completed.
  assertConfigDirWritable();

  const baseUrl = getBaseUrl({ baseUrl: ctx.baseUrl });

  // A login already waiting for approval is reused rather than replaced.
  // Without this, an agent that runs `senso login` twice — because it is not
  // sure the first one finished — orphans the code the user is at that moment
  // typing into the browser, and shows them a second one with no explanation.
  const pending = livePendingAuthorization(baseUrl);
  const auth = pending
    ? {
        deviceCode: pending.deviceCode,
        userCode: pending.userCode,
        verificationUri: pending.verificationUri,
        interval: clampInterval(pending.interval),
        // What is left of the five minutes, not five minutes again.
        expiresIn: Math.max(1, Math.round((Date.parse(pending.expiresAt) - Date.now()) / 1000)),
      }
    : await startDeviceAuthorization({
        deviceName: opts.deviceName ?? defaultDeviceName(),
        baseUrl: ctx.baseUrl,
      });
  const expiresAt = pending
    ? pending.expiresAt
    : new Date(Date.now() + auth.expiresIn * 1000).toISOString();

  if (pending) {
    log.dim("A login is already waiting for approval. This is the same code.");
  } else {
    // The resolved base URL, not the flag: `--complete` is a different process
    // and may not be given the same flag or environment, and a poll sent to a
    // different API than the one that issued the code finds nothing there.
    writeDeviceAuthState({
      deviceCode: auth.deviceCode,
      userCode: auth.userCode,
      verificationUri: auth.verificationUri,
      interval: auth.interval,
      expiresAt,
      baseUrl,
    });
  }

  if (!process.stdin.isTTY) {
    // Here the code IS the payload — it is the entire result of this
    // invocation, and the caller is a program that has to read it. The
    // device_code never appears: it is a bearer secret and belongs only in the
    // state file.
    emit(
      ctx,
      {
        verificationUri: auth.verificationUri,
        userCode: auth.userCode,
        expiresIn: auth.expiresIn,
        expiresAt,
        nextCommand: "senso login --complete",
      },
      {
        plain: [
          "",
          `  Open ${auth.verificationUri} and enter the code ${auth.userCode}`,
          `  The code expires in ${String(Math.round(auth.expiresIn / 60))} minutes.`,
          "",
          `  Then run: senso login --complete`,
          "",
        ],
      },
    );
    return;
  }

  announceCode(auth.verificationUri, auth.userCode, auth.expiresIn);
  if (opts.browser !== false) openBrowser(auth.verificationUri);

  const key = await pollUntilResolved({
    deviceCode: auth.deviceCode,
    baseUrl,
    intervalSeconds: auth.interval,
    expiresAtMs: Date.parse(expiresAt),
  });
  await storeVerifiedKey(ctx, key.apiKey, {
    baseUrl,
    keyExpiresAt: key.expiresAt,
    fromDeviceFlow: true,
  });
}

/**
 * The pending authorization this `login` should reuse, if there is one.
 *
 * Live by the local clock, and opened against the API this login would use — a
 * code issued somewhere else cannot be completed here, so it is not a reason to
 * skip opening one that can be.
 */
function livePendingAuthorization(baseUrl: string): DeviceAuthState | undefined {
  const state = readDeviceAuthState();
  if (!state) return undefined;
  if (!state.userCode || !state.verificationUri) return undefined;
  if (Date.parse(state.expiresAt) <= Date.now()) return undefined;
  if ((state.baseUrl ?? baseUrl) !== baseUrl) return undefined;
  return state;
}

/** The half of the flow that waits, when `login` and the wait are two commands. */
async function completeDeviceLogin(ctx: Ctx): Promise<void> {
  const state = readDeviceAuthState();
  if (!state) {
    // The path is in the message on purpose. An agent that hit a permission
    // error and retried `senso login` under sudo wrote its state file into
    // root's config directory, and this unelevated process cannot see it —
    // naming the path it looked at is what makes that self-diagnosing.
    throw new CliError("There is no login waiting to be completed.", EXIT.USAGE, {
      code: "usage",
      hint: `Nothing was found at ${getDeviceAuthPath()}. Run \`senso login\` first — and if that ran under sudo, run both halves the same way.`,
    });
  }

  // Two logins race on one state file and the last write wins, which orphans
  // the first. Printing the code being waited on is what makes that visible
  // rather than mystifying: it will not match the one on screen.
  if (state.userCode) {
    log.info(`Waiting for approval of code ${pc.bold(state.userCode)}`);
  }
  if (state.verificationUri) {
    log.dim(`Approve it at ${state.verificationUri}`);
  }

  const baseUrl = ctx.baseUrl ?? state.baseUrl;
  const key = await pollUntilResolved({
    deviceCode: state.deviceCode,
    baseUrl,
    intervalSeconds: clampInterval(state.interval),
    expiresAtMs: Date.parse(state.expiresAt),
  });
  await storeVerifiedKey(ctx, key.apiKey, {
    baseUrl,
    keyExpiresAt: key.expiresAt,
    fromDeviceFlow: true,
  });
}

/** The code and the URL, on stderr, where a human can act on them. */
function announceCode(verificationUri: string, userCode: string, expiresIn: number): void {
  log.raw("");
  log.raw(`  ${pc.bold("Approve this device to finish signing in.")}`);
  log.raw("");
  log.raw(`    1. Open   ${pc.cyan(verificationUri)}`);
  log.raw(`    2. Enter  ${pc.bold(userCode)}`);
  log.raw("");
  log.dim(`The code expires in ${String(Math.round(expiresIn / 60))} minutes. Waiting...`);
}

export function registerAuthCommands(program: Command): void {
  program
    .command("login")
    .description(
      "Authenticate this device. Does nothing if the key you already have still works — run `senso logout` first to sign in as a different organization. Otherwise it opens a Senso page where an org admin approves this device in a browser, and stores the key that mints. Use --api-key to store a key you already hold.",
    )
    .option(
      "--complete",
      "Finish a login started earlier: wait for the browser approval and store the key.",
    )
    .option("--interactive", "Paste an existing API key at a prompt instead. Needs a terminal.")
    .option("--device-name <name>", "How this device is labeled on the approval page.")
    .option("--no-browser", "Do not try to open the approval page automatically.")
    .action(
      runAction(program, async (ctx, opts: LoginOptions) => {
        // Order is the contract: an explicit flag always beats the default. The
        // device flow is what a bare `senso login` does, for a human and for an
        // agent alike — see the comment on startDeviceLogin.
        if (opts.complete) return completeDeviceLogin(ctx);
        if (opts.interactive) return interactiveLogin(ctx);
        if (ctx.apiKey) return storeVerifiedKey(ctx, ctx.apiKey);
        // Reuse before minting. A bare `senso login` with a credential that
        // already works is a no-op, so running it twice costs nothing and
        // asks the user for nothing. An explicit flag above says otherwise and
        // is obeyed; `logout` is how you give the current key up.
        if (await reuseWorkingKey(ctx)) return;
        return startDeviceLogin(ctx, opts);
      }),
    );

  program
    .command("logout")
    .description(
      "Remove the stored API key and organization info. A key that `senso login` minted through the browser is revoked first; a key you supplied yourself is only forgotten.",
    )
    .action(
      runAction(program, async (ctx) => {
        // Revoke before delete: once the file is gone the key cannot be
        // revoked, and a device-minted key nobody can reach is exactly the
        // "fifty dead keys a year" the seven-day expiry was meant to bound.
        const revocation = await revokeStoredDeviceKey({ baseUrl: ctx.baseUrl });
        clearConfig();

        if (revocation.attempted && !revocation.revoked) {
          log.warn(
            `The key was removed from this machine but could not be revoked: ${revocation.reason} It stays valid until it expires — device keys last seven days — so revoke it from the dashboard if that matters.`,
          );
        }

        const revoked = revocation.attempted && revocation.revoked;
        const message = !revoked
          ? "Credentials removed."
          : revocation.alreadyInvalid
            ? "Credentials removed. The key was already invalid."
            : "Key revoked and credentials removed.";
        emitConfirmation(ctx, message, {
          ok: true,
          message,
          keyRevoked: revoked,
          ...(revocation.attempted && !revocation.revoked ? { reason: revocation.reason } : {}),
        });
      }),
    );

  program
    .command("whoami")
    .description(
      "Show which organization you are authenticated as, including org ID, slug, tier, and API key prefix.",
    )
    .action(
      runAction(program, async (ctx) => {
        // Resolved together so the reported source is the source of the key
        // this command actually used, not a second guess at the same chain.
        const { key: apiKey, source, shadowed } = resolveApiKey({ apiKey: ctx.apiKey });

        if (!apiKey) {
          throw new CliError("Not authenticated: no API key found.", EXIT.AUTH, {
            code: "unauthorized",
            hint: "Run `senso login`, set SENSO_API_KEY, or pass --api-key.",
          });
        }

        const config = readConfig();

        // Whoever runs this may not be whoever set the key up. Someone runs
        // `senso login` in a terminal that already exports SENSO_API_KEY, sees
        // the warning, and then hands the shell to an agent that never saw it —
        // from there, "which key am I using" and "is another one being ignored"
        // are different questions, and only the second explains a surprise.
        // Suppressed under --output json, which implies --quiet; the payload
        // carries `apiKeyShadowedSources` for that caller instead.
        if (shadowed.length > 0 && source && !ctx.quiet) {
          const ignored = shadowed.map((sh) => API_KEY_SOURCE_LABELS[sh]).join(" and ");
          log.warn(
            `More than one API key is available here: ${API_KEY_SOURCE_LABELS[source]} takes precedence, and the key in ${ignored} is being ignored. If this is not the organization you expected, that is why — and running \`senso login\` will not change it while ${API_KEY_SOURCE_LABELS[source]} is set.`,
          );
        }

        try {
          const org = await verifyApiKey(apiKey, ctx.baseUrl);
          emit(
            ctx,
            {
              orgId: org.org_id,
              orgName: org.name,
              orgSlug: org.slug,
              isFreeTier: org.is_free_tier,
              // A prefix, never the key. `whoami` is the command people paste
              // into a support thread.
              apiKeyPrefix: apiKey.slice(0, 8) + "...",
              // Which of the three sources supplied that key. `login` writes
              // the config file but the environment outranks it, so "which
              // organization" is only half an answer without "and why".
              apiKeySource: source,
              // Always present, empty when there is no conflict. A field that
              // is sometimes absent and sometimes an array is a worse contract
              // for the agent doing the parsing than one that is always there.
              apiKeyShadowedSources: shadowed,
              configPath: getConfigPath(),
            },
            {
              plain: [
                "",
                `  ${pc.bold("Organization:")}  ${org.name}`,
                `  ${pc.bold("Org ID:")}        ${org.org_id}`,
                `  ${pc.bold("Slug:")}          ${org.slug}`,
                `  ${pc.bold("Tier:")}          ${org.is_free_tier ? "Free" : "Paid"}`,
                `  ${pc.bold("API Key:")}       ${apiKey.slice(0, 8)}...${sourceSuffix(source)}`,
                `  ${pc.bold("Config:")}        ${getConfigPath()}`,
                "",
              ],
            },
          );
        } catch (err) {
          // Offline, or the API is down. If a previous login cached the org
          // there is still something true to say, and saying it beats failing —
          // "which org am I pointed at" is answerable without the network.
          //
          // But NOT when the key itself was rejected. Falling back on a 401
          // meant a revoked key printed a cached organization and exited 0, from
          // the one command whose entire job is to say whether you are
          // authenticated.
          const mapped = toCliError(err);
          if (mapped.exitCode === EXIT.AUTH) throw mapped;
          if (!config.orgName) throw err;

          log.warn("Could not reach the Senso API. Showing the last known values.");
          // The cache was written by `login`, so it describes the STORED key.
          // The test is whether the key in use IS that stored key — not whether
          // a source was shadowed. An environment variable repeating the stored
          // key is not a mismatch and must not warn; a config holding a cached
          // org but no key at all (hand-edited) is one, and shadowing misses it.
          // `typeof` rather than trusting `SensoConfig`: the file is
          // user-editable, so `apiKey` is only a string by convention.
          const storedKey = typeof config.apiKey === "string" ? config.apiKey.trim() : "";
          if (storedKey !== apiKey) {
            log.warn(
              "The organization above was cached by `senso login`, which stored the key that is being ignored, so it may not be the organization the key in use belongs to.",
            );
          }
          emit(
            ctx,
            {
              orgId: config.orgId,
              orgName: config.orgName,
              orgSlug: config.orgSlug,
              isFreeTier: config.isFreeTier,
              apiKeyPrefix: apiKey.slice(0, 8) + "...",
              apiKeySource: source,
              apiKeyShadowedSources: shadowed,
              configPath: getConfigPath(),
              cached: true,
            },
            {
              plain: [
                "",
                `  ${pc.bold("Organization:")}  ${config.orgName} ${pc.dim("(cached)")}`,
                `  ${pc.bold("Org ID:")}        ${config.orgId ?? pc.dim("unknown")}`,
                `  ${pc.bold("API Key:")}       ${apiKey.slice(0, 8)}...${sourceSuffix(source)}`,
                `  ${pc.bold("Config:")}        ${getConfigPath()}`,
                "",
              ],
            },
          );
        }
      }),
    );
}
