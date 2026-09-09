import { Command } from "commander";
import { apiRequest } from "../lib/api-client.js";
import { parseJsonFlag } from "../lib/json-arg.js";
import { emit, emitConfirmation } from "../lib/output.js";
import { runAction } from "../lib/run-action.js";
import * as log from "../utils/logger.js";

export function registerQuestionsCommands(program: Command): void {
  const questions = program
    .command("questions")
    .description(
      "Manage org-scoped geo questions. These are lightweight CRUD questions distinct from prompts (which include full run history).",
    );

  questions
    .command("list")
    .description("List geo questions for the org.")
    .option("--type <type>", "Filter by question type: organization | network", "organization")
    .action(
      runAction(program, async (ctx, cmdOpts: Record<string, string>) => {
        const data = await apiRequest({
          path: "/org/questions",
          params: { question_type: cmdOpts.type },
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        // geo_question_id is the id these are referenced by elsewhere (see `engine publish`).
        emit(ctx, data, { columns: ["geo_question_id", "question_text", "type", "created_at"] });
      }),
    );

  questions
    .command("create")
    .description(
      "Create a new geo question. Type must be one of: decision, consideration, awareness, evaluation.",
    )
    .requiredOption(
      "--data <json>",
      'JSON: { "question_text": "...", "type": "decision", "tag_ids": [] }',
    )
    .action(
      runAction(program, async (ctx, cmdOpts: { data: string }) => {
        const body = parseJsonFlag(cmdOpts.data);
        const data = await apiRequest({
          method: "POST",
          path: "/org/questions",
          body,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        if (!ctx.quiet) log.success("Question created.");
        emit(ctx, data);
      }),
    );

  questions
    .command("patch <questionId>")
    .description(
      "Partially update a question. Supports updating tag associations and/or the funnel stage (type). At least one of tag_ids or type must be provided.",
    )
    .requiredOption(
      "--data <json>",
      'JSON: { "tag_ids": ["<uuid>", ...], "type": "decision|consideration|awareness|evaluation" } — pass tag_ids: null to clear all tags',
    )
    .action(
      runAction(program, async (ctx, questionId: string, cmdOpts: { data: string }) => {
        const body = parseJsonFlag(cmdOpts.data);
        const data = await apiRequest({
          method: "PATCH",
          path: `/org/questions/${questionId}`,
          body,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        if (!ctx.quiet) log.success(`Question ${questionId} updated.`);
        emit(ctx, data);
      }),
    );

  questions
    .command("delete <questionId>")
    .description("Delete a geo question.")
    .action(
      runAction(program, async (ctx, questionId: string) => {
        await apiRequest({
          method: "DELETE",
          path: `/org/questions/${questionId}`,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emitConfirmation(ctx, `Question ${questionId} deleted.`);
      }),
    );
}
