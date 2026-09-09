import semver from "semver";
import { readConfig, updateConfig } from "../lib/config.js";
import { version } from "../lib/version.js";
import { updateBox } from "./branding.js";

const NPM_PACKAGE = "@senso-ai/cli";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface NpmPackageInfo {
  "dist-tags": { latest: string };
}

export async function checkForUpdate(quiet: boolean): Promise<void> {
  if (
    process.env.SENSO_NO_UPDATE_CHECK === "1" ||
    quiet
  ) {
    return;
  }

  const config = readConfig();
  const lastCheck = config.lastUpdateCheck
    ? new Date(config.lastUpdateCheck).getTime()
    : 0;

  if (Date.now() - lastCheck < CHECK_INTERVAL_MS) {
    // Show cached result if we have one
    if (config.latestVersion && semver.gt(config.latestVersion, version)) {
      updateBox(version, config.latestVersion);
    }
    return;
  }

  // Do the check in the background — don't block the CLI
  try {
    const latest = await getLatestVersion();
    if (!latest) return;

    updateConfig({
      lastUpdateCheck: new Date().toISOString(),
      latestVersion: latest,
    });

    if (semver.gt(latest, version)) {
      updateBox(version, latest);
    }
  } catch {
    // Silently ignore — update check is best-effort
  }
}

// 3s, not 10. The check is fired without being awaited, and an outstanding
// fetch keeps the event loop alive — so this timeout is the worst-case delay
// between a command printing its output and the process exiting. It is paid at
// most once a day (the 24h gate below serves every other run from cache), and
// the cost of missing a check is that the notice appears tomorrow instead.
const REGISTRY_TIMEOUT_MS = 3_000;

export async function getLatestVersion(): Promise<string | null> {
  try {
    const res = await fetch(
      `https://registry.npmjs.org/${NPM_PACKAGE}`,
      {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
      },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as NpmPackageInfo;
    return data["dist-tags"]?.latest ?? null;
  } catch {
    return null;
  }
}
