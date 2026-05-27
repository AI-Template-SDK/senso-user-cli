import { Command } from "commander";
import { apiRequest, formatApiError } from "../lib/api-client.js";
import * as log from "../utils/logger.js";

export function registerCompetitorsCommands(program: Command): void {
  const competitors = program
    .command("competitors")
    .description("Manage the curated list of competitor brands your organization tracks. Tracked competitors feed downstream share-of-voice analytics and inform content-generation prompts.");

  competitors
    .command("list")
    .description("List every tracked competitor for the current organization.")
    .action(async () => {
      const opts = program.opts();
      try {
        const data = await apiRequest({
          path: "/org/competitors",
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  competitors
    .command("add")
    .description("Add a single tracked competitor.")
    .requiredOption("--name <name>", "Competitor brand name")
    .option("--url <url>", "Competitor website URL")
    .action(async (cmdOpts: { name: string; url?: string }) => {
      const opts = program.opts();
      try {
        const body: Record<string, unknown> = { name: cmdOpts.name };
        if (cmdOpts.url) body.url = cmdOpts.url;
        const data = await apiRequest({
          method: "POST",
          path: "/org/competitors",
          body,
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        log.success(`Tracked competitor "${cmdOpts.name}" added.`);
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  competitors
    .command("batch-add")
    .description("Add up to 50 tracked competitors in one call. Designed for accepting AI-generated suggestions returned by `competitors suggest`.")
    .requiredOption("--data <json>", 'JSON: { "items": [{ "name": "...", "url": "...", "source": "manual|suggested_run_text|suggested_web_search", "rationale": "...", "confidence": 0.85 }, ...] }')
    .action(async (cmdOpts: { data: string }) => {
      const opts = program.opts();
      try {
        const body = JSON.parse(cmdOpts.data);
        const data = await apiRequest({
          method: "POST",
          path: "/org/competitors/batch",
          body,
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        log.success("Tracked competitors added.");
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(err instanceof SyntaxError ? "Invalid JSON in --data" : formatApiError(err));
        process.exit(1);
      }
    });

  competitors
    .command("suggest")
    .description("Get AI-generated competitor suggestions seeded from your org's website and recent prompt-run results. Pipe accepted suggestions into `competitors batch-add`.")
    .action(async () => {
      const opts = program.opts();
      try {
        const data = await apiRequest({
          method: "POST",
          path: "/org/competitors/suggest",
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  competitors
    .command("update <competitorId>")
    .description("Update a tracked competitor's name or URL.")
    .requiredOption("--name <name>", "Competitor brand name")
    .option("--url <url>", "Competitor website URL")
    .action(async (competitorId: string, cmdOpts: { name: string; url?: string }) => {
      const opts = program.opts();
      try {
        const body: Record<string, unknown> = { name: cmdOpts.name };
        if (cmdOpts.url) body.url = cmdOpts.url;
        const data = await apiRequest({
          method: "PUT",
          path: `/org/competitors/${competitorId}`,
          body,
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        log.success(`Tracked competitor ${competitorId} updated.`);
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  competitors
    .command("delete <competitorId>")
    .description("Remove a tracked competitor.")
    .action(async (competitorId: string) => {
      const opts = program.opts();
      try {
        await apiRequest({
          method: "DELETE",
          path: `/org/competitors/${competitorId}`,
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        log.success(`Tracked competitor ${competitorId} removed.`);
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });
}
