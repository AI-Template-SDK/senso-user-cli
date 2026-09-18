/**
 * The repository's own rule about prompting for a credential.
 *
 * Clack's `text` prompt redraws the value into stdout on every keystroke. Used
 * for the API key, it wrote the whole credential there one character at a
 * time, so `senso login > install.log`, a CI capture or a terminal recording
 * persisted it. `password` masks the value instead.
 *
 * This is a policy test rather than a command test because it cannot be one:
 * `tests/commands/auth.test.ts` mocks @clack/prompts, and a mock cannot echo.
 * Swapping `password` back to `text` there changes nothing and every test still
 * passes — which is exactly how this would return unnoticed. The rule is a
 * property of the source, so the source is what gets read.
 *
 * Proven separately, once, by driving the real binary on a pty with stdout
 * redirected to a file: with `text` the key was in that file, with `password`
 * it was not.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const AUTH = join(import.meta.dirname, "../../src/commands/auth.ts");

describe("the API key is never typed into an echoing prompt", () => {
  it("uses clack's masking `password` prompt in `senso login`", () => {
    const source = readFileSync(AUTH, "utf-8");

    expect(
      source.includes("p.password({"),
      "src/commands/auth.ts must prompt for the API key with `p.password`, which masks it. " +
        "`p.text` redraws the typed value into stdout, which writes the credential to any " +
        "captured log.",
    ).toBe(true);
  });

  it("does not use the echoing `text` prompt anywhere in the auth flow", () => {
    const source = readFileSync(AUTH, "utf-8");

    expect(
      source.includes("p.text("),
      "src/commands/auth.ts uses `p.text`, which echoes what is typed into stdout. The only " +
        "thing it prompts for is an API key, so use `p.password` instead.",
    ).toBe(false);
  });
});
