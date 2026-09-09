import semver from "semver";
import { Command } from "commander";
import { getLatestVersion } from "../utils/updater.js";
import { version } from "../lib/version.js";
import { CliError, EXIT } from "../lib/errors.js";
import { runAction } from "../lib/run-action.js";
import * as log from "../utils/logger.js";
import pc from "picocolors";
import { execSync } from "node:child_process";

const NPM_PACKAGE = "@senso-ai/cli";

export function registerUpdateCommand(program: Command): void {
  program
    .command("update")
    .description("Update CLI to the latest version")
    .action(
      // This command has no API payload — everything it says is progress, which
      // belongs on stderr, so it reports through the logger rather than emit().
      runAction(program, async (_ctx) => {
        log.info(`Current version: ${pc.bold(version)}`);
        log.info("Checking npm for updates...");

        const latest = await getLatestVersion();

        if (!latest) {
          throw new CliError("Could not check for updates. Try again later.", EXIT.NETWORK, {
            code: "network",
            hint: "Check your internet connection, or the npm registry you are pointed at.",
          });
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
        } catch (err) {
          throw new CliError("Update failed.", EXIT.ERROR, {
            hint: `Reinstall manually: npm install -g ${NPM_PACKAGE}`,
            cause: err,
          });
        }
        log.success(`Updated to v${latest}.`);
      }),
    );
}
