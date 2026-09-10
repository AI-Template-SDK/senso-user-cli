/**
 * Proves the published CLI runs on a Node version the test runner cannot.
 *
 * `package.json` promises `node >= 18`. The end-to-end suite is built on vitest,
 * which requires Node 22 or newer — so the suite physically cannot execute on
 * the floor of what we support, and a matrix that tried failed on every Node 18
 * runner. Testing the floor with a tool that does not run there is not testing
 * the floor.
 *
 * So this: plain ESM, no dependencies, no TypeScript, no test runner. It runs on
 * anything from Node 18 up, and it checks the contract a user actually depends
 * on — that the installed binary starts, reports its version, renders help, and
 * fails correctly without a credential.
 *
 * It is deliberately given a PACKED TARBALL rather than the working tree, and
 * the tarball is built on a modern Node in an earlier step. That mirrors how the
 * package reaches a user: built once by us, installed and run on whatever they
 * have.
 *
 *   node scripts/compat-check.mjs <path-to-tarball>
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tarball = process.argv[2];
if (!tarball || !existsSync(tarball)) {
  console.error(
    `Usage: node scripts/compat-check.mjs <path-to-tarball>\nGot: ${tarball ?? "(nothing)"}`,
  );
  process.exit(2);
}

const expectedVersion = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

let failures = 0;
const pass = (msg) => {
  console.log(`  ok   ${msg}`);
};
const fail = (msg) => {
  console.error(`  FAIL ${msg}`);
  failures += 1;
};

const work = mkdtempSync(join(tmpdir(), "senso-compat-"));
const home = join(work, "home");
const configDir = join(home, "config");

/**
 * Run the installed binary and capture everything about the attempt.
 *
 * `execFileSync` throws on a non-zero exit, which is the normal case for half of
 * these checks, so the status and both streams are read off the error rather
 * than treated as an exception.
 */
function run(binary, args) {
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: configDir,
    SENSO_CONFIG_DIR: join(configDir, "senso"),
    SENSO_NO_UPDATE_CHECK: "1",
    NO_COLOR: "1",
  };
  // Never inherit a real credential from the runner's environment.
  delete env.SENSO_API_KEY;
  delete env.SENSO_BASE_URL;

  try {
    const stdout = execFileSync(process.execPath, [binary, ...args], {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    return {
      code: typeof err.status === "number" ? err.status : 1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
    };
  }
}

try {
  console.log(`==> Node ${process.version} on ${process.platform}`);
  console.log(`==> installing ${tarball}`);

  const prefix = join(work, "prefix");
  execFileSync("npm", ["install", "--silent", "--prefix", prefix, tarball], {
    stdio: "pipe",
    shell: process.platform === "win32",
  });

  // The path inside node_modules, run directly rather than through the bin
  // shim: the shim differs per platform (a symlink on POSIX, a .cmd on Windows)
  // and what is under test here is the bundle, not npm's linking.
  const installed = join(prefix, "node_modules", "@senso-ai", "cli", "dist", "cli.js");
  if (!existsSync(installed)) {
    fail(`the installed package has no dist/cli.js at ${installed}`);
    throw new Error("nothing to test");
  }
  pass("the tarball installs and ships dist/cli.js");

  // --- the bundle starts and reports itself ---------------------------------
  const version = run(installed, ["--version"]);
  // trim(), not an exact compare: Windows ends the line with \r\n.
  if (version.code === 0 && version.stdout.trim() === expectedVersion) {
    pass(`--version reports ${expectedVersion}`);
  } else {
    fail(
      `--version printed ${JSON.stringify(version.stdout)} exit ${version.code} (want ${expectedVersion})`,
    );
  }

  if (version.stderr.trim() === "") {
    pass("--version writes nothing to stderr");
  } else {
    fail(`--version wrote to stderr: ${version.stderr.trim()}`);
  }

  // A healthcheck must not have side effects.
  if (!existsSync(join(configDir, "senso"))) {
    pass("--version creates no config directory");
  } else {
    fail("--version created a config directory");
  }

  const help = run(installed, ["--help"]);
  if (help.code === 0 && help.stdout.includes("Infrastructure for the Agentic Web")) {
    pass("--help renders and exits 0");
  } else {
    fail(`--help exited ${help.code}`);
  }

  // --- the failure contract -------------------------------------------------
  const noKey = run(installed, ["whoami", "--output", "json"]);
  if (noKey.code === 3) {
    pass("an unauthenticated command exits 3");
  } else {
    fail(`an unauthenticated command exited ${noKey.code}, want 3`);
  }
  if (noKey.stdout === "") {
    pass("stdout is empty on failure");
  } else {
    fail(`stdout was not empty on failure: ${JSON.stringify(noKey.stdout)}`);
  }
  if (noKey.stderr.includes("SENSO_API_KEY")) {
    pass("the error names the environment variable to set");
  } else {
    fail(`the error did not explain how to authenticate: ${noKey.stderr.trim()}`);
  }

  const badFlag = run(installed, ["--nonsense"]);
  if (badFlag.code === 2) {
    pass("a usage error exits 2");
  } else {
    fail(`a usage error exited ${badFlag.code}, want 2`);
  }
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log("");
if (failures === 0) {
  console.log(`==> compat: OK on Node ${process.version} / ${process.platform}`);
} else {
  console.error(
    `==> compat: ${failures} failure(s) on Node ${process.version} / ${process.platform}`,
  );
}
process.exit(failures === 0 ? 0 : 1);
