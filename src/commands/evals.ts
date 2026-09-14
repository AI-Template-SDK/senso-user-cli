import { readFile } from "node:fs/promises";
import { Command } from "commander";
import { apiRequest } from "../lib/api-client.js";
import { parseEnumFlag, parseIntFlag } from "../lib/enum-arg.js";
import { CliError, EXIT } from "../lib/errors.js";
import { emit } from "../lib/output.js";
import { runAction, type Ctx } from "../lib/run-action.js";
import * as log from "../utils/logger.js";

/**
 * Judging text against the organization's own ground truth.
 *
 * A run applies one evaluator to one subject and records every claim it
 * checked, the verdict and the evidence, so a score can be audited rather than
 * taken on faith. `kb_accuracy` checks factual claims against the knowledge
 * base; `brand_alignment` grades writing against the brand kit's rules.
 * Checking one text for both is two runs — the two questions fail
 * independently, and one score must not cover for the other.
 */

const EVALUATORS = ["kb_accuracy", "brand_alignment"] as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Options every trigger accepts, mapped onto the request body. */
interface TriggerOptions {
  evaluator?: string;
  evaluatorVersion?: string;
  judgeModel?: string;
  label?: string;
  idempotencyKey?: string;
  wait?: boolean;
}

function withTriggerOptions(cmd: Command): Command {
  return cmd
    .option(
      "--evaluator <key>",
      `Which check to run: ${EVALUATORS.join(", ")} (default kb_accuracy)`,
    )
    .option("--evaluator-version <v>", "Pin an evaluator version (see `senso evals evaluators`)")
    .option("--judge-model <model>", "Override the model that judges the text")
    .option("--label <text>", "Free-form tag stored on the run, for finding it later")
    .option(
      "--idempotency-key <key>",
      "Makes the trigger safe to retry — the same key returns the original run",
    )
    .option("--wait", "Poll until the run finishes instead of returning a handle straight away");
}

function triggerBody(o: TriggerOptions): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const evaluator = parseEnumFlag("--evaluator", o.evaluator, EVALUATORS);
  if (evaluator) body.evaluator = evaluator;
  if (o.evaluatorVersion !== undefined) body.evaluator_version = o.evaluatorVersion;
  if (o.judgeModel !== undefined) body.judge_model = o.judgeModel;
  if (o.label !== undefined) {
    if (o.label.length > 128) {
      throw new CliError(
        `Invalid --label: ${String(o.label.length)} characters, the maximum is 128.`,
        EXIT.USAGE,
        { code: "usage" },
      );
    }
    body.label = o.label;
  }
  if (o.idempotencyKey !== undefined) {
    if (o.idempotencyKey.length > 255) {
      throw new CliError(
        `Invalid --idempotency-key: ${String(o.idempotencyKey.length)} characters, the maximum is 255.`,
        EXIT.USAGE,
        { code: "usage" },
      );
    }
    body.idempotency_key = o.idempotencyKey;
  }
  // `wait` is deliberately NOT forwarded to the API. The server holds the
  // connection, and `apiRequest` gives up at 30 seconds — a judge run that took
  // 18 seconds one time took over 30 the next, so the flag would have failed
  // roughly as often as it worked. `--wait` polls the run instead, which is
  // what `generate sample` already does for the same reason.
  return body;
}

const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 180_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The spec is explicit: a run is finished when its status is `completed`,
 * `gated` or `failed`. `gated` is the one worth naming — a pre-check found
 * nothing to judge, so the run ended immediately with no model spend, and a
 * poll loop that waited for `completed` would have spun the full budget on a
 * run that was already over. `canceled` is reserved and not currently produced;
 * it is treated as terminal so that producing it later cannot hang a caller.
 */
const FINISHED = new Set(["completed", "gated", "failed", "canceled"]);

function isFinished(status: string | undefined): boolean {
  return status !== undefined && FINISHED.has(status);
}

/**
 * Poll one run until it stops moving.
 *
 * A trigger answers with a queued run, so a caller that wants a verdict rather
 * than a handle has to wait for one. Reading an unfinished run as a score is the
 * mistake worth preventing, so this returns only a finished run or an error.
 */
