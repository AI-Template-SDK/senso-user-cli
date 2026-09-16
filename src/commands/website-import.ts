/**
 * Website import — POST /org/website-import and GET /org/website-import/status.
 *
 * One call seeds the knowledge base from the organization's own public site and
 * drafts a brand kit if there is not one yet. The site is the one on file at
 * `GET /org/me`; nothing about it is passed here, which is why `start` takes no
 * arguments at all.
 *
 * The asynchronous shape is the same one `generate sample` uses: the trigger
 * returns a run, the command polls to completion by default, and `--no-wait`
 * hands back the accepted run instead.
 */

import { Command } from "commander";
import pc from "picocolors";
import { apiRequest } from "../lib/api-client.js";
import { CliError, EXIT } from "../lib/errors.js";
import { apiExits, describeCommand } from "../lib/help.js";
import { emit } from "../lib/output.js";
import { runAction } from "../lib/run-action.js";
import { spinner } from "../lib/progress.js";
import * as log from "../utils/logger.js";

const POLL_INTERVAL_MS = 2_000;
const IMPORT_TIMEOUT_MS = 180_000;

interface WebsiteImportRun {
  run_id: string;
  status: string;
  source_url: string;
  pages_fetched: number;
  pages_ingested: number;
  brand_kit_generated: boolean;
  brand_kit_skip_reason?: string;
  error_code?: string;
  error_message?: string;
  created_at: string;
  started_at?: string;
  completed_at?: string;
}

interface WebsiteImportStatus {
  current: WebsiteImportRun | null;
  latest_completed: WebsiteImportRun | null;
}

const RUN_COLUMNS = [
  "run_id",
  "status",
  "source_url",
  "pages_fetched",
  "pages_ingested",
  "brand_kit_generated",
];

