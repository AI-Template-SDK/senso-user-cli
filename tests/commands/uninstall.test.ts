/**
 * Command layer: `senso uninstall`.
 *
 * The one command whose job is to leave nothing behind, run against a machine
 * it is about to change in three places. What is worth protecting is the
 * order and the stopping points, because a mistake here is not a wrong
 * rendering but a half-removed install with no tool left to finish the job:
 *
 *   - it must not remove anything without consent. Without a terminal and
 *     without --yes it exits 2 before touching a file or spawning a process,
 *     because an agent that ran it by accident would otherwise take the CLI
 *     down with it;
 *   - a skill that will not uninstall stops everything after it. The CLI is
 *     what the user would retry with, so it stays, and so does the key;
 *   - the config file must be gone, and must stay gone. The update check
 *     writes that file after the command has finished, which is why the
 *     command is exempt from it — asserted here because nothing else would
 *     notice the file quietly coming back;
 *   - "removed" must be true. npm exits 0 when asked to uninstall a package it
 *     never installed, so the command checks that the file it is running from
 *     is actually gone before saying so;
 *   - skills are found from shipables' own record, in every project, not only
 *     the current directory — and a machine with no record spawns nothing.
 *
 * `execSync` and `execFile` are mocked because the alternative is a test that
 * uninstalls the developer's CLI. `@clack/prompts` is mocked because the real
 * one reads a TTY.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, envelope } from "../helpers.js";
import { UPDATE_CHECK_EXEMPT } from "../../src/program.js";
import { getConfigDir, getConfigPath, readConfig, writeConfig } from "../../src/lib/config.js";

/**
 * A config directory pinned before the imports above are evaluated, because
 * lib/config.ts resolves SENSO_CONFIG_DIR once at module load — before the
 * suite's `beforeEach` in tests/setup.ts gets to point it anywhere. The tests
 * below write a config file here and check whether the command removed it.
 */
vi.hoisted(() => {
  const tmp = (process.env.TMPDIR ?? process.env.TEMP ?? "/tmp").replace(/[/\\]+$/, "");
  process.env.SENSO_CONFIG_DIR = `${tmp}/senso-uninstall-test-${process.pid}`;
});

/** One shipables invocation, as the command asked for it. */
interface ChildCall {
  file: string;
  args: string[];
  options?: { cwd?: string };
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
      throw new Error("only the promisified form of execFile is used");
    },
    {
      [PROMISIFIED]: (file: string, args: string[], options?: { cwd?: string }) =>
        new Promise<{ stdout: string; stderr: string }>((resolve) => {
          state.calls.push({ file, args, options });
          resolve(state.run(file, args));
        }),
    },
  );

  return {
    state,
    execFile,
    execSync: vi.fn<(command: string, options?: unknown) => Buffer>(),
  };
});

vi.mock("node:child_process", () => ({
  execFile: child.execFile,
  execSync: child.execSync,
}));

const clack = vi.hoisted(() => ({
  CANCEL: Symbol("clack.cancel"),
  confirm: vi.fn<() => Promise<boolean | symbol>>(),
  cancel: vi.fn(),
}));

vi.mock("@clack/prompts", () => ({
  confirm: clack.confirm,
  cancel: clack.cancel,
  isCancel: (value: unknown) => value === clack.CANCEL,
}));

/** Every shipables invocation except the `--version` availability probe. */
function shipablesCalls(): ChildCall[] {
  return child.state.calls.filter(({ args }) => args[0] !== "--version");
}

/** What the CLI runs. The redirect is how npm's log is captured rather than
 *  inherited, so stdout stays one JSON document under --output json. */
const NPM_UNINSTALL_RUN = "npm uninstall -g @senso-ai/cli 2>&1";

/** What a person is told to type. The redirect is ours, not theirs. */
const NPM_UNINSTALL_BY_HAND = "npm uninstall -g @senso-ai/cli";

/** A home directory for shipables' record, fresh per test. */
let home: string;

function shipablesRecords(installations: Record<string, Record<string, unknown>>): void {
  mkdirSync(join(home, ".shipables"), { recursive: true });
  writeFileSync(
    join(home, ".shipables", "installed.json"),
    JSON.stringify({ version: 1, installations }, null, 2),
  );
}

/** A record for one skill, the shape shipables 0.1.x writes. */
function record(agents = ["claude"]): Record<string, unknown> {
  return { version: "1.0.0", agents, skill_dirs: {}, mcp_configs: {} };
}

