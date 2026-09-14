import { Command } from "commander";
import { apiRequest } from "../lib/api-client.js";
import { emit } from "../lib/output.js";
import { runAction, type Ctx } from "../lib/run-action.js";

/**
 * History-import jobs — the run history `senso industries import-prompts`
 * starts copying in the background.
 *
 * The import call returns before the copying is done, so these are how a caller
 * finds out whether it actually got any data. A `completed` import may have
 * copied nothing, which is why `prompts_count` and `historic_runs_imported` are
 * in the default columns: the status alone does not answer the question.
 */
export function registerHistoryImportsCommands(program: Command): void {
  const historyImports = program
    .command("history-imports")
    .description(
      "Track the run-history import jobs started by `senso industries import-prompts`. A `completed` import may still have copied nothing — read `prompts_count` and `historic_runs_imported` rather than the status on its own.",
    );

  historyImports
    .command("list")
    .description(
      "List this organization's 50 most recently started history-import jobs, newest first.",
    )
    .action(
      runAction(program, async (ctx: Ctx) => {
        const data = await apiRequest({
          path: "/org/history-imports",
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
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
        });
      }),
    );

  historyImports
    .command("get <importId>")
    .description(
      "Get one history-import job, as returned in `history_import.import_id` by `senso industries import-prompts`.",
    )
    .action(
      runAction(program, async (ctx: Ctx, importId: string) => {
        const data = await apiRequest({
          path: `/org/history-imports/${encodeURIComponent(importId)}`,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        emit(ctx, data);
      }),
    );
}
