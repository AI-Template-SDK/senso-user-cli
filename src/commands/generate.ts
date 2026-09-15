import { Command } from "commander";
import { apiRequest } from "../lib/api-client.js";
import { parseDateFlag, parseEnumFlag, parseInstantFlag, parseIntFlag } from "../lib/enum-arg.js";
import { CliError, EXIT, usageError, type ErrorCode } from "../lib/errors.js";
import { apiExits, describeCommand, idExits } from "../lib/help.js";
import { isUuid, parseId, parseIdList, type IdSpec } from "../lib/id-arg.js";
import { parseJsonFlag } from "../lib/json-arg.js";
import { emit, type NextStep } from "../lib/output.js";
import type { ResourceRef } from "../lib/resource.js";
import { runAction } from "../lib/run-action.js";
import * as log from "../utils/logger.js";

interface ContentGenerationSampleJobSubmitResponse {
  message: string;
  sample_job_id: string;
  org_id: string;
  status: string;
}

/** The generated draft a completed sample job carries. */
interface ContentGenerationSampleResult {
  content_id?: string;
  version_id?: string;
  seo_title?: string;
}

interface ContentGenerationSampleJobResponse {
  sample_job_id: string;
  org_id: string;
  status: "queued" | "running" | "completed" | "failed" | "expired";
  result?: ContentGenerationSampleResult;
  error?: {
    code?: string;
    message?: string;
  };
}

interface ContentGenerationSettingsResponse {
  enable_content_generation?: boolean;
  selected_content_type_id?: string | null;
  publishers?: Record<string, unknown>[];
}

interface ContentGenerationRunResponse {
  run_id?: string;
}

interface RunDetailResponse {
  run?: Record<string, unknown>;
}

interface RunItemsResponse {
  items?: { status?: string; content_id?: string }[];
}

interface RunsListResponse {
  runs?: { run_id?: string; active?: boolean }[];
}

interface IndustryDraftResponse {
  notes?: string[];
}

const SAMPLE_JOB_POLL_INTERVAL_MS = 2_000;
const SAMPLE_JOB_TIMEOUT_MS = 180_000;

/** `industry-draft` generates inline and bills for it; see the call site. */
const DRAFT_TIMEOUT_MS = 120_000;

/**
 * The run status enum, from pkg/models/content_generation_run.go.
 *
 * Listed here rather than left as free text because an unknown `--status` was
 * stored into the API's filter without being checked: `--status complete`
 * returned an empty list and exit 0, which an agent reads as "there are no
 * runs" rather than "you misspelled completed".
 */
const RUN_STATUSES = [
  "queued",
  "running",
  "completed",
  "partial_failed",
  "failed",
  "dispatch_failed",
  "blocked",
  "skipped",
  "stopped",
] as const;

/** The per-item statuses of a run, from the same model file. */
const RUN_ITEM_STATUSES = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "skipped",
  "stopped",
] as const;

/** The two statuses that are not terminal: everything else has finished. */
const RUN_STATUS_LINE =
  "queued (accepted, not started) | running | completed (every item succeeded) | partial_failed (some items failed) | failed (no item succeeded) | dispatch_failed (the engine never started it) | blocked (refused before starting: generation disabled, or credits) | skipped (nothing to do) | stopped (stopped by an admin). Terminal: everything but queued and running.";

const ITEM_STATUS_LINE =
  "pending | running | succeeded (content_id and version_id are set) | failed (see failed_at_step and operator_message) | skipped | stopped";

/** The keys PATCH /org/content-generation accepts. Anything else is ignored by the API. */
const SETTINGS_KEYS = [
  "enable_content_generation",
  "content_auto_publish",
  "content_schedule",
  "selected_content_type_id",
] as const;

const PROMPT_ID: IdSpec = {
  label: "--prompt-id",
  type: "Prompt",
  idField: "geo_question_id",
  list: "senso prompts list",
};

const PROMPT_IDS: IdSpec = { ...PROMPT_ID, label: "--prompt-ids" };

const CONTENT_TYPE_ID: IdSpec = {
  label: "--content-type-id",
  type: "Content type",
  idField: "content_type_id",
  list: "senso content-types list",
};

const PUBLISHER_IDS: IdSpec = {
  label: "--publisher-ids",
  type: "Destination",
  idField: "publisher_id",
  list: "senso destinations list",
};

const PRODUCT_LINE_IDS: IdSpec = {
  label: "--product-line-ids",
  type: "Product line",
  idField: "product_line_id",
  list: "senso product-lines list",
};

const INDUSTRY_PROMPT_ID: IdSpec = {
  label: "--industry-prompt-id",
  type: "Industry prompt",
  idField: "industry_prompt_id",
  list: "senso industries prompts <industry>",
};

const RUN_ID: IdSpec = {
  label: "<runId>",
  type: "Run",
  idField: "run_id",
  list: "senso generate runs-list",
};

const SAMPLE_JOB_ID: IdSpec = {
  label: "<sampleJobId>",
  type: "Sample job",
  idField: "sample_job_id",
  list: "senso generate sample --no-wait",
};

/** The organization's own content-generation record, for a 404 on the singleton routes. */
const SETTINGS_RESOURCE: ResourceRef = {
  type: "Content generation settings",
  list: "senso org get",
};

function runResource(runId: string): ResourceRef {
  return { type: "Run", id: runId, idField: "run_id", list: "senso generate runs-list" };
}

/**
 * What a failed sample job means, and the one command that fixes it.
 *
 * The job's own `error.code` is the only machine-readable thing the CLI gets
 * back — the HTTP status is 200 — so it is what the hint is chosen by.
 */
