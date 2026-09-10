/**
 * The network ban, and the credential ban.
 *
 * This CLI's whole job is to talk to a real Senso API with a real key. Without
 * this file, a command test that forgot to mock a request would issue it for
 * real — against whatever SENSO_BASE_URL and SENSO_API_KEY happen to be in the
 * developer's environment. That is how a test suite ends up deleting content
 * from a production organization.
 *
 * Two things stop it, and both are mechanical rather than conventions people
 * have to remember:
 *
 *   1. `onUnhandledRequest: 'error'` makes any request nobody explicitly mocked
 *      fail the test that made it.
 *   2. Every Senso environment variable is cleared, and SENSO_CONFIG_DIR is
 *      pointed at a temporary directory, so nothing can read or write the real
 *      config file even if it somehow got past the first rule.
 *
 * This is also why CI needs no secrets, and why pull requests from forks run the
 * full suite instead of silently skipping half of it.
 *
 * To allow a request in a test, register a handler on the server exported here:
 *
 *     server.use(http.get('*\/org/roles', () => HttpResponse.json({ roles: [] })))
 */

import { afterAll, afterEach, beforeAll, beforeEach } from "vitest";
import { setupServer } from "msw/node";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const server = setupServer();

/** The base URL every test points the CLI at. Nothing listens on it. */
export const TEST_BASE_URL = "https://api.test.invalid/api/v1";

/** The key every test authenticates with. Not a real key shape by accident. */
export const TEST_API_KEY = "tgr_test_key_for_the_suite";

let configDir: string;

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});

beforeEach(() => {
  // A fresh directory per test: config.ts resolves SENSO_CONFIG_DIR once at
  // module load, so tests that need a different path re-import the module with
  // vi.resetModules() rather than relying on this changing under them.
  configDir = mkdtempSync(join(tmpdir(), "senso-test-"));
  process.env.SENSO_CONFIG_DIR = configDir;

  // Cleared so a developer's own shell cannot change what a test sees. Every
  // test that needs a key passes one explicitly.
  delete process.env.SENSO_API_KEY;
  delete process.env.SENSO_BASE_URL;
  delete process.env.SENSO_DEBUG;
  process.env.SENSO_NO_UPDATE_CHECK = "1";

  // Color codes would otherwise be interleaved through every assertion about
  // what a command printed.
  process.env.NO_COLOR = "1";

  // runAction sets process.exitCode rather than exiting, so it persists across
  // tests in the same worker. Left unreset, one failing command marks every
  // later test's process as failed.
  process.exitCode = undefined;
});

afterEach(() => {
  // Handlers are per-test. Leaking one makes the next test pass for the wrong
  // reason — the most expensive kind of green.
  server.resetHandlers();
  process.exitCode = undefined;
  if (configDir) rmSync(configDir, { recursive: true, force: true });
});

afterAll(() => {
  server.close();
});
