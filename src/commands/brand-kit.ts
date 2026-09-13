import { Command } from "commander";
import { apiRequest } from "../lib/api-client.js";
import { CliError, EXIT } from "../lib/errors.js";
import { parseJsonFlag } from "../lib/json-arg.js";
import { emit } from "../lib/output.js";
import { runAction } from "../lib/run-action.js";
import * as log from "../utils/logger.js";

/** The `guidelines` fields that must be strings. `null` is rejected for each. */
const GUIDELINE_STRING_FIELDS = [
  "brand_name",
  "brand_domain",
  "brand_description",
  "voice_and_tone",
  "author_persona",
] as const;

/**
 * Every key `guidelines` accepts. The API holds the same closed list and 400s on
 * anything else, so this is a mirror of a server-side allowlist rather than a
 * rule of the CLI's own — see the note on `parseBrandKitData`.
 */
const GUIDELINE_FIELDS: readonly string[] = [...GUIDELINE_STRING_FIELDS, "global_writing_rules"];

const FIELD_LIST = GUIDELINE_FIELDS.join(", ");

const SET_EXAMPLE = `--data '{"guidelines":{"brand_name":"Acme","voice_and_tone":"Warm and direct"}}'`;

/** "a number", "null", "an array" — so a message can name what was actually sent. */
function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}

/**
 * The closest accepted field to a misspelling, when there is an obvious one.
 *
 * Capped at an edit distance of 2, which covers the realistic slips
 * (`brand_nme`, `voice_and_tones`, `author_person`) without proposing a rename
 * for a field the caller invented outright — "did you mean brand_name?" in
 * response to `mascot` is worse than no suggestion at all.
 */
function nearest(key: string, allowed: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = 3;

  for (const candidate of allowed) {
    const distance = editDistance(key, candidate);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }

  return best;
}

/**
 * Levenshtein distance, two-row.
 *
 * Every index read is in range by construction — the loops are bounded by the
 * lengths the rows were built from — but `noUncheckedIndexedAccess` cannot see
 * that, so each one carries a `?? 0` that never fires.
 */
function editDistance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      next.push(
        Math.min(
          (row[j] ?? 0) + 1,
          (next[j - 1] ?? 0) + 1,
          (row[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
        ),
      );
    }
    row = next;
  }

  return row[b.length] ?? 0;
}

function usageError(message: string, hint: string): CliError {
  return new CliError(message, EXIT.USAGE, { code: "usage", hint });
}

/**
 * Checks a brand-kit body against the shape the API accepts, before sending it.
 *
 * Every rule here is one the API already enforces, and each one used to cost a
 * round trip to discover. Worse, the two write endpoints report them
 * differently: `PATCH` passes the validator's message through, so a bad key
 * comes back as `unknown field "mascot"`, while `PUT` flattens every failure to
 * `Invalid guidelines data` — the same body, rejected for the same reason, with
 * the field name discarded. Checking here exits 2 with the field named, the same
 * way for both.
 *
 * Two checks are deliberately stricter than the server, because in both cases
 * the server's leniency loses data silently:
 *
 *   - A key outside `guidelines` is ignored by the API without comment, so
 *     `{"guidelines":{...},"brand_name":"Acme"}` returns 200 having dropped the
 *     brand name. The spec closes the object; this follows the spec.
 *   - A `null` inside `global_writing_rules` is accepted and stored as-is, so a
 *     templating slip leaves a null sitting in an array the spec declares as
 *     strings.
 *
 * `mode` is the one genuine difference between the two commands: `merge` is
 * PATCH, where an empty `guidelines` asks for nothing and is an error, and
 * `replace` is PUT, where `{}` legitimately means "clear the brand kit".
 */
