/**
 * Policy: every command the published agent skills name must exist.
 *
 * WHAT IS WORTH PROTECTING HERE. The seven skills in senso-contextos are not
 * documentation — they are instructions a model follows literally, and it has
 * no way to check them. When a skill names a command that does not exist, every
 * agent that reads it runs the same failing command and then invents a way
 * around it.
 *
 * That was not hypothetical. Four skills called `senso credits`, which is a
 * group and not a command, so the first call in their setup section exited 2.
 * Two more sent agents to `senso content get <content_id>` to read a knowledge
 * base document, which the API rejects by design.
 *
 * The list is vendored by `make skill-commands` rather than read from a sibling
 * checkout, so this test never depends on a clone that may not exist, and a
 * command leaving the skills is visible in a diff.
 *
 * Only EXISTENCE is checked. Whether a bare group is usable is a property of
 * the CLI, asserted in tests/unit/commander-error.test.ts, and the extractor
 * cannot tell an instruction from prose — "use the `senso kb` commands" is not
 * a command to run.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { describe, expect, it } from "vitest";
import { createProgram } from "../../src/program.js";

const FIXTURE = join(process.cwd(), "tests", "policy", "skill-commands.json");

const named = (JSON.parse(readFileSync(FIXTURE, "utf8")) as { commands: string[] }).commands;

/** Every addressable path in the tree, groups included. */
function allPaths(cmd: Command, path: string[] = []): string[] {
  const here = cmd.parent === null ? [] : [...path, cmd.name()];
  const children = cmd.commands.filter((c) => c.name() !== "help");
  const self = here.length > 0 ? [here.join(" ")] : [];
  return [...self, ...children.flatMap((c) => allPaths(c, here))];
}

const tree = new Set(allPaths(createProgram()));

describe("the commands the agent skills tell an agent to run", () => {
  it("found both the skills' list and the command tree", () => {
    // A guard on the guard: either one collapsing would make this pass while
    // checking nothing.
    expect(named.length).toBeGreaterThan(50);
    expect(tree.size).toBeGreaterThan(200);
  });

  it("all exist in the command tree", () => {
    const missing = named.filter((c) => !tree.has(c));

    expect(
      missing,
      "These commands are named in senso-contextos/skills but do not exist:\n  " +
        missing.join("\n  ") +
        "\n\nRename them in the skills, or restore the command. If the skills changed, refresh the list with `make skill-commands`.",
    ).toEqual([]);
  });
});
