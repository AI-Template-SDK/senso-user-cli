// ESLint 9+ flat config.
//
// The rule that earns this file its place is `no-restricted-syntax` on
// `console.*` below. Everything else here is ordinary hygiene; that one rule is
// what makes the CLI's output contract mechanically enforceable instead of a
// convention people remember. See docs/architecture.md.
//
// Type-aware linting is on (projectService), which is why tsconfig.json includes
// tests/ and scripts/ as well as src/.

import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * The only modules allowed to write to stdout or stderr directly.
 *
 * Everything a command prints goes through one of these three, so there is a
 * single place that decides what lands on stdout (the payload, and nothing
 * else), what lands on stderr (diagnostics, progress, decoration), and what
 * `--output json` and `--quiet` mean. A stray `console.log` in a command file
 * bypasses all of that — which is exactly how the banner ended up on stdout,
 * breaking `--output json | jq` for every caller who did not also pass
 * `--quiet`.
 *
 * If you need to print something new, add it to lib/output.ts or
 * utils/logger.ts and call it from the command. Do not add a file here.
 */
const OUTPUT_MODULES = ["src/lib/output.ts", "src/utils/logger.ts", "src/utils/branding.ts"];

const noConsoleRule = {
  selector: "MemberExpression[object.name='console']",
  message:
    "Commands must not write to the console directly. Print through lib/output.ts (payload) or utils/logger.ts (diagnostics) so --output and --quiet keep working, and stdout stays parseable. See eslint.config.mjs.",
};

export default tseslint.config(
  {
    // Build output, coverage reports and dependencies are not ours to lint.
    ignores: ["dist/**", "coverage/**", "node_modules/**", "docs/reference/**"],
  },

  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The output contract. See OUTPUT_MODULES above.
      "no-restricted-syntax": ["error", noConsoleRule],

      // process.exit in a command action is untestable in-process and skips the
      // single error path in lib/run-action.ts. Throw a CliError instead; the
      // bin entry is the one place allowed to exit.
      "no-restricted-properties": [
        "error",
        {
          object: "process",
          property: "exit",
          message:
            "Throw a CliError instead. process.exit() in a command action cannot be tested in-process and bypasses the exit-code mapping in lib/errors.ts. src/cli.ts is the only file that may exit.",
        },
      ],

      // Unused arguments are usually a refactor leftover, but a leading
      // underscore is the conventional way to say "required by the signature,
      // deliberately unused".
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],

      // The codebase reads untyped JSON from an HTTP API and narrows it at the
      // point of use. Blanket-banning these would mean either lying with casts
      // or generating a client, neither of which is in scope; the API responses
      // are validated by the command tests instead.
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",

      // `data as { answer?: string }` on a fetch result is the narrowing idiom
      // used throughout the command layer, and it is deliberate.
      "@typescript-eslint/consistent-type-assertions": "off",

      // Template literals interpolate numbers and ids constantly; requiring a
      // .toString() on each would add noise without catching anything.
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true, allowBoolean: true, allowNullish: true },
      ],
    },
  },

  {
    // The three modules that own the streams. The console ban is lifted here
    // and nowhere else.
    files: OUTPUT_MODULES,
    rules: { "no-restricted-syntax": "off" },
  },

  {
    // The bin entry maps a thrown CliError to an exit code — it is the one file
    // that is supposed to end the process, and it reports failures on stderr
    // before it does.
    files: ["src/cli.ts"],
    rules: {
      "no-restricted-properties": "off",
      "no-restricted-syntax": "off",
    },
  },

  {
    // Tests assert on what reaches the streams and drive the CLI as a
    // subprocess, so both restrictions would fire on every file. Scripts are
    // developer tools whose whole purpose is to print a report.
    files: ["tests/**/*.ts", "scripts/**/*.ts"],
    rules: {
      "no-restricted-syntax": "off",
      "no-restricted-properties": "off",
      // Tests deliberately pass malformed values to check the failure branch.
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
