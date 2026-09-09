import semver from "semver";
import { Command } from "commander";
import { getLatestVersion } from "../utils/updater.js";
import { version } from "../lib/version.js";
import { CliError, EXIT } from "../lib/errors.js";
import { emitConfirmation } from "../lib/output.js";
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
      // Progress belongs on stderr and is silenced by --quiet, which
      // --output json implies. The outcome is still emitted as a payload, so
      // `senso update --output json` is parseable rather than two English
      // sentences followed by nothing.
      runAction(program, async (ctx) => {
        if (!ctx.quiet) {
          log.info(`Current version: ${pc.bold(version)}`);
          log.info("Checking npm for updates...");
        }

        const latest = await getLatestVersion();

        if (!latest) {
          throw new CliError("Could not check for updates. Try again later.", EXIT.NETWORK, {
            code: "network",
            hint: "Check your internet connection, or the npm registry you are pointed at.",
          });
        }

        if (!semver.gt(latest, version)) {
          emitConfirmation(ctx, `Already on the latest version (${version}).`, {
            updated: false,
            current: version,
            latest,
          });
          return;
        }

        if (!ctx.quiet) {
          log.info(`New version available: ${pc.bold(latest)}`);
          log.info("Updating...");
        }

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
        emitConfirmation(ctx, `Updated to v${latest}.`, {
          updated: true,
          previous: version,
          latest,
        });
      }),
    );
}