const SAMPLE_JOB_HINTS: Record<string, string> = {
  prompt_not_found: "List this organization's prompts with `senso prompts list`.",
  prompt_org_mismatch:
    "The prompt belongs to another organization. List yours with `senso prompts list`.",
  content_type_not_found: "List content types with `senso content-types list`.",
  invalid_publish_destination:
    "--destination takes a slug from `senso destinations list` (e.g. citeables), not a publisher_id.",
  content_generation_disabled:
    "Enable it with `senso generate update-settings --data '{\"enable_content_generation\":true}'`.",
  publisher_assignment_required:
    "Select a destination first: `senso destinations list`, then `senso generate update-settings`.",
  insufficient_credits: "Check the balance with `senso credits balance`.",
};

export function registerGenerateCommands(program: Command): void {
  const gen = program
    .command("generate")
    .description(
      "Content generation: read and change the engine's settings, generate one piece of content for a prompt, or start a full run and follow it. Requires the GEO product; `sample`, `run` and `industry-draft` consume credits.",
    );

  describeCommand(gen, {
    notes: [
      "Id spaces used here:",
      "  prompt id          geo_question_id, from `senso prompts list`",
      "  content_type_id    from `senso content-types list`",
      "  publisher_id       from `senso destinations list` (its slug is what `sample --destination` takes)",
      "  run_id             returned by `generate run`, listed by `generate runs-list`",
      "  sample_job_id      returned by `generate sample --no-wait`",
      "  industry_prompt_id from `senso industries prompts` — NOT a prompt id",
      "",
      "Typical workflow:",
      "  1. senso generate settings      confirm generation is enabled and a content type is selected",
      "  2. senso generate job-context   see which prompts would be created and which updated",
      "  3. senso generate sample --prompt-id … --content-type-id …   one prompt, waits, returns the draft",
      "     or senso generate run        every prompt, returns a run_id immediately",
      "  4. senso generate runs-get <run_id>     poll until the status is terminal",
      "  5. senso generate runs-items <run_id>   the per-prompt outcome and the content_id each produced",
    ],
    seeAlso: [
      "senso prompts list",
      "senso content-types list",
      "senso destinations list",
      "senso generated-content list",
    ],
  });

  describeCommand(
    gen
      .command("settings")
      .description(
        "Show the organization's content generation settings: whether generation and auto-publish are on, the days scheduled runs happen, the default content type, and the destinations selected for generation.",
      )
      .action(
        runAction(program, async (ctx) => {
          const data = await apiRequest<ContentGenerationSettingsResponse>({
            path: "/org/content-generation",
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
            resource: SETTINGS_RESOURCE,
          });

          // The two settings that make every other generate command fail, so
          // they are worth naming as the next step rather than leaving an agent
          // to discover them through a 502 from the engine.
          const next: NextStep[] = [];
          if (data.enable_content_generation === false) {
            next.push({
              why: "Generation is off, so `generate run` and scheduled runs are refused",
              command:
                "senso generate update-settings --data '{\"enable_content_generation\":true}'",
            });
          }
          if (
            data.selected_content_type_id === undefined ||
            data.selected_content_type_id === null
          ) {
            next.push({
              why: "No content type is selected, so a run has no format to write in",
              command: "senso content-types list",
            });
          }
          if (next.length === 0) {
            next.push({
              why: "Generate one piece of content for a prompt",
              command: `senso generate sample --prompt-id <geo_question_id> --content-type-id ${String(data.selected_content_type_id)}`,
            });
          }
          emit(ctx, data, { next });
        }),
      ),
    {
      returns: [
        "enable_content_generation — false means scheduled runs and `generate run` are refused",
        "content_auto_publish — true publishes generated content without review",
        "content_schedule — days a scheduled run happens: 0 = Sunday … 6 = Saturday",
        "selected_content_type_id — the content type a run uses unless --content-type-id overrides it; absent when none is set",
        "publishers[] — the destinations selected for generation (not every destination: see `senso destinations list`). publisher_id is what `generate run --publisher-ids` takes; slug is what `generate sample --destination` takes",
      ],
      exitCodes: {
        ...apiExits,
        3: "the organization does not have the GEO product, or the key lacks read:content",
        4: "the organization in this key's context no longer exists",
      },
      examples: [
        { command: "senso generate settings" },
        {
          comment: "The content type a run would use",
          command: "senso generate settings --output json | jq -r .data.selected_content_type_id",
        },
      ],
      seeAlso: [
        "senso generate update-settings",
        "senso destinations list",
        "senso content-types list",
      ],
    },
  );

  describeCommand(
    gen
      .command("update-settings")
      .description(
        'Change the organization\'s content generation settings. PATCH semantics: a key you omit is left unchanged, and "selected_content_type_id": null clears the selection. Returns the full settings object.',
      )
      .requiredOption(
        "--data <json>",
        "JSON with any of: enable_content_generation (bool), content_auto_publish (bool), content_schedule (array of 0-6, 0 = Sunday), selected_content_type_id (uuid or null)",
      )
      .action(
        runAction(program, async (ctx, cmdOpts: { data: string }) => {
          const body = parseJsonFlag(cmdOpts.data, {
            anyOf: SETTINGS_KEYS,
            rejectEmpty:
              "Name at least one setting to change; an empty object would change nothing.",
          });
          validateSettingsBody(body);

          const data = await apiRequest<ContentGenerationSettingsResponse>({
            method: "PATCH",
            path: "/org/content-generation",
            body,
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
            resource: SETTINGS_RESOURCE,
          });

          // Enabling generation with nothing to publish to produces a run that
          // fails at the engine rather than at this request, so say it here.
          const warnings =
            data.enable_content_generation === true && (data.publishers ?? []).length === 0
              ? [
                  "Generation is enabled but no destination is selected, so a run has nowhere to publish. See `senso destinations list`.",
                ]
              : [];

          if (!ctx.quiet) log.success("Updated content generation settings.");
          emit(ctx, data, {
            warnings,
            next: [{ why: "Start a run with the new settings", command: "senso generate run" }],
          });
        }),
      ),
    {
      returns: [
        "The updated settings, in the shape `senso generate settings` returns.",
        "content_schedule — days a scheduled run happens: 0 = Sunday … 6 = Saturday",
      ],
      exitCodes: {
        ...apiExits,
        2: "--data is not valid JSON, has an unknown key, a wrong type, or a schedule day outside 0-6",
        3: "no GEO product, or the key lacks update:content",
        1: "selected_content_type_id is not one of this organization's content types (400), or auto-publish was enabled with no destination selected (422)",
        4: "the organization in this key's context no longer exists",
      },
      examples: [
        {
          command: "senso generate update-settings --data '{\"enable_content_generation\": true}'",
        },
        {
          comment: "Run on Monday, Wednesday and Friday, in one content type",
          command:
            'senso generate update-settings --data \'{"content_schedule": [1,3,5], "selected_content_type_id": "0b7d2c44-9f1e-4a6b-8c3d-5e2f1a0b9c8d"}\'',
        },
        {
          comment: "Clear the default content type",
          command: "senso generate update-settings --data '{\"selected_content_type_id\": null}'",
        },
      ],
      seeAlso: ["senso generate settings", "senso content-types list", "senso destinations list"],
    },
  );

  describeCommand(
    gen
      .command("sample")
      .description(
        "Generate one piece of content for a prompt and wait for it. Submits an async job, polls every 2 s for up to 180 s, and returns the generated draft. The draft IS saved (it comes back with a content_id); with --destination it is also published immediately. Consumes credits.",
      )
      .requiredOption(
        "--prompt-id <uuid>",
        "The prompt to write for: a geo_question_id from `senso prompts list`",
      )
      .requiredOption(
        "--content-type-id <uuid>",
        "The format to write in: a content_type_id from `senso content-types list`",
      )
      .option(
        "--destination <slug>",
        "Publish right after generating. A destination SLUG from `senso destinations list` (citeables, codeables, cucopilot or a custom one) — not a publisher_id. Omit to keep a draft.",
      )
      .option(
        "--no-wait",
        "Return the accepted job immediately. Poll it with `senso generate sample-status <sample_job_id>`.",
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
              geo_question_id: parseId(cmdOpts.promptId, PROMPT_ID),
              content_type_id: parseId(cmdOpts.contentTypeId, CONTENT_TYPE_ID),
            };
            if (cmdOpts.destination !== undefined) {
              body.publish_destination = parseDestination(cmdOpts.destination);
            }

            const data = await apiRequest<ContentGenerationSampleJobSubmitResponse>({
              method: "POST",
              path: "/org/content-generation/sample",
              body,
              apiKey: ctx.apiKey,
              baseUrl: ctx.baseUrl,
            });

            if (cmdOpts.wait === false) {
              // The job id is worthless without the command that reads it, and
              // under --output json stderr is silent: the poll command has to
              // travel in the envelope.
              emit(ctx, data, {
                next: [
                  {
                    why: "Poll until the job is completed or failed",
                    command: `senso generate sample-status ${data.sample_job_id}`,
                  },
                ],
              });
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
              emit(ctx, job.result ?? job, { next: sampleNextSteps(job.result) });
              return;
            }

            throw sampleJobFailure(job);
          },
        ),
      ),
    {
      returns: [
        "content_id, version_id, version_num — the saved draft; read it with `senso generated-content get <content_id>`",
        "raw_markdown, seo_title, url_slug, meta_data, json_ld — the generated document",
        "editorial_status — draft | review | published | rejected",
        "publish_status and publish_results[] — per-destination outcome when --destination was given",
        `Job statuses while waiting: queued | running | completed | failed (expired is reserved and never set today).`,
        "A failed job exits 1 with error.code one of: prompt_not_found, prompt_org_mismatch, content_type_not_found, invalid_publish_destination, content_generation_disabled, publisher_assignment_required, insufficient_credits, content_generation_unavailable, metadata_generation_unavailable, content_generation_failed.",
      ],
      exitCodes: {
        ...idExits,
        2: "--prompt-id or --content-type-id is not a UUID, or --destination is empty or over 64 characters",
        3: "no GEO product, or the key lacks update:content",
        4: "the sample job vanished while it was being polled",
        1: "the job ran and failed (see error.code above)",
        5: "still running after 180 s — the job continues server-side; poll it with `generate sample-status`",
      },
      notes: [
        "Billable: this is priced as an ad-hoc generation, and a failed job can still report insufficient_credits.",
      ],
      examples: [
        {
          command:
            "senso generate sample --prompt-id 7c9e6679-7425-40de-944b-e07fc1f90ae7 --content-type-id 0b7d2c44-9f1e-4a6b-8c3d-5e2f1a0b9c8d",
        },
        {
          comment: "Generate and publish, keeping only the new content id",
          command:
            "senso generate sample --prompt-id <uuid> --content-type-id <uuid> --destination citeables --output json | jq -r .data.content_id",
        },
      ],
      seeAlso: [
        "senso generate sample-status",
        "senso generate run",
        "senso generated-content get",
        "senso destinations list",
      ],
    },
  );

  describeCommand(
    gen
      .command("sample-status <sampleJobId>")
      .description(
        "Read one sample generation job: its status, and its result once it has completed. This is what `generate sample --no-wait` hands back an id for.",
      )
      .action(
        runAction(program, async (ctx, sampleJobId: string) => {
          const id = parseId(sampleJobId, SAMPLE_JOB_ID);
          const job = await apiRequest<ContentGenerationSampleJobResponse>({
            path: `/org/content-generation/sample-jobs/${id}`,
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
            resource: { type: "Sample job", id, idField: "sample_job_id" },
          });

          if (job.status === "failed" || job.status === "expired") {
            throw sampleJobFailure(job);
          }

          const next: NextStep[] =
            job.status === "completed"
              ? sampleNextSteps(job.result)
              : [
                  {
                    why: "The job is not finished; poll it again",
                    command: `senso generate sample-status ${id}`,
                  },
                ];
          emit(ctx, job, { next });
        }),
      ),
    {
      returns: [
        "status — queued | running | completed | failed (expired is reserved and never set today)",
        "result — present once the status is completed: content_id, version_id, raw_markdown, seo_title, url_slug, editorial_status, publish_results[]",
        "started_at, completed_at — when the job began and ended",
      ],
      exitCodes: {
        ...idExits,
        2: "sampleJobId is not a UUID",
        3: "no GEO product, or the key lacks read:content",
        4: "no sample job with this id in this organization (jobs are visible only to the organization that submitted them)",
        1: "the job ran and failed; error.code says why",
      },
      examples: [
        { command: "senso generate sample-status 3d2f8a1c-6e4b-4c9a-8f0e-1a2b3c4d5e6f" },
        {
          comment: "Poll until it stops being queued or running",
          command:
            "senso generate sample-status 3d2f8a1c-6e4b-4c9a-8f0e-1a2b3c4d5e6f --output json | jq -r .data.status",
        },
      ],
      seeAlso: ["senso generate sample", "senso generated-content get"],
    },
  );

  describeCommand(
    gen
      .command("run")
      .description(
        "Start a content generation run over every prompt, or the ones named. Returns immediately with a run_id; the run continues server-side. Consumes credits per prompt generated, and only one run can be active per organization.",
      )
      .option(
        "--prompt-ids <ids...>",
        "Prompts to process: geo_question_id values from `senso prompts list`. Omit to process every prompt in the job context.",
      )
      .option(
        "--content-type-id <uuid>",
        "Override the settings' selected_content_type_id for this run (from `senso content-types list`)",
      )
      .option(
        "--publisher-ids <ids...>",
        "Publish only to these destinations: publisher_id values (not slugs) from `senso destinations list`. Omit to use every destination selected for generation.",
      )
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
            if (cmdOpts.promptIds) body.prompt_ids = parseIdList(cmdOpts.promptIds, PROMPT_IDS);
            if (cmdOpts.contentTypeId) {
              body.content_type_id = parseId(cmdOpts.contentTypeId, CONTENT_TYPE_ID);
            }
            if (cmdOpts.publisherIds) {
              body.publisher_ids = parseIdList(cmdOpts.publisherIds, PUBLISHER_IDS);
            }

            const data = await apiRequest<ContentGenerationRunResponse>({
              method: "POST",
              path: "/org/content-generation/run",
              body,
              apiKey: ctx.apiKey,
              baseUrl: ctx.baseUrl,
            });

            const runId = data.run_id ?? "<run_id>";
            if (!ctx.quiet) log.success(`Run ${runId} accepted.`);
            emit(ctx, data, {
              next: [
                {
                  why: "Poll until the status is terminal (completed, partial_failed, failed, dispatch_failed, blocked, skipped, stopped)",
                  command: `senso generate runs-get ${runId}`,
                },
                {
                  why: "See each prompt's outcome and the content_id it produced",
                  command: `senso generate runs-items ${runId}`,
                },
              ],
            });
          },
        ),
      ),
    {
      returns: [
        `run_id — poll it with \`senso generate runs-get <run_id>\`; status ends at one of ${RUN_STATUSES.join(", ")}`,
        "prompt_ids — echoed back when --prompt-ids was given",
        "org_id, message — the accepted request",
      ],
      exitCodes: {
        ...apiExits,
        2: "an id in --prompt-ids, --publisher-ids or --content-type-id is not a UUID",
        3: "no GEO product, or the key lacks update:content",
        1: "an id is not this organization's (400, the message lists them); a run is already active (409); the content engine refused (502)",
      },
      notes: [
        "Billable, and it needs enable_content_generation: true — check `senso generate settings` first.",
        "With no --publisher-ids, and auto-publish on, the run publishes to every destination selected for generation.",
      ],
      examples: [
        { command: "senso generate run" },
        {
          comment: "One prompt, keeping the run id",
          command:
            "senso generate run --prompt-ids 7c9e6679-7425-40de-944b-e07fc1f90ae7 --output json | jq -r .data.run_id",
        },
      ],
      seeAlso: [
        "senso generate runs-get",
        "senso generate runs-items",
        "senso generate job-context",
        "senso generate settings",
      ],
    },
  );

  describeCommand(
    gen
      .command("job-context")
      .description(
        "Show what a full run would do: every prompt with whether it would create new content or update existing content, plus the counts. This is the set `senso generate run` processes when --prompt-ids is omitted.",
      )
      .action(
        runAction(program, async (ctx) => {
          const data = await apiRequest({
            path: "/org/content-generation/job-context",
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
            resource: SETTINGS_RESOURCE,
          });
          emit(ctx, data, {
            columns: [
              "geo_question_id",
              "queue_type",
              "question_text",
              "editorial_status",
              "content_id",
            ],
            empty: "prompts",
            emptyHint:
              "This organization has no prompts yet. Create one with `senso prompts create`.",
            next: [{ why: "Process these prompts", command: "senso generate run" }],
          });
        }),
      ),
    {
      returns: [
        "summary.total_prompts, summary.create_queue_count, summary.update_queue_count",
        "prompts[].geo_question_id — the prompt id `generate run --prompt-ids` and `generate sample --prompt-id` take",
        "prompts[].queue_type — create (no content exists yet) | update (content exists and would be revised)",
        "prompts[].content_id, latest_version_id, editorial_status — set for update-queue prompts, null otherwise",
        "prompts[].ever_published — true when any version was published to any destination",
        "prompts[].citeables_action — a legacy informational field; ignore it",
        "content_auto_publish, selected_content_type_id — the settings the run would use",
      ],
      exitCodes: {
        ...apiExits,
        3: "no GEO product, or the key lacks read:content",
        4: "the organization in this key's context no longer exists",
      },
      examples: [
        { command: "senso generate job-context" },
        {
          comment: "Just the prompts that would produce new content",
          command:
            "senso generate job-context --output json | jq -r '.data.prompts[] | select(.queue_type==\"create\") | .geo_question_id'",
        },
      ],
      seeAlso: ["senso generate run", "senso generate sample", "senso prompts list"],
    },
  );

  describeCommand(
    gen
      .command("runs-list")
      .description(
        "List the organization's content generation runs, newest first. Each run is one execution of `generate run` or of the schedule, with counts of its per-prompt items.",
      )
      .option("--limit <n>", "Runs per page, at least 1", "20")
      .option("--offset <n>", "Runs to skip", "0")
      .option(`--status <status>`, `Only runs in this status: ${RUN_STATUSES.join(", ")}`)
      .option("--active-only", "Only queued and running runs (the API's `active` flag)")
      .option("--start-date <date>", "Runs created on or after this date (YYYY-MM-DD or RFC 3339)")
      .option("--end-date <date>", "Runs created on or before this date (YYYY-MM-DD or RFC 3339)")
      .action(
        runAction(program, async (ctx, cmdOpts: Record<string, string | boolean>) => {
          const status = parseEnumFlag(
            "--status",
            cmdOpts.status as string | undefined,
            RUN_STATUSES,
          );
          const limit = parseIntFlag("--limit", cmdOpts.limit as string, { min: 1 });
          const offset = parseIntFlag("--offset", cmdOpts.offset as string, { min: 0 });
          const startDate = parseRunDate("--start-date", cmdOpts.startDate as string | undefined);
          const endDate = parseRunDate("--end-date", cmdOpts.endDate as string | undefined);

          const data = await apiRequest<RunsListResponse>({
            path: "/org/content-generation/runs",
            params: {
              limit,
              offset,
              status,
              active_only: cmdOpts.activeOnly ? "true" : undefined,
              start_date: startDate,
              end_date: endDate,
            },
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
          });

          const first = (data.runs ?? [])[0];
          emit(ctx, data, {
            columns: [
              "run_id",
              "status",
              "trigger_mode",
              "succeeded_items",
              "failed_items",
              "created_at",
            ],
            empty: "runs",
            emptyHint: describeRunFilters(status, Boolean(cmdOpts.activeOnly), startDate, endDate),
            next: first?.run_id
              ? [
                  {
                    why: "Follow the newest run",
                    command: `senso generate runs-get ${first.run_id}`,
                  },
                ]
              : [],
          });
        }),
      ),
    {
      returns: [
        "runs[], total, limit, offset",
        "run_id — pass it to runs-get, runs-items and runs-logs",
        `status — ${RUN_STATUS_LINE}`,
        "active — true while queued or running; this is what --active-only filters on",
        "pending_items, running_items, succeeded_items, failed_items, skipped_items, stopped_items — the per-prompt counts",
        "error_summary — set for failed, partial_failed, dispatch_failed and blocked",
      ],
      exitCodes: {
        ...apiExits,
        0: "success, including when nothing matched",
        2: `--status is not one of ${RUN_STATUSES.join(", ")}, --limit is below 1, --offset is negative, or a date is neither YYYY-MM-DD nor RFC 3339`,
        3: "no GEO product, or the key lacks read:content",
      },
      examples: [
        { command: "senso generate runs-list --active-only" },
        {
          comment: "The runs that partly failed",
          command:
            "senso generate runs-list --status partial_failed --output json | jq -r '.data.runs[].run_id'",
        },
      ],
      seeAlso: ["senso generate runs-get", "senso generate runs-items", "senso generate run"],
    },
  );

  describeCommand(
    gen
      .command("runs-get <runId>")
      .description(
        "Show one content generation run: its status, item counts and timestamps. Poll this until the status is terminal.",
      )
      .action(
        runAction(program, async (ctx, runId: string) => {
          const id = parseId(runId, RUN_ID);
          const data = await apiRequest<RunDetailResponse>({
            path: `/org/content-generation/runs/${id}`,
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
            resource: runResource(id),
          });

          const run = data.run;
          const terminal = run?.active !== true;
          // The payload is `{ run: { … } }`, so the generic renderer would print
          // one key with the whole run stringified onto it. JSON still carries
          // the API's own shape; only plain and table see the unwrapped row.
          emit(ctx, data, {
            rows: run ? [run] : [],
            columns: [
              "run_id",
              "status",
              "active",
              "succeeded_items",
              "failed_items",
              "started_at",
              "completed_at",
            ],
            next: terminal
              ? [
                  {
                    why: "See the content_id each prompt produced",
                    command: `senso generate runs-items ${id}`,
                  },
                ]
              : [
                  {
                    why: "The run is still active; poll it again",
                    command: `senso generate runs-get ${id}`,
                  },
                ],
          });
        }),
      ),
    {
      returns: [
        `data.run.status — ${RUN_STATUS_LINE}`,
        "data.run.active — true while queued or running",
        "data.run.pending_items, running_items, succeeded_items, failed_items, skipped_items, stopped_items",
        "data.run.error_summary — why a run failed, was blocked, or was never dispatched",
        "data.run.started_at, completed_at, last_heartbeat_at",
      ],
      exitCodes: {
        ...idExits,
        2: "runId is not a UUID",
        3: "no GEO product, or the key lacks read:content",
        4: "no run with this id in this organization",
      },
      examples: [
        { command: "senso generate runs-get 4e5f6a7b-8c9d-4e0f-a1b2-c3d4e5f6a7b8" },
        {
          comment: "Poll the status alone",
          command:
            "senso generate runs-get 4e5f6a7b-8c9d-4e0f-a1b2-c3d4e5f6a7b8 --output json | jq -r .data.run.status",
        },
      ],
      seeAlso: [
        "senso generate runs-items",
        "senso generate runs-logs",
        "senso generate runs-list",
      ],
    },
  );

  describeCommand(
    gen
      .command("runs-items <runId>")
      .description(
        "List the per-prompt items of a run: which prompt each was, what happened to it, and the content_id it produced.",
      )
      .option("--limit <n>", "Items per page, at least 1", "100")
      .option("--offset <n>", "Items to skip", "0")
      .option("--status <status>", `Only items in this status: ${RUN_ITEM_STATUSES.join(", ")}`)
      .action(
        runAction(program, async (ctx, runId: string, cmdOpts: Record<string, string>) => {
          const id = parseId(runId, RUN_ID);
          const status = parseEnumFlag("--status", cmdOpts.status, RUN_ITEM_STATUSES);
          const limit = parseIntFlag("--limit", cmdOpts.limit, { min: 1 });
          const offset = parseIntFlag("--offset", cmdOpts.offset, { min: 0 });

          const data = await apiRequest<RunItemsResponse>({
            path: `/org/content-generation/runs/${id}/items`,
            params: { limit, offset, status },
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
            resource: runResource(id),
          });

          const succeeded = (data.items ?? []).find(
            (item) => item.status === "succeeded" && item.content_id,
          );
          emit(ctx, data, {
            columns: [
              "run_item_id",
              "status",
              "queue_type",
              "question_text",
              "content_id",
              "failed_at_step",
            ],
            empty: "items",
            emptyHint: status
              ? `No item in this run is ${status}. Drop --status to see every item.`
              : "The run may not have resolved any prompts yet; check `senso generate runs-get`.",
            next: succeeded?.content_id
              ? [
                  {
                    why: "Read the content an item produced",
                    command: `senso generated-content get ${succeeded.content_id}`,
                  },
                ]
              : [],
          });
        }),
      ),
    {
      returns: [
        "items[], total, limit, offset",
        `status — ${ITEM_STATUS_LINE}`,
        "failed_at_step — validation | kb_search | content_generation | metadata_generation | json_ld_extraction | content_persist | publish | unknown",
        "operator_message — the readable reason a failed item failed",
        "content_id, version_id — the draft a succeeded item produced; read it with `senso generated-content get`",
        "publish_summary — the per-destination outcome when the run published",
      ],
      exitCodes: {
        ...idExits,
        0: "success, including when nothing matched",
        2: `runId is not a UUID, --status is not one of ${RUN_ITEM_STATUSES.join(", ")}, --limit is below 1, or --offset is negative`,
        3: "no GEO product, or the key lacks read:content",
        4: "no run with this id in this organization",
      },
      examples: [
        {
          comment: "Only what went wrong",
          command: "senso generate runs-items 4e5f6a7b-8c9d-4e0f-a1b2-c3d4e5f6a7b8 --status failed",
        },
        {
          comment: "Every content id the run produced",
          command:
            "senso generate runs-items 4e5f6a7b-8c9d-4e0f-a1b2-c3d4e5f6a7b8 --output json | jq -r '.data.items[] | select(.status==\"succeeded\") | .content_id'",
        },
      ],
      seeAlso: [
        "senso generate runs-get",
        "senso generate runs-logs",
        "senso generated-content get",
      ],
    },
  );

  describeCommand(
    gen
      .command("runs-logs <runId>")
      .description(
        "List the log lines a run emitted, oldest first. This is where the reason an item failed is written; run_item_id links a line to a row of `generate runs-items`.",
      )
      .option("--limit <n>", "Lines per page, at least 1", "100")
      .option("--offset <n>", "Lines to skip", "0")
      .action(
        runAction(program, async (ctx, runId: string, cmdOpts: Record<string, string>) => {
          const id = parseId(runId, RUN_ID);
          const limit = parseIntFlag("--limit", cmdOpts.limit, { min: 1 });
          const offset = parseIntFlag("--offset", cmdOpts.offset, { min: 0 });

          const data = await apiRequest({
            path: `/org/content-generation/runs/${id}/logs`,
            params: { limit, offset },
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
            resource: runResource(id),
          });
          emit(ctx, data, {
            columns: ["created_at", "level", "event_type", "message", "run_item_id"],
            empty: "log entries",
            emptyHint:
              "A run that has not started yet has no log lines. Check its status with `senso generate runs-get`.",
          });
        }),
      ),
    {
      returns: [
        "logs[], total, limit, offset",
        "level — info | warn | error",
        "event_type — the engine's own event name, e.g. item_started, item_failed, run_completed",
        "run_item_id — the item a line belongs to; absent on run-level lines",
      ],
      exitCodes: {
        ...idExits,
        0: "success, including when there are no lines",
        2: "runId is not a UUID, --limit is below 1, or --offset is negative",
        3: "no GEO product, or the key lacks read:content",
        4: "no run with this id in this organization",
      },
      examples: [
        { command: "senso generate runs-logs 4e5f6a7b-8c9d-4e0f-a1b2-c3d4e5f6a7b8" },
        {
          comment: "Only the errors",
          command:
            "senso generate runs-logs 4e5f6a7b-8c9d-4e0f-a1b2-c3d4e5f6a7b8 --output json | jq '.data.logs[] | select(.level==\"error\")'",
        },
      ],
      seeAlso: ["senso generate runs-items", "senso generate runs-get"],
    },
  );

  describeCommand(
    gen
      .command("industry-draft")
      .description(
        "Draft a complete document from one of your industry's prompts in a single synchronous call, grounded in your knowledge base and written in the given content type. THE RESULT IS NOT STORED: it is returned and then forgotten — nothing appears in `senso generated-content` unless you save it yourself with `senso engine draft`. Consumes credits, and takes 10-30 seconds.",
      )
      .requiredOption(
        "--industry-prompt-id <uuid>",
        "An industry prompt id from `senso industries prompts` — NOT a geo_question_id from `senso prompts list`",
      )
      .requiredOption(
        "--content-type-id <uuid>",
        "A content type id from `senso content-types list`, giving the document its format",
      )
      .option(
        "--product-line-ids <uuids>",
        "Comma-separated product line ids to ground on, 1 to 100. Omit for all of them.",
      )
      .option("--audience <text>", "Who the document is for (max 500 characters)")
      .option("--style-tone <text>", "Voice and tone guidance (max 500 characters)")
      .option(
        "--extra-instructions <text>",
        "Further instructions for the writer (max 4000 characters)",
      )
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
            const industryPromptId = parseId(cmdOpts.industryPromptId, INDUSTRY_PROMPT_ID);
            const contentTypeId = parseId(cmdOpts.contentTypeId, CONTENT_TYPE_ID);

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
              throw usageError(
                `Invalid ${tooLong[0]}: ${String(tooLong[1]?.length)} characters, the maximum is ${String(tooLong[2])}.`,
                {
                  field: tooLong[0],
                  received: `(${String(tooLong[1]?.length)} characters)`,
                  hint: "Shorten it; nothing was sent or billed.",
                },
              );
            }
            // An empty list is not "omit": omitting means every product line, so
            // silently sending [] would strip the context off a billable call.
            if (productLineIds?.length === 0) {
              throw usageError("Invalid --product-line-ids: no ids given.", {
                field: "--product-line-ids",
                received: cmdOpts.productLineIds ?? "",
                hint: "Omit the flag entirely to include all of your product lines.",
              });
            }
            if (productLineIds && productLineIds.length > 100) {
              throw usageError(
                `Invalid --product-line-ids: ${String(productLineIds.length)} ids given, the maximum is 100.`,
                {
                  field: "--product-line-ids",
                  received: `(${String(productLineIds.length)} ids)`,
                  hint: "Name at most 100, or omit the flag to include all of them.",
                },
              );
            }

            const body: Record<string, unknown> = {
              industry_prompt_id: industryPromptId,
              selected_content_type_id: contentTypeId,
            };
            if (productLineIds) {
              body.selected_product_line_ids = parseIdList(productLineIds, PRODUCT_LINE_IDS);
            }
            if (cmdOpts.audience !== undefined) body.audience = cmdOpts.audience;
            if (cmdOpts.styleTone !== undefined) body.style_tone = cmdOpts.styleTone;
            if (cmdOpts.extraInstructions !== undefined) {
              body.extra_instructions = cmdOpts.extraInstructions;
            }

            if (!ctx.quiet) log.info("Generating — this usually takes 10-30 seconds.");
            const data = await apiRequest<IndustryDraftResponse>({
              method: "POST",
              path: "/org/content-generation/industry-prompt-draft",
              body,
              apiKey: ctx.apiKey,
              baseUrl: ctx.baseUrl,
              resource: {
                type: "Industry prompt",
                id: industryPromptId,
                idField: "industry_prompt_id",
                list: "senso industries prompts <industry>",
              },
              // The document is generated inline, charged for, and not stored: a
              // draft that ran long would otherwise abort at the default 30s and
              // lose work the caller already paid for. The server answers 504 on
              // its own ceiling, so waiting is bounded either way.
              timeoutMs: DRAFT_TIMEOUT_MS,
            });

            // The warning is not decoration. An agent that assumes this was
            // saved will move on and lose the document, so the fact travels in
            // both renderings — warnings reach stderr in plain and the envelope
            // under --output json.
            emit(ctx, data, {
              warnings: [
                "This draft was NOT stored. It exists only in this response; save it before the process exits.",
                ...(data.notes ?? []),
              ],
              next: [
                {
                  why: "Store the draft as content (it is not saved otherwise)",
                  command:
                    'senso engine draft --data \'{"geo_question_id":"<geo_question_id>","seo_title":"…","raw_markdown":"…"}\'',
                },
              ],
            });
          },
        ),
      ),
    {
      returns: [
        "document_markdown — GitHub Flavored Markdown with [^n] footnote citations",
        "citations[] — {id, url, label, snippet} backing the footnotes; knowledge base sources use in-app URLs",
        "retrieval.total_results and retrieval.context_chunks_used — 0 chunks used means the draft is ungrounded (notes[] says so)",
        "content_type — {id, name}, echoed back; prompt_text and funnel_stage are the prompt's own",
        "notes[] — caveats about this result; they are repeated as warnings",
        "usage, model_used — what the two model steps cost",
      ],
      exitCodes: {
        ...idExits,
        2: "an id is not a UUID, --product-line-ids is empty or over 100, or a text option is over its limit",
        3: "no GEO product, or the key lacks update:content",
        4: "the industry prompt is not in this organization's industry",
        1: "no credits or the spending limit was reached (402); the organization has no industry (422); the content type is not this organization's (400); generation timed out server-side (504)",
      },
      notes: [
        "NOT STORED: the document is returned once. `senso generated-content list` will not show it.",
        "Billable: priced as an ad-hoc generation, checked before any generation happens.",
      ],
      examples: [
        {
          command:
            "senso generate industry-draft --industry-prompt-id 5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d --content-type-id 0b7d2c44-9f1e-4a6b-8c3d-5e2f1a0b9c8d",
        },
        {
          comment: "Keep the markdown, since nothing else will",
          command:
            "senso generate industry-draft --industry-prompt-id <uuid> --content-type-id <uuid> --output json | jq -r .data.document_markdown > draft.md",
        },
      ],
      seeAlso: [
        "senso industries prompts",
        "senso content-types list",
        "senso engine draft",
        "senso brand-kit get",
      ],
    },
  );
}

