import { Command } from "commander";
import { apiRequest } from "../lib/api-client.js";
import { CliError, EXIT } from "../lib/errors.js";
import { emit } from "../lib/output.js";
import { parseJsonFlag } from "../lib/json-arg.js";
import { runAction } from "../lib/run-action.js";
import * as log from "../utils/logger.js";

/**
 * The run schedule as days of the week, checked before it is sent.
 *
 * The help text promises 0-6, and a day outside that range (or a string "1")
 * is not something the caller can be told about usefully by the API response,
 * which reports the whole body. Naming the offending value here does.
 */
function assertSchedule(schedule: unknown): void {
  if (!Array.isArray(schedule)) {
    throw new CliError('--data must contain a "schedule" array.', EXIT.USAGE, {
      code: "usage",
      hint: "Example: --data '{\"schedule\":[1,3,5]}' — days 0-6 (Sunday-Saturday).",
    });
  }
  for (const day of schedule as unknown[]) {
    if (typeof day !== "number" || !Number.isInteger(day) || day < 0 || day > 6) {
      throw new CliError(`Invalid schedule day: ${JSON.stringify(day)}.`, EXIT.USAGE, {
        code: "usage",
        hint: "Days must be whole numbers 0-6 (0=Sunday, 6=Saturday).",
      });
    }
  }
}

/**
 * The scheduler model list, checked before it is sent.
 *
 * The endpoint takes a non-empty array of `provider/model` strings and answers
 * an empty or mistyped one with the whole accepted set, which reads as an API
 * failure rather than as "you sent the wrong shape". Naming the offending value
 * here makes it a usage error, before the request.
 */
function assertModels(models: unknown): void {
  if (!Array.isArray(models) || models.length === 0) {
    throw new CliError('--data must contain a non-empty "models" array.', EXIT.USAGE, {
      code: "usage",
      hint: 'Example: --data \'{"models":["anthropic/claude"]}\'',
    });
  }
  for (const model of models as unknown[]) {
    if (typeof model !== "string" || model.trim() === "") {
      throw new CliError(`Invalid model: ${JSON.stringify(model)}.`, EXIT.USAGE, {
        code: "usage",
        hint: "Each model is a non-empty 'provider/model' string, e.g. anthropic/claude.",
      });
    }
  }
}

export function registerRunConfigCommands(program: Command): void {
  const rc = program
    .command("run-config")
    .description(
      "Configure which AI models are used for question runs and on which days they run. Models include chatgpt, gemini, etc.",
    );

  rc.command("models")
    .description("Get the AI models currently configured for question runs (e.g. chatgpt, gemini).")
    .action(
      runAction(program, async (ctx) => {
        const data = await apiRequest({
          path: "/org/run-models",
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emit(ctx, data, { columns: ["geo_model_id", "name"] });
      }),
    );

  rc.command("set-models")
    .description(
      "Replace the configured AI models for question runs. At least one model name is required.",
    )
    .requiredOption("--data <json>", 'JSON: { "models": ["chatgpt", "gemini"] }')
    .action(
      runAction(program, async (ctx, cmdOpts: { data: string }) => {
        const body = parseJsonFlag(cmdOpts.data);
        const data = await apiRequest({
          method: "PUT",
          path: "/org/run-models",
          body,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        if (!ctx.quiet) log.success("Models updated.");
        emit(ctx, data, { columns: ["geo_model_id", "name"] });
      }),
    );

  rc.command("model-options")
    .description(
      "List the model names 'run-config set-models' accepts, each with a display label. The options are global rather than per-org — read them before writing, so an unsupported name does not cost a round trip.",
    )
    .action(
      runAction(program, async (ctx) => {
        const data = await apiRequest({
          path: "/org/run-models/options",
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emit(ctx, data, { columns: ["name", "display_name"] });
      }),
    );

  rc.command("scheduler-models")
    .description(
      "Get the models the scheduler runs for the organization, as provider/model pairs with their execution mode. This is a separate set from 'run-config models' — though writing run models also replaces it.",
    )
    .action(
      runAction(program, async (ctx) => {
        const data = await apiRequest({
          path: "/org/scheduler-models",
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emit(ctx, data, { columns: ["id", "provider", "model", "execution_mode"] });
      }),
    );

  rc.command("set-scheduler-models")
    .description(
      "Replace the organization's scheduler model opt-in. Each entry is a 'provider/model' identifier such as anthropic/claude. The supported set is configurable, so do not assume it: an unsupported entry exits 1 and the error lists every accepted value.",
    )
    .requiredOption("--data <json>", 'JSON: { "models": ["anthropic/claude", "openai/gpt"] }')
    .action(
      runAction(program, async (ctx, cmdOpts: { data: string }) => {
        const body = parseJsonFlag<{ models?: unknown }>(cmdOpts.data);
        assertModels(body.models);
        const data = await apiRequest({
          method: "PUT",
          path: "/org/scheduler-models",
          body,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        if (!ctx.quiet) log.success("Scheduler models updated.");
        emit(ctx, data, { columns: ["id", "provider", "model", "execution_mode"] });
      }),
    );

  rc.command("schedule")
    .description(
      "Get the days of the week when question runs are triggered (0=Sunday, 1=Monday, ..., 6=Saturday).",
    )
    .action(
      runAction(program, async (ctx) => {
        const data = await apiRequest({
          path: "/org/run-schedule",
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        // { schedule: [1, 3, 5] } — a list of numbers, not rows, so the generic
        // key/value rendering is the readable one.
        emit(ctx, data);
      }),
    );

  rc.command("set-schedule")
    .description(
      "Set which days of the week question runs are triggered. Values must be 0-6 (Sunday-Saturday).",
    )
    .requiredOption("--data <json>", 'JSON: { "schedule": [1, 3, 5] }')
    .action(
      runAction(program, async (ctx, cmdOpts: { data: string }) => {
        const body = parseJsonFlag<{ schedule?: unknown }>(cmdOpts.data);
        assertSchedule(body.schedule);
        const data = await apiRequest({
          method: "PUT",
          path: "/org/run-schedule",
          body,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        if (!ctx.quiet) log.success("Schedule updated.");
        emit(ctx, data);
      }),
    );
}
