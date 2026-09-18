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
    const parsed: unknown = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
    // `JSON.parse("null")` SUCCEEDS and returns null, so the catch never sees
    // it and every `readConfig().x` in the codebase throws instead. A file
    // holding `null`, a string or an array is as unusable as a missing one —
    // and the whole point of `--api-key` and SENSO_API_KEY is to keep working
    // when the stored config is broken.
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed;
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
 * Where a resolved API key came from.
 *
 * Part of the `whoami` payload, so these spellings are a stable interface.
 */
export type ApiKeySource = "flag" | "env" | "config";

/**
 * How each source is named to a reader. The payloads carry the bare enum; this
 * is what appears in a sentence.
 */
export const API_KEY_SOURCE_LABELS: Record<ApiKeySource, string> = {
  flag: "--api-key",
  env: "SENSO_API_KEY",
  config: "the config file",
};

export interface ResolvedApiKey {
  key?: string;
  source?: ApiKeySource;
  /**
   * Sources that also hold a key, hold a DIFFERENT one, and were outranked.
   *
   * The interesting case is someone running `senso login` in a terminal that
   * already exports SENSO_API_KEY. `login` warns at the time, but whoever works
   * in that shell next — an agent, most of all — never saw the warning and
   * cannot otherwise tell "SENSO_API_KEY is the only key here", which is the
   * normal CI setup, from "SENSO_API_KEY is quietly shadowing the key this user
   * just logged in with", which is almost always a mistake.
   *
   * Identical keys are not listed: two sources agreeing changes nothing.
   */
  shadowed: ApiKeySource[];
}

/**
 * The API key, where it came from, and what it outranked — by precedence:
 * flag, then environment, then the stored file.
 *
 * Resolved in one pass, because the whole point of reporting the source is to
 * answer "which key is this command actually using" — and two separate walks
 * down the same precedence chain are two things that can drift apart and
 * answer differently.
 *
 * A source counts only when it holds a non-empty string. `SENSO_API_KEY=` in a
 * CI environment, or `--api-key ""` from a shell variable that did not expand,
 * falls through to the next source rather than authenticating with "" and
 * producing a confusing 401.
 *
 * Every source is read rather than short-circuited at the winner, which costs
 * one small synchronous file read on a path that already does several. Knowing
 * what was outranked is the entire feature, and it cannot be known lazily.
 */
export function resolveApiKey(opts?: { apiKey?: string }): ResolvedApiKey {
  // Trimmed once, here, so a key is judged by what would actually be sent.
  // `SENSO_API_KEY=$(cat key.txt)` and a Docker --env-file both readily carry a
  // trailing newline; Node strips it from the header anyway, so an untrimmed
  // comparison reported a key as "shadowed" by an identical one and warned
  // about a conflict that did not exist. Whitespace-only is not a key at all,
  // and falls through to the next source exactly as the empty string does.
  const candidates: { source: ApiKeySource; key: string }[] = [];
  // `raw` is typed `unknown` on purpose. `SensoConfig` describes what this CLI
  // writes, not what is on disk: the file is user-editable, so `apiKey` can be
  // a number, an object or null however the type reads. Trusting the type here
  // meant `{"apiKey": 123}` threw ".trim is not a function" out of EVERY
  // command, including ones given a perfectly good key by --api-key.
  const consider = (source: ApiKeySource, raw: unknown): void => {
    if (typeof raw !== "string") return;
    const key = raw.trim();
    if (key) candidates.push({ source, key });
  };

  consider("flag", opts?.apiKey);
  consider("env", process.env.SENSO_API_KEY);
  consider("config", readConfig().apiKey);

  const winner = candidates[0];
  if (!winner) return { shadowed: [] };

  return {
    key: winner.key,
    source: winner.source,
    shadowed: candidates
      .slice(1)
      .filter((c) => c.key !== winner.key)
      .map((c) => c.source),
  };
}

export function getApiKey(opts?: { apiKey?: string }): string | undefined {
  return resolveApiKey(opts).key;
}

/* eslint-disable @typescript-eslint/prefer-nullish-coalescing --
   `||` is the correct operator below, and `??` would be a bug, for the same
   reason resolveApiKey tests truthiness: an empty string is not a usable URL,
   and `SENSO_BASE_URL=` must fall through to the next source rather than
   produce a request against "". `??` only falls through on null and undefined,
   so it would accept the empty string. */

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
