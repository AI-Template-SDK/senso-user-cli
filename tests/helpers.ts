/**
 * Driving the CLI in-process, and seeing what it printed.
 *
 * Command tests assert on three things: what reached stdout (the payload), what
 * reached stderr (diagnostics), and the exit code. `runCli` captures all three.
 *
 * It can work in-process at all because commands throw instead of calling
 * `process.exit` — the wrapper in src/lib/run-action.ts catches, reports, and
 * sets `process.exitCode`. Before that refactor a single failing command would
 * have taken the test runner down with it.
 */

import { vi, type MockInstance } from "vitest";
import type { Command } from "commander";
import { createProgram } from "../src/program.js";
import { ExitSignal } from "../src/lib/errors.js";
import { reportError, requestedFormat } from "../src/lib/run-action.js";
import { TEST_API_KEY, TEST_BASE_URL } from "./setup.js";

export interface CliResult {
  /** Everything written to stdout, joined with newlines. The payload. */
  stdout: string;
  /** Everything written to stderr. Diagnostics, progress, errors. */
  stderr: string;
  /**
   * The exit code the process would have used.
   *
   * `undefined` from `process.exitCode` means success, so it is normalized to 0
   * here — a test asserting `exitCode: 0` should not have to know that.
   */
  exitCode: number;
  /** stdout parsed as JSON. The whole envelope, including ok/command/page. */
  json: <T = unknown>() => T;
  /**
   * The payload: the envelope's `data`, with the envelope shape asserted.
   *
   * This is what almost every assertion means. Reading `json().data` by hand
   * would let a command that had been left emitting a bare payload pass
   * silently, which is the regression the envelope exists to prevent.
   */
  data: <T = unknown>() => T;
}

export interface RunOptions {
  /** Prepend `--api-key`. Defaults to true; pass false to test the unauthenticated path. */
  withKey?: boolean;
  /** Prepend `--base-url`. Defaults to the unreachable test host. */
  baseUrl?: string | false;
}

/**
 * Run one command and capture its output.
 *
 * Pass the arguments as a user would type them, without the `senso`:
 *
 *     const res = await runCli(["roles", "list", "--output", "json"]);
 */
export async function runCli(args: string[], opts: RunOptions = {}): Promise<CliResult> {
  const { withKey = true, baseUrl = TEST_BASE_URL } = opts;

  const stdout: string[] = [];
  const stderr: string[] = [];

  // console.log/error are what lib/output.ts and utils/logger.ts use, and
  // writeStdout is the streaming path. All three are captured so a test can tell
  // which stream a line landed on — which is the point of most of these tests.
  const spies: MockInstance[] = [
    vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
      stdout.push(parts.map(String).join(" "));
    }),
    vi.spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
      stderr.push(parts.map(String).join(" "));
    }),
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdout.push(String(chunk));
      return true;
    }),
  ];

  const argv = [
    ...(withKey ? ["--api-key", TEST_API_KEY] : []),
    ...(baseUrl === false ? [] : ["--base-url", baseUrl]),
    ...args,
  ];

  process.exitCode = undefined;

  const program = createProgram();
  captureCommanderOutput(program, stdout);

  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (err) {
    // Commander's exitOverride throws this for --help and --version, which have
    // already printed by then.
    if (err instanceof ExitSignal) {
      process.exitCode = err.exitCode;
    } else {
      // Everything else mirrors src/cli.ts exactly: a failure raised before any
      // action ran — an unknown option, a group with no subcommand — is
      // reported in the requested format and sets the exit code. Re-throwing
      // here instead, as this used to, meant the tests could never see what a
      // user sees for the whole class of usage errors.
      const cliError = reportError(err, {
        format: requestedFormat(program, argv),
        debug: false,
      });
      process.exitCode = cliError.exitCode;
    }
  } finally {
    for (const spy of spies) spy.mockRestore();
  }

  const code = typeof process.exitCode === "number" ? process.exitCode : 0;
  process.exitCode = undefined;

  const out = stdout.join("\n");
  const result: CliResult = {
    stdout: out,
    stderr: stderr.join("\n"),
    exitCode: code,
    json: <T>(): T => {
      try {
        return JSON.parse(out) as T;
      } catch {
        throw new Error(`stdout was not valid JSON:\n${out || "(empty)"}`);
      }
    },
    data: <T>(): T => envelope<T>(result).data,
  };
  return result;
}

/**
 * Routes Commander's help output into the captured stdout.
 *
 * Only `writeOut`. Commander's stderr is claimed by lib/commander-error.ts,
 * which captures it so a usage failure can be re-reported through the error
 * contract in the caller's chosen format — the suggestion line is lifted out of
 * it for the hint, and nothing else is printed. Overriding `writeErr` here too
 * would take that buffer away and let Commander's raw "error: unknown option"
 * line reach the test's stderr, which is not what a user sees.
 *
 * The configuration has to be applied to each command in the tree. Subcommands
 * copy it at creation time, and by the time `createProgram()` returns they
 * already exist with the default.
 */
function captureCommanderOutput(command: Command, stdout: string[]): void {
  command.configureOutput({
    writeOut: (str) => stdout.push(str.replace(/\n$/, "")),
  });
  for (const sub of command.commands) {
    captureCommanderOutput(sub, stdout);
  }
}

/** An absolute URL on the test host, for registering an MSW handler. */
export function apiUrl(path: string): string {
  return `${TEST_BASE_URL}${path}`;
}

/** The success envelope every command writes under `--output json`. */
export interface SuccessEnvelope<T> {
  ok: true;
  command: string;
  data: T;
  page?: {
    offset?: number;
    limit?: number;
    returned: number;
    total?: number;
    has_more?: boolean;
    next?: string;
  };
  next?: { why: string; command: string }[];
  warnings?: string[];
}

/** The failure envelope, which is written to stderr with stdout left empty. */
export interface ErrorEnvelope {
  ok: false;
  command: string;
  error: {
    code: string;
    message: string;
    status?: number;
    field?: string;
    received?: string;
    allowed?: string[];
    hint?: string;
    details?: unknown;
    request?: { method: string; path: string };
  };
}

/**
 * The parsed success envelope, with the shape asserted.
 *
 * Use this rather than `res.json()` in a JSON test: it fails loudly when a
 * command has been left emitting a bare payload, which is the regression the
 * envelope exists to prevent.
 */
export function envelope<T = unknown>(res: CliResult): SuccessEnvelope<T> {
  // Parsed as an open record so the checks below are real checks: typing it as
  // the envelope up front would make `ok !== true` provably false and the
  // assertion would compile away.
  const parsed = res.json<Record<string, unknown>>();
  if (parsed.ok !== true || typeof parsed.command !== "string" || !("data" in parsed)) {
    throw new Error(`stdout was not a success envelope:\n${res.stdout || "(empty)"}`);
  }
  return parsed as unknown as SuccessEnvelope<T>;
}

/**
 * The parsed failure envelope from stderr.
 *
 * stderr also carries the banner in non-JSON runs, so the JSON object is
 * located rather than assumed to be the whole stream.
 */
export function errorEnvelope(res: CliResult): ErrorEnvelope {
  const start = res.stderr.indexOf("{");
  const text = start === -1 ? "" : res.stderr.slice(start);
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (parsed.ok !== false || typeof parsed.error !== "object") {
      throw new Error("not an error envelope");
    }
    return parsed as unknown as ErrorEnvelope;
  } catch {
    throw new Error(`stderr was not an error envelope:\n${res.stderr || "(empty)"}`);
  }
}
