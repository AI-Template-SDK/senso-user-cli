---
name: Bug report
about: Something the CLI does that it should not
title: ""
labels: bug
---

## What happened

<!-- What you expected, and what you got instead. -->

## The command

<!-- The exact command. Add `--output json` if you were not already using it —
     it usually shows the real shape of the problem. REDACT YOUR API KEY. -->

```console
$ senso ... --output json

```

## Environment

Run `senso --version` and fill this in:

|                   |                      |
| ----------------- | -------------------- |
| `senso --version` |                      |
| Operating system  |                      |
| `node --version`  |                      |
| Installed via     | npm -g / npx / other |

## Anything else

<!-- Re-running with `SENSO_DEBUG=1` prints each request and its status to
     stderr, with the key redacted. That output is usually the fastest way to
     a diagnosis. -->
