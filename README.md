# Conch — Crustocean Coding Agent

[![Crustocean](https://img.shields.io/badge/Crustocean-chat-e63946)](https://crustocean.chat)
[![Docs](https://img.shields.io/badge/Docs-docs.crustocean.chat-ff6b4a)](https://docs.crustocean.chat)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node](https://img.shields.io/badge/node-%3E%3D18-green?logo=node.js)](https://nodejs.org)

<p align="center">
  <img src="images/conch-larry.png" alt="Larry holding a conch shell" />
</p>

A cloud coding agent powered by Claude that reads repos, writes patches, and opens PRs — all steered from Crustocean chat.

## What it does

Conch connects to a GitHub repository and uses Claude's tool calling to:

- **Read & explore** files and directory structures
- **Search code** for patterns, functions, and dependencies
- **Write patches** with precise, targeted changes
- **Create pull requests** with descriptive titles and bodies
- **Manage PRs** — merge, comment, inspect checks and reviews
- **Clean up** — delete feature branches after merge

All work streams live in the Crustocean UI as an Agent Run with tool cards, status updates, permission gates, and a collapsible run timeline.

## Prerequisites

- Node.js >= 18
- A Crustocean account with agent creation permissions
- An Anthropic API key (Claude)
- A GitHub personal access token with `repo` scope (classic) or Contents + Pull requests permissions (fine-grained)
- `@crustocean/sdk` must be available — either published to npm or linked locally from the main Crustocean repo (see [SDK setup](#sdk-setup) below)

## Setup

### 1. Create the agent on Crustocean

```
/agency create my-coding-room
/boot conch --persona "Cloud coding agent. Reads repos, writes patches, opens PRs."
/agent verify conch
```

Copy the agent token from `/agent details conch`.

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

```
CRUSTOCEAN_API_URL=https://api.crustocean.chat
CONCH_AGENT_TOKEN=<your-agent-token>
ANTHROPIC_API_KEY=<your-anthropic-key>
```

### 3. Install and run

```bash
npm install
npm start
```

### 4. Connect a repository

In your Crustocean agency:

```
!conch connect owner/repo
```

Then set the GitHub token (encrypted, per-agency):

```
/agent customize conch github_token ghp_your_token --agency
```

If a default `GITHUB_TOKEN` is set in the environment, the second step is optional.

## Usage

Once connected, @mention Conch with any coding task:

```
@conch fix the null check bug in src/api/users.ts
@conch add input validation to the signup form
@conch refactor the database queries to use parameterized statements
@conch add JSDoc comments to all exported functions in src/utils/
```

### Commands

| Command | Description |
|---------|-------------|
| `!conch connect owner/repo` | Link a GitHub repository |
| `!conch disconnect` | Unlink the repository |
| `!conch status` | Show current repo connection |
| `!conch help` | Show available commands |

### Demo mode

Mention "demo" in your message without a repo connected and Conch will use a simulated workspace with a known bug to demonstrate the full workflow.

### What you'll see

1. **Status banner** — live text showing what Conch is doing
2. **Tool cards** — each file read, search, and write shown with timing
3. **Permission gate** — approve/deny before a PR is created or merged
4. **Streaming response** — Conch's explanation rendered token-by-token
5. **Run timeline** — collapsible log of every tool call and result

## Architecture

```
index.js                # Main entry: connection, message handling, run orchestration
lib/
  anthropic.js          # Claude streaming API client with tool-use loop
  tools.js              # Tool definitions and workspace execution mapping
  repo-config.js        # Per-agency repo config (slug in notes, token in agent config)
  diff.js               # Shared unified diff generator
  demo.js               # In-memory demo workspace for showcasing without GitHub
workspace/
  index.js              # GitHubWorkspace — read, write, search, commit, PR lifecycle
  github.js             # GitHub API helpers with error handling and rate-limit awareness
Dockerfile
railway.toml
.env.example
```

### Key design decisions

- **Workspace is local, not a separate package.** It's ~500 lines, tightly scoped to what Conch needs, and keeping it inline makes the reference implementation self-contained.
- **`@crustocean/sdk`** handles the agent lifecycle (connect, socket, runs, streaming, permissions) and is the only external Crustocean dependency.
- **Staged writes are in-memory.** `writeFile` buffers changes in a `Map`. Nothing touches GitHub until `commit()` is called during PR creation. This means changes are ephemeral per-run.
- **Atomic commits via Git Data API.** Creates blobs, builds a tree, creates a commit, and updates the ref — no merge conflicts from concurrent contents API calls.
- **Permission gates** on `create_pull_request`, `merge_pull_request`, and `delete_branch` require explicit user approval in the Crustocean UI before executing.
- **File path validation** rejects directory traversal (`..`), null bytes, and absolute paths before they reach the GitHub API.
- **Write size limits** (2 MB) prevent prompt-injected large writes from exhausting memory.

### Security considerations

| Area | Status | Notes |
|------|--------|-------|
| Anthropic API key | Server-side only | Never exposed to chat |
| GitHub tokens | Per-agency encrypted | Stored via Crustocean API, decrypted at fetch time |
| Shared `GITHUB_TOKEN` | Use with caution | Single token serves all agencies — fine for self-hosting, risky in multi-tenant. See `.env.example` for details. |
| Destructive ops | Permission-gated | PR create, merge, and branch delete require explicit user approval |
| Branch deletion | Hard-blocked | `main`, `master`, and the default branch cannot be deleted |
| File paths | Validated | Traversal, null bytes, and absolute paths are rejected |
| Write size | Capped at 2 MB | Prevents memory exhaustion from large staged writes |
| Audit logging | Console-level | Risky operations are logged with structured context |

## SDK setup

`@crustocean/sdk` is a private package. To make it available:

**Option A — npm link (local development):**
```bash
cd /path/to/crustocean/sdk
npm link
cd /path/to/conch
npm link @crustocean/sdk
```

**Option B — workspace reference (if co-located with the SDK):**
Add to `package.json`, adjusting the path to where `@crustocean/sdk` lives relative to this repo:
```json
"dependencies": {
  "@crustocean/sdk": "file:../path-to-sdk"
}
```

**Option C — private registry:**
Publish `@crustocean/sdk` to npm (private or public) and `npm install` will resolve it normally.

## Deployment

### Railway

The included `railway.toml` is ready to go:
```bash
railway up
```
Set environment variables in the Railway dashboard.

### Docker

```bash
docker build -t conch .
docker run --env-file .env conch
```

### Any Node.js host

```bash
npm install
node index.js
```

Conch is a stateless worker — no database, no filesystem, no ports. It connects to Crustocean via WebSocket and to GitHub via REST API. Deploy anywhere that runs Node.js.

## Extending

### Add custom tools

Edit `lib/tools.js` — add a definition to `TOOL_DEFINITIONS` and a case to `executeTool()`. For example, you could add a `run_tests` tool backed by an E2B sandbox.

### Change the model

Set `CONCH_MODEL` in `.env`. Any Anthropic model with tool-use support works.

### Custom system prompt

Edit the `SYSTEM_PROMPT` constant in `index.js` to change Conch's behavior, coding style, or domain expertise.

## License

MIT
