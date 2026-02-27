import semver from "semver";
import { Command } from "commander";
import { getLatestRelease } from "../utils/updater.js";
import { version } from "../lib/version.js";
import * as log from "../utils/logger.js";
import pc from "picocolors";
import { execSync } from "node:child_process";

export function registerUpdateCommand(program: Command): void {
  program
    .command("update")
    .description("Update CLI to the latest version")
    .action(async () => {
      log.info(`Current version: ${pc.bold(version)}`);
      log.info("Checking for updates...");

      const release = await getLatestRelease();

      if (!release) {
        log.error("Could not check for updates. Try again later.");
        process.exit(1);
      }

      const latest = release.tag_name.replace(/^v/, "");

      if (!semver.gt(latest, version)) {
        log.success(`Already on the latest version (${version}).`);
        return;
      }

      log.info(`New version available: ${pc.bold(latest)}`);
      log.info("Updating...");

      try {
        execSync("npm install -g senso-user-cli@latest", {
          stdio: "inherit",
        });
        log.success(`Updated to v${latest}.`);

        if (release.body) {
          console.log();
          console.log(pc.dim("Release notes:"));
          console.log(pc.dim(release.body.slice(0, 500)));
        }
      } catch {
        log.warn("Global npm install failed. Trying npx reinstall...");
        try {
          execSync(
            "npx --yes github:senso-ai/senso-user-cli --version",
            { stdio: "inherit" },
          );
          log.success("Updated via npx cache refresh.");
        } catch {
          log.error("Update failed. Please reinstall manually:");
          console.log(
            `  ${pc.cyan("npm install -g senso-user-cli")}`,
          );
          console.log(
            `  ${pc.dim("or")} ${pc.cyan("npx github:senso-ai/senso-user-cli")}`,
          );
          process.exit(1);
        }
      }
    });
}
