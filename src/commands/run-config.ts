import { Command } from "commander";
import { apiRequest } from "../lib/api-client.js";
import { emit } from "../lib/output.js";
import { parseJsonFlag } from "../lib/json-arg.js";
import { runAction } from "../lib/run-action.js";
import * as log from "../utils/logger.js";

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
        const body = parseJsonFlag(cmdOpts.data);
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
