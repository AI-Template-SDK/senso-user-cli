import { Command } from "commander";
import { apiRequest } from "../lib/api-client.js";
import { usageError } from "../lib/errors.js";
import { apiExits, describeCommand } from "../lib/help.js";
import { parseJsonFlag } from "../lib/json-arg.js";
import { emit } from "../lib/output.js";
import { runAction } from "../lib/run-action.js";
import { asText } from "../lib/text.js";
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

/** What each field is for, repeated in both write commands' help. */
const FIELD_RETURNS = [
  "guidelines.brand_name — the brand as it should be written.",
  "guidelines.brand_domain — the brand's website.",
  "guidelines.brand_description — what the company does.",
  "guidelines.voice_and_tone — how generated content should sound.",
  "guidelines.author_persona — who the content is written as.",
  "guidelines.global_writing_rules — an array of strings, applied to every generated piece.",
  'Any of the six may be absent; absent means "not set".',
];

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

/**
 * Checks a brand-kit body against the shape the API accepts, before sending it.
 *
 * Every rule here is one the API already enforces, and each one used to cost a
 * round trip to discover. Worse, the two write endpoints report them
 * differently: `PATCH` passes the validator's message through, so a bad key
 * comes back as `unknown field "mascot"`, while `PUT` flattens every failure to
 * `Invalid guidelines data` — the same body, rejected for the same reason, with
 * the field name discarded. Checking here exits 2 with the field named, the same
 * way for both, and with `field` and `allowed` in the JSON error so an agent can
 * fix its own command line without parsing a sentence.
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
    throw usageError(`--data must have a "guidelines" object at the top level.`, {
      field: "--data",
      allowed: ["guidelines"],
      hint: `The fields go inside it: ${SET_EXAMPLE}. Accepted fields: ${FIELD_LIST}.`,
    });
  }

  const stray = Object.keys(body).filter((key) => key !== "guidelines");
  if (stray.length > 0) {
    throw usageError(
      `--data has ${stray.length === 1 ? "a key" : "keys"} outside "guidelines": ${stray.join(", ")}.`,
      {
        field: "--data",
        received: stray.join(", "),
        allowed: ["guidelines"],
        hint: `Move ${stray.length === 1 ? "it" : "them"} inside "guidelines" — the API ignores anything beside it without reporting that it did. Accepted fields: ${FIELD_LIST}.`,
      },
    );
  }

  const guidelines = body.guidelines;
  if (typeof guidelines !== "object" || guidelines === null || Array.isArray(guidelines)) {
    throw usageError(`"guidelines" must be a JSON object, not ${describe(guidelines)}.`, {
      field: "--data guidelines",
      received: asText(guidelines),
      allowed: GUIDELINE_FIELDS,
      hint: `Example: ${SET_EXAMPLE}`,
    });
  }

  const entries = Object.entries(guidelines as Record<string, unknown>);

  if (mode === "merge" && entries.length === 0) {
    throw usageError(`"guidelines" must name at least one field to patch.`, {
      field: "--data guidelines",
      received: "{}",
      allowed: GUIDELINE_FIELDS,
      hint: `Accepted fields: ${FIELD_LIST}. To clear the whole brand kit instead, run: senso brand-kit set --data '{"guidelines":{}}'`,
    });
  }

  for (const [key, value] of entries) {
    if (!GUIDELINE_FIELDS.includes(key)) {
      const suggestion = nearest(key, GUIDELINE_FIELDS);
      throw usageError(`"guidelines" does not accept the field "${key}".`, {
        field: `--data guidelines.${key}`,
        received: key,
        allowed: GUIDELINE_FIELDS,
        hint: suggestion
          ? `Did you mean "${suggestion}"? Accepted fields: ${FIELD_LIST}.`
          : `Accepted fields: ${FIELD_LIST}.`,
      });
    }

    if (key === "global_writing_rules") {
      if (!Array.isArray(value)) {
        throw usageError(
          `"global_writing_rules" must be an array of strings, not ${describe(value)}.`,
          {
            field: "--data guidelines.global_writing_rules",
            received: asText(value),
            hint: `Example: {"global_writing_rules":["Avoid superlatives unless backed by a number"]}. Pass [] to clear the rules.`,
          },
        );
      }
      const badIndex = value.findIndex((rule) => typeof rule !== "string");
      if (badIndex !== -1) {
        throw usageError(
          `"global_writing_rules[${String(badIndex)}]" must be a string, not ${describe(value[badIndex])}.`,
          {
            field: `--data guidelines.global_writing_rules[${String(badIndex)}]`,
            received: asText(value[badIndex]),
            hint: `Every rule is a line of guidance for the AI writer, e.g. "Prefer concrete examples over abstract claims".`,
          },
        );
      }
      continue;
    }

    if (typeof value !== "string") {
      throw usageError(`"${key}" must be a string, not ${describe(value)}.`, {
        field: `--data guidelines.${key}`,
        received: asText(value),
        allowed: GUIDELINE_FIELDS,
        hint:
          value === null
            ? `No field may be null. Omit it to leave it unchanged, or use 'brand-kit set' without it to remove it.`
            : `Example: {"${key}":"..."}`,
      });
    }
  }

  return body;
}

/** The guideline keys named in a validated body. */
function guidelineKeys(body: Record<string, unknown>): string[] {
  return Object.keys(body.guidelines as Record<string, unknown>);
}

