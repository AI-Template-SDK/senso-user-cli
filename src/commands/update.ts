/**
 * `senso update`: replace this CLI with the newest one on npm.
 *
 * Local: nothing here touches the Senso API. It asks registry.npmjs.org what
 * the newest `@senso-ai/cli` is (3-second timeout, in utils/updater.ts) and, if
 * that is newer than the running version, shells out to npm.
 *
 * npm's output is CAPTURED rather than inherited. With `stdio: "inherit"` the
 * child writes to this process's stdout, so under `--output json` a page of npm
 * progress landed in front of the envelope and stdout stopped being one JSON
 * document. A log is a diagnostic, so it is relayed to stderr like every other
 * diagnostic, and stdout carries the outcome and nothing else.
 */

import { execSync } from "node:child_process";
import semver from "semver";
import { Command } from "commander";
import pc from "picocolors";
import { CliError, EXIT } from "../lib/errors.js";
import { describeCommand, localExits } from "../lib/help.js";
import { emitConfirmation } from "../lib/output.js";
import { runAction } from "../lib/run-action.js";
import { version } from "../lib/version.js";
import { getLatestVersion } from "../utils/updater.js";
import * as log from "../utils/logger.js";

const NPM_PACKAGE = "@senso-ai/cli";

/** The registry the version check asks, named in the failure message. */
const REGISTRY_HOST = "registry.npmjs.org";

/**
 * Run one npm command and relay its log to stderr.
 *
 * `2>&1` merges npm's stderr into the pipe this captures: execSync returns the
 * child's stdout and nothing else, and npm writes most of what is worth seeing
 * to stderr. Both halves then go out through the logger, which is stderr-only
 * and silent under `--quiet` — which `--output json` implies.
 *
 * Exported because `senso uninstall` runs `npm uninstall -g` and needs exactly
 * the same treatment; the defect this fixes was in both commands.
 */
export function runNpm(command: string, quiet: boolean): string {
  const raw: unknown = execSync(`${command} 2>&1`, {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  const output = childText(raw);
  if (!quiet && output !== "") log.raw(output);
  return output;
}

/**
 * What a child wrote, as text.
 *
 * `encoding: "utf8"` makes execSync answer with a string, but the same fields
 * on a thrown error carry a Buffer when the encoding did not apply — and a
 * Buffer stringified as an object is a line of noise rather than a log.
 */
function childText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8").trim();
  return "";
}

/** What npm printed before it failed, for the error and for the terminal. */
export function npmFailureOutput(err: unknown, quiet: boolean): string {
  const child = (typeof err === "object" && err !== null ? err : {}) as {
    stdout?: unknown;
    stderr?: unknown;
  };
  const output = [child.stdout, child.stderr].map(childText).filter(Boolean).join("\n");
  if (!quiet && output !== "") log.raw(output);
  return output;
}

export function registerUpdateCommand(program: Command): void {
  describeCommand(
    program
      .command("update")
      .description(
        "Update this CLI to the newest @senso-ai/cli published on npm. Local: asks the npm registry, then runs `npm install -g`. Nothing is sent to the Senso API.",
      )
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
              hint: `${REGISTRY_HOST} did not answer with a version within 3 seconds. Check your connection, or the registry npm is pointed at (npm config get registry), then retry.`,
            });
          }

          if (!semver.gt(latest, version)) {
            emitConfirmation(ctx, `Already on the latest version (${version}).`, {
              action: "checked",
              resource: "cli",
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
            runNpm(`npm install -g ${NPM_PACKAGE}@latest`, ctx.quiet);
          } catch (err) {
            const output = npmFailureOutput(err, ctx.quiet);
            throw new CliError("Update failed.", EXIT.ERROR, {
              hint: `npm refused the install. Re-run with the permissions npm needs, or install manually: npm install -g ${NPM_PACKAGE}`,
              details: { previous: version, latest, npm: output },
              cause: err,
            });
          }
          emitConfirmation(
            ctx,
            `Updated to v${latest}.`,
            {
              action: "updated",
              resource: "cli",
              updated: true,
              previous: version,
              latest,
            },
            {
              next: [
                { why: "Confirm the new version is the one on PATH", command: "senso --version" },
              ],
            },
          );
        }),
      ),
    {
      returns: [
        "updated — true | false:",
        "  false  the running version is already the newest on npm; npm was not run at all.",
        "  true   npm installed a newer version. The process still running is the OLD one.",
        "current — the running version, when updated is false.",
        "previous — the version that was running, when updated is true.",
        "latest — the newest version on npm, in both cases.",
        "npm's own log is relayed to stderr, never to stdout, so `--output json` stays one document.",
      ],
      exitCodes: {
        ...localExits,
        1: "npm refused the install; error.details carries what npm printed",
        5: `${REGISTRY_HOST} could not be reached, or did not answer with a version, within 3 seconds`,
      },
      notes: [
        "Needs network and a working npm. It runs `npm install -g @senso-ai/cli@latest`, so it updates the GLOBAL npm install — a copy running from npx or a git checkout is left untouched and this command will still report success.",
        "It installs the `latest` dist-tag rather than the exact version it just read, so on a publish between the two the installed version can be newer than `latest` in the payload. Confirm with `senso --version`.",
        "The new version takes effect on the NEXT invocation; this process keeps running the old code.",
        "Separate from the once-a-day update notice this CLI prints on stderr. Silence that with SENSO_NO_UPDATE_CHECK=1.",
        "An install into a system-owned prefix needs whatever permissions npm needs; this command does not elevate anything.",
      ],
      examples: [
        { command: "senso update" },
        {
          comment: "Did anything change?",
          command: "senso update --output json | jq -r '.data.updated, .data.latest'",
        },
        {
          comment: "The version actually on PATH afterwards",
          command: "senso update --quiet && senso --version",
        },
      ],
      seeAlso: ["senso --version", "senso uninstall", "senso skills install"],
    },
  );
}
