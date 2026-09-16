/**
 * The exit-code and error-code contract.
 *
 * These values are part of the CLI's public interface: a script branches on the
 * exit code and an agent branches on `error.code`. Renaming a message is a
 * cosmetic change; changing one of these is a breaking one, and this file is
 * what makes that difference visible in a diff.
 *
 * The mapping from an HTTP status is the half worth protecting. Two decisions in
 * it are easy to get "tidied" into something worse, and both are asserted below:
 * 403 is an auth failure rather than a generic error, and 402 is not.
 */

import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/lib/api-client.js";
import {
  CliError,
  EXIT,
  ExitSignal,
  invalidJsonError,
  missingApiKeyError,
  toCliError,
} from "../../src/lib/errors.js";

describe("the exit-code table", () => {
  it("holds the documented values", () => {
    // Spelled out rather than compared to itself: this is the table README,
    // --help and the e2e suite all promise, so a change here should require
    // editing an obviously public-looking list.
    expect(EXIT).toEqual({
      OK: 0,
      ERROR: 1,
      USAGE: 2,
      AUTH: 3,
      NOT_FOUND: 4,
      NETWORK: 5,
    });
  });
});

describe("CliError", () => {
  it("defaults to a generic failure", () => {
    const err = new CliError("something went wrong");

    expect(err.exitCode).toBe(EXIT.ERROR);
    expect(err.code).toBe("error");
    expect(err.name).toBe("CliError");
  });

  it("derives a machine-readable code from the exit code when none is given", () => {
    expect(new CliError("x", EXIT.AUTH).code).toBe("unauthorized");
    expect(new CliError("x", EXIT.NOT_FOUND).code).toBe("not_found");
    expect(new CliError("x", EXIT.NETWORK).code).toBe("network");
    expect(new CliError("x", EXIT.USAGE).code).toBe("usage");
  });

  it("lets an explicit code override the derived one", () => {
    const err = new CliError("x", EXIT.AUTH, { code: "forbidden" });
    expect(err.code).toBe("forbidden");
  });

  it("keeps the underlying error reachable for debug output", () => {
    const cause = new Error("socket hang up");
    expect(new CliError("x", EXIT.NETWORK, { cause }).cause).toBe(cause);
  });
});

describe("the errors every command can raise", () => {
  it("tells an unauthenticated caller all three ways to authenticate", () => {
    const err = missingApiKeyError();

    expect(err.exitCode).toBe(EXIT.AUTH);
    expect(err.code).toBe("unauthorized");
    expect(err.hint).toContain("senso login");
    expect(err.hint).toContain("SENSO_API_KEY");
    expect(err.hint).toContain("--api-key");
  });

  it("treats malformed --data as a usage error and shows the quoting", () => {
    const err = invalidJsonError("--data");

    // Usage, not a server problem: nothing was sent. Getting this wrong sends a
    // caller looking at the API when the fault is in their shell quoting.
    expect(err.exitCode).toBe(EXIT.USAGE);
    expect(err.code).toBe("invalid_json");
    expect(err.hint).toContain("'{");
  });
});

