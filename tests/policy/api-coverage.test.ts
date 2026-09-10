/**
 * The CLI's coverage of the Senso API, checked without touching the network.
 *
 * The live check lives in `scripts/spec-drift.ts` and runs weekly, because
 * fetching the published spec is exactly the kind of dependency a pull request
 * gate must not have. This is its offline half: it compares the command tree
 * against a vendored snapshot of the spec, so a command that starts calling an
 * undocumented path — or an endpoint that quietly loses its command — fails on
 * the pull request that did it rather than the following Monday.
 *
 * The snapshot goes stale on purpose: it records what the API looked like when
 * it was captured. The weekly job refreshes it. If this test fails because the
 * API has moved, the fix is `npx tsx scripts/spec-drift.ts --update`, not an
 * edit to the assertion.
 *
 * This gap was real and large. On 2026-09-09 eighteen documented endpoints had
 * no command, and one command reached a path the spec did not describe — found
 * by hand during an audit, months after the fact.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dirname, "../..");
const SNAPSHOT = join(REPO_ROOT, "tests/fixtures/api-paths.json");
const EXCLUDED_DOC = join(REPO_ROOT, "docs/reference/excluded-endpoints.md");

/** `/org/prompts/{promptId}` and `/org/prompts/{id}` are the same endpoint. */
function normalize(path: string): string {
  return path.replace(/\{[^}]*\}/g, "{}");
}

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, acc);
    else if (entry.endsWith(".ts")) acc.push(full);
  }
  return acc;
}

/**
 * Every API path the CLI can reach.
 *
 * Any `/org/...` or `/partner/...` string literal counts, not only a `path:`
 * property: `search.ts` passes its endpoint to a helper as an argument, so a
 * narrower scan reported three implemented commands as missing.
 */
function cliPaths(): Set<string> {
  const paths = new Set<string>();
  for (const file of sourceFiles(join(REPO_ROOT, "src"))) {
    for (const m of readFileSync(file, "utf-8").matchAll(
      /[`"](\/(?:org|partner)\/[^`"\s]*)[`"]/g,
    )) {
      if (m[1]) paths.add(normalize(m[1].replace(/\$\{[^}]+\}/g, "{}")));
    }
  }
  return paths;
}

/** Paths recorded as deliberately absent, read from the reference document. */
function excludedPaths(): Set<string> {
  const out = new Set<string>();
  if (!existsSync(EXCLUDED_DOC)) return out;
  for (const m of readFileSync(EXCLUDED_DOC, "utf-8").matchAll(/`([A-Z]+)\s+(\/[^`]+)`/g)) {
    if (m[2]) out.add(normalize(m[2]));
  }
  return out;
}

const snapshot = JSON.parse(readFileSync(SNAPSHOT, "utf-8")) as {
  paths: string[];
  _captured: string;
};
const specPaths = new Set(snapshot.paths.map(normalize));
const cli = cliPaths();
const excluded = excludedPaths();

describe("the vendored spec snapshot", () => {
  it("is present and plausible", () => {
    // A guard on the guard: an empty or truncated snapshot would make every
    // assertion below pass while checking nothing.
    expect(specPaths.size).toBeGreaterThan(80);
    expect(snapshot._captured).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("found the CLI's own paths", () => {
    expect(cli.size).toBeGreaterThan(80);
  });
});

describe("every documented endpoint has a command", () => {
  it("or is recorded as deliberately excluded", () => {
    const missing = [...specPaths].filter((p) => !cli.has(p) && !excluded.has(p)).sort();

    expect(
      missing,
      "These endpoints are in the API spec but no command reaches them.\n" +
        "Add a command, or add a row to docs/reference/excluded-endpoints.md saying why not:\n  " +
        missing.join("\n  "),
    ).toEqual([]);
  });
});

describe("every path the CLI calls is documented", () => {
  it("or is recorded as a known discrepancy", () => {
    // The more alarming direction: a command reaching something the published
    // contract does not describe means either the spec is behind or the command
    // is calling something that is not public API.
    //
    // /partner/* is excluded because the partner API has its own spec, which is
    // not the document this snapshot came from.
    const undocumented = [...cli]
      .filter((p) => !p.startsWith("/partner/"))
      .filter((p) => !specPaths.has(p) && !excluded.has(p))
      .sort();

    expect(
      undocumented,
      "These paths are called by the CLI but are not in the API spec.\n" +
        "Either the snapshot is stale (`npx tsx scripts/spec-drift.ts --update`),\n" +
        "or the command is calling something that is not public API:\n  " +
        undocumented.join("\n  "),
    ).toEqual([]);
  });
});