/** A project directory that exists, so shipables can be run from it. */
function project(name: string): string {
  const dir = join(home, "projects", name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const originalHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
const originalArgv1 = process.argv[1] ?? "";
const originalIsTTY = process.stdin.isTTY;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "senso-uninstall-home-"));
  // `homedir()` reads these, on POSIX and on Windows respectively.
  process.env.HOME = home;
  process.env.USERPROFILE = home;

  // The file Node is "running from". After a successful `npm uninstall -g` it
  // would be gone, so it points at nothing — the test for the other case
  // points it at something.
  process.argv[1] = join(home, "not-a-real-binary");
  process.stdin.isTTY = false;

  child.state.calls = [];
  child.state.run = () => ({ stdout: "", stderr: "" });
  child.execSync.mockReset();
  child.execSync.mockReturnValue(Buffer.from(""));
  clack.confirm.mockReset();
  clack.cancel.mockReset();

  writeConfig({ apiKey: "tgr_stored", orgName: "Acme" });
});

afterEach(() => {
  process.env.HOME = originalHome.HOME;
  process.env.USERPROFILE = originalHome.USERPROFILE;
  process.argv[1] = originalArgv1;
  process.stdin.isTTY = originalIsTTY;
  rmSync(home, { recursive: true, force: true });
  rmSync(getConfigDir(), { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("uninstall, when nobody has confirmed", () => {
  it("exits 2 without a terminal and without --yes, and touches nothing", async () => {
    // The branch that matters most: an agent that runs this by mistake must
    // not lose the CLI. Nothing spawned, nothing deleted.
    shipablesRecords({ __global__: { "senso-ai/senso-search": record() } });

    const res = await runCli(["uninstall"]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("needs confirmation");
    expect(res.stderr).toContain("--yes");
    expect(shipablesCalls()).toEqual([]);
    expect(child.execSync).not.toHaveBeenCalled();
    expect(existsSync(getConfigPath())).toBe(true);
    expect(clack.confirm).not.toHaveBeenCalled();
  });

  it("says so as a JSON error with the usage code", async () => {
    const res = await runCli(["uninstall", "--output", "json"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    const err = JSON.parse(res.stderr.slice(res.stderr.indexOf("{"))) as {
      error: { code: string };
    };
    expect(err.error.code).toBe("usage");
  });

  it("asks in a terminal, and a 'no' removes nothing", async () => {
    process.stdin.isTTY = true;
    clack.confirm.mockResolvedValue(false);

    const res = await runCli(["uninstall"]);

    expect(res.exitCode).toBe(0);
    expect(clack.confirm).toHaveBeenCalledTimes(1);
    expect(clack.cancel).toHaveBeenCalledWith("Uninstall canceled. Nothing was removed.");
    expect(child.execSync).not.toHaveBeenCalled();
    expect(existsSync(getConfigPath())).toBe(true);
  });

  it("treats ctrl-c at the prompt as a 'no'", async () => {
    process.stdin.isTTY = true;
    clack.confirm.mockResolvedValue(clack.CANCEL);

    const res = await runCli(["uninstall"]);

    expect(res.exitCode).toBe(0);
    expect(child.execSync).not.toHaveBeenCalled();
    expect(existsSync(getConfigPath())).toBe(true);
  });

  it("does not ask when --yes is passed in a terminal", async () => {
    process.stdin.isTTY = true;

    const res = await runCli(["uninstall", "--yes"]);

    expect(res.exitCode).toBe(0);
    expect(clack.confirm).not.toHaveBeenCalled();
    expect(child.execSync).toHaveBeenCalledTimes(1);
  });
});

describe("uninstall, when a skill will not go", () => {
  it("exits 1 and leaves the credentials and the CLI in place", async () => {
    // The CLI is what the user retries with. Removing it after a failed skill
    // uninstall would leave them with a broken skill and no way to fix it.
    shipablesRecords({
      __global__: { "senso-ai/senso-search": record(), "senso-ai/senso-ingest": record() },
    });
    child.state.run = (_file, args) => {
      if (args[1] === "senso-ai/senso-ingest") throw new Error("shipables exploded");
      return { stdout: "", stderr: "" };
    };

    const res = await runCli(["uninstall", "--yes"]);

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("1 of 2 skill(s) could not be removed");
    expect(res.stderr).toContain("Failed: ingest");
    expect(res.stderr).toContain("--keep-skills");
    expect(child.execSync).not.toHaveBeenCalled();
    expect(existsSync(getConfigPath())).toBe(true);
    expect(res.stdout).toBe("");
  });

  it("still tries every other skill first, since they are independent", async () => {
    shipablesRecords({
      __global__: { "senso-ai/senso-search": record(), "senso-ai/senso-ingest": record() },
    });
    child.state.run = (_file, args) => {
      if (args[1] === "senso-ai/senso-search") throw new Error("no");
      return { stdout: "", stderr: "" };
    };

    await runCli(["uninstall", "--yes"]);

    expect(shipablesCalls().map((c) => c.args[1])).toEqual([
      "senso-ai/senso-search",
      "senso-ai/senso-ingest",
    ]);
  });
});

describe("uninstall, when npm will not go", () => {
  it("exits 1 and says how to finish by hand", async () => {
    child.execSync.mockImplementation(() => {
      throw new Error("EACCES");
    });

    const res = await runCli(["uninstall", "--yes"]);

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("Removing the CLI failed");
    expect(res.stderr).toContain(NPM_UNINSTALL_BY_HAND);
    // The earlier steps had already happened, and the message says so.
    expect(res.stderr).toContain("Skills and credentials were removed");
    expect(existsSync(getConfigPath())).toBe(false);
  });

  it("exits 1 when npm succeeded but this copy of the CLI is still there", async () => {
    // `npm uninstall -g` exits 0 for a package it never installed. If the file
    // Node is running from survives, the CLI came from somewhere else and
    // "removed" would be a lie.
    const binary = join(home, "checkout", "dist", "cli.js");
    mkdirSync(join(home, "checkout", "dist"), { recursive: true });
    writeFileSync(binary, "");
    process.argv[1] = binary;

    const res = await runCli(["uninstall", "--yes"]);

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("was not installed globally with npm");
    expect(res.stderr).toContain(binary);
    expect(res.stdout).toBe("");
  });
});

describe("uninstall --dry-run", () => {
  it("reports the plan and removes nothing, without confirmation", async () => {
    shipablesRecords({
      __global__: { "senso-ai/senso-search": record() },
      [project("app")]: { "senso-ai/senso-ingest": record() },
    });

    const res = await runCli(["uninstall", "--dry-run"]);

    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain("Dry run: nothing was removed.");
    expect(res.stderr).toContain("skill search (global)");
    expect(res.stderr).toContain("skill ingest (in ");
    expect(res.stderr).toContain(getConfigPath());
    expect(shipablesCalls()).toEqual([]);
    expect(child.execSync).not.toHaveBeenCalled();
    expect(existsSync(getConfigPath())).toBe(true);
    expect(res.stdout).toBe("");
  });

  it("gives a JSON caller the plan as a payload", async () => {
    shipablesRecords({ __global__: { "senso-ai/senso-search": record() } });

    const res = await runCli(["uninstall", "--dry-run", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toMatchObject({
      action: "planned",
      resource: "installation",
      dryRun: true,
      skills: [{ name: "search", package: "senso-ai/senso-search", scope: "global" }],
      config: { path: getConfigPath(), present: true, apiKeyInEnvironment: false },
      cli: { package: "@senso-ai/cli" },
    });
    expect(res.stderr).toBe("");
  });
});

describe("uninstall, in full", () => {
  it("removes every Senso skill shipables recorded, from the scope it was installed in", async () => {
    // Global, and two different projects. `shipables list` would see only one
    // of these from here; the record sees all of them.
    const app = project("app");
    const site = project("site");
    shipablesRecords({
      __global__: { "senso-ai/senso-search": record() },
      [app]: { "senso-ai/senso-ingest": record(), "someone-else/their-skill": record() },
      [site]: { "senso-ai/senso-onboarding": record() },
    });

    const res = await runCli(["uninstall", "--yes"]);

    expect(res.exitCode).toBe(0);
    expect(
      shipablesCalls().map((c) => ({ file: c.file, args: c.args, cwd: c.options?.cwd })),
    ).toEqual([
      {
        file: "shipables",
        args: ["uninstall", "senso-ai/senso-search", "--global"],
        cwd: undefined,
      },
      { file: "shipables", args: ["uninstall", "senso-ai/senso-ingest"], cwd: app },
      { file: "shipables", args: ["uninstall", "senso-ai/senso-onboarding"], cwd: site },
    ]);
  });

  it("does not spawn shipables at all when it has no record of a skill", async () => {
    // Most machines. Downloading shipables through npx to learn there is
    // nothing to remove is a minute of the user's time for no reason.
    const res = await runCli(["uninstall", "--yes"]);

    expect(res.exitCode).toBe(0);
    expect(child.state.calls).toEqual([]);
  });

  it("skips a project whose directory no longer exists, and says so", async () => {
    const gone = join(home, "projects", "deleted-long-ago");
    shipablesRecords({ [gone]: { "senso-ai/senso-ingest": record() } });

    const res = await runCli(["uninstall", "--yes", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(shipablesCalls()).toEqual([]);
    expect(res.data()).toMatchObject({
      skills: {
        removed: [],
        skipped: [
          {
            name: "ingest",
            scope: gone,
            reason: "project directory no longer exists",
          },
        ],
      },
    });
  });

  it("removes the config file and its directory", async () => {
    const res = await runCli(["uninstall", "--yes"]);

    expect(res.exitCode).toBe(0);
    expect(existsSync(getConfigPath())).toBe(false);
    expect(existsSync(getConfigDir())).toBe(false);
    expect(readConfig()).toEqual({});
  });

  it("leaves the config directory alone when something else is in it", async () => {
    // SENSO_CONFIG_DIR can be anywhere. Never recursive.
    writeFileSync(join(getConfigDir(), "notes.txt"), "mine");

    const res = await runCli(["uninstall", "--yes"]);

    expect(res.exitCode).toBe(0);
    expect(existsSync(getConfigPath())).toBe(false);
    expect(existsSync(join(getConfigDir(), "notes.txt"))).toBe(true);
  });

  it("runs the global npm uninstall for the published package, last", async () => {
    shipablesRecords({ __global__: { "senso-ai/senso-search": record() } });
    let configWasGoneAtNpm = false;
    let skillsWereGoneAtNpm = false;
    child.execSync.mockImplementation(() => {
      configWasGoneAtNpm = !existsSync(getConfigPath());
      skillsWereGoneAtNpm = shipablesCalls().length === 1;
      return Buffer.from("");
    });

    await runCli(["uninstall", "--yes"]);

    expect(child.execSync).toHaveBeenCalledTimes(1);
    expect(child.execSync.mock.calls[0]?.[0]).toBe(NPM_UNINSTALL_RUN);
    expect(child.execSync.mock.calls[0]?.[1]).toMatchObject({ stdio: ["ignore", "pipe", "pipe"] });
    expect(configWasGoneAtNpm).toBe(true);
    expect(skillsWereGoneAtNpm).toBe(true);
  });

  it("puts the confirmation on stderr and leaves stdout empty", async () => {
    const res = await runCli(["uninstall", "--yes"]);

    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Senso CLI removed.");
    expect(res.stderr).toContain("npm install -g @senso-ai/cli");
  });

  it("gives a JSON caller the full outcome and nothing on stderr", async () => {
    shipablesRecords({ __global__: { "senso-ai/senso-search": record() } });

    const res = await runCli(["uninstall", "--yes", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(res.data()).toMatchObject({
      action: "removed",
      resource: "installation",
      skills: {
        removed: [{ name: "search", package: "senso-ai/senso-search", scope: "global" }],
        skipped: [],
      },
      config: { removed: true, path: getConfigPath(), apiKeyInEnvironment: false },
      cli: { removed: true, package: "@senso-ai/cli" },
    });
    expect(res.stderr).toBe("");
  });

  it("warns that SENSO_API_KEY in the environment is out of its reach", async () => {
    // The stored key is gone; the one in the shell profile is not something a
    // process can remove, and silence here would leave the user believing it
    // was.
    process.env.SENSO_API_KEY = "tgr_from_env";

    const res = await runCli(["uninstall", "--yes", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    // Under --output json stderr is silent, so the notice travels in the
    // envelope. A warning written only to stderr would reach nobody here.
    const env = envelope<{ config: { apiKeyInEnvironment: boolean } }>(res);
    expect(env.warnings?.join(" ")).toContain("SENSO_API_KEY");
    expect(env.data).toMatchObject({ config: { apiKeyInEnvironment: true } });
  });
});

describe("uninstall --keep-skills and --keep-config", () => {
  it("--keep-skills spawns nothing even when skills are recorded", async () => {
    shipablesRecords({ __global__: { "senso-ai/senso-search": record() } });

    const res = await runCli(["uninstall", "--yes", "--keep-skills", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(child.state.calls).toEqual([]);
    expect(res.data()).toMatchObject({ skills: { removed: [] }, cli: { removed: true } });
  });

  it("--keep-config leaves the stored key where it is", async () => {
    const res = await runCli(["uninstall", "--yes", "--keep-config", "--output", "json"]);

    expect(res.exitCode).toBe(0);
    expect(existsSync(getConfigPath())).toBe(true);
    expect(readConfig().apiKey).toBe("tgr_stored");
    expect(res.data()).toMatchObject({ config: { removed: false }, cli: { removed: true } });
  });
});

describe("uninstall and the update check", () => {
  it("is exempt, so the check cannot write the config file back after it was removed", () => {
    // The check is fired without being awaited and writes lastUpdateCheck
    // when it returns — which, for this command, is after the file was
    // deleted. The exemption is the only thing standing between "removed" and
    // a config file that is quietly back.
    expect(UPDATE_CHECK_EXEMPT.has("uninstall")).toBe(true);
  });
});