function parseBrandKitData(data: string, mode: "replace" | "merge"): Record<string, unknown> {
  const body = parseJsonFlag(data);

  if (!("guidelines" in body)) {
    throw usageError(
      `--data must have a "guidelines" object at the top level.`,
      `The fields go inside it: ${SET_EXAMPLE}. Accepted fields: ${FIELD_LIST}.`,
    );
  }

  const stray = Object.keys(body).filter((key) => key !== "guidelines");
  if (stray.length > 0) {
    throw usageError(
      `--data has ${stray.length === 1 ? "a key" : "keys"} outside "guidelines": ${stray.join(", ")}.`,
      `Move ${stray.length === 1 ? "it" : "them"} inside "guidelines" — the API ignores anything beside it without reporting that it did. Accepted fields: ${FIELD_LIST}.`,
    );
  }

  const guidelines = body.guidelines;
  if (typeof guidelines !== "object" || guidelines === null || Array.isArray(guidelines)) {
    throw usageError(
      `"guidelines" must be a JSON object, not ${describe(guidelines)}.`,
      `Example: ${SET_EXAMPLE}`,
    );
  }

  const entries = Object.entries(guidelines as Record<string, unknown>);

  if (mode === "merge" && entries.length === 0) {
    throw usageError(
      `"guidelines" must name at least one field to patch.`,
      `Accepted fields: ${FIELD_LIST}. To clear the whole brand kit instead, run: senso brand-kit set --data '{"guidelines":{}}'`,
    );
  }

  for (const [key, value] of entries) {
    if (!GUIDELINE_FIELDS.includes(key)) {
      const suggestion = nearest(key, GUIDELINE_FIELDS);
      throw usageError(
        `"guidelines" does not accept the field "${key}".`,
        suggestion
          ? `Did you mean "${suggestion}"? Accepted fields: ${FIELD_LIST}.`
          : `Accepted fields: ${FIELD_LIST}.`,
      );
    }

    if (key === "global_writing_rules") {
      if (!Array.isArray(value)) {
        throw usageError(
          `"global_writing_rules" must be an array of strings, not ${describe(value)}.`,
          `Example: {"global_writing_rules":["Avoid superlatives unless backed by a number"]}. Pass [] to clear the rules.`,
        );
      }
      const badIndex = value.findIndex((rule) => typeof rule !== "string");
      if (badIndex !== -1) {
        throw usageError(
          `"global_writing_rules[${String(badIndex)}]" must be a string, not ${describe(value[badIndex])}.`,
          `Every rule is a line of guidance for the AI writer, e.g. "Prefer concrete examples over abstract claims".`,
        );
      }
      continue;
    }

    if (typeof value !== "string") {
      throw usageError(
        `"${key}" must be a string, not ${describe(value)}.`,
        value === null
          ? `No field may be null. Omit it to leave it unchanged, or use 'brand-kit set' without it to remove it.`
          : `Example: {"${key}":"..."}`,
      );
    }
  }

  return body;
}

export function registerBrandKitCommands(program: Command): void {
  const bk = program
    .command("brand-kit")
    .description(
      `Manage the organization's brand kit guidelines that inform AI content generation about your brand voice, tone, and style. The guidelines object accepts a defined set of keys: ${FIELD_LIST} (global_writing_rules is an array of strings, the rest are strings). Unknown keys, wrong types and nulls are rejected before the request is sent.`,
    );

  bk.command("get")
    .description(
      "Get the current brand kit guidelines. An organization that has never saved one gets an empty guidelines object rather than an error.",
    )
    .action(
      runAction(program, async (ctx) => {
        const data = await apiRequest({
          path: "/org/brand-kit",
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emit(ctx, data);
      }),
    );

  bk.command("set")
    .description(
      "Replace the entire brand kit (PUT). All existing fields are overwritten — run 'brand-kit get' first to preserve fields you are not changing. For a safe partial update, use 'brand-kit patch'. This is also what creates the brand kit the first time.",
    )
    .requiredOption(
      "--data <json>",
      `JSON: { "guidelines": { "brand_name": "Acme", "brand_domain": "https://acme.com", "brand_description": "...", "voice_and_tone": "...", "author_persona": "...", "global_writing_rules": ["..."] } }. Every field is optional, but anything you omit is REMOVED — pass '{"guidelines":{}}' to clear the brand kit entirely.`,
    )
    .action(
      runAction(program, async (ctx, cmdOpts: { data: string }) => {
        const body = parseBrandKitData(cmdOpts.data, "replace");
        const data = await apiRequest({
          method: "PUT",
          path: "/org/brand-kit",
          body,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        if (!ctx.quiet) log.success("Brand kit updated.");
        emit(ctx, data);
      }),
    );

  bk.command("patch")
    .description(
      "Partially update the brand kit (PATCH). Only the fields you provide are changed — existing fields are preserved. Preferred over 'set' for targeted updates. Note that global_writing_rules is replaced wholesale, not appended to, and no field can be removed this way — use 'set' for that.",
    )
    .requiredOption(
      "--data <json>",
      `JSON: { "guidelines": { "voice_and_tone": "Warm and approachable" } }. At least one field is required; accepted fields are ${FIELD_LIST}.`,
    )
    .action(
      runAction(program, async (ctx, cmdOpts: { data: string }) => {
        const body = parseBrandKitData(cmdOpts.data, "merge");
        const data = await apiRequest({
          method: "PATCH",
          path: "/org/brand-kit",
          body,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        if (!ctx.quiet) log.success("Brand kit updated.");
        emit(ctx, data);
      }),
    );
}
