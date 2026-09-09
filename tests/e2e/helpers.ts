/**
 * The harness for the only layer that runs the shipped artifact.
 *
 * Everything else in this repository tests `src/`. The unit and command suites
 * import `createProgram()`, drive it in-process, spy on `console`, and read
 * `process.exitCode` — which is fast and precise, and which structurally cannot
 * observe four things that a user hits first:
 *
 *   1. Whether `dist/cli.js` runs at all. tsup could emit a bundle that
 *      references something outside dist/, or fail to inline a dependency, and
 *      every in-process test would still pass.
 *   2. Whether the shebang survived, and whether the file is executable.
 *   3. The real exit code. `process.exitCode` is a number a test reads out of
 *      its own process; the number a shell branches on is what the kernel
 *      reports after Node has drained its event loop, and the two differ if
 *      anything later overwrites it or the process dies another way.
 *   4. Whether the process exits at all. A pending timer, an un-awaited fetch
 *      or a prompt waiting on a keypress makes a command hang forever — the
 *      failure mode that is invisible in-process because the test runner owns
 *      the event loop and just moves on.
 *
 * So this file spawns the built bundle as a real child process and talks to it
 * only through the interface a caller has: argv in, stdout/stderr/exit code out.
 *
 * The mock API is a plain `node:http` server rather than MSW for the same
 * reason. MSW patches `fetch` inside the current process; the CLI under test
 * runs in a different one, where nothing is patched. A real socket on a real
 * port is the only thing both processes can agree on.
 */

import { spawn } from "node:child_process";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The artifact under test. Not `src/` — that is the unit suite's job. */
export const CLI_PATH = join(HERE, "..", "..", "dist", "cli.js");

/** The repository root, for reading package.json in an assertion. */
export const REPO_ROOT = join(HERE, "..", "..");

/** The key the suite authenticates with. Not a real key shape by accident. */
export const TEST_API_KEY = "tgr_e2e_key_for_the_suite";

/**
 * The path prefix a real Senso base URL carries.
 *
 * The mock is served behind it so that a bug in how `api-client.ts` joins the
 * base URL to a command's path shows up here rather than in a user's terminal.
 * Recorded requests report the path with it stripped, so a test asserts on
 * `/org/roles` — what the command asked for — and `rawPath` when the prefix
 * itself is the thing under test.
 */
const API_PREFIX = "/api/v1";

/**
 * A base URL nothing listens on.
 *
 * The default for every run, so that a test which forgets to point at the mock
 * fails with a connection error instead of quietly reaching a real Senso API
 * with whatever happens to be in the environment. Same reasoning as the
 * `onUnhandledRequest: 'error'` ban in tests/setup.ts, one layer down.
 */
export const UNREACHABLE_BASE_URL = "http://127.0.0.1:1/api/v1";

/**
 * Any ANSI escape sequence.
 *
 * Written out rather than matching only color codes: cursor moves and line
 * erases from a spinner are just as unwelcome in a piped stream.
 */
