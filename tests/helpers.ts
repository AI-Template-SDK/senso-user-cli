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
  /** stdout parsed as JSON. Throws with the raw text if it will not parse. */
  json: <T = unknown>() => T;
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
  captureCommanderOutput(program, stdout, stderr);

  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (err) {
    // Commander's exitOverride throws this for --help and --version, which have
    // already printed by then. Anything else is a genuine failure to surface.
    if (err instanceof ExitSignal) {
      process.exitCode = err.exitCode;
    } else {
      throw err;
    }
  } finally {
    for (const spy of spies) spy.mockRestore();
  }

  const code = typeof process.exitCode === "number" ? process.exitCode : 0;
  process.exitCode = undefined;

  const out = stdout.join("\n");
  return {
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
  };
}

/**
 * Routes Commander's own writes into the captured streams.
 *
 * Commander does not use `console.*` for its usage errors and help text — it
 * writes to `process.stderr` through its output configuration, which the spies
 * above do not see. Two consequences, both fixed here: those lines leaked into
 * the test runner's output as unattributed "error: required option ..." noise,
 * and a test could not assert on them, so every missing-flag case could only
 * check the exit code.
 *
 * The configuration has to be applied to each command in the tree. Subcommands
 * copy it at creation time, and by the time `createProgram()` returns they
 * already exist with the default.
 */
function captureCommanderOutput(command: Command, stdout: string[], stderr: string[]): void {
  command.configureOutput({
    writeOut: (str) => stdout.push(str.replace(/\n$/, "")),
    writeErr: (str) => stderr.push(str.replace(/\n$/, "")),
  });
  for (const sub of command.commands) {
    captureCommanderOutput(sub, stdout, stderr);
  }
}

/** An absolute URL on the test host, for registering an MSW handler. */
export function apiUrl(path: string): string {
  return `${TEST_BASE_URL}${path}`;
}
