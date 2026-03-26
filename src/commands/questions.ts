import { Command } from "commander";
import { apiRequest, formatApiError } from "../lib/api-client.js";
import * as log from "../utils/logger.js";

export function registerQuestionsCommands(program: Command): void {
  const questions = program
    .command("questions")
    .description("Manage org-scoped geo questions. These are lightweight CRUD questions distinct from prompts (which include full run history).");

  questions
    .command("list")
    .description("List geo questions for the org.")
    .option("--type <type>", "Filter by question type: organization | network", "organization")
    .action(async (cmdOpts: Record<string, string>) => {
      const opts = program.opts();
      try {
        const data = await apiRequest({
          path: "/org/questions",
          params: { question_type: cmdOpts.type },
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  questions
    .command("create")
    .description("Create a new geo question. Type must be one of: decision, consideration, awareness, evaluation.")
    .requiredOption("--data <json>", 'JSON: { "question_text": "...", "type": "decision", "tag_ids": [] }')
    .action(async (cmdOpts: { data: string }) => {
      const opts = program.opts();
      try {
        const body = JSON.parse(cmdOpts.data);
        const data = await apiRequest({ method: "POST", path: "/org/questions", body, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
        log.success("Question created.");
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(err instanceof SyntaxError ? "Invalid JSON in --data" : formatApiError(err));
        process.exit(1);
      }
    });

  questions
    .command("patch <questionId>")
    .description("Partially update a question. Currently supports updating tag associations.")
    .requiredOption("--data <json>", 'JSON: { "tag_ids": ["<uuid>", ...] } — pass null to clear all tags')
    .action(async (questionId: string, cmdOpts: { data: string }) => {
      const opts = program.opts();
      try {
        const body = JSON.parse(cmdOpts.data);
        const data = await apiRequest({ method: "PATCH", path: `/org/questions/${questionId}`, body, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
        log.success(`Question ${questionId} updated.`);
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(err instanceof SyntaxError ? "Invalid JSON in --data" : formatApiError(err));
        process.exit(1);
      }
    });

  questions
    .command("delete <questionId>")
    .description("Delete a geo question.")
    .action(async (questionId: string) => {
      const opts = program.opts();
      try {
        await apiRequest({ method: "DELETE", path: `/org/questions/${questionId}`, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
        log.success(`Question ${questionId} deleted.`);
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });
}