// eslint-disable-next-line no-control-regex -- matching an escape sequence requires the escape character
export const ANSI_ESCAPE = /\u001B\[[0-9;]*[A-Za-z]/;

// ── The mock API ─────────────────────────────────────────────────────────────

/** One request the CLI made, as the server saw it. */
export interface RecordedRequest {
  method: string;
  /** Pathname with `API_PREFIX` removed: the path the command asked for. */
  path: string;
  /** Pathname exactly as it arrived, prefix included. */
  rawPath: string;
  /** The query string, already parsed. */
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  /** The raw request body. Empty string when there was none. */
  body: string;
}

/** What the mock should reply with. */
export interface MockResponse {
  /** Defaults to 200. */
  status?: number;
  /**
   * An object or array is sent as JSON; a string is sent verbatim, which is how
   * a test reproduces a proxy returning HTML. Omit it for a bodiless 204.
   */
  body?: unknown;
  headers?: Record<string, string>;
}

export interface MockApi {
  /** Point `SENSO_BASE_URL` or `--base-url` here. */
  url: string;
  /** Every request the CLI made, in order. */
  requests: RecordedRequest[];
  /**
   * Queue a response for a path.
   *
   * Called once, the response is reused for every request to that path. Called
   * several times for the same path, the responses are handed out in order and
   * the last one sticks — which is how a test scripts a retry or a paginated
   * sequence without counting requests.
   */
  respondWith: (path: string, response: MockResponse) => void;
  /** Forget every recorded request and every queued response. */
  reset: () => void;
  close: () => Promise<void>;
}

export async function startMockApi(): Promise<MockApi> {
  const requests: RecordedRequest[] = [];
  const queued = new Map<string, MockResponse[]>();

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      // The base is a placeholder: only the path and query are read from it.
      const url = new URL(req.url ?? "/", "http://mock.invalid");
      const rawPath = url.pathname;
      const path = rawPath.startsWith(API_PREFIX)
        ? rawPath.slice(API_PREFIX.length) || "/"
        : rawPath;

      requests.push({
        method: req.method ?? "GET",
        path,
        rawPath,
        query: url.searchParams,
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });

      const queue = queued.get(path);
      const next = queue && queue.length > 1 ? queue.shift() : queue?.[0];

      if (!next) {
        // 501 rather than 404: a test asserting on the 404 path would otherwise
        // pass because it forgot to queue anything, which is the most expensive
        // kind of green. 501 maps to a generic failure and the body says why.
        res.writeHead(501, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: `No mock response queued for ${req.method ?? "GET"} ${path}. Call respondWith() first.`,
          }),
        );
        return;
      }

      const status = next.status ?? 200;
      if (next.body === undefined) {
        res.writeHead(status, next.headers);
        res.end();
        return;
      }

      const isText = typeof next.body === "string";
      res.writeHead(status, {
        "content-type": isText ? "text/plain" : "application/json",
        ...next.headers,
      });
      res.end(isText ? (next.body as string) : JSON.stringify(next.body));
    });
  });

  // Undici keeps sockets alive between requests. Each CLI invocation is its own
  // process and takes its socket with it, but a short idle timeout keeps a
  // half-open connection from delaying close() on a slow machine.
  server.keepAliveTimeout = 500;

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}${API_PREFIX}`,
    requests,
    respondWith(path, response) {
      const queue = queued.get(path);
      if (queue) queue.push(response);
      else queued.set(path, [response]);
    },
    reset() {
      requests.length = 0;
      queued.clear();
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
  };
}

/**
 * A URL whose port had a listener and no longer does.
 *
 * Reserved by binding and immediately releasing, rather than hard-coding a port
 * that might be in use, so `connect` is refused rather than left to time out.
 */
export async function closedPortUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  return `http://127.0.0.1:${port}${API_PREFIX}`;
}

// ── Running the built CLI ────────────────────────────────────────────────────

export interface RunOptions {
  /**
   * The API key to put in the child's `SENSO_API_KEY`.
   *
   * Omitted by default: most of what is worth testing here is the failure path,
   * and a credential that appears without a test asking for it is how a suite
   * ends up passing for the wrong reason.
   */
  apiKey?: string;
  /** `SENSO_BASE_URL` for the child. Defaults to `UNREACHABLE_BASE_URL`. */
  baseUrl?: string;
  /**
   * `SENSO_CONFIG_DIR` for the child. Defaults to a path inside a fresh temp
   * directory that does NOT yet exist, so a test can assert that a command
   * which should touch no configuration created nothing.
   */
  configDir?: string;
  /** Extra environment for the child. `undefined` removes a variable. */
  env?: Record<string, string | undefined>;
  /** Written to the child's stdin, which is then closed. */
  stdin?: string;
  /**
   * How long to wait before killing the child and failing.
   *
   * Below vitest's 30s file timeout on purpose: a command that hangs should
   * fail with a sentence naming the command, not with a timeout naming the
   * test. Lower it further for a test whose whole point is that something
   * returns promptly.
   */
  timeoutMs?: number;
}

