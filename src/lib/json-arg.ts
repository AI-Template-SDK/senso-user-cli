/**
 * Parsing and checking the `--data '{"...":"..."}'` flags.
 *
 * Roughly a third of the commands take a raw JSON body this way. Each of them
 * used to parse it inside the same try block as the API call, so a missing
 * quote and a 500 from the server produced the same exit code and the same
 * shape of message — and a shell that ate the quoting reported "Invalid JSON in
 * --data" with no indication of what to do instead.
 *
 * Parsing here separates the two: a malformed flag is a usage error (exit 2)
 * carrying a hint that shows the quoting, before any request is made.
 *
 * The schema half exists because "Invalid request body" is what the API says
 * when a required key is missing, and it never names the key. An agent that
 * cannot see which field was wrong will guess, so the CLI names the required
 * keys, names the ones it did not recognize, and refuses a body that would
 * clear a field the caller never mentioned.
 */

import { CliError, EXIT, invalidJsonError, usageError } from "./errors.js";

/**
 * What a command accepts in its `--data` object.
 *
 * `required` and `optional` together are the complete accepted set: anything
 * else is reported as unknown rather than sent, because this API ignores
 * unrecognized keys silently and a typo'd field name would otherwise look like
 * a successful write that did nothing.
 */
export interface JsonSchema {
  /** The flag this body came from, for the message. Defaults to `--data`. */
  flag?: string;
  /** Keys that must be present. */
  required?: readonly string[];
  /** Keys that may be present. */
  optional?: readonly string[];
  /** At least one of these must be present, for partial-update endpoints. */
  anyOf?: readonly string[];
  /** Refuse an empty object, for endpoints that read `{}` as "clear it all". */
  rejectEmpty?: string;
}

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
export function parseJsonFlag<T = Record<string, unknown>>(
  value: string,
  flagOrSchema: string | JsonSchema = "--data",
): T {
  const schema: JsonSchema =
    typeof flagOrSchema === "string" ? { flag: flagOrSchema } : flagOrSchema;
  const flag = schema.flag ?? "--data";

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (err) {
    throw invalidJsonError(flag, err);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CliError(`${flag} must be a JSON object.`, EXIT.USAGE, {
      code: "usage",
      field: flag,
      received: value,
      hint: `Got ${Array.isArray(parsed) ? "an array" : typeof parsed}. Example: ${flag} '{"name":"value"}'`,
    });
  }

  const body = parsed as Record<string, unknown>;
  const accepted = [
    ...(schema.required ?? []),
    ...(schema.optional ?? []),
    ...(schema.anyOf ?? []),
  ];

  if (schema.rejectEmpty && Object.keys(body).length === 0) {
    throw usageError(`${flag} is an empty object.`, {
      field: flag,
      received: value,
      hint: schema.rejectEmpty,
    });
  }

  const missing = (schema.required ?? []).filter((k) => body[k] === undefined);
  if (missing.length > 0) {
    throw usageError(
      `${flag} is missing ${missing.length === 1 ? "a required key" : "required keys"}: ${missing.join(", ")}.`,
      {
        field: flag,
        allowed: accepted.length > 0 ? accepted : undefined,
        hint:
          accepted.length > 0
            ? `Accepted keys: ${accepted.join(", ")}.`
            : `Add ${missing.join(", ")} to the object.`,
      },
    );
  }

  if (schema.anyOf && schema.anyOf.length > 0) {
    const present = schema.anyOf.filter((k) => body[k] !== undefined);
    if (present.length === 0) {
      throw usageError(`${flag} must set at least one of: ${schema.anyOf.join(", ")}.`, {
        field: flag,
        allowed: schema.anyOf,
        hint: "A partial update that names no field would change nothing.",
      });
    }
  }

  if (accepted.length > 0) {
    const unknown = Object.keys(body).filter((k) => !accepted.includes(k));
    if (unknown.length > 0) {
      throw usageError(
        `${flag} has ${unknown.length === 1 ? "an unknown key" : "unknown keys"}: ${unknown.join(", ")}.`,
        {
          field: flag,
          received: unknown.join(", "),
          allowed: accepted,
          // Silently dropped, not rejected, by the API: a typo would otherwise
          // read as a successful write that changed nothing.
          hint: `The API ignores keys it does not recognize, so this would have looked like a success. Accepted keys: ${accepted.join(", ")}.`,
        },
      );
    }
  }

  return body as T;
}
