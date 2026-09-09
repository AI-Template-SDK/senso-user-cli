import { Command } from "commander";
import { apiRequest } from "../lib/api-client.js";
import { parseEnumFlag, parseIntFlag } from "../lib/enum-arg.js";
import { CliError, EXIT } from "../lib/errors.js";
import { parseJsonFlag } from "../lib/json-arg.js";
import { emit } from "../lib/output.js";
import { runAction } from "../lib/run-action.js";
import * as log from "../utils/logger.js";

/** The fields worth seeing when a response carries a list of templates. */
const CTA_COLUMNS = ["cta_id", "title", "button_label", "target_url", "is_default"];

/** What a content item's CTA selection may be. The API rejects anything else. */
const SELECTION_TYPES = ["default", "template", "none"] as const;

/** The image types the asset upload endpoint signs a URL for. */
const IMAGE_CONTENT_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

/** 10 MiB, the documented ceiling for a CTA image. */
const MAX_IMAGE_BYTES = 10_485_760;

/** The list response, unpacked so the table and plain renderings show templates. */
interface CtaListResponse {
  templates?: Record<string, unknown>[];
}

export function registerCtaCommands(program: Command): void {
  const ctas = program
    .command("ctas")
    .description(
      "Manage call-to-action (CTA) templates — the card attached to a published content-engine page — and choose which one each content item carries. One template can be the organization default; content items either inherit it, pin a specific template, or publish with no CTA. Requires the GEO product.",
    );

  ctas
    .command("list")
    .description(
      "List every CTA template in the organization, the default first and the rest oldest first. This is where a cta_id comes from for 'ctas update', 'ctas delete', 'ctas set-default' and 'ctas set-for-content'. The full payload also carries default_cta, the template currently set as the organization default.",
    )
    .action(
      runAction(program, async (ctx) => {
        const data = await apiRequest<CtaListResponse>({
          path: "/org/ctas",
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        // `default_cta` sits alongside `templates` and is not a pagination key,
        // so the generic row-finder declines the response. Naming the rows here
        // keeps both --output table and --output plain showing the templates.
        emit(ctx, data, {
          table: { rows: data.templates ?? [], columns: CTA_COLUMNS },
          columns: CTA_COLUMNS,
        });
      }),
    );

  ctas
    .command("create")
    .description(
      "Create a CTA template and return it, including its new cta_id. 'title', 'button_label' and 'target_url' are required; 'image_url' is typically one returned by 'ctas upload-url'. Pass \"is_default\": true to make it the organization default in the same call, replacing any previous default.",
    )
    .requiredOption(
      "--data <json>",
      'JSON: { "title": "Start an application", "description": "Book a short consultation.", "button_label": "Apply now", "target_url": "https://example.com/apply", "eyebrow": "Get started", "image_url": "https://...", "agent_text": "...", "is_default": false }',
    )
    .action(
      runAction(program, async (ctx, cmdOpts: { data: string }) => {
        const body = parseJsonFlag(cmdOpts.data);
        const data = await apiRequest({
          method: "POST",
          path: "/org/ctas",
          body,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        if (!ctx.quiet) log.success("CTA template created.");
        emit(ctx, data);
      }),
    );

  ctas
    .command("update <ctaId>")
    .description(
      "Replace a CTA template's fields (PUT) and return it. The body is the full template — any optional field you omit is cleared, so read the current values with 'ctas list' first. \"is_default\": true promotes it to the organization default; false or omitted leaves the default flag as it is. Live pages carrying this template are updated to match, and the response reports how many.",
    )
    .requiredOption(
      "--data <json>",
      'JSON: { "title": "Start an application", "button_label": "Apply today", "target_url": "https://example.com/apply" }',
    )
    .action(
      runAction(program, async (ctx, ctaId: string, cmdOpts: { data: string }) => {
        const body = parseJsonFlag(cmdOpts.data);
        const data = await apiRequest({
          method: "PUT",
          path: `/org/ctas/${ctaId}`,
          body,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        if (!ctx.quiet) log.success(`CTA template ${ctaId} updated.`);
        emit(ctx, data);
      }),
    );

  ctas
    .command("delete <ctaId>")
    .description(
      "Delete a CTA template. The organization default cannot be deleted — run 'ctas clear-default' or 'ctas set-default <ctaId>' first, or this exits 1 on a 409. Content items pinned to the deleted template fall back to the default; pages already live keep it until they are next published. Take the cta_id from 'ctas list'.",
    )
    .action(
      runAction(program, async (ctx, ctaId: string) => {
        const data = await apiRequest({
          method: "DELETE",
          path: `/org/ctas/${ctaId}`,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        if (!ctx.quiet) log.success(`CTA template ${ctaId} deleted.`);
        emit(ctx, data);
      }),
    );

  ctas
    .command("set-default <ctaId>")
    .description(
      "Make a CTA template the organization default, replacing any previous default, and return the template. Content items that inherit the default show it from the next publish; live pages inheriting it are updated, and the response reports how many carry the template. Take the cta_id from 'ctas list'.",
    )
    .action(
      runAction(program, async (ctx, ctaId: string) => {
        const data = await apiRequest({
          method: "PUT",
          path: "/org/ctas/default",
          body: { cta_id: ctaId },
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        if (!ctx.quiet) log.success(`CTA template ${ctaId} is now the organization default.`);
        emit(ctx, data);
      }),
    );

  ctas
    .command("clear-default")
    .description(
      "Clear the organization default so that no template is the default. Live content items inheriting the default switch to no CTA and their pages drop the card; items that are not live keep 'default', which resolves to nothing until a default is set again. Succeeds even when no default was set.",
    )
    .action(
      runAction(program, async (ctx) => {
        const data = await apiRequest({
          method: "DELETE",
          path: "/org/ctas/default",
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        if (!ctx.quiet) log.success("No template is the organization default any more.");
        emit(ctx, data);
      }),
    );

  ctas
    .command("for-content <contentId>")
    .description(
      "Show which CTA a content item carries when it is published: 'default' (the organization default), 'template' (a pinned cta_id), or 'none'. The payload also carries the template the selection resolves to. Only content-engine content has a selection — anything else exits 4. Content IDs come from 'content list' or 'generated-content list'.",
    )
    .action(
      runAction(program, async (ctx, contentId: string) => {
        const data = await apiRequest({
          path: `/org/content/${contentId}/cta`,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emit(ctx, data);
      }),
    );

  ctas
    .command("set-for-content <contentId>")
    .description(
      "Set which CTA a content item carries when it is published, and return the resulting selection. --selection default inherits the organization default, template pins the one named by --cta-id, and none publishes without a CTA. This is a full replacement. If the item is already live, its page is updated to match. Content IDs come from 'content list'; cta_ids from 'ctas list'.",
    )
    .requiredOption("--selection <type>", "What to carry: default | template | none")
    .option("--cta-id <ctaId>", "The template to pin. Required with --selection template only.")
    .action(
      runAction(
        program,
        async (ctx, contentId: string, cmdOpts: { selection: string; ctaId?: string }) => {
          const selectionType = parseEnumFlag("--selection", cmdOpts.selection, SELECTION_TYPES);
          // The API rejects both mismatches, but it costs a round trip to be
          // told so — and "cta_id must be omitted" is not obviously about a flag
          // the caller did pass.
          if (selectionType === "template" && !cmdOpts.ctaId) {
            throw new CliError("--cta-id is required with --selection template.", EXIT.USAGE, {
              code: "usage",
              hint: "Run 'senso ctas list' for the cta_id, or use --selection default to inherit the organization default.",
            });
          }
          if (selectionType !== "template" && cmdOpts.ctaId) {
            throw new CliError(
              `--cta-id may only be used with --selection template, not ${String(selectionType)}.`,
              EXIT.USAGE,
              { code: "usage", hint: "Drop --cta-id, or pass --selection template to pin it." },
            );
          }

          const body: Record<string, unknown> = { selection_type: selectionType };
          if (cmdOpts.ctaId) body.cta_id = cmdOpts.ctaId;

          const data = await apiRequest({
            method: "PUT",
            path: `/org/content/${contentId}/cta`,
            body,
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
          });
          if (!ctx.quiet) log.success(`CTA selection updated for content ${contentId}.`);
          emit(ctx, data);
        },
      ),
    );

  ctas
    .command("upload-url")
    .description(
      "Get a short-lived pre-signed URL for a CTA image. Upload the bytes yourself with an HTTP PUT to 'upload_url', sending exactly the returned 'upload_headers', then pass the returned 'image_url' as a template's image_url in 'ctas create' or 'ctas update'. Exits 1 with a 503 when image storage is not configured for the deployment.",
    )
    .requiredOption(
      "--filename <name>",
      "The file's name. Its extension, when it has one, must match --content-type.",
    )
    .requiredOption(
      "--content-type <type>",
      "The image media type: image/png | image/jpeg | image/webp | image/gif",
    )
    .requiredOption("--size <bytes>", "The file size in bytes, at most 10485760 (10 MiB)")
    .action(
      runAction(
        program,
        async (ctx, cmdOpts: { filename: string; contentType: string; size: string }) => {
          const contentType = parseEnumFlag(
            "--content-type",
            cmdOpts.contentType,
            IMAGE_CONTENT_TYPES,
          );
          const fileSize = parseIntFlag("--size", cmdOpts.size, { min: 1, max: MAX_IMAGE_BYTES });
          const data = await apiRequest({
            method: "POST",
            path: "/org/cta-assets/upload-url",
            body: {
              filename: cmdOpts.filename,
              content_type: contentType,
              file_size_bytes: fileSize,
            },
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
          });
          emit(ctx, data);
        },
      ),
    );
}
