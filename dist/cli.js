#!/usr/bin/env node

// src/cli.ts
import { Command } from "commander";

// src/lib/version.ts
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { readFileSync } from "fs";
var _version = "0.0.0";
try {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  for (const dir of [__dirname, join(__dirname, ".."), join(__dirname, "../..")]) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
      if (pkg.version) {
        _version = pkg.version;
        break;
      }
    } catch {
    }
  }
} catch {
}
var version = _version;

// src/utils/branding.ts
import figlet from "figlet";
import gradient from "gradient-string";
import boxen from "boxen";
import pc from "picocolors";
var sensoGradient = gradient(["#0D9373", "#07C983"]);
function banner() {
  const ascii = figlet.textSync("SENSO", {
    font: "ANSI Shadow",
    horizontalLayout: "fitted"
  });
  const branded = sensoGradient.multiline(ascii);
  const tagline = pc.dim("        Infrastructure for the Agentic Web");
  console.log(
    boxen(`${branded}
${tagline}`, {
      padding: 1,
      margin: { top: 1, bottom: 1, left: 2, right: 2 },
      borderStyle: "round",
      borderColor: "green"
    })
  );
}
function miniBanner() {
  const title = sensoGradient("Senso CLI");
  console.log(`
  ${title} ${pc.dim(`v${version}`)}
`);
}
function updateBox(current, latest) {
  const msg = [
    `${pc.yellow("Update available!")} ${pc.dim(current)} \u2192 ${pc.green(latest)}`,
    "",
    `Run ${pc.cyan("senso update")} to update`
  ].join("\n");
  console.error(
    boxen(msg, {
      padding: 1,
      margin: { top: 1, bottom: 0, left: 2, right: 2 },
      borderStyle: "round",
      borderColor: "yellow"
    })
  );
}

// src/utils/updater.ts
import semver from "semver";

// src/lib/config.ts
import { readFileSync as readFileSync2, writeFileSync, mkdirSync, unlinkSync } from "fs";
import { join as join2 } from "path";
import envPaths from "env-paths";
var paths = envPaths("senso", { suffix: "" });
var CONFIG_FILE = join2(paths.config, "config.json");
var DEFAULT_BASE_URL = "https://apiv2.senso.ai/api/v1";
function readConfig() {
  try {
    return JSON.parse(readFileSync2(CONFIG_FILE, "utf-8"));
  } catch {
    return {};
  }
}
function writeConfig(config) {
  mkdirSync(paths.config, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n", {
    mode: 384
  });
}
function updateConfig(partial) {
  const config = readConfig();
  writeConfig({ ...config, ...partial });
}
function clearConfig() {
  try {
    unlinkSync(CONFIG_FILE);
  } catch {
  }
}
function getApiKey(opts) {
  return opts?.apiKey || process.env.SENSO_API_KEY || readConfig().apiKey;
}
function getBaseUrl(opts) {
  return opts?.baseUrl || process.env.SENSO_BASE_URL || readConfig().baseUrl || DEFAULT_BASE_URL;
}
function getConfigPath() {
  return CONFIG_FILE;
}

