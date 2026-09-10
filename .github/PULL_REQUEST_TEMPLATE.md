## What this changes

<!-- One or two sentences. What is different after this merges? -->

## Why

<!-- The problem, not the patch. What was wrong or missing? -->

## Checklist

- [ ] `make all` passes locally (lint, typecheck, security, unit, e2e, build, smoke)
- [ ] New or changed behavior has a test, and the failure branches are covered — not just the happy path
- [ ] If a command was added, renamed or removed: `make reference` was run and the README's command table updated
- [ ] If an environment variable was added or renamed, `docs/configuration.md` documents it
- [ ] `CHANGELOG.md` has an entry under `## [Unreleased]` for anything a user or an agent would notice
- [ ] American English throughout
- [ ] No credential, key or token in any tracked file

## Risk

<!-- Answer all five. "No" is a fine answer; a blank is not. -->

- **Does this change the shape of stdout, or any `--output json` payload?** Agents parse these.
- **Does this change an exit code?** Scripts branch on them.
- **Does this change the config file's format or location?** Existing installs must keep working.
- **Does this change what is sent to the Senso API** — a new endpoint, a new header, a new field?
- **Is it safe to roll back by reverting this commit alone?**

## Verified how

<!-- A passing test suite is not the same as having run the command. If you
     changed something a user sees, paste what you ran and what it printed. -->
