# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[semantic versioning](https://semver.org/).

Entries are written for the person who has to act on them: what changed, why it
mattered, and what you need to do differently.

## [Unreleased]

### Changed

- **`senso website-import` now imports up to 20 pages, chosen for what people
  ask about the business.** The API reads the site's sitemap as well as the
  home page's links, and when there are more candidates than it imports, an AI
  model picks the pages most likely to answer common questions (what you offer,
  pricing, who it is for, how it works, FAQs) instead of the first ten nav
  links. `start` now says how the pages were chosen, and runs carry the new
  `selection_method`, `candidates_found`, `candidates_considered` and
  `sitemap_found` fields. Nothing to change on your side.

## [0.17.4] — 2026-09-23

### Added

- **`senso setup` installs the handful of skills a new user needs to get
  started**, globally, in one command: `quickstart`, `context-layer`,
  `evaluate-remediate`, `generate-verify` and `publish`. That is the starter
  set, not the whole registry — anything else is still one
  `senso skills install` away. `--local` scopes the install to the current
  project and `--agent <name>` narrows it to one agent; `--global` is accepted
  as a no-op so spelling out the default is never a usage error. Passing
  `--global` and `--local` together exits 2 rather than picking a winner — a
  wrongly-scoped install reports success either way, so guessing would be
  unrecoverable in practice.

### Changed

- **The starter skill set is now the five workflow skills**, not the seven
  task-shaped ones: `quickstart`, `context-layer`, `evaluate-remediate`,
  `generate-verify`, `publish`. `senso skills install --all` and
  `senso skills list-available` follow the new list. The old packages
  (`search`, `ingest`, `content-gen`, `brand-setup`, `kb-organize`,
  `review-publish`, `onboarding`) are still in the registry and still install
  by name — `senso skills install search` works unchanged — they are simply no
  longer what `--all` means. If you relied on `--all` to get the old seven,
  name them explicitly.

## [0.17.3] — 2026-09-22

### Added

- **`senso industries prompts --imported <true|false>` filters by what you
  already have.** The API gained the parameter and a matching `org_prompt_id`
  on every prompt — your own prompt with the same trimmed text, or `null`,
  judged by the same rule the import applies. `--imported false` lists what you
  have not taken yet, which is the natural call after importing, and
  `--imported true` lists what you have. The flag takes a value rather than
  being a bare boolean because omitting it means "all", which is a third state:
  a `--no-imported` spelling would have made "everything" unsayable. An invalid
  value exits 2 without spending a request, and `org_prompt_id` is now a table
  column, so "do I already have this?" is answerable without `--output json`.

- **`senso login` reuses a credential that still works, instead of minting
  another.** A bare `senso login` now verifies whatever key commands would
  actually send — `SENSO_API_KEY` included, since it outranks the stored file —
  and, if the API accepts it, reports `Already authenticated as "…"` and stops.
  Nothing is minted, nobody is asked to approve anything, and the JSON payload
  carries `reused: true` so a caller can tell "a human just approved something"
  from "nothing happened". That makes `login` safe for an agent to run at the
  start of every session. A rejected key falls through to the browser flow as
  before; a network failure is reported rather than answered by starting a flow
  that needs the same network. Signing in as a different organization is
  `senso logout` then `senso login` — deliberately explicit, because giving up a
  working credential should be something you asked for. `--api-key`,
  `--interactive` and `--complete` are instructions and still do exactly what
  they say.

- **`senso login` run twice mid-flow re-prints the same code.** It used to open
  a second authorization and show a second code, orphaning the one the user was
  at that moment typing into the browser. A pending login that is still live —
  and was opened against the same API — is now reused, with the time it has
  actually got left rather than a fresh five minutes.

- **The key's expiry is stored, as `apiKeyExpiresAt`.** `login` prints how long
  a reused key has left and warns when that is under a day, which is the
  difference between an agent seeing a session end coming and meeting it
  mid-task.

- **`senso logout` and `senso uninstall` revoke the key that `senso login`
  minted.** A device-flow key is single-purpose and lasts seven days; before
  today, signing out deleted the local file and left the key live until it
  expired — one orphan per login, accumulating on the api-keys page. Both
  commands now call `POST /org/api-keys/self/revoke` with the stored key first,
  then delete the file. Only a key the CLI minted is revoked: `login` records
  `apiKeyProvenance` when it stores a key, a key you pasted or passed with
  `--api-key` is `supplied` and only forgotten (it may be in use elsewhere), and
  a config written before the field existed is treated the same way. The
  request carries the _stored_ key, never the one `SENSO_API_KEY` or `--api-key`
  would resolve to, and goes to the API the key belongs to. Revocation is
  best-effort: a network failure still logs you out, with a warning that the key
  stays valid until it expires and `keyRevoked: false` in the JSON payload.
  `uninstall --keep-config` skips it, and `--dry-run` reports
  `keyWillBeRevoked`. `login` deliberately does **not** revoke: replacing a
  working key is what `--api-key` does on request, and it warns that the key it
  displaced stays valid until it expires.

## [0.17.2] — 2026-09-22

### Added

