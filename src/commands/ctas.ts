import { Command } from "commander";
import { ApiError, apiRequest } from "../lib/api-client.js";
import { parseIntFlag, requireEnumFlag } from "../lib/enum-arg.js";
import { CliError, EXIT, notFoundError, usageError } from "../lib/errors.js";
import { apiExits, describeCommand, idExits } from "../lib/help.js";
import { parseId, type IdSpec } from "../lib/id-arg.js";
import { parseJsonFlag } from "../lib/json-arg.js";
import { emit, emitConfirmation, type NextStep } from "../lib/output.js";
import type { ResourceRef } from "../lib/resource.js";
import { runAction } from "../lib/run-action.js";
import * as log from "../utils/logger.js";

/** The fields worth seeing when a response carries a list of templates. */
const CTA_COLUMNS = ["cta_id", "title", "button_label", "target_url", "is_default"];

/** What a content item's CTA selection may be. The API rejects anything else. */
const SELECTION_TYPES = ["default", "template", "none"] as const;

/** The image types the asset upload endpoint signs a URL for. */
const IMAGE_CONTENT_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

/** Which filename extensions each signed content type will accept. */
const IMAGE_EXTENSIONS: Record<string, string[]> = {
  "image/png": [".png"],
  "image/jpeg": [".jpg", ".jpeg"],
  "image/webp": [".webp"],
  "image/gif": [".gif"],
};

/** 10 MiB, the documented ceiling for a CTA image. */
const MAX_IMAGE_BYTES = 10_485_760;

/** Every key CTARequest accepts, with the API's own length limits. */
const CTA_REQUIRED = ["title", "button_label", "target_url"] as const;
const CTA_OPTIONAL = [
  "description",
  "eyebrow",
  "image_url",
  "image_position",
  "agent_text",
  "is_default",
] as const;

/** Maximum lengths, from dto.CTARequest's validate tags. */
const CTA_MAX_LENGTHS: Record<string, number> = {
  title: 255,
  button_label: 120,
  target_url: 2048,
  description: 2000,
  eyebrow: 120,
  image_url: 2048,
  agent_text: 2000,
};

const CTA_ID: IdSpec = {
  label: "<ctaId>",
  type: "CTA template",
  idField: "cta_id",
  list: "senso ctas list",
};

const CTA_ID_FLAG: IdSpec = { ...CTA_ID, label: "--cta-id" };

const CONTENT_ID: IdSpec = {
  label: "<contentId>",
  type: "Content",
  idField: "content_id",
  list: "senso content list",
};

function ctaResource(ctaId: string): ResourceRef {
  return { type: "CTA template", id: ctaId, idField: "cta_id", list: "senso ctas list" };
}

function contentResource(contentId: string): ResourceRef {
  return { type: "Content", id: contentId, idField: "content_id", list: "senso content list" };
}

/** The list response, unpacked so the table and plain renderings show templates. */
interface CtaListResponse {
  templates?: Record<string, unknown>[];
  default_cta?: { cta_id?: string };
}

/** A template as the API returns it, including what it did to live pages. */
interface CtaResponse {
  cta_id?: string;
  is_default?: boolean;
  live_update_queued?: boolean;
  live_update_count?: number;
}

interface ContentCtaSelectionResponse {
  content_id?: string;
  selection_type?: string;
  cta_id?: string;
}

