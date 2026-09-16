import { Command } from "commander";
import { apiRequest } from "../lib/api-client.js";
import { parseIntFlag } from "../lib/enum-arg.js";
import { usageError } from "../lib/errors.js";
import { apiExits, describeCommand, idExits } from "../lib/help.js";
import { parseId } from "../lib/id-arg.js";
import { parseJsonFlag } from "../lib/json-arg.js";
import { emit, emitConfirmation } from "../lib/output.js";
import type { ResourceRef } from "../lib/resource.js";
import { runAction } from "../lib/run-action.js";

/**
 * Every key `config` accepts, mirroring services.validateContentTypeConfig.
 *
 * The API holds the same closed list and answers anything else with a 400
 * `unknown field "x"`. Checking here turns that round trip into exit 2 with the
 * key named, and — more importantly — makes the accepted set readable from
 * `error.allowed` rather than from a sentence.
 */
const CONFIG_KEYS = [
  "template",
  "template_spec",
  "cta_text",
  "cta_destination",
  "writing_rules",
] as const;

/** What a content type request addresses, so a 404 names the record. */
function contentTypeResource(id: string): ResourceRef {
  return {
    type: "Content type",
    id,
    idField: "content_type_id",
    list: "senso content-types list",
  };
}

/** "a number", "null", "an array" — so a message can name what was sent. */
function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The `config` object, checked against the rules the API enforces.
 *
 * Every rule here is the server's, and each one used to cost a request to
 * discover: an unknown key, a null, a wrongly typed value, a relative
 * cta_destination. The one thing this adds is the warning about template_spec,
 * which the API accepts, validates and then throws away — canonicalizeContent-
 * TypeConfig always rebuilds it from `template`, so a caller who carefully
 * constructs one watches it be replaced without a word.
 */
function validateConfig(config: unknown): string[] {
  if (!isPlainObject(config)) {
    throw usageError(`"config" in --data must be a JSON object, not ${describe(config)}.`, {
      field: "config",
      allowed: CONFIG_KEYS,
      hint: `Example: --data '{"name":"Blog Post","config":{"template":"## Introduction (100-150 words)\\n..."}}'`,
    });
  }

  const warnings: string[] = [];

  for (const [key, value] of Object.entries(config)) {
    if (!CONFIG_KEYS.includes(key as (typeof CONFIG_KEYS)[number])) {
      throw usageError(`"config" does not accept the field "${key}".`, {
        field: `config.${key}`,
        received: key,
        allowed: CONFIG_KEYS,
        hint: `Accepted config keys: ${CONFIG_KEYS.join(", ")}.`,
      });
    }

    if (key === "writing_rules") {
      if (!Array.isArray(value)) {
        throw usageError(`"writing_rules" must be an array of strings, not ${describe(value)}.`, {
          field: "config.writing_rules",
          hint: `Example: {"writing_rules":["No superlatives without a number"]}. Pass [] to clear them.`,
        });
      }
      const badIndex = value.findIndex((rule) => typeof rule !== "string");
      if (badIndex !== -1) {
        throw usageError(
          `"writing_rules[${String(badIndex)}]" must be a string, not ${describe(value[badIndex])}.`,
          {
            field: "config.writing_rules",
            hint: "Every rule is one line of guidance for the AI writer.",
          },
        );
      }
      continue;
    }

    if (key === "template_spec") {
      if (!isPlainObject(value)) {
        throw usageError(`"template_spec" must be an object, not ${describe(value)}.`, {
          field: "config.template_spec",
          hint: "It is derived from `template`, so the simplest correct thing to do is to omit it.",
        });
      }
      warnings.push(
        "config.template_spec is ignored: the API rebuilds it from config.template on every write, so what was sent will not be stored.",
      );
      continue;
    }

    if (typeof value !== "string") {
      throw usageError(`"${key}" must be a string, not ${describe(value)}.`, {
        field: `config.${key}`,
        hint:
          value === null
            ? "No config field may be null. Omit it, or send an empty string to clear it."
            : `Example: {"${key}":"..."}`,
      });
    }

    if (key === "cta_destination" && value.trim() !== "") {
      let parsed: URL | undefined;
      try {
        parsed = new URL(value.trim());
      } catch {
        parsed = undefined;
      }
      if (!parsed?.protocol || !parsed.host) {
        throw usageError(`"cta_destination" must be an absolute URL, not "${value}".`, {
          field: "config.cta_destination",
          received: value,
          hint: "Include the scheme and the host, e.g. https://acme.com/demo.",
        });
      }
    }
  }

  return warnings;
}

