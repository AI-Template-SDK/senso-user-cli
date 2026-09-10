/**
 * Read-only checks against a real Senso API, with a real organization key.
 *
 * Every other suite runs against a mock, which is what makes them fast, free and
 * runnable on a fork. That also means none of them would notice the API renaming
 * a field, changing a status code, or removing an endpoint. This would.
 *
 * It is deliberately NOT a pull request gate. It needs a secret, so it cannot
 * run on a fork, and a check that silently skips when the secret is absent
 * reports green without having run — which is worse than no check at all. It
 * runs on a schedule and on demand.
 *
 * Every command here is a read. Nothing in this file creates, updates, deletes
 * or publishes anything, and nothing here spends generation credits.
 *
 *   SENSO_API_KEY=tgr_... npx tsx scripts/live-canary.ts
 *   SENSO_API_KEY=tgr_... npx tsx scripts/live-canary.ts --json
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

const CLI = join(import.meta.dirname, "../dist/cli.js");

/**
 * The checks, in dependency order.
 *
 * `whoami` first: if the key is wrong, every later failure would be the same
 * failure reported nine times.
 */
const CHECKS: { name: string; args: string[]; expect?: (payload: unknown) => string | null }[] = [
  {
    name: "whoami",
    args: ["whoami"],
    expect: (p) => (has(p, "orgId") ? null : "no orgId in the response"),
  },
  {
    name: "org get",
    args: ["org", "get"],
    expect: (p) => (has(p, "name") ? null : "no name in the response"),
  },
  { name: "credits balance", args: ["credits", "balance"] },
  { name: "roles list", args: ["roles", "list"] },
  { name: "permissions list", args: ["permissions", "list"] },
  { name: "members list", args: ["members", "list", "--limit", "1"] },
  { name: "content list", args: ["content", "list", "--limit", "1"] },
  { name: "kb my-files", args: ["kb", "my-files", "--limit", "1"] },
  { name: "prompts list", args: ["prompts", "list", "--limit", "1"] },
  { name: "analytics glossary", args: ["analytics", "glossary"] },
  {
    name: "analytics summary",
    args: ["analytics", "summary"],
    // The shape that matters most: every windowed response carries a window and
    // a notes array, and the renderers depend on both.
    expect: (p) => (has(p, "window") && has(p, "notes") ? null : "missing window or notes"),
  },
  { name: "analytics filters", args: ["analytics", "filters"] },
];

function has(payload: unknown, key: string): boolean {
  return typeof payload === "object" && payload !== null && key in payload;
}

interface Result {
  name: string;
  ok: boolean;
  detail: string;
  ms: number;
}

async function run(): Promise<void> {
  const asJson = process.argv.includes("--json");

  if (!process.env.SENSO_API_KEY) {
    console.error("SENSO_API_KEY is not set. This suite needs a real organization key.");
    process.exit(2);
  }
  if (!existsSync(CLI)) {
    console.error(`${CLI} does not exist. Run \`npm run build\` first.`);
    process.exit(2);
  }

  const results: Result[] = [];

  for (const check of CHECKS) {
    const started = Date.now();
    try {
      const { stdout } = await execFileAsync(
        process.execPath,
        [CLI, ...check.args, "--output", "json"],
        { timeout: 60_000, env: { ...process.env, SENSO_NO_UPDATE_CHECK: "1", NO_COLOR: "1" } },
      );
      const payload: unknown = JSON.parse(stdout);
      const problem = check.expect?.(payload) ?? null;
      results.push({
        name: check.name,
        ok: problem === null,
        detail: problem ?? "",
        ms: Date.now() - started,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({
        name: check.name,
        ok: false,
        // The first line only: execFile appends the whole stderr, which for a
        // failed command is several lines of hint.
        detail: message.split("\n")[0] ?? message,
        ms: Date.now() - started,
      });
    }
  }

  const failed = results.filter((r) => !r.ok);

  if (asJson) {
    console.log(JSON.stringify({ results, failed: failed.length }, null, 2));
  } else {
    for (const r of results) {
      const mark = r.ok ? "ok  " : "FAIL";
      console.log(`  ${mark} ${r.name.padEnd(22)} ${String(r.ms).padStart(5)}ms  ${r.detail}`);
    }
    console.log("");
    console.log(
      failed.length === 0
        ? `live canary: all ${String(results.length)} checks passed`
        : `live canary: ${String(failed.length)} of ${String(results.length)} checks FAILED`,
    );
  }

  process.exitCode = failed.length === 0 ? 0 : 1;
}

void run();
