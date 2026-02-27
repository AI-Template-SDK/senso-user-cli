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
    const msg = typeof body === "object" && body && "error" in body ? body.error : statusText;
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
      case 403:
        return "Permission denied. Check your API key permissions.";
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
function registerSearchCommands(program2) {
  const search = program2.command("search").description("Search the knowledge base with natural language queries. Returns AI-generated answers synthesised from matching content chunks, or raw chunks/content IDs.");
  search.argument("<query>", "Search query").option("--max-results <n>", "Maximum number of results", "5").action(async (query, cmdOpts) => {
    const opts = program2.opts();
    try {
      const data = await apiRequest({
        method: "POST",
        path: "/org/search",
        body: { query, max_results: parseInt(cmdOpts.maxResults) },
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
  search.command("context <query>").description("Search the knowledge base \u2014 returns matching content chunks only, without AI answer generation. Faster than full search.").option("--max-results <n>", "Maximum results", "5").action(async (query, cmdOpts) => {
    const opts = program2.opts();
    try {
      const data = await apiRequest({
        method: "POST",
        path: "/org/search/context",
        body: { query, max_results: parseInt(cmdOpts.maxResults) },
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl
      });
      outputByFormat(opts.output, data);
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  search.command("content <query>").description("Search the knowledge base \u2014 returns deduplicated content IDs and titles only. No chunks or AI answer.").option("--max-results <n>", "Maximum results", "5").action(async (query, cmdOpts) => {
    const opts = program2.opts();
    try {
      const data = await apiRequest({
        method: "POST",
        path: "/org/search/content",
        body: { query, max_results: parseInt(cmdOpts.maxResults) },
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
  ingest.command("upload <files...>").description("Upload files to the knowledge base. Accepts local file paths (up to 10). Files are hashed, uploaded to S3, then parsed and embedded by a background worker.").action(async (files) => {
    const opts = program2.opts();
    if (files.length > 10) {
      error("Maximum 10 files per upload request.");
      process.exit(1);
    }
    try {
      const fileData = await Promise.all(files.map(getFileMetadata));
      const results = await apiRequest({
        method: "POST",
        path: "/org/ingestion/upload",
        body: { files: fileData.map((f) => f.meta) },
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl
      });
      const items = Array.isArray(results) ? results : [];
      let uploaded = 0;
      for (const item of items) {
        if (item.status === "upload_pending" && item.upload_url) {
          const match = fileData.find((f) => f.meta.filename === item.filename);
          if (match) {
            await uploadToS3(item.upload_url, match.buffer, match.meta.content_type);
            uploaded++;
            success(`Uploaded ${item.filename} (content_id: ${item.content_id})`);
          }
        } else {
          warn(`Skipped ${item.filename}: ${item.status}${item.message ? ` \u2014 ${item.message}` : ""}`);
        }
      }
      if (uploaded > 0) {
        success(`${uploaded} file(s) uploaded. Background processing will parse, chunk, and embed them.`);
      }
      if (opts.output === "json") {
        console.log(JSON.stringify(results, null, 2));
      }
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  ingest.command("reprocess <contentId> <file>").description("Re-ingest an existing content item with a new file version. Provide the content ID and the path to the replacement file.").action(async (contentId, file) => {
    const opts = program2.opts();
    try {
      const { meta, buffer } = await getFileMetadata(file);
      const results = await apiRequest({
        method: "PUT",
        path: `/org/ingestion/content/${contentId}`,
        body: { file: meta },
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl
      });
      const items = Array.isArray(results) ? results : [];
      for (const item of items) {
        if (item.status === "upload_pending" && item.upload_url) {
          await uploadToS3(item.upload_url, buffer, meta.content_type);
          success(`Uploaded ${meta.filename} for content ${contentId}. Background re-processing started.`);
        } else {
          warn(`Skipped: ${item.status}${item.message ? ` \u2014 ${item.message}` : ""}`);
        }
      }
      if (opts.output === "json") {
        console.log(JSON.stringify(results, null, 2));
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
  content.command("list").description("List all content items in the knowledge base. Returns title, status, and ID for each item. Use --search to filter by title, --sort to order results.").option("--limit <n>", "Items per page", "10").option("--offset <n>", "Pagination offset", "0").option("--search <query>", "Filter content by title").option("--sort <order>", "Sort order: title_asc, title_desc, created_asc, created_desc").action(async (cmdOpts) => {
    const opts = program2.opts();
    try {
      const data = await apiRequest({
        path: "/org/content",
        params: { limit: cmdOpts.limit, offset: cmdOpts.offset, search: cmdOpts.search, sort: cmdOpts.sort },
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl
      });
      const format = opts.output || "plain";
      const rows = Array.isArray(data) ? data : [];
      output(format, {
        json: data,
        table: {
          rows: rows.map((r) => ({
            id: r.id || r.content_id,
            title: r.title,
            status: r.status
          })),
          columns: ["id", "title", "status"]
        },
        plain: rows.length ? rows.map(
          (r) => `  ${pc6.bold(String(r.title || "Untitled"))} ${pc6.dim(`(${r.id || r.content_id})`)} ${r.status ? pc6.dim(`[${r.status}]`) : ""}`
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
  gen.command("update-settings").description("Update content generation settings. Control auto-publish, generation toggle, and schedule (days of week 0-6).").requiredOption("--data <json>", 'JSON settings: { "enable_content_generation": bool, "content_auto_publish": bool, "content_schedule": [0-6] }').action(async (cmdOpts) => {
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
  gen.command("sample").description("Generate an ad hoc content sample for a specific prompt and content type. Returns the generated markdown, SEO title, and publish results.").requiredOption("--prompt-id <id>", "Prompt (geo question) ID to generate content for").requiredOption("--content-type-id <id>", "Content type ID that defines the output format").option("--destination <dest>", "Publish destination (e.g. citeables)").action(async (cmdOpts) => {
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
  gen.command("run").description("Trigger a content generation run. Processes all prompts (or a specific subset) through the content engine. Runs asynchronously.").option("--prompt-ids <ids...>", "Optional list of prompt IDs to process (omit to run all)").action(async (cmdOpts) => {
    const opts = program2.opts();
    try {
      const body = cmdOpts.promptIds ? { prompt_ids: cmdOpts.promptIds } : void 0;
      const data = await apiRequest({ method: "POST", path: "/org/content-generation/run", body, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
      success("Content generation run triggered.");
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
  bk.command("set").description("Create or replace the brand kit. The guidelines field is a free-form JSON object defining your brand voice.").requiredOption("--data <json>", 'JSON: { "guidelines": { "tone": "professional", "voice": "..." } }').action(async (cmdOpts) => {
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
  ct.command("update <id>").description("Update a content type's name or configuration.").requiredOption("--data <json>", 'JSON: { "name": "Updated Name", "config": { ... } }').action(async (id, cmdOpts) => {
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
  const prompts = program2.command("prompts").description("Manage prompts (geo questions). Prompts are the questions that drive AI content generation \u2014 each prompt is run against configured AI models to track brand mentions, claims, and competitor visibility.");
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

// src/commands/notifications.ts
function registerNotificationCommands(program2) {
  const notif = program2.command("notifications").description("View and manage user notifications. Notifications are triggered by content verification, generation runs, and other system events.");
  notif.command("list").description("List notifications for the current user. Use --unread-only to filter to unread notifications.").option("--limit <n>", "Maximum notifications to return (default: 50, max: 200)").option("--offset <n>", "Number of notifications to skip (for pagination)").option("--unread-only", "Only return unread notifications").action(async (cmdOpts) => {
    const opts = program2.opts();
    try {
      const data = await apiRequest({
        path: "/app/v1/notifications",
        params: {
          limit: cmdOpts.limit,
          offset: cmdOpts.offset,
          unread_only: cmdOpts.unreadOnly ? "true" : void 0
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
  notif.command("read <id>").description("Mark a notification as read.").action(async (id) => {
    const opts = program2.opts();
    try {
      await apiRequest({
        method: "PATCH",
        path: `/app/v1/notifications/${id}/read`,
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl
      });
      success(`Notification ${id} marked as read.`);
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
registerNotificationCommands(program);
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
