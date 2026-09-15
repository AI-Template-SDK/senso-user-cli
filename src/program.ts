/**
 * Builds the command tree.
 *
 * Kept apart from src/cli.ts, the bin entry, because importing this module must
 * have no side effects. The old arrangement built the program and called
 * parseAsync at module scope, so anything that imported it — a test, the
 * reference generator — ran the CLI. Tests call createProgram() and drive it;
 * scripts/gen-reference.ts walks it to produce the command reference.
 */

import { Command } from "commander";
import { version } from "./lib/version.js";
import { miniBanner } from "./utils/branding.js";
import { checkForUpdate } from "./utils/updater.js";
import { EXIT, ExitSignal } from "./lib/errors.js";

// Command registrations
import { registerAuthCommands } from "./commands/auth.js";
import { registerOrgCommands } from "./commands/org.js";
import { registerUserCommands } from "./commands/users.js";
import { registerApiKeyCommands } from "./commands/api-keys.js";
import { registerSearchCommands } from "./commands/search.js";
import { registerIngestCommands } from "./commands/ingest.js";
import { registerWebsiteImportCommands } from "./commands/website-import.js";
import { registerContentCommands } from "./commands/content.js";
import { registerCtaCommands } from "./commands/ctas.js";
import { registerEvalsCommands } from "./commands/evals.js";
import { registerGapsCommands } from "./commands/gaps.js";
import { registerGenerateCommands } from "./commands/generate.js";
import { registerEngineCommands } from "./commands/engine.js";
import { registerDestinationsCommands } from "./commands/destinations.js";
import { registerPublishRecordsCommands } from "./commands/publish-records.js";
import { registerBrandKitCommands } from "./commands/brand-kit.js";
import { registerContentTypeCommands } from "./commands/content-types.js";
import { registerPromptCommands } from "./commands/prompts.js";
import { registerRunConfigCommands } from "./commands/run-config.js";
import { registerSkillsCommands } from "./commands/skills.js";
import { registerMemberCommands } from "./commands/members.js";
import { registerCreditsCommands } from "./commands/credits.js";
import { registerQuestionsCommands } from "./commands/questions.js";
import { registerKBCommands } from "./commands/kb.js";
import { registerPermissionsCommands } from "./commands/permissions.js";
import { registerProductLineCommands } from "./commands/product-lines.js";
import { registerTagsCommands } from "./commands/tags.js";
import { registerRolesCommands } from "./commands/roles.js";
import { registerCompetitorsCommands } from "./commands/competitors.js";
import { registerTrackedSourcesCommands } from "./commands/tracked-sources.js";
import { registerGeneratedContentCommands } from "./commands/generated-content.js";
import { registerAnalyticsCommands } from "./commands/analytics/index.js";
import { registerHistoryImportsCommands } from "./commands/history-imports.js";
import { registerIndustriesCommands } from "./commands/industries.js";
import { registerPartnerCommands } from "./commands/partner.js";
import { registerUpdateCommand } from "./commands/update.js";
import { registerUninstallCommand } from "./commands/uninstall.js";

/**
 * `login`, `logout` and `uninstall` own the config file for the duration of
 * their run, and `update` asks the registry itself — a second check would be
 * redundant work and a second writer. For `uninstall` the second writer is
 * worse than redundant: the check finishes after the command has deleted the
 * config file, and writes it straight back.
 */
export const UPDATE_CHECK_EXEMPT = new Set(["login", "logout", "update", "uninstall"]);

/**
 * The exit-code table, shown at the bottom of `senso --help`.
 *
 * Documented in the help output and not only in the README because the caller
 * most likely to branch on an exit code is an agent, and `--help` is what an
 * agent reads.
 */
