/**
 * Command layer: `senso skills`.
 *
 * The only command group that delegates its work to another program. Nothing
 * here goes over HTTP, so what is worth protecting is the argv this command
 * hands to `shipables` and what it makes of the result:
 *
 *   - the argv itself. `--yes` is what keeps a non-interactive install from
 *     hanging on a prompt nobody can answer, and the agent flag is the whole
 *     point of the command. Both are asserted literally, because a silently
 *     renamed flag installs nothing and says it succeeded;
 *   - a partial failure. Skills are independent installs, so one failing must
 *     not abandon the rest — and the command must still exit non-zero. It used
 *     to exit 0 after every install failed, which made a CI step that installed
 *     skills structurally unable to notice;
 *   - a child that answers with something other than JSON. `skills list` parses
 *     the subprocess's stdout, and a stack trace out of JSON.parse is not a
 *     diagnosis;
 *   - `list-available`, which must answer from the built-in list without
 *     spawning anything at all.
 *
 * `execFile` is mocked because the alternative is a test that downloads and
 * installs packages. skills.ts promisifies it at module load, so the mock
 * carries the promisify custom symbol; without it `promisify` would resolve the
 * bare stdout string and the destructuring in skills.ts would throw.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_API_KEY } from "../setup.js";
import { runCli } from "../helpers.js";

/**
 * A temporary, never-created config directory, pinned before the imports above
 * are evaluated.
 *
 * lib/config.ts resolves SENSO_CONFIG_DIR once at module load, which happens
 * when this file imports the program — before the suite's `beforeEach` gets to
 * point it anywhere. Without this, the `--api-key`-less test below would read
 * the developer's own stored key and pass or fail depending on whose machine it
 * ran on. Nothing writes here, so the directory never has to exist.
 */
vi.hoisted(() => {
  const tmp = (process.env.TMPDIR ?? process.env.TEMP ?? "/tmp").replace(/[/\\]+$/, "");
  process.env.SENSO_CONFIG_DIR = `${tmp}/senso-skills-test-${process.pid}`;
});

/** One `shipables` invocation, as this command asked for it. */
interface ChildCall {
  file: string;
  args: string[];
}

const child = vi.hoisted(() => {
  // What util.promisify looks for. Node's real execFile defines it so the
  // promisified form resolves { stdout, stderr } rather than stdout alone.
  const PROMISIFIED = Symbol.for("nodejs.util.promisify.custom");

  const state = {
    calls: [] as ChildCall[],
    run: (_file: string, _args: string[]): { stdout: string; stderr: string } => ({
      stdout: "",
      stderr: "",
    }),
  };

  const execFile = Object.assign(
    () => {
      throw new Error("skills.ts uses only the promisified form of execFile");
    },
    {
      // Not an async function: a `run` that throws has to become a rejected
      // promise, which is what a failing child process looks like from here,
      // and the Promise constructor does that conversion.
      [PROMISIFIED]: (file: string, args: string[]) =>
        new Promise<{ stdout: string; stderr: string }>((resolve) => {
          state.calls.push({ file, args });
          resolve(state.run(file, args));
        }),
    },
  );

  return { state, execFile };
});

vi.mock("node:child_process", () => ({
  execFile: child.execFile,
  // commands/update.ts imports this at module load, and program.ts imports
  // every command. Nothing in this file calls it.
  execSync: vi.fn(),
}));

/** Decides what the fake `shipables` does for a given invocation. */
function shipablesRuns(impl: (file: string, args: string[]) => { stdout: string; stderr: string }) {
  child.state.run = impl;
}

/** Every invocation except the `shipables --version` availability probe. */
function invocations(): ChildCall[] {
  return child.state.calls.filter(({ args }) => args[0] !== "--version");
}

/** The argv of the nth real invocation. */
function argv(n = 0): string[] {
  return invocations()[n]?.args ?? [];
}

const SKILL_COUNT = 7;

