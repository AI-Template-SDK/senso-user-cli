/**
 * The `senso analytics` command group.
 *
 * This file owns the group itself — its description and the order its
 * subcommands appear in `--help` — and nothing else. Everything it calls lives
 * beside it:
 *
 *   types.ts            the response shapes, mirroring the API's DTOs
 *   render.ts           the shared presentation rules (NO_VALUE, the metric
 *                       table, the window / quality / notes context lines)
 *   filters.ts          the shared option builders and their query mapping
 *   filters-command.ts  the `filters` subcommand — not to be confused with
 *                       filters.ts above
 *   summary.ts, mentions.ts, citations.ts, domains.ts, pages.ts, prompts.ts,
 *   prompt.ts, answers.ts, glossary.ts
 *                       one file per subcommand, each registering exactly one
 *
 * `registerAnalyticsCommands` is the only export the rest of the CLI sees; the
 * `addXCommand` functions are internal to this directory.
 */

import { Command } from "commander";
import { addSummaryCommand } from "./summary.js";
import { addMentionsCommand } from "./mentions.js";
import { addCitationsCommand } from "./citations.js";
import { addDomainsCommand } from "./domains.js";
import { addPagesCommand } from "./pages.js";
import { addPromptsCommand } from "./prompts.js";
import { addPromptCommand } from "./prompt.js";
import { addAnswersCommand } from "./answers.js";
import { addGlossaryCommand } from "./glossary.js";
import { addFiltersCommand } from "./filters-command.js";

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerAnalyticsCommands(program: Command): void {
  const analytics = program
    .command("analytics")
    .description(
      "GEO analytics for your organization — brand visibility, share of voice, and citations across the AI models you monitor. Every payload ships raw counts alongside the rates, and a rate is null (shown as “—”) when its denominator is zero, never a silent 0%. Run 'senso analytics glossary' for the canonical definition and denominator of every metric. Requires the GEO product and the read:prompt permission: a 403 here is usually an entitlement, which no role change fixes. Dates are YYYY-MM-DD (the 'senso evals' group takes RFC 3339 instants under the same flag names) and a window may span at most 365 days. `analytics prompt <promptId>` takes an ORG prompt id — the prompt_id field of 'senso analytics prompts' or 'senso prompts list' — never an industry prompt id from 'senso industries prompts'. Typical order: filters → summary → prompts --order asc → prompt <id> → answers.",
    );

  // Registration order is the order `senso analytics --help` lists them in.
  addSummaryCommand(analytics, program);
  addMentionsCommand(analytics, program);
  addCitationsCommand(analytics, program);
  addDomainsCommand(analytics, program);
  addPagesCommand(analytics, program);
  addPromptsCommand(analytics, program);
  addPromptCommand(analytics, program);
  addAnswersCommand(analytics, program);
  addGlossaryCommand(analytics, program);
  addFiltersCommand(analytics, program);
}
