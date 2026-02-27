import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import envPaths from "env-paths";

const paths = envPaths("senso", { suffix: "" });
const CONFIG_FILE = join(paths.config, "config.json");

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

export function readConfig(): SensoConfig {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
  } catch {
    return {};
  }
}

export function writeConfig(config: SensoConfig): void {
  mkdirSync(paths.config, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n", {
    mode: 0o600,
  });
}

export function updateConfig(partial: Partial<SensoConfig>): void {
  const config = readConfig();
  writeConfig({ ...config, ...partial });
}

export function clearConfig(): void {
  try {
    unlinkSync(CONFIG_FILE);
  } catch {
    // file didn't exist, that's fine
  }
}

export function getApiKey(opts?: { apiKey?: string }): string | undefined {
  return opts?.apiKey || process.env.SENSO_API_KEY || readConfig().apiKey;
}

export function getBaseUrl(opts?: { baseUrl?: string }): string {
  return (
    opts?.baseUrl ||
    process.env.SENSO_BASE_URL ||
    readConfig().baseUrl ||
    DEFAULT_BASE_URL
  );
}

export function getConfigPath(): string {
  return CONFIG_FILE;
}
