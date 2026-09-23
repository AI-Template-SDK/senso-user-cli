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
import { apiRequest } from "../lib/api-client.js";
import { CliError, EXIT } from "../lib/errors.js";
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
  selection_method?: "all" | "llm" | "heuristic";
  candidates_found?: number;
  candidates_considered?: number;
  sitemap_found?: boolean;
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

  const chosenBy = describeSelection(run);
  if (chosenBy) log.info(chosenBy);

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
 * One line on how the pages beyond the home page were chosen, or undefined for
 * a run from an API that does not report it.
 */
function describeSelection(run: WebsiteImportRun): string | undefined {
  const found = run.candidates_found;
  const source = run.sitemap_found ? "home page links and sitemap" : "home page links";
  switch (run.selection_method) {
    case "all":
      return `Took every candidate page (${String(found ?? 0)} found in the ${source}).`;
    case "llm":
      return `Picked the most informative pages from ${String(found ?? 0)} candidates in the ${source}.`;
    case "heuristic":
      return `Picked pages by URL ranking from ${String(found ?? 0)} candidates in the ${source} (AI selection was unavailable).`;
    default:
      return undefined;
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

export function registerWebsiteImportCommands(program: Command): void {
  const websiteImport = program
    .command("website-import")
    .description(
      "Import your organization's website into the knowledge base. Fetches the home page plus up to 19 more of its pages — picked from the home page's links and the sitemap, favouring the ones that answer what people most often ask about the business — ingests each as a document under a folder named 'Website', and drafts a brand kit if the organization does not have one yet.",
    );

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
          // 409 keeps the CLI's standard mapping to exit 1 rather than being
          // treated as success, but the generic "Conflict: ..." message does not
          // say what to do next, and only one import can run per organization.
          const status = (err as { status?: number }).status;
          if (status === 409) {
            throw new CliError(
              "A website import is already running for this organization.",
              EXIT.ERROR,
              {
                code: "conflict",
                status: 409,
                hint: "Run `senso website-import status` to follow the one in flight.",
                cause: err,
              },
            );
          }
          throw err;
        }

        if (!cmdOpts.wait) {
          if (!ctx.quiet) log.success(`Website import ${accepted.run_id} started.`);
          emit(ctx, accepted, { columns: RUN_COLUMNS });
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

        emit(ctx, finished, { columns: RUN_COLUMNS });
      }),
    );

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
        });
      }),
    );
}
