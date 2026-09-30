/**
 * Command layer: `senso setup`.
 *
 * Installs the official set globally, skips what is already current, and
 * removes retired skills. Its value is the argv it hands to `shipables` and
 * what it deletes, so that is what is worth protecting here:
 *
 *   - `--global` is present unless someone asked for `--local`, and a global
 *     install names every supported agent rather than shipables' `--all`, which
 *     means only the agents it happens to detect from the current directory;
 *   - a machine with all nine at their latest versions installs nothing and
 *     says "up to date", so an agent can run it every session;
 *   - a retired skill is removed only after every install succeeded, and is
 *     removed from disk even when shipables has no record of it — `shipables
 *     uninstall` exits 4 and leaves the files in that case;
 *   - it deletes nothing but the retired skill's own directories;
 *   - `--global --local` together is a usage error, not a coin toss, and one
 *     skill failing must not abandon the rest and must still exit non-zero.
 *
 * `execFile` is mocked for the same reason as in skills.test.ts — the
 * alternative is a test that downloads and installs packages — and carries the
 * promisify custom symbol because skills.ts promisifies it at module load.
 * HOME points at a fresh directory per test, because setup deletes directories
 * under it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEST_API_KEY } from "../setup.js";
import { runCli } from "../helpers.js";
import { SENSO_SKILLS, SUPPORTED_AGENTS } from "../../src/commands/skills.js";

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

const ALL_AGENT_FLAGS = SUPPORTED_AGENTS.map((a) => `--${a}`);
const RETIRED = "senso-ai/senso-evaluate-remediate";

/** The registry, as `shipables search --json` reports it. */
let registry: Record<string, string>;
/** shipables' record for the scope, as `shipables list --json` reports it. */
let recorded: Record<string, { version: string; agents: string[] }>;
/** Invocations that should fail, matched on the package argument. */
let failing: Set<string>;

function fakeShipables(_file: string, args: string[]): { stdout: string; stderr: string } {
  const [command, pkg] = args;
  if (command === "list") return { stdout: JSON.stringify(recorded), stderr: "" };
  if (command === "search") {
    const skills = Object.entries(registry).map(([full_name, latest_version]) => ({
      full_name,
      latest_version,
    }));
    return { stdout: JSON.stringify({ skills, pagination: {} }), stderr: "" };
  }
  if (pkg && failing.has(pkg)) throw new Error(`Command failed: shipables ${command} ${pkg}`);
  return { stdout: "", stderr: "" };
}

/** Every invocation of the given shipables command. */
function calls(command: string): ChildCall[] {
  return child.state.calls.filter(({ args }) => args[0] === command);
}

/** The package argument of every install this command performed. */
function installedPackages(): string[] {
  return calls("install").map(({ args }) => args[1] ?? "");
}

/** Every official skill recorded at its latest version, for every agent. */
function everythingCurrent(): void {
  for (const pkg of SENSO_SKILLS) {
    recorded[pkg] = { version: registry[pkg] ?? "", agents: [...SUPPORTED_AGENTS] };
  }
}

/** A skill directory on disk, as shipables would have left it. */
function skillDir(relative: string): string {
  const dir = join(home, relative);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), "---\nname: x\n---\n");
  return dir;
}

let home: string;
const originalHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "senso-setup-home-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;

  registry = Object.fromEntries(SENSO_SKILLS.map((pkg) => [pkg, "1.0.0"]));
  registry[RETIRED] = "0.8.0";
  recorded = {};
  failing = new Set();
  child.state.calls = [];
  child.state.run = fakeShipables;
});

