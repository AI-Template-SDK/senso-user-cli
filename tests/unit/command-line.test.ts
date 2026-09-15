/**
 * Unit: rebuilding the command line that produced this invocation.
 *
 * WHAT IS WORTH PROTECTING HERE. Every "next page" and "next step" the CLI
 * offers has to be runnable as printed. A paging hint that says `--offset 50`
 * without the filters the caller already typed sends an agent to a different
 * result set than the one it was paging through — which is worse than saying
 * nothing, because it looks correct.
 *
 * So the line is reconstructed from Commander's own record of the invocation,
 * and `getOptionValueSource` is what makes that exact: a declared default must
 * not appear in the rebuilt line, or the hint would invent flags the caller
 * never passed.
 */

import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { commandLine, commandPath, hasOption } from "../../src/lib/command-line.js";

/** A miniature `senso kb my-files`, parsed the way Commander parses the real one. */
function parse(args: string[]): Command {
  const program = new Command("senso");
  const kb = program.command("kb");
  const myFiles = kb
    .command("my-files")
    .option("--limit <n>", "page size", "50")
    .option("--offset <n>", "skip", "0")
    .option("--status <status>", "ingestion state")
    .option("--tag-ids <ids...>", "tag filter")
    .option("--no-gap-signals", "keep out of the gap report")
    .action(() => undefined);
  program.parse(args, { from: "user" });
  return myFiles;
}

describe("commandPath", () => {
  it("is the path without the program name", () => {
    expect(commandPath(parse(["kb", "my-files"]))).toBe("kb my-files");
  });
});

describe("commandLine", () => {
  it("keeps the filters the caller typed, so the next page is the same query", () => {
    const cmd = parse(["kb", "my-files", "--status", "complete", "--limit", "50"]);

    expect(commandLine(cmd, { offset: 50 })).toBe(
      "senso kb my-files --limit 50 --offset 50 --status complete",
    );
  });

  it("omits an option the caller never passed, even though it has a default", () => {
    // `--limit` defaults to 50. Emitting it would put a flag in the hint that
    // the caller did not choose, and that they would then carry forward.
    const cmd = parse(["kb", "my-files"]);

    expect(commandLine(cmd, { offset: 20 })).toBe("senso kb my-files --offset 20");
  });

  it("re-sends a variadic option the way it was typed", () => {
    const cmd = parse(["kb", "my-files", "--tag-ids", "a", "b"]);

    expect(commandLine(cmd)).toContain("--tag-ids a b");
  });

  it("emits a negated flag only when it was actually passed", () => {
    expect(commandLine(parse(["kb", "my-files"]))).not.toContain("--no-gap-signals");
    expect(commandLine(parse(["kb", "my-files", "--no-gap-signals"]))).toContain(
      "--no-gap-signals",
    );
  });

  it("quotes a value a shell would otherwise split", () => {
    const program = new Command("senso");
    const search = program
      .command("search <query>")
      .option("--label <text>", "")
      .action(() => undefined);
    program.parse(["search", "what is our refund policy", "--label", "a b"], { from: "user" });

    const line = commandLine(search);
    expect(line).toContain("'what is our refund policy'");
    expect(line).toContain("--label 'a b'");
  });

  it("skips an override for a flag the command does not declare", () => {
    // Otherwise a shared paging helper could invent `--offset` on a command
    // that has no such flag, and print a line that fails when run.
    const program = new Command("senso");
    const stats = program.command("stats").action(() => undefined);
    program.parse(["stats"], { from: "user" });

    expect(commandLine(stats, { offset: 10 })).toBe("senso stats");
    expect(hasOption(stats, "offset")).toBe(false);
  });
});