- **`senso login` now signs you in through a browser, and works without a
  terminal.** It opens a device authorization against the Senso API, prints a
  short code and the page to type it into, and stores the key an org admin's
  approval mints. This closes the gap that made one-shot agent onboarding
  impossible: `login` used to require a TTY and exit 2 without one, so the only
  paths left for an agent were `SENSO_API_KEY` or `--api-key`, both of which
  need the user to already hold a key and both of which put a live credential
  into the agent's transcript.

  Whether there is a terminal decides the process shape, not the mechanism —
  browser approval is what humans and agents both do, so there is one flow to
  maintain:

  | stdin          | What happens                                                                   |
  | -------------- | ------------------------------------------------------------------------------ |
  | a terminal     | one process: prints the code, then waits for the approval                      |
  | not a terminal | two: `senso login` prints the code and exits 0, `senso login --complete` waits |

  The split exists because an agent host generally surfaces a command's stdout
  only once it exits, so a single blocking process would hide the code until the
  five minutes had run out. Between the two, the `device_code` lives in
  `device-auth.json` beside `config.json`, mode `0600`, deleted the moment the
  flow ends — never on stdout, where in an agent's shell it would outlive the
  five minutes it is good for.

  Exit codes are the contract, as everywhere else: **3** with `device_denied` if
  the approval was refused, **1** with `device_expired` if the code ran out,
  **2** if there is no login to complete, **5** if the API could not be reached.
  A 5xx, a 429 or a dropped connection is _not_ an answer — the authorization is
  untouched, so polling continues and the failure is reported only if the clock
  runs out with nothing better to say.

- **The approval page gets a device name a person can recognize.** `senso login`
  sends `user@machine`, and falls back to `user (macOS)` when the hostname is an
  address rather than a name — which is what macOS returns for a machine whose
  name was never set, so the card would otherwise read `senso-cli
82:5b:bd:cc:62:3d`. Nothing trusts this field; its only job is to help the
  person approving decide whether the request is the terminal they just typed
  in. `--device-name` overrides it.

- **`senso login --api-key <key>` verifies and stores a key without a
  terminal.** There was no way to do that before: `login` always prompted, so a
  scripted setup or an agent told "here is my key" could only pass it per
  command, which breaks silently the moment something forgets the flag. It runs
  the same `/org/me` check and the same shadowing warning as every other path.

- **`senso login --interactive`** keeps the old paste-a-key prompt, for anyone
  who cannot open a browser. It still needs a terminal, and without one it still
  exits 2 with the same message.

### Changed

- **`senso login` without a terminal no longer exits 2.** It starts the device
  flow instead. `senso login --interactive` is now the command that requires a
  TTY, and it fails the same way it always did. Anything scripted around "login
  exits 2 without a terminal" should move to `--interactive` or `--api-key`.

- **`config.json` has its permissions re-applied on every write.** Node applies
  a file mode only when it creates the file, so a `config.json` that already
  existed with looser permissions — an older version, a restored backup, a file
  copied between machines — kept them and had a credential written into it
  anyway. Both it and the new state file are now `chmod`ed explicitly after each
  write, and the config directory is created `0700`. Best-effort, because POSIX
  modes do not apply on Windows, where the protection is the ACL on `%APPDATA%`.

- **`senso logout` also ends a login in progress**, deleting `device-auth.json`
  along with the stored key. `senso uninstall` depends on it: it removes the
  config directory, which fails while anything is left inside.

### Fixed

- **`senso login` no longer erases a stored `baseUrl`.** It built a fresh
  config object and wrote it, so a `baseUrl` set by an earlier login or by hand
  vanished unless `--base-url` was passed on that exact invocation. The login
  had just _used_ that URL to verify the key, then deleted the pointer to it, and
  the next command sent a key minted in one environment to another and got a 401
  nobody could explain. `login` now merges into the file, and records the API
  the key was actually verified against — flag, then `SENSO_BASE_URL`, then the
  stored value — because a key belongs to the environment that minted it. The
  default is stored as absence, so a login to the default API clears a stale
  pointer rather than pinning today's default into the file. The update-check
  cache survives a login too, which it never did.

- **The credential file is replaced atomically, never rewritten in place.**
  `config.json` and `device-auth.json` are now written to a fresh `0600` file
  beside the target and renamed over it. That closes three holes at once: an
  interrupted write no longer leaves a truncated file that reads as "not logged
  in" — which for a device-minted key meant a credential lost for good, since it
  is delivered exactly once; a symlink planted at the path no longer carries the
  key to wherever it points; and a file left world-readable by an older version
  no longer holds the secret for the instant before the permissions are fixed.
  On Windows the rename is retried through the `EPERM` an antivirus scanner
  produces, and a failure after that throws rather than falling back to an
  in-place write.

- **`senso content-types` help no longer teaches a broken template.** `--data`
  on `create`, `update` and `patch` showed `"template": "..."` (and, on `patch`,
  the prose value `"Updated template instruction"`), and the key list advertised
  `template_spec` as settable. Both are traps. `template` is markdown: the server
  derives the section structure from its headings and word budgets from
  annotations like `(40-80 words)`. Prose that _describes_ a structure parses to
  zero sections, and the create still returns 200 — a content type that generates
  against no structure at all, with nothing to indicate it. Prose that reads like
  one long instruction is worse: it derives a single section whose title is the
  whole paragraph. `template_spec`, meanwhile, is validated field by field and
  then discarded, so setting it costs a round trip per field and changes nothing.
  All three examples are now a real markdown template that can be pasted as-is,
  and the descriptions say what `template` is and that `template_spec` is
  derived.

