/**
 * Generates docs/reference/commands.md by walking the real command tree.
 *
 * The README was 89 subcommands behind the code because the command list was
 * maintained by hand, and nothing checked. Generating it removes the class of
 * problem: `make reference` rewrites the file from `createProgram()`, and
 * tests/policy/reference.test.ts fails the build if the committed file is stale.
 *
 * Run it after adding, renaming or removing a command:
 *
 *     make reference
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import { createProgram } from "../src/program.js";

const OUTPUT = join(import.meta.dirname, "../docs/reference/commands.md");

interface Entry {
  path: string;
  depth: number;
  description: string;
  usage: string;
  options: { flags: string; description: string; defaultValue?: unknown }[];
  hasChildren: boolean;
}

function collect(cmd: Command, prefix: string, depth: number, acc: Entry[]): void {
  for (const sub of cmd.commands) {
    // Commander registers the auto-generated `help` command as a sibling. It is
    // not part of this CLI's surface and documenting it adds noise.
    if (sub.name() === "help") continue;

    const path = `${prefix} ${sub.name()}`.trim();
    acc.push({
      path,
      depth,
      description: sub.description(),
      usage: sub.usage(),
      options: sub.options.map((o) => ({
        flags: o.flags,
        description: o.description,
        defaultValue: o.defaultValue,
      })),
      hasChildren: sub.commands.some((c) => c.name() !== "help"),
    });
    collect(sub, path, depth + 1, acc);
  }
}

function escapeCell(s: string): string {
  return s.replaceAll("|", "\\|").replaceAll("\n", " ");
}

// No version number in the output. The policy test fails when this file is
// stale, so a version here made every `npm version` bump fail CI on a commit that
// changed no command. The file should change when the command tree does, and only
// then.
function render(entries: Entry[]): string {
  const lines: string[] = [];

  lines.push("# Command reference");
  lines.push("");
  lines.push(
    "**This file is generated.** Run `make reference` after changing a command; a policy test fails if it is stale.",
  );
  lines.push("");
  lines.push(
    "Generated from the command tree of `@senso-ai/cli`. Every command accepts the [global options](#global-options).",
  );
  lines.push("");

  // Contents, top level only — a full tree would be longer than the document.
  lines.push("## Contents");
  lines.push("");
  for (const e of entries.filter((x) => x.depth === 0)) {
    lines.push(
      `- [\`senso ${e.path}\`](#senso-${e.path.replaceAll(" ", "-")}) — ${escapeCell(firstSentence(e.description))}`,
    );
  }
  lines.push("");

  lines.push("## Global options");
  lines.push("");
  lines.push("These are accepted by every command.");
  lines.push("");
  const program = createProgram();
  lines.push("| Flag | Description |");
  lines.push("|---|---|");
  for (const o of program.options) {
    lines.push(`| \`${escapeCell(o.flags)}\` | ${escapeCell(o.description)} |`);
  }
  lines.push("");
  lines.push("## Exit codes");
  lines.push("");
  lines.push("| Code | Meaning |");
  lines.push("|---|---|");
  lines.push("| 0 | Success |");
  lines.push("| 1 | The API or the runtime refused the request |");
  lines.push("| 2 | Usage error: unknown command, missing argument, bad flag |");
  lines.push("| 3 | Authentication: no key, or the key was rejected |");
  lines.push("| 4 | Not found |");
  lines.push("| 5 | Network failure or timeout |");
  lines.push("");

  lines.push("---");
  lines.push("");

  for (const entry of entries) {
    if (entry.depth === 0) {
      lines.push(`## senso ${entry.path}`);
    } else {
      lines.push(`### senso ${entry.path}`);
    }
    lines.push("");
    if (entry.description) {
      lines.push(entry.description);
      lines.push("");
    }
    lines.push("```");
    lines.push(`senso ${entry.path} ${entry.usage}`.trim());
    lines.push("```");
    lines.push("");

    if (entry.options.length > 0) {
      lines.push("| Option | Description | Default |");
      lines.push("|---|---|---|");
      for (const o of entry.options) {
        const def =
          o.defaultValue === undefined || o.defaultValue === false
            ? ""
            : `\`${describeDefault(o.defaultValue)}\``;
        lines.push(`| \`${escapeCell(o.flags)}\` | ${escapeCell(o.description)} | ${def} |`);
      }
      lines.push("");
    }
  }

  return lines.join("\n") + "\n";
}

/**
 * A Commander default, as text.
 *
 * The value is whatever the caller handed `.option()` — usually a string, but an
 * array for a variadic and an object in principle. JSON for the non-scalars, so
 * a default never renders as "[object Object]" in the published reference.
 */
function describeDefault(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function firstSentence(s: string): string {
  const stop = s.indexOf(". ");
  return stop === -1 ? s : s.slice(0, stop + 1);
}

export function generateReference(): string {
  const program = createProgram();
  const entries: Entry[] = [];
  collect(program, "", 0, entries);
  return render(entries);
}

// Written only when this file is the entry point, so the policy test can import
// `generateReference` and compare against the committed file without rewriting
// it — a test that fixes what it is checking always passes.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const content = generateReference();
  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, content);
  console.log(`Wrote ${OUTPUT} (${String(content.split("\n").length)} lines)`);
}
