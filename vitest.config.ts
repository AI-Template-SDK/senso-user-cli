import { defineConfig } from "vitest/config";

/**
 * Two projects, because they need opposite things.
 *
 * `unit` runs in-process against src/. It is fast, it measures coverage, and it
 * cannot touch the network — tests/setup.ts installs an MSW server with
 * `onUnhandledRequest: 'error'`, so a request nobody mocked fails the test that
 * made it instead of quietly reaching a real Senso API with whatever key happens
 * to be in the developer's environment. That ban is mechanical rather than a
 * convention people have to remember, which is why CI needs no secrets and why
 * pull requests from forks run the full suite.
 *
 * `e2e` spawns `dist/cli.js` as a subprocess against a local mock server. It
 * proves things the unit project structurally cannot see: that the bundle runs
 * at all, that the shebang survived, that stdout carries only the payload, and
 * that the process really does exit with the code the contract promises. It
 * needs a build first, which is why `make e2e` runs one.
 *
 * Coverage is measured on the unit project only. The e2e project runs the
 * bundle in another process, where the instrumentation cannot see it, so
 * including it would report src/ as uncovered and hide what the unit suite
 * actually reaches.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          globals: true,
          setupFiles: ["./tests/setup.ts"],
          include: [
            "tests/unit/**/*.test.ts",
            "tests/commands/**/*.test.ts",
            "tests/policy/**/*.test.ts",
          ],
        },
      },
      {
        test: {
          name: "e2e",
          environment: "node",
          globals: true,
          include: ["tests/e2e/**/*.test.ts"],
          // Spawning a process, packing a tarball and waiting on a socket are
          // all slower than an in-process assertion.
          testTimeout: 30_000,
          // The mock API binds a port per file. Running files in parallel makes
          // that a race that only shows up under load.
          fileParallelism: false,
        },
      },
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**"],
      exclude: [
        "**/*.d.ts",
        // The bin entry: three lines that call createProgram() and exit. What it
        // does is covered by the e2e project, in the only place it is real — a
        // separate process where an exit code can actually be observed.
        "src/cli.ts",
        // Type-only modules have no statements to execute, so including them
        // reports 0% for files nothing can cover.
        "src/commands/analytics/types.ts",
      ],
      /**
       * The gate sits below what the suite achieves, on purpose.
       *
       * A gate set at the current number fails the build on the first line of a
       * work-in-progress branch, which teaches people to pass --no-coverage.
       * Leaving headroom means a real regression still fails the build while
       * adding code in one commit and its tests in the next does not.
       *
       * Do not lower these to make a change pass. If you are hitting one, the
       * change needs tests.
       *
       * Achieved as of 2026-09-09: 98.8% statements, 85.3% branches, 99.5%
       * functions, 99.2% lines, across ~1,200 tests. The branch figure is the
       * one to read carefully and it is the lowest on purpose — much of the
       * remaining branching is defensive handling of API response shapes that
       * cannot all be provoked without inventing malformed payloads for their
       * own sake.
       */
      thresholds: {
        statements: 92,
        branches: 78,
        functions: 92,
        lines: 92,
      },
    },
  },
});