beforeEach(() => {
  child.state.calls = [];
  // The default world: shipables is on PATH and every invocation succeeds
  // quietly. Tests that care about the other cases say so.
  shipablesRuns(() => ({ stdout: "", stderr: "" }));
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("skills list-available, which answers for itself", () => {
  it("spawns nothing at all", async () => {
    // The one subcommand that is pure local data. Shelling out to discover a
    // hard-coded list would make `--help`-adjacent discovery cost a subprocess.
    const res = await runCli(["skills", "list-available"]);

    expect(res.exitCode).toBe(0);
    expect(child.state.calls).toEqual([]);
  });

  it("lists every official skill by short name and package under --output json", async () => {
    const res = await runCli(["skills", "list-available", "--output", "json"]);

    const listed = res.json<{ package: string; shortName: string }[]>();
    expect(listed).toHaveLength(SKILL_COUNT);
    expect(listed).toContainEqual({ package: "senso-ai/senso-search", shortName: "search" });
    expect(res.stderr).toBe("");
  });

  it("renders the short names and the install hint in plain", async () => {
    const res = await runCli(["skills", "list-available"]);

    expect(res.stdout).toContain("search");
    expect(res.stdout).toContain("senso-ai/senso-onboarding");
    expect(res.stdout).toContain("senso skills install --all");
  });

  it("renders a row per skill under --output table", async () => {
    const res = await runCli(["skills", "list-available", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("shortName");
    expect(res.stdout).toContain("content-gen");
  });
});

describe("skills install, on the argv", () => {
  it("expands a short name and passes the agent flag and --yes", async () => {
    const res = await runCli(["skills", "install", "search", "--agent", "claude"]);

    expect(res.exitCode).toBe(0);
    expect(invocations()).toHaveLength(1);
    // Asserted whole. --yes is what stops the child prompting in CI, and the
    // agent flag is the entire meaning of --agent.
    expect(argv()).toEqual([
      "install",
      "senso-ai/senso-search",
      "--claude",
      "--env",
      `SENSO_API_KEY=${TEST_API_KEY}`,
      "--yes",
    ]);
  });

  it("installs every official skill when no name is given", async () => {
    const res = await runCli(["skills", "install"]);

    expect(res.exitCode).toBe(0);
    expect(invocations()).toHaveLength(SKILL_COUNT);
    expect(invocations().map(({ args }) => args[1])).toContain("senso-ai/senso-onboarding");
  });

  it("targets every agent with --all when none was named", async () => {
    await runCli(["skills", "install", "search"]);

    expect(argv()).toContain("--all");
  });

  it("passes a fully qualified package through untouched", async () => {
    await runCli(["skills", "install", "@someone/their-skill"]);

    expect(argv()[1]).toBe("@someone/their-skill");
  });

  it("forwards --global to the child", async () => {
    await runCli(["skills", "install", "search", "--global"]);

    expect(argv()).toContain("--global");
  });

  it("omits --env entirely when there is no key to pass", async () => {
    // The key travels in the child's argv, where `ps` can read it — a known
    // limitation recorded in SECURITY.md. The least this can do is not invent
    // an empty one.
    await runCli(["skills", "install", "search"], { withKey: false });

    expect(argv()).not.toContain("--env");
    expect(argv().join(" ")).not.toContain("SENSO_API_KEY");
  });

  it("falls back to npx when shipables is not on PATH", async () => {
    shipablesRuns((file, args) => {
      if (file === "shipables" && args[0] === "--version") throw new Error("ENOENT");
      return { stdout: "", stderr: "" };
    });

    await runCli(["skills", "install", "search"]);

    expect(invocations()[0]?.file).toBe("npx");
    // --yes before the package name is npx's own "do not ask before
    // downloading", which is a different flag from the install's --yes.
    expect(argv().slice(0, 3)).toEqual(["--yes", "@senso-ai/shipables", "install"]);
    expect(argv()).toContain("--yes");
  });

  it("puts the child's own output on stderr, never on stdout", async () => {
    shipablesRuns(() => ({ stdout: "shipables: wrote .claude/skills", stderr: "npm notice" }));

    const res = await runCli(["skills", "install", "search"]);

    expect(res.stderr).toContain("shipables: wrote .claude/skills");
    expect(res.stderr).toContain("npm notice");
    expect(res.stdout).not.toContain("npm notice");
  });
});

describe("skills install, when the agent is not one we know", () => {
  it("exits 2 and names the agents that are valid", async () => {
    const res = await runCli(["skills", "install", "search", "--agent", "emacs"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain('Unknown agent "emacs"');
    for (const agent of ["claude", "cursor", "codex", "copilot", "gemini", "cline"]) {
      expect(res.stderr).toContain(agent);
    }
  });

  it("spawns nothing before rejecting it", async () => {
    // The check happens before the first install, so a typo costs no
    // subprocess and installs no skill under the wrong agent.
    await runCli(["skills", "install", "search", "--agent", "emacs"]);

    expect(child.state.calls).toEqual([]);
  });

  it("accepts an agent name in any case", async () => {
    await runCli(["skills", "install", "search", "--agent", "Cursor"]);

    expect(argv()).toContain("--cursor");
  });
});

describe("skills install, when one of several skills fails", () => {
  /** ingest fails; search and content-gen do not. */
  function ingestFails(): void {
    shipablesRuns((_file, args) => {
      if (args.includes("senso-ai/senso-ingest")) {
        throw new Error("Command failed: shipables install senso-ai/senso-ingest");
      }
      return { stdout: "", stderr: "" };
    });
  }

  it("still installs the others", async () => {
    // Independent installs. Abandoning the queue on the first failure would
    // mean one unavailable package leaves the user with nothing.
    ingestFails();

    await runCli(["skills", "install", "ingest", "search", "content-gen"]);

    expect(invocations()).toHaveLength(3);
    expect(invocations().map(({ args }) => args[1])).toEqual([
      "senso-ai/senso-ingest",
      "senso-ai/senso-search",
      "senso-ai/senso-content-gen",
    ]);
  });

  it("exits non-zero, so a CI step can tell", async () => {
    // The regression this test exists for: every install could fail and the
    // command still exited 0 with "Done".
    ingestFails();

    const res = await runCli(["skills", "install", "ingest", "search"]);

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("Failed to install ingest");
    expect(res.stderr).toContain("1 of 2 skill(s) failed");
  });

  it("exits non-zero when every single one fails", async () => {
    shipablesRuns((_file, args) => {
      if (args[0] === "--version") return { stdout: "0.1.2", stderr: "" };
      throw new Error("registry unreachable");
    });

    const res = await runCli(["skills", "install", "search", "ingest"]);

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("2 of 2 skill(s) failed");
  });

  it("does not claim to be done", async () => {
    ingestFails();

    const res = await runCli(["skills", "install", "ingest", "search"]);

    expect(res.stderr).not.toContain("Done.");
  });

  it("keeps stdout empty and names the failures on stderr, under --output json", async () => {
    ingestFails();

    const res = await runCli(["skills", "install", "ingest", "search", "--output", "json"]);

    expect(res.exitCode).toBe(1);
    // The contract every other command keeps: a non-zero exit leaves stdout
    // empty, so a caller redirecting it to a file never mistakes a partial run
    // for a payload. Which skill failed is on stderr, in the error hint.
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("1 of 2 skill(s) failed");
    expect(res.stderr).toContain("Failed: ingest");
  });
});

describe("skills list, reading what the child printed", () => {
  it("asks for JSON, and for the global scope only when told to", async () => {
    shipablesRuns(() => ({ stdout: "[]", stderr: "" }));

    await runCli(["skills", "list"]);
    expect(argv()).toEqual(["list", "--json"]);

    child.state.calls = [];
    await runCli(["skills", "list", "--global"]);
    expect(argv()).toEqual(["list", "--global", "--json"]);
  });

  it("prints the child's JSON as the payload", async () => {
    const installed = [{ name: "senso-search", version: "0.1.2" }];
    shipablesRuns(() => ({ stdout: JSON.stringify(installed), stderr: "" }));

    const res = await runCli(["skills", "list", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.json()).toEqual(installed);
  });

  it("says so plainly when nothing is installed", async () => {
    shipablesRuns(() => ({ stdout: "[]", stderr: "" }));

    const res = await runCli(["skills", "list"]);

    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain("No skills installed");
  });

  it("exits 1 with a diagnosis when the child does not answer with JSON", async () => {
    // A missing binary, an npx banner, a proxy's error page: all of them arrive
    // here as text. JSON.parse throwing a SyntaxError at the user diagnoses
    // nothing.
    shipablesRuns(() => ({ stdout: "npm ERR! could not determine executable\n", stderr: "" }));

    const res = await runCli(["skills", "list"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("shipables did not return valid JSON");
    expect(res.stderr).toContain("@senso-ai/shipables");
    expect(res.stderr).not.toContain("SyntaxError");
  });

  it("reports that failure as a JSON error object on stderr", async () => {
    shipablesRuns(() => ({ stdout: "<html>proxy</html>", stderr: "" }));

    const res = await runCli(["skills", "list", "--output", "json"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(JSON.parse(res.stderr)).toMatchObject({ error: { code: "error" } });
  });

  it("exits 1 when the child itself fails", async () => {
    shipablesRuns((_file, args) => {
      if (args[0] === "--version") return { stdout: "0.1.2", stderr: "" };
      throw new Error("shipables: no such command");
    });

    const res = await runCli(["skills", "list"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("no such command");
  });
});

describe("skills remove", () => {
  it("uninstalls the expanded package name without prompting", async () => {
    const res = await runCli(["skills", "remove", "search"]);

    expect(res.exitCode).toBe(0);
    expect(argv()).toEqual(["uninstall", "senso-ai/senso-search", "--yes"]);
  });

  it("forwards --global", async () => {
    await runCli(["skills", "remove", "search", "--global"]);

    expect(argv()).toEqual(["uninstall", "senso-ai/senso-search", "--global", "--yes"]);
  });

  it("puts the confirmation on stderr, leaving stdout empty", async () => {
    // There is no payload here. A caller piping this command gets an empty
    // stream rather than a sentence.
    const res = await runCli(["skills", "remove", "search"]);

    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Removed search");
  });

  it("gives a JSON caller a parseable object instead", async () => {
    const res = await runCli(["skills", "remove", "search", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.json()).toEqual({ removed: "search", package: "senso-ai/senso-search" });
    expect(res.stderr).toBe("");
  });
});