export function registerCtaCommands(program: Command): void {
  const ctas = program
    .command("ctas")
    .description(
      "Call-to-action templates: the card attached to a published content-engine page, and which one each content item carries. One template can be the organization default; each item inherits it (default), pins one (template), or carries none. Requires the GEO product.",
    );

  describeCommand(ctas, {
    notes: [
      "Id spaces used here:",
      "  cta_id      a template, from `senso ctas list`",
      "  content_id  a content-engine content item, from `senso content list` or `senso generated-content list`",
      "",
      "Typical workflow:",
      "  1. senso ctas upload-url --filename hero.png --content-type image/png --size 48213   (optional) sign an image URL",
      "  2. curl -X PUT … the bytes to upload_url   the CLI does not upload the file itself",
      "  3. senso ctas create --data '{\"title\":…,\"button_label\":…,\"target_url\":…,\"is_default\":true}'",
      "  4. senso ctas set-for-content <content_id> --selection template --cta-id <cta_id>   pin one item, or leave items on default",
      "",
      "Reads need read:content; every write needs update:content.",
      "Writes reach live pages: changing or promoting a template updates the pages already carrying it.",
    ],
    seeAlso: ["senso content list", "senso generated-content list", "senso engine publish"],
  });

  describeCommand(
    ctas
      .command("list")
      .description(
        "List the organization's CTA templates, the default first and the rest oldest first. This is where a cta_id comes from for `ctas update`, `ctas delete`, `ctas set-default` and `ctas set-for-content`.",
      )
      .action(
        runAction(program, async (ctx) => {
          const data = await apiRequest<CtaListResponse>({
            path: "/org/ctas",
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
          });

          const templates = data.templates ?? [];
          // `default_cta` sits alongside `templates` and is not a pagination key,
          // so the generic row-finder declines the response. Naming the rows here
          // keeps both --output table and --output plain showing the templates.
          emit(ctx, data, {
            table: { rows: templates, columns: CTA_COLUMNS },
            rows: templates,
            columns: CTA_COLUMNS,
            empty: "CTA templates",
            emptyHint:
              "This organization has no CTA templates, so published pages carry no card. Create one with `senso ctas create`.",
            next:
              templates.length > 0 && data.default_cta?.cta_id === undefined
                ? [
                    {
                      why: "No template is the organization default, so items on the default selection carry no card",
                      command: "senso ctas set-default <cta_id>",
                    },
                  ]
                : [],
          });
        }),
      ),
    {
      returns: [
        "templates[], default_cta (the one with is_default: true, absent when none is set), total",
        "cta_id — what `ctas update`, `ctas delete`, `ctas set-default` and `ctas set-for-content --cta-id` take",
        "title, description, button_label, target_url, eyebrow — the card's text",
        "image_url — the card image; image_position is its {x, y} focal point, each 0 to 1",
        "agent_text — optional text for AI agents; resolved_agent_text is the same with the organization name substituted",
        "is_default — true on at most one template",
      ],
      exitCodes: {
        ...apiExits,
        0: "success, including when there are no templates",
        3: "no GEO product, or the key lacks read:content",
      },
      examples: [
        { command: "senso ctas list" },
        {
          comment: "The id of the organization default",
          command: "senso ctas list --output json | jq -r .data.default_cta.cta_id",
        },
      ],
      seeAlso: ["senso ctas create", "senso ctas set-default"],
    },
  );

  describeCommand(
    ctas
      .command("create")
      .description(
        'Create a CTA template and return it with its new cta_id. With "is_default": true it becomes the organization default in the same call, replacing any previous default — and the live pages that inherit the default are updated.',
      )
      .requiredOption(
        "--data <json>",
        'JSON: { "title": <=255, "button_label": <=120, "target_url": absolute URL, "description": <=2000, "eyebrow": <=120, "image_url": absolute URL, "image_position": {"x":0-1,"y":0-1}, "agent_text": <=2000, "is_default": bool }',
      )
      .action(
        runAction(program, async (ctx, cmdOpts: { data: string }) => {
          const body = parseJsonFlag(cmdOpts.data, {
            required: CTA_REQUIRED,
            optional: CTA_OPTIONAL,
          });
          validateCtaBody(body);

          const data = await apiRequest<CtaResponse>({
            method: "POST",
            path: "/org/ctas",
            body,
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
            resource: { type: "CTA template", list: "senso ctas list" },
          });

          if (!ctx.quiet) log.success(`Created CTA template ${String(data.cta_id)}.`);
          emit(ctx, data, {
            warnings: livePageWarnings(data),
            next: templateNextSteps(data.cta_id),
          });
        }),
      ),
    {
      returns: [
        "cta_id — use it with `ctas set-default`, `ctas update` and `ctas set-for-content --cta-id`",
        "resolved_agent_text — agent_text with the organization's name substituted",
        "is_default — whether this template is now the organization default",
        "live_update_queued and live_update_count — how many live pages were queued for update because the default moved",
      ],
      exitCodes: {
        ...apiExits,
        0: "created",
        2: "--data is not valid JSON, is missing title, button_label or target_url, has an unknown key, a non-absolute URL, or an over-length value",
        3: "no GEO product, or the key lacks update:content",
      },
      notes: [
        'With "is_default": true this changes what every page on the default selection shows, including pages that are already live.',
      ],
      examples: [
        {
          command:
            'senso ctas create --data \'{"title":"Start an application","button_label":"Apply now","target_url":"https://acme.example/apply"}\'',
        },
        {
          comment: "Create it as the organization default and keep its id",
          command:
            'senso ctas create --data \'{"title":"Start an application","button_label":"Apply now","target_url":"https://acme.example/apply","is_default":true}\' --output json | jq -r .data.cta_id',
        },
      ],
      seeAlso: ["senso ctas upload-url", "senso ctas set-default", "senso ctas set-for-content"],
    },
  );

  describeCommand(
    ctas
      .command("update <ctaId>")
      .description(
        'Replace a CTA template (PUT) and return it. The body is the WHOLE template: any optional key you omit is cleared, so read the current values with `senso ctas list` first. "is_default": true promotes it; false or omitted leaves the default flag as it is. Live pages carrying this template are updated to match.',
      )
      .requiredOption(
        "--data <json>",
        "JSON with the same keys and limits as `senso ctas create`. title, button_label and target_url are required on every call.",
      )
      .action(
        runAction(program, async (ctx, ctaId: string, cmdOpts: { data: string }) => {
          const id = parseId(ctaId, CTA_ID);
          const body = parseJsonFlag(cmdOpts.data, {
            required: CTA_REQUIRED,
            optional: CTA_OPTIONAL,
          });
          validateCtaBody(body);

          const data = await apiRequest<CtaResponse>({
            method: "PUT",
            path: `/org/ctas/${id}`,
            body,
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
            resource: ctaResource(id),
          });

          if (!ctx.quiet) log.success(`Updated CTA template ${id}.`);
          emit(ctx, data, {
            warnings: livePageWarnings(data),
            next: templateNextSteps(id),
          });
        }),
      ),
    {
      returns: [
        "The whole template as it now stands.",
        "live_update_queued and live_update_count — how many live pages were queued to show the new card",
      ],
      exitCodes: {
        ...idExits,
        0: "updated",
        2: "ctaId is not a UUID, or --data is invalid (see `senso ctas create --help`)",
        3: "no GEO product, or the key lacks update:content",
        4: "no CTA template with this id in this organization",
      },
      notes: [
        "PUT replaces: an optional key you leave out is cleared, not kept.",
        "Every page already live with this template is updated to the new card.",
      ],
      examples: [
        {
          command:
            'senso ctas update b7e2c1d0-3f4a-4b5c-9d6e-7f8a9b0c1d2e --data \'{"title":"Start an application","button_label":"Apply today","target_url":"https://acme.example/apply"}\'',
        },
        {
          comment: "How many live pages the edit touched",
          command:
            "senso ctas update b7e2c1d0-3f4a-4b5c-9d6e-7f8a9b0c1d2e --data '{…}' --output json | jq .data.live_update_count",
        },
      ],
      seeAlso: ["senso ctas list", "senso ctas create"],
    },
  );

  describeCommand(
    ctas
      .command("delete <ctaId>")
      .description(
        "Delete a CTA template. The organization default cannot be deleted: clear it with `senso ctas clear-default`, or make another template the default first. Content items pinned to the deleted template fall back to the default.",
      )
      .action(
        runAction(program, async (ctx, ctaId: string) => {
          const id = parseId(ctaId, CTA_ID);
          try {
            await apiRequest({
              method: "DELETE",
              path: `/org/ctas/${id}`,
              apiKey: ctx.apiKey,
              baseUrl: ctx.baseUrl,
              resource: ctaResource(id),
            });
          } catch (err) {
            throw explainDeleteConflict(err, id);
          }

          emitConfirmation(
            ctx,
            `Deleted CTA template ${id}.`,
            { action: "deleted", resource: "cta_template", id },
            {
              warnings: [
                "Pages already live with this card keep it until they are next published; items pinned to it fall back to the organization default.",
              ],
              next: [{ why: "See what is left", command: "senso ctas list" }],
            },
          );
        }),
      ),
    {
      returns: [
        "action: deleted, resource: cta_template, id — the template that was removed",
      ],
      exitCodes: {
        ...idExits,
        0: "deleted",
        2: "ctaId is not a UUID",
        3: "no GEO product, or the key lacks update:content",
        4: "no CTA template with this id in this organization",
        1: "the template is the organization default (409)",
      },
      examples: [
        { command: "senso ctas delete b7e2c1d0-3f4a-4b5c-9d6e-7f8a9b0c1d2e" },
        {
          comment: "Clear the default first when the template is it",
          command: "senso ctas clear-default && senso ctas delete b7e2c1d0-3f4a-4b5c-9d6e-7f8a9b0c1d2e",
        },
      ],
      seeAlso: ["senso ctas list", "senso ctas clear-default", "senso ctas set-default"],
    },
  );

  describeCommand(
    ctas
      .command("set-default <ctaId>")
      .description(
        "Make a template the organization default, replacing any previous default, and return it. Every content item on the `default` selection now resolves to this template: pages that are already live and inherit the default are updated immediately, and everything else picks it up at its next publish.",
      )
      .action(
        runAction(program, async (ctx, ctaId: string) => {
          const id = parseId(ctaId, CTA_ID);
          const data = await apiRequest<CtaResponse>({
            method: "PUT",
            path: "/org/ctas/default",
            body: { cta_id: id },
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
            resource: ctaResource(id),
          });

          if (!ctx.quiet) log.success(`CTA template ${id} is now the organization default.`);
          emit(ctx, data, {
            warnings: livePageWarnings(data),
            next: [
              {
                why: "Confirm which template each content item carries",
                command: "senso ctas for-content <content_id>",
              },
            ],
          });
        }),
      ),
    {
      returns: [
        "The template, with is_default: true.",
        "live_update_queued and live_update_count — the live pages inheriting the default that were queued for update",
      ],
      exitCodes: {
        ...idExits,
        0: "set",
        2: "ctaId is not a UUID",
        3: "no GEO product, or the key lacks update:content",
        4: "no CTA template with this id in this organization",
      },
      notes: [
        "This changes published pages: any live page whose selection is `default` is updated to this card now.",
      ],
      examples: [
        { command: "senso ctas set-default b7e2c1d0-3f4a-4b5c-9d6e-7f8a9b0c1d2e" },
        {
          comment: "How many live pages changed",
          command:
            "senso ctas set-default b7e2c1d0-3f4a-4b5c-9d6e-7f8a9b0c1d2e --output json | jq .data.live_update_count",
        },
      ],
      seeAlso: ["senso ctas clear-default", "senso ctas list", "senso ctas for-content"],
    },
  );

  describeCommand(
    ctas
      .command("clear-default")
      .description(
        "Make no template the organization default. Live content items that inherit the default switch to no CTA and their pages drop the card; items that are not live keep the `default` selection, which resolves to nothing until a default is set again. Succeeds even when no default was set.",
      )
      .action(
        runAction(program, async (ctx) => {
          await apiRequest({
            method: "DELETE",
            path: "/org/ctas/default",
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
            resource: { type: "Default CTA template", list: "senso ctas list" },
          });

          emitConfirmation(
            ctx,
            "No template is the organization default any more.",
            { action: "cleared", resource: "default_cta" },
            {
              warnings: [
                "Live pages that inherited the default have dropped their card. Pinned items (selection_type: template) are unaffected.",
              ],
              next: [
                {
                  why: "Choose a new default",
                  command: "senso ctas set-default <cta_id>",
                },
              ],
            },
          );
        }),
      ),
    {
      returns: ["action: cleared, resource: default_cta — no template is the default now"],
      exitCodes: {
        ...apiExits,
        0: "cleared, including when there was no default",
        3: "no GEO product, or the key lacks update:content",
      },
      notes: [
        "This changes published pages: every live page on the `default` selection loses its card.",
      ],
      examples: [
        { command: "senso ctas clear-default" },
        { command: "senso ctas clear-default --output json" },
      ],
      seeAlso: ["senso ctas set-default", "senso ctas list"],
    },
  );

  describeCommand(
    ctas
      .command("for-content <contentId>")
      .description(
        "Show which CTA a content item carries when it is published — default (the organization default), template (a pinned cta_id), or none — and the template that selection resolves to.",
      )
      .action(
        runAction(program, async (ctx, contentId: string) => {
          const id = parseId(contentId, CONTENT_ID);
          const data = await apiRequest<ContentCtaSelectionResponse>({
            path: `/org/content/${id}/cta`,
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
            resource: contentResource(id),
          });
          emit(ctx, data, {
            next: [
              {
                why: "Change what this item carries",
                command: `senso ctas set-for-content ${id} --selection template --cta-id <cta_id>`,
              },
            ],
          });
        }),
      ),
    {
      returns: [
        "selection_type — default (inherits the organization default) | template (pins cta_id) | none (no card)",
        "cta_id — set when selection_type is template",
        "template — the resolved template; absent when the selection resolves to nothing (none, or default with no default set)",
        "created_at and updated_at — absent when no selection was ever stored, which means the item is implicitly default",
      ],
      exitCodes: {
        ...idExits,
        2: "contentId is not a UUID",
        3: "no GEO product, or the key lacks read:content",
        4: "no content-engine content with this id in this organization — only content-engine content has a CTA selection",
      },
      examples: [
        { command: "senso ctas for-content 9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f" },
        {
          command:
            "senso ctas for-content 9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f --output json | jq -r .data.selection_type",
        },
      ],
      seeAlso: ["senso ctas set-for-content", "senso ctas list"],
    },
  );

  describeCommand(
    ctas
      .command("set-for-content <contentId>")
      .description(
        "Choose which CTA a content item carries when it is published, and return the stored selection. This replaces the previous selection, and if the item is already live its page is updated now.",
      )
      .requiredOption(
        "--selection <type>",
        "default (inherit the organization default) | template (pin --cta-id) | none (publish without a card)",
      )
      .option(
        "--cta-id <uuid>",
        "The template to pin, from `senso ctas list`. Required with --selection template, and rejected otherwise.",
      )
      .action(
        runAction(
          program,
          async (ctx, contentId: string, cmdOpts: { selection: string; ctaId?: string }) => {
            const id = parseId(contentId, CONTENT_ID);
            const selectionType = requireEnumFlag("--selection", cmdOpts.selection, SELECTION_TYPES);
            // The API rejects both mismatches, but it costs a round trip to be
            // told so — and "cta_id must be omitted" is not obviously about a flag
            // the caller did pass.
            if (selectionType === "template" && !cmdOpts.ctaId) {
              throw usageError("--cta-id is required with --selection template.", {
                field: "--cta-id",
                hint: "Run `senso ctas list` for the cta_id, or use --selection default to inherit the organization default.",
              });
            }
            if (selectionType !== "template" && cmdOpts.ctaId) {
              throw usageError(
                `--cta-id may only be used with --selection template, not ${selectionType}.`,
                {
                  field: "--cta-id",
                  received: cmdOpts.ctaId,
                  hint: "Drop --cta-id, or pass --selection template to pin it.",
                },
              );
            }

            const body: Record<string, unknown> = { selection_type: selectionType };
            if (cmdOpts.ctaId) body.cta_id = parseId(cmdOpts.ctaId, CTA_ID_FLAG);

            let data: ContentCtaSelectionResponse;
            try {
              data = await apiRequest<ContentCtaSelectionResponse>({
                method: "PUT",
                path: `/org/content/${id}/cta`,
                body,
                apiKey: ctx.apiKey,
                baseUrl: ctx.baseUrl,
                resource: contentResource(id),
              });
            } catch (err) {
              throw explainSelectionFailure(err, id, body.cta_id as string | undefined);
            }

            // Pinning the template that is already the default is stored as
            // `default` by the service, so a caller verifying its own write
            // finds a selection_type it never asked for.
            const warnings =
              data.selection_type !== selectionType
                ? [
                    `Stored as selection_type "${String(data.selection_type)}" rather than "${selectionType}": pinning the template that is currently the organization default is recorded as default.`,
                  ]
                : [];

            if (!ctx.quiet) log.success(`CTA selection updated for content ${id}.`);
            emit(ctx, data, {
              warnings,
              next: [
                {
                  why: "Read back what this item now carries",
                  command: `senso ctas for-content ${id}`,
                },
              ],
            });
          },
        ),
      ),
    {
      returns: [
        "selection_type — default | template | none, as stored",
        "cta_id and template — the template the stored selection resolves to",
        "updated_by, created_at, updated_at — who last set it, and when",
      ],
      exitCodes: {
        ...idExits,
        0: "stored",
        2: "contentId or --cta-id is not a UUID; --selection is not default|template|none; --cta-id is missing with template or present without it",
        3: "no GEO product, or the key lacks update:content",
        4: "the content, or the template named by --cta-id, is not in this organization — the message says which",
      },
      notes: [
        "If the item is already live, its published page is updated as part of this call.",
        "Pinning the current organization default collapses to selection_type: default; the response says so and the CLI warns.",
      ],
      examples: [
        {
          command:
            "senso ctas set-for-content 9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f --selection template --cta-id b7e2c1d0-3f4a-4b5c-9d6e-7f8a9b0c1d2e",
        },
        {
          comment: "Publish this one without a card",
          command:
            "senso ctas set-for-content 9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f --selection none",
        },
      ],
      seeAlso: ["senso ctas for-content", "senso ctas list", "senso ctas set-default"],
    },
  );

  describeCommand(
    ctas
      .command("upload-url")
      .description(
        "Get a short-lived pre-signed URL for a CTA image. The CLI does not upload the file: PUT the bytes to upload_url yourself with exactly the returned upload_headers, then pass the returned image_url as a template's image_url in `ctas create` or `ctas update`.",
      )
      .requiredOption(
        "--filename <name>",
        "The file's name, at most 255 characters. Its extension, when it has one, must match --content-type.",
      )
      .requiredOption(
        "--content-type <type>",
        "The image media type: image/png | image/jpeg | image/webp | image/gif",
      )
      .requiredOption("--size <bytes>", "The file size in bytes, 1 to 10485760 (10 MiB)")
      .action(
        runAction(
          program,
          async (ctx, cmdOpts: { filename: string; contentType: string; size: string }) => {
            const contentType = requireEnumFlag(
              "--content-type",
              cmdOpts.contentType,
              IMAGE_CONTENT_TYPES,
            );
            const filename = parseFilename(cmdOpts.filename, contentType);
            const fileSize = parseIntFlag("--size", cmdOpts.size, { min: 1, max: MAX_IMAGE_BYTES });

            const data = await apiRequest<{ upload_url?: string; image_url?: string }>({
              method: "POST",
              path: "/org/cta-assets/upload-url",
              body: {
                filename,
                content_type: contentType,
                file_size_bytes: fileSize,
              },
              apiKey: ctx.apiKey,
              baseUrl: ctx.baseUrl,
            });

            emit(ctx, data, {
              next: [
                {
                  why: "Upload the bytes yourself before the URL expires",
                  command: `curl -X PUT -H 'Content-Type: ${contentType}' --data-binary @${filename} '${String(data.upload_url)}'`,
                },
                {
                  why: "Then create the template with the image",
                  command: `senso ctas create --data '{"title":"…","button_label":"…","target_url":"https://…","image_url":"${String(data.image_url)}"}'`,
                },
              ],
            });
          },
        ),
      ),
    {
      returns: [
        "upload_url — PUT the bytes here before expires_in seconds elapse",
        "upload_headers — send exactly these headers on the PUT (Content-Type, Cache-Control)",
        "image_url — the public URL to store as image_url on a template",
        "object_key — the storage key, informational",
        "expires_in — how many seconds the signed URL is valid for",
      ],
      exitCodes: {
        ...apiExits,
        2: "--content-type is not one of the four image types, --size is outside 1..10485760, --filename is over 255 characters, or its extension does not match --content-type",
        3: "no GEO product, or the key lacks update:content",
        1: "image storage is not configured on this deployment (503)",
      },
      notes: [
        "The CLI never uploads the file. Nothing is stored until you PUT the bytes yourself.",
      ],
      examples: [
        {
          command:
            "senso ctas upload-url --filename hero.png --content-type image/png --size $(stat -c%s hero.png)",
        },
        {
          comment: "Sign, then upload",
          command:
            "U=$(senso ctas upload-url --filename hero.png --content-type image/png --size 48213 --output json); curl -X PUT -H \"Content-Type: image/png\" --data-binary @hero.png \"$(echo \"$U\" | jq -r .data.upload_url)\"",
        },
      ],
      seeAlso: ["senso ctas create", "senso ctas update"],
    },
  );
}

