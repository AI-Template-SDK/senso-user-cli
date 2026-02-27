import semver from "semver";
import { Command } from "commander";
import { getLatestVersion } from "../utils/updater.js";
import { version } from "../lib/version.js";
import * as log from "../utils/logger.js";
import pc from "picocolors";
import { execSync } from "node:child_process";

const NPM_PACKAGE = "@senso-ai/cli";

export function registerUpdateCommand(program: Command): void {
  program
    .command("update")
    .description("Update CLI to the latest version")
    .action(async () => {
      log.info(`Current version: ${pc.bold(version)}`);
      log.info("Checking npm for updates...");

      const latest = await getLatestVersion();

      if (!latest) {
        log.error("Could not check for updates. Try again later.");
        process.exit(1);
      }

      if (!semver.gt(latest, version)) {
        log.success(`Already on the latest version (${version}).`);
        return;
      }

      log.info(`New version available: ${pc.bold(latest)}`);
      log.info("Updating...");

      try {
        execSync(`npm install -g ${NPM_PACKAGE}@latest`, {
          stdio: "inherit",
        });
        log.success(`Updated to v${latest}.`);
      } catch {
        log.error("Update failed. Please reinstall manually:");
        console.log(
          `  ${pc.cyan(`npm install -g ${NPM_PACKAGE}`)}`,
        );
        process.exit(1);
      }
    });
}
