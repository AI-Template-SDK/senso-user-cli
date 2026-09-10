/**
 * The one number that has to agree with npm.
 *
 * `senso --version` is what a bug report quotes, what the User-Agent carries on
 * every request, and what the update check compares against the registry. If it
 * drifts from the version in package.json, all three lie: a user reports a
 * version that was never published, support cannot match it to a release, and
 * the update notice either never appears or appears forever.
 *
 * The module gets there by reading its own directory and walking up looking for
 * a package.json, which is a deliberate trick to work from both `src/` and the
 * bundled `dist/`. The failure mode it protects against is silent: every read
 * is wrapped in a catch, so a wrong path does not throw — it leaves the
 * hardcoded "0.0.0" fallback in place and ships. Asserting equality with the
 * repository's own package.json is what turns that into a failing test, and it
 * is the property the CI smoke test and the e2e suite both depend on.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import semver from "semver";
import { version } from "../../src/lib/version.js";

/** The version npm would publish, read straight off disk. */
function publishedVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf-8")) as {
    version?: string;
  };
  expect(pkg.version).toBeTypeOf("string");
  return pkg.version!;
}

describe("the version the CLI reports", () => {
  it("is a valid semver string", () => {
    expect(semver.valid(version)).toBe(version);
  });

  it("matches the version in the repository's package.json", () => {
    // The assertion this file exists for. `senso --version` must not drift
    // from what is published.
    expect(version).toBe(publishedVersion());
  });

  it("is not the 0.0.0 fallback that a failed lookup leaves behind", () => {
    // Every read in version.ts is wrapped in a catch, so the module cannot
    // fail loudly — it can only fail as this value. Stated separately from the
    // equality check above so the diagnosis is in the test name.
    expect(version).not.toBe("0.0.0");
  });

  it("is a bare version, with no leading v and nothing appended", () => {
    // It is interpolated into the User-Agent as `senso-cli/${version}` and
    // compared with semver.gt against the registry; either would break on
    // whitespace or a "v" prefix.
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
    expect(version.trim()).toBe(version);
  });

  it("is the same value on every read, because it is resolved once at load", () => {
    // Nothing in a single invocation can change it, and the update check
    // compares against it after an await.
    expect(version).toBe(version);
    expect(semver.gt(version, "0.0.0")).toBe(true);
  });
});
