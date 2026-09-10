/**
 * Reports the gap between what the Senso API offers and what this CLI exposes.
 *
 * The API moves faster than the CLI, and there is no mechanism that notices. On
 * 2026-09-09 eighteen documented endpoints had no command and one command hit a
 * path the spec did not document — found by hand, during an audit, months after
 * the fact.
 *
 * This runs weekly and on demand rather than on a pull request, because it
 * fetches the live spec over the network and a pull request gate must not depend
 * on a third party being up. A pull request instead gets the offline half:
 * tests/policy compares the CLI against the vendored snapshot in
 * tests/fixtures/api-paths.json.
 *
 *   npx tsx scripts/spec-drift.ts            # human-readable report
 *   npx tsx scripts/spec-drift.ts --json     # for the workflow
 *   npx tsx scripts/spec-drift.ts --update   # refresh the vendored snapshot
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SPEC_URL = "https://docs.senso.ai/specs/sdk-api.yaml";
const SNAPSHOT = join(import.meta.dirname, "../tests/fixtures/api-paths.json");
const EXCLUDED = join(import.meta.dirname, "../docs/reference/excluded-endpoints.md");

/** `/org/prompts/{promptId}` and `/org/prompts/{id}` are the same endpoint. */
function normalize(path: string): string {
  return path.replace(/\{[^}]*\}/g, "{}");
}

/**
 * Every API path the CLI can reach.
 *
 * Read out of the source rather than by instrumenting the commands, because
 * calling them would require a live key and a great deal of state.
 *
 * Matching any `/org/...` or `/partner/...` string literal, rather than only
 * `path:` properties: `search.ts` registers its four variants through a helper
 * that takes the path as a parameter, so a `path:`-only scan reported three
 * implemented commands as missing. A literal that looks like an API path is one,
 * wherever it appears.
 */
export function cliPaths(): Set<string> {
  const files = walkSource(join(import.meta.dirname, "../src"));
  const paths = new Set<string>();
  for (const file of files) {
    const body = readFileSync(file, "utf-8");
    for (const m of body.matchAll(/[`"](\/(?:org|partner)\/[^`"\s]*)[`"]/g)) {
      const raw = m[1];
      if (!raw) continue;
      // Template interpolations become the same placeholder as spec params.
      paths.add(normalize(raw.replace(/\$\{[^}]+\}/g, "{}")));
    }
  }
  return paths;
}

function walkSource(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkSource(full, acc);
    else if (entry.endsWith(".ts")) acc.push(full);
  }
  return acc;
}

/** Paths the CLI deliberately does not expose, read from the reference doc. */
function excludedPaths(): Set<string> {
  const out = new Set<string>();
  try {
    for (const m of readFileSync(EXCLUDED, "utf-8").matchAll(/^\|\s*`([A-Z]+)\s+([^`]+)`/gm)) {
      if (m[2]) out.add(normalize(m[2]));
    }
  } catch {
    // The document is optional; without it nothing is excluded.
  }
  return out;
}

interface SpecOperation {
  method: string;
  path: string;
}

/**
 * Parses the paths out of the OpenAPI document.
 *
 * Deliberately not a YAML library: this needs only the top-level `paths:` keys
 * and the HTTP verbs under each, and adding a parser dependency to a script that
 * runs once a week is not worth it. The format is stable and machine-generated.
 */
export function parseSpecPaths(yaml: string): SpecOperation[] {
  const ops: SpecOperation[] = [];
  const lines = yaml.split("\n");
  let inPaths = false;
  let current: string | null = null;

  for (const line of lines) {
    if (/^paths:\s*$/.test(line)) {
      inPaths = true;
      continue;
    }
    if (!inPaths) continue;
    // A non-indented key ends the paths block.
    if (/^\S/.test(line)) break;

    const pathMatch = /^ {2}(\/\S*):\s*$/.exec(line);
    if (pathMatch?.[1]) {
      current = pathMatch[1];
      continue;
    }
    const verbMatch = /^ {4}(get|post|put|patch|delete):\s*$/.exec(line);
    if (verbMatch?.[1] && current) {
      ops.push({ method: verbMatch[1].toUpperCase(), path: current });
    }
  }
  return ops;
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));

  const res = await fetch(SPEC_URL, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) {
    console.error(`Could not fetch the spec: ${String(res.status)} ${res.statusText}`);
    process.exit(1);
  }
  const ops = parseSpecPaths(await res.text());
  if (ops.length === 0) {
    console.error("Parsed zero operations from the spec — the format has probably changed.");
    process.exit(1);
  }

  const specPaths = new Set(ops.map((o) => normalize(o.path)));
  const cli = cliPaths();
  const excluded = excludedPaths();

  const missing = ops.filter(
    (o) => !cli.has(normalize(o.path)) && !excluded.has(normalize(o.path)),
  );
  // A CLI path absent from the spec is the more alarming direction: either the
  // spec is behind, or the command calls something that is not public API.
  const undocumented = [...cli].filter((p) => !specPaths.has(p) && !p.startsWith("/partner/"));

  if (args.has("--update")) {
    writeFileSync(
      SNAPSHOT,
      JSON.stringify(
        {
          _comment:
            "API paths from the published OpenAPI spec, vendored so the offline policy test can compare without a network call. Refresh with: npx tsx scripts/spec-drift.ts --update",
          _source: SPEC_URL,
          _captured: new Date().toISOString().slice(0, 10),
          paths: [...specPaths].sort(),
        },
        null,
        2,
      ) + "\n",
    );
    console.log(`Wrote ${SNAPSHOT} (${String(specPaths.size)} paths)`);
    return;
  }

  if (args.has("--json")) {
    console.log(
      JSON.stringify(
        { missing, undocumented, counts: { spec: ops.length, cli: cli.size } },
        null,
        2,
      ),
    );
  } else {
    console.log(`Spec operations: ${String(ops.length)}   CLI paths: ${String(cli.size)}`);
    console.log(`Documented but not exposed: ${String(missing.length)}`);
    for (const o of missing) console.log(`  ${o.method.padEnd(6)} ${o.path}`);
    console.log(`Called by the CLI but not in the spec: ${String(undocumented.length)}`);
    for (const p of undocumented) console.log(`  ${p}`);
  }

  // Non-zero when there is drift, so the workflow can branch on it.
  if (missing.length > 0 || undocumented.length > 0) process.exitCode = 1;
}

if (process.argv[1]?.endsWith("spec-drift.ts")) {
  void main();
}
