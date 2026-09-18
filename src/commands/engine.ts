import { Command } from "commander";
import { apiRequest } from "../lib/api-client.js";
import { CliError, EXIT } from "../lib/errors.js";
import { parseJsonFlag } from "../lib/json-arg.js";
import { emit } from "../lib/output.js";
import { runAction, type Ctx } from "../lib/run-action.js";
import * as log from "../utils/logger.js";

/**
 * One destination's outcome. A publish answers 200 even when a destination
 * failed, so this is where the real result lives.
 */
interface PublishDestination {
  publisher?: string;
  display_url?: string;
  status?: string;
  error_msg?: string;
}

interface PublishResponse {
  content_id?: string;
  version_id?: string;
  publish_destinations?: PublishDestination[];
}

/**
 * Report what actually happened to each destination.
 *
 * `apiRequest` throws on a non-2xx, so reaching here means the content was
 * versioned — but a publish returns 200 with a per-destination `status`, and
 * printing "Content published." without reading those announced a success that
 * had not happened.
 *
 * Classification follows the server, which tests POSITIVELY for `success`
 * (`anySuccess` in content_engine_service.go) rather than testing for failure.
 * That distinction is load-bearing, because "not failed" is not "landed":
 *
 *   success  the destination published
 *   queued   accepted for async publishing — fine, but nothing is live yet
 *   pending  carries an error_msg ("publish record saved but enqueue failed")
 *   failed   did not publish
 *
 * So a destination counts as a problem when it is `failed` OR carries an
 * `error_msg`; an earlier version tested only for `failed` and reported an
 * all-`pending` publish as a clean success.
 *
 * A partial failure leaves the content saved and some destinations live, so it
 * warns and exits 0. Every destination failing is a failed publish: it exits 1
 * with an empty stdout, like `website-import start`, carrying the reasons and
 * the content id in the error — the error is all a `--output json` caller gets,
 * because that format implies --quiet and suppresses the per-destination lines.
 */
function isProblemDestination(d: PublishDestination): boolean {
  return d.status === "failed" || (d.error_msg ?? "") !== "";
}

function describeDestination(d: PublishDestination): string {
  return `${d.publisher ?? "(unnamed)"}: ${d.error_msg ?? d.status ?? "no reason given"}`;
}

function reportPublish(ctx: Ctx, data: unknown): void {
  // A 204 or a null body would otherwise be dereferenced into a TypeError,
  // which is the failure mode the `?? []` guards elsewhere exist to prevent.
  const body = (typeof data === "object" && data !== null ? data : {}) as PublishResponse;
  const dests = body.publish_destinations ?? [];
  const problems = dests.filter(isProblemDestination);

  if (!ctx.quiet) {
    for (const d of problems) log.error(`Destination ${describeDestination(d)}`);
  }

  // No destinations at all is not a failure: `mark_as_published` records
  // content as already live elsewhere without pushing it anywhere.
  if (dests.length > 0 && problems.length === dests.length) {
    throw new CliError(
      `Publish failed at every destination (${String(problems.length)} of ${String(dests.length)}): ${problems
        .map(describeDestination)
        .join("; ")}`,
      EXIT.ERROR,
      {
        hint: `The content was saved as version ${body.version_id ?? "(unknown)"} of content ${body.content_id ?? "(unknown)"} — retry the publish with that content_id rather than creating another item.`,
      },
    );
  }

  if (ctx.quiet) return;

  if (problems.length > 0) {
    log.warn(
      `${String(problems.length)} of ${String(dests.length)} destination(s) did not publish.`,
    );
    return;
  }

  // Every destination queued means the publish was accepted but nothing is live
  // yet, so claiming it published would be a lie a caller acts on.
  if (dests.length > 0 && dests.every((d) => d.status === "queued")) {
    log.info(
      `Publish queued at ${String(dests.length)} destination(s); they publish asynchronously.`,
    );
    return;
  }

  log.success("Content published.");
}

export function registerEngineCommands(program: Command): void {
  const engine = program
    .command("engine")
    .description(
      "Publish or draft content through the content engine. Used to push AI-generated content to external destinations (citeables by default) or save it as a draft for review.",
    );

  engine
    .command("publish")
    .description(
      "Publish content to external destinations via the content engine. Requires raw_markdown and seo_title; geo_question_id is optional. Pass content_id to publish a new version of an existing content item rather than creating another one — without it, the item is found by geo_question_id or created fresh. By default publishes to every destination currently selected for generation (citeables is the default for most orgs — see 'senso destinations list'). Pass --publisher-ids to restrict publishing to a specific subset, or include 'publisher_ids' inside --data. To record content as already published externally rather than pushing it to destinations, set mark_as_published (and optionally manual_published_at) in --data. A destination can fail while the call still succeeds: read publish_destinations, which this command reports on stderr. Exits 1 if every destination failed.",
    )
    .requiredOption(
      "--data <json>",
      'JSON: { "raw_markdown": "...", "seo_title": "...", "content_id": "uuid", "geo_question_id": "uuid", "summary": "...", "publisher_ids": ["<uuid>", ...], "mark_as_published": false, "manual_published_at": "2026-06-11T00:00:00Z", "manual_published_url": "https://...", "generation_run_id": "uuid", "generation_receipt_id": "uuid" }. Only raw_markdown and seo_title are required. content_id targets an existing content item.',
    )
    .option(
      "--publisher-ids <ids...>",
      "Restrict publishing to specific publisher IDs. Overrides any publisher_ids present in --data. Omit to publish to all configured destinations (citeables by default).",
    )
    .action(
      runAction(program, async (ctx, cmdOpts: { data: string; publisherIds?: string[] }) => {
        const body = parseJsonFlag(cmdOpts.data);
        if (cmdOpts.publisherIds && cmdOpts.publisherIds.length > 0) {
          body.publisher_ids = cmdOpts.publisherIds;
        }
        const data = await apiRequest({
          method: "POST",
          path: "/org/content-engine/publish",
          body,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        reportPublish(ctx, data);
        emit(ctx, data);
      }),
    );

  engine
    .command("draft")
    .description(
      "Save content as a draft for review before publishing. Requires raw_markdown and seo_title; geo_question_id is optional. Pass content_id to save a new version of an existing content item — that is how an edit loop revises one item instead of leaving a trail of new ones. Without it, the item is found by geo_question_id or created fresh. Drafts do not hit any destination until you run 'senso engine publish' on them.",
    )
    .requiredOption(
      "--data <json>",
      'JSON: { "raw_markdown": "...", "seo_title": "...", "content_id": "uuid", "geo_question_id": "uuid", "summary": "...", "generation_run_id": "uuid", "generation_receipt_id": "uuid" }. Only raw_markdown and seo_title are required. content_id targets an existing content item, so repeated drafts version it rather than creating a new one.',
    )
    .action(
      runAction(program, async (ctx, cmdOpts: { data: string }) => {
        const body = parseJsonFlag(cmdOpts.data);
        const data = await apiRequest({
          method: "POST",
          path: "/org/content-engine/draft",
          body,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        if (!ctx.quiet) log.success("Content saved as draft.");
        emit(ctx, data);
      }),
    );
}
