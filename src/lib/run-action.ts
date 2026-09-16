/**
 * The single path every command action takes.
 *
 * Before this, each of ~200 actions repeated the same eight lines: read the
 * global options, try, catch, format the error, `process.exit(1)`. That had
 * three consequences worth naming, because they are what this file fixes:
 *
 *   1. Every failure exited 1, so a caller could not tell a bad flag from an
 *      expired key from a network outage.
 *   2. `process.exit()` inside an action makes the action untestable in-process
 *      — the test runner dies with it — which is a large part of why this
 *      repository had no tests.
 *   3. Twenty-seven of thirty command files never read `--output` at all, so
 *      the flag was advertised globally and honored in three files.
 *
 * Commands now throw and return. This wrapper resolves the context once, runs
 * the handler, and turns anything thrown into a reported error and an exit code.
 *
 * It also captures the Command instance Commander passes as the last argument,
 * which is what lets the output layer name the command in its envelope and
 * rebuild an accurate next-page command from the flags the caller actually
 * typed.
 */

import { Command } from "commander";
import { commandPath } from "./command-line.js";
import { CliError, EXIT, toCliError } from "./errors.js";
import type { OutputFormat } from "./output.js";
import * as log from "../utils/logger.js";

/**
 * The resolved global options, handed to every action.
 *
 * `apiKey` and `baseUrl` keep those exact names so they can be spread into
 * `apiRequest` the way the old `opts` object was.
 */
export interface Ctx {
  apiKey?: string;
  baseUrl?: string;
  format: OutputFormat;
  quiet: boolean;
  /** SENSO_DEBUG=1. Request logging to stderr, with the key redacted. */
  debug: boolean;
  /** "kb my-files" — echoed in every JSON envelope. */
  command?: string;
  /** The Commander instance for this invocation, for rebuilding command lines. */
  commandRef?: Command;
}

const FORMATS = new Set<OutputFormat>(["json", "table", "plain"]);

/**
 * The format to report a failure in when no context was ever resolved.
 *
 * Commander's own failures — an unknown option, a group with no subcommand —
 * happen before any action runs, and they are exactly the failures an agent is
 * most likely to hit. Reporting them in plain text while the caller asked for
 * JSON is what made "errors are JSON too" untrue.
 *
 * Commander has usually finished parsing the global options by then, so its own
 * record is the first source. When it has not, the argv scan is the fallback,
 * and it handles both `--output json` and `--output=json`.
 */
export function requestedFormat(program: Command, argv: readonly string[]): OutputFormat {
  const parsed = program.opts<{ output?: string }>().output;
  if (parsed !== undefined && FORMATS.has(parsed as OutputFormat)) return parsed as OutputFormat;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? "";
    if (token.startsWith("--output=")) {
      const value = token.slice("--output=".length);
      if (FORMATS.has(value as OutputFormat)) return value as OutputFormat;
    }
    if (token === "--output") {
      const value = argv[i + 1] ?? "";
      if (FORMATS.has(value as OutputFormat)) return value as OutputFormat;
    }
  }
  return "plain";
}

/**
 * Reads the global options off the root command.
 *
 * Commander already parsed them, including the `--output=json` form that the
 * hand-rolled argv scan this replaces used to miss.
 */
export function resolveContext(program: Command, commandRef?: Command): Ctx {
  const opts = program.opts<{
    apiKey?: string;
    baseUrl?: string;
    output?: string;
    quiet?: boolean;
  }>();

  const requested = opts.output ?? "plain";
  if (!FORMATS.has(requested as OutputFormat)) {
    throw new CliError(`Unknown --output format: ${requested}`, EXIT.USAGE, {
      code: "usage",
      field: "--output",
      received: requested,
      allowed: ["json", "table", "plain"],
      hint: "Valid formats are: json, table, plain.",
    });
  }
  const format = requested as OutputFormat;

  return {
    apiKey: opts.apiKey,
    baseUrl: opts.baseUrl,
    format,
    // JSON output implies quiet. A caller that asked for a machine-readable
    // payload did not also ask for progress commentary next to it — and since
    // the envelope now carries `next`, `page` and `warnings`, nothing is lost
    // by silencing stderr the way it used to be.
    quiet: Boolean(opts.quiet) || format === "json",
    debug: process.env.SENSO_DEBUG === "1",
    command: commandRef ? commandPath(commandRef) : undefined,
    commandRef,
  };
}

