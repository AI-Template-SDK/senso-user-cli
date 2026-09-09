/**
 * The single path every one of ~150 command actions takes.
 *
 * Two contracts live in this file and nowhere else, which is why a change here
 * changes the behavior of the whole CLI at once:
 *
 *   1. Global flags become a Ctx. `--output`, `--quiet`, `--api-key` and
 *      `--base-url` are advertised on the root command, so every subcommand has
 *      to honor them without knowing they exist. The derived rule — JSON output
 *      implies quiet — is the one worth stating out loud: a caller that asked
 *      for a machine-readable payload did not also ask for progress commentary.
 *   2. A thrown error becomes an exit code and a message on stderr. Not a
 *      `process.exit()` (which truncates a piped stdout and takes the test
 *      runner down with it), and never anything on stdout — `cmd --output json
 *      > out.json` must leave an empty file on failure rather than a file
 *      holding an error object a later read would mistake for data.
 *
 * These use a throwaway Commander program rather than the real one so the
 * assertions are about this wrapper and not about whichever command happened to
 * be convenient.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { runAction, resolveContext, type Ctx } from "../../src/lib/run-action.js";
import { CliError, EXIT } from "../../src/lib/errors.js";

let stdout: string[];
let stderr: string[];

/**
 * A root command carrying the same global options the real program declares,
 * already parsed with `globals`.
 */
function programWith(globals: string[] = []): Command {
  const program = new Command();
  program
    .option("--api-key <key>", "Override API key")
    .option("--base-url <url>", "Override API base URL")
    .option("--output <format>", "Output format: json | table | plain", "plain")
    .option("--quiet", "Suppress non-essential output")
    .exitOverride();
  program.command("noop").action(() => undefined);
  program.parse([...globals, "noop"], { from: "user" });
  return program;
}

beforeEach(() => {
  stdout = [];
  stderr = [];
  vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
    stdout.push(parts.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
    stderr.push(parts.map(String).join(" "));
  });
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  // runAction sets this rather than exiting, so it would otherwise persist and
  // mark every later test's process as failed. tests/setup.ts also clears it.
  process.exitCode = undefined;
});

describe("resolving the global options into a context", () => {
  it("carries the credential and the base URL through under the names apiRequest wants", () => {
    // These two keep their exact names so a command can spread the ctx into
    // apiRequest the way the old hand-rolled options object was.
    const ctx = resolveContext(
      programWith(["--api-key", "tgr_from_flag", "--base-url", "https://from-flag.test"]),
    );

    expect(ctx.apiKey).toBe("tgr_from_flag");
    expect(ctx.baseUrl).toBe("https://from-flag.test");
  });

  it("leaves the credential undefined when no flag was passed, so config can resolve it", () => {
    const ctx = resolveContext(programWith([]));

    expect(ctx.apiKey).toBeUndefined();
    expect(ctx.baseUrl).toBeUndefined();
  });

  it("defaults to the plain format", () => {
    expect(resolveContext(programWith([])).format).toBe("plain");
  });

  it("accepts each of the three formats the help text advertises", () => {
    expect(resolveContext(programWith(["--output", "json"])).format).toBe("json");
    expect(resolveContext(programWith(["--output", "table"])).format).toBe("table");
    expect(resolveContext(programWith(["--output", "plain"])).format).toBe("plain");
  });

  it("reads the --output=json form as well as the spaced one", () => {
    // The hand-rolled argv scan this replaced missed the equals form, so
    // `--output=json` silently printed a human-readable table.
    expect(resolveContext(programWith(["--output=json"])).format).toBe("json");
  });

  it("passes --quiet through", () => {
    expect(resolveContext(programWith(["--quiet"])).quiet).toBe(true);
    expect(resolveContext(programWith([])).quiet).toBe(false);
  });

  it("forces quiet on for JSON output even without --quiet", () => {
    // The derived rule. A caller that asked for a machine-readable payload did
    // not also ask for progress commentary next to it.
    const ctx = resolveContext(programWith(["--output", "json"]));

    expect(ctx.format).toBe("json");
    expect(ctx.quiet).toBe(true);
  });

  it("does not force quiet on for the other formats", () => {
    expect(resolveContext(programWith(["--output", "table"])).quiet).toBe(false);
  });

  it("sets debug from SENSO_DEBUG=1", () => {
    process.env.SENSO_DEBUG = "1";
    expect(resolveContext(programWith([])).debug).toBe(true);
  });

  it("treats any other SENSO_DEBUG value as off", () => {
    // Only "1". "0" and "false" both read as "on" under a truthiness check,
    // which is the opposite of what someone typing them means.
    process.env.SENSO_DEBUG = "0";
    expect(resolveContext(programWith([])).debug).toBe(false);

    process.env.SENSO_DEBUG = "true";
    expect(resolveContext(programWith([])).debug).toBe(false);

    delete process.env.SENSO_DEBUG;
    expect(resolveContext(programWith([])).debug).toBe(false);
  });
});

