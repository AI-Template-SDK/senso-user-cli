import { Command } from "commander";
import { apiRequest } from "../lib/api-client.js";
import { usageError } from "../lib/errors.js";
import { apiExits, describeCommand } from "../lib/help.js";
import { emit } from "../lib/output.js";
import { parseJsonFlag } from "../lib/json-arg.js";
import { runAction } from "../lib/run-action.js";

/** 0 = Sunday, the way GET/PUT /org/run-schedule numbers the week. */
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * The run-model names PUT /org/run-models accepts.
 *
 * The authoritative list is the enabled, scheduler-supported model_registry
 * rows plus legacyModelAliases (senso-api internal/services/model_validation.go),
 * and `senso run-config model-options` serves it. These are the seeded values:
 * the six the picker offers, plus `gpt`, which hiddenPickerModels keeps out of
 * the picker while every write path still accepts it.
 */
const RUN_MODELS = [
  "chatgpt",
  "perplexity",
  "gemini",
  "grok",
  "google_ai_overviews",
  "claude",
  "gpt",
] as const;

/**
 * The senso-workflows spellings the same endpoint accepts, and what they mean.
 *
 * Kept separate from RUN_MODELS so the error message can offer the canonical
 * name rather than an alias: the API stores the canonical spelling either way.
 */
const RUN_MODEL_ALIASES: Record<string, string> = {
  aioverview: "google_ai_overviews",
  "claude-sonnet-4-6": "claude",
  "gpt-4.1": "gpt",
};

/** The seeded scheduler catalog (migration 000111), for the help text. */
const SCHEDULER_CATALOG = [
  "brightdata/chatgpt",
  "brightdata/grok",
  "brightdata/perplexity",
  "brightdata/gemini",
  "brightdata_serp/google_ai_overviews",
  "anthropic/claude",
  "openai/gpt",
];

/**
 * The run schedule as days of the week, checked before it is sent.
 *
 * A day outside 0-6 is reported by the API against the whole body rather than
 * against the value; naming the offending value here does better. The empty
 * array is rejected too: dto.SetOrgRunScheduleRequest marks Schedule
 * `required`, which fails on a zero-length slice, so `{"schedule":[]}` used to
 * pass the client check and come back as a 400 that read like a CLI bug.
 */
function parseSchedule(schedule: unknown): number[] {
  if (!Array.isArray(schedule)) {
    throw usageError('--data must contain a "schedule" array.', {
      field: "schedule",
      hint: "Example: --data '{\"schedule\":[1,3,5]}' — days 0-6 (Sunday-Saturday).",
    });
  }
  if (schedule.length === 0) {
    throw usageError('"schedule" must name at least one day.', {
      field: "schedule",
      received: "[]",
      hint: "The API cannot store an empty schedule, so runs cannot be turned off from this command. Set the days you do want, e.g. --data '{\"schedule\":[1]}'.",
    });
  }
  const days: number[] = [];
  for (const day of schedule as unknown[]) {
    if (typeof day !== "number" || !Number.isInteger(day) || day < 0 || day > 6) {
      throw usageError(`Invalid schedule day: ${JSON.stringify(day)}.`, {
        field: "schedule",
        received: JSON.stringify(day),
        hint: "Days are whole numbers 0-6 (0=Sunday, 6=Saturday).",
      });
    }
    if (days.includes(day)) {
      throw usageError(`Duplicate schedule day: ${String(day)} (${DAY_NAMES[day] ?? ""}).`, {
        field: "schedule",
        received: String(day),
        hint: "List each day once; the schedule is a set of days, not a count of runs.",
      });
    }
    days.push(day);
  }
  return days;
}

/** "1 (Monday), 3 (Wednesday)" — the numbers the API returns, made readable. */
function describeDays(schedule: unknown): string | undefined {
  if (!Array.isArray(schedule)) return undefined;
  const days = schedule.filter((d): d is number => typeof d === "number");
  if (days.length === 0) return undefined;
  return days.map((d) => `${String(d)} (${DAY_NAMES[d] ?? "?"})`).join(", ");
}

