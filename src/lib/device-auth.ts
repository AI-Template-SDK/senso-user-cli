/**
 * The device-authorization flow, as the CLI sees it.
 *
 * The credential has to be born in a browser and consumed in a terminal: only a
 * signed-in org admin may mint an API key, and an API key may not mint another
 * one. So `senso login` opens an authorization, a human approves it on a page,
 * and the CLI's poll is what turns that decision into a key — the key is minted
 * in the response to this process's own request, and nothing else ever sees it.
 *
 * Two public endpoints, and the CLI touches nothing else in the flow:
 *
 *   POST /device/authorize   opens it, once
 *   POST /device/token       polls it, every `interval` seconds
 *
 * Both are unauthenticated by necessity — the caller has no key yet, which is
 * the entire problem being solved. What makes that safe is that `/device/token`
 * accepts only the 256-bit `device_code`, which is exactly as hard to guess as
 * the key it hands over, and that the row it addresses grants nothing until a
 * human has approved it.
 *
 * **Branch on `error_code`, never on the message.** The wording is prose and may
 * be reworded; `error_code` is the contract. The one trap is that not every
 * failure carries one: a rejected Content-Type, a 503 and every 500 are plain
 * error envelopes, so "a 400 without a code" must never be read as "keep
 * polling" — that is an infinite loop against a bug.
 */

import { execFile } from "node:child_process";
import { ApiError, apiRequest } from "./api-client.js";
import { CliError, EXIT, toCliError } from "./errors.js";

/** Where the flow lives, under the same `/api/v1` prefix as everything else. */
const AUTHORIZE_PATH = "/device/authorize";
const TOKEN_PATH = "/device/token";

/** What the server sends when it has no opinion, or an unusable one. */
const DEFAULT_INTERVAL_SECONDS = 5;
const DEFAULT_EXPIRES_IN_SECONDS = 300;

/**
 * Bounds on the poll pacing.
 *
 * The server's `interval` is honored as sent — it is the protocol's pacing
 * hint and the client's job is to respect it. The floor is there so a `0` from
 * a broken or hostile server cannot turn the poll into a busy loop for five
 * minutes; the ceiling so an absurd value cannot outlive the authorization it
 * is polling for.
 */
const MIN_INTERVAL_SECONDS = 0.1;
const MAX_INTERVAL_SECONDS = 60;