/**
 * Checks a CTA body against the shape the API validates it with.
 *
 * Worth doing here because the API's own answers do not name what to fix: a
 * misspelled key is dropped silently and surfaces as "button_label: This field
 * is required", and a relative target_url comes back as the validator's default
 * "Invalid value", which says nothing about needing a scheme and a host.
 */
function validateCtaBody(body: Record<string, unknown>): void {
  for (const key of [...CTA_REQUIRED, "description", "eyebrow", "agent_text"] as const) {
    const value = body[key];
    if (value === undefined) continue;
    if (typeof value !== "string") {
      throw usageError(`Invalid --data: ${key} must be a string.`, {
        field: `--data.${key}`,
        received: JSON.stringify(value),
      });
    }
    if ((CTA_REQUIRED as readonly string[]).includes(key) && value.trim() === "") {
      throw usageError(`Invalid --data: ${key} is empty.`, {
        field: `--data.${key}`,
        received: value,
        hint: `Required keys: ${CTA_REQUIRED.join(", ")}.`,
      });
    }
    const max = CTA_MAX_LENGTHS[key];
    if (max !== undefined && value.length > max) {
      throw usageError(
        `Invalid --data: ${key} is ${String(value.length)} characters, the maximum is ${String(max)}.`,
        { field: `--data.${key}`, received: `(${String(value.length)} characters)` },
      );
    }
  }

  for (const key of ["target_url", "image_url"] as const) {
    const value = body[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || !isAbsoluteUrl(value)) {
      throw usageError(
        `Invalid --data: ${key} must be an absolute URL, got ${JSON.stringify(value)}.`,
        {
          field: `--data.${key}`,
          received: typeof value === "string" ? value : JSON.stringify(value),
          hint: `Example: "${key}": "https://acme.example/apply"`,
        },
      );
    }
    const max = CTA_MAX_LENGTHS[key] ?? 2048;
    if (value.length > max) {
      throw usageError(
        `Invalid --data: ${key} is ${String(value.length)} characters, the maximum is ${String(max)}.`,
        { field: `--data.${key}`, received: `(${String(value.length)} characters)` },
      );
    }
  }

  if (body.is_default !== undefined && typeof body.is_default !== "boolean") {
    throw usageError("Invalid --data: is_default must be true or false.", {
      field: "--data.is_default",
      received: JSON.stringify(body.is_default),
      allowed: ["true", "false"],
    });
  }

  const position = body.image_position;
  if (position !== undefined && position !== null) {
    const point = position as Record<string, unknown>;
    if (typeof position !== "object" || Array.isArray(position)) {
      throw usageError("Invalid --data: image_position must be an object.", {
        field: "--data.image_position",
        received: JSON.stringify(position),
        hint: 'Example: "image_position": {"x": 0.5, "y": 0.25}',
      });
    }
    for (const axis of ["x", "y"] as const) {
      const value = point[axis];
      if (typeof value !== "number" || value < 0 || value > 1) {
        throw usageError(
          `Invalid --data: image_position.${axis} must be a number between 0 and 1.`,
          {
            field: `--data.image_position.${axis}`,
            received: JSON.stringify(value),
            hint: 'Example: "image_position": {"x": 0.5, "y": 0.25}',
          },
        );
      }
    }
  }
}

function isAbsoluteUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * The filename's extension has to agree with the signed content type.
 *
 * The API compares them and answers "unsupported CTA image content type", which
 * reads as though the media type itself were wrong rather than the pairing.
 */
function parseFilename(value: string, contentType: string): string {
  const filename = value.trim();
  if (filename.length === 0 || filename.length > 255) {
    throw usageError(
      `Invalid --filename: ${filename.length === 0 ? "it is empty" : `${String(filename.length)} characters, the maximum is 255`}.`,
      { field: "--filename", received: value },
    );
  }
  const dot = filename.lastIndexOf(".");
  if (dot <= 0) return filename;

  const extension = filename.slice(dot).toLowerCase();
  const allowed = IMAGE_EXTENSIONS[contentType] ?? [];
  if (!allowed.includes(extension)) {
    throw usageError(
      `Invalid --filename: "${filename}" does not match --content-type ${contentType}.`,
      {
        field: "--filename",
        received: filename,
        allowed,
        hint: `${contentType} expects ${allowed.join(" or ")}.`,
      },
    );
  }
  return filename;
}

/** Says out loud when a write reached pages that are already published. */
function livePageWarnings(data: CtaResponse): string[] {
  const count = data.live_update_count ?? 0;
  if (count === 0) return [];
  return [
    `${String(count)} live page${count === 1 ? "" : "s"} carrying this template ${count === 1 ? "was" : "were"} queued for update, so published pages will change.`,
  ];
}