describe("an unknown --output value", () => {
  const rejected = (value: string): CliError => {
    try {
      resolveContext(programWith(["--output", value]));
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      return err as CliError;
    }
    throw new Error(`expected --output ${value} to be rejected`);
  };

  it("is a usage error, not a failed request", () => {
    // Exit 2 and nothing sent. Formatting is decided before any API call, so
    // the wrong value can be caught for free.
    const err = rejected("yaml");

    expect(err.exitCode).toBe(EXIT.USAGE);
    expect(err.code).toBe("usage");
  });

  it("names the value it did not understand and the ones it does", () => {
    const err = rejected("yaml");

    expect(err.message).toContain("yaml");
    expect(err.hint).toContain("json");
    expect(err.hint).toContain("table");
    expect(err.hint).toContain("plain");
  });

  it("is case-sensitive, rather than quietly accepting JSON", () => {
    // Documenting current behavior: `--output JSON` is rejected. The message
    // names the value, so the fix is visible.
    expect(rejected("JSON").exitCode).toBe(EXIT.USAGE);
  });
});

describe("running a handler that succeeds", () => {
  it("leaves the exit code unset", async () => {
    const program = programWith([]);
    await runAction(program, () => undefined)();

    // `undefined` is how Node says success; run-action must not set 0
    // explicitly, and must certainly not set anything else.
    expect(process.exitCode).toBeUndefined();
  });

  it("awaits an asynchronous handler before returning", async () => {
    const program = programWith([]);
    let finished = false;

    await runAction(program, async () => {
      await Promise.resolve();
      finished = true;
    })();

    expect(finished).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });

  it("writes nothing itself — printing is the handler's job", async () => {
    const program = programWith([]);
    await runAction(program, () => undefined)();

    expect(stdout.join("\n")).toBe("");
    expect(stderr.join("\n")).toBe("");
  });
});

describe("what the handler is given", () => {
  it("receives the context first, then whatever Commander passed", async () => {
    // Commander calls the action with the declared arguments, then the
    // command's own options, then the Command itself. Everything is forwarded
    // unchanged after the ctx, so a handler reads (ctx, id, cmdOpts).
    const program = new Command();
    program
      .option("--output <format>", "Output format", "plain")
      .option("--quiet", "Suppress non-essential output")
      .exitOverride();

    let seenCtx: Ctx | undefined;
    let seenName: string | undefined;
    let seenOpts: { loud?: boolean } | undefined;

    program
      .command("greet <name>")
      .option("--loud", "Shout it")
      .action(
        runAction(program, (ctx: Ctx, name: string, cmdOpts: { loud?: boolean }) => {
          seenCtx = ctx;
          seenName = name;
          seenOpts = cmdOpts;
        }),
      );

    await program.parseAsync(["--output", "json", "greet", "world", "--loud"], { from: "user" });

    expect(seenCtx?.format).toBe("json");
    expect(seenCtx?.quiet).toBe(true);
    expect(seenName).toBe("world");
    expect(seenOpts).toMatchObject({ loud: true });
    expect(process.exitCode).toBeUndefined();
  });
});

