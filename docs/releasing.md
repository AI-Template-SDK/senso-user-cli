# Releasing

Publishing is the only irreversible action in this repository. npm permits
unpublishing for 72 hours and never reuses a version number, so the whole
procedure is arranged around making a bad release hard to produce rather than
easy to undo.

A release is triggered by pushing a tag matching `v*`.
`.github/workflows/publish.yml` does the rest.

## Cutting a release

### 1. Describe the release under `[Unreleased]`

Make sure `## [Unreleased]` in `CHANGELOG.md` says what this release changes. You
do not move the entries yourself: `npm version` runs the `version` npm script
(`scripts/changelog-release.ts`), which moves them under a heading for the new
version and adds the compare link, in the same commit as the bump:

```markdown
## [0.13.0] — 2026-09-20
```

```markdown
[unreleased]: https://github.com/AI-Template-SDK/senso-user-cli/compare/v0.13.0...HEAD
[0.13.0]: https://github.com/AI-Template-SDK/senso-user-cli/compare/v0.12.0...v0.13.0
```

The script refuses to run while `[Unreleased]` is empty, and the publish workflow
refuses to publish a version with no section of its own.

Nothing else in the repository names the version. In particular
`docs/reference/commands.md` deliberately does not, so a bump never makes it stale.

Entries are written for the person who has to act on them: what changed, why it
mattered, and what they need to do differently. Anything a user or an agent would
notice belongs there, and a change to an exit code or an `error.code` is a
breaking change.

### 2. Bump, tag and push

```bash
git checkout main && git pull           # never from a feature branch
make all                                # what the tag will re-run anyway
npm version patch                       # or minor / major
git push --follow-tags
```

Run it from an up-to-date `main`. Merging a pull request on GitHub leaves your
local checkout on its branch, and `npm version` there tags a commit `main` never
sees. That is how 0.16.0 was published from `feat/gaps-commands` while `main`
stayed at 0.15.0 and later tried to release 0.15.1. The workflow now refuses both.

`npm version` rewrites `package.json`, commits, and creates the annotated tag
`v0.13.0`. `--follow-tags` pushes the commit and the tag together.

`main` is protected, so if the direct push is refused, land the version commit
through a pull request and push the tag on its own afterwards
(`git push origin v0.13.0`). The workflow keys off the tag, not the branch, and
gate 1 below checks that the tag and the `package.json` at that commit agree.

Nothing else is required. There is no manual `npm publish`, and there is no
`NPM_TOKEN`: the workflow authenticates to npm with OIDC trusted publishing,
configured on npmjs.com under the package's Trusted Publisher settings
(org `AI-Template-SDK`, repo `senso-user-cli`, workflow `publish.yml`).

## What the workflow checks before it publishes

Four jobs, chained with `needs:`, cheapest first.

| Job                | Gate                                                                                                                                                            |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verify`           | The tag equals `v` + `package.json`'s version, points at a commit on `main`, is newer than npm's `latest`, and `CHANGELOG.md` has a `## [x.y.z]` section for it |
| `test`             | `make install lint typecheck security unit e2e smoke` on the tagged commit, on Node 22                                                                          |
| `publish`          | `npm publish --access public --provenance`, then a GitHub release cut from the changelog section with `gh`                                                      |
| `verify-published` | Installs the published version from the registry on Ubuntu, macOS and Windows and runs `--version` and `--help`                                                 |

Three details are decisions rather than boilerplate:

- **The test job duplicates the Testing workflow on purpose.** A `workflow_run`
  trigger would let a tag publish a commit whose CI run had been canceled or had
  never started, and a tag is exactly when being sure is worth the minutes.
- **`--provenance` is passed explicitly** even though trusted publishing implies
  it, so the guarantee is visible in the file rather than inherited silently.
- **`verify-published` exists because a package can publish successfully and
  still be broken** — a missing `files` entry, or a `bin` path that does not
  resolve once it is inside `node_modules`. It waits 30 seconds first, because
  npm's registry CDN can lag a publish by a few seconds.

The tag path runs the full suite on Ubuntu only. The three-OS, four-Node matrix
runs on every pull request and every push to `main` in
`.github/workflows/testing.yml`; what the release path adds is the cross-platform
check of the _published_ artifact.

## When it fails

Where the run stopped tells you what exists in the world.

| Failed at                                        | What is published                            | What to do                                                                                                         |
| ------------------------------------------------ | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `verify`                                         | Nothing                                      | Delete the tag, fix the mismatch or the changelog, and re-tag                                                      |
| `test`                                           | Nothing                                      | Fix on a branch and merge it, then delete and re-create the tag on the new commit                                  |
| `publish` — `npm publish`                        | Nothing                                      | Read the step log. A rejected OIDC exchange means the Trusted Publisher config no longer matches the workflow path |
| `publish` — release notes or `gh release create` | **The npm version is live**                  | Do not re-run the workflow: npm refuses to republish a version. Cut the GitHub release by hand                     |
| `verify-published`                               | **The npm version is live and does not run** | Treat it as a bad release — see below                                                                              |

Deleting and re-creating a tag that has not published anything:

```bash
git tag -d v0.13.0
git push --delete origin v0.13.0
# fix, then tag the commit you want
git tag v0.13.0 && git push origin v0.13.0
```

Re-running the whole workflow after a partial publish does not work, because the
`publish` job's first action is the one that already succeeded. Finish the
remainder by hand:

```bash
awk -v v="0.13.0" '
  $0 ~ ("^## \\[" v "\\]") { found = 1; next }
  found && /^## \[/ { exit }
  found { print }
' CHANGELOG.md > release-notes.md

gh release create v0.13.0 --title v0.13.0 --notes-file release-notes.md --verify-tag
```

## Yanking a bad release

npm never reuses a version number, so the fix is always a new version. The
question is only what to do about the bad one.

**Within 72 hours of publishing**, it can be removed outright:

```bash
npm unpublish @senso-ai/cli@0.13.0
```

**After 72 hours**, unpublishing is not available. Deprecate it instead, which
leaves it installable — anything that pinned it keeps working — but prints a
warning on every install:

```bash
npm deprecate "@senso-ai/cli@0.13.0" "Broken release: <one line>. Use 0.13.1."
```

**In both cases**, check where `latest` points. Unpublishing or deprecating does
not move the dist-tag on its own, and `npm install -g @senso-ai/cli` follows
`latest`:

```bash
npm dist-tag ls @senso-ai/cli
npm dist-tag add @senso-ai/cli@0.12.0 latest    # until the fix ships
```

Then finish the trail: mark the GitHub release as a pre-release or delete it, and
record what happened in `CHANGELOG.md` under the replacement version rather than
editing the bad version's section — the notes for a release that people installed
should keep saying what that release contained.