- **`senso org set-industry` no longer says the choice is permanent.** Its
  description claimed the industry could be set ONCE and that changing it
  afterwards was not self-serve, and it translated a 409 into "contact Senso
  support". The API does not work that way: the write overwrites whatever is
  there, the handler has no conflict branch at all, and a repeat call returns 200. The claim came from the spec, which has since been corrected. The command
  now describes what actually happens — an organization that already has an
  industry can change it, prompts already imported stay, and the run history
  copied onto them is kept; what changes is which industry's results the
  organization reads from then on. The 409 special case is gone, so a conflict
  that did appear would be reported by the generic handler rather than as advice
  to contact support.

- **`senso industries answers` says why the list is empty.** The endpoint answers
  200 with an empty list and the reason in `notes` when there is nothing to
  show; those notes were discarded, leaving a bare "No results." They are now
  reported on stderr, where diagnostics belong, and suppressed under `--quiet`
  and `--output json`, whose payload already carries them.

## [0.17.1] — 2026-09-18

### Added

- **`senso credits history` — where the credits went, day by day.** A trailing
  window of daily spend plus the total across it, over `GET
/org/credits/history`. `--days` takes 1-365 and defaults to the server's own
  30; a value outside that is a usage error here rather than a 400 from the API.
  Every day in the window is present, so a day with no spend comes back as `0`
  and a chart has no gaps to fill; the last entry is today and is still
  accumulating. `--output json` carries the whole envelope, `period_usage`
  included, because the total is not one of the rows.

- **`senso industries answers <industry>` — what the AI models actually say.**
  The newest stored answer for each of your industry's prompts, from each model
  at each location, with the full response text, over `GET
/org/industries/{id}/answers/latest`. Every answer records whether it named
  your brand, at what rank, in what tone, and with what share of the brand
  mentions, plus the brands and citations it carried. This is how you find the
  prompts a model answers without you: `--mentioned false --models <one model>`.
  Filters for `--models`, `--location`, `--prompt-ids`, `--since` and
  `--include-empty`, paged with `--limit` and `--offset`. Only your own
  organization's industry can be read, so any other id is a 404. There is no
  date window — each prompt, model and location has exactly one newest answer,
  and `--since` hides combinations whose newest answer is older than that day
  rather than returning older ones. `--models`, `--prompt-ids`, `--since`,
  `--mentioned`, `--limit` and `--offset` are all validated before the request,
  because each is applied server-side before paging: a typo would otherwise come
  back as a perfectly plausible empty answer list.

- **`senso whoami` says which of the three sources supplied the key it used.**
  A new `apiKeySource` field — `flag`, `env` or `config` — next to the
  organization, and the same thing named beside the key in the plain rendering.
  The environment outranks the stored file, so `senso login` can store a key
  that no later command sends: log in as one organization, have `SENSO_API_KEY`
  exported in a shell profile, and every command quietly reaches a different
  one. `whoami` already re-verified against the API, so it was honest about
  which organization; it is now also honest about why that key was chosen.

- **`senso whoami` reports a second, different key that is being shadowed.** A
  new `apiKeyShadowedSources` list, and the same thing on stderr. Knowing the
  key came from the environment is only half the answer: "the environment holds
  the only key" is the ordinary CI setup, and "the environment is shadowing the
  key this user just logged in with" is almost always a mistake, and the two
  were indistinguishable. Silent, and the field omitted, when nothing is
  shadowed or when two sources hold the same key — a warning that fires on
  every ordinary run is one the next reader learns to skip. Suppressed under
  `--quiet` and `--output json`, where the payload carries the same fact and
  where stderr has to stay parseable as the JSON error object.

- **`senso login` warns when `SENSO_API_KEY` would override the key it just
  stored.** On stderr, non-fatal: the key is still written and the command still
  exits 0. It stays quiet when the variable is unset, empty, or holds the same
  key, none of which change what any command does.

  Precedence itself is unchanged — `--api-key`, then `SENSO_API_KEY`, then the
  config file, as documented. Nothing that relies on the environment variable
  needs to change: it remains the way to authenticate in CI, in a container, and
  anywhere `login` has no terminal to prompt on.

### Fixed

- **`senso login` no longer writes the API key to stdout.** The prompt used
  clack's `text`, which redraws into stdout on every keystroke, so the whole key
  was written there one character at a time — `senso login > install.log`, a CI
  capture or a terminal recording persisted the credential. It now prompts with
  `password`, which masks it. Only a truncated 8-character prefix is ever
  printed, by `whoami`.

- **A config file that is not an object no longer breaks every command.**
  `JSON.parse("null")` succeeds and returns `null`, so the guard in `readConfig`
  never caught it and each `readConfig().x` threw instead. A `config.json`
  holding `null`, a bare string or an array now reads as no configuration at
  all, which is what it is. This defeated the documented escape hatch:
  `--api-key` and `SENSO_API_KEY` are what you reach for when the stored config
  is broken, and they stopped working precisely then.

- **A stored `apiKey` that is not a string no longer breaks every command.** The
  config file is user-editable, so the declared type is a convention rather than
  a guarantee; `{"apiKey": 123}` threw out of the credential resolver. It now
  reads as no stored key, which is what it is.

