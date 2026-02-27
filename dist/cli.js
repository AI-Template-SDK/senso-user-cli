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
var GITHUB_REPO = "AI-Template-SDK/senso-user-cli";
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
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
      {
        headers: { Accept: "application/vnd.github.v3+json" },
        signal: AbortSignal.timeout(5e3)
      }
    );
    if (!res.ok) return;
    const release = await res.json();
    const latest = release.tag_name.replace(/^v/, "");
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
async function getLatestRelease() {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
      {
        headers: { Accept: "application/vnd.github.v3+json" },
        signal: AbortSignal.timeout(1e4)
      }
    );
    if (!res.ok) return null;
    return await res.json();
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
      try {
        body = await res.json();
      } catch {
        body = await res.text();
      }
      throw new ApiError(res.status, res.statusText, body);
    }
    if (res.status === 204) {
      return void 0;
    }
    return await res.json();
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
  program2.command("login").description("Save API key to config (validates via GET /org/me)").action(async () => {
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
  program2.command("logout").description("Remove stored credentials").action(() => {
    clearConfig();
    success("Credentials removed.");
  });
  program2.command("whoami").description("Show current auth status and org info").action(async () => {
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
  const org = program2.command("org").description("Organization management");
  org.command("get").description("Get organization details").action(async () => {
    const opts = program2.opts();
    try {
      const data = await apiRequest({ path: "/org/me", apiKey: opts.apiKey, baseUrl: opts.baseUrl });
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  org.command("update").description("Update organization details").requiredOption("--data <json>", "JSON org fields to update").action(async (cmdOpts) => {
    const opts = program2.opts();
    try {
      const body = JSON.parse(cmdOpts.data);
      const data = await apiRequest({
        method: "PATCH",
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
  const users = program2.command("users").description("Manage users in organization");
  users.command("list").description("List users in organization").action(async () => {
    const opts = program2.opts();
    try {
      const data = await apiRequest({ path: "/org/users", apiKey: opts.apiKey, baseUrl: opts.baseUrl });
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  users.command("add").description("Add user to organization").requiredOption("--data <json>", "JSON user data").action(async (cmdOpts) => {
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
  users.command("get <userId>").description("Get a user in the organization").action(async (userId) => {
    const opts = program2.opts();
    try {
      const data = await apiRequest({ path: `/org/users/${userId}`, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  users.command("update <userId>").description("Update a user's role").requiredOption("--data <json>", "JSON user update data").action(async (userId, cmdOpts) => {
    const opts = program2.opts();
    try {
      const body = JSON.parse(cmdOpts.data);
      const data = await apiRequest({
        method: "PATCH",
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
  users.command("remove <userId>").description("Remove a user from the organization").action(async (userId) => {
    const opts = program2.opts();
    try {
      await apiRequest({ method: "DELETE", path: `/org/users/${userId}`, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
      success(`User ${userId} removed.`);
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
}

// src/commands/api-keys.ts
function registerApiKeyCommands(program2) {
  const keys = program2.command("api-keys").description("Manage API keys");
  keys.command("list").description("List API keys").action(async () => {
    const opts = program2.opts();
    try {
      const data = await apiRequest({ path: "/org/api-keys", apiKey: opts.apiKey, baseUrl: opts.baseUrl });
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  keys.command("create").description("Create API key").requiredOption("--data <json>", "JSON key configuration").action(async (cmdOpts) => {
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
  keys.command("get <keyId>").description("Get API key details").action(async (keyId) => {
    const opts = program2.opts();
    try {
      const data = await apiRequest({ path: `/org/api-keys/${keyId}`, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  keys.command("update <keyId>").description("Update API key").requiredOption("--data <json>", "JSON key updates").action(async (keyId, cmdOpts) => {
    const opts = program2.opts();
    try {
      const body = JSON.parse(cmdOpts.data);
      const data = await apiRequest({
        method: "PATCH",
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
  keys.command("delete <keyId>").description("Delete API key").action(async (keyId) => {
    const opts = program2.opts();
    try {
      await apiRequest({ method: "DELETE", path: `/org/api-keys/${keyId}`, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
      success(`API key ${keyId} deleted.`);
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  keys.command("revoke <keyId>").description("Revoke API key").action(async (keyId) => {
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

// src/commands/categories.ts
function registerCategoryCommands(program2) {
  const cat = program2.command("categories").description("Manage categories");
  cat.command("list").description("List categories").action(async () => {
    const opts = program2.opts();
    try {
      const data = await apiRequest({ path: "/org/categories", apiKey: opts.apiKey, baseUrl: opts.baseUrl });
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  cat.command("list-all").description("List all categories with their topics").action(async () => {
    const opts = program2.opts();
    try {
      const data = await apiRequest({ path: "/org/categories/all", apiKey: opts.apiKey, baseUrl: opts.baseUrl });
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  cat.command("create <name>").description("Create a category").action(async (name) => {
    const opts = program2.opts();
    try {
      const data = await apiRequest({
        method: "POST",
        path: "/org/categories",
        body: { name },
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl
      });
      success(`Category "${name}" created.`);
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  cat.command("get <id>").description("Get category by ID").action(async (id) => {
    const opts = program2.opts();
    try {
      const data = await apiRequest({ path: `/org/categories/${id}`, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  cat.command("update <id>").description("Update a category").requiredOption("--name <name>", "New category name").action(async (id, cmdOpts) => {
    const opts = program2.opts();
    try {
      const data = await apiRequest({
        method: "PATCH",
        path: `/org/categories/${id}`,
        body: { name: cmdOpts.name },
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl
      });
      success(`Category ${id} updated.`);
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  cat.command("delete <id>").description("Delete a category").action(async (id) => {
    const opts = program2.opts();
    try {
      await apiRequest({ method: "DELETE", path: `/org/categories/${id}`, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
      success(`Category ${id} deleted.`);
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  cat.command("batch-create").description("Batch create categories with topics").requiredOption("--data <json>", "JSON array of categories with topics").action(async (cmdOpts) => {
    const opts = program2.opts();
    try {
      const body = JSON.parse(cmdOpts.data);
      const data = await apiRequest({
        method: "POST",
        path: "/org/categories/batch",
        body,
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl
      });
      success("Batch create completed.");
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(err instanceof SyntaxError ? "Invalid JSON in --data" : formatApiError(err));
      process.exit(1);
    }
  });
}

// src/commands/topics.ts
function registerTopicCommands(program2) {
  const topics = program2.command("topics").description("Manage topics within categories");
  topics.command("list <categoryId>").description("List topics for a category").action(async (categoryId) => {
    const opts = program2.opts();
    try {
      const data = await apiRequest({
        path: `/org/categories/${categoryId}/topics`,
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl
      });
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  topics.command("create <categoryId>").description("Create topic in category").requiredOption("--name <name>", "Topic name").action(async (categoryId, cmdOpts) => {
    const opts = program2.opts();
    try {
      const data = await apiRequest({
        method: "POST",
        path: `/org/categories/${categoryId}/topics`,
        body: { name: cmdOpts.name },
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl
      });
      success(`Topic "${cmdOpts.name}" created.`);
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  topics.command("get <categoryId> <topicId>").description("Get topic by ID").action(async (categoryId, topicId) => {
    const opts = program2.opts();
    try {
      const data = await apiRequest({
        path: `/org/categories/${categoryId}/topics/${topicId}`,
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl
      });
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  topics.command("update <categoryId> <topicId>").description("Update a topic").requiredOption("--name <name>", "New topic name").action(async (categoryId, topicId, cmdOpts) => {
    const opts = program2.opts();
    try {
      const data = await apiRequest({
        method: "PATCH",
        path: `/org/categories/${categoryId}/topics/${topicId}`,
        body: { name: cmdOpts.name },
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl
      });
      success(`Topic ${topicId} updated.`);
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  topics.command("delete <categoryId> <topicId>").description("Delete a topic").action(async (categoryId, topicId) => {
    const opts = program2.opts();
    try {
      await apiRequest({
        method: "DELETE",
        path: `/org/categories/${categoryId}/topics/${topicId}`,
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl
      });
      success(`Topic ${topicId} deleted.`);
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  topics.command("batch-create <categoryId>").description("Batch create topics in a category").requiredOption("--data <json>", "JSON array of topics").action(async (categoryId, cmdOpts) => {
    const opts = program2.opts();
    try {
      const body = JSON.parse(cmdOpts.data);
      const data = await apiRequest({
        method: "POST",
        path: `/org/categories/${categoryId}/topics/batch`,
        body,
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl
      });
      success("Batch create completed.");
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(err instanceof SyntaxError ? "Invalid JSON in --data" : formatApiError(err));
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
  const search = program2.command("search").description("Semantic search over your knowledge base");
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
  search.command("context <query>").description("Semantic search \u2014 chunks only").option("--max-results <n>", "Maximum results", "5").action(async (query, cmdOpts) => {
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
  search.command("content <query>").description("Semantic search \u2014 content IDs only").option("--max-results <n>", "Maximum results", "5").action(async (query, cmdOpts) => {
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
function registerIngestCommands(program2) {
  const ingest = program2.command("ingest").description("Content ingestion (upload, reprocess)");
  ingest.command("upload").description("Request presigned S3 upload URLs").requiredOption("--files <filenames...>", "File names to get upload URLs for").action(async (cmdOpts) => {
    const opts = program2.opts();
    try {
      const data = await apiRequest({
        method: "POST",
        path: "/org/ingestion/upload",
        body: { files: cmdOpts.files },
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl
      });
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  ingest.command("reprocess <contentId>").description("Request re-ingestion of existing content").action(async (contentId) => {
    const opts = program2.opts();
    try {
      await apiRequest({
        method: "POST",
        path: `/org/ingestion/${contentId}/reprocess`,
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl
      });
      success(`Reprocess triggered for content ${contentId}.`);
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
}

// src/commands/content.ts
import pc6 from "picocolors";
function registerContentCommands(program2) {
  const content = program2.command("content").description("Manage content items");
  content.command("list").description("List content items").option("--limit <n>", "Items per page", "10").option("--offset <n>", "Pagination offset", "0").action(async (cmdOpts) => {
    const opts = program2.opts();
    try {
      const data = await apiRequest({
        path: "/org/content",
        params: { limit: cmdOpts.limit, offset: cmdOpts.offset },
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
  content.command("get <id>").description("Get content item by ID").action(async (id) => {
    const opts = program2.opts();
    try {
      const data = await apiRequest({ path: `/org/content/${id}`, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  content.command("delete <id>").description("Delete content (local + external)").action(async (id) => {
    const opts = program2.opts();
    try {
      await apiRequest({ method: "DELETE", path: `/org/content/${id}`, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
      success(`Content ${id} deleted.`);
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  content.command("unpublish <id>").description("Unpublish content (external delete + set draft)").action(async (id) => {
    const opts = program2.opts();
    try {
      await apiRequest({ method: "POST", path: `/org/content/${id}/unpublish`, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
      success(`Content ${id} unpublished.`);
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  content.command("verification").description("List content awaiting verification").action(async () => {
    const opts = program2.opts();
    try {
      const data = await apiRequest({ path: "/org/content/verification", apiKey: opts.apiKey, baseUrl: opts.baseUrl });
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  content.command("reject <versionId>").description("Reject a content version").action(async (versionId) => {
    const opts = program2.opts();
    try {
      await apiRequest({ method: "POST", path: `/org/content/versions/${versionId}/reject`, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
      success(`Version ${versionId} rejected.`);
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  content.command("restore <versionId>").description("Restore a content version to draft").action(async (versionId) => {
    const opts = program2.opts();
    try {
      await apiRequest({ method: "POST", path: `/org/content/versions/${versionId}/restore`, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
      success(`Version ${versionId} restored to draft.`);
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  content.command("owners <id>").description("List content owners").action(async (id) => {
    const opts = program2.opts();
    try {
      const data = await apiRequest({ path: `/org/content/${id}/owners`, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  content.command("set-owners <id>").description("Replace content owners").requiredOption("--user-ids <ids...>", "User IDs to set as owners").action(async (id, cmdOpts) => {
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
  content.command("remove-owner <id> <userId>").description("Remove content owner").action(async (id, userId) => {
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
  const gen = program2.command("generate").description("Content generation settings and triggers");
  gen.command("settings").description("Get content generation settings").action(async () => {
    const opts = program2.opts();
    try {
      const data = await apiRequest({ path: "/org/content-generation", apiKey: opts.apiKey, baseUrl: opts.baseUrl });
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  gen.command("update-settings").description("Update content generation settings").requiredOption("--data <json>", "JSON settings to update").action(async (cmdOpts) => {
    const opts = program2.opts();
    try {
      const body = JSON.parse(cmdOpts.data);
      const data = await apiRequest({ method: "PATCH", path: "/org/content-generation", body, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(err instanceof SyntaxError ? "Invalid JSON in --data" : formatApiError(err));
      process.exit(1);
    }
  });
  gen.command("sample").description("Generate ad hoc content sample").requiredOption("--instructions <text>", "Instructions for generation").action(async (cmdOpts) => {
    const opts = program2.opts();
    try {
      const data = await apiRequest({
        method: "POST",
        path: "/org/content-generation/sample",
        body: { instructions: cmdOpts.instructions },
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl
      });
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  gen.command("run").description("Trigger content engine run").action(async () => {
    const opts = program2.opts();
    try {
      const data = await apiRequest({ method: "POST", path: "/org/content-generation/run", apiKey: opts.apiKey, baseUrl: opts.baseUrl });
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
  const engine = program2.command("engine").description("Content engine operations (publish/draft)");
  engine.command("publish").description("Publish content via content engine").requiredOption("--data <json>", "JSON payload for publish").action(async (cmdOpts) => {
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
  engine.command("draft").description("Save content as draft via content engine").requiredOption("--data <json>", "JSON payload for draft").action(async (cmdOpts) => {
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
  const bk = program2.command("brand-kit").description("Manage brand kit");
  bk.command("get").description("Get brand kit").action(async () => {
    const opts = program2.opts();
    try {
      const data = await apiRequest({ path: "/org/brand-kit", apiKey: opts.apiKey, baseUrl: opts.baseUrl });
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  bk.command("set").description("Upsert brand kit").requiredOption("--data <json>", "JSON brand kit data").action(async (cmdOpts) => {
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
  const ct = program2.command("content-types").description("Manage content types");
  ct.command("list").description("List content types").action(async () => {
    const opts = program2.opts();
    try {
      const data = await apiRequest({ path: "/org/content-types", apiKey: opts.apiKey, baseUrl: opts.baseUrl });
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  ct.command("create").description("Create a content type").requiredOption("--data <json>", "JSON content type definition").action(async (cmdOpts) => {
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
  ct.command("get <id>").description("Get content type by ID").action(async (id) => {
    const opts = program2.opts();
    try {
      const data = await apiRequest({ path: `/org/content-types/${id}`, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  ct.command("update <id>").description("Update a content type").requiredOption("--data <json>", "JSON content type updates").action(async (id, cmdOpts) => {
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
  ct.command("delete <id>").description("Delete a content type").action(async (id) => {
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
  const prompts = program2.command("prompts").description("Manage prompts (geo questions)");
  prompts.command("list").description("List prompts").action(async () => {
    const opts = program2.opts();
    try {
      const data = await apiRequest({ path: "/org/prompts", apiKey: opts.apiKey, baseUrl: opts.baseUrl });
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  prompts.command("create").description("Create a prompt").requiredOption("--data <json>", "JSON prompt definition").action(async (cmdOpts) => {
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
  prompts.command("get <promptId>").description("Get prompt with full run history").action(async (promptId) => {
    const opts = program2.opts();
    try {
      const data = await apiRequest({ path: `/org/prompts/${promptId}`, apiKey: opts.apiKey, baseUrl: opts.baseUrl });
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  prompts.command("delete <promptId>").description("Delete a prompt").action(async (promptId) => {
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
  const rc = program2.command("run-config").description("Run configuration (models, schedule)");
  rc.command("models").description("Get configured AI models").action(async () => {
    const opts = program2.opts();
    try {
      const data = await apiRequest({ path: "/org/run-models", apiKey: opts.apiKey, baseUrl: opts.baseUrl });
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  rc.command("set-models").description("Set AI models").requiredOption("--data <json>", "JSON model configuration").action(async (cmdOpts) => {
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
  rc.command("schedule").description("Get run schedule").action(async () => {
    const opts = program2.opts();
    try {
      const data = await apiRequest({ path: "/org/run-schedule", apiKey: opts.apiKey, baseUrl: opts.baseUrl });
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  rc.command("set-schedule").description("Set run schedule").requiredOption("--data <json>", "JSON schedule configuration").action(async (cmdOpts) => {
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
  const members = program2.command("members").description("Organization members");
  members.command("list").description("List organization members").action(async () => {
    const opts = program2.opts();
    try {
      const data = await apiRequest({ path: "/org/members", apiKey: opts.apiKey, baseUrl: opts.baseUrl });
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
}

// src/commands/notifications.ts
function registerNotificationCommands(program2) {
  const notif = program2.command("notifications").description("Manage notifications");
  notif.command("list").description("List notifications").action(async () => {
    const opts = program2.opts();
    try {
      const data = await apiRequest({ path: "/app/v1/notifications", apiKey: opts.apiKey, baseUrl: opts.baseUrl });
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      error(formatApiError(err));
      process.exit(1);
    }
  });
  notif.command("read <id>").description("Mark notification as read").action(async (id) => {
    const opts = program2.opts();
    try {
      await apiRequest({
        method: "POST",
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
function registerUpdateCommand(program2) {
  program2.command("update").description("Update CLI to the latest version").action(async () => {
    info(`Current version: ${pc7.bold(version)}`);
    info("Checking for updates...");
    const release = await getLatestRelease();
    if (!release) {
      error("Could not check for updates. Try again later.");
      process.exit(1);
    }
    const latest = release.tag_name.replace(/^v/, "");
    if (!semver2.gt(latest, version)) {
      success(`Already on the latest version (${version}).`);
      return;
    }
    info(`New version available: ${pc7.bold(latest)}`);
    info("Updating...");
    try {
      execSync("npm install -g senso-user-cli@latest", {
        stdio: "inherit"
      });
      success(`Updated to v${latest}.`);
      if (release.body) {
        console.log();
        console.log(pc7.dim("Release notes:"));
        console.log(pc7.dim(release.body.slice(0, 500)));
      }
    } catch {
      warn("Global npm install failed. Trying npx reinstall...");
      try {
        execSync(
          "npx --yes github:AI-Template-SDK/senso-user-cli --version",
          { stdio: "inherit" }
        );
        success("Updated via npx cache refresh.");
      } catch {
        error("Update failed. Please reinstall manually:");
        console.log(
          `  ${pc7.cyan("npm install -g senso-user-cli")}`
        );
        console.log(
          `  ${pc7.dim("or")} ${pc7.cyan("npx github:AI-Template-SDK/senso-user-cli")}`
        );
        process.exit(1);
      }
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
registerCategoryCommands(program);
registerTopicCommands(program);
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
