import { Command } from "commander";
import { apiRequest } from "../lib/api-client.js";
import { parseIntFlag } from "../lib/enum-arg.js";
import { emit } from "../lib/output.js";
import { runAction } from "../lib/run-action.js";

interface CreditHistoryResponse {
  history?: Record<string, unknown>[];
}

export function registerCreditsCommands(program: Command): void {
  const credits = program
    .command("credits")
    .description(
      "View your organization's credit balance. Credits are consumed by AI content generation and search operations.",
    );

  credits
    .command("balance")
    .description(
      "Get the current credit balance for the organization. Returns available credits and any spend limit configured.",
    )
    .action(
      runAction(program, async (ctx) => {
        const data = await apiRequest({
          path: "/org/credits/balance",
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        // A single balance object, not a list: the generic key/value renderer.
        emit(ctx, data);
      }),
    );

  credits
    .command("history")
    .description(
      "Get a day-by-day breakdown of credit spend over a trailing window, plus the total across it. Every day in the window is present — a day with no spend comes back as 0, so there are no gaps to fill. Entries run oldest to newest, and the last one is today, which is still accumulating.",
    )
    .option("--days <n>", "Length of the trailing window in days, 1-365 (default 30)")
    .action(
      runAction(program, async (ctx, cmdOpts: { days?: string }) => {
        const days = parseIntFlag("--days", cmdOpts.days, { min: 1, max: 365 });

        const data = await apiRequest<CreditHistoryResponse>({
          path: "/org/credits/history",
          params: { days: days?.toString() },
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        // `org_id` and `period_usage` are not envelope keys, so the generic
        // list detection does not recognize `history` as the payload's rows and
        // would render the whole object as key/value with the days collapsed
        // into one cell. JSON still gets the envelope, totals included.
        emit(ctx, data, {
          table: { rows: data.history ?? [], columns: ["date", "usage"] },
        });
      }),
    );
}
