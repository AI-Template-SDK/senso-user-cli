/**
 * Commander's own failures, translated into this CLI's error contract.
 *
 * Everything a command throws already becomes a structured error with an exit
 * code and, under `--output json`, a JSON object on stderr. Commander's
 * failures did not: an unknown option, a missing argument, a misspelled command
 * and a group invoked with no subcommand each printed a bare line of English to
 * stderr and exited, whatever `--output` said. So the README's promise that
 * "errors are JSON too" was false for the entire class of mistakes an agent is
 * most likely to make, and `senso credits` — which three of the published agent
 * skills instruct verbatim — dumped a screen of help text and exited 2 with
 * nothing machine-readable in it.
 *
 * Two things make the translation exact. The override is installed on every
 * command in the tree rather than only the root, so the handler knows which
 * command failed and can list ITS subcommands and ITS options. And Commander's
 * stderr is captured rather than written, so its own line is not printed
 * alongside ours — the "(Did you mean …)" suggestion is lifted out of it and
 * carried as the hint, which is the one genuinely useful part.
 */

import type { Command, CommanderError } from "commander";
import { CliError, EXIT, ExitSignal, usageError } from "./errors.js";

/** Commander's stderr for the current invocation, captured not printed. */
let captured = "";

/** Reads and clears the buffer. */
function takeCaptured(): string {
  const text = captured;
  captured = "";
  return text;
}

/**
 * Routes Commander's stderr into a buffer.
 *
 * Applied to the root before any subcommand is registered, because Commander
 * copies the output configuration into each subcommand as it is created.
 * `writeOut` is deliberately left alone: `--help` and `--version` are successful
 * output and belong on stdout.
 */
export function captureCommanderStderr(program: Command): void {
  program.configureOutput({
    writeErr: (str) => {
      captured += str;
    },
  });
}

/** The "(Did you mean search?)" line Commander writes under an unknown name. */
function suggestion(text: string): string | undefined {
  const match = /\(Did you mean ([^)]+)\?\)/.exec(text);
  return match ? `Did you mean ${match[1]}?` : undefined;
}

/** "error: unknown option '--nope'" → "unknown option '--nope'". */
function tidy(message: string): string {
  return message.replace(/^error:\s*/i, "").trim();
}

/** The full path of a command, for a hint that can be run as written. */
function commandName(cmd: Command): string {
  const parts: string[] = [];
  let node: Command = cmd;
  while (node.parent !== null) {
    parts.unshift(node.name());
    node = node.parent;
  }
  return parts.join(" ");
}

function pathOf(cmd: Command): string {
  const parts: string[] = [];
  let node: Command = cmd;
  while (node.parent !== null) {
    parts.unshift(node.name());
    node = node.parent;
  }
  return ["senso", ...parts].join(" ");
}

function subcommandNames(cmd: Command): string[] {
  return cmd.commands.filter((c) => c.name() !== "help").map((c) => c.name());
}

function optionNames(cmd: Command): string[] {
  // `--help` is real and accepted but Commander keeps it out of `options`, so
  // an agent reading `error.allowed` would conclude it does not exist.
  return [...cmd.options.map((o) => o.long ?? o.short ?? "").filter(Boolean), "--help"];
}

/**
 * Turns one CommanderError into either a silent exit or a usage error.
 *
 * `--help` and `--version` have already written what they mean to say and exit
 * 0; everything else is the caller mistyping something, which is exit 2 with
 * the accepted set named.
 */
export function commanderToCliError(err: CommanderError, cmd: Command): CliError | ExitSignal {
  const text = takeCaptured();

  // Help and version have printed to stdout already and are not failures.
  if (err.exitCode === 0) return new ExitSignal(EXIT.OK);

  const where = pathOf(cmd);
  const command = commandName(cmd);

  switch (err.code) {
    case "commander.help":
    case "commander.helpDisplayed": {
      // A group invoked with no subcommand. Commander's answer is to dump the
      // whole help to stderr; an agent needs one line and the list of names.
      const subs = subcommandNames(cmd);
      return usageError(`\`${where}\` needs a subcommand.`, {
        command,
        field: "<subcommand>",
        allowed: subs,
        hint: `One of: ${subs.join(", ")}. Run \`${where} --help\` for what each does.`,
      });
    }
    case "commander.unknownCommand":
      return usageError(tidy(err.message), {
        command,
        field: "<command>",
        allowed: subcommandNames(cmd),
        hint: suggestion(text) ?? `Run \`${where} --help\` for the commands available here.`,
      });
    case "commander.unknownOption":
      return usageError(tidy(err.message), {
        command,
        field: "<option>",
        allowed: optionNames(cmd),
        hint: suggestion(text) ?? `Run \`${where} --help\` for this command's options.`,
      });
    case "commander.missingArgument":
    case "commander.missingMandatoryOptionValue":
    case "commander.optionMissingArgument":
      return usageError(tidy(err.message), {
        command,
        hint: `Run \`${where} --help\` to see what this command requires.`,
      });
    case "commander.excessArguments":
      return usageError(tidy(err.message), {
        command,
        hint: `Run \`${where} --help\`. Quote an argument that contains spaces.`,
      });
    case "commander.invalidArgument":
      return usageError(tidy(err.message), {
        command,
        hint: `Run \`${where} --help\` for the accepted values.`,
      });
    default:
      return usageError(tidy(err.message) || "The command line could not be parsed.", {
        command,
        hint: `Run \`${where} --help\`.`,
      });
  }
}

/**
 * Installs the override on every command in the tree.
 *
 * On the root alone it would still fire — Commander inherits it — but the
 * handler would have no way to tell which command failed, so it could not list
 * the right subcommands or options. Binding per command is what makes
 * "`senso kb` needs a subcommand" possible.
 */
export function installExitOverride(cmd: Command): void {
  cmd.exitOverride((err) => {
    throw commanderToCliError(err, cmd);
  });
  for (const sub of cmd.commands) installExitOverride(sub);
}