- **A key is no longer judged by whitespace around it.** `SENSO_API_KEY=$(cat
key.txt)` and a Docker `--env-file` both readily carry a trailing newline.
  HTTP strips it, so the request always worked — but the comparison did not, so
  a key identical to the stored one was reported as shadowed and warned about a
  conflict that did not exist. Keys are now trimmed once, where they are
  resolved, and a whitespace-only value falls through to the next source exactly
  as the empty string already did.

## [0.17.0] — 2026-09-15

### Added

- **`senso uninstall` — remove the CLI and everything it put on the machine.**
  Three steps, in this order: the Senso agent skills that `senso skills
install` installed, found from shipables' own record so a skill installed in
  another project is removed too; the config file holding the API key, and its
  directory if nothing else is in it; then the npm package itself. A skill that
  will not uninstall stops the command before the CLI goes, so there is still a
  `senso` to retry with. It asks first in a terminal and exits 2 without one
  unless `--yes` is passed, so an agent has to mean it. `--dry-run` reports the
  plan and removes nothing, `--keep-skills` and `--keep-config` narrow it, and
  `--output json` gets the outcome as a payload. A key set through
  `SENSO_API_KEY` cannot be removed by a process and is called out instead. If
  npm exits 0 but the file the CLI is running from is still there, the copy
  was not the global npm install, and the command says so and exits 1 rather
  than reporting a removal that did not happen.

### Fixed

- **`senso skills remove` exited 1 without removing anything.** It passed
  `--yes` to `shipables uninstall`, which has no such flag and rejects it as an
  unknown option. The flag is no longer passed; `skills install` still passes
  it, because the install side does take one.

## [0.16.0] — 2026-09-14

### Added

- **`senso gaps` — the gap report, for agents as much as people.** Six
  commands over `/org/gaps`: `list` finds work, `get` reads one gap in full,
  `resolve` records a decision, `answer` and `dismiss` are shortcuts for the
  two common ones, and `undo` retracts a decision. A gap is something the
  knowledge base could not back up: a question nothing answered, a claim
  nothing supports, a contradiction, or an answer somebody flagged. A search
  through the API, the MCP server or this CLI that finds nothing now files one
  too, with origin `api_unanswered_question`.

  `list` returns only `open`, `reopened` and `addressed` gaps unless told
  otherwise. A gap seen once is `weak` and hidden, so new API search gaps need
  `--status weak`, or `--status all` for everything. Filters repeat or take a
  comma list and reach the API as repeated query keys. `get` ends with the exact
  commands to act on that gap, chosen from its problem and status, with its real
  ids filled in. Every decision prints what the gap now is and the `undo`
  command for it. All of that guidance is stderr, so `--output json` is still
  the API's payload and nothing else.

  The resolution matrix is checked before the request: `answered`,
  `content_added` and `content_updated` need `--produced-content-id`, and
  `ruled_claim_correct`, `ruled_document` and `source_irrelevant` need
  `--authority-content-id`, each exiting 2 with the missing flag named.
  Resolving a gap that does not exist exits 4, although the API answers it with
  a 400.

- **`--no-gap-signals` on every search command, and `SENSO_GAP_SIGNALS=off`.**
  Keeps a search out of the gap report by sending `X-Senso-Signals: off`. The
  search still runs, costs credits and is recorded. Use it on probes, tests and
  monitors; leave real questions alone. The flag covers one search and the
  variable a whole session. An unrecognized value in the variable exits 2
  before any request, because the API would read a typo as "eligible" and file
  every probe.

- **`senso evals` — judge text against your organization's ground truth.** Six
  commands: `evaluators` lists what can run and the version each is on; `text`
  judges text you pass with `--text` or `--text-file`; `content` judges the
  latest saved version of a content item; `runs` and `get` read runs; `claims`
  reads the individual judged claims a score is built from.

  Two evaluators. `kb_accuracy` extracts the factual claims a text makes about
  your brand and verifies each against your knowledge base. `brand_alignment`
  grades the text against your brand kit's writing rules, and ends `failed` if
  the brand kit has none. Checking one text for both is two runs, so that one
  score never covers for the other. Judge model spend is recorded on each run
  but is not billed against your credit balance.

  A trigger returns a queued run to read later with `evals get`. `--wait` polls
  until the run finishes instead. A run that ends `failed` under `--wait` exits
  1 with an empty stdout, so a caller that waited and got exit 0 can trust the
  score it was handed; without `--wait` a queued run is the expected answer and
  exits 0.

  `--from` and `--to` on `runs` and `claims` are RFC 3339 instants
  (`2026-09-01T00:00:00Z`), not the `YYYY-MM-DD` dates the analytics and
  industries commands take, and a plain date is a usage error rather than a
  round trip. `--evaluator` and `--subject-type` are deliberately unrestricted
  there: subjects include `question_run` and `search_turn` as well as `inline`
  and `content`.