/** The opened flow: what to show the human, and the secret to poll with. */
export interface DeviceAuthorization {
  /** The secret. Never printed, never logged — it is a bearer credential. */
  deviceCode: string;
  /** The eight characters the human types into the page. */
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

/** The minted key, delivered exactly once, in the response to one poll. */
export interface DeviceKey {
  apiKey: string;
  orgId: string;
  /** May be empty: the server degrades it rather than lose a minted key. */
  orgName: string;
  /** ISO 8601. Device-minted keys expire, so this is worth keeping. */
  expiresAt: string;
}

/**
 * One poll's answer.
 *
 * `transient` is the case the RFC does not name and the flow needs: a 5xx or a
 * dropped connection says nothing about the authorization, which is still live
 * and still approvable. Stopping there would throw away a flow the user is in
 * the middle of approving, so the caller keeps polling and reports the last
 * transient error only if the clock runs out.
 */
export type DevicePollResult =
  | { status: "authorized"; key: DeviceKey }
  | { status: "pending" }
  | { status: "denied" }
  | { status: "expired" }
  | { status: "transient"; error: CliError };

interface AuthorizeResponse {
  device_code?: unknown;
  user_code?: unknown;
  verification_uri?: unknown;
  expires_in?: unknown;
  interval?: unknown;
}

interface TokenResponse {
  api_key?: unknown;
  org_id?: unknown;
  org_name?: unknown;
  expires_at?: unknown;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asSeconds(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * The `error_code` the CLI branches on, if the body carries one.
 *
 * Read defensively because the responses that matter most here are the ones
 * that did not come from the device handler at all — a proxy's HTML error page,
 * a Content-Type rejection, a 502 from a load balancer.
 */
function deviceErrorCode(err: ApiError): string | undefined {
  if (typeof err.body !== "object" || err.body === null) return undefined;
  const code = (err.body as Record<string, unknown>).error_code;
  return typeof code === "string" ? code : undefined;
}

/**
 * A response from the device endpoints that this client does not understand.
 *
 * Distinct from every other failure on purpose: it means the CLI and the API
 * disagree about the protocol — a missing `error_code`, an unknown one, a
 * `--base-url` pointing at something that is not the Senso API — and the useful
 * reaction is to report it rather than to retry it.
 */
function unexpectedDeviceResponse(path: string, err: ApiError): CliError {
  return new CliError(
    `Unexpected response from ${path} (HTTP ${String(err.status)}): ${err.message}`,
    EXIT.ERROR,
    {
      code: "error",
      status: err.status,
      hint: "Check --base-url, or SENSO_BASE_URL, points at a Senso API. If it does, this is a bug worth reporting with the status above.",
      cause: err,
    },
  );
}

/**
 * Opens an authorization. Public: no credential is sent, because none exists.
 *
 * The 503 is worth its own message. It means the server has no
 * DEVICE_VERIFICATION_URL configured, so it refuses to issue a code that no
 * page could ever approve — which is the default state of a freshly booted
 * local backend, and the first thing anyone developing against one will hit.
 */
export async function startDeviceAuthorization(opts: {
  deviceName?: string;
  baseUrl?: string;
}): Promise<DeviceAuthorization> {
  let res: AuthorizeResponse;
  try {
    res = await apiRequest<AuthorizeResponse>({
      method: "POST",
      path: AUTHORIZE_PATH,
      // Always an object, never undefined: the endpoint requires
      // `Content-Type: application/json`, and api-client only sets that header
      // when there is a body to send.
      body: opts.deviceName ? { device_name: opts.deviceName } : {},
      auth: "none",
      baseUrl: opts.baseUrl,
    });
  } catch (err) {
    if (err instanceof ApiError && err.status === 503) {
      throw new CliError("This Senso API has browser login turned off.", EXIT.ERROR, {
        code: "error",
        status: 503,
        hint: "The server needs DEVICE_VERIFICATION_URL set to the page where the code is approved. Until then, authenticate with `senso login --api-key <key>` or SENSO_API_KEY.",
        cause: err,
      });
    }
    if (err instanceof ApiError && err.status < 500) {
      throw unexpectedDeviceResponse(AUTHORIZE_PATH, err);
    }
    throw toCliError(err);
  }

  const deviceCode = asString(res.device_code);
  const userCode = asString(res.user_code);
  const verificationUri = asString(res.verification_uri);

  // `apiRequest<T>` casts, it does not validate. A body missing any of these
  // would otherwise be written to the state file and polled with `undefined`,
  // failing five minutes later with something unrecognizable.
  if (!deviceCode || !userCode || !verificationUri) {
    throw new CliError(`${AUTHORIZE_PATH} answered without the fields to continue.`, EXIT.ERROR, {
      code: "error",
      hint: "Expected device_code, user_code and verification_uri. Check --base-url points at a Senso API.",
    });
  }

  return {
    deviceCode,
    userCode,
    verificationUri,
    expiresIn: asSeconds(res.expires_in, DEFAULT_EXPIRES_IN_SECONDS),
    interval: clampInterval(asSeconds(res.interval, DEFAULT_INTERVAL_SECONDS)),
  };
}

export function clampInterval(seconds: number): number {
  return Math.min(Math.max(seconds, MIN_INTERVAL_SECONDS), MAX_INTERVAL_SECONDS);
}

/**
 * One poll.
 *
 * Every outcome the caller can act on is a returned value; everything else
 * throws. `invalid_request` is in the second group deliberately — it means this
 * client sent a body the server could not read, which no amount of retrying
 * fixes and which the user cannot do anything about, so it surfaces as the bug
 * it is rather than as a flow that quietly never completes.
 */
export async function pollDeviceToken(opts: {
  deviceCode: string;
  baseUrl?: string;
}): Promise<DevicePollResult> {
  let res: TokenResponse;
  try {
    res = await apiRequest<TokenResponse>({
      method: "POST",
      path: TOKEN_PATH,
      body: { device_code: opts.deviceCode },
      auth: "none",
      baseUrl: opts.baseUrl,
    });
  } catch (err) {
    if (err instanceof ApiError) {
      switch (deviceErrorCode(err)) {
        case "authorization_pending":
          return { status: "pending" };
        case "access_denied":
          return { status: "denied" };
        // One code for three states — past five minutes, already used, never
        // issued. The server will not say which, and the CLI cannot act on the
        // difference: all three mean start over.
        case "expired_token":
          return { status: "expired" };
        case "invalid_request":
          throw new CliError(`${TOKEN_PATH} rejected the request as malformed.`, EXIT.ERROR, {
            code: "error",
            status: err.status,
            hint: "The CLI sent a body the API could not read. This is a bug in the CLI — please report it.",
            cause: err,
          });
      }
      // No error_code. A 5xx is the API failing rather than answering, and a
      // 429 is it asking for patience — in both cases the authorization is
      // untouched and the next poll is worth making. Anything else — a
      // Content-Type rejection, a proxy, a wrong base URL — is a protocol
      // disagreement that will not fix itself.
      //
      // 429 is here on purpose although nothing rate-limits these endpoints
      // today: the PRD defers the limit rather than rules it out, and the day
      // it lands a client that reads it as a failed login would be the bug.
      if (err.status >= 500 || err.status === 429) {
        return { status: "transient", error: toCliError(err) };
      }
      throw unexpectedDeviceResponse(TOKEN_PATH, err);
    }

    // A dropped connection or a timeout. Same reasoning as a 5xx: the row is
    // still there, and the next poll is seconds away.
    const mapped = toCliError(err);
    if (mapped.exitCode === EXIT.NETWORK) return { status: "transient", error: mapped };
    throw mapped;
  }

  const apiKey = asString(res.api_key);
  if (!apiKey) {
    // The one unrecoverable failure in the flow: the row is consumed and this
    // response was the only copy of the key. Say so plainly — a retry will get
    // `expired_token` and the user needs to know why.
    throw new CliError(`${TOKEN_PATH} answered without an API key.`, EXIT.ERROR, {
      code: "error",
      hint: "The authorization was consumed, so this code cannot be reused. Run `senso login` again.",
    });
  }

  return {
    status: "authorized",
    key: {
      apiKey,
      orgId: asString(res.org_id),
      orgName: asString(res.org_name),
      expiresAt: asString(res.expires_at),
    },
  };
}

/**
 * Opens the verification page, best-effort.
 *
 * Never awaited, never fatal, and never the only way to reach the page: the URL
 * and the code are on screen whatever happens here. Headless machines, an agent
 * with no session bus, and a locked-down container all land in the catch, and
 * none of them is a failed login.
 *
 * `execFile`, not `exec`: no shell means the URL is one argument rather than
 * something a shell re-parses. On Windows that rules out `cmd /c start`, whose
 * argument handling is exactly the problem — `rundll32` takes the URL whole.
 */
export function openBrowser(url: string): void {
  // Only ever a web page. This URL comes from the server's configuration, and
  // handing an arbitrary scheme to the OS opener is how "open the page" becomes
  // "run the thing".
  if (!/^https?:\/\//i.test(url)) return;

  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];

  try {
    // The callback is not optional in practice: without one, a missing opener
    // raises an unhandled 'error' event on the child and takes the CLI down
    // with it — on precisely the headless machines where it is missing.
    const child = execFile(command, args, () => undefined);
    // Do not hold the event loop open waiting for a browser to exit.
    child.unref();
  } catch {
    // Spawning failed outright. The URL is already on screen.
  }
}
