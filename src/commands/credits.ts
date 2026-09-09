import { Command } from "commander";
import { apiRequest } from "../lib/api-client.js";
import { emit } from "../lib/output.js";
import { runAction } from "../lib/run-action.js";

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
}