/**
 * Rejects a `--data` body the API would accept and quietly half-apply.
 *
 * The validator behind PATCH /org/content-generation reports a day outside 0-6
 * as "Should be at most 6 characters", which is about a string it never saw, and
 * a non-UUID content type id as "Invalid request payload" with no field name.
 * Neither tells a caller what to send instead.
 */
function validateSettingsBody(body: Record<string, unknown>): void {
  for (const key of ["enable_content_generation", "content_auto_publish"] as const) {
    const value = body[key];
    if (value !== undefined && typeof value !== "boolean") {
      throw usageError(`Invalid --data: ${key} must be true or false.`, {
        field: `--data.${key}`,
        received: JSON.stringify(value),
        allowed: ["true", "false"],
        hint: `Example: --data '{"${key}": true}'`,
      });
    }
  }

  const schedule = body.content_schedule;
  if (schedule !== undefined) {
    if (!Array.isArray(schedule)) {
      throw usageError("Invalid --data: content_schedule must be an array of days.", {
        field: "--data.content_schedule",
        received: JSON.stringify(schedule),
        hint: "Days are 0 (Sunday) to 6 (Saturday). Example: --data '{\"content_schedule\":[1,3,5]}'",
      });
    }
    schedule.forEach((day: unknown, i: number) => {
      if (typeof day !== "number" || !Number.isInteger(day) || day < 0 || day > 6) {
        throw usageError(
          `Invalid --data: content_schedule[${String(i)}] is ${JSON.stringify(day)}; days are 0 (Sunday) to 6 (Saturday).`,
          {
            field: `--data.content_schedule[${String(i)}]`,
            received: JSON.stringify(day),
            allowed: ["0", "1", "2", "3", "4", "5", "6"],
            hint: "Example: --data '{\"content_schedule\":[1,3,5]}'",
          },
        );
      }
    });
  }

  const contentTypeId = body.selected_content_type_id;
  if (contentTypeId !== undefined && contentTypeId !== null) {
    if (typeof contentTypeId !== "string" || !isUuid(contentTypeId)) {
      throw usageError(
        `Invalid --data: selected_content_type_id must be a UUID or null, got ${JSON.stringify(contentTypeId)}.`,
        {
          field: "--data.selected_content_type_id",
          received: JSON.stringify(contentTypeId),
          hint: "List content types with `senso content-types list`; null clears the selection.",
        },
      );
    }
  }
}

