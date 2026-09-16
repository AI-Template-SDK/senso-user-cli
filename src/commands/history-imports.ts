import { Command } from "commander";
import { ApiError, apiRequest } from "../lib/api-client.js";
import { CliError, toCliError } from "../lib/errors.js";
import { apiExits, describeCommand, idExits } from "../lib/help.js";
import { parseId } from "../lib/id-arg.js";
import { emit, type NextStep } from "../lib/output.js";
import { runAction, type Ctx } from "../lib/run-action.js";

/**
 * History-import jobs — the run history `senso industries import-prompts`
 * starts copying in the background.
 *
 * The import call returns before the copying is done, so these are how a caller
 * finds out whether it actually got any data. Two facts drive everything in
 * this file, and both are in the API's own DTO:
 *
 *   - A `completed` import may have copied NOTHING. A job that matched no
 *     prompts completes successfully having imported zero runs, so an agent
 *     polling until status == completed and then reporting success is exactly
 *     the failure this group exists to prevent. `get` says so in its help AND
 *     emits a warning when it happens.
 *   - `failed` is NOT terminal. A failed job is retried and can return to
 *     `running` on its own, so an agent that stops on `failed` gives up early.
 */

/** This group's id space. Not a prompt id, and not a geo_question_id. */
const HISTORY_IMPORT = {
  type: "History import",
  idField: "import_id",
  list: "senso history-imports list",
} as const;

/**
 * The four statuses, spelled out wherever a payload carries one.
 *
 * An agent that reads `"status": "failed"` and cannot see that failed is
 * retried has no way to know whether to poll or to give up.
 */
const STATUS_RETURNS = [
  "status — the job state, one of:",
  "  pending    accepted; copying has not started. Keep polling.",
  "  running    copying. Keep polling.",
  "  completed  the job finished. NOT the same as “it got data” — read historic_runs_imported.",
  "  failed     THIS ATTEMPT failed. Not terminal: failed jobs are retried and can return to running, so poll again before giving up.",
];

/** The outcome fields, and why their absence is not a zero. */
const OUTCOME_RETURNS = [
  "days — how many days of history the job is copying.",
  "prompts_count — prompts the job matched. NULL until the job completes; null is not 0.",
  "historic_runs_imported — runs actually copied. NULL until the job completes. 0 on a COMPLETED job means the import found nothing to copy — this, not the status, is the test for whether history arrived.",
  "error — always present, null unless the job failed. When set it is always the same fixed sentence; the real detail is internal, so there is nothing more to extract from it.",
  "created_at / updated_at / completed_at — completed_at is null until the job finishes.",
];

/** One job, as much of it as the rendering below needs. */
interface HistoryImportJob {
  id?: string;
  status?: string;
  prompts_count?: number | null;
  historic_runs_imported?: number | null;
}

/**
 * The ledger is an external integration, and its two failures are precise
 * answers that the generic 5xx branch would replace with "retry shortly" —
 * advice that can never work for a deployment that has no ledger at all.
 */
function refineLedger(err: unknown): CliError {
  const mapped = toCliError(err);
  if (!(err instanceof ApiError)) return mapped;
  if (err.status === 501) {
    return new CliError(
      "History imports are not available on this Senso deployment: it has no history-import integration.",
      mapped.exitCode,
      {
        code: mapped.code,
        status: 501,
        details: mapped.details,
        request: mapped.request,
        hint: "Nothing to retry. Your prompts are unaffected — check them with `senso prompts list`.",
        cause: err,
      },
    );
  }
  if (err.status === 502) {
    return new CliError("Senso could not reach the history-import ledger.", mapped.exitCode, {
      code: mapped.code,
      status: 502,
      details: mapped.details,
      request: mapped.request,
      hint: "Retry in a minute; the prompts themselves are unaffected.",
      cause: err,
    });
  }
  return mapped;
}

/** True when a finished job copied nothing — the caveat, as a predicate. */
function completedEmpty(job: HistoryImportJob): boolean {
  return job.status === "completed" && (job.historic_runs_imported ?? 0) === 0;
}

