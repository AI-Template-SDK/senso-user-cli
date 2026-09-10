/**
 * The command reference, and the README's command table, kept honest.
 *
 * This repository's README was 89 subcommands behind the code — not because
 * anyone was careless, but because a hand-maintained list of 186 commands drifts
 * the moment someone adds one and forgets. Generating the reference removed the
 * effort; this test removes the option of skipping it.
 *
 * `docs/reference/commands.md` is produced by `make reference`. If the committed
 * file differs from what the current command tree would generate, the build
 * fails and names the command that moved.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createProgram } from "../../src/program.js";
import { generateReference } from "../../scripts/gen-reference.js";

const REPO_ROOT = join(import.meta.dirname, "../..");
const REFERENCE = join(REPO_ROOT, "docs/reference/commands.md");

/** Every command path in the tree, `help` excluded. */
function commandPaths(): string[] {
  const out: string[] = [];
  const visit = (cmd: import("commander").Command, prefix: string): void => {
    for (const sub of cmd.commands) {
      if (sub.name() === "help") continue;
      const path = `${prefix} ${sub.name()}`.trim();
      out.push(path);
      visit(sub, path);
    }
  };
  visit(createProgram(), "");
  return out;
}

describe("the generated command reference", () => {
  it("exists", () => {
    expect(
      existsSync(REFERENCE),
      "docs/reference/commands.md is missing. Run `make reference`.",
    ).toBe(true);
  });

  it("is current", () => {
    const committed = readFileSync(REFERENCE, "utf-8");
    const generated = generateReference();

    // Compared line by line rather than as one blob: a whole-file diff on a
    // 2,000-line document tells you only that it changed.
    const committedLines = committed.split("\n");
    const generatedLines = generated.split("\n");
    const firstDifference = generatedLines.findIndex((line, i) => committedLines[i] !== line);

    expect(
      firstDifference,
      firstDifference === -1
        ? ""
        : `docs/reference/commands.md is stale — run \`make reference\`.\n` +
            `  First difference at line ${String(firstDifference + 1)}:\n` +
            `    committed: ${committedLines[firstDifference] ?? "(end of file)"}\n` +
            `    generated: ${generatedLines[firstDifference] ?? "(end of file)"}`,
    ).toBe(-1);

    expect(committedLines.length, "the committed reference has a different number of lines").toBe(
      generatedLines.length,
    );
  });

  it("does not contain the package version, so a release cannot make it stale", () => {
    // It used to. `npm version` bumped package.json, the reference still named
    // the old version, and "is current" failed CI on a commit that changed no
    // command — on every release.
    const { version } = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf-8")) as {
      version: string;
    };

    expect(
      generateReference().includes(version),
      `scripts/gen-reference.ts writes the package version (${version}) into the reference. ` +
        "Leave it out: the reference should change when a command does, not on every release.",
    ).toBe(false);
  });

  it("documents every command in the tree", () => {
    // Belt to the braces above: if the generator itself started skipping
    // commands, a byte-identical comparison would still pass.
    const reference = readFileSync(REFERENCE, "utf-8");
    const missing = commandPaths().filter((path) => !reference.includes(`senso ${path}`));

    expect(
      missing,
      `these commands exist but are not in the reference:\n  ${missing.join("\n  ")}`,
    ).toEqual([]);
  });
});

describe("the README's command table", () => {
  const readme = readFileSync(join(REPO_ROOT, "README.md"), "utf-8");
  const groups = createProgram()
    .commands.map((c) => c.name())
    .filter((n) => n !== "help");

  it("names every top-level command group", () => {
    // The README lists groups, not every subcommand — that is the reference's
    // job. But a whole group missing from the front page means a user has no way
    // to discover it.
    const missing = groups.filter((g) => !new RegExp(`\`[^\`]*\\b${g}\\b[^\`]*\``).test(readme));

    expect(
      missing,
      `these command groups are missing from the README's command table:\n  ${missing.join("\n  ")}`,
    ).toEqual([]);
  });

  it("names no command group that does not exist", () => {
    // The other direction: a group renamed or removed leaves the README
    // promising something that is not there.
    const tableSection = readme.slice(readme.indexOf("| Group |"), readme.indexOf("A few worth"));
    const named = [...tableSection.matchAll(/`([a-z][a-z-]+)`/g)].map((m) => m[1]!);
    const phantom = [...new Set(named)].filter((n) => !groups.includes(n));

    expect(
      phantom,
      `the README's command table names groups that do not exist:\n  ${phantom.join("\n  ")}`,
    ).toEqual([]);
  });
});