- **`senso industries` — the industry catalog, readable with your own key.**
  Seven commands over `/org/industries/*`: `list` browses the public catalog
  with `--search`, `--live`, `--sort` and paging; `prompts` lists the prompts an
  industry runs; `brands` is the brand leaderboard, with `--no-canonicalize`,
  `--rollup parent` and `--entity-type` to shape it; `brand` and `brand-by-id`
  look one brand up; `domain` looks up a domain's citations; `import-prompts`
  copies prompts from your own industry into your organization.

  Reads accept any industry in the public catalog, not only your own, and the
  `<industry>` argument takes a UUID, a name or a slug — a UUID is used as-is, a
  name costs one search first. `brand` and `domain` answer `mentioned: false` and
  `cited: false` rather than a 404 when there is nothing to report, so exit 0
  means the question was answered, not that the brand was found.

  `import-prompts` accepts 1–100 ids and is restricted to your own industry. It
  ACTIVATES the organization and starts its scheduled runs, so it is the one
  command in the group with a side effect beyond reading. Re-running is safe:
  prompts already held are skipped.

- **`senso history-imports list` and `senso history-imports get`.** Follow the
  run-history import that `industries import-prompts` starts. A `completed`
  import may have copied nothing, so `prompts_count` and
  `historic_runs_imported` sit next to the status in the default table rather
  than leaving the status to be read on its own.

- **`senso org set-industry <industryId>`.** Sets the industry your organization
  belongs to, from the catalog at `senso industries list`. It creates no
  prompts and starts no runs. It can be done ONCE — afterwards the API answers
  409 and changing it is not self-serve — so the 409 is reported with the
  server's own message naming the industry already in place, rather than as a
  conflict worth retrying.

- **`senso generate industry-draft`.** Drafts a whole document from one of your
  industry's prompts in a single synchronous call, grounded in your knowledge
  base and written in a content type you choose. Returns GitHub Flavored
  Markdown with citations rather than storing content. It takes 10–30 seconds
  and consumes credits, so `--audience`, `--style-tone`, `--extra-instructions`
  and `--product-line-ids` are length-checked before the request goes out.

### Changed

- **`senso industries` now reads `/org/*`; the partner commands moved to `senso
partner`.** The six partner-network commands are unchanged apart from their
  name: `senso industries list` is now `senso partner industries list`, and so on
  for `summary`, `brand`, `domain` and `prompt-metrics`, while
  `senso industries glossary` is now `senso partner glossary`. They still need a
  PARTNER API key.

  The name moved because almost every caller has an organization key and wants
  the org-scoped view; giving that the obvious name and putting the partner-only
  commands behind `senso partner` makes the key each one needs legible from the
  command itself. **Update any script calling `senso industries` for
  partner-network data.**

## [0.15.0] — 2026-09-13

### Added

- **`senso website-import start` and `senso website-import status`.** One call
  seeds the knowledge base from your organization's own public site: it fetches
  the home page plus up to ten linked pages, ingests each as a document under a
  folder named `Website`, and drafts a brand kit if the organization has none.
  The site is the one on file at `senso org get`, not a value you pass, so
  `start` takes no arguments.

  `start` waits for the import to finish and exits 1 if it ends in a failed
  state, so a caller that gets exit 0 can trust that it worked; `--no-wait`
  returns the accepted run instead. `status` is a read and exits 0 whatever it
  finds, including a previous failure. The completion signal is the status
  endpoint's `current` going null rather than a terminal status on the run
  itself — a finished import leaves `current` and reappears as
  `latest_completed`, so waiting on `current.status` would wait forever. A
  brand kit left alone because one already exists is reported as the success it
  is, not a failure. Triggering while an import is already running keeps the
  CLI's standard 409 handling — exit 1 — with a hint pointing at `status`.

  Both endpoints are in this repository's copy of the spec but not yet in the
  published one, so `scripts/spec-drift.ts` reports them until that lands;
  `docs/reference/excluded-endpoints.md` carries a row saying so.

### Fixed

- **`org update` now says that `websites` and `locations` replace the list.**
  The help described the body as "only provided fields are changed", which is
  true field by field and dangerously incomplete list by list: `PUT /org/me`
  swaps `websites` wholesale for whatever you send, so an org with three
  websites that is sent one is left with one — no error, exit 0. That is the
  worst shape of failure for this CLI's primary consumer, an agent, which reads
  the help and sends the single entry it was asked to add. Both the description
  and the `--data` help now name the replace semantics, say to read `org get`
  first and send back everything worth keeping, and note that the
  `org_website_id` you get from `org get` is rejected on the way back in.

- **`ingest upload` pointed at the one command that cannot poll it.** Its help
  told you to poll `senso content get <content-id>` until `processing_status`
  was `complete`. That command is `GET /org/content/{id}`, which the API spec
  documents as serving non-knowledge-base content only and answering `400` for
  anything in the knowledge base — which is everything `ingest upload` creates.
  An agent following the instruction printed on the command got a hard failure,
  and on an org without the GEO product it failed for a second, unrelated
  reason. Both `ingest upload` and `kb upload` now name `senso kb get
<kb-node-id>` and `content.processing_status`, which is what the spec itself
  prescribes for a KB node.

- **The upload payload now carries `kb_node_id`, the id that poll takes.**
  `ingest upload`'s table rendered `content_id` and nothing else, so the id the
  corrected instruction needs was absent from the output of the command that
  produces it — the two are different id spaces, and `content_id` 404s against
  the `kb` commands. It is now the column before `content_id` in both upload
  commands, and declared on `UploadResultItem` rather than reaching JSON callers
  only because `apiRequest` casts instead of validating.