/**
 * Reports a failure on stderr, in the format the caller asked for.
 *
 * Always stderr, including in JSON mode. stdout stays empty on failure so that
 * `cmd --output json > out.json` leaves an empty file rather than a file
 * containing an error object that a later read would mistake for data.
 *
 * The JSON shape mirrors the success envelope — `ok`, `command`, then the
 * payload — so a caller can branch on one field regardless of outcome.
 */
export function reportError(
  err: unknown,
  ctx: Pick<Ctx, "format" | "debug"> & { command?: string },
): CliError {
  const cliError = toCliError(err);
  const command = cliError.command ?? ctx.command ?? "";

  if (ctx.format === "json") {
    // Written with console.error via the logger's raw channel so it lands on
    // stderr; outputJson would put it on stdout.
    log.raw(
      JSON.stringify(
        {
          ok: false,
          command,
          error: {
            code: cliError.code,
            message: cliError.message,
            ...(cliError.status === undefined ? {} : { status: cliError.status }),
            ...(cliError.field === undefined ? {} : { field: cliError.field }),
            ...(cliError.received === undefined ? {} : { received: cliError.received }),
            ...(cliError.allowed === undefined ? {} : { allowed: cliError.allowed }),
            ...(cliError.hint === undefined ? {} : { hint: cliError.hint }),
            ...(cliError.details === undefined ? {} : { details: cliError.details }),
            ...(cliError.request === undefined ? {} : { request: cliError.request }),
          },
        },
        null,
        2,
      ),
    );
  } else {
    log.error(cliError.message);
    // The hint usually names the accepted set in a sentence; printing the raw
    // list as well says the same thing twice. `error.allowed` in the JSON is
    // where a program reads it.
    if (cliError.hint) {
      log.hint(cliError.hint);
    } else if (cliError.allowed && cliError.allowed.length > 0) {
      log.hint(`Allowed values: ${cliError.allowed.join(", ")}`);
    }
  }

  // The underlying error only when asked for. A stack trace is noise to a user
  // and the first thing a maintainer wants.
  if (ctx.debug && cliError.cause instanceof Error) {
    log.raw(cliError.cause.stack ?? cliError.cause.message);
  }

  return cliError;
}

/**
 * Wraps a command action.
 *
 * Commander calls the returned function with the declared arguments, then the
 * command's own options, then the Command instance. Those are forwarded to the
 * handler unchanged after the context, so a handler reads
 * `(ctx, id, cmdOpts)` where it used to read `(id, cmdOpts)`.
 *
 * On failure it sets `process.exitCode` rather than calling `process.exit()`:
 * exiting outright truncates buffered stdout when it is a pipe, and it makes
 * the action impossible to test in-process. Node exits with that code once the
 * event loop drains, which is the same observable result without either
 * problem.
 */
export function runAction<Args extends unknown[]>(
  program: Command,
  handler: (ctx: Ctx, ...args: Args) => Promise<void> | void,
): (...args: Args) => Promise<void> {
  return async (...args: Args): Promise<void> => {
    // Commander appends the Command instance to every action call. Reading it
    // here — rather than asking 200 handlers to declare it — is what gives the
    // envelope its `command` field and the paging hint its real flags.
    const last = args.length > 0 ? args[args.length - 1] : undefined;
    const commandRef = last instanceof Command ? last : undefined;

    // Resolved inside the try: an invalid --output is itself a usage error and
    // should be reported through the same path as everything else.
    let ctx: Ctx | undefined;
    try {
      ctx = resolveContext(program, commandRef);
      await handler(ctx, ...args);
    } catch (err) {
      const reporting = ctx ?? {
        format: "plain" as const,
        debug: process.env.SENSO_DEBUG === "1",
        command: commandRef ? commandPath(commandRef) : undefined,
      };
      const cliError = reportError(err, reporting);
      process.exitCode = cliError.exitCode;
    }
  };
}