/** The `models` array both write endpoints take, checked for shape. */
function parseModelList(models: unknown, example: string): string[] {
  if (!Array.isArray(models) || models.length === 0) {
    throw usageError('--data must contain a non-empty "models" array.', {
      field: "models",
      hint: `Example: --data '{"models":${example}}'`,
    });
  }
  return (models as unknown[]).map((model) => {
    if (typeof model !== "string" || model.trim() === "") {
      throw usageError(`Invalid model: ${JSON.stringify(model)}.`, {
        field: "models",
        received: JSON.stringify(model),
        hint: `Every entry is a non-empty string. Example: --data '{"models":${example}}'`,
      });
    }
    return model.trim();
  });
}

/**
 * Run-model names, checked against the registry this CLI knows about.
 *
 * The registry is configurable, so `senso run-config model-options` — not this
 * list — is authoritative. Checking here still pays: the API's rejection is a
 * 400 that reads like a server problem, and a typo like "gpt5" is by far the
 * likeliest failure. The hint names the discovery command so a caller who hits
 * a model this CLI has not heard of knows where to look.
 */
function parseRunModels(models: unknown): string[] {
  return parseModelList(models, '["chatgpt","claude"]').map((model) => {
    const normalized = model.toLowerCase();
    if (RUN_MODELS.includes(normalized as (typeof RUN_MODELS)[number])) return normalized;
    const alias = RUN_MODEL_ALIASES[normalized];
    if (alias !== undefined) return alias;
    throw usageError(`Invalid model: "${model}".`, {
      field: "models",
      received: model,
      allowed: RUN_MODELS,
      hint: `Run \`senso run-config model-options\` for the authoritative list. Accepted aliases: ${Object.keys(RUN_MODEL_ALIASES).join(", ")}. For the scheduler's provider/model ids, use \`senso run-config set-scheduler-models\`.`,
    });
  });
}

/**
 * Scheduler model ids, checked for the shape the registry resolves.
 *
 * The catalog itself is configurable and no endpoint serves it, so the values
 * are not checked against a fixed set — only the provider/model form is, which
 * catches the one mistake an agent actually makes: passing the bare name that
 * `set-models` takes.
 */
function parseSchedulerModels(models: unknown): string[] {
  return parseModelList(models, '["anthropic/claude"]').map((model) => {
    const [provider, name, ...rest] = model.split("/");
    if (!provider || !name || rest.length > 0) {
      throw usageError(`Invalid model: "${model}".`, {
        field: "models",
        received: model,
        allowed: SCHEDULER_CATALOG,
        hint: `Scheduler models are provider/model ids, e.g. ${SCHEDULER_CATALOG.join(", ")}. Bare names like "claude" belong to \`senso run-config set-models\`.`,
      });
    }
    return model;
  });
}