async function waitForRun(
  runId: string,
  opts: { apiKey?: string; baseUrl?: string; quiet?: boolean },
): Promise<unknown> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let lastStatus = "";

  while (Date.now() < deadline) {
    const run = await apiRequest<{ status?: string }>({
      path: `/org/evals/runs/${runId}`,
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl,
    });

    if (!opts.quiet && run.status !== undefined && run.status !== lastStatus) {
      log.info(`Eval run status: ${run.status}`);
      lastStatus = run.status;
    }
    if (isFinished(run.status)) return run;

    await sleep(POLL_INTERVAL_MS);
  }

  // NETWORK, not ERROR: the run is still going server-side, so this is a "we
  // stopped waiting" outcome the caller can retry.
  throw new CliError(`Timed out waiting for eval run ${runId}.`, EXIT.NETWORK, {
    code: "timeout",
    hint: `The run is still going. Read it with \`senso evals get ${runId}\`.`,
  });
}

/**
 * Report a trigger's outcome, then hand back the payload — or fail.
 *
 * A caller who passed `--wait` asked for a verdict. A run that ends `failed`
 * has none: the judge did not get to a score, so exit 0 with a payload would
 * read as one. Following `website-import start`, the error is thrown BEFORE the
 * payload is emitted, leaving stdout empty on failure like every other command.
 * Without `--wait` a queued run is the expected answer, so it is emitted as-is.
 */
function finishTrigger(ctx: Ctx, data: unknown, waited: boolean): void {
  const run = data as {
    eval_run_id?: string;
    status?: string;
    error_code?: string;
    error_message?: string;
  };

  if (!ctx.quiet) {
    if (run.status === "failed") {
      log.error(`Eval run failed: ${run.error_message ?? "no reason given"}`);
      if (run.error_code) log.error(`Reason code: ${run.error_code}`);
    } else if (run.status === "gated") {
      // Not an error and not a score: the pre-check found nothing to judge, so
      // say so rather than let an empty result read as a clean bill of health.
      log.warn("Eval run gated: the pre-check found nothing to judge, so no score was produced.");
    } else if (run.status === "completed") {
      log.success("Eval run completed.");
    } else {
      log.info(
        `Eval run ${run.status ?? "queued"}. Read it with \`senso evals get ${run.eval_run_id ?? "<runId>"}\`.`,
      );
    }
  }

  if (waited && run.status === "failed") {
    throw new CliError(
      `Eval run ${run.eval_run_id ?? ""} failed${run.error_code ? ` (${run.error_code})` : ""}.`.replace(
        "  ",
        " ",
      ),
      EXIT.ERROR,
      { hint: `Read the full record with \`senso evals get ${run.eval_run_id ?? "<runId>"}\`.` },
    );
  }

  emit(ctx, data, { columns: RUN_COLUMNS });
}

/**
 * Filters shared by `runs` and `claims`.
 *
 * `--evaluator` and `--subject-type` are deliberately NOT checked against a
 * fixed list: the spec gives them no enum, and the evaluators endpoint reports
 * subjects this CLI has no business restricting — `question_run`, `search_turn`
 * and others exist alongside `inline` and `content`.
 */
interface ListFilters {
  from?: string;
  to?: string;
  evaluator?: string;
  subjectType?: string;
  limit?: string;
  offset?: string;
}

/**
 * `from` and `to` are RFC 3339 instants here, NOT the `YYYY-MM-DD` dates the
 * analytics and industries commands take. The API answers anything else with a
 * 400, and a caller who reasonably assumed a plain date should learn that from
 * the flag rather than from a round trip.
 */
function parseInstantFlag(flag: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value.trim())) {
    throw new CliError(`Invalid ${flag}: "${value}" is not an RFC 3339 instant.`, EXIT.USAGE, {
      code: "usage",
      hint: "Use a full timestamp with a time zone, e.g. 2026-09-01T00:00:00Z.",
    });
  }
  return value.trim();
}