export interface RunResult {
  /** The payload. Should carry nothing else — that is most of the contract. */
  stdout: string;
  /** Diagnostics, progress, banner, errors. */
  stderr: string;
  /** The real exit code, as the kernel reported it. */
  code: number;
  /** Set when the child was killed rather than exiting on its own. */
  signal: NodeJS.Signals | null;
  /** Where `SENSO_CONFIG_DIR` pointed. May not exist. */
  configDir: string;
  /** The config file inside it. May not exist. */
  configFile: string;
  /** stdout parsed as JSON. Throws with the raw text if it will not parse. */
  json: () => unknown;
}

const tempRoots: string[] = [];

/** A config directory path that does not exist yet, inside a fresh temp root. */
export function freshConfigDir(): string {
  const root = mkdtempSync(join(tmpdir(), "senso-e2e-"));
  tempRoots.push(root);
  return join(root, "config");
}

/**
 * Run the built CLI once and collect everything observable about it.
 *
 * Arguments are passed as a user would type them, without the `senso`:
 *
 *     const res = await runSenso(["roles", "list", "--output", "json"], {
 *       apiKey: TEST_API_KEY,
 *       baseUrl: api.url,
 *     });
 */
export async function runSenso(args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const configDir = opts.configDir ?? freshConfigDir();
  const timeoutMs = opts.timeoutMs ?? 20_000;

  // Built by overlaying on the parent environment and then dropping every
  // `undefined`, so a variable set here to undefined is genuinely absent from
  // the child rather than present with the string "undefined".
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries({
      ...process.env,

      // The developer's own credential, API host and config path must never
      // reach the child. A suite that inherits SENSO_API_KEY talks to a real
      // organization the moment someone forgets a --base-url, and this is the
      // only place that can stop it. A test that wants a key passes one.
      SENSO_API_KEY: opts.apiKey,
      SENSO_BASE_URL: opts.baseUrl ?? UNREACHABLE_BASE_URL,
      SENSO_CONFIG_DIR: configDir,
      SENSO_DEBUG: undefined,
      // The update check fires an un-awaited fetch to the npm registry, which
      // both reaches the network and keeps the event loop alive after the
      // output is written. Neither belongs in a test of the exit code.
      SENSO_NO_UPDATE_CHECK: "1",
      // Deterministic output. The tests that care about color override it.
      NO_COLOR: "1",

      ...opts.env,
    }).filter(([, value]) => value !== undefined),
  );

  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env,
      cwd: REPO_ROOT,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    // Closed immediately unless a test supplies input. stdin is a pipe rather
    // than a TTY for a spawned child either way, which is exactly the condition
    // `senso login` has to detect.
    if (opts.stdin !== undefined) child.stdin.write(opts.stdin);
    child.stdin.end();

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);

      if (timedOut) {
        reject(
          new Error(
            `\`senso ${args.join(" ")}\` did not exit within ${String(timeoutMs)}ms.\n` +
              `A command that hangs is a bug, not a slow test: something is keeping the ` +
              `event loop alive, or a prompt is waiting on input that a spawned child can ` +
              `never provide.\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
          ),
        );
        return;
      }

      resolve({
        stdout,
        stderr,
        // null only when a signal killed the child, which the timeout branch
        // above has already handled; -1 keeps the type honest for the rest.
        code: code ?? -1,
        signal,
        configDir,
        configFile: join(configDir, "config.json"),
        json: (): unknown => {
          try {
            return JSON.parse(stdout);
          } catch {
            throw new Error(`stdout was not valid JSON:\n${stdout || "(empty)"}`);
          }
        },
      });
    });
  });
}

// ── Preconditions and cleanup ────────────────────────────────────────────────

/**
 * Registered here rather than in each test file so that importing this harness
 * is enough to get the check. Vitest attaches the hook to whichever file is
 * being collected when this module is imported.
 */
beforeAll(() => {
  if (!existsSync(CLI_PATH)) {
    throw new Error(
      `The e2e suite runs the built bundle, and it is not there:\n  ${CLI_PATH}\n\n` +
        `Run \`npm run build\` first, or use \`make e2e\`, which builds and then runs this project.`,
    );
  }
});

afterAll(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});
