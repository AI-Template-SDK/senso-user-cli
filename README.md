# Senso CLI

> Infrastructure for the Agentic Web

The official command-line interface for [Senso](https://docssenso.ai). Search your knowledge base, manage content, and control your entire Senso organization — directly from the terminal.

Built for **AI agents** (Claude Code, Gemini CLI, Codex) and **developers** who want fast, scriptable access to their Senso workspace.

---

## Quick Install

Requires **Node.js 18+**. Works on **Linux**, **macOS**, and **Windows**.

```bash
# Run directly from GitHub (no install needed)
npx github:AI-Template-SDK/senso-user-cli

# Or install globally
npm install -g senso-user-cli
```

Verify it works:

```bash
senso --version
```

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
senso login                          Save API key (interactive)
senso logout                         Remove stored credentials
senso whoami                         Show current org and auth status
```

### Search

```
senso search <query>                 Semantic search with AI-generated answer
senso search context <query>         Semantic search — chunks only
senso search content <query>         Semantic search — content IDs only
```

Options: `--max-results <n>`

### Content

```
senso content list                   List content items
senso content get <id>               Get content item by ID
senso content delete <id>            Delete content (local + external)
senso content unpublish <id>         Unpublish content
senso content verification           List content awaiting verification
senso content reject <versionId>     Reject a content version
senso content restore <versionId>    Restore a content version to draft
senso content owners <id>            List content owners
senso content set-owners <id>        Replace content owners
senso content remove-owner <id> <userId>  Remove content owner
```

### Content Generation

```
senso generate settings              Get content generation settings
senso generate update-settings       Update content generation settings
senso generate sample                Generate ad hoc content sample
senso generate run                   Trigger content engine run
```

### Content Engine

```
senso engine publish                 Publish content via content engine
senso engine draft                   Save content as draft
```

### Ingestion

```
senso ingest upload                  Request presigned S3 upload URLs
senso ingest reprocess <contentId>   Re-ingest existing content
```

### Categories & Topics

```
senso categories list                List categories
senso categories list-all            List all categories with their topics
senso categories create <name>       Create a category
senso categories get <id>            Get category by ID
senso categories update <id>         Update a category
senso categories delete <id>         Delete a category
senso categories batch-create        Batch create categories with topics

senso topics list <categoryId>       List topics in a category
senso topics create <categoryId>     Create a topic
senso topics get <catId> <topicId>   Get a topic
senso topics update <catId> <topicId> Update a topic
senso topics delete <catId> <topicId> Delete a topic
senso topics batch-create <catId>    Batch create topics
```

### Brand Kit & Content Types

```
senso brand-kit get                  Get brand kit
senso brand-kit set                  Upsert brand kit

senso content-types list             List content types
senso content-types create           Create a content type
senso content-types get <id>         Get content type
senso content-types update <id>      Update content type
senso content-types delete <id>      Delete content type
```

### Prompts

```
senso prompts list                   List prompts
senso prompts create                 Create a prompt
senso prompts get <promptId>         Get prompt with full run history
senso prompts delete <promptId>      Delete a prompt
```

### Organization

```
senso org get                        Get organization details
senso org update                     Update organization details

senso users list                     List users
senso users add                      Add a user
senso users get <userId>             Get a user
senso users update <userId>          Update a user's role
senso users remove <userId>          Remove a user

senso api-keys list                  List API keys
senso api-keys create                Create API key
senso api-keys get <keyId>           Get API key details
senso api-keys update <keyId>        Update API key
senso api-keys delete <keyId>        Delete API key
senso api-keys revoke <keyId>        Revoke API key

senso members list                   List organization members
```

### Run Configuration

```
senso run-config models              Get configured AI models
senso run-config set-models          Set AI models
senso run-config schedule            Get run schedule
senso run-config set-schedule        Set run schedule
```

### Notifications

```
senso notifications list             List notifications
senso notifications read <id>        Mark notification as read
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

The CLI checks for new versions once every 24 hours (via GitHub releases) and shows a notice on stderr if an update is available:

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
├── commands/              # One file per command group (18 files)
│   ├── auth.ts            # login, logout, whoami
│   ├── search.ts          # search, search context, search content
│   ├── content.ts         # CRUD + verification + owners
│   ├── generate.ts        # content generation settings + triggers
│   ├── engine.ts          # publish, draft
│   ├── ingest.ts          # upload, reprocess
│   ├── categories.ts      # CRUD + batch
│   ├── topics.ts          # CRUD + batch
│   ├── brand-kit.ts       # get, set
│   ├── content-types.ts   # CRUD
│   ├── prompts.ts         # CRUD
│   ├── org.ts             # get, update
│   ├── users.ts           # CRUD
│   ├── api-keys.ts        # CRUD + revoke
│   ├── members.ts         # list
│   ├── run-config.ts      # models, schedule
│   ├── notifications.ts   # list, read
│   └── update.ts          # self-update
├── lib/
│   ├── api-client.ts      # HTTP wrapper (native fetch, X-API-Key auth)
│   ├── config.ts          # Config read/write (~/.config/senso/)
│   ├── output.ts          # json/table/plain formatting
│   └── version.ts         # Reads version from package.json
└── utils/
    ├── logger.ts          # Colored log helpers (picocolors)
    ├── branding.ts        # ASCII logo, gradient banner, boxed panels
    └── updater.ts         # GitHub releases version check
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

This project uses [semantic versioning](https://semver.org/). The CLI's auto-update checker compares the installed version against the latest GitHub release using semver, so pre-release tags and version ordering are handled correctly.

```bash
# 1. Bump the version in package.json, commit, and create a git tag
npm version patch   # 0.1.0 → 0.1.1 (bug fixes)
npm version minor   # 0.1.0 → 0.2.0 (new features, backwards-compatible)
npm version major   # 0.1.0 → 1.0.0 (breaking changes)

# 2. Push the commit and tag
git push origin main --tags

# 3. Create a GitHub release (this is what the auto-updater checks)
gh release create v0.2.0 --title "v0.2.0" --notes "Release notes here"
```

After step 3, users running the CLI will see the update notice within 24 hours (or immediately via `senso update`).

---

## License

[AGPL-3.0](LICENSE)
