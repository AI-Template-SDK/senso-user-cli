/**
 * The repository's own rules about who may write to a stream.
 *
 * ESLint already blocks `console.*` and `process.stdout.write` outside the three
 * modules that own the streams, so why also test it? Because a lint rule can be
 * disabled inline, a file can be added to the exempt list, and neither shows up
 * as a behavior change in review. This test reads the source and the ESLint
 * config and fails if the exemption list grows — so widening the contract
 * becomes a deliberate edit to a file called `output-contract.test.ts` rather
 * than a quiet line in a config.
 *
 * The rule exists because breaking it is how the banner ended up on stdout,
 * making `--output json | jq` fail for every caller who did not also pass
 * `--quiet`.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPO_ROOT = join(import.meta.dirname, "../..");
const SRC = join(REPO_ROOT, "src");

/**
 * The only modules allowed to touch a stream directly.
 *
 * Adding to this list widens what can print without going through the output
 * contract. If you are about to do that, the answer is almost always a new
 * function in lib/output.ts or utils/logger.ts instead.
 */
const STREAM_OWNERS = [
  "src/lib/output.ts",
  "src/utils/logger.ts",
  "src/utils/branding.ts",
  // The bin entry reports a failure that happened before any context existed,
  // and is the one file permitted to end the process.
  "src/cli.ts",
];

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, acc);
    } else if (entry.endsWith(".ts")) {
      acc.push(full);
    }
  }
  return acc;
}

const files = sourceFiles(SRC).map((f) => ({
  path: relative(REPO_ROOT, f).replaceAll("\\", "/"),
  body: readFileSync(f, "utf-8"),
}));

describe("the search found something to check", () => {
  it("collected the command and library sources", () => {
    // A guard on the guard: a broken glob that matches nothing would make every
    // assertion below pass vacuously.
    expect(files.length).toBeGreaterThan(30);
  });
});

describe("only the stream owners write to a stream", () => {
  it("no other module calls console.*", () => {
    const offenders = files
      .filter((f) => !STREAM_OWNERS.includes(f.path))
      .filter((f) => /\bconsole\s*\./.test(stripComments(f.body)))
      .map((f) => f.path);

    expect(
      offenders,
      "These files write to the console directly, which bypasses --output and --quiet " +
        "and can put non-payload text on stdout. Print through lib/output.ts or " +
        "utils/logger.ts instead:\n  " +
        offenders.join("\n  "),
    ).toEqual([]);
  });

  it("no other module writes to process.stdout or process.stderr", () => {
    // `.write` only, matching the ESLint rule. Reading `process.stdout.isTTY` to
    // decide whether an animated spinner is safe is a legitimate check —
    // lib/progress.ts does exactly that — and banning the object rather than the
    // write would forbid it.
    const offenders = files
      .filter((f) => !STREAM_OWNERS.includes(f.path))
      .filter((f) => /process\s*\.\s*std(out|err)\s*\.\s*write\s*\(/.test(stripComments(f.body)))
      .map((f) => f.path);

    expect(
      offenders,
      "These files write to a raw stream, stepping around the console ban. " +
        "lib/output.ts exports writeStdout() for streamed payload:\n  " +
        offenders.join("\n  "),
    ).toEqual([]);
  });
});

describe("only the bin entry ends the process", () => {
  it("no command or library module calls process.exit", () => {
    // An action that exits cannot be tested in-process — the test runner dies
    // with it — and it skips the exit-code mapping entirely.
    const offenders = files
      .filter((f) => f.path !== "src/cli.ts")
      .filter((f) => /process\s*\.\s*exit\s*\(/.test(stripComments(f.body)))
      .map((f) => f.path);

    expect(
      offenders,
      "These files call process.exit(). Throw a CliError instead — src/cli.ts is " +
        "the only file that may exit:\n  " +
        offenders.join("\n  "),
    ).toEqual([]);
  });
});

describe("every command action goes through runAction", () => {
  it("no .action() is passed a bare function", () => {
    // A bare action bypasses the error mapping, the exit codes and the resolved
    // context — which is exactly the state the refactor moved the CLI out of.
    const offenders: string[] = [];

    for (const file of files) {
      if (!file.path.startsWith("src/commands/")) continue;
      const body = stripComments(file.body);
      // The whitespace lives INSIDE the lookahead on purpose. With `\s*` outside
      // it, the quantifier backtracks to zero characters and the lookahead then
      // succeeds against the newline — flagging every correctly-wrapped file.
      // industries.ts wraps runAction in its own runPartnerAction, which adds
      // the partner-key explanation and is itself built on runAction.
      const pattern = /\.action\((?!\s*(?:runAction|runPartnerAction)\b)/;
      if (pattern.test(body)) {
        offenders.push(file.path);
      }
    }

    expect(
      offenders,
      "These files register an action without runAction(), so its failures skip " +
        "the exit-code contract:\n  " +
        offenders.join("\n  "),
    ).toEqual([]);
  });
});

describe("the ESLint config still enforces all of this", () => {
  const config = readFileSync(join(REPO_ROOT, "eslint.config.mjs"), "utf-8");

  it("bans console outside the stream owners", () => {
    expect(config).toContain("MemberExpression[object.name='console']");
  });

  it("bans the raw streams too", () => {
    expect(config).toMatch(/stdout\|stderr/);
  });

  it("bans process.exit", () => {
    expect(config).toContain("no-restricted-properties");
    expect(config).toContain('property: "exit"');
  });

  it("exempts exactly the modules this test exempts", () => {
    // The two lists drifting apart is the failure mode: the test would keep
    // passing while the linter quietly allowed a fourth file to print.
    const declared = [...config.matchAll(/"(src\/(?:lib|utils)\/[a-z-]+\.ts)"/g)].map((m) => m[1]);

    expect(new Set(declared)).toEqual(
      new Set(["src/lib/output.ts", "src/utils/logger.ts", "src/utils/branding.ts"]),
    );
  });
});

/**
 * Strips comments and string literals before matching.
 *
 * Without this, every comment mentioning `console.log` — including the ones in
 * lib/output.ts explaining the rule — counts as a violation, and a test that
 * cries wolf gets suppressed.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
}
