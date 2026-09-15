import { readFile } from "node:fs/promises";
import { Command } from "commander";
import { apiRequest } from "../lib/api-client.js";
import { parseEnumFlag, parseInstantFlag, parseIntFlag } from "../lib/enum-arg.js";
import { CliError, EXIT } from "../lib/errors.js";
import { apiExits, describeCommand, idExits } from "../lib/help.js";
import { parseId, type IdSpec } from "../lib/id-arg.js";
import { emit, type NextStep } from "../lib/output.js";
import type { ResourceRef } from "../lib/resource.js";
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
 *
 * A run is ASYNCHRONOUS, and the consequence of that is the thing this file is
 * most careful about: a trigger answers with a queued handle, `--wait` polls,
 * and a run can finish without a score. `gated` is the case that misleads —
 * exit 0, a run-shaped payload, no accuracy_pct and no band — so it is reported
 * as a warning in the envelope rather than only as a line on stderr that
 * `--output json` suppresses.
 */

const EVALUATORS = ["kb_accuracy", "brand_alignment"] as const;

/**
 * The lifecycle, as the API defines it (models/eval.go).
 *
 * Kept as meanings rather than a bare list because the set alone does not tell
 * a caller what to do: `gated` and `completed` are both terminal and both exit
 * 0, and only one of them carries a score.
 */
const RUN_STATUS_MEANING: Record<string, string> = {
  queued: "accepted, waiting for a judge",
  running: "the judge is working",
  completed: "finished with a score",
  gated:
    "a pre-check found nothing to judge, so the run ended at once with no model spend and NO score — accuracy_pct and band are absent",
  failed: "the judge never reached a score; error_code and error_message say why",
  canceled: "reserved by the API and not currently produced; treated as terminal so it cannot hang",
};

/** Bands for accuracy_pct, from the scoring defaults (evals/scoring.go). */
const BAND_MEANING: Record<string, string> = {
  green: "accuracy_pct at or above 90",
  yellow: "accuracy_pct at or above 70",
  red: "accuracy_pct below 70",
};

/** kb_accuracy's per-claim vocabulary. */
const KB_VERDICT_MEANING: Record<string, string> = {
  verified: "knowledge base evidence entails the claim",
  conflict: "knowledge base evidence contradicts it",
  unsupported: "searched, and nothing in the knowledge base settles it",
  not_verifiable: "subjective; excluded from the score rather than failed",
};

/** brand_alignment's per-rule vocabulary. */
const BRAND_VERDICT_MEANING: Record<string, string> = {
  pass: "the rule is followed",
  partial: "partly followed; suggested_fix carries replacement wording",
  fail: "the rule is broken",
  not_applicable: "the content never enters a situation the rule governs",
  ungraded: "the judge returned nothing usable for this rule; never counted as a pass",
};

/** Where a run id and a content id come from. Two different id spaces. */
const RUN_ID: IdSpec = {
  label: "<runId>",
  type: "Eval run",
  idField: "eval_run_id",
  list: "senso evals runs",
};

const RUN_ID_FLAG: IdSpec = { ...RUN_ID, label: "--run-id" };

const CONTENT_ID: IdSpec = {
  label: "<contentId>",
  type: "Content",
  idField: "content_id",
  list: "senso kb get <kb_node_id>",
};

function runResource(runId: string): ResourceRef {
  return { type: "Eval run", id: runId, idField: "eval_run_id", list: "senso evals runs" };
}

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
      // A poll can 404 too — the run id could belong to another organization —
      // and "Not found." mid-wait would say nothing about what was being polled.
      resource: runResource(runId),
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
  const runId = run.eval_run_id ?? "<runId>";
  const warnings: string[] = [];
  const next: NextStep[] = [];

  if (run.status === "gated") {
    // Terminal, exit 0, and carrying no score. Reported as a warning rather
    // than only as a line on stderr, because `--output json` suppresses stderr
    // and an absent accuracy_pct otherwise reads as a clean bill of health.
    warnings.push(
      "This run was gated: a pre-check found nothing to judge, so it ended with no model spend and produced NO score. accuracy_pct and band are absent.",
    );
  }
  if (!isFinished(run.status)) {
    next.push({ why: "Read the finished run", command: `senso evals get ${runId}` });
  }
  if (run.status === "completed" || run.status === "failed") {
    next.push({
      why: "Read every claim the score is built from",
      command: `senso evals claims --run-id ${runId}`,
    });
  }

  if (!ctx.quiet) {
    if (run.status === "failed") {
      log.error(`Eval run failed: ${run.error_message ?? "no reason given"}`);
      if (run.error_code) log.error(`Reason code: ${run.error_code}`);
    } else if (run.status === "gated") {
      log.warn("Eval run gated: the pre-check found nothing to judge, so no score was produced.");
    } else if (run.status === "completed") {
      log.success("Eval run completed.");
    } else {
      log.info(`Eval run ${run.status ?? "queued"}.`);
    }
  }

  if (waited && run.status === "failed") {
    // A caller who passed --wait asked for a verdict. A failed run has none, so
    // exit 0 with a run-shaped payload would read as one. Thrown BEFORE the
    // payload is emitted, leaving stdout empty on failure like every command.
    throw new CliError(
      `Eval run ${runId} failed${run.error_code ? ` (${run.error_code})` : ""}.`,
      EXIT.ERROR,
      { hint: `Read the full record with \`senso evals get ${runId}\`.` },
    );
  }

  emit(ctx, data, { columns: RUN_COLUMNS, warnings, next });
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
 * analytics and industries commands take. `parseInstantFlag` says so in its
 * message, because a caller who reasonably assumed a plain date should learn it
 * from exit 2 rather than from a 400.
 */
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