## [0.14.0] — 2026-09-11

### Added

- **`kb my-files`, `kb find` and `kb children` accept the filters the API has
  always offered.** Five of the eight shared query parameters were never wired
  up: `--status`, `--sort-by`, `--sort-order`, `--tag-ids` and `--role`. The
  absences were not cosmetic — without `--status` there was
  no way to list the documents whose ingestion failed, and without `--sort-by`
  no way to order a page at all. The closed sets are validated locally, so
  `--status archived` now exits 2 naming the valid values instead of spending a
  round trip on a 400. `--limit` is checked for being a whole number of at least
  1 but deliberately not capped at 50: the API documents higher values as capped
  rather than rejected, and it silently read a non-numeric limit as 50.

- **Search results now show the KB node ID, so a hit can be acted on.** The
  search endpoints return `kb_node_id` alongside `content_id`, and the CLI
  surfaces it first in every rendering. It is the id the rest of the CLI takes:
  `kb get`, `kb rename`, `kb move` and `kb delete` all address a node, and
  `content_id` is a different id space that 404s against them. `content_id` is
  still shown, because it is what `--content-ids` accepts — the two ids answer
  different questions: what to read next, and what to scope the next search to.
  `senso search <query>`'s plain output previously labelled `content_id` as
  plain `ID:`, which is the one id that does not work with any `kb` command.

### Fixed

- **`brand-kit set` and `brand-kit patch` check the guidelines before sending
  them.** `guidelines` is a closed six-key object at the API — `brand_name`,
  `brand_domain`, `brand_description`, `voice_and_tone`, `author_persona` and
  `global_writing_rules` — and every violation used to cost a round trip to
  discover. Worse, the two endpoints report the same failure differently: PATCH
  passes the field name through, PUT flattens everything to
  `Invalid guidelines data`, so the one thing you needed was the one thing
  dropped. An unknown key, a wrong type, a `null`, a missing `guidelines`
  envelope or a patch with nothing in it now exits 2 with the field named, and a
  near-miss key suggests the one you meant. Two checks are deliberately stricter
  than the server, because there the leniency loses data silently: a key left
  beside `guidelines` is accepted and ignored, and a `null` inside
  `global_writing_rules` is accepted and stored.

- **`search context`, `search full` and `search content` render a table again
  under `--output table`.** They printed the entire response as a single
  key/value blob, with the hits stuffed into one `value` cell as raw JSON,
  because a search payload carries `query` and `search_type` beside its list and
  the list-detection rule deliberately refuses anything that is not a list plus
  pagination metadata. The three variants now pass their rows explicitly, as
  `senso search <query>` already did.

- **The raw-content `--data` help no longer promises tagging that does not
  happen.** All three commands advertised `tag_ids`. On `kb create-raw` the API
  accepts the field and discards it — the document is auto-tagged from its
  content instead — so the flag silently did nothing and the help now says so.
  On `kb update-raw` and `kb patch-raw` it does work, but it _replaces_ the whole
  tag set rather than adding to it; omit it to keep the current tags, pass `[]`
  to clear them, and note that every ID must already exist or the entire update
  is rejected. Both descriptions also now mention that re-ingestion re-runs
  auto-tagging, which can add tags of its own after the call returns.

- **A version bump no longer fails CI.** The generated command reference named
  the package version, so every `npm version` left it stale and the release
  commit failed the test that keeps it current. That is what stopped 0.13.0 from
  publishing. The reference no longer names a version.

## [0.13.0] — 2026-09-10

### Changed — breaking for anything that reads output or exit codes

- **The minimum Node version is now 20.12.** It was advertised as 18, but that
  had already stopped being true: upgrading dependencies raised the real floor
  to 22.12 without anything noticing, because the only thing that would have
  noticed was a test on the floor and the test runner cannot run there. Node 18
  reached end of life on 2025-04-30 and receives no security fixes, so the floor
  moves up rather than pinning dependencies back to support it — `commander` is
  held one major back at 14 so the floor is 20 rather than 22, which keeps Node
  20 users, who are still in maintenance until 2026-04-30.

  `engines` now says `>=20.12.0` precisely, not `>=20`: `@clack/prompts` imports
  `styleText` from `node:util`, added in 20.12, and it loads on every
  invocation. Verified against Node 20.11 (fails) and 20.12 (works). A policy
  test now compares the declared floor against every runtime dependency's own
  requirement, so an `engines` field that promises more than the dependencies
  deliver fails the build.

- **stdout now carries the payload and nothing else.** The banner, progress
  spinners, success ticks, warnings and errors all moved to stderr. In
  particular the banner used to be printed to stdout, so
  `senso ... --output json | jq` failed unless you also passed `--quiet`. It no
  longer does, and `--quiet` is no longer needed for machine use.

- **Exit codes now say what went wrong.** Every failure used to exit 1. Now:
  `0` success, `1` API or runtime error, `2` usage error, `3` authentication,
  `4` not found, `5` network failure or timeout. A script that tested for
  `exit != 0` is unaffected; one that tested for `exit == 1` should be reviewed.

- **`--output` is honored by every command.** Twenty-seven of thirty command
  files previously ignored it and printed JSON regardless of what was asked for.
  If you relied on `--output table` producing JSON, it now produces a table.