/** The whole `--data` body for a write, checked before the request. */
function parseContentTypeData(
  data: string,
  mode: "full" | "partial",
): { body: Record<string, unknown>; warnings: string[] } {
  const body =
    mode === "full"
      ? parseJsonFlag(data, { required: ["name", "config"] })
      : parseJsonFlag(data, {
          anyOf: ["name", "config"],
          rejectEmpty:
            'A patch that names nothing would change nothing. Send at least one of "name" or "config".',
        });

  if (body.name !== undefined && (typeof body.name !== "string" || body.name.trim() === "")) {
    throw usageError(`"name" in --data must be a non-blank string.`, {
      field: "name",
      hint: "Names are unique within the organization; `senso content-types list` shows the ones in use.",
    });
  }

  const warnings = body.config === undefined ? [] : validateConfig(body.config);
  return { body, warnings };
}

export function registerContentTypeCommands(program: Command): void {
  const ct = program
    .command("content-types")
    .description(
      "Manage content types — the reusable output formats for AI-generated content (blog post, FAQ, landing page). Each has a name, unique in the organization, and a config. What defines the format is config.template, a freeform Markdown string: the API parses it into config.template_spec, one section per Markdown heading, and reads word budgets out of phrases in the text — (800-1200 words), target: 900 words, max 500 words, minimum 200 words. Those budgets are ENFORCED on generated output, so a number in a template is a hard constraint rather than a hint. config.template_spec is read-only in practice: whatever is sent is validated and then replaced with the parse of config.template. The stored config is canonicalized on every write, so it always carries all five keys. Workflow: list → create → get (to read the derived template_spec) → use the content_type_id with the generate commands.",
    );

  describeCommand(
    ct
      .command("list")
      .description("List the organization's content types, with their full config.")
      .option("--limit <n>", "Rows per page (default: 50)")
      .option("--offset <n>", "Rows to skip (default: 0)"),
    {
      returns: [
        "content_types[].content_type_id — the id; takes content-types get/update/patch/delete and the generate commands",
        "content_types[].name — unique within the organization",
        "content_types[].config — template, template_spec, cta_text, cta_destination, writing_rules. Read it in full with `content-types get <id>`",
        "total — CAUTION: the number of rows on THIS PAGE, not the number in the organization. To page, keep going while the rows returned equal --limit",
      ],
      exitCodes: {
        ...apiExits,
        2: "--limit or --offset is not an integer in range",
        3: "no API key, or the organization does not have the GEO product",
      },
      examples: [
        { command: "senso content-types list" },
        {
          command:
            "senso content-types list --output json | jq -r '.data.content_types[] | [.content_type_id, .name] | @tsv'",
        },
      ],
      seeAlso: ["senso content-types get <id>", "senso content-types create", "senso generate"],
    },
  ).action(
    runAction(program, async (ctx, cmdOpts: Record<string, string>) => {
      const data = await apiRequest({
        path: "/org/content-types",
        params: {
          // The API ignores an unparseable or non-positive value and serves 50
          // instead, so an unchecked flag returned a page nobody asked for.
          limit: parseIntFlag("--limit", cmdOpts.limit, { min: 1 }),
          offset: parseIntFlag("--offset", cmdOpts.offset, { min: 0 }),
        },
        apiKey: ctx.apiKey,
        baseUrl: ctx.baseUrl,
      });
      // 'config' is nested and long; `get <id>` is where you read it.
      emit(ctx, data, {
        columns: ["content_type_id", "name", "created_at", "updated_at"],
        empty: "content types",
        emptyHint:
          'Add one with `senso content-types create --data \'{"name":"Blog Post","config":{"template":"## Introduction (100-150 words)"}}\'`.',
      });
    }),
  );

  describeCommand(
    ct
      .command("create")
      .description(
        "Create a content type: a name and a config whose `template` defines the output format.",
      )
      .requiredOption(
        "--data <json>",
        `JSON: { "name": "Blog Post", "config": { "template": "## Introduction (100-150 words)\\n...", "writing_rules": [], "cta_text": "...", "cta_destination": "https://..." } }. Accepted config keys: ${CONFIG_KEYS.join(", ")} — anything else is rejected.`,
      ),
    {
      returns: [
        "content_type_id — use it with content-types get/update/patch/delete and the generate commands",
        "name — as stored",
        'config — canonicalized: all five keys are present, with "" or null for the ones that were omitted, and template_spec derived from the template that was sent',
        "config.template_spec.sections[] — one per Markdown heading, with the word budget read out of the heading text and ENFORCED on generated output",
      ],
      exitCodes: {
        ...apiExits,
        2: "--data is not JSON, is missing name or config, name is blank, or config has an unknown key, a wrongly typed value or a relative cta_destination",
        3: "no API key, or the organization does not have the GEO product",
        1: "the API refused: 409 when a content type of that name already exists",
      },
      examples: [
        {
          command:
            'senso content-types create --data \'{"name":"Blog Post","config":{"template":"## Introduction (100-150 words)\\nSet up the problem.\\n\\n## Body (600-900 words)\\nThree sections with evidence.","writing_rules":["No superlatives without a number"],"cta_text":"Talk to us","cta_destination":"https://acme.com/demo"}}\'',
        },
        {
          comment: "Keep the id",
          command:
            'senso content-types create --data \'{"name":"FAQ","config":{"template":"## Question\\n## Answer (max 150 words)"}}\' --output json | jq -r .data.content_type_id',
        },
      ],
      notes: [
        "Names are unique per organization: a duplicate is a 409.",
        "config.template_spec is accepted and then replaced with the parse of config.template. Sending it can only make the request fail.",
      ],
      seeAlso: ["senso content-types get <id>", "senso content-types patch <id>", "senso generate"],
    },
  ).action(
    runAction(program, async (ctx, cmdOpts: { data: string }) => {
      const { body, warnings } = parseContentTypeData(cmdOpts.data, "full");
      const created = await apiRequest<{ content_type_id?: string }>({
        method: "POST",
        path: "/org/content-types",
        body,
        apiKey: ctx.apiKey,
        baseUrl: ctx.baseUrl,
      });
      const id = created.content_type_id ?? "<id>";
      emit(ctx, created, {
        warnings,
        next: [
          {
            why: "Read the template_spec the API derived from your template",
            command: `senso content-types get ${id}`,
          },
        ],
      });
    }),
  );

  describeCommand(
    ct
      .command("get")
      .description(
        "Read one content type: the template that defines the output format, and the parsed spec derived from it.",
      )
      .argument("<id>", "content_type_id from `senso content-types list`. Not a content_id."),
    {
      returns: [
        "name — the content type's unique name",
        "config.template — the Markdown that defines the format; edit this to change the output",
        "config.template_spec — the parse of config.template, regenerated on every write: parser_version (always 1), source_format (always freeform_markdown), total_word_budget (min_words / max_words / target_words, ENFORCED on generated output), sections[] (id, title, instructions, word_budget), parse_warnings[]",
        "config.writing_rules, config.cta_text, config.cta_destination — style rules and the call to action",
      ],
      exitCodes: {
        ...idExits,
        2: "<id> is not a UUID",
        3: "no API key, or the organization does not have the GEO product",
        4: "no content type with this id in your organization",
      },
      examples: [
        { command: "senso content-types get 9c8b7a6d-1111-4222-8333-444455556666" },
        {
          comment: "Just the template, to edit and send back",
          command:
            "senso content-types get 9c8b7a6d-1111-4222-8333-444455556666 --output json | jq -r .data.config.template",
        },
      ],
      notes: [
        "Sending your own template_spec has no effect; it is always re-derived from template.",
      ],
      seeAlso: ["senso content-types patch <id>", "senso content-types list", "senso generate"],
    },
  ).action(
    runAction(program, async (ctx, id: string) => {
      const contentTypeId = parseId(id, { label: "<id>", ...contentTypeResource(id) });
      const data = await apiRequest({
        path: `/org/content-types/${contentTypeId}`,
        apiKey: ctx.apiKey,
        baseUrl: ctx.baseUrl,
        resource: contentTypeResource(contentTypeId),
      });
      emit(ctx, data, {
        next: [
          {
            why: "Change the format without resending the rest",
            command: `senso content-types patch ${contentTypeId} --data '{"config":{"template":"..."}}'`,
          },
        ],
      });
    }),
  );

  describeCommand(
    ct
      .command("update")
      .description(
        "Replace a content type's name AND config (PUT). A full replacement twice over: a key left out of --data is cleared, and a key left out of config is cleared too. Run `content-types get <id>` first, or use `content-types patch <id>`.",
      )
      .argument("<id>", "content_type_id from `senso content-types list`")
      .requiredOption(
        "--data <json>",
        `JSON: { "name": "Updated Name", "config": { ... } }. Both required. Accepted config keys: ${CONFIG_KEYS.join(", ")}; keys omitted from config are CLEARED.`,
      ),
    {
      returns: [
        "The content type after the replacement, with template_spec re-derived from the new template",
      ],
      exitCodes: {
        ...idExits,
        2: "--data is not JSON, is missing name or config, name is blank, config has an unknown key, a wrongly typed value or a relative cta_destination; or <id> is not a UUID",
        3: "no API key, or the organization does not have the GEO product",
        4: "no content type with this id in your organization",
        1: "the API refused: 409 when another content type already uses the new name",
      },
      examples: [
        {
          comment: "Read, edit, replace — without dropping the fields you are not changing",
          command:
            "senso content-types get 9c8b7a6d-1111-4222-8333-444455556666 --output json > ct.json && senso content-types update 9c8b7a6d-1111-4222-8333-444455556666 --data \"$(jq -c '{name: .data.name, config: (.data.config | del(.template_spec))}' ct.json)\"",
        },
      ],
      seeAlso: ["senso content-types patch <id>", "senso content-types get <id>"],
    },
  ).action(
    runAction(program, async (ctx, id: string, cmdOpts: { data: string }) => {
      const contentTypeId = parseId(id, { label: "<id>", ...contentTypeResource(id) });
      const { body, warnings } = parseContentTypeData(cmdOpts.data, "full");
      const data = await apiRequest({
        method: "PUT",
        path: `/org/content-types/${contentTypeId}`,
        body,
        apiKey: ctx.apiKey,
        baseUrl: ctx.baseUrl,
        resource: contentTypeResource(contentTypeId),
      });
      emit(ctx, data, {
        warnings: [
          ...warnings,
          "This replaced the config: any key that was not in --data, including cta_text, cta_destination and writing_rules, is now cleared.",
        ],
      });
    }),
  );

  describeCommand(
    ct
      .command("patch")
      .description(
        "Change part of a content type (PATCH). Keys that are not sent keep their current value. The merge is one level deep: sending writing_rules REPLACES the whole list.",
      )
      .argument("<id>", "content_type_id from `senso content-types list`")
      .requiredOption(
        "--data <json>",
        `JSON with at least one of "name" and "config", e.g. { "config": { "template": "Updated template instruction" } }. Accepted config keys: ${CONFIG_KEYS.join(", ")}.`,
      ),
    {
      returns: [
        "The content type after the merge, with template_spec re-derived from the merged template",
      ],
      exitCodes: {
        ...idExits,
        2: "--data is not JSON, names neither name nor config, has a blank name, or a config key that is unknown or wrongly typed; or <id> is not a UUID",
        3: "no API key, or the organization does not have the GEO product",
        4: "no content type with this id in your organization",
        1: "the API refused: 409 when another content type already uses the new name",
      },
      examples: [
        {
          command:
            'senso content-types patch 9c8b7a6d-1111-4222-8333-444455556666 --data \'{"config":{"template":"## Introduction (120 words)\\n..."}}\'',
        },
        {
          command:
            'senso content-types patch 9c8b7a6d-1111-4222-8333-444455556666 --data \'{"config":{"cta_destination":"https://acme.com/demo"}}\'',
        },
        {
          command:
            'senso content-types patch 9c8b7a6d-1111-4222-8333-444455556666 --data \'{"name":"Blog Post (long form)"}\'',
        },
      ],
      notes: [
        "A new template re-derives template_spec, so the sections and the ENFORCED word budgets change with it.",
        "To add one writing rule, read the current list with `content-types get` and send it back with the new entry.",
      ],
      seeAlso: ["senso content-types get <id>", "senso content-types update <id>"],
    },
  ).action(
    runAction(program, async (ctx, id: string, cmdOpts: { data: string }) => {
      const contentTypeId = parseId(id, { label: "<id>", ...contentTypeResource(id) });
      const { body, warnings } = parseContentTypeData(cmdOpts.data, "partial");
      const data = await apiRequest({
        method: "PATCH",
        path: `/org/content-types/${contentTypeId}`,
        body,
        apiKey: ctx.apiKey,
        baseUrl: ctx.baseUrl,
        resource: contentTypeResource(contentTypeId),
      });
      const changed = Object.keys(body).join(", ");
      emit(ctx, data, {
        warnings: [
          ...warnings,
          ...(isPlainObject(body.config) && "writing_rules" in body.config
            ? ["writing_rules replaced the whole list rather than adding to it."]
            : []),
          `Patched ${changed}; everything else kept its stored value.`,
        ],
      });
    }),
  );

  describeCommand(
    ct
      .command("delete")
      .description(
        "Remove a content type. It disappears from `content-types list` immediately and there is no undelete from the CLI.",
      )
      .argument("<id>", "content_type_id from `senso content-types list`"),
    {
      returns: [
        'Nothing on stdout in plain output. Under --output json: { action: "deleted", resource: "content_type", id }',
      ],
      exitCodes: {
        ...idExits,
        2: "<id> is not a UUID",
        3: "no API key, or the organization does not have the GEO product",
        4: "no content type with this id in your organization (an already deleted one counts)",
      },
      examples: [
        { command: "senso content-types delete 9c8b7a6d-1111-4222-8333-444455556666" },
        {
          command: "senso content-types delete 9c8b7a6d-1111-4222-8333-444455556666 --output json",
        },
      ],
      notes: [
        "Content already generated is unaffected. Anything that still names this content_type_id when generating will fail.",
      ],
      seeAlso: ["senso content-types list", "senso content-types patch <id>"],
    },
  ).action(
    runAction(program, async (ctx, id: string) => {
      const contentTypeId = parseId(id, { label: "<id>", ...contentTypeResource(id) });
      await apiRequest({
        method: "DELETE",
        path: `/org/content-types/${contentTypeId}`,
        apiKey: ctx.apiKey,
        baseUrl: ctx.baseUrl,
        resource: contentTypeResource(contentTypeId),
      });
      emitConfirmation(ctx, `Content type ${contentTypeId} deleted.`, {
        action: "deleted",
        resource: "content_type",
        id: contentTypeId,
      });
    }),
  );
}