describe("running a handler that throws", () => {
  const failWith = async (err: unknown, globals: string[] = []): Promise<void> => {
    const program = programWith(globals);
    await runAction(program, () => {
      throw err;
    })();
  };

  it("sets the exit code the error carries, rather than a blanket 1", async () => {
    // The whole reason this wrapper exists: a caller has to be able to tell a
    // bad flag from an expired key from a network outage.
    await failWith(new CliError("no key", EXIT.AUTH));
    expect(process.exitCode).toBe(EXIT.AUTH);

    await failWith(new CliError("bad flag", EXIT.USAGE));
    expect(process.exitCode).toBe(EXIT.USAGE);

    await failWith(new CliError("gone", EXIT.NOT_FOUND));
    expect(process.exitCode).toBe(EXIT.NOT_FOUND);
  });

  it("reports the message on stderr and leaves stdout empty", async () => {
    await failWith(new CliError("the org was not found", EXIT.NOT_FOUND));

    expect(stderr.join("\n")).toContain("the org was not found");
    expect(stdout.join("\n")).toBe("");
  });

  it("prints the hint under the message, where the reader is looking", async () => {
    await failWith(new CliError("no key", EXIT.AUTH, { hint: "Run senso login." }));

    expect(stderr.join("\n")).toContain("no key");
    expect(stderr.join("\n")).toContain("Run senso login.");
  });

  it("maps a thrown value that is not a CliError onto the contract", async () => {
    await failWith(new Error("something unexpected"));

    expect(process.exitCode).toBe(EXIT.ERROR);
    expect(stderr.join("\n")).toContain("something unexpected");
  });

  it("does not rethrow, so the process can flush and exit normally", async () => {
    // Commander awaits the action; a rejection here would surface as an
    // unhandled rejection instead of an exit code.
    await expect(failWith(new CliError("nope"))).resolves.toBeUndefined();
  });

  it("keeps the stack trace out of the output unless SENSO_DEBUG is set", async () => {
    const cause = new Error("socket hang up");

    await failWith(new CliError("network", EXIT.NETWORK, { cause }));
    expect(stderr.join("\n")).not.toContain("socket hang up");

    process.env.SENSO_DEBUG = "1";
    stderr.length = 0;
    await failWith(new CliError("network", EXIT.NETWORK, { cause }));
    expect(stderr.join("\n")).toContain("socket hang up");
    delete process.env.SENSO_DEBUG;
  });
});

describe("reporting a failure in JSON mode", () => {
  const failAsJson = async (err: unknown): Promise<Record<string, any>> => {
    const program = programWith(["--output", "json"]);
    await runAction(program, () => {
      throw err;
    })();
    return JSON.parse(stderr.join("\n")) as Record<string, any>;
  };

  it("emits a parseable error object, on stderr", async () => {
    const payload = await failAsJson(
      new CliError("the org was not found", EXIT.NOT_FOUND, { hint: "Try senso org list." }),
    );

    expect(payload.error).toMatchObject({
      code: "not_found",
      message: "the org was not found",
      hint: "Try senso org list.",
    });
    expect(process.exitCode).toBe(EXIT.NOT_FOUND);
  });

  it("still leaves stdout completely empty", async () => {
    // `cmd --output json > out.json` must leave an empty file on failure, not
    // a file holding an error object that a later read mistakes for data.
    await failAsJson(new CliError("boom", EXIT.ERROR));

    expect(stdout.join("\n")).toBe("");
  });

  it("omits status and hint when the error has none, rather than emitting nulls", async () => {
    const payload = await failAsJson(new CliError("boom"));

    expect(payload.error).toEqual({ code: "error", message: "boom" });
  });

  it("includes the HTTP status when the failure came from the API", async () => {
    const err = new CliError("rejected", EXIT.AUTH, { status: 401 });
    const payload = await failAsJson(err);

    expect(payload.error.status).toBe(401);
  });
});

describe("a usage error in the global options themselves", () => {
  it("is reported through the same path as everything else", async () => {
    // resolveContext runs inside the try, so an invalid --output reaches the
    // reporter rather than escaping as an unhandled rejection — and it is
    // reported in plain text, because the requested format is the broken part.
    const program = programWith(["--output", "yaml"]);
    let handlerRan = false;

    await runAction(program, () => {
      handlerRan = true;
    })();

    expect(handlerRan).toBe(false);
    expect(process.exitCode).toBe(EXIT.USAGE);
    expect(stderr.join("\n")).toContain("yaml");
    expect(stdout.join("\n")).toBe("");
  });
});