// src/utils/updater.ts
var NPM_PACKAGE = "@senso-ai/cli";
var CHECK_INTERVAL_MS = 24 * 60 * 60 * 1e3;
async function checkForUpdate(quiet) {
  if (process.env.SENSO_NO_UPDATE_CHECK === "1" || quiet) {
    return;
  }
  const config = readConfig();
  const lastCheck = config.lastUpdateCheck ? new Date(config.lastUpdateCheck).getTime() : 0;
  if (Date.now() - lastCheck < CHECK_INTERVAL_MS) {
    if (config.latestVersion && semver.gt(config.latestVersion, version)) {
      updateBox(version, config.latestVersion);
    }
    return;
  }
  try {
    const latest = await getLatestVersion();
    if (!latest) return;
    updateConfig({
      lastUpdateCheck: (/* @__PURE__ */ new Date()).toISOString(),
      latestVersion: latest
    });
    if (semver.gt(latest, version)) {
      updateBox(version, latest);
    }
  } catch {
  }
}
async function getLatestVersion() {
  try {
    const res = await fetch(
      `https://registry.npmjs.org/${NPM_PACKAGE}`,
      {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(1e4)
      }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data["dist-tags"]?.latest ?? null;
  } catch {
    return null;
  }
}

// src/commands/auth.ts
import * as p from "@clack/prompts";
import pc3 from "picocolors";

// src/lib/api-client.ts
var ApiError = class extends Error {
  constructor(status, statusText, body) {
    const msg = typeof body === "object" && body ? "error" in body ? body.error : "message" in body ? body.message : statusText : statusText;
    super(msg);
    this.status = status;
    this.statusText = statusText;
    this.body = body;
    this.name = "ApiError";
  }
};
async function apiRequest(opts) {
  const apiKey = getApiKey({ apiKey: opts.apiKey });
  if (!apiKey) {
    throw new Error(
      "No API key found. Run `senso login` or set SENSO_API_KEY."
    );
  }
  const baseUrl = getBaseUrl({ baseUrl: opts.baseUrl });
  const url = new URL(`${baseUrl}${opts.path}`);
  if (opts.params) {
    for (const [key, val] of Object.entries(opts.params)) {
      if (val !== void 0) {
        url.searchParams.set(key, String(val));
      }
    }
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3e4);
  try {
    const res = await fetch(url.toString(), {
      method: opts.method || "GET",
      headers: {
        "X-API-Key": apiKey,
        Accept: "application/json",
        ...opts.body ? { "Content-Type": "application/json" } : {},
        "User-Agent": `senso-cli/${version}`
      },
      body: opts.body ? JSON.stringify(opts.body) : void 0,
      signal: controller.signal
    });
    if (!res.ok) {
      let body;
      const text3 = await res.text();
      try {
        body = JSON.parse(text3);
      } catch {
        body = text3;
      }
      throw new ApiError(res.status, res.statusText, body);
    }
    if (res.status === 204) {
      return void 0;
    }
    const text2 = await res.text();
    try {
      return JSON.parse(text2);
    } catch {
      throw new Error(`Invalid JSON response from ${opts.path}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}
function formatApiError(err) {
  if (err instanceof ApiError) {
    switch (err.status) {
      case 401:
        return "Authentication failed. Run `senso login` to update your API key.";
      case 402:
        return "Insufficient credits or spending limit reached. Check your plan at https://app.senso.ai.";
      case 403:
        return `Permission denied: ${err.message}`;
      case 404:
        return "Resource not found.";
      case 409:
        return `Conflict: ${err.message}`;
      default:
        if (err.status >= 500) {
          return "Server error. Try again later.";
        }
        return `API error (${err.status}): ${err.message}`;
    }
  }
  if (err instanceof Error) {
    if (err.name === "AbortError") {
      return "Request timed out. Try again later.";
    }
    if (err.message.includes("fetch failed") || err.message.includes("ECONNREFUSED")) {
      return "Could not connect to Senso API. Check your internet connection.";
    }
    return err.message;
  }
  return String(err);
}

// src/utils/logger.ts
import pc2 from "picocolors";
function success(msg) {
  console.log(`  ${pc2.green("\u2713")} ${msg}`);
}
function error(msg) {
  console.error(`  ${pc2.red("\u2717")} ${msg}`);
}
function warn(msg) {
  console.error(`  ${pc2.yellow("!")} ${msg}`);
}
function info(msg) {
  console.log(`  ${pc2.cyan("\u2139")} ${msg}`);
}

// src/commands/auth.ts
async function verifyApiKey(apiKey, baseUrl) {
  return apiRequest({
    path: "/org/me",
    apiKey,
    baseUrl
  });
}
function registerAuthCommands(program2) {
  program2.command("login").description("Authenticate with Senso. Paste your API key and it will be validated against your organization, then stored locally.").action(async () => {
    const opts = program2.opts();
    banner();
    console.log(`  ${pc3.bold("Welcome to Senso CLI!")}
`);
    console.log(`  ${pc3.dim("1.")} Go to ${pc3.cyan("https://docs.senso.ai")} to create an account`);
    console.log(`  ${pc3.dim("2.")} Generate an API key from your dashboard
`);
    const result = await p.text({
      message: "Paste your API key:",
      placeholder: "tgr_...",
      validate: (val) => {
        if (!val || val.trim().length < 4) return "API key is required";
      }
    });
    if (p.isCancel(result)) {
      p.cancel("Login cancelled.");
      process.exit(0);
    }
    const apiKey = result.trim();
    const spin = p.spinner();
    spin.start("Verifying API key...");
    try {
      const org = await verifyApiKey(apiKey, opts.baseUrl);
      spin.stop("API key verified");
      writeConfig({
        apiKey,
        ...opts.baseUrl ? { baseUrl: opts.baseUrl } : {},
        orgName: org.name,
        orgId: org.org_id,
        orgSlug: org.slug,
        isFreeTier: org.is_free_tier
      });
      success(`Authenticated as ${pc3.bold(`"${org.name}"`)} (${pc3.dim(org.org_id)})`);
      success(`Config saved to ${pc3.dim(getConfigPath())}`);
      console.log();
    } catch (err) {
      spin.stop("Verification failed");
      error(formatApiError(err));
      process.exit(1);
    }
  });
  program2.command("logout").description("Remove stored API key and organization info from local config.").action(() => {
    clearConfig();
    success("Credentials removed.");
  });
  program2.command("whoami").description("Show which organization you are authenticated as, including org ID, slug, tier, and API key prefix.").action(async () => {
    const opts = program2.opts();
    const apiKey = getApiKey({ apiKey: opts.apiKey });
    if (!apiKey) {
      error("Not logged in. Run `senso login` to authenticate.");
      process.exit(1);
    }
    const config = readConfig();
    try {
      const org = await verifyApiKey(apiKey, opts.baseUrl);
      const format = opts.output || "plain";
      if (format === "json") {
        console.log(
          JSON.stringify({
            orgId: org.org_id,
            orgName: org.name,
            orgSlug: org.slug,
            isFreeTier: org.is_free_tier,
            apiKeyPrefix: apiKey.slice(0, 8) + "..."
          }, null, 2)
        );
      } else {
        console.log();
        console.log(`  ${pc3.bold("Organization:")}  ${org.name}`);
        console.log(`  ${pc3.bold("Org ID:")}        ${org.org_id}`);
        console.log(`  ${pc3.bold("Slug:")}          ${org.slug}`);
        console.log(`  ${pc3.bold("Tier:")}          ${org.is_free_tier ? "Free" : "Paid"}`);
        console.log(`  ${pc3.bold("API Key:")}       ${apiKey.slice(0, 8)}...`);
        console.log(`  ${pc3.bold("Config:")}        ${getConfigPath()}`);
        console.log();
      }
    } catch (err) {
      if (config.orgName) {
        warn(`Could not reach API: ${formatApiError(err)}`);
        console.log(`  ${pc3.bold("Organization:")}  ${config.orgName} ${pc3.dim("(cached)")}`);
        console.log(`  ${pc3.bold("Org ID:")}        ${config.orgId}`);
      } else {
        error(formatApiError(err));
        process.exit(1);
      }
    }
  });
}

// src/commands/org.ts
function registerOrgCommands(program2) {
  const org = program2.command("org").description("View and update organization profile and settings. Includes name, slug, logo, websites, locations, and tier information.");
  org.command("get").description("Get full organization details including name, slug, tier, websites, locations, configured AI models, publishers, and schedule.").action(async () => {
    const opts = program2.opts();
    try {
      const data = await apiRequest({ path: "/org/me", apiKey: opts.apiKey, baseUrl: opts.baseUrl });
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  org.command("update").description("Update organization details. All fields are optional \u2014 only provided fields are changed. Pass an empty array for websites/locations to clear them.").requiredOption("--data <json>", 'JSON: { "name": "...", "slug": "...", "logo_url": "...", "websites": [...], "locations": [...] }').action(async (cmdOpts) => {
    const opts = program2.opts();
    try {
      const body = JSON.parse(cmdOpts.data);
      const data = await apiRequest({
        method: "PUT",
        path: "/org/me",
        body,
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl
      });
      success("Organization updated.");
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(err instanceof SyntaxError ? "Invalid JSON in --data" : formatApiError(err));
      process.exit(1);
    }
  });
}

// src/commands/users.ts
function registerUserCommands(program2) {
  const users = program2.command("users").description("Manage users within the organization. Add, update roles, remove users, or set the active organization for a user.");
  users.command("list").description("List all users in the organization. Returns user IDs, roles, and membership status.").option("--limit <n>", "Maximum number of users to return").option("--offset <n>", "Number of users to skip (for pagination)").action(async (cmdOpts) => {
    const opts = program2.opts();
    try {
      const data = await apiRequest({
        path: "/org/users",
        params: { limit: cmdOpts.limit, offset: cmdOpts.offset },
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl
      });
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  users.command("add").description("Add an existing platform user to the organization. Requires user_id and role_id.").requiredOption("--data <json>", 'JSON: { "user_id": "uuid", "role_id": "uuid", "is_current": false }').action(async (cmdOpts) => {
    const opts = program2.opts();
    try {
      const body = JSON.parse(cmdOpts.data);
      const data = await apiRequest({
        method: "POST",
        path: "/org/users",
        body,
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl
      });
      success("User added.");
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(err instanceof SyntaxError ? "Invalid JSON in --data" : formatApiError(err));
      process.exit(1);
    }
  });
  users.command("get <userId>").description("Get a user's details including their role and membership status in the organization.").action(async (userId) => {
    const opts = program2.opts();
    try {
      const data = await apiRequest({ path: `/org/users/${userId}`, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  users.command("update <userId>").description("Update a user's role in the organization. Requires role_id in the JSON body.").requiredOption("--data <json>", 'JSON: { "role_id": "uuid", "is_current": true }').action(async (userId, cmdOpts) => {
    const opts = program2.opts();
    try {
      const body = JSON.parse(cmdOpts.data);
      const data = await apiRequest({
        method: "PUT",
        path: `/org/users/${userId}`,
        body,
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl
      });
      success(`User ${userId} updated.`);
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(err instanceof SyntaxError ? "Invalid JSON in --data" : formatApiError(err));
      process.exit(1);
    }
  });
  users.command("remove <userId>").description("Remove a user from the organization. This does not delete the platform user account.").action(async (userId) => {
    const opts = program2.opts();
    try {
      await apiRequest({ method: "DELETE", path: `/org/users/${userId}`, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
      success(`User ${userId} removed.`);
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  users.command("set-current <userId>").description("Set this organization as the current (active) organization for a user.").action(async (userId) => {
    const opts = program2.opts();
    try {
      await apiRequest({
        method: "PATCH",
        path: `/org/users/${userId}/current`,
        body: { is_current: true },
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl
      });
      success(`Organization set as current for user ${userId}.`);
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
}

// src/commands/api-keys.ts
function registerApiKeyCommands(program2) {
  const keys = program2.command("api-keys").description("Manage org-scoped API keys. Create, rotate, revoke, or list API keys used to authenticate with the Senso API.");
  keys.command("list").description("List all API keys for the organization. Shows name, expiry, revocation status, and last usage.").option("--limit <n>", "Maximum number of keys to return").option("--offset <n>", "Number of keys to skip (for pagination)").action(async (cmdOpts) => {
    const opts = program2.opts();
    try {
      const data = await apiRequest({
        path: "/org/api-keys",
        params: { limit: cmdOpts.limit, offset: cmdOpts.offset },
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl
      });
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  keys.command("create").description("Create a new API key. The key value is returned only once \u2014 store it securely.").requiredOption("--data <json>", 'JSON: { "name": "my-key", "expires_at": "2025-12-31T00:00:00Z" }').action(async (cmdOpts) => {
    const opts = program2.opts();
    try {
      const body = JSON.parse(cmdOpts.data);
      const data = await apiRequest({
        method: "POST",
        path: "/org/api-keys",
        body,
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl
      });
      success("API key created.");
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(err instanceof SyntaxError ? "Invalid JSON in --data" : formatApiError(err));
      process.exit(1);
    }
  });
  keys.command("get <keyId>").description("Get details for a specific API key including name, expiry, and last used timestamp.").action(async (keyId) => {
    const opts = program2.opts();
    try {
      const data = await apiRequest({ path: `/org/api-keys/${keyId}`, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  keys.command("update <keyId>").description("Update an API key's name or expiry date.").requiredOption("--data <json>", 'JSON: { "name": "new-name", "expires_at": "2026-06-01T00:00:00Z" }').action(async (keyId, cmdOpts) => {
    const opts = program2.opts();
    try {
      const body = JSON.parse(cmdOpts.data);
      const data = await apiRequest({
        method: "PUT",
        path: `/org/api-keys/${keyId}`,
        body,
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl
      });
      success(`API key ${keyId} updated.`);
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(err instanceof SyntaxError ? "Invalid JSON in --data" : formatApiError(err));
      process.exit(1);
    }
  });
  keys.command("delete <keyId>").description("Permanently delete an API key. This cannot be undone.").action(async (keyId) => {
    const opts = program2.opts();
    try {
      await apiRequest({ method: "DELETE", path: `/org/api-keys/${keyId}`, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
      success(`API key ${keyId} deleted.`);
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  keys.command("revoke <keyId>").description("Revoke an API key. The key remains visible but can no longer be used for authentication.").action(async (keyId) => {
    const opts = program2.opts();
    try {
      await apiRequest({ method: "POST", path: `/org/api-keys/${keyId}/revoke`, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
      success(`API key ${keyId} revoked.`);
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  keys.command("kb-permissions-get <keyId>").description("Get the knowledge base node permission grants configured for an API key.").action(async (keyId) => {
    const opts = program2.opts();
    try {
      const data = await apiRequest({ path: `/org/api-keys/${keyId}/kb-permissions`, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  keys.command("kb-permissions-set <keyId>").description("Set KB node permission grants for an API key. Replaces any existing grants. Each grant requires a node_id (UUID) and role (viewer|editor|owner|admin).").requiredOption("--data <json>", 'JSON: { "grants": [{ "node_id": "<uuid>", "role": "viewer" }] }').action(async (keyId, cmdOpts) => {
    const opts = program2.opts();
    try {
      const body = JSON.parse(cmdOpts.data);
      const data = await apiRequest({ method: "PUT", path: `/org/api-keys/${keyId}/kb-permissions`, body, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
      success(`KB permissions updated for key ${keyId}.`);
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(err instanceof SyntaxError ? "Invalid JSON in --data" : formatApiError(err));
      process.exit(1);
    }
  });
  keys.command("kb-permissions-delete <keyId>").description("Remove all KB node permission grants from an API key, restoring full org-level access.").action(async (keyId) => {
    const opts = program2.opts();
    try {
      await apiRequest({ method: "DELETE", path: `/org/api-keys/${keyId}/kb-permissions`, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
      success(`KB permissions removed from key ${keyId}.`);
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
}

// src/commands/search.ts
import pc5 from "picocolors";

// src/lib/output.ts
import pc4 from "picocolors";
function outputJson(data) {
  console.log(JSON.stringify(data, null, 2));
}
function outputTable(rows, columns) {
  if (rows.length === 0) {
    console.log(pc4.dim("  No results."));
    return;
  }
  const cols = columns || Object.keys(rows[0]);
  const widths = cols.map((col) => {
    const maxVal = rows.reduce(
      (max, row) => Math.max(max, String(row[col] ?? "").length),
      0
    );
    return Math.max(col.length, maxVal);
  });
  const header = cols.map((col, i) => pc4.bold(col.padEnd(widths[i]))).join("  ");
  console.log(`  ${header}`);
  console.log(`  ${widths.map((w) => "\u2500".repeat(w)).join("  ")}`);
  for (const row of rows) {
    const line = cols.map((col, i) => String(row[col] ?? "").padEnd(widths[i])).join("  ");
    console.log(`  ${line}`);
  }
}
function outputPlain(lines) {
  const arr = Array.isArray(lines) ? lines : [lines];
  for (const line of arr) {
    console.log(line);
  }
}
function output(format, data) {
  switch (format) {
    case "json":
      outputJson(data.json);
      break;
    case "table":
      if (data.table) {
        outputTable(data.table.rows, data.table.columns);
      } else {
        outputJson(data.json);
      }
      break;
    case "plain":
      outputPlain(data.plain);
      break;
  }
}

// src/commands/search.ts
function parseMaxResults(value) {
  const n = parseInt(value);
  if (isNaN(n) || n < 1) return 5;
  return Math.min(n, 20);
}
function registerSearchCommands(program2) {
  const search = program2.command("search").description("Search the knowledge base with natural language queries. Returns AI-generated answers synthesised from matching content chunks, or raw chunks/content IDs.");
  search.argument("<query>", "Search query").option("--max-results <n>", "Maximum number of results (max: 20)", "5").option("--content-ids <ids...>", "Restrict search to specific content item IDs (space-separated UUIDs)").option("--require-scoped-ids", "Only return results from the specified --content-ids (omit to allow fallback to all content)").action(async (query, cmdOpts) => {
    const opts = program2.opts();
    try {
      const body = { query, max_results: parseMaxResults(cmdOpts.maxResults) };
      if (cmdOpts.contentIds) body.content_ids = cmdOpts.contentIds;
      if (cmdOpts.requireScopedIds) body.require_scoped_ids = true;
      const data = await apiRequest({
        method: "POST",
        path: "/org/search",
        body,
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl
      });
      const format = opts.output || "plain";
      const res = data;
      output(format, {
        json: data,
        table: res.results ? {
          rows: res.results.map((r) => ({
            id: r.content_id,
            title: r.title,
            text: String(r.chunk_text || "").slice(0, 80)
          })),
          columns: ["id", "title", "text"]
        } : void 0,
        plain: [
          "",
          res.answer ? `  ${pc5.bold("Answer:")} ${res.answer}` : "",
          "",
          ...(res.results || []).map(
            (r, i) => `  ${pc5.dim(`${i + 1}.`)} ${pc5.bold(String(r.title || "Untitled"))}
     ${String(r.chunk_text || "").slice(0, 120)}
     ${pc5.dim(`ID: ${r.content_id}`)}`
          ),
          ""
        ].filter(Boolean)
      });
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  search.command("context <query>").description("Search the knowledge base \u2014 returns matching content chunks only, without AI answer generation. Use this to feed verified chunks into your own LLM pipeline instead of using Senso's generated answer.").option("--max-results <n>", "Maximum results (max: 20)", "5").option("--content-ids <ids...>", "Restrict search to specific content item IDs (space-separated UUIDs)").option("--require-scoped-ids", "Only return results from the specified --content-ids").action(async (query, cmdOpts) => {
    const opts = program2.opts();
    try {
      const body = { query, max_results: parseMaxResults(cmdOpts.maxResults) };
      if (cmdOpts.contentIds) body.content_ids = cmdOpts.contentIds;
      if (cmdOpts.requireScopedIds) body.require_scoped_ids = true;
      const data = await apiRequest({
        method: "POST",
        path: "/org/search/context",
        body,
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl
      });
      outputByFormat(opts.output, data);
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  search.command("content <query>").description("Search the knowledge base \u2014 returns deduplicated content IDs and titles only. Use this to discover which documents are relevant before fetching full content with 'content get <id>'.").option("--max-results <n>", "Maximum results (max: 20)", "5").option("--content-ids <ids...>", "Restrict search to specific content item IDs (space-separated UUIDs)").option("--require-scoped-ids", "Only return results from the specified --content-ids").action(async (query, cmdOpts) => {
    const opts = program2.opts();
    try {
      const body = { query, max_results: parseMaxResults(cmdOpts.maxResults) };
      if (cmdOpts.contentIds) body.content_ids = cmdOpts.contentIds;
      if (cmdOpts.requireScopedIds) body.require_scoped_ids = true;
      const data = await apiRequest({
        method: "POST",
        path: "/org/search/content",
        body,
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl
      });
      outputByFormat(opts.output, data);
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  search.command("full <query>").description("Alias for the default search \u2014 returns AI answer plus matching chunks. Equivalent to 'senso search <query>'.").option("--max-results <n>", "Maximum results (max: 20)", "5").option("--content-ids <ids...>", "Restrict search to specific content item IDs (space-separated UUIDs)").option("--require-scoped-ids", "Only return results from the specified --content-ids").action(async (query, cmdOpts) => {
    const opts = program2.opts();
    try {
      const body = { query, max_results: parseMaxResults(cmdOpts.maxResults) };
      if (cmdOpts.contentIds) body.content_ids = cmdOpts.contentIds;
      if (cmdOpts.requireScopedIds) body.require_scoped_ids = true;
      const data = await apiRequest({
        method: "POST",
        path: "/org/search/full",
        body,
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl
      });
      outputByFormat(opts.output, data);
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
}
function outputByFormat(format, data) {
  if (format === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
}

// src/commands/ingest.ts
import { createHash } from "crypto";
import { readFile, stat } from "fs/promises";
import { basename, resolve } from "path";
var MIME_TYPES = {
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".html": "text/html",
  ".htm": "text/html",
  ".md": "text/markdown",
  ".json": "application/json",
  ".xml": "application/xml"
};
function getMimeType(filename) {
  const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  return MIME_TYPES[ext] || "application/octet-stream";
}
async function getFileMetadata(filePath) {
  const absPath = resolve(filePath);
  const buffer = await readFile(absPath);
  const stats = await stat(absPath);
  const hash = createHash("md5").update(buffer).digest("hex");
  return {
    meta: {
      filename: basename(absPath),
      file_size_bytes: stats.size,
      content_type: getMimeType(basename(absPath)),
      content_hash_md5: hash
    },
    buffer
  };
}
async function uploadToS3(url, buffer, contentType) {
  const res = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: buffer
  });
  if (!res.ok) {
    throw new Error(`S3 upload failed: ${res.status} ${res.statusText}`);
  }
}
function registerIngestCommands(program2) {
  const ingest = program2.command("ingest").description("Ingest files into the knowledge base. Upload documents (PDF, TXT, DOCX, etc.) to be parsed, chunked, and embedded for semantic search.");
  ingest.command("upload <files...>").description("Upload files to the knowledge base. Accepts local file paths (up to 10). Files are hashed, uploaded to S3, then parsed and embedded by a background worker. Poll 'senso content get <content-id>' until processing_status is 'complete' before searching the uploaded content.").action(async (files) => {
    const opts = program2.opts();
    if (files.length > 10) {
      error("Maximum 10 files per upload request.");
      process.exit(1);
    }
    try {
      const fileData = await Promise.all(files.map(getFileMetadata));
      const response = await apiRequest({
        method: "POST",
        path: "/org/kb/upload",
        body: { files: fileData.map((f) => f.meta) },
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl
      });
      const items = response.results ?? [];
      let uploaded = 0;
      for (const item of items) {
        if (item.status === "upload_pending" && item.upload_url) {
          const match = fileData.find((f) => f.meta.filename === item.filename);
          if (!match) {
            error(`Could not match server filename "${item.filename}" to a local file \u2014 skipping upload.`);
            continue;
          }
          try {
            await uploadToS3(item.upload_url, match.buffer, match.meta.content_type);
            uploaded++;
            success(`Uploaded ${item.filename} (content_id: ${item.content_id})`);
          } catch (uploadErr) {
            error(`S3 upload failed for ${item.filename}: ${uploadErr instanceof Error ? uploadErr.message : String(uploadErr)}`);
          }
        } else {
          warn(`Skipped ${item.filename}: ${item.status}${item.error ? ` \u2014 ${item.error}` : ""}`);
        }
      }
      if (uploaded > 0) {
        success(`${uploaded} file(s) uploaded. Background processing will parse, chunk, and embed them.`);
      }
      if (opts.output === "json") {
        console.log(JSON.stringify(response, null, 2));
      }
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  ingest.command("reprocess <nodeId> <file>").description("Re-ingest an existing document with a new file version. Provide the KB node ID (kb_node_id) and the path to the replacement file.").action(async (nodeId, file) => {
    const opts = program2.opts();
    try {
      const { meta, buffer } = await getFileMetadata(file);
      const item = await apiRequest({
        method: "PUT",
        path: `/org/kb/nodes/${nodeId}/file`,
        body: { file: meta },
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl
      });
      if (item.status === "upload_pending" && item.upload_url) {
        await uploadToS3(item.upload_url, buffer, meta.content_type);
        success(`Uploaded ${meta.filename} for node ${nodeId}. Background re-processing started.`);
      } else {
        warn(`Skipped: ${item.status}${item.error ? ` \u2014 ${item.error}` : ""}`);
      }
      if (opts.output === "json") {
        console.log(JSON.stringify(item, null, 2));
      }
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
}

// src/commands/content.ts
import pc6 from "picocolors";
function registerContentCommands(program2) {
  const content = program2.command("content").description("Manage content items in the knowledge base. List, inspect, delete, unpublish, and manage the verification workflow and ownership of content.");
  content.command("list").description("List top-level files and folders in the knowledge base. Use 'kb my-files' for the same result with richer KB node output.").option("--limit <n>", "Items per page", "10").option("--offset <n>", "Pagination offset", "0").action(async (cmdOpts) => {
    const opts = program2.opts();
    try {
      const data = await apiRequest({
        path: "/org/kb/my-files",
        params: { limit: cmdOpts.limit, offset: cmdOpts.offset },
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl
      });
      const format = opts.output || "plain";
      const rows = Array.isArray(data) ? data : data.nodes ?? [];
      output(format, {
        json: data,
        table: {
          rows: rows.map((r) => ({
            id: r.kb_node_id,
            name: r.name,
            type: r.type,
            status: r.processing_status
          })),
          columns: ["id", "name", "type", "status"]
        },
        plain: rows.length ? rows.map(
          (r) => `  ${pc6.bold(String(r.name || "Untitled"))} ${pc6.dim(`(${r.kb_node_id})`)} ${r.type ? pc6.dim(`[${r.type}]`) : ""}`
        ) : ["  No content found."]
      });
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  content.command("get <id>").description("Get a content item by ID. Returns the full content detail including versions, metadata, and publish status.").action(async (id) => {
    const opts = program2.opts();
    try {
      const data = await apiRequest({ path: `/org/content/${id}`, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  content.command("delete <id>").description("Delete a content item from the knowledge base and any external publish destinations. This cannot be undone.").action(async (id) => {
    const opts = program2.opts();
    try {
      await apiRequest({ method: "DELETE", path: `/org/content/${id}`, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
      success(`Content ${id} deleted.`);
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  content.command("unpublish <id>").description("Unpublish a content item. Removes it from external destinations and sets its status back to draft.").action(async (id) => {
    const opts = program2.opts();
    try {
      await apiRequest({ method: "POST", path: `/org/content/${id}/unpublish`, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
      success(`Content ${id} unpublished.`);
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  content.command("verification").description("List content items in the verification workflow. Filter by editorial status (draft, review, rejected, published) to manage the review pipeline.").option("--limit <n>", "Maximum items to return").option("--offset <n>", "Number of items to skip (for pagination)").option("--search <query>", "Filter by title").option("--status <status>", "Filter by status: all, draft, review, rejected, published").action(async (cmdOpts) => {
    const opts = program2.opts();
    try {
      const data = await apiRequest({
        path: "/org/content/verification",
        params: { limit: cmdOpts.limit, offset: cmdOpts.offset, search: cmdOpts.search, status: cmdOpts.status },
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl
      });
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  content.command("reject <versionId>").description("Reject a content version in the verification workflow. Optionally provide a reason for the rejection.").option("--reason <text>", "Reason for rejection").action(async (versionId, cmdOpts) => {
    const opts = program2.opts();
    try {
      const body = cmdOpts.reason ? { reason: cmdOpts.reason } : void 0;
      await apiRequest({ method: "POST", path: `/org/content/versions/${versionId}/reject`, body, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
      success(`Version ${versionId} rejected.`);
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  content.command("restore <versionId>").description("Restore a rejected content version back to draft status for further editing.").action(async (versionId) => {
    const opts = program2.opts();
    try {
      await apiRequest({ method: "POST", path: `/org/content/versions/${versionId}/restore`, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
      success(`Version ${versionId} restored to draft.`);
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  content.command("owners <id>").description("List the owners assigned to a content item. Owners are responsible for reviewing and approving content.").action(async (id) => {
    const opts = program2.opts();
    try {
      const data = await apiRequest({ path: `/org/content/${id}/owners`, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  content.command("set-owners <id>").description("Replace all owners of a content item with a new set of user IDs.").requiredOption("--user-ids <ids...>", "User IDs to set as owners").action(async (id, cmdOpts) => {
    const opts = program2.opts();
    try {
      await apiRequest({
        method: "PUT",
        path: `/org/content/${id}/owners`,
        body: { user_ids: cmdOpts.userIds },
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl
      });
      success(`Owners updated for content ${id}.`);
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  content.command("remove-owner <id> <userId>").description("Remove a single owner from a content item.").action(async (id, userId) => {
    const opts = program2.opts();
    try {
      await apiRequest({ method: "DELETE", path: `/org/content/${id}/owners/${userId}`, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
      success(`Owner ${userId} removed from content ${id}.`);
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
}

// src/commands/generate.ts
function registerGenerateCommands(program2) {
  const gen = program2.command("generate").description("AI content generation. Configure settings, generate content samples from prompts, or trigger full content engine runs.");
  gen.command("settings").description("Get content generation settings. Shows whether generation and auto-publish are enabled, the content schedule, and configured publishers.").action(async () => {
    const opts = program2.opts();
    try {
      const data = await apiRequest({ path: "/org/content-generation", apiKey: opts.apiKey, baseUrl: opts.baseUrl });
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  gen.command("update-settings").description("Update content generation settings. Control auto-publish, generation toggle, and schedule (days of week 0-6).").requiredOption("--data <json>", 'JSON settings: { "enable_content_generation": bool, "content_auto_publish": bool, "content_schedule": [0-6], "selected_content_type_id": "<uuid>" }').action(async (cmdOpts) => {
    const opts = program2.opts();
    try {
      const body = JSON.parse(cmdOpts.data);
      const data = await apiRequest({ method: "PATCH", path: "/org/content-generation", body, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
      success("Content generation settings updated.");
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(err instanceof SyntaxError ? "Invalid JSON in --data" : formatApiError(err));
      process.exit(1);
    }
  });
  gen.command("sample").description("Generate an ad hoc content sample for a specific prompt and content type. Returns the generated markdown, SEO title, and publish results. Use 'prompts list' to find a prompt ID, and 'content-types list' to find a content-type ID.").requiredOption("--prompt-id <id>", "Prompt (geo question) ID to generate content for").requiredOption("--content-type-id <id>", "Content type ID that defines the output format (use 'content-types list' to find)").option("--destination <dest>", "Publisher slug to publish to immediately after generation. Omit to save as draft only.").action(async (cmdOpts) => {
    const opts = program2.opts();
    try {
      const body = {
        geo_question_id: cmdOpts.promptId,
        content_type_id: cmdOpts.contentTypeId
      };
      if (cmdOpts.destination) {
        body.publish_destination = cmdOpts.destination;
      }
      const data = await apiRequest({
        method: "POST",
        path: "/org/content-generation/sample",
        body,
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl
      });
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  gen.command("run").description("Trigger a content generation run. Processes all prompts (or a specific subset) through the content engine. Runs asynchronously \u2014 use 'generate runs-list' to monitor progress.").option("--prompt-ids <ids...>", "Optional list of prompt IDs to process (omit to run all)").option("--content-type-id <id>", "Override the org's default content type for this run").option("--publisher-ids <ids...>", "Restrict publishing to specific publisher IDs").action(async (cmdOpts) => {
    const opts = program2.opts();
    try {
      const body = {};
      if (cmdOpts.promptIds) body.prompt_ids = cmdOpts.promptIds;
      if (cmdOpts.contentTypeId) body.content_type_id = cmdOpts.contentTypeId;
      if (cmdOpts.publisherIds) body.publisher_ids = cmdOpts.publisherIds;
      const data = await apiRequest({ method: "POST", path: "/org/content-generation/run", body: Object.keys(body).length > 0 ? body : {}, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
      success("Content generation run triggered.");
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  gen.command("job-context").description("Get the full content generation job context \u2014 all prompts with queue status (create vs update), content state, and a summary of queue counts.").action(async () => {
    const opts = program2.opts();
    try {
      const data = await apiRequest({ path: "/org/content-generation/job-context", apiKey: opts.apiKey, baseUrl: opts.baseUrl });
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  gen.command("runs-list").description("List content generation runs for the org. Use --status to filter by run status, --active-only to show only in-progress runs.").option("--limit <n>", "Items per page", "20").option("--offset <n>", "Pagination offset", "0").option("--status <status>", "Filter by run status").option("--active-only", "Only return active (in-progress) runs").option("--start-date <date>", "Filter runs on or after this date (YYYY-MM-DD)").option("--end-date <date>", "Filter runs on or before this date (YYYY-MM-DD)").action(async (cmdOpts) => {
    const opts = program2.opts();
    try {
      const data = await apiRequest({
        path: "/org/content-generation/runs",
        params: {
          limit: cmdOpts.limit,
          offset: cmdOpts.offset,
          status: cmdOpts.status,
          active_only: cmdOpts.activeOnly ? "true" : void 0,
          start_date: cmdOpts.startDate,
          end_date: cmdOpts.endDate
        },
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl
      });
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  gen.command("runs-get <runId>").description("Get details for a specific content generation run.").action(async (runId) => {
    const opts = program2.opts();
    try {
      const data = await apiRequest({ path: `/org/content-generation/runs/${runId}`, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  gen.command("runs-items <runId>").description("List individual prompt items within a content generation run and their per-item status.").option("--limit <n>", "Items per page", "100").option("--offset <n>", "Pagination offset", "0").action(async (runId, cmdOpts) => {
    const opts = program2.opts();
    try {
      const data = await apiRequest({
        path: `/org/content-generation/runs/${runId}/items`,
        params: { limit: cmdOpts.limit, offset: cmdOpts.offset },
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl
      });
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  gen.command("runs-logs <runId>").description("List log entries for a content generation run.").option("--limit <n>", "Items per page", "100").option("--offset <n>", "Pagination offset", "0").action(async (runId, cmdOpts) => {
    const opts = program2.opts();
    try {
      const data = await apiRequest({
        path: `/org/content-generation/runs/${runId}/logs`,
        params: { limit: cmdOpts.limit, offset: cmdOpts.offset },
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl
      });
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
}

// src/commands/engine.ts
function registerEngineCommands(program2) {
  const engine = program2.command("engine").description("Publish or draft content through the content engine. Used to push AI-generated content to external destinations or save it as a draft for review.");
  engine.command("publish").description("Publish content to external destinations via the content engine. Requires geo_question_id, raw_markdown, and seo_title.").requiredOption("--data <json>", 'JSON: { "geo_question_id": "uuid", "raw_markdown": "...", "seo_title": "...", "summary": "..." }').action(async (cmdOpts) => {
    const opts = program2.opts();
    try {
      const body = JSON.parse(cmdOpts.data);
      const data = await apiRequest({
        method: "POST",
        path: "/org/content-engine/publish",
        body,
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl
      });
      success("Content published.");
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(err instanceof SyntaxError ? "Invalid JSON in --data" : formatApiError(err));
      process.exit(1);
    }
  });
  engine.command("draft").description("Save content as a draft for review before publishing. Requires geo_question_id, raw_markdown, and seo_title.").requiredOption("--data <json>", 'JSON: { "geo_question_id": "uuid", "raw_markdown": "...", "seo_title": "...", "summary": "..." }').action(async (cmdOpts) => {
    const opts = program2.opts();
    try {
      const body = JSON.parse(cmdOpts.data);
      const data = await apiRequest({
        method: "POST",
        path: "/org/content-engine/draft",
        body,
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl
      });
      success("Content saved as draft.");
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(err instanceof SyntaxError ? "Invalid JSON in --data" : formatApiError(err));
      process.exit(1);
    }
  });
}

// src/commands/brand-kit.ts
function registerBrandKitCommands(program2) {
  const bk = program2.command("brand-kit").description("Manage the organization's brand kit guidelines. The brand kit is a free-form JSON object that informs AI content generation about your brand voice, tone, and style.");
  bk.command("get").description("Get the current brand kit guidelines.").action(async () => {
    const opts = program2.opts();
    try {
      const data = await apiRequest({ path: "/org/brand-kit", apiKey: opts.apiKey, baseUrl: opts.baseUrl });
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  bk.command("set").description("Replace the entire brand kit (PUT). All existing fields are overwritten \u2014 run 'brand-kit get' first to preserve fields you are not changing. For a safe partial update, use 'brand-kit patch'.").requiredOption("--data <json>", 'JSON: { "guidelines": { "brand_name": "Acme", "voice_and_tone": "...", "author_persona": "...", "global_writing_rules": [] } }').action(async (cmdOpts) => {
    const opts = program2.opts();
    try {
      const body = JSON.parse(cmdOpts.data);
      const data = await apiRequest({
        method: "PUT",
        path: "/org/brand-kit",
        body,
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl
      });
      success("Brand kit updated.");
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(err instanceof SyntaxError ? "Invalid JSON in --data" : formatApiError(err));
      process.exit(1);
    }
  });
  bk.command("patch").description("Partially update the brand kit (PATCH). Only the fields you provide are changed \u2014 existing fields are preserved. Preferred over 'set' for targeted updates.").requiredOption("--data <json>", 'JSON: { "guidelines": { "voice_and_tone": "Warm and approachable" } }').action(async (cmdOpts) => {
    const opts = program2.opts();
    try {
      const body = JSON.parse(cmdOpts.data);
      const data = await apiRequest({
        method: "PATCH",
        path: "/org/brand-kit",
        body,
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl
      });
      success("Brand kit updated.");
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(err instanceof SyntaxError ? "Invalid JSON in --data" : formatApiError(err));
      process.exit(1);
    }
  });
}

// src/commands/content-types.ts
function registerContentTypeCommands(program2) {
  const ct = program2.command("content-types").description("Manage content type configurations. Content types define the output format and structure for AI-generated content (e.g. blog post, FAQ, landing page).");
  ct.command("list").description("List all content types configured for the organization.").option("--limit <n>", "Maximum number of content types to return (default: 50)").option("--offset <n>", "Number of items to skip (for pagination)").action(async (cmdOpts) => {
    const opts = program2.opts();
    try {
      const data = await apiRequest({
        path: "/org/content-types",
        params: { limit: cmdOpts.limit, offset: cmdOpts.offset },
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl
      });
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  ct.command("create").description("Create a new content type. Requires a name and configuration defining the output structure.").requiredOption("--data <json>", 'JSON: { "name": "Blog Post", "config": { ... } }').action(async (cmdOpts) => {
    const opts = program2.opts();
    try {
      const body = JSON.parse(cmdOpts.data);
      const data = await apiRequest({
        method: "POST",
        path: "/org/content-types",
        body,
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl
      });
      success("Content type created.");
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(err instanceof SyntaxError ? "Invalid JSON in --data" : formatApiError(err));
      process.exit(1);
    }
  });
  ct.command("get <id>").description("Get a content type by ID, including its full configuration.").action(async (id) => {
    const opts = program2.opts();
    try {
      const data = await apiRequest({ path: `/org/content-types/${id}`, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  ct.command("update <id>").description("Replace a content type's name and config (PUT). Both fields are required \u2014 run 'get <id>' first to preserve existing values. For single-field updates, use 'content-types patch <id>'.").requiredOption("--data <json>", 'JSON: { "name": "Updated Name", "config": { "template": "...", "cta_text": "...", "cta_destination": "...", "writing_rules": [] } }').action(async (id, cmdOpts) => {
    const opts = program2.opts();
    try {
      const body = JSON.parse(cmdOpts.data);
      const data = await apiRequest({
        method: "PUT",
        path: `/org/content-types/${id}`,
        body,
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl
      });
      success(`Content type ${id} updated.`);
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(err instanceof SyntaxError ? "Invalid JSON in --data" : formatApiError(err));
      process.exit(1);
    }
  });
  ct.command("patch <id>").description("Partially update a content type (PATCH). Only the fields you provide are changed \u2014 existing fields are preserved. Preferred over 'update' for targeted changes like updating just the template.").requiredOption("--data <json>", 'JSON: { "config": { "template": "Updated template instruction" } }').action(async (id, cmdOpts) => {
    const opts = program2.opts();
    try {
      const body = JSON.parse(cmdOpts.data);
      const data = await apiRequest({
        method: "PATCH",
        path: `/org/content-types/${id}`,
        body,
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl
      });
      success(`Content type ${id} updated.`);
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(err instanceof SyntaxError ? "Invalid JSON in --data" : formatApiError(err));
      process.exit(1);
    }
  });
  ct.command("delete <id>").description("Delete a content type. This cannot be undone.").action(async (id) => {
    const opts = program2.opts();
    try {
      await apiRequest({ method: "DELETE", path: `/org/content-types/${id}`, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
      success(`Content type ${id} deleted.`);
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
}

// src/commands/prompts.ts
function registerPromptCommands(program2) {
  const prompts = program2.command("prompts").description("Manage prompts (GEO questions). Each prompt is a question that drives both AI content generation (use with 'generate sample --prompt-id') and brand visibility monitoring \u2014 tracking how AI models mention your brand, products, and competitors.");
  prompts.command("list").description("List all prompts in the organization. Use --search to filter by question text, --sort to order results.").option("--limit <n>", "Maximum prompts to return (max: 100)").option("--offset <n>", "Number of prompts to skip (for pagination)").option("--search <query>", "Filter prompts by question text").option("--sort <order>", "Sort order: created_desc, created_asc, text_asc, text_desc, type_asc, type_desc").action(async (cmdOpts) => {
    const opts = program2.opts();
    try {
      const data = await apiRequest({
        path: "/org/prompts",
        params: { limit: cmdOpts.limit, offset: cmdOpts.offset, search: cmdOpts.search, sort: cmdOpts.sort },
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl
      });
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  prompts.command("create").description("Create a new prompt. Type must be one of: decision, consideration, awareness, evaluation.").requiredOption("--data <json>", 'JSON: { "question_text": "What are the best...", "type": "decision" }').action(async (cmdOpts) => {
    const opts = program2.opts();
    try {
      const body = JSON.parse(cmdOpts.data);
      const data = await apiRequest({
        method: "POST",
        path: "/org/prompts",
        body,
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl
      });
      success("Prompt created.");
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(err instanceof SyntaxError ? "Invalid JSON in --data" : formatApiError(err));
      process.exit(1);
    }
  });
  prompts.command("get <promptId>").description("Get a prompt with its full run history. Includes all question runs with mentions, claims, citations, and competitor data.").action(async (promptId) => {
    const opts = program2.opts();
    try {
      const data = await apiRequest({ path: `/org/prompts/${promptId}`, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  prompts.command("delete <promptId>").description("Delete a prompt and all its associated run history. This cannot be undone.").action(async (promptId) => {
    const opts = program2.opts();
    try {
      await apiRequest({ method: "DELETE", path: `/org/prompts/${promptId}`, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
      success(`Prompt ${promptId} deleted.`);
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
}

// src/commands/run-config.ts
function registerRunConfigCommands(program2) {
  const rc = program2.command("run-config").description("Configure which AI models are used for question runs and on which days they run. Models include chatgpt, gemini, etc.");
  rc.command("models").description("Get the AI models currently configured for question runs (e.g. chatgpt, gemini).").action(async () => {
    const opts = program2.opts();
    try {
      const data = await apiRequest({ path: "/org/run-models", apiKey: opts.apiKey, baseUrl: opts.baseUrl });
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  rc.command("set-models").description("Replace the configured AI models for question runs. At least one model name is required.").requiredOption("--data <json>", 'JSON: { "models": ["chatgpt", "gemini"] }').action(async (cmdOpts) => {
    const opts = program2.opts();
    try {
      const body = JSON.parse(cmdOpts.data);
      const data = await apiRequest({
        method: "PUT",
        path: "/org/run-models",
        body,
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl
      });
      success("Models updated.");
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(err instanceof SyntaxError ? "Invalid JSON in --data" : formatApiError(err));
      process.exit(1);
    }
  });
  rc.command("schedule").description("Get the days of the week when question runs are triggered (0=Sunday, 1=Monday, ..., 6=Saturday).").action(async () => {
    const opts = program2.opts();
    try {
      const data = await apiRequest({ path: "/org/run-schedule", apiKey: opts.apiKey, baseUrl: opts.baseUrl });
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  rc.command("set-schedule").description("Set which days of the week question runs are triggered. Values must be 0-6 (Sunday-Saturday).").requiredOption("--data <json>", 'JSON: { "schedule": [1, 3, 5] }').action(async (cmdOpts) => {
    const opts = program2.opts();
    try {
      const body = JSON.parse(cmdOpts.data);
      const data = await apiRequest({
        method: "PUT",
        path: "/org/run-schedule",
        body,
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl
      });
      success("Schedule updated.");
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(err instanceof SyntaxError ? "Invalid JSON in --data" : formatApiError(err));
      process.exit(1);
    }
  });
}

// src/commands/members.ts
function registerMemberCommands(program2) {
  const members = program2.command("members").description("View the organization member directory. Lists all users who belong to the organization with their names and emails.");
  members.command("list").description("List all organization members. Use --search to filter by name or email, --sort to order results.").option("--limit <n>", "Maximum members to return (max: 1000)").option("--offset <n>", "Number of members to skip (for pagination)").option("--search <query>", "Filter by name or email").option("--sort <order>", "Sort order: name_asc, name_desc, email_asc, email_desc, created_asc, created_desc").action(async (cmdOpts) => {
    const opts = program2.opts();
    try {
      const data = await apiRequest({
        path: "/org/members",
        params: { limit: cmdOpts.limit, offset: cmdOpts.offset, search: cmdOpts.search, sort: cmdOpts.sort },
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl
      });
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
}

// src/commands/credits.ts
function registerCreditsCommands(program2) {
  const credits = program2.command("credits").description("View your organisation's credit balance. Credits are consumed by AI content generation and search operations.");
  credits.command("balance").description("Get the current credit balance for the organisation. Returns available credits and any spend limit configured.").action(async () => {
    const opts = program2.opts();
    try {
      const data = await apiRequest({ path: "/org/credits/balance", apiKey: opts.apiKey, baseUrl: opts.baseUrl });
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
}

// src/commands/questions.ts
function registerQuestionsCommands(program2) {
  const questions = program2.command("questions").description("Manage org-scoped geo questions. These are lightweight CRUD questions distinct from prompts (which include full run history).");
  questions.command("list").description("List geo questions for the org.").option("--type <type>", "Filter by question type: organization | network", "organization").action(async (cmdOpts) => {
    const opts = program2.opts();
    try {
      const data = await apiRequest({
        path: "/org/questions",
        params: { question_type: cmdOpts.type },
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl
      });
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  questions.command("create").description("Create a new geo question. Type must be one of: decision, consideration, awareness, evaluation.").requiredOption("--data <json>", 'JSON: { "question_text": "...", "type": "decision", "tag_ids": [] }').action(async (cmdOpts) => {
    const opts = program2.opts();
    try {
      const body = JSON.parse(cmdOpts.data);
      const data = await apiRequest({ method: "POST", path: "/org/questions", body, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
      success("Question created.");
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(err instanceof SyntaxError ? "Invalid JSON in --data" : formatApiError(err));
      process.exit(1);
    }
  });
  questions.command("patch <questionId>").description("Partially update a question. Currently supports updating tag associations.").requiredOption("--data <json>", 'JSON: { "tag_ids": ["<uuid>", ...] } \u2014 pass null to clear all tags').action(async (questionId, cmdOpts) => {
    const opts = program2.opts();
    try {
      const body = JSON.parse(cmdOpts.data);
      const data = await apiRequest({ method: "PATCH", path: `/org/questions/${questionId}`, body, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
      success(`Question ${questionId} updated.`);
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(err instanceof SyntaxError ? "Invalid JSON in --data" : formatApiError(err));
      process.exit(1);
    }
  });
  questions.command("delete <questionId>").description("Delete a geo question.").action(async (questionId) => {
    const opts = program2.opts();
    try {
      await apiRequest({ method: "DELETE", path: `/org/questions/${questionId}`, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
      success(`Question ${questionId} deleted.`);
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
}

// src/commands/kb.ts
import { createHash as createHash2 } from "crypto";
import { readFile as readFile2, stat as stat2 } from "fs/promises";
import { basename as basename2, resolve as resolve2 } from "path";
var MIME_TYPES2 = {
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".html": "text/html",
  ".htm": "text/html",
  ".md": "text/markdown",
  ".json": "application/json",
  ".xml": "application/xml"
};
function getMimeType2(filename) {
  const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  return MIME_TYPES2[ext] || "application/octet-stream";
}
async function getFileMetadata2(filePath) {
  const absPath = resolve2(filePath);
  const buffer = await readFile2(absPath);
  const stats = await stat2(absPath);
  const hash = createHash2("md5").update(buffer).digest("hex");
  return {
    meta: {
      filename: basename2(absPath),
      file_size_bytes: stats.size,
      content_type: getMimeType2(basename2(absPath)),
      content_hash_md5: hash
    },
    buffer
  };
}
async function uploadToS32(url, buffer, contentType) {
  const res = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: buffer
  });
  if (!res.ok) throw new Error(`S3 upload failed: ${res.status} ${res.statusText}`);
}
function registerKBCommands(program2) {
  const kb = program2.command("kb").description("Manage the knowledge base. Browse nodes, upload files, create folders, create raw content, and manage the KB tree.");
  kb.command("root").description("Get the root KB node for the org.").action(async () => {
    const opts = program2.opts();
    try {
      const data = await apiRequest({ path: "/org/kb/root", apiKey: opts.apiKey, baseUrl: opts.baseUrl });
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  kb.command("my-files").description("List top-level files and folders in the knowledge base.").option("--limit <n>", "Items per page", "50").option("--offset <n>", "Pagination offset", "0").action(async (cmdOpts) => {
    const opts = program2.opts();
    try {
      const data = await apiRequest({
        path: "/org/kb/my-files",
        params: { limit: cmdOpts.limit, offset: cmdOpts.offset },
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl
      });
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  kb.command("find").description("Search KB nodes by name.").requiredOption("--query <q>", "Name search query").option("--limit <n>", "Items per page", "20").option("--offset <n>", "Pagination offset", "0").action(async (cmdOpts) => {
    const opts = program2.opts();
    try {
      const data = await apiRequest({
        path: "/org/kb/find",
        params: { q: cmdOpts.query, limit: cmdOpts.limit, offset: cmdOpts.offset },
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl
      });
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  kb.command("sync-status").description("Get the vector sync status for the org's knowledge base.").action(async () => {
    const opts = program2.opts();
    try {
      const data = await apiRequest({ path: "/org/kb/sync-status", apiKey: opts.apiKey, baseUrl: opts.baseUrl });
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  kb.command("get <id>").description("Get a KB node by ID.").action(async (id) => {
    const opts = program2.opts();
    try {
      const data = await apiRequest({ path: `/org/kb/nodes/${id}`, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  kb.command("children <id>").description("List children of a KB folder node.").option("--limit <n>", "Items per page", "50").option("--offset <n>", "Pagination offset", "0").action(async (id, cmdOpts) => {
    const opts = program2.opts();
    try {
      const data = await apiRequest({
        path: `/org/kb/nodes/${id}/children`,
        params: { limit: cmdOpts.limit, offset: cmdOpts.offset },
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl
      });
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  kb.command("ancestors <id>").description("Get the ancestor chain (breadcrumb) for a KB node.").action(async (id) => {
    const opts = program2.opts();
    try {
      const data = await apiRequest({ path: `/org/kb/nodes/${id}/ancestors`, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  kb.command("get-content <id>").description("Get the content detail for a KB content node.").option("--version <version>", "Specific version to retrieve").action(async (id, cmdOpts) => {
    const opts = program2.opts();
    try {
      const data = await apiRequest({
        path: `/org/kb/nodes/${id}/content`,
        params: { version: cmdOpts.version },
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl
      });
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  kb.command("download-url <id>").description("Get a presigned S3 download URL for a KB file node.").option("--version <version>", "Specific version to download").action(async (id, cmdOpts) => {
    const opts = program2.opts();
    try {
      const data = await apiRequest({
        path: `/org/kb/nodes/${id}/download-url`,
        params: { version: cmdOpts.version },
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl
      });
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  kb.command("create-folder").description("Create a new folder in the knowledge base.").requiredOption("--name <name>", "Folder name").option("--parent-id <id>", "Parent folder node ID (omit to create at root)").action(async (cmdOpts) => {
    const opts = program2.opts();
    try {
      const body = { name: cmdOpts.name };
      if (cmdOpts.parentId) body.parent_id = cmdOpts.parentId;
      const data = await apiRequest({ method: "POST", path: "/org/kb/folders", body, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
      success(`Folder "${cmdOpts.name}" created.`);
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  kb.command("rename <id>").description("Rename a KB node.").requiredOption("--name <name>", "New name").action(async (id, cmdOpts) => {
    const opts = program2.opts();
    try {
      const data = await apiRequest({ method: "PATCH", path: `/org/kb/nodes/${id}/rename`, body: { name: cmdOpts.name }, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
      success(`Node ${id} renamed to "${cmdOpts.name}".`);
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  kb.command("move <id>").description("Move a KB node to a different parent folder.").requiredOption("--parent-id <parentId>", "Target parent folder node ID").action(async (id, cmdOpts) => {
    const opts = program2.opts();
    try {
      const data = await apiRequest({ method: "PATCH", path: `/org/kb/nodes/${id}/move`, body: { new_parent_id: cmdOpts.parentId }, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
      success(`Node ${id} moved.`);
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  kb.command("delete <id>").description("Delete a KB node (soft delete).").action(async (id) => {
    const opts = program2.opts();
    try {
      await apiRequest({ method: "DELETE", path: `/org/kb/nodes/${id}`, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
      success(`Node ${id} deleted.`);
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  kb.command("create-raw").description("Create a raw (text/markdown) content item in the knowledge base.").requiredOption("--data <json>", 'JSON: { "title": "My doc", "text": "# Hello", "kb_folder_node_id": "<uuid>", "tag_ids": ["<uuid>"] }').action(async (cmdOpts) => {
    const opts = program2.opts();
    try {
      const body = JSON.parse(cmdOpts.data);
      const data = await apiRequest({ method: "POST", path: "/org/kb/raw", body, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
      success("Raw content node created.");
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(err instanceof SyntaxError ? "Invalid JSON in --data" : formatApiError(err));
      process.exit(1);
    }
  });
  kb.command("update-raw <id>").description("Fully replace the text content of a raw KB node (creates a new version).").requiredOption("--data <json>", 'JSON: { "title": "Title", "text": "# Updated content", "tag_ids": ["<uuid>"] }').action(async (id, cmdOpts) => {
    const opts = program2.opts();
    try {
      const body = JSON.parse(cmdOpts.data);
      const data = await apiRequest({ method: "PUT", path: `/org/kb/nodes/${id}/raw`, body, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
      success(`Node ${id} content replaced.`);
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(err instanceof SyntaxError ? "Invalid JSON in --data" : formatApiError(err));
      process.exit(1);
    }
  });
  kb.command("patch-raw <id>").description("Partially update the text content of a raw KB node.").requiredOption("--data <json>", 'JSON: { "title": "New title", "text": "Updated text", "summary": "...", "tag_ids": ["<uuid>"] }').action(async (id, cmdOpts) => {
    const opts = program2.opts();
    try {
      const body = JSON.parse(cmdOpts.data);
      const data = await apiRequest({ method: "PATCH", path: `/org/kb/nodes/${id}/raw`, body, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
      success(`Node ${id} content patched.`);
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(err instanceof SyntaxError ? "Invalid JSON in --data" : formatApiError(err));
      process.exit(1);
    }
  });
  kb.command("upload <files...>").description("Upload files to the knowledge base (up to 10). Files are hashed, uploaded to S3, then parsed and embedded by a background worker.").option("--folder-id <id>", "Parent folder node ID to place files in (omit for root)").action(async (files, cmdOpts) => {
    const opts = program2.opts();
    if (files.length > 10) {
      error("Maximum 10 files per upload request.");
      process.exit(1);
    }
    try {
      const fileData = await Promise.all(files.map(getFileMetadata2));
      const body = { files: fileData.map((f) => f.meta) };
      if (cmdOpts.folderId) body.kb_folder_node_id = cmdOpts.folderId;
      const response = await apiRequest({
        method: "POST",
        path: "/org/kb/upload",
        body,
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl
      });
      const items = response.results ?? [];
      let uploaded = 0;
      for (const item of items) {
        if (item.status === "upload_pending" && item.upload_url) {
          const match = fileData.find((f) => f.meta.filename === item.filename);
          if (!match) {
            error(`Could not match server filename "${item.filename}" to a local file \u2014 skipping upload.`);
            continue;
          }
          try {
            await uploadToS32(item.upload_url, match.buffer, match.meta.content_type);
            uploaded++;
            success(`Uploaded ${item.filename} (content_id: ${item.content_id})`);
          } catch (uploadErr) {
            error(`S3 upload failed for ${item.filename}: ${uploadErr instanceof Error ? uploadErr.message : String(uploadErr)}`);
          }
        } else {
          warn(`Skipped ${item.filename}: ${item.status}${item.error ? ` \u2014 ${item.error}` : ""}`);
        }
      }
      if (uploaded > 0) {
        success(`${uploaded} file(s) uploaded. Background processing will parse, chunk, and embed them.`);
      }
      if (opts.output === "json") console.log(JSON.stringify(response, null, 2));
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  kb.command("update-file <id> <file>").description("Replace the file on an existing KB file node with a new version.").action(async (id, file) => {
    const opts = program2.opts();
    try {
      const { meta, buffer } = await getFileMetadata2(file);
      const item = await apiRequest({
        method: "PUT",
        path: `/org/kb/nodes/${id}/file`,
        body: { file: meta },
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl
      });
      if (item.status === "upload_pending" && item.upload_url) {
        await uploadToS32(item.upload_url, buffer, meta.content_type);
        success(`Uploaded ${meta.filename} for node ${id}. Background re-processing started.`);
      } else {
        warn(`Skipped: ${item.status}${item.error ? ` \u2014 ${item.error}` : ""}`);
      }
      if (opts.output === "json") console.log(JSON.stringify(item, null, 2));
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
}

// src/commands/permissions.ts
function registerPermissionsCommands(program2) {
  const perms = program2.command("permissions").description("View available role permissions for the organization.");
  perms.command("list").description("List all available permission keys with their names, descriptions, and categories. Useful for building role management UIs.").action(async () => {
    const opts = program2.opts();
    try {
      const data = await apiRequest({ path: "/org/permissions", apiKey: opts.apiKey, baseUrl: opts.baseUrl });
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
}

// src/commands/update.ts
import semver2 from "semver";
import pc7 from "picocolors";
import { execSync } from "child_process";
var NPM_PACKAGE2 = "@senso-ai/cli";
function registerUpdateCommand(program2) {
  program2.command("update").description("Update CLI to the latest version").action(async () => {
    info(`Current version: ${pc7.bold(version)}`);
    info("Checking npm for updates...");
    const latest = await getLatestVersion();
    if (!latest) {
      error("Could not check for updates. Try again later.");
      process.exit(1);
    }
    if (!semver2.gt(latest, version)) {
      success(`Already on the latest version (${version}).`);
      return;
    }
    info(`New version available: ${pc7.bold(latest)}`);
    info("Updating...");
    try {
      execSync(`npm install -g ${NPM_PACKAGE2}@latest`, {
        stdio: "inherit"
      });
      success(`Updated to v${latest}.`);
    } catch {
      error("Update failed. Please reinstall manually:");
      console.log(
        `  ${pc7.cyan(`npm install -g ${NPM_PACKAGE2}`)}`
      );
      process.exit(1);
    }
  });
}

// src/cli.ts
var program = new Command();
program.name("senso").description("Senso CLI \u2014 Infrastructure for the Agentic Web").version(version, "-v, --version").option("--api-key <key>", "Override API key (or set SENSO_API_KEY)").option("--base-url <url>", "Override API base URL").option("--output <format>", "Output format: json | table | plain", "plain").option("--quiet", "Suppress non-essential output").option("--no-update-check", "Skip version check").hook("preAction", async () => {
  const opts = program.opts();
  if (!opts.quiet) {
    miniBanner();
  }
});
registerAuthCommands(program);
registerOrgCommands(program);
registerUserCommands(program);
registerApiKeyCommands(program);
registerSearchCommands(program);
registerIngestCommands(program);
registerContentCommands(program);
registerGenerateCommands(program);
registerEngineCommands(program);
registerBrandKitCommands(program);
registerContentTypeCommands(program);
registerPromptCommands(program);
registerRunConfigCommands(program);
registerMemberCommands(program);
registerCreditsCommands(program);
registerQuestionsCommands(program);
registerKBCommands(program);
registerPermissionsCommands(program);
registerUpdateCommand(program);
async function main() {
  const quiet = process.argv.includes("--quiet") || process.argv.includes("--output") && process.argv[process.argv.indexOf("--output") + 1] === "json";
  checkForUpdate(quiet).catch(() => {
  });
  await program.parseAsync(process.argv);
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
