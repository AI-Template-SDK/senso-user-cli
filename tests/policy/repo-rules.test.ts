/**
 * Rules this repository writes down, enforced so they cannot quietly drift.
 *
 * Every check here exists because the rule it protects was already stated
 * somewhere — in CONTRIBUTING.md, in a config comment, or in the plan — and
 * stating a rule has never once been enough to keep it true. The README was 89
 * subcommands behind the code; the skills list shipped one skill short for a
 * release; the spelling rule was written down and broken anyway.
 *
 * Each failure message names the offender. "expected [] to deeply equal []"
 * helps nobody at six in the evening.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createProgram } from "../../src/program.js";

const REPO_ROOT = join(import.meta.dirname, "../..");
const read = (p: string) => readFileSync(join(REPO_ROOT, p), "utf-8");
const pkg = JSON.parse(read("package.json")) as {
  version: string;
  engines: { node: string };
  files: string[];
  bin: Record<string, string>;
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

// ---------------------------------------------------------------------------
// American English
// ---------------------------------------------------------------------------

/**
 * British spelling to the American form to use instead.
 *
 * Patterns, not substrings, and the difference matters: matching the bare
 * substring `fulfil` flags "fulfilled", which is spelled the same in both
 * dialects. Stems that only ever appear as prefixes match loosely; whole words
 * are anchored on both sides.
 */
const BRITISH: { pattern: RegExp; american: string }[] = [
  { pattern: /organis(e|ed|es|ing|ation|ational)?\b/i, american: "organiz-" },
  { pattern: /authoris(e|ed|es|ing|ation)?\b/i, american: "authoriz-" },
  { pattern: /recognis(e|ed|es|ing)?\b/i, american: "recogniz-" },
  { pattern: /customis(e|ed|es|ing|ation)?\b/i, american: "customiz-" },
  { pattern: /optimis(e|ed|es|ing|ation)?\b/i, american: "optimiz-" },
  { pattern: /summaris(e|ed|es|ing)?\b/i, american: "summariz-" },
  { pattern: /synthesis(e|ed|es|ing)\b/i, american: "synthesiz-" },
  { pattern: /normalis(e|ed|es|ing)?\b/i, american: "normaliz-" },
  { pattern: /analys(e|ed|es|ing)\b/i, american: "analyz-" },
  { pattern: /\bbehaviour/i, american: "behavior" },
  { pattern: /\bcolour/i, american: "color" },
  { pattern: /\bfavourite/i, american: "favorite" },
  { pattern: /\blicence\b/i, american: "license" },
  { pattern: /\bcentre\b/i, american: "center" },
  { pattern: /\bcatalogue\b/i, american: "catalog" },
  { pattern: /\bcancelled\b|\bcancelling\b/i, american: "canceled / canceling" },
  {
    pattern: /\bfulfil\b|\bfulfils\b|\bfulfilment\b/i,
    american: "fulfill / fulfills / fulfillment",
  },
];