- **`--output table` renders a single object** as a two-column key/value table
  rather than silently falling back to JSON, and no longer prints
  `[object Object]` for a nested field.

- **Errors are structured under `--output json`.** A failure writes
  `{"error":{"code","message","status?","hint?"}}` to stderr and leaves stdout
  empty. `error.code` is a stable identifier; branch on it rather than on the
  message.

- **Invalid flag values now fail before the request is made,** with exit 2 and
  the valid values named. `--match-type`, `--tier`, `--priority`, `--status`,
  `--type` and `--sort` on the commands that document a closed set were
  previously forwarded to the API unchecked. One of these was worse than a
  wasted round trip: `generated-content --status` mapped any unrecognized value
  to `published`, so a typo returned a plausible-looking wrong list.

### Fixed

- **`senso kb get-content --version` and `senso kb download-url --version` were
  unreachable, and are now `--rev`.** The root command declares `-v, --version`
  for the CLI's own version and Commander answers it wherever it appears, so
  `senso kb get-content <id> --version 3` printed the CLI version and exited 0
  without making a request. Both flags were documented and neither ever worked.
  Pass `--rev <n>` instead; the request is unchanged (still `?version=<n>`).
  Renaming a documented flag would normally be breaking — this one is not, since
  no invocation of it can ever have done what it said.

- **`senso kb upload` flattened every failure to exit 1.** A rejected API key, a
  missing destination folder and an unreachable API all arrived as 1, so a script
  could not tell them apart. Only a whole-batch rejection is unpacked now (still
  exit 1, with the per-file reasons); everything else keeps its own code — `3`
  authentication, `4` not found, `5` network — as `senso ingest upload` already
  did.

- **`senso kb upload` accepted files `senso ingest upload` refuses.** A path that
  does not exist was a raw `ENOENT` at exit 1, and a zero-byte file was uploaded
  for an ingestion worker that cannot parse it. Both are now usage errors (exit 2) naming the file, before anything is sent.

- **`senso ingest reprocess <node-id> <file>` exited 1 on a path that does not
  exist,** where `senso ingest upload` exits 2. It now exits 2 and names the
  file, so the same mistake has the same exit code in both commands.

- **`senso content verification --status` and `--substatus` were not validated.**
  Both document a closed set in their help text and forwarded anything, so a typo
  cost a round trip and came back as a server-side validation error. They now
  fail at exit 2 with the valid values named, like the other closed-set flags.

- **`senso login` hung forever without a terminal.** It waited on a keypress
  that could never arrive, so it stalled CI and agent shells indefinitely. It now
  exits 2 immediately and names the two ways to authenticate that need no
  terminal.

- **`senso skills install` reported success when every skill failed to install.**
  It now exits non-zero if any skill failed, and reports which.

- **`senso skills install --all` installed six of the seven official skills.**
  `senso-onboarding` was published but never added to the CLI's list. A policy
  test now compares the list against a fixture.

- **`senso ingest upload` crashed on an empty confirmation.** Pressing Enter at
  the "type yes or no" prompt called `.trim()` on `undefined`.

- **`--output table` dropped a column** that the first row happened to omit,
  which is normal for these responses. Columns are now the union of every row's
  keys.

- **A single object containing a list rendered as only that list.** `senso org
get` showed the organization's locations and silently dropped its name, slug
  and tier from `plain` and `table` output.

- **A malformed `errors[]` in an API error body produced
  `undefined: undefined`** instead of the server's message.

- **`--output=json`** (the equals form) was not recognized by the quiet
  detection, so a banner still appeared.

- **A connection failure worded "Failed to fetch"** rather than Node's "fetch
  failed" was classified as a generic error, losing the exit-5 retry signal.

- **The update check ran on `--version` and `--help`,** reaching the npm registry
  and creating the config directory as a side effect. It no longer runs for
  either, nor for `login`, `logout` or `update`, and its timeout dropped from 10
  seconds to 3 — it is fired without being awaited, so that timeout was the
  worst-case delay between a command printing its output and the process exiting.

### Added

- **`senso ctas`** — call-to-action templates, the card a published
  content-engine page carries. List, create, update and delete templates; set or
  clear the organization default; read and set the CTA a single content item
  carries (`ctas for-content`, `ctas set-for-content`); and get a pre-signed
  upload URL for a CTA image (`ctas upload-url`). Requires the GEO product.

- **`senso kb stats`, `senso kb bulk-delete` and `senso kb permissions`.**
  `stats` returns the document and folder counts without paging through
  `my-files`; `bulk-delete` removes up to 100 nodes in one all-or-nothing call
  and refuses a larger batch before sending it; `permissions list|add|update|remove`
  manages the viewer and editor grants on a node.

- **Five `senso content` commands for the GEO reporting surface**:
  `provenance --url` audits how one published URL came to exist,
  `verification-velocity` reports publish-to-citation timing across the
  organization, `citation-details <id>` and `citation-prompts <id>` break one
  published item's citations down by destination and by prompt, and
  `record-edits <id> --data` bulk-records Builder edit telemetry.

- **`senso run-config model-options`, `scheduler-models` and
  `set-scheduler-models`.** The options command lists the model names
  `set-models` accepts, so an unsupported name no longer costs a round trip. The
  scheduler set is separate from the run-models list, though writing run models
  also replaces it.

