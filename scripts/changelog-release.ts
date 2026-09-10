/**
 * Moves the `## [Unreleased]` entries under a heading for the version being
 * released, and adds the compare link.
 *
 * Wired to npm's `version` lifecycle script, which runs after package.json has
 * been bumped and before the release commit is made — so the rewritten changelog
 * lands in the same commit as the version bump, and `git push --follow-tags`
 * carries both.
 *
 * That matters because the publish workflow refuses to publish a version with no
 * changelog section. Doing this by hand is the step everyone forgets, and
 * discovering it from a failed release is the worst moment to find out.
 *
 *   npx tsx scripts/changelog-release.ts            # uses package.json's version
 *   npx tsx scripts/changelog-release.ts 1.2.3      # or an explicit one
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO = "https://github.com/AI-Template-SDK/senso-user-cli";
const CHANGELOG = join(import.meta.dirname, "../CHANGELOG.md");
const PACKAGE = join(import.meta.dirname, "../package.json");

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** The most recent released version already in the changelog, for the link. */
function previousVersion(body: string): string | null {
  const headings = [...body.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)];
  return headings[0]?.[1] ?? null;
}

function main(): void {
  const version =
    process.argv[2] ?? (JSON.parse(readFileSync(PACKAGE, "utf-8")) as { version: string }).version;

  const body = readFileSync(CHANGELOG, "utf-8");

  if (new RegExp(`^## \\[${version.replace(/\./g, "\\.")}\\]`, "m").test(body)) {
    console.log(`CHANGELOG.md already has a section for ${version}. Nothing to do.`);
    return;
  }

  const unreleased = /^## \[Unreleased\]\s*$/m.exec(body);
  if (!unreleased?.index) {
    console.error("CHANGELOG.md has no '## [Unreleased]' heading. Add one and re-run.");
    process.exit(1);
  }

  // Everything from the Unreleased heading to the next version heading.
  const after = body.slice(unreleased.index + unreleased[0].length);
  const nextHeading = /^## \[/m.exec(after);
  const entries = (nextHeading ? after.slice(0, nextHeading.index) : after).trim();

  if (entries.length === 0) {
    console.error(
      `CHANGELOG.md's Unreleased section is empty, so ${version} would ship with no notes.\n` +
        "Describe what changed before tagging — that is what the section is for.",
    );
    process.exit(1);
  }

  const previous = previousVersion(body);

  const rewritten =
    body.slice(0, unreleased.index) +
    `## [Unreleased]\n\n## [${version}] — ${today()}\n\n${entries}\n\n` +
    (nextHeading ? after.slice(nextHeading.index) : "");

  // The compare link for the new version, and Unreleased repointed at it.
  const withLinks = rewritten
    .replace(
      /^\[Unreleased\]: .*$/m,
      `[Unreleased]: ${REPO}/compare/v${version}...HEAD\n[${version}]: ${REPO}/compare/${previous ? `v${previous}` : "v0.0.0"}...v${version}`,
    )
    .replace(/\n{3,}/g, "\n\n");

  writeFileSync(CHANGELOG, withLinks);
  console.log(`CHANGELOG.md: moved the Unreleased entries under [${version}].`);
}

main();