/** What to do next about one job, given the state it is in. */
function pollSteps(job: HistoryImportJob): NextStep[] {
  const id = job.id;
  if (id === undefined) return [];
  if (job.status === "completed") {
    return completedEmpty(job)
      ? [
          {
            why: "Nothing was copied — check which prompts this organization actually holds",
            command: "senso prompts list",
          },
        ]
      : [
          {
            why: "The back-filled history is now in the analytics window",
            command: "senso analytics summary",
          },
        ];
  }
  if (job.status === "failed") {
    return [
      {
        why: "Failed is not terminal — failed jobs are retried, so poll again before giving up",
        command: `senso history-imports get ${id}`,
      },
    ];
  }
  return [
    {
      why: "Poll until status is completed AND historic_runs_imported is above 0",
      command: `senso history-imports get ${id}`,
    },
  ];
}

export function registerHistoryImportsCommands(program: Command): void {
  const historyImports = program
    .command("history-imports")
    .description(
      "Read-only view of the run-history import jobs that back-fill this organization's prompts with the history already collected for its industry. Nothing here starts or cancels a job — the only thing that starts one is `senso industries import-prompts`. A `completed` import may still have copied NOTHING, so read prompts_count and historic_runs_imported rather than the status on its own, and remember that `failed` is not terminal: failed jobs are retried and can return to running. Both commands require the GEO product. Workflow: industries import-prompts → history-imports get <import_id> (until completed with runs > 0) → senso analytics.",
    );

  describeCommand(
    historyImports
      .command("list")
      .description(
        "List this organization's 50 most recently started history-import jobs, newest first.",
      )
      .action(
        runAction(program, async (ctx: Ctx) => {
          let data: { imports?: HistoryImportJob[] };
          try {
            data = await apiRequest<{ imports?: HistoryImportJob[] }>({
              path: "/org/history-imports",
              apiKey: ctx.apiKey,
              baseUrl: ctx.baseUrl,
            });
          } catch (err) {
            throw refineLedger(err);
          }
          const jobs = data.imports ?? [];
          const hollow = jobs.filter((j) => completedEmpty(j));
          const first = jobs[0];
          emit(ctx, data, {
            columns: [
              "id",
              "status",
              "days",
              "prompts_count",
              "historic_runs_imported",
              "created_at",
              "completed_at",
            ],
            warnings:
              hollow.length > 0
                ? [
                    `${String(hollow.length)} completed import(s) copied no historic runs: ${hollow
                      .map((j) => j.id ?? "?")
                      .join(", ")}. A completed job that matched no prompts still reports success.`,
                  ]
                : [],
            empty: "history imports",
            emptyHint:
              "Nothing has ever been imported for this organization. Imports are started by `senso industries import-prompts <industry> --prompt-ids <id>,<id>`.",
            next:
              first?.id === undefined
                ? []
                : [
                    {
                      why: "Read one job in full",
                      command: `senso history-imports get ${first.id}`,
                    },
                  ],
          });
        }),
      ),
    {
      returns: [
        "imports[] — newest first.",
        "imports[].id — the import_id. Pass it to `senso history-imports get`.",
        ...STATUS_RETURNS.map((line) => (line.startsWith(" ") ? line : `imports[].${line}`)),
        ...OUTCOME_RETURNS.map((line) => `imports[].${line}`),
      ],
      exitCodes: {
        ...apiExits,
        1: "the API refused, including 501 when this deployment has no history-import integration and 502 when Senso could not reach the ledger",
        3: "the organization does not have the GEO product, the key lacks read:prompt, or the key was rejected",
      },
      notes: [
        "Not paginated and not filterable: the window is fixed at the 50 most recent jobs, and the payload carries no total. An organization accumulates roughly one import per activation, so 50 covers any realistic history.",
        "prompts_count and historic_runs_imported are in the default columns on purpose: a `completed` job with 0 runs imported copied nothing, and the status alone never says so.",
      ],
      examples: [
        { command: "senso history-imports list" },
        {
          comment: "The completed jobs that actually copied nothing",
          command:
            "senso history-imports list --output json | jq -r '.data.imports[] | select(.status==\"completed\" and (.historic_runs_imported // 0) == 0) | .id'",
        },
      ],
      seeAlso: [
        "senso history-imports get",
        "senso industries import-prompts",
        "senso prompts list",
      ],
    },
  );

  describeCommand(
    historyImports
      .command("get")
      .description(
        "Get one run-history import job. This is the command to poll after `senso industries import-prompts` — and status alone is not the answer: a completed job may have copied nothing, and a failed one may still be retried.",
      )
      .argument(
        "<importId>",
        "An import_id UUID: `history_import.import_id` from `senso industries import-prompts`, or `id` from `senso history-imports list`. NOT a geo_question_id and NOT an industry prompt id",
      )
      .action(
        runAction(program, async (ctx: Ctx, importIdArg: string) => {
          const importId = parseId(importIdArg, { label: "<importId>", ...HISTORY_IMPORT });
          let data: HistoryImportJob;
          try {
            data = await apiRequest<HistoryImportJob>({
              path: `/org/history-imports/${importId}`,
              resource: { ...HISTORY_IMPORT, id: importId },
              apiKey: ctx.apiKey,
              baseUrl: ctx.baseUrl,
            });
          } catch (err) {
            throw refineLedger(err);
          }
          const job = { ...data, id: data.id ?? importId };
          const pending = job.status === "pending" || job.status === "running";
          emit(ctx, data, {
            warnings: [
              ...(completedEmpty(job)
                ? [
                    "Completed, but NO historic runs were imported: the job matched no prompts. This is not success — the analytics window will still open empty. Check what this organization holds with `senso prompts list`.",
                  ]
                : []),
              ...(job.status === "failed"
                ? [
                    "This attempt failed, and `failed` is not terminal: failed imports are retried and can return to running. Poll again before giving up. The `error` field is always the same fixed sentence and carries no extra detail.",
                  ]
                : []),
              ...(pending
                ? [
                    "prompts_count and historic_runs_imported are null until the job completes — a blank value here is “not yet known”, not zero.",
                  ]
                : []),
            ],
            next: pollSteps(job),
          });
        }),
      ),
    {
      returns: [
        "id — the import_id you passed.",
        ...STATUS_RETURNS,
        ...OUTCOME_RETURNS,
        "The success test is status == completed AND historic_runs_imported > 0. Nothing weaker is a success: a completed import that matched no prompts copied zero runs and still reports completed.",
      ],
      exitCodes: {
        ...idExits,
        1: "the API refused, including 501 when this deployment has no history-import integration and 502 when Senso could not reach the ledger",
        2: "<importId> is not a UUID",
        3: "the organization does not have the GEO product, the key lacks read:prompt, or the key was rejected",
        4: "no import with this id belongs to this organization",
      },
      notes: [
        "A `completed` job may have copied NOTHING. Read historic_runs_imported; the CLI warns when it is 0 on a completed job.",
        "`failed` is NOT terminal: the job is retried and can return to running on its own. Poll again rather than reporting a failure.",
        "Every status, including failed, exits 0 — the command succeeded in reading the job. Branch on the payload, not on the exit code.",
      ],
      examples: [
        { command: "senso history-imports get 5e4d3c2b-1a09-4f8e-9d7c-6b5a4f3e2d10" },
        {
          comment: "Poll correctly: terminal AND it actually got data",
          command:
            "until senso history-imports get 5e4d3c2b-1a09-4f8e-9d7c-6b5a4f3e2d10 --output json | jq -e '.data.status==\"completed\" and (.data.historic_runs_imported // 0) > 0' >/dev/null; do sleep 10; done",
        },
      ],
      seeAlso: [
        "senso history-imports list",
        "senso industries import-prompts",
        "senso prompts list",
        "senso analytics summary",
      ],
    },
  );
}
