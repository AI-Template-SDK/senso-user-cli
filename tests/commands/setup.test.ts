/**
 * Command layer: `senso setup`.
 *
 * A shortcut for `skills install --all --global`, which makes its whole value
 * the argv it hands to `shipables`. What is worth protecting here:
 *
 *   - `--global` is present unless someone asked for `--local`. This command
 *     exists because a project-level install is invisible from the next
 *     directory, and a wrongly-scoped install reports success either way — so
 *     nothing but an argv assertion can catch the regression;
 *   - the full official set is installed, and it is the same set `skills
 *     install --all` uses. Two lists would be two first-run experiences;
 *   - `--global --local` together is a usage error, not a coin toss;
 *   - the failure accounting it inherits: one skill failing must not abandon
 *     the rest, and must still exit non-zero.
 *
 * `execFile` is mocked for the same reason as in skills.test.ts — the
 * alternative is a test that downloads and installs packages — and carries the
 * promisify custom symbol because skills.ts promisifies it at module load.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_API_KEY } from "../setup.js";
import { runCli } from "../helpers.js";
import { SENSO_SKILLS } from "../../src/commands/skills.js";

/**
 * A temporary, never-created config directory, pinned before the imports above
 * are evaluated — see the same guard in skills.test.ts. Without it the
 * `withKey: false` case reads the developer's own stored key.
 */
vi.hoisted(() => {
  const tmp = (process.env.TMPDIR ?? process.env.TEMP ?? "/tmp").replace(/[/\\]+$/, "");
  process.env.SENSO_CONFIG_DIR = `${tmp}/senso-setup-test-${process.pid}`;
});

interface ChildCall {
  file: string;
  args: string[];
}

const child = vi.hoisted(() => {
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

function shipablesRuns(impl: (file: string, args: string[]) => { stdout: string; stderr: string }) {
  child.state.run = impl;
}

/** Every invocation except the `shipables --version` availability probe. */
function invocations(): ChildCall[] {
  return child.state.calls.filter(({ args }) => args[0] !== "--version");
}

/** The package argument of every install this command performed. */
function installedPackages(): string[] {
  return invocations().map(({ args }) => args[1] ?? "");
}

beforeEach(() => {
  child.state.calls = [];
  shipablesRuns(() => ({ stdout: "", stderr: "" }));
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("setup, on the ways it can be asked for the wrong thing", () => {
  it("exits 2 when --global and --local are both given", async () => {
    // Picking a winner would install to the wrong scope silently, and a
    // wrongly-scoped install looks exactly like a correct one afterwards.
    const res = await runCli(["setup", "--global", "--local"]);

    expect(res.exitCode).toBe(2);
    expect(invocations()).toEqual([]);
    expect(res.stdout).toBe("");
  });

  it("exits 2 on an agent it does not know, before spawning anything", async () => {
    const res = await runCli(["setup", "--agent", "emacs"]);

    expect(res.exitCode).toBe(2);
    expect(invocations()).toEqual([]);
    expect(res.stderr).toContain("emacs");
  });

  it("exits 1 and stays quiet on stdout when a skill fails to install", async () => {
    shipablesRuns((_file, args) => {
      if (args[1] === "senso-ai/senso-publish") throw new Error("registry unreachable");
      return { stdout: "", stderr: "" };
    });

    const res = await runCli(["setup"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("publish");
  });

  it("installs the rest of the set even after one fails", async () => {
    // Independent installs. Abandoning four because the first 404'd would turn
    // a transient registry blip into a machine with no skills at all.
    shipablesRuns((_file, args) => {
      if (args[1] === "senso-ai/senso-quickstart") throw new Error("boom");
      return { stdout: "", stderr: "" };
    });

    await runCli(["setup"]);

    expect(invocations()).toHaveLength(SENSO_SKILLS.length);
  });
});

describe("setup, on the argv it hands to shipables", () => {
  it("installs every official skill, globally, targeting every agent", async () => {
    const res = await runCli(["setup"]);

    expect(res.exitCode).toBe(0);
    expect(installedPackages()).toEqual([...SENSO_SKILLS]);
    // Asserted whole: --global is the entire reason this command exists, and
    // --yes is what stops the child prompting where nobody can answer.
    expect(invocations()[0]?.args).toEqual([
      "install",
      "senso-ai/senso-quickstart",
      "--all",
      "--global",
      "--env",
      `SENSO_API_KEY=${TEST_API_KEY}`,
      "--yes",
    ]);
  });

  it("drops --global when --local is given, and nothing else changes", async () => {
    await runCli(["setup", "--local"]);

    for (const { args } of invocations()) {
      expect(args).not.toContain("--global");
    }
    expect(installedPackages()).toEqual([...SENSO_SKILLS]);
  });

  it("keeps --global when it is passed explicitly, since that is the default anyway", async () => {
    // An agent that spells out the default must not get an unknown-option
    // error for agreeing with us.
    const res = await runCli(["setup", "--global"]);

    expect(res.exitCode).toBe(0);
    expect(invocations()[0]?.args).toContain("--global");
  });

  it("narrows to one agent with --agent", async () => {
    await runCli(["setup", "--agent", "claude"]);

    expect(invocations()[0]?.args).toContain("--claude");
    expect(invocations()[0]?.args).not.toContain("--all");
  });

  it("omits --env entirely when there is no key to pass", async () => {
    // Half a flag is worse than none: `--env` with nothing after it would make
    // shipables read the next argument as the variable.
    await runCli(["setup"], { withKey: false });

    expect(invocations()[0]?.args).not.toContain("--env");
  });

  it("installs the same set as skills install --all", async () => {
    await runCli(["setup"]);
    const viaSetup = installedPackages();

    child.state.calls = [];
    await runCli(["skills", "install", "--all"]);

    expect(viaSetup).toEqual(installedPackages());
  });
});

describe("setup, on what it reports", () => {
  it("emits the installed short names as the payload", async () => {
    const res = await runCli(["setup", "--output", "json"]);

    expect(res.json()).toEqual({
      installed: [
        "quickstart",
        "context-layer",
        "evaluate-remediate",
        "generate-verify",
        "publish",
      ],
      failed: [],
    });
  });

  it("says nothing on stderr beyond the payload under --output json", async () => {
    // --output json implies --quiet, and the child's own progress output is the
    // easiest thing to leak past that.
    shipablesRuns(() => ({ stdout: "installing...", stderr: "resolving..." }));

    const res = await runCli(["setup", "--output", "json"]);

    expect(res.stderr).not.toContain("installing...");
    expect(res.stderr).not.toContain("resolving...");
  });
});
