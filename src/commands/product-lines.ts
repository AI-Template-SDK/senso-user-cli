import { Command } from "commander";
import { apiRequest } from "../lib/api-client.js";
import { parseIntFlag } from "../lib/enum-arg.js";
import { usageError } from "../lib/errors.js";
import { apiExits, describeCommand, idExits } from "../lib/help.js";
import { parseId } from "../lib/id-arg.js";
import { parseJsonFlag } from "../lib/json-arg.js";
import { emit, emitConfirmation } from "../lib/output.js";
import { runAction } from "../lib/run-action.js";
import * as log from "../utils/logger.js";

/** Where a product line id comes from, for `parseId` and for the 404. */
const PRODUCT_LINE_ID = {
  label: "<id>",
  type: "Product line",
  idField: "product_line_id",
  list: "senso product-lines list",
};

/** dto.CreateProductLineRequest: name is required, 1-255 characters after trimming. */
const MAX_NAME_LENGTH = 255;

/**
 * The one sentence that matters about `details`, repeated wherever it is set.
 *
 * Every scalar leaf of the blob is flattened into the generation evidence
 * inventory as an APPROVED evidence item keyed `details.<path>`, and the
 * evidence-sufficiency prompt tells the model those are confirmed facts a claim
 * may rest on. Anything wrong or stale in `details` is something Senso may
 * assert in published content.
 */
const EVIDENCE_NOTE =
  "Every scalar leaf of `details` is flattened into the generation evidence inventory as an APPROVED evidence item (keyed `details.<path>`; arrays become `details.skus[0]`). The generator may assert those values as fact, so only put things in `details` you are willing to see published.";

interface ProductLineBody {
  name?: unknown;
  details?: unknown;
}

/** `name`, when it is present, checked the way the service checks it. */
function assertName(body: ProductLineBody): void {
  if (body.name === undefined) return;
  if (typeof body.name !== "string" || body.name.trim().length === 0) {
    throw usageError("--data.name must be a non-empty string.", {
      field: "--data.name",
      received: JSON.stringify(body.name),
      hint: `--data '{"name":"Pro Plan","details":{}}'`,
    });
  }
  if (body.name.trim().length > MAX_NAME_LENGTH) {
    throw usageError(
      `--data.name is ${String(body.name.trim().length)} characters; the maximum is ${String(MAX_NAME_LENGTH)}.`,
      { field: "--data.name", hint: `Shorten the name to ${String(MAX_NAME_LENGTH)} characters or fewer.` },
    );
  }
}

/**
 * `details` must be a JSON OBJECT.
 *
 * An array, a string or a number all parse cleanly and all fail at the API with
 * "invalid product line details JSON", which is a 400 — exit 1 — and names a
 * cause that is not the real one.
 */
function assertDetails(body: ProductLineBody): void {
  if (body.details === undefined) return;
  const isObject =
    typeof body.details === "object" && body.details !== null && !Array.isArray(body.details);
  if (!isObject) {
    const got = body.details === null ? "null" : Array.isArray(body.details) ? "an array" : `a ${typeof body.details}`;
    throw usageError(`--data.details must be a JSON object, got ${got}.`, {
      field: "--data.details",
      received: JSON.stringify(body.details),
      hint: `Wrap it: --data '{"details":{"skus":["SENSO-PRO"]}}'`,
    });
  }
}

