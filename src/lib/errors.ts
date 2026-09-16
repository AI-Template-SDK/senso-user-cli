/**
 * The error and exit-code contract.
 *
 * Scripts and agents branch on exit codes, so they are part of this CLI's public
 * interface in the same way its JSON payloads are. Changing one is a breaking
 * change; adding one is not.
 *
 * Before this existed, every failure exited 1 — a missing flag, an expired key,
 * a deleted record and a DNS failure were indistinguishable to a caller, so the
 * only way to react to one of them was to grep an English sentence off stderr.
 *
 * The second half of the contract is the STRUCTURE of a failure, and it exists
 * for the same reason. An agent cannot act on prose. So every CliError can carry
 * the flag at fault, what it received, what would have been accepted, the
 * request that produced it, and whatever machine-readable detail the API sent —
 * and `reportError` puts all of it in the JSON error object. A message may be
 * reworded freely; `error.code` and the field names below may not.
 */

import { ApiError } from "./api-client.js";
import { readConfig } from "./config.js";
import { describeResource, type ResourceRef } from "./resource.js";

export const EXIT = {
  /** The command did what was asked. */
  OK: 0,
  /** The API or the runtime refused. The message says why. */
  ERROR: 1,
  /**
   * The command line was wrong: unknown command, missing argument, bad flag.
   * Commander already exits 2 for these, so this constant records the value
   * rather than choosing it — moving it would fight the framework.
   */
  USAGE: 2,
  /** No credential, or the credential was rejected. 401 and 403 land here. */
  AUTH: 3,
  /** The thing addressed does not exist. 404. */
  NOT_FOUND: 4,
  /** The API was unreachable, or took too long. Retrying may work. */
  NETWORK: 5,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/**
 * A stable, machine-readable label for the failure.
 *
 * This is what `--output json` puts in `error.code`. It exists so a caller can
 * switch on a value that will not change when someone rewords the message.
 */
export type ErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "insufficient_credits"
  | "rate_limited"
  | "server_error"
  | "network"
  | "timeout"
  | "usage"
  | "invalid_json"
  /** The request was well-formed but the API rejected its contents (400/422). */
  | "validation"
  | "error";

/** The request that produced a failure, echoed so a caller can see what ran. */
export interface RequestRef {
  method: string;
  path: string;
}

export interface CliErrorOptions {
  /** Overrides the code derived from the exit code. */
  code?: ErrorCode;
  /** The HTTP status, when the failure came from the API. */
  status?: number;
  /** A second line offering the user something to do about it. */
  hint?: string;
  cause?: unknown;
  /** The flag or argument at fault: "--status", "<id>", "text". */
  field?: string;
  /** What the caller actually passed, as they passed it. */
  received?: string;
  /** Every value that would have been accepted. */
  allowed?: readonly string[];
  /** Machine-readable detail from the API body (field errors, ids, counts). */
  details?: unknown;
  /** The request that produced this, when one was made. */
  request?: RequestRef;
  /**
   * The command path ("kb get"), for failures raised before a context exists.
   *
   * `runAction` knows the command for anything a handler throws. Commander's
   * own failures happen before that, so the translation layer records it here
   * and the reporter prefers it over the empty string.
   */
  command?: string;
}

/**
 * Every expected failure in a command is one of these.
 *
 * Commands throw; `runAction` catches, reports on stderr in whatever format the
 * user asked for, and sets the exit code. Nothing in a command calls
 * `process.exit` — an action that exits cannot be tested in-process, and the
 * ESLint config enforces that.
 */
export class CliError extends Error {
  readonly exitCode: ExitCode;
  readonly code: ErrorCode;
  readonly status?: number;
  readonly hint?: string;
  readonly field?: string;
  readonly received?: string;
  readonly allowed?: readonly string[];
  readonly details?: unknown;
  readonly request?: RequestRef;
  readonly command?: string;

  constructor(message: string, exitCode: ExitCode = EXIT.ERROR, opts: CliErrorOptions = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "CliError";
    this.exitCode = exitCode;
    this.code = opts.code ?? defaultCodeFor(exitCode);
    this.status = opts.status;
    this.hint = opts.hint;
    this.field = opts.field;
    this.received = opts.received;
    this.allowed = opts.allowed;
    this.details = opts.details;
    this.request = opts.request;
    this.command = opts.command;
  }
}

function defaultCodeFor(exitCode: ExitCode): ErrorCode {
  switch (exitCode) {
    case EXIT.AUTH:
      return "unauthorized";
    case EXIT.NOT_FOUND:
      return "not_found";
    case EXIT.NETWORK:
      return "network";
    case EXIT.USAGE:
      return "usage";
    default:
      return "error";
  }
}

/**
 * "Stop with this code, and say nothing."
 *
 * Commander handles `--help` and `--version` by printing and then exiting. With
 * `exitOverride` installed — which this CLI needs in order to exit 2 rather than
 * 1 on a usage error — that exit becomes a throw, and the bin entry would
 * otherwise report "(outputHelp)" as though it were a failure. This carries the
 * intended code past the reporting layer untouched, so the one file allowed to
 * end the process stays the only one that does.
 */
export class ExitSignal extends Error {
  readonly exitCode: ExitCode;

  constructor(exitCode: ExitCode) {
    super(`exit ${String(exitCode)}`);
    this.name = "ExitSignal";
    this.exitCode = exitCode;
  }
}

/** The error every command hits first: no credential anywhere. */
export function missingApiKeyError(): CliError {
  return new CliError("Not authenticated: no API key found.", EXIT.AUTH, {
    code: "unauthorized",
    hint: "Run `senso login`, set SENSO_API_KEY, or pass --api-key.",
  });
}

/** A `--data` flag that was not JSON. Usage, not a server problem. */
export function invalidJsonError(flag: string, cause?: unknown): CliError {
  return new CliError(`Invalid JSON in ${flag}.`, EXIT.USAGE, {
    code: "invalid_json",
    field: flag,
    hint: `Pass a JSON object, quoted for your shell: ${flag} '{"key":"value"}'`,
    cause,
  });
}

/**
 * A usage error that names the flag, the value and the accepted set.
 *
 * The shape every client-side validation failure should take, so that an agent
 * reading `error.allowed` never has to parse a sentence to learn what to send.
 */
export function usageError(
  message: string,
  opts: {
    field?: string;
    received?: string;
    allowed?: readonly string[];
    hint?: string;
    command?: string;
  } = {},
): CliError {
  return new CliError(message, EXIT.USAGE, { code: "usage", ...opts });
}

/** " in organization acme", when a login cached the slug. Empty otherwise. */
function orgSuffix(): string {
  const slug = readConfig().orgSlug;
  return slug ? ` in organization ${slug}` : "";
}

/**
 * The API said 404, and we know what was being addressed.
 *
 * Built here rather than at 150 call sites so the wording cannot drift, and so
 * the hint always names a real command.
 */
export function notFoundError(ref: ResourceRef, opts: CliErrorOptions = {}): CliError {
  const hint =
    opts.hint ??
    (ref.list
      ? `List them with \`${ref.list}\`.`
      : "Check the id. A list command in the same group will show what exists.");
  return new CliError(`${describeResource(ref)} not found${orgSuffix()}.`, EXIT.NOT_FOUND, {
    code: "not_found",
    status: 404,
    field: ref.idField,
    received: ref.id,
    hint,
    ...opts,
  });
}

/**
 * What a 403 actually means, which is four different things.
 *
 * The old message — "This key is valid but lacks the scope for that operation.
 * An org admin can widen it." — is right for one of them and actively
 * misleading for the other three. A product entitlement is a billing question,
 * a KB node grant is fixed with `kb permissions add`, and a partner route
 * simply cannot be reached with an organization key.
 */
function forbiddenHint(apiMessage: string, ref?: ResourceRef): string {
  const m = apiMessage.toLowerCase();
  if (/product|entitle/.test(m)) {
    return "This organization does not have the product this endpoint belongs to. Check the plan at https://app.senso.ai.";
  }
  if (m.includes("partner")) {
    return "This route needs a partner API key. For the same data under your own key, use `senso industries`.";
  }
  if (/knowledge base|kb node/.test(m) || (ref?.type ?? "").toLowerCase().includes("kb node")) {
    return "Access to a knowledge base node is granted per node. Ask an editor to run `senso kb permissions add <id> --grantee-type user --grantee-id <you> --role editor`.";
  }
  return "This key is valid but lacks the scope for that operation. An org admin can widen it.";
}

/**
 * Maps anything thrown anywhere into the contract.
 *
 * The HTTP mapping is the interesting half. 401 and 403 are both authentication
 * failures from a caller's point of view — one says "who are you", the other
 * says "not you" — and a script's reaction to either is to fix its credential,
 * so both exit 3 while keeping distinct codes. 402 is deliberately not an auth
 * failure: the key is fine, the account is out of credits, and retrying with a
 * different key is the wrong response.
 *
 * Every branch now passes the API's own message through. Replacing it with a
 * fixed sentence was the single largest loss of information in this CLI: a 404
 * became "Not found." with the id dropped, a 409 lost `existing_content_id`,
 * and a deployment saying "Evals are not enabled in this environment" was
 * answered with "retry shortly", advice that can never work.
 */
export function toCliError(err: unknown): CliError {
  if (err instanceof CliError) return err;

  if (err instanceof ApiError) {
    const ref = err.resource;
    const request = err.request;
    const details = bodyDetails(err.body);

    switch (err.status) {
      case 401:
        return new CliError(`Authentication failed: ${err.message}`, EXIT.AUTH, {
          code: "unauthorized",
          status: 401,
          hint: "Run `senso login` to store a new key, or check SENSO_API_KEY.",
          details,
          request,
          cause: err,
        });
      case 403:
        return new CliError(`Permission denied: ${err.message}`, EXIT.AUTH, {
          code: "forbidden",
          status: 403,
          hint: forbiddenHint(err.message, ref),
          details,
          request,
          cause: err,
        });
      case 404:
        if (ref) {
          return notFoundError(ref, { details, request, cause: err });
        }
        return new CliError(`Not found: ${err.message}`, EXIT.NOT_FOUND, {
          code: "not_found",
          status: 404,
          hint: "Check the id. A list command in the same group will show what exists.",
          details,
          request,
          cause: err,
        });
      case 402:
        return new CliError(`Insufficient credits: ${err.message}`, EXIT.ERROR, {
          code: "insufficient_credits",
          status: 402,
          hint: "Check the balance with `senso credits balance`, or your plan at https://app.senso.ai.",
          details,
          request,
          cause: err,
        });
      case 409:
        return new CliError(`Conflict: ${err.message}`, EXIT.ERROR, {
          code: "conflict",
          status: 409,
          // The 409 body is the point: an upload conflict carries
          // existing_content_id, which is the id the caller needs next.
          details,
          request,
          cause: err,
        });
      case 400:
      case 422:
        return new CliError(`The API rejected the request: ${err.message}`, EXIT.ERROR, {
          code: "validation",
          status: err.status,
          details,
          request,
          cause: err,
        });
      case 429:
        return new CliError("Rate limited by the Senso API.", EXIT.NETWORK, {
          code: "rate_limited",
          status: 429,
          hint: "Wait and retry. Reduce concurrency if you are running commands in a loop.",
          details,
          request,
          cause: err,
        });
      case 501:
      case 503:
        // A deployment-level refusal. Retrying is precisely what will not work,
        // so this must never inherit the 5xx "try again later" hint.
        return new CliError(err.message, EXIT.ERROR, {
          code: "server_error",
          status: err.status,
          hint: "This deployment does not offer that endpoint. It is not a transient failure.",
          details,
          request,
          cause: err,
        });
      default:
        if (err.status >= 500) {
          return new CliError(`Senso API error (${err.status}): ${err.message}`, EXIT.ERROR, {
            code: "server_error",
            status: err.status,
            hint: "This is a server-side failure. Retry shortly; if it persists, report it with the time and the command.",
            details,
            request,
            cause: err,
          });
        }
        return new CliError(`API error (${err.status}): ${err.message}`, EXIT.ERROR, {
          code: "error",
          status: err.status,
          details,
          request,
          cause: err,
        });
    }
  }

  if (err instanceof Error) {
    // fetch() aborts surface as an AbortError or a TimeoutError depending on
    // whether the abort came from our AbortController or from AbortSignal.timeout.
    if (err.name === "AbortError" || err.name === "TimeoutError") {
      return new CliError("The request timed out.", EXIT.NETWORK, {
        code: "timeout",
        hint: "Check your connection, or retry — the API may be slow right now.",
        cause: err,
      });
    }
    // Node reports every connection-level failure as a bare "fetch failed" with
    // the real reason on `cause`, so the cause is where the useful text is.
    // "Failed to fetch" is the same failure worded the other way — it is what
    // the WHATWG spec text says, and what a non-undici fetch implementation or a
    // test double raises. Matching only Node's wording meant an equivalent
    // failure exited 1 and a caller lost the retry signal that exit 5 carries.
    const detail = err.cause instanceof Error ? err.cause.message : "";
    if (
      /fetch failed|failed to fetch|network ?error/i.test(err.message) ||
      /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET/.test(detail)
    ) {
      return new CliError("Could not reach the Senso API.", EXIT.NETWORK, {
        code: "network",
        hint: "Check your internet connection, and --base-url if you set one.",
        cause: err,
      });
    }
    return new CliError(err.message, EXIT.ERROR, { cause: err });
  }

  return new CliError(String(err), EXIT.ERROR);
}

/**
 * The machine-readable half of an API error body.
 *
 * Everything but the message the CliError already carries: field-level errors,
 * `existing_content_id` on a conflict, `valid_models` and `suggestions` on a
 * rejected model list. `extractErrorMessage` reduces the body to one sentence
 * for humans; this keeps the rest for the caller that can act on it.
 */
function bodyDetails(body: unknown): unknown {
  if (typeof body !== "object" || body === null) return undefined;
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    // The prose fields are already the CliError's message.
    if (key === "error" || key === "message" || key === "detail" || key === "status") continue;
    rest[key] = value;
  }
  return Object.keys(rest).length > 0 ? rest : undefined;
}