function templateNextSteps(ctaId: string | undefined): NextStep[] {
  if (!ctaId) return [];
  return [
    {
      why: "Pin it on a content item (or leave items on the default)",
      command: `senso ctas set-for-content <content_id> --selection template --cta-id ${ctaId}`,
    },
    { why: "Make it the organization default", command: `senso ctas set-default ${ctaId}` },
  ];
}

/**
 * The 409 that already has a fix written down in the help text.
 *
 * `toCliError` passes a conflict's message through without a hint, and "default
 * CTA template cannot be deleted" does not name the command that clears the
 * default — which is the one thing the caller has to do first.
 */
function explainDeleteConflict(err: unknown, id: string): unknown {
  if (!(err instanceof ApiError) || err.status !== 409) return err;
  return new CliError(`Cannot delete CTA template ${id}: ${err.message}`, EXIT.ERROR, {
    code: "conflict",
    status: 409,
    field: "<ctaId>",
    received: id,
    hint: "Clear the organization default first: senso ctas clear-default",
    request: err.request,
    cause: err,
  });
}

/**
 * Tells the two 404s of `set-for-content` apart.
 *
 * The route can miss on the content OR on the template named by --cta-id, and
 * both arrive as a 404. Reported identically, a caller cannot tell which of the
 * two ids it got wrong.
 */
function explainSelectionFailure(err: unknown, contentId: string, ctaId?: string): unknown {
  if (!(err instanceof ApiError) || err.status !== 404) return err;
  if (ctaId && /cta template/i.test(err.message)) {
    return notFoundError(
      { type: "CTA template", id: ctaId, idField: "cta_id", list: "senso ctas list" },
      { request: err.request, cause: err },
    );
  }
  return notFoundError(
    { type: "Content", id: contentId, idField: "content_id", list: "senso content list" },
    {
      hint: "Only content-engine content has a CTA selection. List it with `senso content list`.",
      request: err.request,
      cause: err,
    },
  );
}