/**
 * A slug, not a publisher_id, and within the API's own length bound.
 *
 * The length is checked here because the API's answer — "Should be at most 64
 * characters" on a field the caller never named — arrives after the job has
 * been submitted, and a submitted job is billable.
 */
function parseDestination(value: string): string {
  const slug = value.trim();
  if (slug.length === 0) {
    throw usageError("Invalid --destination: it is empty.", {
      field: "--destination",
      received: value,
      hint: "Destination slugs are the `slug` field of `senso destinations list`.",
    });
  }
  if (slug.length > 64) {
    throw usageError(
      `Invalid --destination: ${String(slug.length)} characters, the maximum is 64.`,
      {
        field: "--destination",
        received: value,
        hint: "Destination slugs are the `slug` field of `senso destinations list`.",
      },
    );
  }
  return slug;
}

/**
 * The runs endpoints take either form on the same flag.
 *
 * `--start-date 2026-01-01` and `--start-date 2026-01-01T00:00:00Z` are both
 * valid to the API, so insisting on one of them here would reject a command
 * line that works. The `T` is what the API's own parser branches on.
 */
function parseRunDate(flag: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.includes("T") ? parseInstantFlag(flag, value) : parseDateFlag(flag, value);
}

/** Why a run list came back empty, naming the filters that could have hidden one. */
function describeRunFilters(
  status: string | undefined,
  activeOnly: boolean,
  startDate: string | undefined,
  endDate: string | undefined,
): string {
  const applied: string[] = [];
  if (status) applied.push(`--status ${status}`);
  if (activeOnly) applied.push("--active-only");
  if (startDate) applied.push(`--start-date ${startDate}`);
  if (endDate) applied.push(`--end-date ${endDate}`);
  return applied.length > 0
    ? `No run matched ${applied.join(" ")}. Drop the filters to see every run: senso generate runs-list`
    : "This organization has never run the content engine. Start one with `senso generate run`.";
}