/** The zero UUID the API synthesizes for an organization that never saved one. */
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

interface BrandKit {
  brand_kit_id?: string;
  created_at?: string;
  guidelines?: Record<string, unknown>;
}

/**
 * True when the API made this record up because nothing is stored.
 *
 * `GET /org/brand-kit` never 404s: an organization with no brand kit gets a
 * synthesized record whose id is the zero UUID and whose timestamps are year
 * 0001. Nothing in the payload says so, and an agent could reasonably store
 * that id as if it meant something.
 */
function isUnsaved(data: BrandKit): boolean {
  return data.brand_kit_id === ZERO_UUID || (data.created_at ?? "").startsWith("0001-01-01");
}

export function registerBrandKitCommands(program: Command): void {
  const bk = program
    .command("brand-kit")
    .description(
      `One brand kit per organization: the brand facts and voice rules the AI writer follows when generating content. It is a singleton — there is no id to pass, the key identifies it, 'get' always succeeds, and the first 'set' creates it. The guidelines object accepts exactly these keys and nothing else: ${FIELD_LIST} (global_writing_rules is an array of strings, the rest are strings). Unknown keys, wrong types and nulls are rejected before the request is sent, with the offending key named. 'senso website-import start' can fill the brand kit in from a website instead — it is gated on the same update:brand_kit permission for that reason. Requires the GEO product and read:brand_kit / update:brand_kit; viewers have no brand kit access.`,
    );

  describeCommand(
    bk
      .command("get")
      .description(
        "Read the organization's brand kit guidelines. Always succeeds: an organization that has never saved one gets an empty guidelines object rather than a 404.",
      )
      .action(
        runAction(program, async (ctx) => {
          const data = await apiRequest<BrandKit>({
            path: "/org/brand-kit",
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
          });
          const unsaved = isUnsaved(data);
          const missing = GUIDELINE_FIELDS.filter((f) => data.guidelines?.[f] === undefined);
          const warnings: string[] = [];
          if (unsaved) {
            warnings.push(
              "No brand kit has been saved. This record was synthesized by the API — brand_kit_id is the zero UUID and the timestamps are year 0001, and no command takes them.",
            );
          } else if (missing.length > 0) {
            warnings.push(
              `Not set: ${missing.join(", ")}. An empty voice_and_tone is why generated content reads generically.`,
            );
          }
          emit(ctx, data, {
            warnings,
            next: unsaved
              ? [
                  {
                    why: "Create the brand kit",
                    command: `senso brand-kit set ${SET_EXAMPLE}`,
                  },
                  {
                    why: "Or fill it in from the company website",
                    command: "senso website-import start --url https://acme.com",
                  },
                ]
              : missing.length > 0
                ? [
                    {
                      why: `Fill in ${missing[0] ?? ""} without touching the rest`,
                      command: `senso brand-kit patch --data '{"guidelines":{"${missing[0] ?? ""}":"…"}}'`,
                    },
                  ]
                : [],
          });
        }),
      ),
    {
      returns: [
        ...FIELD_RETURNS,
        "brand_kit_id, created_at, updated_at — housekeeping. No command takes brand_kit_id. When nothing has been saved the API synthesizes the record and these come back as the zero UUID and 0001-01-01T00:00:00Z.",
      ],
      exitCodes: {
        ...apiExits,
        1: "the API refused (500)",
        3: "no API key, the organization lacks the GEO product, or the key lacks read:brand_kit",
      },
      notes: [
        "There is no 404 here: an organization with no brand kit gets an empty guidelines object and exit 0.",
        "Read this before `brand-kit set`, which replaces everything it is not given.",
      ],
      examples: [
        { command: "senso brand-kit get" },
        {
          comment: "One field",
          command: "senso brand-kit get --output json | jq -r .data.guidelines.voice_and_tone",
        },
      ],
      seeAlso: ["senso brand-kit patch", "senso brand-kit set", "senso website-import start"],
    },
  );

  describeCommand(
    bk
      .command("set")
      .description(
        "Replace the entire brand kit (PUT). Every field you do not send is REMOVED — run 'brand-kit get' first to keep what you are not changing, or use 'brand-kit patch' for a targeted update. This is also what creates the brand kit the first time.",
      )
      .requiredOption(
        "--data <json>",
        `JSON: { "guidelines": { "brand_name": "Acme", "brand_domain": "https://acme.com", "brand_description": "...", "voice_and_tone": "...", "author_persona": "...", "global_writing_rules": ["..."] } }. Every field is optional, but anything you omit is REMOVED — pass '{"guidelines":{}}' to clear the brand kit entirely. A key beside "guidelines" is rejected here because the API would accept it with a 200 and silently drop it`,
      )
      .action(
        runAction(program, async (ctx, cmdOpts: { data: string }) => {
          const body = parseBrandKitData(cmdOpts.data, "replace");
          const sent = guidelineKeys(body);
          const dropped = GUIDELINE_FIELDS.filter((f) => !sent.includes(f));
          const data = await apiRequest({
            method: "PUT",
            path: "/org/brand-kit",
            body,
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
          });
          if (!ctx.quiet) log.success("Brand kit updated.");
          emit(ctx, data, {
            warnings:
              sent.length === 0
                ? [
                    "The brand kit is now empty: every guideline was cleared. Generated content will follow no brand rules until one is saved again.",
                  ]
                : dropped.length > 0
                  ? [
                      `set replaces the whole brand kit, so anything previously stored in ${dropped.join(", ")} is now gone. Use \`senso brand-kit patch\` to change one field without touching the others.`,
                    ]
                  : [],
            next: [
              { why: "Read back what is stored", command: "senso brand-kit get" },
              {
                why: "Generate something that uses it",
                command: "senso generate sample",
              },
            ],
          });
        }),
      ),
    {
      returns: [...FIELD_RETURNS, "The stored guidelines, exactly as sent."],
      exitCodes: {
        ...apiExits,
        1: "the API refused the write",
        2: '--data is not JSON, has a key outside "guidelines", "guidelines" is not an object, a field is unknown (the message names it and suggests the closest accepted one), a value has the wrong type, or any value is null',
        3: "no API key, the organization lacks the GEO product, or the key lacks update:brand_kit",
      },
      notes: [
        "Destructive by design: this is PUT. Fields absent from --data are removed, and there is no undo.",
        `'{"guidelines":{}}' clears the brand kit entirely and is reported as a warning, not refused.`,
        'Keys outside "guidelines" are rejected locally because the API accepts them with a 200 and drops them, which looks like a successful write that changed nothing.',
      ],
      examples: [
        {
          comment: "Create or replace the whole kit",
          command: `senso brand-kit set --data '{"guidelines":{"brand_name":"Acme","brand_domain":"https://acme.com","voice_and_tone":"Warm and direct","global_writing_rules":["Avoid superlatives unless backed by a number"]}}'`,
        },
        {
          comment: "Change one field without losing the rest",
          command: `senso brand-kit patch --data '{"guidelines":{"voice_and_tone":"Warmer"}}'`,
        },
      ],
      seeAlso: ["senso brand-kit patch", "senso brand-kit get", "senso website-import start"],
    },
  );

  describeCommand(
    bk
      .command("patch")
      .description(
        "Partially update the brand kit (PATCH). Only the fields you provide are changed; the rest keep their current value. Preferred over 'set' for targeted updates. Two things it cannot do: append to global_writing_rules (sending it replaces the whole list — read the current one with 'brand-kit get' and send it back with the new entry), and remove a field (null is rejected; use 'brand-kit set' with the field omitted).",
      )
      .requiredOption(
        "--data <json>",
        `JSON: { "guidelines": { "voice_and_tone": "Warm and approachable" } }. At least one field is required; accepted fields are ${FIELD_LIST} (global_writing_rules is an array of strings, the rest are strings)`,
      )
      .action(
        runAction(program, async (ctx, cmdOpts: { data: string }) => {
          const body = parseBrandKitData(cmdOpts.data, "merge");
          const sent = guidelineKeys(body);
          const data = await apiRequest({
            method: "PATCH",
            path: "/org/brand-kit",
            body,
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
          });
          if (!ctx.quiet) log.success(`Brand kit updated: ${sent.join(", ")}.`);
          emit(ctx, data, {
            warnings: sent.includes("global_writing_rules")
              ? [
                  "global_writing_rules was replaced wholesale, not appended to — any rule not in --data is gone.",
                ]
              : [],
            next: [{ why: "Read back the merged kit", command: "senso brand-kit get" }],
          });
        }),
      ),
    {
      returns: [...FIELD_RETURNS, "The merged guidelines, as they are now stored."],
      exitCodes: {
        ...apiExits,
        1: "the API refused the write",
        2: '--data is not JSON, has a key outside "guidelines", "guidelines" is empty or not an object, a field is unknown, a value has the wrong type, or any value is null',
        3: "no API key, the organization lacks the GEO product, or the key lacks update:brand_kit",
      },
      notes: [
        "global_writing_rules is REPLACED, not appended to. To add a rule, read the current list with `senso brand-kit get` and send it back with the new entry.",
        "No field can be removed this way — null is rejected. Use `senso brand-kit set` with the field omitted.",
      ],
      examples: [
        {
          command: `senso brand-kit patch --data '{"guidelines":{"voice_and_tone":"Warm and approachable"}}'`,
        },
        {
          comment: "Append a rule to the existing list",
          command: `senso brand-kit get --output json | jq -c '{guidelines:{global_writing_rules:(.data.guidelines.global_writing_rules + ["Prefer concrete examples"])}}' | xargs -0 -I{} senso brand-kit patch --data {}`,
        },
      ],
      seeAlso: ["senso brand-kit set", "senso brand-kit get", "senso generate sample"],
    },
  );
}
