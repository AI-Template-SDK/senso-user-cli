import { Command } from "commander";
import { apiRequest, formatApiError } from "../lib/api-client.js";
import * as log from "../utils/logger.js";

export function registerRunConfigCommands(program: Command): void {
  const rc = program
    .command("run-config")
    .description("Configure which AI models are used for question runs and on which days they run. Models include chatgpt, gemini, etc.");

  rc
    .command("models")
    .description("Get the AI models currently configured for question runs (e.g. chatgpt, gemini).")
    .action(async () => {
      const opts = program.opts();
      try {
        const data = await apiRequest({ path: "/org/run-models", apiKey: opts.apiKey, baseUrl: opts.baseUrl });
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  rc
    .command("set-models")
    .description("Replace the configured AI models for question runs. At least one model name is required.")
    .requiredOption("--data <json>", 'JSON: { "models": ["chatgpt", "gemini"] }')
    .action(async (cmdOpts: { data: string }) => {
      const opts = program.opts();
      try {
        const body = JSON.parse(cmdOpts.data);
        const data = await apiRequest({
          method: "PUT",
          path: "/org/run-models",
          body,
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        log.success("Models updated.");
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(err instanceof SyntaxError ? "Invalid JSON in --data" : formatApiError(err));
        process.exit(1);
      }
    });

  rc
    .command("schedule")
    .description("Get the days of the week when question runs are triggered (0=Sunday, 1=Monday, ..., 6=Saturday).")
    .action(async () => {
      const opts = program.opts();
      try {
        const data = await apiRequest({ path: "/org/run-schedule", apiKey: opts.apiKey, baseUrl: opts.baseUrl });
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  rc
    .command("set-schedule")
    .description("Set which days of the week question runs are triggered. Values must be 0-6 (Sunday-Saturday).")
    .requiredOption("--data <json>", 'JSON: { "schedule": [1, 3, 5] }')
    .action(async (cmdOpts: { data: string }) => {
      const opts = program.opts();
      try {
        const body = JSON.parse(cmdOpts.data);
        const data = await apiRequest({
          method: "PUT",
          path: "/org/run-schedule",
          body,
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        log.success("Schedule updated.");
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(err instanceof SyntaxError ? "Invalid JSON in --data" : formatApiError(err));
        process.exit(1);
      }
    });
}
