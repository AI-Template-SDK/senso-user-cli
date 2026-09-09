import { Command } from "commander";
import { version } from "./lib/version.js";
import { miniBanner } from "./utils/branding.js";
import { checkForUpdate } from "./utils/updater.js";

// Command registrations
import { registerAuthCommands } from "./commands/auth.js";
import { registerOrgCommands } from "./commands/org.js";
import { registerUserCommands } from "./commands/users.js";
import { registerApiKeyCommands } from "./commands/api-keys.js";
import { registerSearchCommands } from "./commands/search.js";
import { registerIngestCommands } from "./commands/ingest.js";
import { registerContentCommands } from "./commands/content.js";
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
import { registerAnalyticsCommands } from "./commands/analytics.js";
import { registerIndustriesCommands } from "./commands/industries.js";
import { registerUpdateCommand } from "./commands/update.js";

// `login` and `logout` own the config file for the duration of their run, and
// `update` asks the registry itself — a second check would be redundant work
// and a second writer.
const UPDATE_CHECK_EXEMPT = new Set(["login", "logout", "update"]);

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
  // preAction runs once per invocation, after Commander has parsed the global
  // options and resolved which command is running — which is why both of these
  // live here rather than in main(). Commander exits on `--version` and
  // `--help` without dispatching an action, so neither the banner nor the
  // update check fires for them: `senso --version` stays offline and pure,
  // which is what a CI smoke test needs.
  .hook("preAction", (_thisCommand, actionCommand) => {
    const opts = program.opts();
    // JSON output is consumed by a program. Even on stderr, a banner is noise
    // an agent has to be told to ignore, so suppress it entirely.
    const decorated = !opts.quiet && opts.output !== "json";
    if (decorated) {
      miniBanner();
    }

    // Skipped for the three commands that either write the config file
    // themselves or check the registry on their own behalf. Best-effort and
    // deliberately not awaited.
    const name = actionCommand.name();
    if (!UPDATE_CHECK_EXEMPT.has(name)) {
      void checkForUpdate(!decorated);
    }
  });

// Register all command groups
registerAuthCommands(program);
registerOrgCommands(program);
registerUserCommands(program);
registerApiKeyCommands(program);
registerSearchCommands(program);
registerIngestCommands(program);
registerContentCommands(program);
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
registerIndustriesCommands(program);
registerUpdateCommand(program);

async function main() {
  await program.parseAsync(process.argv);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
