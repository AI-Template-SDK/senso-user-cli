import { Command } from "commander";
import { apiRequest, formatApiError } from "../lib/api-client.js";
import * as log from "../utils/logger.js";

export function registerGenerateCommands(program: Command): void {
  const gen = program
    .command("generate")
    .description("Content generation settings and triggers");

  gen
    .command("settings")
    .description("Get content generation settings")
    .action(async () => {
      const opts = program.opts();
      try {
        const data = await apiRequest({ path: "/org/content-generation", apiKey: opts.apiKey, baseUrl: opts.baseUrl });
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  gen
    .command("update-settings")
    .description("Update content generation settings")
    .requiredOption("--data <json>", "JSON settings to update")
    .action(async (cmdOpts: { data: string }) => {
      const opts = program.opts();
      try {
        const body = JSON.parse(cmdOpts.data);
        const data = await apiRequest({ method: "PATCH", path: "/org/content-generation", body, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(err instanceof SyntaxError ? "Invalid JSON in --data" : formatApiError(err));
        process.exit(1);
      }
    });

  gen
    .command("sample")
    .description("Generate ad hoc content sample")
    .requiredOption("--instructions <text>", "Instructions for generation")
    .action(async (cmdOpts: { instructions: string }) => {
      const opts = program.opts();
      try {
        const data = await apiRequest({
          method: "POST",
          path: "/org/content-generation/sample",
          body: { instructions: cmdOpts.instructions },
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  gen
    .command("run")
    .description("Trigger content engine run")
    .action(async () => {
      const opts = program.opts();
      try {
        const data = await apiRequest({ method: "POST", path: "/org/content-generation/run", apiKey: opts.apiKey, baseUrl: opts.baseUrl });
        log.success("Content generation run triggered.");
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });
}
