import { Command } from "commander";
import { apiRequest } from "../lib/api-client.js";
import { CliError, EXIT } from "../lib/errors.js";
import { parseJsonFlag } from "../lib/json-arg.js";
import { emit } from "../lib/output.js";
import { runAction } from "../lib/run-action.js";
import * as log from "../utils/logger.js";

export function registerOrgCommands(program: Command): void {
  const org = program
    .command("org")
    .description(
      "View and update organization profile and settings. Includes name, slug, logo, websites, locations, and tier information.",
    );

  org
    .command("get")
    .description(
      "Get full organization details including name, slug, tier, websites, locations, configured AI models, publishers, and schedule.",
    )
    .action(
      runAction(program, async (ctx) => {
        const data = await apiRequest({
          path: "/org/me",
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emit(ctx, data);
      }),
    );

  org
    .command("update")
    .description(
      "Update organization details. Only the fields you pass are changed; omitting a field leaves it alone. But 'websites' and 'locations' REPLACE their whole list when passed — sending one website deletes the rest. To add to either list, run 'org get' first and send back every entry you want to keep.",
    )
    .requiredOption(
      "--data <json>",
      'JSON: { "name": "Acme", "slug": "acme", "logo_url": "https://acme.com/logo.png", "websites": [{"url": "https://acme.com"}], "locations": [{"country_code": "US", "region_name": "California"}] }. Every field is optional. "websites" and "locations" REPLACE the existing list rather than adding to it — include every entry you want to keep, or pass [] to clear the list. A website entry takes only "url"; sending the "org_website_id" from \'org get\' is rejected. Send "logo_url": "" to clear the logo.',
    )
    .action(
      runAction(program, async (ctx, cmdOpts: { data: string }) => {
        const body = parseJsonFlag(cmdOpts.data);
        const data = await apiRequest({
          method: "PUT",
          path: "/org/me",
          body,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        if (!ctx.quiet) log.success("Organization updated.");
        emit(ctx, data);
      }),
    );

  org
    .command("set-industry <industryId>")
    .description(
      "Set the industry your organization belongs to, chosen from the public catalog (`senso industries list`). An organization that already has one can change it: the new choice replaces the old. Prompts already imported from the previous industry stay, and the run history copied onto them is kept — what changes is which industry's results the organization reads from then on. It is what `senso industries import-prompts` and `senso generate industry-draft` work from, and where an org with no models or locations of its own inherits them on activation. Nothing else happens — no prompts are created and no runs start.",
    )
    .action(
      runAction(program, async (ctx, industryId: string) => {
        const data = await apiRequest({
          method: "PUT",
          path: "/org/me/industry",
          body: { industry_id: industryId },
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        if (!ctx.quiet) log.success("Organization industry set.");
        emit(ctx, data);
      }),
    );

  org
    .command("set-runs")
    .description(
      "Toggle the org-wide runs master switch. Pause every scheduled prompt run and content-generation run, or re-enable them.",
    )
    .requiredOption("--enabled <bool>", "Set to true or false")
    .action(
      runAction(program, async (ctx, cmdOpts: { enabled: string }) => {
        const raw = cmdOpts.enabled.toLowerCase();
        if (raw !== "true" && raw !== "false") {
          throw new CliError("--enabled must be `true` or `false`.", EXIT.USAGE, {
            code: "usage",
            hint: "Pass --enabled true or --enabled false.",
          });
        }
        const enable = raw === "true";
        const data = await apiRequest({
          method: "PATCH",
          path: "/org/me/runs-enabled",
          body: { enable_runs: enable },
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        if (!ctx.quiet) log.success(`Org-wide runs ${enable ? "enabled" : "disabled"}.`);
        emit(ctx, data);
      }),
    );
}