/**
 * Source with comments and string literals removed.
 *
 * The dependency scan below matches `from "x"`, and prose in a comment —
 * "a page of results" from "one object that happens to contain a list" — matches
 * that shape too. A policy test that reports an English phrase as a missing
 * dependency is one nobody reads twice.
 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function walk(dir: string, ext: RegExp, acc: string[] = []): string[] {
  const full = join(REPO_ROOT, dir);
  if (!existsSync(full)) return acc;
  for (const entry of readdirSync(full)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const rel = join(dir, entry);
    if (statSync(join(REPO_ROOT, rel)).isDirectory()) walk(rel, ext, acc);
    else if (ext.test(entry)) acc.push(rel);
  }
  return acc;
}

describe("American English on every surface a reader sees", () => {
  it("uses American spellings throughout src/", () => {
    // Scope is the reader-visible surface: help text, error messages, prose.
    // This file is exempt because it has to name the wrong spellings in order
    // to forbid them.
    const offenders: string[] = [];

    for (const rel of walk("src", /\.ts$/)) {
      read(rel)
        .split("\n")
        .forEach((line, i) => {
          for (const { pattern, american } of BRITISH) {
            const hit = pattern.exec(line);
            if (hit) offenders.push(`${rel}:${i + 1} "${hit[0]}" → use "${american}"`);
          }
        });
    }

    expect(offenders, `British spellings found:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Node version, pinned in four places that must move together
// ---------------------------------------------------------------------------

describe("the Node version is pinned consistently", () => {
  it("agrees across .nvmrc, package.json engines, CI and the bundler target", () => {
    // Four places. Moving off a Node major is a deliberate decision made across
    // all of them, not a bump to merge — which is only true if a mismatch fails
    // the build.
    const nvmrc = read(".nvmrc").trim();
    const engines = pkg.engines.node;
    const ci = read(".github/workflows/testing.yml");
    const tsup = read("tsup.config.ts");

    // The development version: what .nvmrc pins and what CI runs by default.
    expect(ci, ".nvmrc says Node " + nvmrc + " but the CI NODE_VERSION does not match").toContain(
      `NODE_VERSION: "${nvmrc}"`,
    );

    // The floor: what `engines` promises and what the bundle targets. These are
    // deliberately lower than the development version — the CLI supports Node
    // 18 even though it is developed on 22.
    const floor = /(\d+)/.exec(engines)?.[1];
    expect(floor, "package.json engines.node has no numeric floor").toBeTruthy();
    expect(tsup, `engines.node allows Node ${floor} but tsup targets something else`).toContain(
      `node${floor}`,
    );

    // The e2e matrix must actually test the floor, or the promise is untested.
    expect(ci, `the CI matrix does not include the supported floor, Node ${floor}`).toMatch(
      new RegExp(`node:.*"${floor}"`),
    );
  });
});

// ---------------------------------------------------------------------------
// What ships to npm
// ---------------------------------------------------------------------------

describe("the published package", () => {
  it("ships only the built bundle", () => {
    // Shipping src/ or tests/ inflates every install and implies a support
    // surface that is not offered.
    expect(pkg.files).toEqual(["dist"]);
  });

  it("points bin at a path inside what it ships", () => {
    for (const target of Object.values(pkg.bin)) {
      expect(target, `bin entry ${target} is outside the published files`).toMatch(/^\.\/dist\//);
    }
  });

  it("declares every runtime import as a dependency, not a devDependency", () => {
    // A runtime import listed under devDependencies works locally and breaks on
    // the first clean install. tsup bundles, which hides this until someone
    // switches to an external import.
    const runtimeImports = new Set<string>();
    for (const rel of walk("src", /\.ts$/)) {
      for (const m of code(read(rel)).matchAll(/^\s*(?:import|export)[^;]*?from "([^"]+)"/gm)) {
        const spec = m[1];
        if (!spec || spec.startsWith(".") || spec.startsWith("node:")) continue;
        runtimeImports.add(
          spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!,
        );
      }
    }

    const missing = [...runtimeImports].filter((dep) => !(dep in pkg.dependencies));
    expect(missing, `imported by src/ but not in dependencies: ${missing.join(", ")}`).toEqual([]);
  });

  it("declares no dependency it never imports", () => {
    const imported = new Set<string>();
    for (const rel of walk("src", /\.ts$/)) {
      for (const m of code(read(rel)).matchAll(/^\s*(?:import|export)[^;]*?from "([^"]+)"/gm)) {
        const spec = m[1];
        if (!spec || spec.startsWith(".") || spec.startsWith("node:")) continue;
        imported.add(
          spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!,
        );
      }
    }

    const unused = Object.keys(pkg.dependencies).filter((d) => !imported.has(d));
    expect(unused, `in dependencies but never imported: ${unused.join(", ")}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Help text, which is what an agent reads
// ---------------------------------------------------------------------------

/** Every (path, command) pair in the tree, depth-first. */
function allCommands(): { path: string; cmd: import("commander").Command }[] {
  const out: { path: string; cmd: import("commander").Command }[] = [];
  const visit = (cmd: import("commander").Command, prefix: string): void => {
    for (const sub of cmd.commands) {
      const path = `${prefix} ${sub.name()}`.trim();
      out.push({ path, cmd: sub });
      visit(sub, path);
    }
  };
  visit(createProgram(), "");
  return out;
}

