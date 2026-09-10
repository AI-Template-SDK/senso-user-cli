/**
 * Where the API key lives.
 *
 * One small JSON file, written with mode 0600, in the platform's standard
 * configuration directory. It is plaintext, which is a deliberate decision
 * rather than an oversight — SECURITY.md records the reasoning and what would
 * have to change to use the OS keychain instead.
 */

import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import envPaths from "env-paths";

/**
 * SENSO_CONFIG_DIR overrides the location entirely.
 *
 * It exists so the test suite and the smoke test can never read or write a real
 * developer's credentials: every test points it at a temporary directory. It is
 * also the supported way to keep separate credentials per project or per
 * environment, so it is documented rather than hidden.
 *
 * Resolved once at module load. Nothing in a single CLI invocation changes it,
 * and re-reading the environment per call invites a test that passes only
 * because of the order its cases ran in.
 */
const CONFIG_DIR = process.env.SENSO_CONFIG_DIR ?? envPaths("senso", { suffix: "" }).config;
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export interface SensoConfig {
  apiKey?: string;
  baseUrl?: string;
  orgName?: string;
  orgId?: string;
  orgSlug?: string;
  isFreeTier?: boolean;
  lastUpdateCheck?: string;
  latestVersion?: string;
}

const DEFAULT_BASE_URL = "https://apiv2.senso.ai/api/v1";

/**
 * The stored configuration, or an empty object.
 *
 * A missing file is the normal first-run state, and a corrupt one is not worth
 * failing a command over — the fields are all optional and re-derivable, so the
 * useful behavior is to act as though nothing was stored.
 */
export function readConfig(): SensoConfig {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) as SensoConfig;
  } catch {
    return {};
  }
}

export function writeConfig(config: SensoConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  // 0600: this file holds a credential, so it is readable by its owner only.
  // Passing the mode to writeFileSync only applies it when the file is created,
  // which is why login writes through this single function.
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
}

/**
 * Merge fields into the stored configuration.
 *
 * The read and the write are one synchronous block on purpose. The update
 * checker runs concurrently with the command that invoked it, and re-reading
 * immediately before writing is what stops it from writing back a snapshot
 * taken before `login` stored a key.
 */
export function updateConfig(partial: Partial<SensoConfig>): void {
  writeConfig({ ...readConfig(), ...partial });
}

export function clearConfig(): void {
  try {
    unlinkSync(CONFIG_FILE);
  } catch {
    // Already absent. `logout` when logged out is not an error.
  }
}

/**
 * The API key, by precedence: flag, then environment, then the stored file.
 *
 * `||` rather than `??` deliberately: an empty string is not a usable key, and
 * `SENSO_API_KEY=` in a CI environment should fall through to the stored value
 * rather than authenticate with "".
 */
/* eslint-disable @typescript-eslint/prefer-nullish-coalescing --
   `||` is the correct operator in both functions below, and `??` would be a
   bug. An empty string is not a usable key or URL: `SENSO_API_KEY=` in a CI
   environment, or `--api-key ""` from a shell variable that did not expand,
   must fall through to the next source rather than authenticate with "". `??`
   only falls through on null and undefined, so it would accept the empty
   string and produce a confusing 401. */

export function getApiKey(opts?: { apiKey?: string }): string | undefined {
  return opts?.apiKey || process.env.SENSO_API_KEY || readConfig().apiKey;
}

export function getBaseUrl(opts?: { baseUrl?: string }): string {
  return opts?.baseUrl || process.env.SENSO_BASE_URL || readConfig().baseUrl || DEFAULT_BASE_URL;
}

/* eslint-enable @typescript-eslint/prefer-nullish-coalescing */

export function getConfigPath(): string {
  return CONFIG_FILE;
}

export function getConfigDir(): string {
  return CONFIG_DIR;
}
