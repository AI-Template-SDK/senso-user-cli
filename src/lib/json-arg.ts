/**
 * Parsing for the `--data '{"...":"..."}'` flags.
 *
 * Roughly a third of the commands take a raw JSON body this way. Each of them
 * used to parse it inside the same try block as the API call, so a missing
 * quote and a 500 from the server produced the same exit code and the same
 * shape of message — and a shell that ate the quoting reported "Invalid JSON in
 * --data" with no indication of what to do instead.
 *
 * Parsing here separates the two: a malformed flag is a usage error (exit 2)
 * carrying a hint that shows the quoting, before any request is made.
 */

import { CliError, EXIT, invalidJsonError } from "./errors.js";

/**
 * Parse a JSON object supplied on the command line.
 *
 * Rejects valid JSON that is not an object — `--data '[1,2]'` and `--data '"x"'`
 * parse cleanly but every endpoint taking one of these flags wants an object, so
 * they would otherwise fail at the API with a less useful message.
 */
/* T is a caller-supplied assertion about the body's shape
   (`parseJsonFlag<UpdateBody>(...)`), not something inferable from the
   arguments. The alternative is an `as UpdateBody` at every call site. */
export function parseJsonFlag<T = Record<string, unknown>>(value: string, flag = "--data"): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (err) {
    throw invalidJsonError(flag, err);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CliError(`${flag} must be a JSON object.`, EXIT.USAGE, {
      code: "usage",
      hint: `Got ${Array.isArray(parsed) ? "an array" : typeof parsed}. Example: ${flag} '{"name":"value"}'`,
    });
  }

  return parsed as T;
}