/** What to do with a sample job's result, once there is one. */
function sampleNextSteps(result: ContentGenerationSampleResult | undefined): NextStep[] {
  const contentId = result?.content_id;
  if (!contentId) return [];
  return [
    {
      why: "Read the saved draft",
      command: `senso generated-content get ${contentId}`,
    },
    {
      why: "See which CTA the page will carry when it publishes",
      command: `senso ctas for-content ${contentId}`,
    },
  ];
}

/**
 * A job that ran and failed, as an error a caller can branch on.
 *
 * The HTTP status was 200 — the failure is inside the payload — so nothing
 * upstream will classify it. `insufficient_credits` is lifted to the CLI's own
 * stable code because "top up" is a different reaction from "fix the command",
 * and an agent should not have to string-match to tell them apart.
 */
function sampleJobFailure(job: ContentGenerationSampleJobResponse): CliError {
  const reported = job.error?.message;
  // An empty message is as useless as a missing one, so both fall back to the
  // status line rather than reporting a blank failure.
  const message =
    reported === undefined || reported === ""
      ? `Sample job ended with status: ${job.status}`
      : `Sample job failed: ${reported}`;
  const jobCode = job.error?.code;
  const code: ErrorCode = jobCode === "insufficient_credits" ? "insufficient_credits" : "error";

  return new CliError(jobCode ? `${message} (${jobCode})` : message, EXIT.ERROR, {
    code,
    hint: jobCode ? SAMPLE_JOB_HINTS[jobCode] : undefined,
    details: { sample_job_id: job.sample_job_id, status: job.status, job_code: jobCode },
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
      resource: { type: "Sample job", id: sampleJobId, idField: "sample_job_id" },
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
  throw new CliError(
    `Timed out after 180 s waiting for sample job ${sampleJobId} (last status: ${lastStatus || "unknown"}).`,
    EXIT.NETWORK,
    {
      code: "timeout",
      hint: `The job continues server-side. Poll it with \`senso generate sample-status ${sampleJobId}\`.`,
    },
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
