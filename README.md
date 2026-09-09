# Senso CLI

> Infrastructure for the Agentic Web

The official command-line interface for [Senso](https://docssenso.ai). Search your knowledge base, manage content, and control your entire Senso organization — directly from the terminal.

Built for **AI agents** (Claude Code, Gemini CLI, Codex) and **developers** who want fast, scriptable access to their Senso workspace.

---

## Quick Install

Requires **Node.js 18+**. Works on **Linux**, **macOS**, and **Windows**.

```bash
npm install -g @senso-ai/cli
```

Verify it works:

```bash
senso --version
```

> **One-off usage** — If you just want to try it without installing globally:
>
> ```bash
> npx @senso-ai/cli --help
> ```

## Quick Start

### 1. Authenticate

Get an API key from [docs.senso.ai](https://docs.senso.ai), then:

```bash
senso login
```

The interactive prompt will walk you through pasting your key and verifying it against your organization.

Alternatively, set an environment variable (useful for CI and AI agents):

```bash
export SENSO_API_KEY=tgr_your_key_here
```

### 2. Search your knowledge base

```bash
senso search "What are the current mortgage rates?"
```

### 3. List your content

```bash
senso content list
```

That's it. Every endpoint in the Senso Org API is available as a CLI command.

---

## Platform Support

| Platform | Supported | Config Location |
|----------|-----------|-----------------|
| **Linux** | Node 18+ | `~/.config/senso/config.json` |
| **macOS** | Node 18+ | `~/Library/Preferences/senso/config.json` |
| **Windows** | Node 18+ | `%APPDATA%\senso\config.json` |

Config paths are handled automatically via XDG-compatible directories. The config file stores your API key, org info, and update check timestamps with owner-only permissions (`0600`).

---

## Usage with AI Agents

The CLI is designed as a first-class tool for AI LLM agents. Pass `--output json` to get structured output and `--quiet` to suppress banners:

```bash
# Claude Code / Gemini CLI / Codex can call this directly
senso search "customer refund policy" --output json --quiet

# Pass API key inline (no config file needed)
senso search "billing FAQ" --api-key tgr_... --output json --quiet
```

### Auth Priority

The CLI resolves credentials in this order:

1. `--api-key` flag (highest priority)
2. `SENSO_API_KEY` environment variable
3. `~/.config/senso/config.json` stored key
4. Interactive prompt (first-run only)

For non-interactive use (CI, agents), set the env var or pass the flag.

---

## Commands

### Authentication

```
senso login                          Authenticate with Senso (interactive)
senso logout                         Remove stored credentials
senso whoami                         Show current org and auth status
```

### Search

```
senso search <query>                 Semantic search with AI-generated answer + source chunks
senso search context <query>         Chunks only (no AI answer, faster)
senso search content <query>         Content IDs only (deduplicated)
```

Options: `--max-results <n>`

### Content

```
senso content list                   List all knowledge base items
senso content get <id>               Get full content detail by ID
senso content versions <id>          List version history for a content item
senso content delete <id>            Delete content (knowledge base + external)
senso content unpublish <id>         Unpublish and revert to draft
senso content verification           List items in verification workflow
senso content verification-counts    Counts by status + published-domain summaries
senso content reject <versionId>     Reject a content version
senso content restore <versionId>    Restore rejected version to draft
senso content owners <id>            List owners of a content item
senso content set-owners <id>        Replace owners (--user-ids)
senso content remove-owner <id> <userId>  Remove a single owner
```

Options: `content list` supports `--limit`, `--offset`, `--search`, `--sort`. `content verification` supports `--limit`, `--offset`, `--search`, `--status`, `--substatus`. `content reject` supports `--reason`.

### Generated Content (GEO)

```
senso generated-content list         List published or draft generated content (--status published|drafts)
senso generated-content get <id>     Get a generated content item with its rendered body
```

Options: `generated-content list` supports `--status`, `--limit`, `--offset`, `--search`.

### Content Generation

```
senso generate settings              Get generation settings
senso generate update-settings       Update generation settings (--data)
senso generate sample                Generate sample for a prompt; waits for async job by default (--prompt-id, --content-type-id, --no-wait)
senso generate run                   Trigger a content engine run (--prompt-ids)
```

### Content Engine

```
senso engine publish                 Publish content to external destinations (--data)
senso engine draft                   Save content as draft for review (--data)
```

### Tracked Competitors & Sources

```
senso competitors list               List tracked competitors
senso competitors add                Add a competitor (--name, --url)
senso competitors suggest            Get AI-generated competitor suggestions
senso competitors batch-add          Add up to 50 competitors (--data)
senso competitors update <id>        Update a competitor (--name, --url)
senso competitors delete <id>        Remove a competitor

senso tracked-sources list           List citation-classification rules
senso tracked-sources add            Add a rule (--pattern, --match-type, --tier)
senso tracked-sources update <id>    Replace a rule (--pattern, --match-type, --tier)
senso tracked-sources delete <id>    Remove a rule
```

Options: `tracked-sources add`/`update` support `--category`, `--label`, `--priority`; `update` also supports `--active`/`--no-active`. `--match-type` is one of `domain | host | path_prefix | exact_url`; `--tier` is one of `primary | tracked | secondary`.

### Ingestion

```
senso ingest upload <files...>       Upload files to knowledge base (up to 10)
senso ingest reprocess <contentId> <file>  Re-ingest content with new file
```

### Brand Kit & Content Types

```
senso brand-kit get                  Get brand kit guidelines
senso brand-kit set                  Create or replace brand kit (--data)

senso content-types list             List content types
senso content-types create           Create a content type (--data)
senso content-types get <id>         Get content type by ID
senso content-types update <id>      Update a content type (--data)
senso content-types delete <id>      Delete a content type
```

Options: `content-types list` supports `--limit`, `--offset`.

### Prompts

```
senso prompts list                   List prompts (geo questions)
senso prompts create                 Create a prompt (--data)
senso prompts get <promptId>         Get prompt with run history
senso prompts delete <promptId>      Delete a prompt
```

Options: `prompts list` supports `--limit`, `--offset`, `--search`, `--sort`.

### Analytics (GEO)

Read-only metrics for your own organization: how often the AI models name your brand, your share of every brand mention the models made, and which domains and pages get cited. Works with the organization API key from `senso login`.

```
senso analytics summary              Headline metrics + previous window + deltas
senso analytics mentions             Visibility time series (day or week buckets)
senso analytics citations            Citation rates and shares, with the series
senso analytics domains              Cited domains, ranked (coverage + share)
senso analytics pages                Cited pages, with the prompts driving them
senso analytics prompts              Per-prompt performance table
senso analytics prompt <promptId>    One prompt: history + latest full answers
senso analytics answers              Latest answer per prompt × model × location
senso analytics glossary             Canonical definition of every metric
senso analytics filters              Filter values that have data for this org
```

Options:

| Command | Options |
|---------|---------|
| all except `prompt <promptId>`, `glossary`, `filters` | `--from`, `--to`, `--models`, `--location`, `--prompt-type`, `--tag` |
| `mentions`, `citations` | `--group-by <day\|week>` |
| `domains` | `--tier`, `--domain-contains`, `--sort <citations\|coverage>`, `--limit`, `--offset` |
| `pages` | `--tier`, `--domain`, `--domain-contains`, `--url-contains`, `--sort <citations\|coverage>`, `--limit`, `--offset` |
| `prompts` | `--search`, `--sort <mention_rate\|share_of_voice\|citations\|answered\|text>`, `--order <asc\|desc>`, `--limit`, `--offset` |
| `prompt <promptId>` | `--from`, `--to`, `--models`, `--location`, `--no-include-answers` |
| `answers` | `--from`, `--to`, `--models`, `--location`, `--prompt-type`, `--tag`, `--mentioned <bool>`, `--cited <bool>`, `--citation-tier <primary\|tracked\|secondary>`, `--limit`, `--offset` |

`--from`/`--to` are `YYYY-MM-DD` and default to the 30 days ending at the most recent day that has data for your model/location filter (max window: 365 days). `--models` and `--location` are comma-separated; locations are case-sensitive exact codes (`US`, `US/California`) — the API also accepts `locations` as an alias for the `location` query param. Run `senso analytics filters` to see the values that actually have data.

`analytics answers` is a snapshot, not a window. It always returns the newest stored answer per prompt × model × location, and `--from`/`--to` filter on `run_at` — when that answer was collected. Narrowing the window therefore **hides** prompt × model × location combinations whose latest answer falls outside it; it does not return older answers in their place. Use `analytics mentions` or `analytics citations` for history.

Reading the numbers:

- **Share of Voice** is your mention instances ÷ `brand_mention_total` — mentions of *every* brand the models named, not just your tracked competitors. It matches the Share of Voice in the Senso app. `tracked_mention_total` is still returned as a raw count in `totals`, but it is not the denominator.
- **Citation Rate** and **Citation Coverage** divide by `D` — answers with at least one citation. **Citation Share** divides by `S` — total citation instances. They are different metrics on different denominators; every table shows the numerator and denominator next to the percentage so you can check.
- The three tier **rates** are independent and can sum past 100% (one answer can cite an owned page and an external page). The three tier **shares** partition and sum to exactly 100%.
- A metric renders as `—` when its denominator was zero. That is "not measured", not 0%.
- Every response carries `notes[]` — caveats about window truncation, null denominators and tracking-set dependence. They are printed under a **Notes** heading in `plain` and `table` output, and are part of the payload in `--output json`.
- `senso analytics glossary` is the canonical definition, denominator and gotcha for every metric.

### Industry Intelligence (partner key required)

```
senso industries list                List industries visible to the partner
senso industries summary <industry>  Industry overview over a time window
senso industries brand <industry> <brandName>    One brand within an industry
senso industries domain <industry> <domainOrUrl> Domain/URL citation lookup
senso industries prompt-metrics <industry>       Per-prompt industry metrics
senso industries glossary            Competitive-intelligence metric glossary
```

These commands read partner-scoped endpoints and **require a partner API key**. The organization key stored by `senso login` is rejected with a 401/403 — pass a partner key with `--api-key <key>` or `SENSO_API_KEY`. For metrics about your own organization, use `senso analytics` instead.

Options: all except `list` and `glossary` support `--from`, `--to`, `--location`, `--models`; `prompt-metrics` also supports `--limit`, `--offset`; `list` supports `--search`. The `<industry>` argument accepts a UUID or a name (e.g. `"Automotive"`).

### Organization

```
senso org get                        Get organization details
senso org update                     Update organization details (--data)

senso users list                     List users
senso users add                      Add a user (--data)
senso users get <userId>             Get user details
senso users update <userId>          Update a user's role (--data)
senso users remove <userId>          Remove a user
senso users set-current <userId>     Set org as current for a user

senso api-keys list                  List API keys
senso api-keys create                Create API key (--data)
senso api-keys get <keyId>           Get API key details
senso api-keys update <keyId>        Update API key (--data)
senso api-keys delete <keyId>        Delete API key
senso api-keys revoke <keyId>        Revoke API key

senso members list                   List organization members
```

Options: `users list` supports `--limit`, `--offset`. `api-keys list` supports `--limit`, `--offset`. `members list` supports `--limit`, `--offset`, `--search`, `--sort`.

### Run Configuration

```
senso run-config models              Get configured AI models
senso run-config set-models          Set AI models (--data)
senso run-config schedule            Get run schedule (days of week)
senso run-config set-schedule        Set run schedule (--data)
```

### CLI Management

```
senso update                         Update to the latest version
senso --version                      Show current version
senso --help                         Show help
```

---

## Global Options

| Flag | Description |
|------|-------------|
| `--api-key <key>` | Override API key (or set `SENSO_API_KEY` env var) |
| `--base-url <url>` | Override API base URL (default: `https://apiv2.senso.ai/api/v1`) |
| `--output <format>` | Output format: `json`, `table`, or `plain` (default: `plain`) |
| `--quiet` | Suppress banners and non-essential output |
| `--no-update-check` | Skip version check (or set `SENSO_NO_UPDATE_CHECK=1`) |
| `-v, --version` | Show version |
| `-h, --help` | Show help |

---

## Output Formats

**Plain** (default — human-friendly):

```
$ senso search "mortgage rates"

Answer: Based on our knowledge base, current mortgage rates are...

Found 3 results:

  1. Mortgage Rate Overview
     Content: Fixed-rate mortgages currently average...
     ID: cnt_abc123
```

**JSON** (for AI agents and scripting):

```
$ senso search "mortgage rates" --output json
{
  "answer": "Based on our knowledge base...",
  "results": [
    {
      "title": "Mortgage Rate Overview",
      "chunk_text": "Fixed-rate mortgages currently average...",
      "content_id": "cnt_abc123"
    }
  ]
}
```

**Table** (for listing resources):

```
$ senso content list --output table

ID           Title                    Status
cnt_abc123   Mortgage Rate Overview   published
cnt_def456   Variable Rate Products   draft
```

---

## Auto-Update

The CLI checks for new versions once every 24 hours (via the npm registry) and shows a notice on stderr if an update is available:

```
╭──────────────────────────────────────────────╮
│                                              │
│  Update available! 0.1.0 → 0.2.0            │
│                                              │
│  Run senso update to update                  │
│                                              │
╰──────────────────────────────────────────────╯
```

Update notices are written to `stderr` so they won't interfere with `--output json` piped to other programs.

To disable: `--no-update-check` or `export SENSO_NO_UPDATE_CHECK=1`.

---

## Development

```bash
# Clone the repo
git clone https://github.com/AI-Template-SDK/senso-user-cli.git
cd senso-user-cli

# Install dependencies
npm install

# Run in dev mode (TypeScript directly via tsx)
npm run dev -- search "test query"

# Build (single ESM bundle via tsup)
npm run build

# Run the built version
node dist/cli.js --help

# Run tests
npm test
```

### Project Structure

```
src/
├── cli.ts                 # Entry point — arg parsing, command dispatch
├── commands/              # One file per command group
│   ├── auth.ts            # login, logout, whoami
│   ├── search.ts          # search, search context, search content
│   ├── content.ts         # CRUD + versions + verification + owners
│   ├── generated-content.ts  # GEO generated content (list, get)
│   ├── generate.ts        # content generation settings + triggers
│   ├── engine.ts          # publish, draft
│   ├── competitors.ts     # tracked competitors CRUD + suggest
│   ├── tracked-sources.ts # citation-classification rules CRUD
│   ├── ingest.ts          # upload, reprocess (with S3 upload)
│   ├── brand-kit.ts       # get, set
│   ├── content-types.ts   # CRUD
│   ├── prompts.ts         # CRUD
│   ├── analytics.ts       # org GEO analytics (summary, citations, prompts, …)
│   ├── industries.ts      # partner-scoped competitive intelligence
│   ├── org.ts             # get, update
│   ├── users.ts           # CRUD + set-current
│   ├── api-keys.ts        # CRUD + revoke
│   ├── members.ts         # list
│   ├── run-config.ts      # models, schedule
│   └── update.ts          # self-update
├── lib/
│   ├── api-client.ts      # HTTP wrapper (native fetch, X-API-Key auth)
│   ├── config.ts          # Config read/write (~/.config/senso/)
│   ├── output.ts          # json/table/plain formatting
│   └── version.ts         # Reads version from package.json
└── utils/
    ├── logger.ts          # Colored log helpers (picocolors)
    ├── branding.ts        # ASCII logo, gradient banner, boxed panels
    └── updater.ts         # npm registry version check
```

### Tech Stack

| Concern | Choice |
|---------|--------|
| Language | TypeScript |
| Runtime | Node.js 18+ |
| Bundler | tsup (esbuild) — single 50KB ESM bundle |
| CLI Framework | Commander.js |
| Interactive Prompts | @clack/prompts |
| Colors | picocolors |
| ASCII Branding | figlet + gradient-string + boxen |
| Config | env-paths (XDG-compatible) |
| HTTP | Native `fetch` |

### Releasing a New Version

This project uses [semantic versioning](https://semver.org/). Publishing to npm is automated: pushing a `v*` tag runs `.github/workflows/publish.yml`, which builds the CLI and publishes it via [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers) (GitHub Actions OIDC, no token secrets). Every pull request and push to `main` runs `.github/workflows/ci.yml` (typecheck, build, tests, smoke test).

```bash
# 1. Bump the version in package.json, commit, and create a git tag
npm version patch   # 0.1.0 → 0.1.1 (bug fixes)
npm version minor   # 0.1.0 → 0.2.0 (new features, backwards-compatible)
npm version major   # 0.1.0 → 1.0.0 (breaking changes)

# 2. Push the commit and tag — the tag triggers the publish workflow
git push --follow-tags
```

The publish workflow refuses to run if the tag does not match the version in `package.json`. Once it finishes, users running the CLI will see the update notice within 24 hours (or immediately via `senso update`).

---

## License

[AGPL-3.0](LICENSE)
