import { Command } from "commander";
import { version } from "./lib/version.js";
import { miniBanner } from "./utils/branding.js";
import { checkForUpdate } from "./utils/updater.js";

// Command registrations
import { registerAuthCommands } from "./commands/auth.js";
import { registerOrgCommands } from "./commands/org.js";
import { registerUserCommands } from "./commands/users.js";
import { registerApiKeyCommands } from "./commands/api-keys.js";
import { registerCategoryCommands } from "./commands/categories.js";
import { registerTopicCommands } from "./commands/topics.js";
import { registerSearchCommands } from "./commands/search.js";
import { registerIngestCommands } from "./commands/ingest.js";
import { registerContentCommands } from "./commands/content.js";
import { registerGenerateCommands } from "./commands/generate.js";
import { registerEngineCommands } from "./commands/engine.js";
import { registerBrandKitCommands } from "./commands/brand-kit.js";
import { registerContentTypeCommands } from "./commands/content-types.js";
import { registerPromptCommands } from "./commands/prompts.js";
import { registerRunConfigCommands } from "./commands/run-config.js";
import { registerMemberCommands } from "./commands/members.js";
import { registerNotificationCommands } from "./commands/notifications.js";
import { registerUpdateCommand } from "./commands/update.js";

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
  .hook("preAction", async () => {
    const opts = program.opts();
    if (!opts.quiet) {
      miniBanner();
    }
  });

// Register all command groups
registerAuthCommands(program);
registerOrgCommands(program);
registerUserCommands(program);
registerApiKeyCommands(program);
registerCategoryCommands(program);
registerTopicCommands(program);
registerSearchCommands(program);
registerIngestCommands(program);
registerContentCommands(program);
registerGenerateCommands(program);
registerEngineCommands(program);
registerBrandKitCommands(program);
registerContentTypeCommands(program);
registerPromptCommands(program);
registerRunConfigCommands(program);
registerMemberCommands(program);
registerNotificationCommands(program);
registerUpdateCommand(program);

// Parse and execute
async function main() {
  const quiet =
    process.argv.includes("--quiet") ||
    (process.argv.includes("--output") &&
      process.argv[process.argv.indexOf("--output") + 1] === "json");

  // Check for updates (non-blocking, stderr only — don't await to avoid slowing startup)
  checkForUpdate(quiet).catch(() => {});

  await program.parseAsync(process.argv);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
