// ESLint 9+ flat config.
//
// The rule that earns this file its place is `no-restricted-syntax` on
// `console.*` below. Everything else here is ordinary hygiene; that one rule is
// what makes the CLI's output contract mechanically enforceable instead of a
// convention people remember. See docs/architecture.md.
//
// Type-aware linting is on (projectService), which is why tsconfig.json includes
// tests/ and scripts/ as well as src/.

import { defineConfig } from "eslint/config";
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

/**
 * The same ban, one level down.
 *
 * Without this, `process.stdout.write(...)` is an unguarded way around the
 * console rule that looks more deliberate than it is — and it was already being
 * used to stream search tokens. lib/output.ts exports `writeStdout` for that
 * case, which keeps the exception in the module that owns the stream.
 */
const noRawStreamRule = {
  // `.write` specifically, not any access to the stream. Reading
  // `process.stdout.isTTY` to decide whether an animated spinner is safe is a
  // legitimate check — lib/progress.ts does exactly that — and the point of the
  // rule is to stop unmediated OUTPUT, not to ban the object.
  selector:
    "MemberExpression[property.name='write'][object.object.name='process'][object.property.name=/^(stdout|stderr)$/]",
  message:
    "Do not write to process.stdout/stderr directly. Use writeStdout() from lib/output.ts for streamed payload, or utils/logger.ts for diagnostics. See eslint.config.mjs.",
};

export default defineConfig(
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
        // `allowDefaultProject` covers the config files at the repository root.
        // They are linted, but they are not part of the TypeScript program —
        // putting them in tsconfig's `include` would drag a .mjs file into a
        // build that has no reason to know about it.
        projectService: {
          allowDefaultProject: ["*.mjs", "*.js"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The output contract. See OUTPUT_MODULES above.
      "no-restricted-syntax": ["error", noConsoleRule, noRawStreamRule],

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

      // A type parameter that appears once is this codebase's way of letting a
      // caller assert the shape of something untyped — `parseJsonFlag<Body>()`,
      // `resolveOption<string[]>()`, `result.json<Payload>()`. The rule is right
      // that nothing infers it; that is the point. The alternative is an `as`
      // cast at every call site, which is the same assertion with less
      // documentation.
      "@typescript-eslint/no-unnecessary-type-parameters": "off",

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
    /**
     * Command files narrow untyped JSON, so "provably true" is not provable.
     *
     * `apiRequest<T>` is a cast, not a validator: the response interfaces in
     * these files are assertions about what the server sends, and the compiler
     * treats them as facts. That makes `no-unnecessary-condition` unsound here —
     * it reads `results: UploadResultItem[]` as "always present" and flags the
     * `?? []` that keeps a malformed response from throwing "not iterable".
     * Removing those guards to satisfy the linter would trade a real runtime
     * protection for a type-level tautology.
     *
     * The rule stays on for lib/ and utils/, where the types are ours and the
     * reasoning holds — it found genuine dead conditionals in both.
     */
    files: ["src/commands/**/*.ts"],
    rules: { "@typescript-eslint/no-unnecessary-condition": "off" },
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
