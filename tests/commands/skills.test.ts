/**
 * Command layer: `senso skills`.
 *
 * The only command group that delegates its work to another program. Nothing
 * here goes over HTTP, so what is worth protecting is the argv this command
 * hands to `shipables`, the environment it hands with it, and what it makes of
 * the result:
 *
 *   - THE CREDENTIAL. The API key travels in the child's ENVIRONMENT and never
 *     in its argv, because argv is readable by every process on the machine —
 *     and Node's own "Command failed: <argv>" rejection message put it back on
 *     stderr the moment the child failed. Both halves are asserted here: the
 *     key is absent from every argv, and no failure path prints it;
 *   - BOTH SPELLINGS OF A NAME. `search` and `senso-ai/senso-search` are the
 *     same skill, and the second is what `list-available` prints. Only the
 *     short form used to be handled, so feeding this command its own output
 *     built `senso-ai/senso-senso-ai/senso-search` and failed after a
 *     120-second round trip through npx;
 *   - the argv itself. `--yes` is what keeps a non-interactive install from
 *     hanging on a prompt nobody can answer, and shipables' uninstall rejects
 *     that same flag as unknown, so both are asserted literally;
 *   - a partial failure. Skills are independent installs, so one failing must
 *     not abandon the rest — and the command must still exit non-zero;
 *   - a child that answers with something other than JSON, and
 *     `list-available`, which must answer from the built-in list without
 *     spawning anything at all.
 *
 * `execFile` is mocked because the alternative is a test that downloads and
 * installs packages. skills.ts promisifies it at module load, so the mock
 * carries the promisify custom symbol; without it `promisify` would resolve the
 * bare stdout string and the destructuring in skills.ts would throw.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_API_KEY } from "../setup.js";
import { envelope, errorEnvelope, runCli } from "../helpers.js";

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
  options?: { env?: Record<string, string | undefined>; cwd?: string };
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
      [PROMISIFIED]: (file: string, args: string[], options?: ChildCall["options"]) =>
        new Promise<{ stdout: string; stderr: string }>((resolve) => {
          state.calls.push({ file, args, options });
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

/** Everything every invocation was given, as one string. */
function everyArgv(): string {
  return child.state.calls.map(({ args }) => args.join(" ")).join(" | ");
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

describe("skills install, and the credential", () => {
  it("never puts the API key in the child's argv", async () => {
    // argv is readable by every process on the machine, and it lands in shell
    // history. The key used to be passed as `--env SENSO_API_KEY=<key>`, which
    // bought nothing: shipables reads --env only for a skill whose manifest
    // declares an MCP server, and no Senso skill declares one.
    const res = await runCli(["skills", "install", "search", "--agent", "claude"]);

    expect(res.exitCode).toBe(0);
    expect(argv()).not.toContain("--env");
    expect(everyArgv()).not.toContain(TEST_API_KEY);
    expect(everyArgv()).not.toContain("SENSO_API_KEY");
  });

  it("exports it to the child's environment instead, on top of our own", async () => {
    await runCli(["skills", "install", "search"]);

    const env = invocations()[0]?.options?.env;
    expect(env?.SENSO_API_KEY).toBe(TEST_API_KEY);
    // The rest of the environment survives: without PATH the child cannot run.
    expect(env?.PATH).toBe(process.env.PATH);
  });

  it("does not echo the child's command line when the child fails", async () => {
    // Node builds the rejection message as `Command failed: <the whole argv>`
    // followed by the child's stderr. Relaying that verbatim is how this
    // command used to print the key back out on a failure.
    shipablesRuns((_file, args) => {
      if (args[0] === "--version") return { stdout: "0.1.2", stderr: "" };
      throw Object.assign(
        new Error(`Command failed: shipables install senso-ai/senso-search --claude --yes`),
        { stdout: "", stderr: "shipables: the registry returned 404" },
      );
    });

    const res = await runCli(["skills", "install", "search"]);

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("the registry returned 404");
    expect(res.stderr).not.toContain("Command failed:");
  });

  it("redacts the key from anything the child said, however it got there", async () => {
    // Belt and braces: shipables could print it back, or a wrapper could put it
    // in an error message. Nothing this command relays may carry it.
    shipablesRuns((_file, args) => {
      if (args[0] === "--version") return { stdout: "0.1.2", stderr: "" };
      throw Object.assign(new Error("Command failed"), {
        stdout: "",
        stderr: `auth failed for SENSO_API_KEY=${TEST_API_KEY}`,
      });
    });

    const res = await runCli(["skills", "install", "search"]);

    expect(res.exitCode).toBe(1);
    expect(res.stderr).not.toContain(TEST_API_KEY);
    expect(res.stderr).toContain("<redacted>");
  });

  it("redacts it out of what a SUCCESSFUL child printed too", async () => {
    shipablesRuns(() => ({ stdout: `wrote .claude/skills (key ${TEST_API_KEY})`, stderr: "" }));

    const res = await runCli(["skills", "install", "search"]);

    expect(res.exitCode).toBe(0);
    expect(res.stderr).not.toContain(TEST_API_KEY);
    expect(res.stdout).not.toContain(TEST_API_KEY);
  });

  it("passes no environment override, and warns, when there is no key at all", async () => {
    // The skill authenticates through this CLI, which reads the key when it
    // runs — but an install with nothing configured is worth saying out loud.
    const res = await runCli(["skills", "install", "search", "--output", "json"], {
      withKey: false,
    });

    expect(res.exitCode).toBe(0);
    expect(invocations()[0]?.options?.env).toBeUndefined();
    expect(everyArgv()).not.toContain("SENSO_API_KEY");
    expect(envelope(res).warnings?.join(" ")).toContain("senso login");
  });
});

describe("skills install and remove, on both spellings of a name", () => {
  it("expands the short name to the package", async () => {
    await runCli(["skills", "install", "search"]);

    expect(argv()[1]).toBe("senso-ai/senso-search");
  });

  it("accepts the package form `list-available` prints, without prefixing it twice", async () => {
    // Feeding this command its own output used to build
    // `senso-ai/senso-senso-ai/senso-search` and fail after a 120-second npx
    // round trip that ended in a registry 404.
    await runCli(["skills", "install", "senso-ai/senso-search"]);

    expect(argv()[1]).toBe("senso-ai/senso-search");
    expect(everyArgv()).not.toContain("senso-senso-ai");
  });

  it("accepts both spellings for remove as well", async () => {
    await runCli(["skills", "remove", "senso-ai/senso-search"]);

    expect(argv()).toEqual(["uninstall", "senso-ai/senso-search"]);
  });

  it("passes somebody else's scoped package through untouched", async () => {
    // This CLI has no list to check it against, and refusing it would remove
    // the only way to install a skill Senso does not publish.
    await runCli(["skills", "install", "@someone/their-skill"]);

    expect(argv()[1]).toBe("@someone/their-skill");
  });

  it("exits 2 on an unknown name, spawning nothing, and suggests the near miss", async () => {
    const res = await runCli(["skills", "install", "serach", "--output", "json"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(child.state.calls).toEqual([]);
    const { error } = errorEnvelope(res);
    expect(error.code).toBe("usage");
    expect(error.field).toBe("[names...]");
    expect(error.received).toBe("serach");
    expect(error.allowed).toContain("search");
    expect(error.hint).toContain("Did you mean search?");
  });

  it("exits 2 on an unknown name for remove too, spawning nothing", async () => {
    const res = await runCli(["skills", "remove", "not-a-skill", "--output", "json"]);

    expect(res.exitCode).toBe(2);
    expect(child.state.calls).toEqual([]);
    expect(errorEnvelope(res).error.field).toBe("<name>");
  });
});

describe("skills install, on the argv", () => {
  it("passes the agent flag and --yes, and nothing else", async () => {
    const res = await runCli(["skills", "install", "search", "--agent", "claude"]);

    expect(res.exitCode).toBe(0);
    expect(invocations()).toHaveLength(1);
    // Asserted whole. --yes is what stops the child prompting in CI, and the
    // agent flag is the entire meaning of --agent.
    expect(argv()).toEqual(["install", "senso-ai/senso-search", "--claude", "--yes"]);
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

  it("forwards --global to the child", async () => {
    await runCli(["skills", "install", "search", "--global"]);

    expect(argv()).toContain("--global");
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

  it("reports what it installed, and where, under --output json", async () => {
    const res = await runCli([
      "skills",
      "install",
      "search",
      "--agent",
      "claude",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toMatchObject({
      installed: [{ name: "search", package: "senso-ai/senso-search" }],
      failed: [],
      scope: process.cwd(),
      agent: "claude",
    });
    expect(res.stderr).toBe("");
  });
});

describe("skills install, when the agent is not one we know", () => {
  it("exits 2 and names the agents that are valid", async () => {
    const res = await runCli([
      "skills",
      "install",
      "search",
      "--agent",
      "emacs",
      "--output",
      "json",
    ]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    const { error } = errorEnvelope(res);
    expect(error.field).toBe("--agent");
    expect(error.allowed).toEqual(["claude", "cursor", "codex", "copilot", "gemini", "cline"]);
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
        throw Object.assign(new Error("Command failed"), {
          stdout: "",
          stderr: "shipables: the registry returned 404",
        });
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
    expect(res.stderr).not.toContain("Done.");
  });

  it("keeps stdout empty and says which ones did install, under --output json", async () => {
    ingestFails();

    const res = await runCli(["skills", "install", "ingest", "search", "--output", "json"]);

    expect(res.exitCode).toBe(1);
    // The contract every other command keeps: a non-zero exit leaves stdout
    // empty, so a caller redirecting it to a file never mistakes a partial run
    // for a payload. What DID install is the question a partial failure
    // raises, so it travels in error.details.
    expect(res.stdout).toBe("");
    const { error } = errorEnvelope(res);
    expect(error.details).toMatchObject({
      installed: [{ name: "search", package: "senso-ai/senso-search" }],
      failed: [{ name: "ingest", reason: "shipables: the registry returned 404" }],
    });
    expect(error.hint).toContain("senso skills install ingest");
  });

  it("exits 5 when every failure was the 120-second timeout", async () => {
    // A timeout is a network failure, and exit 5 is what carries "retrying may
    // work" — which for an npx download it often does.
    shipablesRuns((_file, args) => {
      if (args[0] === "--version") return { stdout: "0.1.2", stderr: "" };
      throw Object.assign(new Error("Command failed"), { killed: true, signal: "SIGTERM" });
    });

    const res = await runCli(["skills", "install", "search", "--output", "json"]);

    expect(res.exitCode).toBe(5);
    expect(errorEnvelope(res).error.code).toBe("timeout");
  });
});

describe("skills list, reading what the child printed", () => {
  /** What shipables 0.1.x prints under `list --json`: a map keyed by package. */
  const INSTALLED = {
    "senso-ai/senso-search": { version: "0.1.2", agents: ["claude", "cursor"] },
  };

  it("asks for JSON, and for the global scope only when told to", async () => {
    shipablesRuns(() => ({ stdout: "{}", stderr: "" }));

    await runCli(["skills", "list"]);
    expect(argv()).toEqual(["list", "--json"]);

    child.state.calls = [];
    await runCli(["skills", "list", "--global"]);
    expect(argv()).toEqual(["list", "--global", "--json"]);
  });

  it("turns the child's map into a list, and says which scope it is for", async () => {
    shipablesRuns(() => ({ stdout: JSON.stringify(INSTALLED), stderr: "" }));

    const res = await runCli(["skills", "list", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toEqual({
      scope: process.cwd(),
      skills: [
        {
          name: "search",
          package: "senso-ai/senso-search",
          version: "0.1.2",
          agents: ["claude", "cursor"],
        },
      ],
    });
  });

  it("renders the scope and a row per skill in plain", async () => {
    shipablesRuns(() => ({ stdout: JSON.stringify(INSTALLED), stderr: "" }));

    const res = await runCli(["skills", "list"]);

    expect(res.stdout).toContain("scope");
    expect(res.stdout).toContain("search");
    expect(res.stdout).toContain("0.1.2");
  });

  it("says so when nothing is installed HERE, and that other projects are not shown", async () => {
    // shipables prints `{}` for a scope with nothing in it. Rendering that map
    // raw meant an empty project printed a blank line and nothing else.
    shipablesRuns(() => ({ stdout: "{}", stderr: "" }));

    const res = await runCli(["skills", "list"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("No Senso skills installed in");
    expect(res.stderr).toContain("Skills installed in another project are not shown");
    expect(res.stderr).toContain("--global");
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

  it("reports that failure as an error envelope on stderr", async () => {
    shipablesRuns(() => ({ stdout: "<html>proxy</html>", stderr: "" }));

    const res = await runCli(["skills", "list", "--output", "json"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(errorEnvelope(res).error.code).toBe("error");
  });

  it("exits 1 when the child itself fails", async () => {
    shipablesRuns((_file, args) => {
      if (args[0] === "--version") return { stdout: "0.1.2", stderr: "" };
      throw Object.assign(new Error("Command failed"), {
        stdout: "",
        stderr: "shipables: no such command",
      });
    });

    const res = await runCli(["skills", "list"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("no such command");
  });
});

describe("skills list-available, which answers for itself", () => {
  it("spawns nothing at all", async () => {
    // The one subcommand that is pure local data, and the one an agent is
    // meant to call first. Shelling out to discover a hard-coded list would
    // make discovery cost a subprocess and a network round trip.
    const res = await runCli(["skills", "list-available"]);

    expect(res.exitCode).toBe(0);
    expect(child.state.calls).toEqual([]);
  });

  it("lists every official skill by short name, package and one-line summary", async () => {
    const res = await runCli(["skills", "list-available", "--output", "json"]);

    const { skills } = res.data<{ skills: { name: string; package: string }[] }>();
    expect(skills).toHaveLength(SKILL_COUNT);
    expect(skills).toContainEqual({
      name: "search",
      package: "senso-ai/senso-search",
      description: "Search the knowledge base for verified answers, chunks and content ids.",
    });
    expect(res.stderr).toBe("");
  });

  it("prints both spellings, so either can be fed back to install", async () => {
    const res = await runCli(["skills", "list-available"]);

    expect(res.stdout).toContain("search");
    expect(res.stdout).toContain("senso-ai/senso-onboarding");
    // The next step is guidance, so it belongs on stderr rather than in the
    // payload a caller is parsing.
    expect(res.stderr).toContain("senso skills install --all");
  });

  it("renders a row per skill under --output table", async () => {
    const res = await runCli(["skills", "list-available", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("package");
    expect(res.stdout).toContain("content-gen");
    expect(res.stderr).not.toContain("which the API did not return");
  });
});

describe("skills remove", () => {
  it("uninstalls the expanded package name, without a --yes shipables does not take", async () => {
    // shipables' uninstall has no --yes flag and rejects it as an unknown
    // option. Passing it made every `skills remove` exit 1 having removed
    // nothing, so the argv is asserted literally.
    const res = await runCli(["skills", "remove", "search"]);

    expect(res.exitCode).toBe(0);
    expect(argv()).toEqual(["uninstall", "senso-ai/senso-search"]);
  });

  it("forwards --global", async () => {
    await runCli(["skills", "remove", "search", "--global"]);

    expect(argv()).toEqual(["uninstall", "senso-ai/senso-search", "--global"]);
  });

  it("exits 4, not 1, when the skill is simply not installed here", async () => {
    // shipables exits non-zero for a skill it has no record of, which is a 404
    // in every sense that matters: the name was fine, the thing is not there.
    shipablesRuns((_file, args) => {
      if (args[0] === "--version") return { stdout: "0.1.2", stderr: "" };
      throw Object.assign(new Error("Command failed"), {
        stdout: "",
        stderr: "senso-ai/senso-search is not installed",
      });
    });

    const res = await runCli(["skills", "remove", "search", "--output", "json"]);

    expect(res.exitCode).toBe(4);
    expect(res.stdout).toBe("");
    const { error } = errorEnvelope(res);
    expect(error.code).toBe("not_found");
    expect(error.field).toBe("<name>");
    expect(error.hint).toContain("--global");
  });

  it("puts the confirmation on stderr, leaving stdout empty", async () => {
    // There is no payload here. A caller piping this command gets an empty
    // stream rather than a sentence.
    const res = await runCli(["skills", "remove", "search"]);

    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Removed skill search");
  });

  it("gives a JSON caller a record of what went, not a sentence to parse", async () => {
    const res = await runCli(["skills", "remove", "search", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toEqual({
      action: "removed",
      resource: "skill",
      id: "search",
      package: "senso-ai/senso-search",
      scope: process.cwd(),
    });
    expect(res.stderr).toBe("");
  });
});
