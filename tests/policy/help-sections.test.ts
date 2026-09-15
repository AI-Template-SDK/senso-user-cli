/**
 * Policy: every leaf command explains itself the same way.
 *
 * WHAT IS WORTH PROTECTING HERE. The reader of this CLI is an agent. Commander
 * gives it a description, the arguments and the options; the three questions it
 * cannot answer from those are "what comes back", "what does a failure mean",
 * and "what does a correct invocation look like". Left unanswered, it invents
 * all three — which is how the published Senso skills came to tell agents to
 * poll an endpoint that rejects knowledge base content by design.
 *
 * So every leaf command carries Returns, Exit codes and Examples through
 * `describeCommand`, and this test is what stops the next command from
 * shipping without them. It walks the real command tree rather than the source,
 * so a section added to a file but never wired into the help still fails.
 *
 * Group commands are exempt: they document the group and list their
 * subcommands, and Commander renders that already.
 */

import { describe, expect, it } from "vitest";
import type { Command } from "commander";
import { createProgram } from "../../src/program.js";

interface Leaf {
  path: string;
  help: string;
}

/**
 * The help a user actually sees.
 *
 * NOT `helpInformation()`: that renders the usage, description, arguments and
 * options, and stops. Everything added through `addHelpText("after")` — which
 * is where Returns, Exit codes and Examples live — is appended by `outputHelp`
 * on its way to the stream. Reading the wrong one here made this test assert
 * against a string that could never contain the sections it was looking for.
 */
function renderHelp(cmd: Command): string {
  let captured = "";
  cmd.configureOutput({
    writeOut: (str) => {
      captured += str;
    },
  });
  cmd.outputHelp();
  return captured;
}

/** Every command that does work, with the help text a user would see. */
function leafCommands(cmd: Command, path: string[] = []): Leaf[] {
  const here = cmd.parent === null ? [] : [...path, cmd.name()];
  const children = cmd.commands.filter((c) => c.name() !== "help");
  if (children.length > 0) {
    return children.flatMap((c) => leafCommands(c, here));
  }
  return [{ path: here.join(" "), help: renderHelp(cmd) }];
}

const leaves = leafCommands(createProgram());

describe("every leaf command's --help", () => {
  it("finds the whole command tree", () => {
    // A guard on the guard: if this collapses, every assertion below passes
    // vacuously.
    expect(leaves.length).toBeGreaterThan(190);
  });

  for (const section of ["Returns", "Exit codes", "Examples"]) {
    it(`has a ${section} section`, () => {
      const missing = leaves.filter((l) => !l.help.includes(`${section}:`)).map((l) => l.path);

      expect(
        missing,
        `These commands have no "${section}:" section. Add one with describeCommand() from src/lib/help.ts:\n  ${missing.join("\n  ")}`,
      ).toEqual([]);
    });
  }

  it("names the values of every status field it returns", () => {
    // A `returns` line that names a status field without its set is the failure
    // mode this catches: an agent reading `"processing_status": "pending"` with
    // no set to compare it against cannot tell whether to poll or to give up.
    const offenders: string[] = [];
    for (const leaf of leaves) {
      const returns = leaf.help.split("Returns:")[1]?.split(/\n[A-Z][a-z]/)[0] ?? "";
      const mentionsStatus = /\b(status|processing_status|verdict|band|tier)\b/.test(returns);
      if (!mentionsStatus) continue;
      // Either the values are listed inline, or the line points at the command
      // that lists them.
      const listsValues = /\|| one of|:\s*\w+\s*,\s*\w+|senso /.test(returns);
      if (!listsValues) offenders.push(leaf.path);
    }

    expect(
      offenders,
      `These commands name a status field in Returns without saying what its values are:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });
});
