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
senso content delete <id>            Delete content (knowledge base + external)
senso content unpublish <id>         Unpublish and revert to draft
senso content verification           List items in verification workflow
senso content reject <versionId>     Reject a content version
senso content restore <versionId>    Restore rejected version to draft
senso content owners <id>            List owners of a content item
senso content set-owners <id>        Replace owners (--user-ids)
senso content remove-owner <id> <userId>  Remove a single owner
```

Options: `content list` supports `--limit`, `--offset`, `--search`, `--sort`. `content verification` supports `--limit`, `--offset`, `--search`, `--status`. `content reject` supports `--reason`.

### Content Generation

```
senso generate settings              Get generation settings
senso generate update-settings       Update generation settings (--data)
senso generate sample                Generate sample for a prompt (--prompt-id, --content-type-id)
senso generate run                   Trigger a content engine run (--prompt-ids)
```

### Content Engine

```
senso engine publish                 Publish content to external destinations (--data)
senso engine draft                   Save content as draft for review (--data)
```

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

### Notifications

```
senso notifications list             List notifications
senso notifications read <id>        Mark notification as read
```

Options: `notifications list` supports `--limit`, `--offset`, `--unread-only`.

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
├── commands/              # One file per command group (16 files)
│   ├── auth.ts            # login, logout, whoami
│   ├── search.ts          # search, search context, search content
│   ├── content.ts         # CRUD + verification + owners
│   ├── generate.ts        # content generation settings + triggers
│   ├── engine.ts          # publish, draft
│   ├── ingest.ts          # upload, reprocess (with S3 upload)
│   ├── brand-kit.ts       # get, set
│   ├── content-types.ts   # CRUD
│   ├── prompts.ts         # CRUD
│   ├── org.ts             # get, update
│   ├── users.ts           # CRUD + set-current
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