function listParams(o: ListFilters): Record<string, string | undefined> {
  return {
    from: parseInstantFlag("--from", o.from),
    to: parseInstantFlag("--to", o.to),
    evaluator: o.evaluator,
    subject_type: o.subjectType,
    limit: parseIntFlag("--limit", o.limit, { min: 1, max: 100 })?.toString(),
    offset: parseIntFlag("--offset", o.offset, { min: 0 })?.toString(),
  };
}

function withListOptions(cmd: Command): Command {
  return cmd
    .option(
      "--from <instant>",
      "Only items created at or after this RFC 3339 instant, e.g. 2026-09-01T00:00:00Z",
    )
    .option("--to <instant>", "Only items created before this RFC 3339 instant (exclusive)")
    .option("--evaluator <key>", "Filter by evaluator key (see `senso evals evaluators`)")
    .option("--subject-type <type>", "Filter by subject type, e.g. inline or content")
    .option("--limit <n>", "Page size, 1-100 (default 25)")
    .option("--offset <n>", "Number of items to skip (default 0)");
}

/**
 * Eight, because `outputTable` caps at eight and silently drops the rest — a
 * longer list would promise columns that never render. `subject_type` and
 * `created_at` lost the cut: the first is a filter you already chose, and runs
 * come back newest first.
 */
const RUN_COLUMNS = [
  "eval_run_id",
  "evaluator_key",
  "status",
  "accuracy_pct",
  "band",
  "claims_scored",
  "claims_total",
  "label",
];

