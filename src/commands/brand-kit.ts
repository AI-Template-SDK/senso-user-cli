import { Command } from "commander";
import { apiRequest } from "../lib/api-client.js";
import { parseJsonFlag } from "../lib/json-arg.js";
import { emit } from "../lib/output.js";
import { runAction } from "../lib/run-action.js";
import * as log from "../utils/logger.js";

export function registerBrandKitCommands(program: Command): void {
  const bk = program
    .command("brand-kit")
    .description(
      "Manage the organization's brand kit guidelines that inform AI content generation about your brand voice, tone, and style. The guidelines object accepts a defined set of keys: brand_name, brand_domain, brand_description, voice_and_tone, author_persona, and global_writing_rules (array). Unknown keys are rejected.",
    );

  bk.command("get")
    .description("Get the current brand kit guidelines.")
    .action(
      runAction(program, async (ctx) => {
        const data = await apiRequest({
          path: "/org/brand-kit",
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emit(ctx, data);
      }),
    );

  bk.command("set")
    .description(
      "Replace the entire brand kit (PUT). All existing fields are overwritten — run 'brand-kit get' first to preserve fields you are not changing. For a safe partial update, use 'brand-kit patch'.",
    )
    .requiredOption(
      "--data <json>",
      'JSON: { "guidelines": { "brand_name": "Acme", "voice_and_tone": "...", "author_persona": "...", "global_writing_rules": [] } }',
    )
    .action(
      runAction(program, async (ctx, cmdOpts: { data: string }) => {
        const body = parseJsonFlag(cmdOpts.data);
        const data = await apiRequest({
          method: "PUT",
          path: "/org/brand-kit",
          body,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        if (!ctx.quiet) log.success("Brand kit updated.");
        emit(ctx, data);
      }),
    );

  bk.command("patch")
    .description(
      "Partially update the brand kit (PATCH). Only the fields you provide are changed — existing fields are preserved. Preferred over 'set' for targeted updates.",
    )
    .requiredOption(
      "--data <json>",
      'JSON: { "guidelines": { "voice_and_tone": "Warm and approachable" } }',
    )
    .action(
      runAction(program, async (ctx, cmdOpts: { data: string }) => {
        const body = parseJsonFlag(cmdOpts.data);
        const data = await apiRequest({
          method: "PATCH",
          path: "/org/brand-kit",
          body,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        if (!ctx.quiet) log.success("Brand kit updated.");
        emit(ctx, data);
      }),
    );
}
