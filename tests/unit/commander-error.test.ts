/**
 * Unit: Commander's own failures, translated into the error contract.
 *
 * WHAT IS WORTH PROTECTING HERE. Everything a command throws already becomes a
 * structured error with an exit code and, under `--output json`, a JSON object
 * on stderr. Commander's failures did not: an unknown option, a missing
 * argument, a misspelled command and a group invoked with no subcommand each
 * printed a line of English and exited, whatever `--output` said. That is the
 * entire class of mistake an agent is most likely to make, and the README
 * promised those errors were JSON too.
 *
 * `senso credits` is the case that mattered in practice: three published Senso
 * skills instruct it verbatim, and it dumped a screen of help text and exited 2
 * with nothing machine-readable in it.
 */

import { Command } from "commander";
import { describe, expect, it } from "vitest";
import {
  captureCommanderStderr,
  commanderToCliError,
  installExitOverride,
} from "../../src/lib/commander-error.js";
import { CliError, EXIT, ExitSignal } from "../../src/lib/errors.js";

/** A miniature program with the same wiring `createProgram()` installs. */
function program(): Command {
  const root = new Command("senso");
  captureCommanderStderr(root);
  const kb = root.command("kb").description("knowledge base");
  kb.command("get <id>")
    .option("--rev <n>", "a stored version")
    .action(() => undefined);
  kb.command("my-files").action(() => undefined);
  root.command("search <query>").action(() => undefined);
  installExitOverride(root);
  return root;
}

/** Runs argv and returns whatever the override threw. */
function failure(args: string[]): CliError | ExitSignal {
  try {
    program().parse(args, { from: "user" });
  } catch (err) {
    return err as CliError | ExitSignal;
  }
  throw new Error(`expected \`senso ${args.join(" ")}\` to fail`);
}

describe("a group invoked with no subcommand", () => {
  it("answers in one line with the list of subcommands, not a help dump", () => {
    const err = failure(["kb"]) as CliError;

    expect(err.exitCode).toBe(EXIT.USAGE);
    expect(err.code).toBe("usage");
    expect(err.message).toBe("`senso kb` needs a subcommand.");
    expect(err.allowed).toEqual(["get", "my-files"]);
    expect(err.command).toBe("kb");
  });

  it("names the root the same way when nothing at all was typed", () => {
    const err = failure([]) as CliError;

    expect(err.message).toBe("`senso` needs a subcommand.");
    expect(err.allowed).toContain("kb");
  });
});

describe("a mistyped command or flag", () => {
  it("carries Commander's suggestion as the hint", () => {
    const err = failure(["serach", "x"]) as CliError;

    expect(err.exitCode).toBe(EXIT.USAGE);
    expect(err.hint).toBe("Did you mean search?");
    expect(err.field).toBe("<command>");
  });

  it("lists the options the failing command actually has", () => {
    // The override is installed per command, not only on the root, which is the
    // only way the handler can know whose options to list.
    const err = failure(["kb", "get", "abc", "--nope"]) as CliError;

    expect(err.message).toContain("--nope");
    expect(err.allowed).toEqual(["--rev", "--help"]);
    expect(err.command).toBe("kb get");
  });

  it("points at the right help for a missing argument", () => {
    const err = failure(["search"]) as CliError;

    expect(err.exitCode).toBe(EXIT.USAGE);
    expect(err.hint).toContain("senso search --help");
  });
});

describe("--help and --version", () => {
  it("are not failures", () => {
    // Both have already written to stdout by the time the override runs, so
    // reporting here would append a spurious error to a successful run.
    const thrown = failure(["--help"]);
    expect(thrown).toBeInstanceOf(ExitSignal);
    expect(thrown.exitCode).toBe(EXIT.OK);
  });
});

describe("commanderToCliError", () => {
  it("falls back to a usage error for a code it does not recognize", () => {
    const root = program();
    const odd = Object.assign(new Error("error: something odd"), {
      code: "commander.somethingNew",
      exitCode: 1,
      name: "CommanderError",
    });
    const err = commanderToCliError(odd, root) as CliError;

    expect(err.exitCode).toBe(EXIT.USAGE);
    expect(err.message).toBe("something odd");
  });
});