function getStatus(ctx: { apiKey?: string; baseUrl?: string }): Promise<WebsiteImportStatus> {
  return apiRequest<WebsiteImportStatus>({
    path: "/org/website-import/status",
    apiKey: ctx.apiKey,
    baseUrl: ctx.baseUrl,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Polls until nothing is in flight, then returns the finished run.
 *
 * The outcome is read from `latest_completed`, never from `current`: a finished
 * import leaves `current` the moment it ends, so waiting for `current.status` to
 * turn terminal waits forever. `current` going null IS the completion signal.
 */
async function waitForImport(
  runId: string,
  ctx: { apiKey?: string; baseUrl?: string; quiet: boolean },
): Promise<WebsiteImportRun> {
  const deadline = Date.now() + IMPORT_TIMEOUT_MS;
  let lastStatus = "";

  while (Date.now() < deadline) {
    const { current, latest_completed: latest } = await getStatus(ctx);

    if (current && !ctx.quiet && current.status !== lastStatus) {
      log.info(`Website import status: ${current.status}`);
      lastStatus = current.status;
    }

    if (!current) {
      // Nothing running. The run we started is finished if it is the one now
      // sitting in latest_completed; anything else means somebody else's import
      // displaced it, which is not an outcome we can report as ours.
      if (latest?.run_id === runId) return latest;
      throw new CliError(
        `Website import ${runId} finished but its result could not be read.`,
        EXIT.ERROR,
        {
          hint: "Run `senso website-import status` to see the most recent import.",
        },
      );
    }

    await sleep(POLL_INTERVAL_MS);
  }

  // NETWORK rather than ERROR: the import is still running server-side, so this
  // is "we stopped waiting", which a caller can reasonably retry or poll.
  throw new CliError(`Timed out waiting for website import ${runId}.`, EXIT.NETWORK, {
    code: "timeout",
    hint: "Run `senso website-import status` to check on it.",
  });
}

/** Reports a finished run on stderr, in the detail its outcome warrants. */
function describeOutcome(run: WebsiteImportRun, quiet: boolean): void {
  if (quiet) return;

  if (run.status === "failed") {
    log.error(`Website import failed: ${run.error_message ?? "no reason given"}`);
    if (run.error_code) log.error(`Reason code: ${run.error_code}`);
    return;
  }

  log.success(
    `Imported ${String(run.pages_ingested)} of ${String(run.pages_fetched)} page(s) from ${run.source_url}.`,
  );

  if (run.brand_kit_generated) {
    log.success("A brand kit was generated from the site.");
  } else if (run.brand_kit_skip_reason === "already_populated") {
    // A skip is a success, not a failure: the API declines to overwrite a brand
    // kit that already has content, and says so rather than erroring.
    log.info("Brand kit left alone — this organization already has one.");
  }

  if (run.pages_ingested < run.pages_fetched) {
    log.info("Pages already in the knowledge base unchanged are fetched but not re-ingested.");
  }
}

/**
 * The two nullable slots as table rows, absent ones dropped.
 *
 * Built here rather than left to `findRows`: a status envelope is two optional
 * objects, not a list plus pagination, so nothing in it looks like rows.
 */
function buildStatusRows(data: WebsiteImportStatus): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  if (data.current) rows.push({ slot: "current", ...data.current });
  if (data.latest_completed) rows.push({ slot: "latest_completed", ...data.latest_completed });
  return rows;
}

/** One run as labeled lines. */
function runLines(run: WebsiteImportRun): string[] {
  const lines = [
    `     run_id               ${run.run_id}`,
    `     status               ${run.status}`,
    `     source_url           ${run.source_url}`,
    `     pages_fetched        ${String(run.pages_fetched)}`,
    `     pages_ingested       ${String(run.pages_ingested)}`,
    `     brand_kit_generated  ${String(run.brand_kit_generated)}`,
  ];
  if (run.brand_kit_skip_reason) {
    lines.push(`     brand_kit_skip_reason  ${run.brand_kit_skip_reason}`);
  }
  if (run.error_code) lines.push(`     error_code           ${run.error_code}`);
  if (run.error_message) lines.push(`     error_message        ${run.error_message}`);
  return lines;
}

/**
 * The two slots, said out loud.
 *
 * "In flight: none" is the whole point: the generic renderer dropped a null
 * slot entirely, so a reader could not tell "nothing is running" from "the CLI
 * did not print that field".
 */
function plainStatus(data: WebsiteImportStatus): string[] {
  if (!data.current && !data.latest_completed) {
    return ["", "  No website imports yet.", ""];
  }
  const lines = [""];
  lines.push(`  ${pc.bold("In flight:")}     ${data.current ? "" : "none"}`);
  if (data.current) lines.push(...runLines(data.current));
  lines.push(`  ${pc.bold("Last finished:")} ${data.latest_completed ? "" : "none"}`);
  if (data.latest_completed) lines.push(...runLines(data.latest_completed));
  lines.push("");
  return lines;
}

/** The API body, when it sent one that parsed. */
function errorBody(err: unknown): Record<string, unknown> {
  const body = (err as { body?: unknown }).body;
  return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
}

/**
 * Re-reports the failures whose generic mapping sends a caller the wrong way.
 *
 * Three of them mattered enough to name: a 403 from the product gate is not a
 * key-scope problem and no admin can widen a key into it; a 422 is a missing
 * website on the organization, which has a one-line fix; and a 503 here is a
 * deployment that has the feature switched off, so "retry shortly" is advice
 * that will never come true.
 */
function mapStartError(err: unknown): unknown {
  const status = (err as { status?: number }).status;
  const message = err instanceof Error ? err.message : String(err);
  const body = errorBody(err);

  if (status === 409) {
    const current = body.current as { run_id?: string; started_at?: string } | undefined;
    const detail = current?.run_id ? ` Run ${current.run_id} is in flight.` : "";
    return new CliError(
      `A website import is already running for this organization.${detail}`,
      EXIT.ERROR,
      {
        code: "conflict",
        status: 409,
        hint: "Run `senso website-import status` to follow the one in flight.",
        details: current,
        cause: err,
      },
    );
  }

  if (status === 422) {
    return new CliError(
      `Cannot import: no website is on file for this organization (API: ${message}).`,
      EXIT.ERROR,
      {
        code: "validation",
        status: 422,
        hint: `Set one first: senso org update --data '{"websites":["https://example.com"]}'`,
        details: body,
        cause: err,
      },
    );
  }

  if (status === 503) {
    return new CliError("Website import is not enabled in this environment.", EXIT.ERROR, {
      code: "error",
      status: 503,
      details: body,
      cause: err,
    });
  }

  if (status === 403 && /product/i.test(message)) {
    return new CliError(
      `Website import needs the GEO product, which this organization does not have (API: ${message}).`,
      EXIT.AUTH,
      {
        code: "forbidden",
        status: 403,
        hint: "This is a product entitlement, not a key scope: contact Senso to enable GEO.",
        cause: err,
      },
    );
  }

  return err;
}

export function registerWebsiteImportCommands(program: Command): void {
  const websiteImport = program
    .command("website-import")
    .description(
      "Import your organization's website into the knowledge base. Fetches the home page plus up to 10 linked pages, ingests each as a document under a folder named 'Website', and drafts a brand kit if the organization does not have one yet.",
    )
    .addHelpText(
      "after",
      [
        "",
        "The site is the one on file for the organization (`senso org get` → primary_website_url,",
        "websites); nothing about it is passed here. One import runs per organization at a time.",
        "",
        "Gated on the GEO product and the update:brand_kit permission — even `status`, which is a",
        "read. Without them the API answers 403.",
        "",
        "Workflow:",
        "  1. senso website-import start          starts one and waits",
        "  2. senso website-import status         poll while `current` is non-null",
        "  3. senso kb find --query Website       the pages it ingested",
      ].join("\n"),
    );

  describeCommand(
    websiteImport
      .command("start")
      .description(
        "Start a website import and wait for it to finish. The site imported is the one on file for your organization — see 'senso org get' — not a value you pass, so this takes no arguments. Exits 1 if the import finishes in a failed state.",
      )
      .option(
        "--no-wait",
        "Return the accepted run immediately instead of polling until the import finishes.",
      )
      .action(
        runAction(program, async (ctx, cmdOpts: { wait: boolean }) => {
          let accepted: WebsiteImportRun;
          try {
            accepted = await apiRequest<WebsiteImportRun>({
              method: "POST",
              path: "/org/website-import",
              apiKey: ctx.apiKey,
              baseUrl: ctx.baseUrl,
            });
          } catch (err) {
            // The generic mappings for 409, 422, 503 and the product 403 all
            // point a caller at the wrong fix; mapStartError says what each one
            // actually means here.
            throw mapStartError(err);
          }

          if (!cmdOpts.wait) {
            if (!ctx.quiet) log.success(`Website import ${accepted.run_id} started.`);
            // The command returned before the work finished, so it owes the
            // caller the exact way to find out how it ended.
            emit(ctx, accepted, {
              columns: RUN_COLUMNS,
              next: [
                {
                  why: "Poll until `current` is null, then read `latest_completed`",
                  command: "senso website-import status",
                },
              ],
            });
            return;
          }

          const spin = spinner(ctx.quiet);
          spin.start("Importing website...");
          let finished: WebsiteImportRun;
          try {
            finished = await waitForImport(accepted.run_id, ctx);
          } catch (err) {
            // Or the spinner keeps turning over the error, with the cursor hidden.
            spin.stop("Website import did not finish");
            throw err;
          }
          spin.stop("Website import finished");

          describeOutcome(finished, ctx.quiet);

          // Thrown BEFORE the payload is emitted, so stdout stays empty on a
          // failure like every other command here. A caller that waited for the
          // import and got exit 0 should be able to trust that it worked.
          if (finished.status === "failed") {
            throw new CliError(
              `Website import ${finished.run_id} failed${finished.error_code ? ` (${finished.error_code})` : ""}.`,
              EXIT.ERROR,
              { hint: "Run `senso website-import status` for the full record." },
            );
          }

          emit(ctx, finished, {
            columns: RUN_COLUMNS,
            next: [
              { why: "Read the pages it ingested", command: "senso kb find --query Website" },
              ...(finished.brand_kit_generated
                ? [{ why: "Read the brand kit it drafted", command: "senso brand-kit get" }]
                : []),
            ],
          });
        }),
      ),
    {
      returns: [
        "run_id — this import run",
        "status — queued | running | completed | failed",
        "source_url — the site that was fetched, from the organization's record",
        "pages_fetched / pages_ingested — ingested is lower when a page was already in the knowledge base unchanged",
        "brand_kit_generated — true when a brand kit was drafted from the site",
        "brand_kit_skip_reason — already_populated when the organization already had one",
        "error_code / error_message — present on a failed run",
      ],
      exitCodes: {
        ...apiExits,
        1: "the import finished failed, one is already running (409), no website is on file (422), or the feature is off in this environment (503)",
        3: "no API key, the key was rejected, the key lacks update:brand_kit, or the organization does not have the GEO product",
        5: "the CLI waited 180 s and stopped; the import is still running server-side",
      },
      notes: [
        "Waits by default: polls GET /org/website-import/status every 2 s for up to 180 s.",
        "A timeout is exit 5 and does NOT cancel the import — poll `senso website-import status`.",
        "One import runs per organization at a time.",
        "Needs the GEO product and the update:brand_kit permission.",
      ],
      examples: [
        { comment: "Import and wait", command: "senso website-import start" },
        {
          comment: "Start and poll yourself",
          command: "senso website-import start --no-wait --output json",
        },
      ],
      seeAlso: ["senso website-import status", "senso org get", "senso kb find --query Website"],
    },
  );

  describeCommand(
    websiteImport
      .command("status")
      .description(
        "Show the website import in flight and the most recently finished one. Either may be absent. This is a read: it exits 0 even when the last import failed.",
      )
      .action(
        runAction(program, async (ctx) => {
          const data = await getStatus(ctx);

          if (!ctx.quiet && !data.current && !data.latest_completed) {
            log.info("This organization has never imported its website.");
          }

          emit(ctx, data, {
            // A status envelope is two nullable runs, not a list, so the table
            // rendering is built here rather than left to findRows.
            table: {
              rows: buildStatusRows(data),
              columns: ["slot", ...RUN_COLUMNS],
            },
            plain: plainStatus(data),
            next:
              !data.current && !data.latest_completed
                ? [
                    {
                      why: "Import the organization's website",
                      command: "senso website-import start",
                    },
                  ]
                : [],
          });
        }),
      ),
    {
      returns: [
        "current — the run in flight, or null. Poll while it is non-null",
        "latest_completed — the most recent finished run (completed OR failed), or null",
        "<run>.status — queued | running | completed | failed",
        "<run>.error_code / error_message — present on a failed run",
        "Both null means this organization has never imported its website",
      ],
      exitCodes: {
        ...apiExits,
        3: "no API key, the key was rejected, the key lacks update:brand_kit, or the organization does not have the GEO product",
      },
      notes: [
        "A read that needs a write permission: the route is gated on update:brand_kit and the GEO product.",
        "Exits 0 even when the last import failed — read `latest_completed.status`.",
      ],
      examples: [
        {
          comment: "Is one running?",
          command: "senso website-import status --output json | jq '.data.current'",
        },
        {
          comment: "How did the last one end?",
          command:
            "senso website-import status --output json | jq -r '.data.latest_completed.status'",
        },
      ],
      seeAlso: ["senso website-import start"],
    },
  );
}
