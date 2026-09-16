/**
 * The CLI's contract, asserted against the process a user actually runs.
 *
 * Every claim below is also made somewhere in the unit suite, and the unit
 * suite cannot prove any of them. It imports `createProgram()` and reads
 * `process.exitCode` out of its own process; it never loads `dist/cli.js`, so
 * a bundle that fails to start, loses its shebang, writes the banner to the
 * wrong stream, or sets an exit code that something later overwrites is still
 * green there. These tests spawn the bundle and read what the kernel and the
 * two pipes report, which is the same thing a shell, a Dockerfile healthcheck
 * and an agent see.
 *
 * The three properties worth stating plainly, because they are what callers
 * depend on and what regress silently:
 *
 *   stdout is the payload, and carries nothing else — no banner, no tick, no
 *   progress. `--output json | jq` has to work without `--quiet`.
 *
 *   the exit code says what happened. 0/2/3/4/5 are branched on by scripts, so
 *   each is proven end to end here rather than inferred from a mapping table.
 *
 *   `--version` is offline and free of side effects. It makes no request and
 *   creates no configuration, which is what makes it usable as a healthcheck.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ANSI_ESCAPE,
  CLI_PATH,
  REPO_ROOT,
  TEST_API_KEY,
  closedPortUrl,
  runSenso,
  startMockApi,
  type MockApi,
} from "./helpers.js";

const PKG_VERSION = (
  JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { version: string }
).version;

const ROLES = {
  roles: [
    { role_id: "r-admin", name: "admin", description: "Full access" },
    { role_id: "r-view", name: "viewer", description: "Read only" },
  ],
};

const BALANCE = { balance: 4200, spend_limit: 10000, currency: "credits" };

const TAGS = { tags: [{ tag_id: "t-1", name: "onboarding" }] };

let api: MockApi;

beforeAll(async () => {
  api = await startMockApi();
});

afterAll(async () => {
  await api.close();
});

beforeEach(() => {
  // Per-test, for the same reason MSW handlers are reset per-test in the unit
  // suite: a queued response that outlives its test makes the next one pass for
  // a reason its author never wrote down.
  api.reset();
});

describe("`senso --version`", () => {
  it("prints exactly the version in package.json, and nothing else, on stdout", async () => {
    const res = await runSenso(["--version"], { baseUrl: api.url });

    // Exactly, not `toContain`: a shell script assigning this to a variable
    // gets the string it compares against, with no banner line above it.
    expect(res.stdout).toBe(`${PKG_VERSION}\n`);
    expect(res.code).toBe(0);
  });

  it("writes nothing at all to stderr", async () => {
    const res = await runSenso(["--version"], { baseUrl: api.url });

    // The banner is a stderr diagnostic everywhere else. `--version` predates
    // any command dispatch, so nothing should decorate it — and a healthcheck
    // that logs a banner on every probe fills a container's logs with noise.
    expect(res.stderr).toBe("");
  });

  it("makes no HTTP request and creates no config directory, so it can serve as a healthcheck", async () => {
    const res = await runSenso(["--version"], { baseUrl: api.url });

    expect(api.requests).toEqual([]);
    // The config directory path handed to the child does not exist when the
    // process starts. Anything that reads a key, caches an update check or
    // writes a timestamp would create it.
    expect(existsSync(res.configDir)).toBe(false);
  });
});

describe("`senso --help`", () => {
  it("exits 0 and renders the exit-code table that a caller branches on", async () => {
    const res = await runSenso(["--help"]);

    expect(res.code).toBe(0);
    expect(res.stdout).toContain("Exit codes:");
    // Spelled out one by one. This table is the public interface described in
    // src/lib/errors.ts, and `--help` is where an agent reads it.
    expect(res.stdout).toContain("0  success");
    expect(res.stdout).toContain("2  usage error");
    expect(res.stdout).toContain("3  authentication");
    expect(res.stdout).toContain("4  not found");
    expect(res.stdout).toContain("5  network failure or timeout");
  });

  it("lists every environment variable the CLI reads", async () => {
    const res = await runSenso(["--help"]);

    expect(res.stdout).toContain("SENSO_API_KEY");
    expect(res.stdout).toContain("SENSO_BASE_URL");
    expect(res.stdout).toContain("SENSO_CONFIG_DIR");
    expect(res.stdout).toContain("SENSO_DEBUG");
    expect(res.stdout).toContain("SENSO_NO_UPDATE_CHECK");
    expect(res.stdout).toContain("SENSO_GAP_SIGNALS");
    expect(res.stdout).toContain("NO_COLOR");
  });
});

describe("`senso` with no arguments", () => {
  it("says it needs a subcommand and lists them, in one line each", async () => {
    const res = await runSenso([]);

    // Commander's own answer is to dump the entire help to stderr. For a person
    // that is fine; for an agent it is a screenful to parse before learning the
    // one fact it needed, which is the list of names. Exit 2 is consistent with
    // the rest of the table — the caller did not name anything to run — and
    // stdout stays empty so a pipe gets nothing rather than help text.
    expect(res.code).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("needs a subcommand");
    expect(res.stderr).toContain("kb");
    expect(res.stderr).toContain("senso --help");
  });

  it("answers in JSON when the caller asked for JSON", async () => {
    // The README promised "errors are JSON too" and this whole class of usage
    // failure ignored it, printing English whatever --output said.
    const res = await runSenso(["--output", "json"]);

    expect(res.code).toBe(2);
    expect(res.stdout).toBe("");
    const parsed = JSON.parse(res.stderr) as {
      ok: boolean;
      error: { code: string; allowed: string[] };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("usage");
    expect(parsed.error.allowed).toContain("kb");
  });

  it("names a group's subcommands rather than dumping its help", async () => {
    const res = await runSenso(["kb", "--output", "json"]);

    expect(res.code).toBe(2);
    const parsed = JSON.parse(res.stderr) as {
      command: string;
      error: { message: string; allowed: string[] };
    };
    expect(parsed.command).toBe("kb");
    expect(parsed.error.message).toContain("`senso kb` needs a subcommand");
    expect(parsed.error.allowed).toContain("my-files");
  });
});

describe("a command line the CLI does not understand", () => {
  it("exits 2 on an unknown command, with the complaint on stderr and stdout empty", async () => {
    const res = await runSenso(["definitely-not-a-command"]);

    expect(res.code).toBe(2);
    expect(res.stderr).toContain("unknown command");
    expect(res.stderr).toContain("definitely-not-a-command");
    expect(res.stdout).toBe("");
  });

  it("exits 2 on an unknown flag", async () => {
    const res = await runSenso(["roles", "list", "--not-a-flag"]);

    expect(res.code).toBe(2);
    expect(res.stderr).toContain("unknown option");
    expect(res.stdout).toBe("");
  });

  it("exits 2 on an --output format that does not exist, and says which are valid", async () => {
    const res = await runSenso(["roles", "list", "--output", "yaml"], {
      apiKey: TEST_API_KEY,
      baseUrl: api.url,
    });

    expect(res.code).toBe(2);
    expect(res.stderr).toContain("json, table, plain");
    // Rejected before anything went on the wire.
    expect(api.requests).toEqual([]);
  });
});

describe("a command run with no credential", () => {
  it("exits 3 and names SENSO_API_KEY, so the reader learns the fix from the message", async () => {
    const res = await runSenso(["roles", "list"], { baseUrl: api.url });

    expect(res.code).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("no API key found");
    expect(res.stderr).toContain("SENSO_API_KEY");
    // No credential means no request: the CLI must not send an unauthenticated
    // call and let the server decide.
    expect(api.requests).toEqual([]);
  });
});

describe("`--output json` on a successful command", () => {
  it("prints the `roles list` payload as parseable JSON, with an empty stderr", async () => {
    api.respondWith("/org/roles", { body: ROLES });

    const res = await runSenso(["roles", "list", "--output", "json"], {
      apiKey: TEST_API_KEY,
      baseUrl: api.url,
    });

    expect(res.code).toBe(0);
    expect(res.data()).toEqual(ROLES);
    expect(res.stderr).toBe("");
  });

  it("prints the `credits balance` payload as parseable JSON, with an empty stderr", async () => {
    api.respondWith("/org/credits/balance", { body: BALANCE });

    const res = await runSenso(["credits", "balance", "--output", "json"], {
      apiKey: TEST_API_KEY,
      baseUrl: api.url,
    });

    expect(res.code).toBe(0);
    expect(res.data()).toEqual(BALANCE);
    expect(res.stderr).toBe("");
  });

  it("prints the `tags list` payload as parseable JSON, with an empty stderr", async () => {
    api.respondWith("/org/tags", { body: TAGS });

    const res = await runSenso(["tags", "list", "--output", "json"], {
      apiKey: TEST_API_KEY,
      baseUrl: api.url,
    });

    expect(res.code).toBe(0);
    expect(res.data()).toEqual(TAGS);
    expect(res.stderr).toBe("");
  });

  it("treats the `--output=json` form identically to the spaced one", async () => {
    api.respondWith("/org/roles", { body: ROLES });

    const res = await runSenso(["roles", "list", "--output=json"], {
      apiKey: TEST_API_KEY,
      baseUrl: api.url,
    });

    // Worth its own test: the equals form used to be missed by a hand-rolled
    // argv scan, so `--output=json` printed a decorated table and a pipeline
    // that had worked in one shell broke in another.
    expect(res.code).toBe(0);
    expect(res.data()).toEqual(ROLES);
    expect(res.stderr).toBe("");
  });
});

describe("`--output json` on a failing command", () => {
  it("leaves stdout empty and writes an error object carrying a code to stderr", async () => {
    api.respondWith("/org/roles", { status: 403, body: { error: "insufficient scope" } });

    const res = await runSenso(["roles", "list", "--output", "json"], {
      apiKey: TEST_API_KEY,
      baseUrl: api.url,
    });

    expect(res.code).toBe(3);
    // The half that matters: `senso ... --output json > out.json` leaves an
    // empty file, not a file holding an error object that a later read would
    // mistake for data.
    expect(res.stdout).toBe("");

    const reported: unknown = JSON.parse(res.stderr);
    expect(reported).toMatchObject({ error: { code: "forbidden", status: 403 } });
  });
});

describe("the exit-code table, end to end", () => {
  it("exits 0 when the command succeeds", async () => {
    api.respondWith("/org/roles", { body: ROLES });

    const res = await runSenso(["roles", "list"], { apiKey: TEST_API_KEY, baseUrl: api.url });

    expect(res.code).toBe(0);
  });

  it("exits 2 when the command line is wrong", async () => {
    const res = await runSenso(["roles", "nope"], { apiKey: TEST_API_KEY, baseUrl: api.url });

    expect(res.code).toBe(2);
  });

  it("exits 3 when the API rejects the key", async () => {
    api.respondWith("/org/roles", { status: 401, body: { error: "invalid key" } });

    const res = await runSenso(["roles", "list"], { apiKey: TEST_API_KEY, baseUrl: api.url });

    expect(res.code).toBe(3);
    expect(res.stderr).toContain("Authentication failed");
  });

  it("exits 4 when the API returns 404", async () => {
    api.respondWith("/org/roles", { status: 404, body: { error: "no such org" } });

    const res = await runSenso(["roles", "list"], { apiKey: TEST_API_KEY, baseUrl: api.url });

    expect(res.code).toBe(4);
    expect(res.stderr).toContain("Not found");
  });

  it("exits 5 when nothing is listening at the base URL", async () => {
    // A port that had a listener a moment ago, so the connection is refused
    // immediately rather than left to a firewall's timeout.
    const dead = await closedPortUrl();

    const res = await runSenso(["roles", "list", "--base-url", dead], {
      apiKey: TEST_API_KEY,
      baseUrl: api.url,
    });

    expect(res.code).toBe(5);
    expect(res.stderr).toContain("Could not reach");
    // The flag beat the environment variable, which is the precedence the
    // failure itself proves: the mock never saw the request.
    expect(api.requests).toEqual([]);
  });
});

describe("what reaches which stream", () => {
  it("keeps the banner off stdout, and puts it on stderr, in the default format", async () => {
    api.respondWith("/org/roles", { body: ROLES });

    const res = await runSenso(["roles", "list"], { apiKey: TEST_API_KEY, baseUrl: api.url });

    expect(res.stdout).not.toContain("Senso CLI");
    expect(res.stdout).toContain("admin");
    expect(res.stderr).toContain("Senso CLI");
  });

  it("keeps the banner off stdout under --output table and --output json as well", async () => {
    for (const format of ["table", "json"]) {
      api.reset();
      api.respondWith("/org/roles", { body: ROLES });

      const res = await runSenso(["roles", "list", "--output", format], {
        apiKey: TEST_API_KEY,
        baseUrl: api.url,
      });

      expect(res.stdout).not.toContain("Senso CLI");
      expect(res.stdout).toContain("admin");
    }
  });

  it("suppresses the banner under --quiet while leaving the payload intact", async () => {
    api.respondWith("/org/roles", { body: ROLES });

    const res = await runSenso(["roles", "list", "--quiet"], {
      apiKey: TEST_API_KEY,
      baseUrl: api.url,
    });

    expect(res.code).toBe(0);
    expect(res.stderr).not.toContain("Senso CLI");
    // --quiet removes decoration, never data. A caller reaching for it because
    // a banner was in the way must not lose the answer with it.
    expect(res.stdout).toContain("r-admin");
    expect(res.stdout).toContain("Full access");
  });
});

describe("color, when the output is not a terminal", () => {
  it("emits no ANSI escape sequence on either stream when NO_COLOR is set", async () => {
    api.respondWith("/org/roles", { body: ROLES });

    // The default for every run in this suite, asserted here rather than
    // assumed: the plain renderer bolds keys and the banner is a gradient, so
    // both streams would carry escapes if NO_COLOR were being ignored.
    const res = await runSenso(["roles", "list"], { apiKey: TEST_API_KEY, baseUrl: api.url });

    expect(ANSI_ESCAPE.test(res.stdout)).toBe(false);
    expect(ANSI_ESCAPE.test(res.stderr)).toBe(false);
  });

  // Not asserted: that a piped stdout is clean when NO_COLOR is absent.
  //
  // picocolors enables color when `CI` is present in the environment, whatever
  // stdout is attached to — so the same command is clean on a developer's
  // machine and colored in GitHub Actions. Asserting it would produce a test
  // that fails only in CI, which teaches people to distrust the suite. Callers
  // who need the guarantee have NO_COLOR, which is honored unconditionally.
});

describe("the built bundle itself", () => {
  it("starts with a shebang, so npm's bin link executes it as a program", () => {
    // Not observable from the unit suite at all: it imports TypeScript source,
    // where the shebang is added by tsup's banner at build time. A tsup config
    // change that drops it would ship a package whose `senso` command fails
    // with a syntax error on the first import statement.
    const head = readFileSync(CLI_PATH, "utf8").slice(0, 32);
    expect(head.startsWith("#!/usr/bin/env node")).toBe(true);

    // And on a POSIX system it survived as a file the shell may run, not merely
    // as text. Windows has no execute permission bit — NTFS decides by file
    // extension and npm installs a .cmd shim rather than relying on the mode —
    // so `mode & 0o111` is always 0 there and asserting it would fail for a
    // reason that says nothing about the package.
    if (process.platform !== "win32") {
      const mode = statSync(CLI_PATH).mode;
      expect(mode & 0o111).not.toBe(0);
    }
  });

  it("sends the key as X-API-Key and identifies itself, over a real socket", async () => {
    api.respondWith("/org/roles", { body: ROLES });

    await runSenso(["roles", "list"], { apiKey: TEST_API_KEY, baseUrl: api.url });

    const [seen] = api.requests;
    expect(seen?.headers["x-api-key"]).toBe(TEST_API_KEY);
    expect(seen?.headers["user-agent"]).toMatch(/^senso-cli\//);
    // The base URL's path prefix is in front of the command's path: a bug in
    // that join sends every request to the wrong place, and only a real server
    // sees which URL was actually requested.
    expect(seen?.rawPath).toBe("/api/v1/org/roles");
  });
});