export function registerEvalsCommands(program: Command): void {
  const evals = program
    .command("evals")
    .description(
      "Judge text against your organization's ground truth. `kb_accuracy` verifies the factual claims a text makes about your brand against your knowledge base; `brand_alignment` grades it against your brand kit's writing rules. Every run records the claims it checked, the verdict and the evidence, so a score can be audited rather than trusted. Judge model spend is recorded on each run but is not billed against your credit balance.",
    );

  evals
    .command("evaluators")
    .description(
      "List the evaluators available to this organization, with the version each one is currently on. Use `latest_version` here to pin `--evaluator-version` on a trigger.",
    )
    .action(
      runAction(program, async (ctx: Ctx) => {
        const data = await apiRequest({
          path: "/org/evals/evaluators",
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emit(ctx, data, {
          columns: ["key", "display_name", "evaluation_unit", "scope", "latest_version"],
        });
      }),
    );

  withTriggerOptions(
    evals
      .command("text")
      .description(
        "Judge text you supply. Pass the text with --text, or --text-file to read it from a file. Returns straight away with a run handle to read later with `senso evals get`; add --wait to poll until the run finishes and print the finished run instead. A run that ends `failed` under --wait exits 1, so a caller that waited and got exit 0 can trust the score it was handed.",
      ),
  )
    .option("--text <text>", "The text to judge")
    .option("--text-file <path>", "Read the text to judge from a file")
    .option("--title <title>", "Optional title, stored with the run's subject (max 255 chars)")
    .action(
      runAction(
        program,
        async (
          ctx: Ctx,
          cmdOpts: TriggerOptions & { text?: string; textFile?: string; title?: string },
        ) => {
          if ((cmdOpts.text === undefined) === (cmdOpts.textFile === undefined)) {
            throw new CliError("Pass exactly one of --text or --text-file.", EXIT.USAGE, {
              code: "usage",
            });
          }
          if (cmdOpts.title !== undefined && cmdOpts.title.length > 255) {
            throw new CliError(
              `Invalid --title: ${String(cmdOpts.title.length)} characters, the maximum is 255.`,
              EXIT.USAGE,
              { code: "usage" },
            );
          }

          let text = cmdOpts.text;
          if (cmdOpts.textFile !== undefined) {
            try {
              text = await readFile(cmdOpts.textFile, "utf-8");
            } catch {
              throw new CliError(`Cannot read --text-file: ${cmdOpts.textFile}`, EXIT.USAGE, {
                code: "usage",
              });
            }
          }
          // The API answers an empty string with a 400 and whitespace with a
          // 422; neither is worth a round trip to discover.
          if (text === undefined || text.trim().length === 0) {
            throw new CliError("The text to judge is empty.", EXIT.USAGE, { code: "usage" });
          }

          const body: Record<string, unknown> = { ...triggerBody(cmdOpts), text };
          if (cmdOpts.title !== undefined) body.title = cmdOpts.title;

          const triggered = await apiRequest<{ eval_run_id?: string }>({
            method: "POST",
            path: "/org/evals/text",
            body,
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
          });

          const data =
            cmdOpts.wait && triggered.eval_run_id
              ? await waitForRun(triggered.eval_run_id, ctx)
              : triggered;
          finishTrigger(ctx, data, Boolean(cmdOpts.wait));
        },
      ),
    );

  withListOptions(
    evals
      .command("runs")
      .description(
        "List eval runs, newest first. Each row carries the score and the claim counts behind it, so a run can be read without opening it.",
      ),
  ).action(
    runAction(program, async (ctx: Ctx, cmdOpts: ListFilters) => {
      const data = await apiRequest({
        path: "/org/evals/runs",
        params: listParams(cmdOpts),
        apiKey: ctx.apiKey,
        baseUrl: ctx.baseUrl,
      });
      emit(ctx, data, { columns: RUN_COLUMNS });
    }),
  );

  evals
    .command("get <runId>")
    .description(
      "Get one eval run in full — every claim it checked, the verdict, the evidence behind it, and what the judge searched for. This is the auditable form of a score.",
    )
    .action(
      runAction(program, async (ctx: Ctx, runId: string) => {
        const data = await apiRequest({
          path: `/org/evals/runs/${encodeURIComponent(runId)}`,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emit(ctx, data, { columns: RUN_COLUMNS });
      }),
    );

  withListOptions(
    evals
      .command("claims")
      .description(
        "List the individual claims evaluators have judged, across runs. This is the grain a score is built from: each row carries the claim, the verdict, whether it counted toward the score, and the evidence the judge relied on. Narrow to one run with --run-id.",
      ),
  )
    .option("--run-id <id>", "Only claims from this eval run")
    .action(
      runAction(program, async (ctx: Ctx, cmdOpts: ListFilters & { runId?: string }) => {
        // The API requires a UUID here and answers anything else with a 400.
        if (cmdOpts.runId !== undefined && !UUID_RE.test(cmdOpts.runId.trim())) {
          throw new CliError(`Invalid --run-id: "${cmdOpts.runId}" is not a UUID.`, EXIT.USAGE, {
            code: "usage",
            hint: "Run ids come from `senso evals runs` or the output of a trigger.",
          });
        }
        const data = await apiRequest({
          path: "/org/evals/claims",
          params: { ...listParams(cmdOpts), run_id: cmdOpts.runId },
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emit(ctx, data, {
          columns: [
            "eval_claim_id",
            "eval_run_id",
            "verdict",
            "passed",
            "about_brand",
            "verifiable",
            "confidence",
            "claim_text",
          ],
        });
      }),
    );

  withTriggerOptions(
    evals
      .command("content <contentId>")
      .description(
        "Judge a saved content item — a knowledge-base document or a generated article — by its content id. Its latest saved version is what gets judged, and only items whose latest version is raw text can be: an uploaded file or a crawled page stores a pointer rather than text of its own and is a 422. Add --wait to poll until the run finishes.",
      ),
  ).action(
    runAction(program, async (ctx: Ctx, contentId: string, cmdOpts: TriggerOptions) => {
      const triggered = await apiRequest<{ eval_run_id?: string }>({
        method: "POST",
        path: "/org/evals/content",
        body: { ...triggerBody(cmdOpts), content_id: contentId },
        apiKey: ctx.apiKey,
        baseUrl: ctx.baseUrl,
      });

      const data =
        cmdOpts.wait && triggered.eval_run_id
          ? await waitForRun(triggered.eval_run_id, ctx)
          : triggered;
      finishTrigger(ctx, data, Boolean(cmdOpts.wait));
    }),
  );
}