describe("every command explains itself", () => {
  const commands = allCommands();

  it("found the whole command tree", () => {
    expect(commands.length).toBeGreaterThan(100);
  });

  it("gives every command a description", () => {
    // The description is the entire interface for an agent choosing a command.
    const missing = commands.filter(({ cmd }) => !cmd.description().trim()).map(({ path }) => path);

    expect(missing, `commands with no description:\n  ${missing.join("\n  ")}`).toEqual([]);
  });

  it("gives every option a description", () => {
    const missing: string[] = [];
    for (const { path, cmd } of commands) {
      for (const opt of cmd.options) {
        if (!opt.description.trim()) missing.push(`${path} ${opt.flags}`);
      }
    }

    expect(missing, `options with no description:\n  ${missing.join("\n  ")}`).toEqual([]);
  });

  it("has no duplicate command paths", () => {
    // Two commands registered at the same path means one is unreachable, and
    // Commander picks silently.
    const seen = new Map<string, number>();
    for (const { path } of commands) seen.set(path, (seen.get(path) ?? 0) + 1);
    const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([p]) => p);

    expect(dupes, `duplicate command paths: ${dupes.join(", ")}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The skills list, which drifted once already
// ---------------------------------------------------------------------------

describe("the bundled skills list", () => {
  it("matches the fixture recorded from the registry", () => {
    // senso-onboarding shipped from senso-contextos and was never added here,
    // so `skills install --all` quietly installed six of seven for a release.
    // The fixture is refreshed by the scheduled drift job; a mismatch means
    // either the registry moved or this list did.
    const fixture = JSON.parse(read("tests/fixtures/senso-skills.json")) as { skills: string[] };
    const source = read("src/commands/skills.ts");
    const listed = [...source.matchAll(/"(senso-ai\/senso-[a-z-]+)"/g)].map((m) => m[1]!);

    expect(new Set(listed)).toEqual(new Set(fixture.skills));
  });
});

// ---------------------------------------------------------------------------
// The Makefile is the CI contract
// ---------------------------------------------------------------------------

describe("CI and the Makefile cannot mean different things", () => {
  const makefile = read("Makefile");
  const ci = read(".github/workflows/testing.yml");

  it("has every target CI invokes", () => {
    // The character class includes digits on purpose: `[a-z-]+` stopped at the
    // digit in `e2e` and captured "e" on both sides, so this check passed by
    // coincidence rather than by matching anything.
    const invoked = [...ci.matchAll(/run: make ([a-z0-9-]+)/g)].map((m) => m[1]!);
    const defined = [...makefile.matchAll(/^([a-z0-9-]+):/gm)].map((m) => m[1]!);

    const missing = [...new Set(invoked)].filter((t) => !defined.includes(t));
    expect(
      missing,
      `CI runs "make ${missing.join(", ")}" but the Makefile defines no such target`,
    ).toEqual([]);
  });

  it("scopes the test targets to one vitest project each", () => {
    // The bug this exists for: `make unit` ran `vitest run --coverage` with no
    // project filter, so it also ran the e2e project — which drives the BUILT
    // bundle that `unit` does not build. It passed on every developer machine,
    // because a stale dist/ from an earlier build was always lying around, and
    // failed in CI on a clean checkout. That is precisely the "cannot mean
    // different things" property the Makefile exists to provide.
    const unit = /^unit:[^\n]*\n\t([^\n]*)/m.exec(makefile)?.[1] ?? "";
    const e2e = /^e2e:[^\n]*\n(?:[^\n]*\n)*?\t([^\n]*vitest[^\n]*)/m.exec(makefile)?.[1] ?? "";

    expect(unit, "`make unit` must pass --project unit, or it also runs e2e").toContain(
      "--project unit",
    );
    expect(e2e, "`make e2e` must pass --project e2e").toContain("--project e2e");
  });

  it("documents every target with a help line", () => {
    // `make help` is the discovery mechanism; a target without `## ` is
    // invisible to anyone who has not read the file.
    const undocumented = [...makefile.matchAll(/^([a-z0-9-]+):(?!=)([^\n]*)$/gm)]
      .filter(([, , rest]) => !rest?.includes("##"))
      .map(([, name]) => name!)
      .filter((name) => name !== "all");

    expect(
      undocumented,
      `Makefile targets with no ## help text: ${undocumented.join(", ")}`,
    ).toEqual([]);
  });
});