export function registerRunConfigCommands(program: Command): void {
  const rc = program
    .command("run-config")
    .description(
      "Configure which AI models answer this organization's prompts, and on which days. Two model lists live here, and they are different vocabularies for the same models. Run models (use these) are bare names — chatgpt, perplexity, gemini, grok, google_ai_overviews, claude, gpt — read with `models`, written with `set-models`, discovered with `model-options`. Scheduler models (advanced) are registry ids of the form provider/model, such as anthropic/claude, read with `scheduler-models` and written with `set-scheduler-models`. They are linked in ONE direction: `set-models` also rewrites the scheduler opt-in, so the two stay consistent, while `set-scheduler-models` leaves the run-model list alone and the two reads can then disagree. Prefer `set-models`. Workflow: model-options → set-models → set-schedule → models / schedule to confirm. The read commands need the GEO product; the write commands need the update:org permission.",
    );

  describeCommand(
    rc
      .command("models")
      .description(
        "The AI models currently configured to answer this organization's prompts. An empty list means no runs will be produced at all.",
      ),
    {
      returns: [
        "models[].name — the model that runs: chatgpt | perplexity | gemini | grok | google_ai_overviews | claude | gpt. This is the value `senso run-config set-models` takes",
        "models[].geo_model_id — the stored row's id. No command takes it",
        "models[].created_at, updated_at — when the model was added to the organization",
      ],
      exitCodes: {
        ...apiExits,
        3: "no API key, or the organization does not have the GEO product",
      },
      examples: [
        { command: "senso run-config models" },
        { command: "senso run-config models --output json | jq -r '.data.models[].name'" },
      ],
      notes: [
        "`senso run-config set-scheduler-models` changes the scheduler's list without changing this one, so after using it the two reads can disagree.",
      ],
      seeAlso: [
        "senso run-config model-options",
        "senso run-config set-models",
        "senso run-config schedule",
      ],
    },
  ).action(
    runAction(program, async (ctx) => {
      const data = await apiRequest({
        path: "/org/run-models",
        apiKey: ctx.apiKey,
        baseUrl: ctx.baseUrl,
      });
      emit(ctx, data, {
        columns: ["name", "geo_model_id", "created_at"],
        empty: "run models",
        emptyHint:
          'No models are configured, so no runs will be produced. Set them with `senso run-config set-models --data \'{"models":["chatgpt"]}\'`.',
      });
    }),
  );

  describeCommand(
    rc
      .command("set-models")
      .description(
        "Replace the AI models that answer this organization's prompts. Any model not listed is removed. This also rewrites the scheduler opt-in (`run-config scheduler-models`) to match.",
      )
      .requiredOption(
        "--data <json>",
        `JSON: { "models": ["chatgpt", "claude"] }. At least one name, from: ${RUN_MODELS.join(", ")}. The aliases ${Object.keys(RUN_MODEL_ALIASES).join(", ")} are accepted too.`,
      ),
    {
      returns: [
        "models[].name — the models now configured, after the replace",
        `The accepted names come from the model registry; \`senso run-config model-options\` is the authoritative list, and this CLI checks against ${RUN_MODELS.join(", ")} plus the aliases ${Object.keys(RUN_MODEL_ALIASES).join(", ")}`,
      ],
      exitCodes: {
        ...apiExits,
        2: '--data is not JSON, has no "models", the array is empty, or a name is not one of the accepted models',
        3: "no API key, or (JWT callers) no update:org permission",
        1: "the API refused the name. Its error carries valid_models and suggestions in error.details",
      },
      examples: [
        {
          command:
            'senso run-config set-models --data \'{"models":["chatgpt","claude","perplexity"]}\'',
        },
        {
          comment: "Discover the names first",
          command:
            "senso run-config model-options --output json | jq -r '.data.valid_models[].name'",
        },
      ],
      notes: ["The write is all-or-nothing: nothing is stored if any name is rejected."],
      seeAlso: [
        "senso run-config model-options",
        "senso run-config models",
        "senso run-config set-scheduler-models",
      ],
    },
  ).action(
    runAction(program, async (ctx, cmdOpts: { data: string }) => {
      const body = parseJsonFlag<{ models?: unknown }>(cmdOpts.data, { required: ["models"] });
      const models = parseRunModels(body.models);
      const data = await apiRequest({
        method: "PUT",
        path: "/org/run-models",
        body: { models },
        apiKey: ctx.apiKey,
        baseUrl: ctx.baseUrl,
      });
      emit(ctx, data, {
        columns: ["name", "geo_model_id", "created_at"],
        empty: "run models",
        warnings: [
          "This replaced the whole set: models that were configured and are not in the list are gone.",
          "It also rewrote the scheduler opt-in to match — see `senso run-config scheduler-models`.",
        ],
      });
    }),
  );

  describeCommand(
    rc
      .command("model-options")
      .description(
        "The model names `run-config set-models` accepts, with their display labels. Global rather than per-organization: read them before writing, so an unsupported name does not cost a round trip.",
      ),
    {
      returns: [
        "valid_models[].name — the value to put in `set-models --data`",
        "valid_models[].display_name — the label Senso shows for it",
        'scope — which run surface these names apply to; always "org" here, and visible under --output json. Networks spell the same models differently',
      ],
      exitCodes: {
        ...apiExits,
        3: "no API key, or the organization does not have the GEO product",
      },
      examples: [
        { command: "senso run-config model-options" },
        {
          command:
            "senso run-config model-options --output json | jq -r '.data.valid_models[].name'",
        },
      ],
      notes: [
        "Not exhaustive on purpose: `gpt` (the direct OpenAI API model) is accepted by set-models but deliberately not offered here, and the aliases aioverview, claude-sonnet-4-6 and gpt-4.1 are accepted too. A name in `run-config models` that is missing from this list is why.",
      ],
      seeAlso: ["senso run-config set-models", "senso run-config models"],
    },
  ).action(
    runAction(program, async (ctx) => {
      const data = await apiRequest<{
        scope?: string;
        valid_models?: { name?: string; display_name?: string }[];
      }>({
        path: "/org/run-models/options",
        apiKey: ctx.apiKey,
        baseUrl: ctx.baseUrl,
      });
      // The rows are passed explicitly because the payload pairs `valid_models`
      // with a `scope` scalar: the shared renderer treats a list plus a scalar
      // as a list only for the list keys it knows, and this endpoint's is not
      // one of them. Without this the discovery command for `set-models` — the
      // one command whose whole job is to be readable — printed the options as
      // a single JSON line.
      emit(ctx, data, {
        rows: data.valid_models ?? [],
        columns: ["name", "display_name"],
        empty: "model options",
        emptyHint:
          "No models are offered for org runs in this deployment. Check with your Senso partner.",
        next: [
          {
            why: "Configure the models that answer your prompts",
            command: `senso run-config set-models --data '{"models":["chatgpt","claude"]}'`,
          },
        ],
      });
    }),
  );

  describeCommand(
    rc
      .command("scheduler-models")
      .description(
        "The registry models this organization is opted into for scheduled runs. `run-config set-models` rewrites this list to match the run models, so normally the two agree.",
      ),
    {
      returns: [
        'models[].provider + "/" + models[].model — the identifier `set-scheduler-models` takes, e.g. anthropic/claude',
        "models[].execution_mode — batch_async: answered in a batch, hours of latency. single_sync: answered one request at a time",
        "models[].adapter_key — which integration runs it (bd_dataset, bd_serp, anthropic, openai)",
        "models[].id — the registry row id. No command takes it",
      ],
      exitCodes: {
        ...apiExits,
        3: "no API key, or the organization does not have the GEO product",
      },
      examples: [
        { command: "senso run-config scheduler-models" },
        {
          comment: "The ids set-scheduler-models takes",
          command:
            "senso run-config scheduler-models --output json | jq -r '.data.models[] | .provider + \"/\" + .model'",
        },
      ],
      notes: [
        "An empty list means the scheduler will run nothing for this organization.",
        "No endpoint serves the full catalog, so this and the error from a rejected write are the only sources of valid ids.",
      ],
      seeAlso: ["senso run-config set-scheduler-models", "senso run-config models"],
    },
  ).action(
    runAction(program, async (ctx) => {
      const data = await apiRequest({
        path: "/org/scheduler-models",
        apiKey: ctx.apiKey,
        baseUrl: ctx.baseUrl,
      });
      emit(ctx, data, {
        columns: ["provider", "model", "execution_mode", "adapter_key", "id"],
        empty: "scheduler models",
        emptyHint:
          "Nothing is opted in, so the scheduler will run nothing. Set the run models with `senso run-config set-models`, which updates this list too.",
      });
    }),
  );

  describeCommand(
    rc
      .command("set-scheduler-models")
      .description(
        "Replace the registry models the scheduler runs for this organization. Advanced: for the usual case use `run-config set-models`, which sets both lists. This does NOT update the run-model list, so afterwards `run-config models` and `run-config scheduler-models` can disagree.",
      )
      .requiredOption(
        "--data <json>",
        `JSON: { "models": ["anthropic/claude", "brightdata/chatgpt"] }. Each entry is provider/model; the bare names \`set-models\` takes are rejected here. Seeded catalog: ${SCHEDULER_CATALOG.join(", ")}.`,
      ),
    {
      returns: [
        "models[] — the opt-in after the replace, with provider, model, execution_mode and adapter_key",
        `The catalog is configurable; \`senso run-config scheduler-models\` shows this organization's current opt-in, and a rejected write returns the accepted set in error.details (valid_models, suggestions). The seeded ids are ${SCHEDULER_CATALOG.join(", ")}`,
      ],
      exitCodes: {
        ...apiExits,
        2: '--data is not JSON, has no "models", the array is empty, or an entry is not a provider/model string',
        3: "no API key, or (JWT callers) no update:org permission",
        1: "the API refused: an entry that is not an enabled, scheduler-supported registry model. error.details carries valid_models and suggestions",
      },
      examples: [
        {
          command:
            'senso run-config set-scheduler-models --data \'{"models":["anthropic/claude","brightdata/chatgpt"]}\'',
        },
      ],
      notes: ["The write is all-or-nothing: nothing is stored if any entry is rejected."],
      seeAlso: ["senso run-config set-models", "senso run-config scheduler-models"],
    },
  ).action(
    runAction(program, async (ctx, cmdOpts: { data: string }) => {
      const body = parseJsonFlag<{ models?: unknown }>(cmdOpts.data, { required: ["models"] });
      const models = parseSchedulerModels(body.models);
      const data = await apiRequest({
        method: "PUT",
        path: "/org/scheduler-models",
        body: { models },
        apiKey: ctx.apiKey,
        baseUrl: ctx.baseUrl,
      });
      emit(ctx, data, {
        columns: ["provider", "model", "execution_mode", "adapter_key", "id"],
        empty: "scheduler models",
        warnings: [
          "This replaced the whole opt-in, and left `senso run-config models` untouched — the two lists can now disagree.",
        ],
      });
    }),
  );

  describeCommand(
    rc
      .command("schedule")
      .description("The days of the week on which this organization's prompts are run."),
    {
      returns: [
        "schedule — days of the week, 0 = Sunday through 6 = Saturday",
        "An empty schedule means no scheduled runs at all: prompts are never answered until days are set",
        "Day granularity only — the API does not expose the time of day or the timezone",
      ],
      exitCodes: {
        ...apiExits,
        3: "no API key, or the organization does not have the GEO product",
      },
      examples: [
        { command: "senso run-config schedule" },
        { command: "senso run-config schedule --output json | jq -r '.data.schedule | @csv'" },
      ],
      seeAlso: [
        "senso run-config set-schedule",
        "senso run-config models",
        "senso prompts get <promptId>",
      ],
    },
  ).action(
    runAction(program, async (ctx) => {
      const data = await apiRequest<{ schedule?: unknown }>({
        path: "/org/run-schedule",
        apiKey: ctx.apiKey,
        baseUrl: ctx.baseUrl,
      });
      // { schedule: [1, 3, 5] } is a list of numbers, not rows, and the numbers
      // alone are the one thing a reader has to decode. Naming the days next to
      // them is the whole difference between an answer and a lookup table.
      const days = describeDays(data.schedule);
      emit(ctx, data, {
        plain: days
          ? [`  schedule  ${days}`]
          : ["  No run days configured — scheduled runs will not fire."],
        next: days
          ? []
          : [
              {
                why: "Nothing runs until days are set",
                command: `senso run-config set-schedule --data '{"schedule":[1,3,5]}'`,
              },
            ],
      });
    }),
  );

  describeCommand(
    rc
      .command("set-schedule")
      .description(
        "Set which days of the week this organization's prompts are run. REPLACES the whole schedule: days that are not listed are removed.",
      )
      .requiredOption(
        "--data <json>",
        'JSON: { "schedule": [1, 3, 5] } — whole numbers 0-6, 0 = Sunday. At least one day: the API cannot store an empty schedule, so runs cannot be turned off here.',
      ),
    {
      returns: ["schedule — the days after the write, 0 = Sunday through 6 = Saturday"],
      exitCodes: {
        ...apiExits,
        2: '--data is not JSON, has no "schedule" array, the array is empty, a value is not a whole number 0-6, or a day is listed twice',
        3: "no API key, or (JWT callers) no update:org permission",
      },
      examples: [
        { command: "senso run-config set-schedule --data '{\"schedule\":[1,3,5]}'" },
        {
          comment: "Every day",
          command: "senso run-config set-schedule --data '{\"schedule\":[0,1,2,3,4,5,6]}'",
        },
      ],
      notes: [
        "Day granularity only: the time of day and the timezone are not configurable through the API.",
      ],
      seeAlso: ["senso run-config schedule", "senso run-config set-models"],
    },
  ).action(
    runAction(program, async (ctx, cmdOpts: { data: string }) => {
      const body = parseJsonFlag<{ schedule?: unknown }>(cmdOpts.data, { required: ["schedule"] });
      const schedule = parseSchedule(body.schedule);
      const data = await apiRequest<{ schedule?: unknown }>({
        method: "PUT",
        path: "/org/run-schedule",
        body: { schedule },
        apiKey: ctx.apiKey,
        baseUrl: ctx.baseUrl,
      });
      const days = describeDays(data.schedule);
      emit(ctx, data, {
        plain: days
          ? [`  schedule  ${days}`]
          : ["  No run days configured — scheduled runs will not fire."],
        warnings: ["This replaced the whole schedule; days that were not listed no longer run."],
      });
    }),
  );
}