afterEach(() => {
  process.env.HOME = originalHome.HOME;
  process.env.USERPROFILE = originalHome.USERPROFILE;
  rmSync(home, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("setup, on the ways it can be asked for the wrong thing", () => {
  it("exits 2 when --global and --local are both given", async () => {
    // Picking a winner would install to the wrong scope silently, and a
    // wrongly-scoped install looks exactly like a correct one afterwards.
    const res = await runCli(["setup", "--global", "--local"]);

    expect(res.exitCode).toBe(2);
    expect(child.state.calls).toEqual([]);
    expect(res.stdout).toBe("");
  });

  it("exits 2 on an agent it does not know, before spawning anything", async () => {
    const res = await runCli(["setup", "--agent", "emacs"]);

    expect(res.exitCode).toBe(2);
    expect(child.state.calls).toEqual([]);
    expect(res.stderr).toContain("emacs");
  });
});

describe("setup, when an install fails", () => {
  it("exits 1 and stays quiet on stdout", async () => {
    failing.add("senso-ai/senso-publish");

    const res = await runCli(["setup"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("publish");
  });

  it("installs the rest of the set even after one fails", async () => {
    // Independent installs. Abandoning eight because the first 404'd would
    // turn a transient registry blip into a machine with no skills at all.
    failing.add("senso-ai/senso-quickstart");

    await runCli(["setup"]);

    expect(installedPackages()).toEqual([...SENSO_SKILLS]);
  });

  it("leaves the retired skill in place, since its replacement may be what failed", async () => {
    // gap-report carries part of what evaluate-remediate did. Removing the old
    // one when the new one did not arrive would leave the user with neither.
    recorded[RETIRED] = { version: "0.7.3", agents: ["claude"] };
    const old = skillDir(".claude/skills/senso-evaluate-remediate");
    failing.add("senso-ai/senso-gap-report");

    const res = await runCli(["setup"]);

    expect(res.exitCode).toBe(1);
    expect(calls("uninstall")).toEqual([]);
    expect(existsSync(old)).toBe(true);
  });
});

describe("setup, when it cannot tell what is installed", () => {
  it("installs everything when shipables' record is not JSON", async () => {
    // The check is an optimization. Without it, setup does what it did before
    // it could skip anything, rather than failing a first run.
    child.state.run = (file, args) =>
      args[0] === "list" ? { stdout: "npm WARN exec", stderr: "" } : fakeShipables(file, args);

    const res = await runCli(["setup"]);

    expect(res.exitCode).toBe(0);
    expect(installedPackages()).toEqual([...SENSO_SKILLS]);
  });

  it("installs everything when the registry search fails", async () => {
    everythingCurrent();
    child.state.run = (file, args) => {
      if (args[0] === "search") throw new Error("HTTP 429");
      return fakeShipables(file, args);
    };

    const res = await runCli(["setup"]);

    expect(res.exitCode).toBe(0);
    expect(installedPackages()).toEqual([...SENSO_SKILLS]);
  });
});

describe("setup, on the argv it hands to shipables", () => {
  it("installs all nine, globally, naming every supported agent", async () => {
    const res = await runCli(["setup"]);

    expect(res.exitCode).toBe(0);
    expect(installedPackages()).toEqual([...SENSO_SKILLS]);
    // Asserted whole: --global is the reason this command exists, every agent
    // is named because shipables' --all means only the detected ones, and
    // --yes is what stops the child prompting where nobody can answer.
    expect(calls("install")[0]?.args).toEqual([
      "install",
      "senso-ai/senso-quickstart",
      ...ALL_AGENT_FLAGS,
      "--global",
      "--env",
      `SENSO_API_KEY=${TEST_API_KEY}`,
      "--yes",
    ]);
  });

  it("reads the global record and searches the registry once", async () => {
    // One search, not a lookup per skill: the registry rate-limits.
    await runCli(["setup"]);

    expect(calls("list").map(({ args }) => args)).toEqual([["list", "--global", "--json"]]);
    expect(calls("search")).toHaveLength(1);
  });

  it("drops --global when --local is given, and lets shipables pick the agents", async () => {
    // Naming all six in a project would create .claude, .cursor and .agents in
    // a repository that uses one of them.
    await runCli(["setup", "--local"]);

    for (const { args } of calls("install")) {
      expect(args).not.toContain("--global");
      expect(args).toContain("--all");
    }
    expect(calls("list")[0]?.args).toEqual(["list", "--json"]);
    expect(installedPackages()).toEqual([...SENSO_SKILLS]);
  });

  it("keeps --global when it is passed explicitly, since that is the default anyway", async () => {
    // An agent that spells out the default must not get an unknown-option
    // error for agreeing with us.
    const res = await runCli(["setup", "--global"]);

    expect(res.exitCode).toBe(0);
    expect(calls("install")[0]?.args).toContain("--global");
  });

  it("narrows to one agent with --agent", async () => {
    await runCli(["setup", "--agent", "claude"]);

    const args = calls("install")[0]?.args ?? [];
    expect(args).toContain("--claude");
    expect(args).not.toContain("--cursor");
    expect(args).not.toContain("--all");
  });

  it("omits --env entirely when there is no key to pass", async () => {
    // Half a flag is worse than none: `--env` with nothing after it would make
    // shipables read the next argument as the variable.
    await runCli(["setup"], { withKey: false });

    expect(calls("install")[0]?.args).not.toContain("--env");
  });

  it("installs the same set as skills install --all", async () => {
    await runCli(["setup"]);
    const viaSetup = installedPackages();

    child.state.calls = [];
    await runCli(["skills", "install", "--all"]);

    expect(viaSetup).toEqual(installedPackages());
  });
});

describe("setup, on a machine that already has the skills", () => {
  it("installs nothing and says up to date when all nine are current", async () => {
    everythingCurrent();

    const res = await runCli(["setup"]);

    expect(res.exitCode).toBe(0);
    expect(calls("install")).toEqual([]);
    expect(res.stderr).toContain("up to date");
  });

  it("reports the no-op as a payload under --output json", async () => {
    everythingCurrent();

    const res = await runCli(["setup", "--output", "json"]);

    expect(res.json()).toEqual({
      installed: [],
      upToDate: SENSO_SKILLS.map((p) => p.replace("senso-ai/senso-", "")),
      removed: [],
      failed: [],
    });
  });

  it("installs only the skill that is behind the registry", async () => {
    everythingCurrent();
    recorded["senso-ai/senso-quickstart"] = { version: "0.8.2", agents: [...SUPPORTED_AGENTS] };

    await runCli(["setup"]);

    expect(installedPackages()).toEqual(["senso-ai/senso-quickstart"]);
  });

  it("installs a current skill again for an agent it is missing from", async () => {
    everythingCurrent();
    recorded["senso-ai/senso-publish"] = { version: "1.0.0", agents: ["claude"] };

    await runCli(["setup"]);

    expect(installedPackages()).toEqual(["senso-ai/senso-publish"]);
  });

  it("counts a skill recorded under the @ spelling as installed", async () => {
    everythingCurrent();
    const record = recorded["senso-ai/senso-gap-report"];
    delete recorded["senso-ai/senso-gap-report"];
    recorded["@senso-ai/senso-gap-report"] = record!;

    await runCli(["setup"]);

    expect(calls("install")).toEqual([]);
  });
});

describe("setup, on the retired evaluate-remediate", () => {
  it("uninstalls it through shipables, globally", async () => {
    recorded[RETIRED] = { version: "0.7.3", agents: ["claude"] };

    const res = await runCli(["setup", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(calls("uninstall").map(({ args }) => args)).toEqual([
      ["uninstall", RETIRED, "--global"],
    ]);
    expect(res.json()).toMatchObject({ removed: ["evaluate-remediate"] });
  });

  it("uninstalls a record under the @ spelling under that spelling", async () => {
    // shipables looks records up by exact name; the bare spelling would report
    // "not installed" and remove nothing.
    recorded[`@${RETIRED}`] = { version: "0.7.3", agents: ["claude"] };

    await runCli(["setup"]);

    expect(calls("uninstall").map(({ args }) => args[1])).toEqual([`@${RETIRED}`]);
  });

  it("deletes its directory from every agent even when shipables has no record", async () => {
    // The case shipables cannot handle: it exits 4 and leaves the files.
    const dirs = [
      skillDir(".claude/skills/senso-evaluate-remediate"),
      skillDir(".cursor/skills/senso-evaluate-remediate"),
      skillDir(".agents/skills/senso-evaluate-remediate"),
    ];

    const res = await runCli(["setup", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    for (const dir of dirs) expect(existsSync(dir)).toBe(false);
    expect(res.json()).toMatchObject({ removed: ["evaluate-remediate"] });
  });

  it("still deletes the directory when shipables' uninstall fails", async () => {
    recorded[RETIRED] = { version: "0.7.3", agents: ["claude"] };
    failing.add(RETIRED);
    const dir = skillDir(".claude/skills/senso-evaluate-remediate");

    const res = await runCli(["setup"]);

    expect(res.exitCode).toBe(0);
    expect(existsSync(dir)).toBe(false);
  });

  it("deletes nothing else in the skills directories", async () => {
    const kept = [
      skillDir(".claude/skills/senso-quickstart"),
      skillDir(".claude/skills/someone-elses-skill"),
      skillDir(".agents/skills/senso-evaluate-remediate-notes"),
    ];

    await runCli(["setup"]);

    for (const dir of kept) expect(existsSync(dir)).toBe(true);
  });

  it("removes it on a machine that is otherwise up to date", async () => {
    everythingCurrent();
    recorded[RETIRED] = { version: "0.7.3", agents: ["claude"] };

    const res = await runCli(["setup"]);

    expect(calls("install")).toEqual([]);
    expect(calls("uninstall")).toHaveLength(1);
    expect(res.stderr).toContain("Removed retired skill evaluate-remediate");
    expect(res.stderr).not.toContain("up to date");
  });

  it("uninstalls from the project, and sweeps the project, under --local", async () => {
    recorded[RETIRED] = { version: "0.7.3", agents: ["claude"] };
    const inHome = skillDir(".claude/skills/senso-evaluate-remediate");

    await runCli(["setup", "--local"]);

    expect(calls("uninstall").map(({ args }) => args)).toEqual([["uninstall", RETIRED]]);
    // A project-scoped run has no business in the home directory.
    expect(existsSync(inHome)).toBe(true);
  });
});

describe("setup, on what it reports", () => {
  it("emits what it installed as the payload", async () => {
    const res = await runCli(["setup", "--output", "json"]);

    expect(res.json()).toEqual({
      installed: [
        "quickstart",
        "verification-loop-setup",
        "verification-loop",
        "shared-context-setup",
        "shared-context",
        "context-layer",
        "gap-report",
        "generate-verify",
        "publish",
      ],
      upToDate: [],
      removed: [],
      failed: [],
    });
  });

  it("says nothing on stderr beyond the payload under --output json", async () => {
    // --output json implies --quiet, and the child's own progress output is the
    // easiest thing to leak past that.
    child.state.run = (file, args) =>
      args[0] === "install"
        ? { stdout: "installing...", stderr: "resolving..." }
        : fakeShipables(file, args);

    const res = await runCli(["setup", "--output", "json"]);

    expect(res.stderr).not.toContain("installing...");
    expect(res.stderr).not.toContain("resolving...");
  });
});
