import { Command } from "commander";
import { apiRequest, formatApiError } from "../lib/api-client.js";
import * as log from "../utils/logger.js";

interface ContentGenerationSampleJobSubmitResponse {
  message: string;
  sample_job_id: string;
  org_id: string;
  status: string;
}

interface ContentGenerationSampleJobResponse {
  sample_job_id: string;
  org_id: string;
  status: "queued" | "running" | "completed" | "failed" | "expired";
  result?: unknown;
  error?: {
    code?: string;
    message?: string;
  };
}

const SAMPLE_JOB_POLL_INTERVAL_MS = 2_000;
const SAMPLE_JOB_TIMEOUT_MS = 180_000;

export function registerGenerateCommands(program: Command): void {
  const gen = program
    .command("generate")
    .description("AI content generation. Configure settings, generate content samples from prompts, or trigger full content engine runs.");

  gen
    .command("settings")
    .description("Get content generation settings. Shows whether generation and auto-publish are enabled, the content schedule, and configured publishers.")
    .action(async () => {
      const opts = program.opts();
      try {
        const data = await apiRequest({ path: "/org/content-generation", apiKey: opts.apiKey, baseUrl: opts.baseUrl });
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  gen
    .command("update-settings")
    .description("Update content generation settings. Control auto-publish, generation toggle, and schedule (days of week 0-6).")
    .requiredOption("--data <json>", 'JSON settings: { "enable_content_generation": bool, "content_auto_publish": bool, "content_schedule": [0-6], "selected_content_type_id": "<uuid>" }')
    .action(async (cmdOpts: { data: string }) => {
      const opts = program.opts();
      try {
        const body = JSON.parse(cmdOpts.data);
        const data = await apiRequest({ method: "PATCH", path: "/org/content-generation", body, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
        log.success("Content generation settings updated.");
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(err instanceof SyntaxError ? "Invalid JSON in --data" : formatApiError(err));
        process.exit(1);
      }
    });

  gen
    .command("sample")
    .description("Generate an ad hoc content sample for a specific prompt and content type. Submits an async job, waits for completion by default, then returns the generated markdown, SEO title, and publish results. Use 'prompts list' to find a prompt ID, and 'content-types list' to find a content-type ID.")
    .requiredOption("--prompt-id <id>", "Prompt (geo question) ID to generate content for")
    .requiredOption("--content-type-id <id>", "Content type ID that defines the output format (use 'content-types list' to find)")
    .option("--destination <dest>", "Publisher slug to publish to immediately after generation. Omit to save as draft only.")
    .option("--no-wait", "Return the accepted sample job immediately instead of polling for the generated content.")
    .action(async (cmdOpts: { promptId: string; contentTypeId: string; destination?: string; wait?: boolean }) => {
      const opts = program.opts();
      try {
        const body: Record<string, unknown> = {
          geo_question_id: cmdOpts.promptId,
          content_type_id: cmdOpts.contentTypeId,
        };
        if (cmdOpts.destination) {
          body.publish_destination = cmdOpts.destination;
        }
        const data = await apiRequest({
          method: "POST",
          path: "/org/content-generation/sample",
          body,
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        }) as ContentGenerationSampleJobSubmitResponse;

        if (cmdOpts.wait === false) {
          console.log(JSON.stringify(data, null, 2));
          return;
        }

        const quiet = opts.quiet || opts.output === "json";
        if (!quiet) {
          log.info(`Sample job accepted: ${data.sample_job_id}`);
        }

        const job = await waitForSampleJob(data.sample_job_id, {
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
          quiet,
        });

        if (job.status === "completed") {
          console.log(JSON.stringify(job.result ?? job, null, 2));
          return;
        }

        const message = job.error?.message || `Sample job ended with status: ${job.status}`;
        throw new Error(job.error?.code ? `${message} (${job.error.code})` : message);
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  gen
    .command("run")
    .description("Trigger a content generation run. Processes all prompts (or a specific subset) through the content engine. Runs asynchronously — use 'generate runs-list' to monitor progress.")
    .option("--prompt-ids <ids...>", "Optional list of prompt IDs to process (omit to run all)")
    .option("--content-type-id <id>", "Override the org's default content type for this run")
    .option("--publisher-ids <ids...>", "Restrict publishing to specific publisher IDs")
    .action(async (cmdOpts: { promptIds?: string[]; contentTypeId?: string; publisherIds?: string[] }) => {
      const opts = program.opts();
      try {
        const body: Record<string, unknown> = {};
        if (cmdOpts.promptIds) body.prompt_ids = cmdOpts.promptIds;
        if (cmdOpts.contentTypeId) body.content_type_id = cmdOpts.contentTypeId;
        if (cmdOpts.publisherIds) body.publisher_ids = cmdOpts.publisherIds;
        const data = await apiRequest({ method: "POST", path: "/org/content-generation/run", body: Object.keys(body).length > 0 ? body : {}, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
        log.success("Content generation run triggered.");
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  gen
    .command("job-context")
    .description("Get the full content generation job context — all prompts with queue status (create vs update), content state, and a summary of queue counts.")
    .action(async () => {
      const opts = program.opts();
      try {
        const data = await apiRequest({ path: "/org/content-generation/job-context", apiKey: opts.apiKey, baseUrl: opts.baseUrl });
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  gen
    .command("runs-list")
    .description("List content generation runs for the org. Use --status to filter by run status, --active-only to show only in-progress runs.")
    .option("--limit <n>", "Items per page", "20")
    .option("--offset <n>", "Pagination offset", "0")
    .option("--status <status>", "Filter by run status")
    .option("--active-only", "Only return active (in-progress) runs")
    .option("--start-date <date>", "Filter runs on or after this date (YYYY-MM-DD)")
    .option("--end-date <date>", "Filter runs on or before this date (YYYY-MM-DD)")
    .action(async (cmdOpts: Record<string, string | boolean>) => {
      const opts = program.opts();
      try {
        const data = await apiRequest({
          path: "/org/content-generation/runs",
          params: {
            limit: cmdOpts.limit as string,
            offset: cmdOpts.offset as string,
            status: cmdOpts.status as string | undefined,
            active_only: cmdOpts.activeOnly ? "true" : undefined,
            start_date: cmdOpts.startDate as string | undefined,
            end_date: cmdOpts.endDate as string | undefined,
          },
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  gen
    .command("runs-get <runId>")
    .description("Get details for a specific content generation run.")
    .action(async (runId: string) => {
      const opts = program.opts();
      try {
        const data = await apiRequest({ path: `/org/content-generation/runs/${runId}`, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  gen
    .command("runs-items <runId>")
    .description("List individual prompt items within a content generation run and their per-item status.")
    .option("--limit <n>", "Items per page", "100")
    .option("--offset <n>", "Pagination offset", "0")
    .action(async (runId: string, cmdOpts: Record<string, string>) => {
      const opts = program.opts();
      try {
        const data = await apiRequest({
          path: `/org/content-generation/runs/${runId}/items`,
          params: { limit: cmdOpts.limit, offset: cmdOpts.offset },
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  gen
    .command("runs-logs <runId>")
    .description("List log entries for a content generation run.")
    .option("--limit <n>", "Items per page", "100")
    .option("--offset <n>", "Pagination offset", "0")
    .action(async (runId: string, cmdOpts: Record<string, string>) => {
      const opts = program.opts();
      try {
        const data = await apiRequest({
          path: `/org/content-generation/runs/${runId}/logs`,
          params: { limit: cmdOpts.limit, offset: cmdOpts.offset },
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });
}

async function waitForSampleJob(
  sampleJobId: string,
  opts: { apiKey?: string; baseUrl?: string; quiet?: boolean },
): Promise<ContentGenerationSampleJobResponse> {
  const deadline = Date.now() + SAMPLE_JOB_TIMEOUT_MS;
  let lastStatus = "";

  while (Date.now() < deadline) {
    const job = await apiRequest<ContentGenerationSampleJobResponse>({
      path: `/org/content-generation/sample-jobs/${sampleJobId}`,
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl,
    });

    if (!opts.quiet && job.status !== lastStatus) {
      log.info(`Sample job status: ${job.status}`);
      lastStatus = job.status;
    }

    if (job.status === "completed" || job.status === "failed" || job.status === "expired") {
      return job;
    }

    await sleep(SAMPLE_JOB_POLL_INTERVAL_MS);
  }

  throw new Error(`Timed out waiting for sample job ${sampleJobId}. Poll /org/content-generation/sample-jobs/${sampleJobId} for status.`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
