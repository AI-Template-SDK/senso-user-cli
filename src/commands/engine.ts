import { Command } from "commander";
import { apiRequest } from "../lib/api-client.js";
import { parseJsonFlag } from "../lib/json-arg.js";
import { emit } from "../lib/output.js";
import { runAction } from "../lib/run-action.js";
import * as log from "../utils/logger.js";

export function registerEngineCommands(program: Command): void {
  const engine = program
    .command("engine")
    .description(
      "Publish or draft content through the content engine. Used to push AI-generated content to external destinations (citeables by default) or save it as a draft for review.",
    );

  engine
    .command("publish")
    .description(
      "Publish content to external destinations via the content engine. Requires geo_question_id, raw_markdown, and seo_title. By default publishes to every destination currently selected for generation (citeables is the default for most orgs — see 'senso destinations list'). Pass --publisher-ids to restrict publishing to a specific subset, or include 'publisher_ids' inside --data. To record content as already published externally rather than pushing it to destinations, set mark_as_published (and optionally manual_published_at) in --data.",
    )
    .requiredOption(
      "--data <json>",
      'JSON: { "geo_question_id": "uuid", "raw_markdown": "...", "seo_title": "...", "summary": "...", "publisher_ids": ["<uuid>", ...], "mark_as_published": false, "manual_published_at": "2026-06-11T00:00:00Z" }',
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
        if (!ctx.quiet) log.success("Content published.");
        emit(ctx, data);
      }),
    );

  engine
    .command("draft")
    .description(
      "Save content as a draft for review before publishing. Requires geo_question_id, raw_markdown, and seo_title. Drafts do not hit any destination until you run 'senso engine publish' on them.",
    )
    .requiredOption(
      "--data <json>",
      'JSON: { "geo_question_id": "uuid", "raw_markdown": "...", "seo_title": "...", "summary": "..." }',
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
