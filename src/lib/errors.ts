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
 */

import { ApiError } from "./api-client.js";

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
  | "error";

export interface CliErrorOptions {
  /** Overrides the code derived from the exit code. */
  code?: ErrorCode;
  /** The HTTP status, when the failure came from the API. */
  status?: number;
  /** A second line offering the user something to do about it. */
  hint?: string;
  cause?: unknown;
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

  constructor(message: string, exitCode: ExitCode = EXIT.ERROR, opts: CliErrorOptions = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "CliError";
    this.exitCode = exitCode;
    this.code = opts.code ?? defaultCodeFor(exitCode);
    this.status = opts.status;
    this.hint = opts.hint;
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
    hint: `Pass a JSON object, quoted for your shell: ${flag} '{"key":"value"}'`,
    cause,
  });
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
 */
export function toCliError(err: unknown): CliError {
  if (err instanceof CliError) return err;

  if (err instanceof ApiError) {
    switch (err.status) {
      case 401:
        return new CliError("Authentication failed: the API key was rejected.", EXIT.AUTH, {
          code: "unauthorized",
          status: 401,
          hint: "Run `senso login` to store a new key, or check SENSO_API_KEY.",
          cause: err,
        });
      case 403:
        return new CliError(`Permission denied: ${err.message}`, EXIT.AUTH, {
          code: "forbidden",
          status: 403,
          hint: "This key is valid but lacks the scope for that operation. An org admin can widen it.",
          cause: err,
        });
      case 404:
        return new CliError("Not found.", EXIT.NOT_FOUND, {
          code: "not_found",
          status: 404,
          hint: "Check the ID. A list command in the same group will show what exists.",
          cause: err,
        });
      case 402:
        return new CliError(
          "Insufficient credits, or the spending limit was reached.",
          EXIT.ERROR,
          {
            code: "insufficient_credits",
            status: 402,
            hint: "Check your plan at https://app.senso.ai.",
            cause: err,
          },
        );
      case 409:
        return new CliError(`Conflict: ${err.message}`, EXIT.ERROR, {
          code: "conflict",
          status: 409,
          cause: err,
        });
      case 429:
        return new CliError("Rate limited by the Senso API.", EXIT.NETWORK, {
          code: "rate_limited",
          status: 429,
          hint: "Wait and retry. Reduce concurrency if you are running commands in a loop.",
          cause: err,
        });
      default:
        if (err.status >= 500) {
          return new CliError(
            `Senso API error (${err.status}). This is not your fault.`,
            EXIT.ERROR,
            {
              code: "server_error",
              status: err.status,
              hint: "Retry shortly. If it persists, report it with the time and the command.",
              cause: err,
            },
          );
        }
        return new CliError(`API error (${err.status}): ${err.message}`, EXIT.ERROR, {
          code: "error",
          status: err.status,
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
    const detail = err.cause instanceof Error ? err.cause.message : "";
    if (
      err.message.includes("fetch failed") ||
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
