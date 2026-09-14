import { Command } from "commander";
import { apiRequest } from "../lib/api-client.js";
import { CliError, EXIT } from "../lib/errors.js";
import { parseJsonFlag } from "../lib/json-arg.js";
import { emit } from "../lib/output.js";
import { runAction } from "../lib/run-action.js";
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
    .description(
      "AI content generation. Configure settings, generate content samples from prompts, or trigger full content engine runs.",
    );

  gen
    .command("settings")
    .description(
      "Get content generation settings. Shows whether generation and auto-publish are enabled, the content schedule, and configured publishers.",
    )
    .action(
      runAction(program, async (ctx) => {
        const data = await apiRequest({
          path: "/org/content-generation",
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emit(ctx, data);
      }),
    );

  gen
    .command("update-settings")
    .description(
      "Update content generation settings. Control auto-publish, generation toggle, and schedule (days of week 0-6).",
    )
    .requiredOption(
      "--data <json>",
      'JSON settings: { "enable_content_generation": bool, "content_auto_publish": bool, "content_schedule": [0-6], "selected_content_type_id": "<uuid>" }',
    )
    .action(
      runAction(program, async (ctx, cmdOpts: { data: string }) => {
        const body = parseJsonFlag(cmdOpts.data);
        const data = await apiRequest({
          method: "PATCH",
          path: "/org/content-generation",
          body,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        if (!ctx.quiet) log.success("Content generation settings updated.");
        emit(ctx, data);
      }),
    );

  gen
    .command("sample")
    .description(
      "Generate an ad hoc content sample for a specific prompt and content type. Submits an async job, waits for completion by default, then returns the generated markdown, SEO title, and publish results. Use 'prompts list' to find a prompt ID, and 'content-types list' to find a content-type ID.",
    )
    .requiredOption("--prompt-id <id>", "Prompt (geo question) ID to generate content for")
    .requiredOption(
      "--content-type-id <id>",
      "Content type ID that defines the output format (use 'content-types list' to find)",
    )
    .option(
      "--destination <dest>",
      "Publisher slug to publish to immediately after generation. Omit to save as draft only.",
    )
    .option(
      "--no-wait",
      "Return the accepted sample job immediately instead of polling for the generated content.",
    )
    .action(
      runAction(
        program,
        async (
          ctx,
          cmdOpts: {
            promptId: string;
            contentTypeId: string;
            destination?: string;
            wait?: boolean;
          },
        ) => {
          const body: Record<string, unknown> = {
            geo_question_id: cmdOpts.promptId,
            content_type_id: cmdOpts.contentTypeId,
          };
          if (cmdOpts.destination) {
            body.publish_destination = cmdOpts.destination;
          }
          const data = await apiRequest<ContentGenerationSampleJobSubmitResponse>({
            method: "POST",
            path: "/org/content-generation/sample",
            body,
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
          });

          if (cmdOpts.wait === false) {
            emit(ctx, data);
            return;
          }

          if (!ctx.quiet) {
            log.info(`Sample job accepted: ${data.sample_job_id}`);
          }

          const job = await waitForSampleJob(data.sample_job_id, {
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
            quiet: ctx.quiet,
          });

          if (job.status === "completed") {
            emit(ctx, job.result ?? job);
            return;
          }

          // An empty message is as useless as a missing one, so both fall back
          // to the status line rather than reporting a blank failure.
          const reported = job.error?.message;
          const message =
            reported === undefined || reported === ""
              ? `Sample job ended with status: ${job.status}`
              : reported;
          // A job that ran and failed is a server-side outcome, not a bad
          // command line: exit 1, with the job's own code kept in the message.
          throw new CliError(
            job.error?.code ? `${message} (${job.error.code})` : message,
            EXIT.ERROR,
          );
        },
      ),
    );

  gen
    .command("run")
    .description(
      "Trigger a content generation run. Processes all prompts (or a specific subset) through the content engine. Runs asynchronously — use 'generate runs-list' to monitor progress.",
    )
    .option("--prompt-ids <ids...>", "Optional list of prompt IDs to process (omit to run all)")
    .option("--content-type-id <id>", "Override the org's default content type for this run")
    .option("--publisher-ids <ids...>", "Restrict publishing to specific publisher IDs")
    .action(
      runAction(
        program,
        async (
          ctx,
          cmdOpts: {
            promptIds?: string[];
            contentTypeId?: string;
            publisherIds?: string[];
          },
        ) => {
          const body: Record<string, unknown> = {};
          if (cmdOpts.promptIds) body.prompt_ids = cmdOpts.promptIds;
          if (cmdOpts.contentTypeId) body.content_type_id = cmdOpts.contentTypeId;
          if (cmdOpts.publisherIds) body.publisher_ids = cmdOpts.publisherIds;
          const data = await apiRequest({
            method: "POST",
            path: "/org/content-generation/run",
            body: Object.keys(body).length > 0 ? body : {},
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
          });
          if (!ctx.quiet) log.success("Content generation run triggered.");
          emit(ctx, data);
        },
      ),
    );

  gen
    .command("job-context")
    .description(
      "Get the full content generation job context — all prompts with queue status (create vs update), content state, and a summary of queue counts.",
    )
    .action(
      runAction(program, async (ctx) => {
        const data = await apiRequest({
          path: "/org/content-generation/job-context",
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emit(ctx, data);
      }),
    );

  gen
    .command("runs-list")
    .description(
      "List content generation runs for the org. Use --status to filter by run status, --active-only to show only in-progress runs.",
    )
    .option("--limit <n>", "Items per page", "20")
    .option("--offset <n>", "Pagination offset", "0")
    .option("--status <status>", "Filter by run status")
    .option("--active-only", "Only return active (in-progress) runs")
    .option("--start-date <date>", "Filter runs on or after this date (YYYY-MM-DD)")
    .option("--end-date <date>", "Filter runs on or before this date (YYYY-MM-DD)")
    .action(
      runAction(program, async (ctx, cmdOpts: Record<string, string | boolean>) => {
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
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emit(ctx, data);
      }),
    );

  gen
    .command("runs-get <runId>")
    .description("Get details for a specific content generation run.")
    .action(
      runAction(program, async (ctx, runId: string) => {
        const data = await apiRequest({
          path: `/org/content-generation/runs/${runId}`,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emit(ctx, data);
      }),
    );

  gen
    .command("runs-items <runId>")
    .description(
      "List individual prompt items within a content generation run and their per-item status.",
    )
    .option("--limit <n>", "Items per page", "100")
    .option("--offset <n>", "Pagination offset", "0")
    .option(
      "--status <status>",
      "Filter by item status: pending, running, succeeded, failed, skipped, stopped",
    )
    .action(
      runAction(program, async (ctx, runId: string, cmdOpts: Record<string, string>) => {
        const data = await apiRequest({
          path: `/org/content-generation/runs/${runId}/items`,
          params: { limit: cmdOpts.limit, offset: cmdOpts.offset, status: cmdOpts.status },
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emit(ctx, data);
      }),
    );

  gen
    .command("runs-logs <runId>")
    .description("List log entries for a content generation run.")
    .option("--limit <n>", "Items per page", "100")
    .option("--offset <n>", "Pagination offset", "0")
    .action(
      runAction(program, async (ctx, runId: string, cmdOpts: Record<string, string>) => {
        const data = await apiRequest({
          path: `/org/content-generation/runs/${runId}/logs`,
          params: { limit: cmdOpts.limit, offset: cmdOpts.offset },
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emit(ctx, data);
      }),
    );

  gen
    .command("industry-draft")
    .description(
      "Draft a complete document from one of your industry's prompts in a single call. The prompt is resolved against your organization's industry, grounded in your knowledge base, and written in the requested content type with your brand kit and product lines applied. The result is NOT stored as content — it comes back as GitHub Flavored Markdown with footnote citations for you to review or store separately. Typically takes 10-30 seconds and consumes credits like an ad-hoc generation. Requires the GEO product.",
    )
    .requiredOption(
      "--industry-prompt-id <id>",
      "An industry prompt id from `senso industries prompts` — NOT one of your own prompt ids",
    )
    .requiredOption(
      "--content-type-id <id>",
      "A content type id from `senso content-types list`, giving the document its format",
    )
    .option(
      "--product-line-ids <ids>",
      "Comma-separated product line ids (default: all, up to 100)",
    )
    .option("--audience <text>", "Who the document is for (max 500 chars)")
    .option("--style-tone <text>", "Voice and tone guidance (max 500 chars)")
    .option("--extra-instructions <text>", "Further instructions for the writer (max 4000 chars)")
    .action(
      runAction(
        program,
        async (
          ctx,
          cmdOpts: {
            industryPromptId: string;
            contentTypeId: string;
            productLineIds?: string;
            audience?: string;
            styleTone?: string;
            extraInstructions?: string;
          },
        ) => {
          const productLineIds = cmdOpts.productLineIds
            ?.split(",")
            .map((p) => p.trim())
            .filter((p) => p.length > 0);

          // Checked here because the call is slow and billable: a body the API
          // rejects for length should not cost 10-30 seconds to find out about.
          const tooLong = (
            [
              ["--audience", cmdOpts.audience, 500],
              ["--style-tone", cmdOpts.styleTone, 500],
              ["--extra-instructions", cmdOpts.extraInstructions, 4000],
            ] as const
          ).find(([, value, max]) => value !== undefined && value.length > max);
          if (tooLong) {
            throw new CliError(
              `Invalid ${tooLong[0]}: ${String(tooLong[1]?.length)} characters, the maximum is ${String(tooLong[2])}.`,
              EXIT.USAGE,
              { code: "usage" },
            );
          }
          if (productLineIds && productLineIds.length > 100) {
            throw new CliError(
              `Invalid --product-line-ids: ${String(productLineIds.length)} ids given, the maximum is 100.`,
              EXIT.USAGE,
              { code: "usage" },
            );
          }

          const body: Record<string, unknown> = {
            industry_prompt_id: cmdOpts.industryPromptId,
            selected_content_type_id: cmdOpts.contentTypeId,
          };
          if (productLineIds) body.selected_product_line_ids = productLineIds;
          if (cmdOpts.audience !== undefined) body.audience = cmdOpts.audience;
          if (cmdOpts.styleTone !== undefined) body.style_tone = cmdOpts.styleTone;
          if (cmdOpts.extraInstructions !== undefined) {
            body.extra_instructions = cmdOpts.extraInstructions;
          }

          if (!ctx.quiet) log.info("Generating — this usually takes 10-30 seconds.");
          const data = await apiRequest({
            method: "POST",
            path: "/org/content-generation/industry-prompt-draft",
            body,
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
          });
          emit(ctx, data);
        },
      ),
    );
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

  // NETWORK, not ERROR: the job may still be running server-side, so this is a
  // "we stopped waiting" outcome that a caller can reasonably retry or poll.
  throw new CliError(`Timed out waiting for sample job ${sampleJobId}.`, EXIT.NETWORK, {
    code: "timeout",
    hint: `Poll /org/content-generation/sample-jobs/${sampleJobId} for status.`,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