- **`SENSO_DEBUG=1`** logs every request, its status and its duration to stderr,
  with the API key redacted.

- **`SENSO_CONFIG_DIR`** relocates the configuration file. Useful for
  per-project credentials, and it is what lets the test suite run without
  touching a real one.

- **An exit-code and environment-variable table in `senso --help`,** because the
  caller most likely to branch on an exit code is an agent, and `--help` is what
  an agent reads.

- **A test suite.** Unit tests for the library modules, in-process command tests
  for every command group against a mock API, an end-to-end suite that drives the
  built bundle as a subprocess, and policy tests that enforce this repository's
  own rules. There were previously no tests of any kind, and CI passed because
  it ran vitest with `--passWithNoTests`.

- **A CI pipeline that means something**: lint, typecheck, security, unit,
  end-to-end across three operating systems and four Node versions, build, and a
  smoke test that packs the tarball and installs it clean. It needs no secrets,
  so pull requests from forks run the full suite.

- **A Makefile** as the single contract between a developer's machine and CI.

- **Security scanning**: `npm audit`, semgrep, and gitleaks over the full git
  history with a deliberately empty allowlist.

- **`docs/`**, a generated command reference, `CONTRIBUTING.md`, `SECURITY.md`,
  `CLAUDE.md`, this changelog, `CODEOWNERS`, Dependabot, and pull request and
  issue templates. The repository previously had none of them.

- ESLint 9 with type-aware rules, Prettier, `.editorconfig`, `.nvmrc`, and
  optional pre-commit hooks.

### Internal

- Every command action is routed through a single `runAction` wrapper, replacing
  the eight lines of try/catch/format/exit that each of ~150 actions repeated.
  Commands throw instead of calling `process.exit`, which is what makes them
  testable in-process.
- `createProgram()` builds the command tree with no side effects; importing it no
  longer runs the CLI.
- `src/commands/analytics.ts` (1,299 lines) became `src/commands/analytics/`,
  one file per subcommand, with no behavior change.
- Every dependency moved to its current major. TypeScript is pinned at 5.9
  because no typescript-eslint release supports 7 yet.

## [0.12.0] — 2026-09-08

### Added

- `senso analytics` — the organization GEO analytics API: summary, mentions,
  citations, cited domains and pages, per-prompt performance, latest answers, a
  metric glossary, and the filter values that have data.
- `senso industries` — partner-scoped competitive intelligence. Requires a
  partner API key; the organization key is rejected.
- GitHub Actions CI and automated npm publishing via trusted publishing (OIDC),
  with no token secret.

## [0.11.0] — 2026-08

### Added

- Tags, product lines, and automatic tagging.
- Tracked competitors and citation-classification rules (`tracked-sources`).

## [0.9.0] — 2026-07

### Added

- Asynchronous sample-generation jobs, with polling.
- Streaming search, an interactive knowledge base folder picker, and an overhaul
  of the upload experience.

## [0.8.0] — 2026-06

### Added

- The agent skills installer (`senso skills`).

## [0.6.0] — 2026-05

### Added

- Knowledge base commands, credits, search scoping, and agent-friendly help text.

### Fixed

- Silent S3 upload failures in `ingest` and `kb upload` are now surfaced.

## [0.2.0] — 2026-04

### Added

- First published release: authentication, search, content, ingestion,
  organization administration, and self-update.

[Unreleased]: https://github.com/AI-Template-SDK/senso-user-cli/compare/v0.17.4...HEAD
[0.17.4]: https://github.com/AI-Template-SDK/senso-user-cli/compare/v0.17.3...v0.17.4
[0.17.3]: https://github.com/AI-Template-SDK/senso-user-cli/compare/v0.17.2...v0.17.3
[0.17.2]: https://github.com/AI-Template-SDK/senso-user-cli/compare/v0.17.1...v0.17.2
[0.17.1]: https://github.com/AI-Template-SDK/senso-user-cli/compare/v0.17.0...v0.17.1
[0.17.0]: https://github.com/AI-Template-SDK/senso-user-cli/compare/v0.16.0...v0.17.0
[0.16.0]: https://github.com/AI-Template-SDK/senso-user-cli/compare/v0.15.0...v0.16.0
[0.15.0]: https://github.com/AI-Template-SDK/senso-user-cli/compare/v0.14.0...v0.15.0
[0.14.0]: https://github.com/AI-Template-SDK/senso-user-cli/compare/v0.13.0...v0.14.0
[0.13.0]: https://github.com/AI-Template-SDK/senso-user-cli/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/AI-Template-SDK/senso-user-cli/compare/v0.11.1...v0.12.0
[0.11.0]: https://github.com/AI-Template-SDK/senso-user-cli/compare/v0.9.0...v0.11.0
[0.9.0]: https://github.com/AI-Template-SDK/senso-user-cli/compare/v0.8.2...v0.9.0
[0.8.0]: https://github.com/AI-Template-SDK/senso-user-cli/compare/v0.7.0...v0.8.0
[0.6.0]: https://github.com/AI-Template-SDK/senso-user-cli/compare/v0.5.0...v0.6.0
[0.2.0]: https://github.com/AI-Template-SDK/senso-user-cli/releases/tag/v0.2.0