const HELP_EPILOG = `
Exit codes:
  0  success
  1  the API or the runtime refused the request
  2  usage error (unknown command, missing argument, bad flag)
  3  authentication (no key, or the key was rejected)
  4  not found
  5  network failure or timeout

Environment:
  SENSO_API_KEY        API key, if you do not want to run \`senso login\`
  SENSO_BASE_URL       Override the API base URL
  SENSO_CONFIG_DIR     Override where the config file is read and written
  SENSO_DEBUG=1        Log every request to stderr, with the key redacted
  SENSO_NO_UPDATE_CHECK=1  Never check npm for a newer version
  SENSO_GAP_SIGNALS=off  Keep every search out of the gap report (for probes and tests)
  NO_COLOR             Disable color (any value)

Output:
  stdout carries the payload; diagnostics, progress and errors go to stderr.
  With --output json, stdout is always parseable JSON and errors are JSON too.

Docs: https://docs.senso.ai`;

export function createProgram(): Command {
  const program = new Command();

  program
    .name("senso")
    .description("Senso CLI — Infrastructure for the Agentic Web")
    .version(version, "-v, --version")
    .option("--api-key <key>", "Override API key (or set SENSO_API_KEY)")
    .option("--base-url <url>", "Override API base URL")
    .option("--output <format>", "Output format: json | table | plain", "plain")
    .option("--quiet", "Suppress non-essential output")
    .option("--no-update-check", "Skip version check")
    .addHelpText("after", HELP_EPILOG)
    // Commander exits 1 by default for a usage error. 2 is the long-standing
    // convention for "you typed it wrong", and it is what lets a caller tell a
    // bad flag from a rejected request. See lib/errors.ts.
    //
    // Thrown rather than exited so that src/cli.ts remains the only file that
    // ends the process: `--help` and `--version` have already printed by the
    // time this runs and must exit 0 silently, which is what ExitSignal means.
    .exitOverride((err) => {
      throw new ExitSignal(err.exitCode === 0 ? EXIT.OK : EXIT.USAGE);
    })
    // preAction runs once per invocation, after Commander has parsed the global
    // options and resolved which command is running — which is why both of these
    // live here rather than in the bin entry. Commander exits on `--version` and
    // `--help` without dispatching an action, so neither the banner nor the
    // update check fires for them: `senso --version` stays offline and pure,
    // which is what a CI smoke test needs.
    .hook("preAction", (_thisCommand, actionCommand) => {
      const opts = program.opts<{ quiet?: boolean; output?: string }>();
      // JSON output is consumed by a program. Even on stderr, a banner is noise
      // an agent has to be told to ignore, so suppress it entirely.
      const decorated = !opts.quiet && opts.output !== "json";
      if (decorated) {
        miniBanner();
      }

      // Best-effort and deliberately not awaited.
      //
      // `--no-update-check` was registered here and never read: Commander stores
      // it as `updateCheck: false`, and the hook decided purely from --quiet and
      // --output, so the documented flag did nothing at all.
      const opted = program.opts<{ updateCheck?: boolean }>().updateCheck !== false;
      if (opted && !UPDATE_CHECK_EXEMPT.has(actionCommand.name())) {
        void checkForUpdate(!decorated);
      }
    });

  registerAuthCommands(program);
  registerOrgCommands(program);
  registerUserCommands(program);
  registerApiKeyCommands(program);
  registerSearchCommands(program);
  registerIngestCommands(program);
  registerWebsiteImportCommands(program);
  registerContentCommands(program);
  registerCtaCommands(program);
  registerEvalsCommands(program);
  registerGapsCommands(program);
  registerGenerateCommands(program);
  registerEngineCommands(program);
  registerDestinationsCommands(program);
  registerPublishRecordsCommands(program);
  registerBrandKitCommands(program);
  registerContentTypeCommands(program);
  registerPromptCommands(program);
  registerRunConfigCommands(program);
  registerSkillsCommands(program);
  registerMemberCommands(program);
  registerCreditsCommands(program);
  registerQuestionsCommands(program);
  registerKBCommands(program);
  registerPermissionsCommands(program);
  registerTagsCommands(program);
  registerProductLineCommands(program);
  registerRolesCommands(program);
  registerCompetitorsCommands(program);
  registerTrackedSourcesCommands(program);
  registerGeneratedContentCommands(program);
  registerAnalyticsCommands(program);
  registerHistoryImportsCommands(program);
  registerIndustriesCommands(program);
  registerPartnerCommands(program);
  registerUpdateCommand(program);
  registerUninstallCommand(program);

  return program;
}