describe("mapping an HTTP failure onto the contract", () => {
  const api = (status: number, body: unknown = {}) => new ApiError(status, "", body);

  it("maps 401 to an auth failure", () => {
    const err = toCliError(api(401));
    expect(err.exitCode).toBe(EXIT.AUTH);
    expect(err.code).toBe("unauthorized");
    expect(err.status).toBe(401);
  });

  it("maps 403 to an auth failure too, with its own code", () => {
    // Both exit 3 because a caller's response to either is to fix its
    // credential, but the codes stay distinct so a script can tell "who are
    // you" from "not you".
    const err = toCliError(api(403, { error: "insufficient scope" }));
    expect(err.exitCode).toBe(EXIT.AUTH);
    expect(err.code).toBe("forbidden");
    expect(err.message).toContain("insufficient scope");
  });

  it("maps 404 to not-found and suggests the matching list command", () => {
    const err = toCliError(api(404));
    expect(err.exitCode).toBe(EXIT.NOT_FOUND);
    expect(err.hint).toContain("list command");
  });

  it("does NOT treat 402 as an auth failure", () => {
    // The key is valid; the account is out of credits. Exiting 3 would send a
    // retry loop looking for a new credential it does not need.
    const err = toCliError(api(402));
    expect(err.exitCode).toBe(EXIT.ERROR);
    expect(err.code).toBe("insufficient_credits");
  });

  it("maps 409 to a conflict and keeps the server's explanation", () => {
    const err = toCliError(api(409, { message: "already exists" }));
    expect(err.code).toBe("conflict");
    expect(err.message).toContain("already exists");
  });

  it("maps 429 to the network family, because retrying is the right response", () => {
    const err = toCliError(api(429));
    expect(err.exitCode).toBe(EXIT.NETWORK);
    expect(err.code).toBe("rate_limited");
  });

  it("maps a 5xx to a server error whose hint says to retry", () => {
    for (const status of [500, 502, 504]) {
      const err = toCliError(api(status));
      expect(err.exitCode).toBe(EXIT.ERROR);
      expect(err.code).toBe("server_error");
      expect(err.hint).toContain("Retry");
    }
  });

  it("does not tell the caller to retry a 501 or a 503, which never will work", () => {
    // A deployment that does not offer an endpoint answers every attempt the
    // same way. Inheriting the generic 5xx "retry shortly" hint sent agents
    // into a loop against "History imports are not available for this
    // deployment" and "Evals are not enabled in this environment".
    for (const status of [501, 503]) {
      const err = toCliError(api(status, { message: "Evals are not enabled in this environment" }));
      expect(err.code).toBe("server_error");
      expect(err.message).toBe("Evals are not enabled in this environment");
      expect(err.hint).toContain("not a transient failure");
    }
  });

  it("keeps an unrecognized 4xx generic rather than guessing", () => {
    const err = toCliError(api(418, { error: "teapot" }));
    expect(err.exitCode).toBe(EXIT.ERROR);
    expect(err.code).toBe("error");
    expect(err.status).toBe(418);
  });
});

describe("mapping a transport failure onto the contract", () => {
  it("recognizes an aborted request as a timeout", () => {
    const abort = new Error("This operation was aborted");
    abort.name = "AbortError";

    const err = toCliError(abort);
    expect(err.exitCode).toBe(EXIT.NETWORK);
    expect(err.code).toBe("timeout");
  });

  it("recognizes AbortSignal.timeout's TimeoutError as well", () => {
    // Two different names reach this code path depending on whether the abort
    // came from our AbortController or from AbortSignal.timeout, and only one
    // of them was handled before.
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";

    expect(toCliError(timeout).code).toBe("timeout");
  });

  it("reads the real reason out of the cause of a bare 'fetch failed'", () => {
    // Node reports every connection-level failure as "fetch failed" with the
    // useful text on `cause`, so a mapping that only reads `message` classifies
    // a DNS failure as a generic error.
    const inner = new Error("getaddrinfo ENOTFOUND api.senso.ai");
    const outer = new Error("fetch failed", { cause: inner });

    const err = toCliError(outer);
    expect(err.exitCode).toBe(EXIT.NETWORK);
    expect(err.code).toBe("network");
    expect(err.hint).toContain("--base-url");
  });

  it("passes an already-mapped CliError through untouched", () => {
    const original = new CliError("already mapped", EXIT.USAGE);
    expect(toCliError(original)).toBe(original);
  });

  it("does not lose a value that was thrown but is not an Error", () => {
    const err = toCliError("just a string");
    expect(err.exitCode).toBe(EXIT.ERROR);
    expect(err.message).toBe("just a string");
  });
});

describe("ExitSignal", () => {
  it("carries a code and means 'say nothing'", () => {
    // --help and --version have already printed by the time this is thrown;
    // reporting it would append an error to a successful run.
    expect(new ExitSignal(EXIT.OK).exitCode).toBe(EXIT.OK);
    expect(new ExitSignal(EXIT.USAGE).exitCode).toBe(EXIT.USAGE);
  });
});
