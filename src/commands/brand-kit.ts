import { Command } from "commander";
import { apiRequest, formatApiError } from "../lib/api-client.js";
import * as log from "../utils/logger.js";

export function registerBrandKitCommands(program: Command): void {
  const bk = program
    .command("brand-kit")
    .description("Manage the organization's brand kit guidelines that inform AI content generation about your brand voice, tone, and style. The guidelines object accepts a defined set of keys: brand_name, brand_domain, brand_description, voice_and_tone, author_persona, and global_writing_rules (array). Unknown keys are rejected.");

  bk
    .command("get")
    .description("Get the current brand kit guidelines.")
    .action(async () => {
      const opts = program.opts();
      try {
        const data = await apiRequest({ path: "/org/brand-kit", apiKey: opts.apiKey, baseUrl: opts.baseUrl });
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  bk
    .command("set")
    .description("Replace the entire brand kit (PUT). All existing fields are overwritten — run 'brand-kit get' first to preserve fields you are not changing. For a safe partial update, use 'brand-kit patch'.")
    .requiredOption("--data <json>", 'JSON: { "guidelines": { "brand_name": "Acme", "voice_and_tone": "...", "author_persona": "...", "global_writing_rules": [] } }')
    .action(async (cmdOpts: { data: string }) => {
      const opts = program.opts();
      try {
        const body = JSON.parse(cmdOpts.data);
        const data = await apiRequest({
          method: "PUT",
          path: "/org/brand-kit",
          body,
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        log.success("Brand kit updated.");
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(err instanceof SyntaxError ? "Invalid JSON in --data" : formatApiError(err));
        process.exit(1);
      }
    });

  bk
    .command("patch")
    .description("Partially update the brand kit (PATCH). Only the fields you provide are changed — existing fields are preserved. Preferred over 'set' for targeted updates.")
    .requiredOption("--data <json>", 'JSON: { "guidelines": { "voice_and_tone": "Warm and approachable" } }')
    .action(async (cmdOpts: { data: string }) => {
      const opts = program.opts();
      try {
        const body = JSON.parse(cmdOpts.data);
        const data = await apiRequest({
          method: "PATCH",
          path: "/org/brand-kit",
          body,
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        log.success("Brand kit updated.");
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(err instanceof SyntaxError ? "Invalid JSON in --data" : formatApiError(err));
        process.exit(1);
      }
    });
}
