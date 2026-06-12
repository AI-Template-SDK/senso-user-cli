import { Command } from "commander";
import { apiRequest, formatApiError } from "../lib/api-client.js";
import * as log from "../utils/logger.js";

const MATCH_TYPES = "domain | host | path_prefix | exact_url";
const TIERS = "primary (Owned) | tracked | secondary (External)";
const CATEGORIES = "affiliated_domain | published_content | social | press";

interface SourceFlags {
  pattern?: string;
  matchType?: string;
  tier?: string;
  category?: string;
  label?: string;
  priority?: string;
  active?: boolean;
}

function buildSourceBody(cmdOpts: SourceFlags): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (cmdOpts.pattern !== undefined) body.pattern = cmdOpts.pattern;
  if (cmdOpts.matchType !== undefined) body.match_type = cmdOpts.matchType;
  if (cmdOpts.tier !== undefined) body.tier = cmdOpts.tier;
  if (cmdOpts.category !== undefined) body.category = cmdOpts.category;
  if (cmdOpts.label !== undefined) body.label = cmdOpts.label;
  if (cmdOpts.priority !== undefined) body.priority = Number(cmdOpts.priority);
  if (cmdOpts.active !== undefined) body.active = cmdOpts.active;
  return body;
}

export function registerTrackedSourcesCommands(program: Command): void {
  const sources = program
    .command("tracked-sources")
    .description("Manage citation-classification rules that tier each cited URL as Owned (primary), Tracked, or External (secondary). Tracked sources drive share-of-voice and citation analytics. Rules created from published content are read-only.");

  sources
    .command("list")
    .description("List every tracked source rule for the current organization.")
    .action(async () => {
      const opts = program.opts();
      try {
        const data = await apiRequest({
          path: "/org/tracked-sources",
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  sources
    .command("add")
    .description("Add a tracked source rule. New rules are always created active.")
    .requiredOption("--pattern <pattern>", "Value to match cited URLs against, interpreted per --match-type")
    .requiredOption("--match-type <type>", `Match strategy: ${MATCH_TYPES}`)
    .requiredOption("--tier <tier>", `Classification tier: ${TIERS}`)
    .option("--category <category>", `Optional sub-category (only meaningful for the 'tracked' tier): ${CATEGORIES}`)
    .option("--label <label>", "Optional human-readable label")
    .option("--priority <n>", "Optional ordering priority (integer)")
    .action(async (cmdOpts: SourceFlags) => {
      const opts = program.opts();
      try {
        const data = await apiRequest({
          method: "POST",
          path: "/org/tracked-sources",
          body: buildSourceBody(cmdOpts),
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        log.success(`Tracked source "${cmdOpts.pattern}" added.`);
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  sources
    .command("update <sourceId>")
    .description("Replace a tracked source rule (PUT). Pattern, match type, and tier are required. Published rules are read-only.")
    .requiredOption("--pattern <pattern>", "Value to match cited URLs against, interpreted per --match-type")
    .requiredOption("--match-type <type>", `Match strategy: ${MATCH_TYPES}`)
    .requiredOption("--tier <tier>", `Classification tier: ${TIERS}`)
    .option("--category <category>", `Optional sub-category (only meaningful for the 'tracked' tier): ${CATEGORIES}`)
    .option("--label <label>", "Optional human-readable label")
    .option("--priority <n>", "Optional ordering priority (integer)")
    .option("--active", "Mark the rule active")
    .option("--no-active", "Mark the rule inactive")
    .action(async (sourceId: string, cmdOpts: SourceFlags) => {
      const opts = program.opts();
      try {
        const data = await apiRequest({
          method: "PUT",
          path: `/org/tracked-sources/${sourceId}`,
          body: buildSourceBody(cmdOpts),
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        log.success(`Tracked source ${sourceId} updated.`);
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  sources
    .command("delete <sourceId>")
    .description("Remove a tracked source rule.")
    .action(async (sourceId: string) => {
      const opts = program.opts();
      try {
        await apiRequest({
          method: "DELETE",
          path: `/org/tracked-sources/${sourceId}`,
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        log.success(`Tracked source ${sourceId} removed.`);
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });
}
