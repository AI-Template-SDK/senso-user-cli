import semver from "semver";
import { readConfig, updateConfig } from "../lib/config.js";
import { version } from "../lib/version.js";
import { updateBox } from "./branding.js";

const GITHUB_REPO = "AI-Template-SDK/senso-user-cli";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface GitHubRelease {
  tag_name: string;
  body?: string;
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
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
      {
        headers: { Accept: "application/vnd.github.v3+json" },
        signal: AbortSignal.timeout(5000),
      },
    );

    if (!res.ok) return;

    const release = (await res.json()) as GitHubRelease;
    const latest = release.tag_name.replace(/^v/, "");

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

export async function getLatestRelease(): Promise<GitHubRelease | null> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
      {
        headers: { Accept: "application/vnd.github.v3+json" },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) return null;
    return (await res.json()) as GitHubRelease;
  } catch {
    return null;
  }
}