export function registerProductLineCommands(program: Command): void {
  const pl = program.command("product-lines").description(
    `Manage product lines — the organization's product and service definitions. A product line is a name plus an open-ended JSON \`details\` object.

\`details\` is not inert metadata. ${EVIDENCE_NOTE}

Requires the GEO product, plus read:product_line to read and update:product_line to write (admin and collaborator; viewers have no product line access). A 403 here is usually a plan limitation, not a bad key.

Id space: a product_line_id is the \`product_line_id\` field of \`senso product-lines list\`. It is what get/update/patch/delete take, and what \`senso generate --product-line-ids\` takes.

Typical workflow: product-lines list → product-lines create → product-lines patch to correct one field → senso generate --product-line-ids <product_line_id>.

See also: senso generate, senso brand-kit get, senso content-types list`,
  );

  describeCommand(
    pl
      .command("list")
      .description(
        "List the organization's product lines. Each item carries its full `details` blob; the table view omits it, so use `product-lines get <id>` or --output json to read it.",
      )
      .option("--limit <n>", "Rows per page. Integer >= 1. Default 50. Maps to `limit`")
      .option("--offset <n>", "Rows to skip. Integer >= 0. Default 0. Maps to `offset`")
      .action(
        runAction(program, async (ctx, cmdOpts: { limit?: string; offset?: string }) => {
          // Checked here because the API does not check them: a value it cannot
          // parse is silently replaced by the default, so `--limit abc` returns
          // 50 rows and reports "limit": 50 as though it had been asked for.
          const limit = parseIntFlag("--limit", cmdOpts.limit, { min: 1 });
          const offset = parseIntFlag("--offset", cmdOpts.offset, { min: 0 });

          const data = await apiRequest<{ product_lines?: unknown[] }>({
            path: "/org/product-lines",
            params: { limit, offset },
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
            resource: { type: "Product line", list: "senso product-lines list" },
          });

          const returned = data.product_lines?.length ?? 0;
          emit(ctx, data, {
            columns: ["product_line_id", "name", "created_at", "updated_at"],
            empty: "product lines",
            emptyHint:
              'Create one with: senso product-lines create --data \'{"name":"Pro Plan","details":{}}\'',
            // `total` from this endpoint is len(page), so the derived page line
            // reads "Showing 1-2 of 2" on an org with 90 product lines.
            warnings:
              returned > 0
                ? [
                    "`total` from this endpoint is the size of this page, not the organization's row count — keep paging with --offset until a page comes back short.",
                  ]
                : [],
            next: [
              {
                why: "Use a product line in a generation",
                command: "senso generate --prompt-id <prompt_id> --product-line-ids <product_line_id>",
              },
            ],
          });
        }),
      ),
    {
      returns: [
        "product_lines[].product_line_id — the id for get/update/patch/delete and for `senso generate --product-line-ids`",
        "product_lines[].name — unique per organization",
        "product_lines[].details — the open-ended JSON object whose scalar leaves become approved evidence during generation",
        "product_lines[].created_at, updated_at",
        "total — the number of rows IN THIS RESPONSE, not an org-wide count. The API does not report one, so page until a page comes back short.",
        "limit, offset — echoed back from the request",
      ],
      exitCodes: {
        ...apiExits,
        2: "--limit or --offset is not a whole number, or is out of range",
        3: "the organization does not have the GEO product, or the role lacks read:product_line",
      },
      examples: [
        { command: "senso product-lines list" },
        {
          command:
            "senso product-lines list --limit 100 --output json | jq -r '.data.product_lines[] | \"\\(.product_line_id) \\(.name)\"'",
        },
      ],
      seeAlso: ["senso product-lines get <id>", "senso generate"],
    },
  );

  describeCommand(
    pl
      .command("create")
      .description(`Create a product line. ${EVIDENCE_NOTE}`)
      .requiredOption("--data <json>", 'JSON: { "name": "Pro Plan", "details": { ... } }')
      .action(
        runAction(program, async (ctx, cmdOpts: { data: string }) => {
          const body = parseJsonFlag<ProductLineBody>(cmdOpts.data, {
            required: ["name"],
            optional: ["details"],
          });
          assertName(body);
          assertDetails(body);

          const data = await apiRequest<{ product_line_id?: string }>({
            method: "POST",
            path: "/org/product-lines",
            body,
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
            resource: { type: "Product line", list: "senso product-lines list" },
          });
          const id = data.product_line_id ?? "<product_line_id>";
          if (!ctx.quiet) log.success(`Created product line ${id}.`);
          emit(ctx, data, {
            warnings: [
              "`details` keys are returned sorted; the input key order is not preserved.",
              "Its scalar leaves are now approved evidence that generation may assert as fact.",
            ],
            next: [
              {
                why: "Generate with this product line applied",
                command: `senso generate --prompt-id <prompt_id> --product-line-ids ${id}`,
              },
            ],
          });
        }),
      ),
    {
      returns: [
        "product_line_id — the new id, for get/update/patch/delete and `senso generate --product-line-ids`",
        "name — the stored, trimmed name",
        "details — the stored blob, re-serialized with sorted keys",
        "created_at, updated_at",
      ],
      exitCodes: {
        ...apiExits,
        1: "409 — a product line with that name already exists",
        2: "--data is not a JSON object, `name` is missing/blank/over 255 characters, or `details` is present but not a JSON object",
        3: "no GEO product, or the role lacks update:product_line",
      },
      examples: [
        {
          command:
            'senso product-lines create --data \'{"name":"Pro Plan","details":{"price_usd":99,"sku":"SENSO-PRO"}}\'',
        },
        {
          command:
            'senso product-lines create --data \'{"name":"Pro Plan","details":{}}\' --output json | jq -r .data.product_line_id',
        },
      ],
      seeAlso: ["senso product-lines patch <id>", "senso generate"],
    },
  );

  describeCommand(
    pl
      .command("get")
      .description(
        "Read one product line, including its full `details` object. This is the command to use when you need to see `details` — `product-lines list` omits it from the table view.",
      )
      .argument(
        "<id>",
        "A product_line_id (UUID) — the `product_line_id` field of `senso product-lines list`. Not a content_id, kb_node_id or prompt_id",
      )
      .action(
        runAction(program, async (ctx, rawId: string) => {
          const id = parseId(rawId, PRODUCT_LINE_ID);
          const data = await apiRequest({
            path: `/org/product-lines/${id}`,
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
            resource: { ...PRODUCT_LINE_ID, id },
          });
          emit(ctx, data, {
            next: [
              {
                why: "Change one field without losing the rest of the blob",
                command: `senso product-lines patch ${id} --data '{"details":{...}}'`,
              },
            ],
          });
        }),
      ),
    {
      returns: [
        "product_line_id, name",
        "details — the stored JSON object, keys sorted. Its scalar leaves are what generation treats as approved evidence, addressed as `details.<path>`.",
        "created_at, updated_at",
      ],
      exitCodes: {
        ...idExits,
        3: "no GEO product, or the role lacks read:product_line",
        4: "no product line with this id in your organization",
      },
      examples: [
        { command: "senso product-lines get 4c8e1b2a-77d3-4f10-bb92-0e5d6a9c1f31" },
        {
          command:
            "senso product-lines get 4c8e1b2a-77d3-4f10-bb92-0e5d6a9c1f31 --output json | jq .data.details",
        },
      ],
      seeAlso: ["senso product-lines patch <id>", "senso product-lines list"],
    },
  );

  describeCommand(
    pl
      .command("update")
      .description(
        "REPLACE a product line's name and details (PUT). Whatever you do not send is gone: the API treats an absent `details` as {}, which removes every evidence field generation was drawing from this product line. Read the current value first, or use `product-lines patch <id>` to change one field.",
      )
      .argument("<id>", "A product_line_id (UUID) from `senso product-lines list`")
      .requiredOption("--data <json>", 'JSON: { "name": "Updated Name", "details": { ... } }')
      .action(
        runAction(program, async (ctx, rawId: string, cmdOpts: { data: string }) => {
          const id = parseId(rawId, PRODUCT_LINE_ID);
          const body = parseJsonFlag<ProductLineBody>(cmdOpts.data, {
            required: ["name"],
            optional: ["details"],
          });
          assertName(body);
          assertDetails(body);

          // The API's declared contract says `details` is required and its
          // enforced contract does not — ShouldBindJSON never runs the
          // `validate:` tag — so an omitted `details` is a 200 that silently
          // replaced the blob with {}. Refused here, because from the CLI's side
          // that is indistinguishable from a successful write.
          if (body.details === undefined) {
            throw usageError(
              '--data is missing "details", and this is a PUT: the API would replace the stored details with {} and report success.',
              {
                field: "--data.details",
                allowed: ["name", "details"],
                hint: `To change only the name: senso product-lines patch ${id} --data '{"name":"Pro Plan"}'. To deliberately clear the blob: --data '{"name":"Pro Plan","details":{}}'.`,
              },
            );
          }

          const data = await apiRequest({
            method: "PUT",
            path: `/org/product-lines/${id}`,
            body,
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
            resource: { ...PRODUCT_LINE_ID, id },
          });
          if (!ctx.quiet) log.success(`Replaced product line ${id}.`);
          emit(ctx, data, {
            warnings: [
              "PUT replaced `details` wholesale: keys that were not in --data are gone, along with the evidence they provided to generation.",
            ],
            next: [
              { why: "Confirm the stored blob", command: `senso product-lines get ${id}` },
            ],
          });
        }),
      ),
    {
      returns: ["The product line as it now stands: product_line_id, name, details, created_at, updated_at"],
      exitCodes: {
        ...idExits,
        1: "409 — another product line already has that name",
        2: "<id> is not a UUID; --data is not an object; `name` is missing or blank; or `details` is missing (which would silently clear it) or is not a JSON object",
        3: "no GEO product, or the role lacks update:product_line",
        4: "no product line with this id in your organization",
      },
      notes: ["`details` keys come back sorted; the input key order is not preserved."],
      examples: [
        {
          comment: "Read the current record first, so nothing is dropped by accident",
          command:
            "senso product-lines get 4c8e1b2a-77d3-4f10-bb92-0e5d6a9c1f31 --output json | jq .data",
        },
        {
          command:
            'senso product-lines update 4c8e1b2a-77d3-4f10-bb92-0e5d6a9c1f31 --data \'{"name":"Pro Plan","details":{"price_usd":129,"sku":"SENSO-PRO"}}\'',
        },
      ],
      seeAlso: ["senso product-lines patch <id>", "senso product-lines get <id>"],
    },
  );

  describeCommand(
    pl
      .command("patch")
      .description(
        "Change a product line's name, its details, or both (PATCH). Top-level fields you omit are left alone — but `details` is REPLACED, not merged: sending {\"details\":{\"price_usd\":129}} makes that the entire blob and drops every other key. To change one key, read the current blob and send it back whole.",
      )
      .argument("<id>", "A product_line_id (UUID) from `senso product-lines list`")
      .requiredOption("--data <json>", 'JSON: at least one of { "name": "...", "details": { ... } }')
      .action(
        runAction(program, async (ctx, rawId: string, cmdOpts: { data: string }) => {
          const id = parseId(rawId, PRODUCT_LINE_ID);
          const body = parseJsonFlag<ProductLineBody>(cmdOpts.data, {
            anyOf: ["name", "details"],
          });
          assertName(body);
          assertDetails(body);

          const fields = Object.keys(body).join(", ");
          const data = await apiRequest({
            method: "PATCH",
            path: `/org/product-lines/${id}`,
            // Only the keys the caller passed: the handler reads an absent key
            // as "leave it alone", and sending one we invented would not.
            body,
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
            resource: { ...PRODUCT_LINE_ID, id },
          });
          if (!ctx.quiet) log.success(`Patched product line ${id} (fields: ${fields}).`);
          emit(ctx, data, {
            warnings:
              body.details === undefined
                ? []
                : [
                    "`details` was replaced, not merged: keys absent from --data are gone. Merge instead with `senso product-lines get <id> --output json | jq -c '{details: (.data.details + {price_usd: 129})}'`.",
                  ],
            next: [{ why: "Confirm the stored blob", command: `senso product-lines get ${id}` }],
          });
        }),
      ),
    {
      returns: ["The product line as it now stands: product_line_id, name, details, created_at, updated_at"],
      exitCodes: {
        ...idExits,
        1: "409 — another product line already has that name",
        2: "<id> is not a UUID; --data is not an object; --data has neither `name` nor `details`; `name` is blank; or `details` is not a JSON object",
        3: "no GEO product, or the role lacks update:product_line",
        4: "no product line with this id in your organization",
      },
      examples: [
        {
          command:
            'senso product-lines patch 4c8e1b2a-77d3-4f10-bb92-0e5d6a9c1f31 --data \'{"name":"Pro Plan (2026)"}\'',
        },
        {
          comment: "Change one key of details without losing the rest",
          command:
            "senso product-lines patch 4c8e1b2a-77d3-4f10-bb92-0e5d6a9c1f31 --data \"$(senso product-lines get 4c8e1b2a-77d3-4f10-bb92-0e5d6a9c1f31 --output json | jq -c '{details: (.data.details + {price_usd: 129})}')\"",
        },
      ],
      seeAlso: ["senso product-lines get <id>", "senso product-lines update <id>"],
    },
  );

  describeCommand(
    pl
      .command("delete")
      .description(
        "Delete a product line. This cannot be undone, and there is no soft delete. Anything still holding the id stops resolving — a saved `senso generate --product-line-ids <id>`, and any Builder workspace or agent session whose selection includes it — and generation simply loses the evidence this product line was contributing.",
      )
      .argument("<id>", "A product_line_id (UUID) from `senso product-lines list`")
      .action(
        runAction(program, async (ctx, rawId: string) => {
          const id = parseId(rawId, PRODUCT_LINE_ID);
          await apiRequest({
            method: "DELETE",
            path: `/org/product-lines/${id}`,
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
            resource: { ...PRODUCT_LINE_ID, id },
          });
          emitConfirmation(
            ctx,
            `Deleted product line ${id}.`,
            { action: "deleted", resource: "product_line", id },
            {
              warnings: [
                `Any generation still passing --product-line-ids ${id} will no longer match it.`,
              ],
              next: [{ why: "Confirm what remains", command: "senso product-lines list" }],
            },
          );
        }),
      ),
    {
      returns: [
        'Nothing. The API answers 204, and --output json reports { "action": "deleted", "resource": "product_line", "id": "<id>" }.',
      ],
      exitCodes: {
        ...idExits,
        2: "<id> is not a UUID",
        3: "no GEO product, or the role lacks update:product_line (there is no separate delete permission)",
        4: "no product line with this id in your organization — it may already be gone",
      },
      examples: [
        {
          comment: "See what you are removing",
          command: "senso product-lines get 4c8e1b2a-77d3-4f10-bb92-0e5d6a9c1f31",
        },
        { command: "senso product-lines delete 4c8e1b2a-77d3-4f10-bb92-0e5d6a9c1f31" },
      ],
      seeAlso: ["senso product-lines list", "senso product-lines patch <id>"],
    },
  );
}
