# Endpoints without commands

Every documented Senso API endpoint has a CLI command, except the ones listed
here. Each row is a decision rather than an omission, and
`scripts/spec-drift.ts` reads this file — an endpoint listed here stops being
reported as drift, so adding a row is an act of deciding, not of silencing.

The weekly [API drift workflow](../../.github/workflows/spec-drift.yml) compares
the published spec against the command tree and opens an issue when something
appears that is in neither place. Run it yourself with:

```bash
npx tsx scripts/spec-drift.ts
```

## Deliberately not exposed

| Endpoint                               | Why                                                                                                                                                                                               |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /org/generated-content/drafts`    | Duplicates `senso generated-content list --status drafts`. The command builds its path from the `--status` flag, so both listings are reachable; only the literal path is absent from the source. |
| `GET /org/generated-content/published` | Duplicates `senso generated-content list --status published`, which is the default.                                                                                                               |

## Called by the CLI but not in the spec

The reverse direction, which is the more alarming one: a command that reaches an
endpoint the published contract does not describe. Either the spec is behind, or
the command is calling something that is not public API.

| Path                                | Command                 | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /org/api-keys/{keyId}/revoke` | `senso api-keys revoke` | **Unresolved.** The customer-facing spec documents only `GET /org/api-keys` and `GET /org/api-keys/{keyId}`, and states that creating, updating, revoking and deleting keys happens in the dashboard because those actions need user authentication rather than an API key. The CLI ships `create`, `update`, `delete` and `revoke` against those paths anyway. They may work with an admin-scoped key and simply be undocumented, or they may be dead. **This needs an answer from the API team before the next release**; if they are dead, the commands should be removed rather than left to fail confusingly. |

## How to add a row

Only after deciding not to implement something. Give the reason, not the
restatement — "needs a browser flow", "duplicates an existing command",
"destructive without a confirmation this CLI cannot offer" are reasons. "Not
implemented yet" is not; that is what the drift report already says.