/** Every status and what it means, as help lines. */
function statusLines(): string[] {
  return Object.entries(RUN_STATUS_MEANING).map(([k, v]) => `  ${k} — ${v}`);
}

export function registerEvalsCommands(program: Command): void {
  const evals = program
    .command("evals")
    .description(
      "Judge text against your organization's ground truth. `kb_accuracy` verifies the factual claims a text makes about your brand against your knowledge base; `brand_alignment` grades it against your brand kit's writing rules. Every run records the claims it checked, the verdict and the evidence, so a score can be audited rather than trusted. Judge model spend is recorded on each run but is not billed against your credit balance. Typical loop: `evals evaluators` to see what can run, `evals text --wait` or `evals content --wait` to judge something, then `evals claims --run-id <id>` for the grain the score is built from.",
    );

  describeCommand(
    evals
      .command("evaluators")
      .description(
        "List the evaluators available to this organization, with the version each one is currently on. Use `latest_version` here to pin `--evaluator-version` on a trigger.",
      ),
    {
      returns: [
        "key — what to pass to --evaluator: kb_accuracy or brand_alignment",
        "latest_version — what to pass to --evaluator-version to pin a run",
        "evaluation_unit — what one judged item is (a claim, a rule)",
        "scope — what the evaluator reads: the knowledge base, or the brand kit",
      ],
      exitCodes: { ...apiExits, 3: "the key lacks read access, or evals are not enabled here" },
      examples: [{ comment: "What can run, and at what version", command: "senso evals evaluators --output json" }],
      seeAlso: ["senso evals text", "senso evals content"],
    },
  ).action(
    runAction(program, async (ctx: Ctx) => {
      const data = await apiRequest({
        path: "/org/evals/evaluators",
        apiKey: ctx.apiKey,
        baseUrl: ctx.baseUrl,
      });
      emit(ctx, data, {
        columns: ["key", "display_name", "evaluation_unit", "scope", "latest_version"],
        empty: "evaluators",
        emptyHint: "No evaluator is enabled for this organization. This is a deployment setting, not something a flag can widen.",
      });
    }),
  );

  describeCommand(
    withTriggerOptions(
      evals
        .command("text")
        .description(
          "Judge text you supply. Pass it with --text, or --text-file to read it from a file. Returns straight away with a run handle; add --wait to poll until the run finishes and print the finished run instead.",
        ),
    )
      .option("--text <text>", "The text to judge. Mutually exclusive with --text-file")
      .option("--text-file <path>", "Read the text to judge from a file. Mutually exclusive with --text")
      .option("--title <title>", "Optional title, stored with the run's subject (max 255 chars)"),
    {
      returns: [
        "eval_run_id — the id `evals get` and `evals claims --run-id` take",
        "status — one of:",
        ...statusLines(),
        "accuracy_pct — 0-100, absent unless status is completed",
        `band — ${Object.entries(BAND_MEANING).map(([k, v]) => `${k} (${v})`).join("; ")}`,
        "claims_scored / claims_total — the denominator behind the score; they differ because not_verifiable claims are excluded rather than failed",
      ],
      exitCodes: {
        ...apiExits,
        1: "the API refused, or --wait was passed and the run ended `failed`",
        2: "--text and --text-file both given or both omitted, empty text, or a flag over its length limit",
      },
      notes: [
        "A `gated` run is terminal, exits 0 and has NO score. The envelope carries a warning saying so; do not read an absent accuracy_pct as a pass.",
        "--wait polls rather than holding the connection: a judge run that took 18 seconds once took over 30 the next time, and the request budget is 30.",
      ],
      examples: [
        { comment: "Judge a claim and wait for the verdict", command: `senso evals text --text "Acme was founded in 1999" --wait --output json` },
        { comment: "Grade a draft against the brand kit", command: "senso evals text --text-file draft.md --evaluator brand_alignment --wait" },
      ],
      seeAlso: ["senso evals get <runId>", "senso evals claims --run-id <runId>"],
    },
  ).action(
    runAction(
      program,
      async (
        ctx: Ctx,
        cmdOpts: TriggerOptions & { text?: string; textFile?: string; title?: string },
      ) => {
        if ((cmdOpts.text === undefined) === (cmdOpts.textFile === undefined)) {
          throw new CliError("Pass exactly one of --text or --text-file.", EXIT.USAGE, {
            code: "usage",
            field: "--text",
            hint: "--text takes the text itself; --text-file reads it from a path.",
          });
        }
        if (cmdOpts.title !== undefined && cmdOpts.title.length > 255) {
          throw new CliError(
            `Invalid --title: ${String(cmdOpts.title.length)} characters, the maximum is 255.`,
            EXIT.USAGE,
            { code: "usage", field: "--title" },
          );
        }

        let text = cmdOpts.text;
        if (cmdOpts.textFile !== undefined) {
          try {
            text = await readFile(cmdOpts.textFile, "utf-8");
          } catch (err) {
            throw new CliError(`Cannot read --text-file: ${cmdOpts.textFile}`, EXIT.USAGE, {
              code: "usage",
              field: "--text-file",
              received: cmdOpts.textFile,
              hint: "Paths are resolved relative to the current directory.",
              cause: err,
            });
          }
        }
        // The API answers an empty string with a 400 and whitespace with a
        // 422; neither is worth a round trip to discover.
        if (text === undefined || text.trim().length === 0) {
          throw new CliError("The text to judge is empty.", EXIT.USAGE, {
            code: "usage",
            field: cmdOpts.textFile === undefined ? "--text" : "--text-file",
          });
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

  describeCommand(
    withListOptions(
      evals
        .command("runs")
        .description(
          "List eval runs, newest first. Each row carries the score and the claim counts behind it, so a run can be read without opening it.",
        ),
    ),
    {
      returns: [
        "eval_run_id — the id `evals get` takes",
        "status — one of:",
        ...statusLines(),
        "accuracy_pct, band, claims_scored, claims_total — the score and its denominator",
      ],
      exitCodes: { ...apiExits, 2: "--from or --to is not an RFC 3339 instant, or a page flag is out of range" },
      notes: [
        "--from and --to are RFC 3339 instants here (2026-09-01T00:00:00Z), NOT the YYYY-MM-DD dates `senso analytics` and `senso industries` take.",
      ],
      examples: [
        { comment: "The most recent runs", command: "senso evals runs --limit 10 --output json" },
        { comment: "Everything judged since a point in time", command: "senso evals runs --from 2026-09-01T00:00:00Z" },
      ],
      seeAlso: ["senso evals get <runId>", "senso evals claims"],
    },
  ).action(
    runAction(program, async (ctx: Ctx, cmdOpts: ListFilters) => {
      const data = await apiRequest({
        path: "/org/evals/runs",
        params: listParams(cmdOpts),
        apiKey: ctx.apiKey,
        baseUrl: ctx.baseUrl,
      });
      emit(ctx, data, {
        columns: RUN_COLUMNS,
        empty: "eval runs",
        emptyHint: "Nothing has been judged in this window. Judge something with `senso evals text --text \"...\"`.",
      });
    }),
  );

  describeCommand(
    evals
      .command("get")
      .description(
        "Get one eval run in full — every claim it checked, the verdict, the evidence behind it, and what the judge searched for. This is the auditable form of a score.",
      )
      .argument("<runId>", "An eval_run_id, from `senso evals runs` or from a trigger's output"),
    {
      returns: [
        "status — one of:",
        ...statusLines(),
        `claims[].verdict — for kb_accuracy: ${Object.keys(KB_VERDICT_MEANING).join(", ")}; for brand_alignment: ${Object.keys(BRAND_VERDICT_MEANING).join(", ")}`,
        "claims[].passed — whether this claim counted toward the score",
        "claims[].evidence — the quote and reasoning the judge relied on",
      ],
      exitCodes: { ...idExits, 4: "no eval run with this id in your organization" },
      examples: [{ comment: "Audit a score", command: "senso evals get <runId> --output json" }],
      seeAlso: ["senso evals claims --run-id <runId>"],
    },
  ).action(
    runAction(program, async (ctx: Ctx, rawRunId: string) => {
      const runId = parseId(rawRunId, RUN_ID);
      const data = await apiRequest({
        path: `/org/evals/runs/${encodeURIComponent(runId)}`,
        resource: runResource(runId),
        apiKey: ctx.apiKey,
        baseUrl: ctx.baseUrl,
      });
      emit(ctx, data, {
        columns: RUN_COLUMNS,
        next: [
          {
            why: "Read the claims as rows rather than nested under the run",
            command: `senso evals claims --run-id ${runId}`,
          },
        ],
      });
    }),
  );

  describeCommand(
    withListOptions(
      evals
        .command("claims")
        .description(
          "List the individual claims evaluators have judged, across runs. This is the grain a score is built from: each row carries the claim, the verdict, whether it counted toward the score, and the evidence the judge relied on. Narrow to one run with --run-id.",
        ),
    ).option("--run-id <id>", "Only claims from this eval run (an eval_run_id from `senso evals runs`)"),
    {
      returns: [
        "eval_claim_id / eval_run_id — the claim, and the run it belongs to",
        `verdict — for kb_accuracy: ${Object.entries(KB_VERDICT_MEANING).map(([k, v]) => `${k} (${v})`).join("; ")}`,
        `verdict — for brand_alignment: ${Object.entries(BRAND_VERDICT_MEANING).map(([k, v]) => `${k} (${v})`).join("; ")}`,
        "passed — whether it counted toward the score; a not_verifiable claim is excluded, not failed",
        "about_brand, verifiable, confidence — why the judge did or did not score it",
      ],
      exitCodes: { ...apiExits, 2: "--run-id is not a UUID, or a date flag is not an RFC 3339 instant" },
      examples: [{ comment: "Every claim behind one score", command: "senso evals claims --run-id <runId> --output json" }],
      seeAlso: ["senso evals get <runId>"],
    },
  ).action(
    runAction(program, async (ctx: Ctx, cmdOpts: ListFilters & { runId?: string }) => {
      // The API requires a UUID here and answers anything else with a 400.
      const runId =
        cmdOpts.runId === undefined ? undefined : parseId(cmdOpts.runId, RUN_ID_FLAG);
      const data = await apiRequest({
        path: "/org/evals/claims",
        params: { ...listParams(cmdOpts), run_id: runId },
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
        empty: "claims",
        emptyHint:
          runId === undefined
            ? "Nothing has been judged in this window."
            : `That run judged nothing. A gated run produces no claims: check its status with \`senso evals get ${runId}\`.`,
      });
    }),
  );

  describeCommand(
    withTriggerOptions(
      evals
        .command("content")
        .description(
          "Judge a saved content item by its content id. Its latest saved version is what gets judged. Add --wait to poll until the run finishes.",
        )
        .argument("<contentId>", "A content_id — the `content_id` on a `senso kb get` node, or an id from `senso content verification`. NOT a kb_node_id"),
    ),
    {
      returns: [
        "eval_run_id — the id `evals get` takes",
        "status — one of:",
        ...statusLines(),
      ],
      exitCodes: {
        ...idExits,
        1: "the API refused, or --wait was passed and the run ended `failed`",
        2: "<contentId> is not a UUID",
        4: "no content with this id in your organization",
      },
      notes: [
        "Only an item whose latest version is raw text can be judged. An uploaded file or a crawled page stores a pointer rather than text of its own, and the API answers 422.",
        "This takes a content_id, not a kb_node_id. They are both UUIDs and are not interchangeable.",
      ],
      examples: [{ comment: "Check a stored document against the knowledge base", command: "senso evals content <contentId> --wait --output json" }],
      seeAlso: ["senso kb get <kb_node_id>", "senso evals get <runId>"],
    },
  ).action(
    runAction(program, async (ctx: Ctx, rawContentId: string, cmdOpts: TriggerOptions) => {
      const contentId = parseId(rawContentId, CONTENT_ID);
      const triggered = await apiRequest<{ eval_run_id?: string }>({
        method: "POST",
        path: "/org/evals/content",
        body: { ...triggerBody(cmdOpts), content_id: contentId },
        resource: { type: "Content", id: contentId, idField: "content_id" },
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
