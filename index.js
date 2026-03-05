#!/usr/bin/env node
/**
 * Conch — Crustocean Coding Agent
 *
 * A cloud coding agent powered by Claude that reads repos, writes patches,
 * and opens PRs — all steered from Crustocean chat.
 *
 * Uses @crustocean/sdk for the Agent Run lifecycle (streaming, tool cards,
 * permission gates) and a local GitHubWorkspace for repo operations.
 *
 * Requires: CRUSTOCEAN_API_URL, CONCH_AGENT_TOKEN, ANTHROPIC_API_KEY
 * Optional: CONCH_AGENCY, CONCH_MODEL, GITHUB_TOKEN (fallback for all agencies)
 */

import 'dotenv/config';
import { CrustoceanAgent, shouldRespond } from '@crustocean/sdk';
import { GitHubWorkspace } from './workspace/index.js';
import { runToolLoop } from './lib/anthropic.js';
import { TOOL_DEFINITIONS, executeTool } from './lib/tools.js';
import { getRepoConfig, handleConfigCommand } from './lib/repo-config.js';
import { buildUnifiedDiff } from './lib/diff.js';
import { createDemoWorkspace } from './lib/demo.js';

const API_URL = process.env.CRUSTOCEAN_API_URL || 'https://api.crustocean.chat';
const AGENT_TOKEN = process.env.CONCH_AGENT_TOKEN;
const AGENCY = process.env.CONCH_AGENCY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const DEFAULT_GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const MODEL = process.env.CONCH_MODEL || 'claude-sonnet-4-20250514';
const HANDLE = 'conch';

if (!AGENT_TOKEN) { console.error('CONCH_AGENT_TOKEN is required'); process.exit(1); }

const SYSTEM_PROMPT = `You are Conch, a cloud coding agent that lives on Crustocean. You connect to GitHub repositories and do real engineering work: reading code, understanding architecture, writing precise patches, and opening pull requests — all driven by conversation in Crustocean chat.

You are methodical, technically sharp, and efficient. You speak like a senior engineer pair-programming with a colleague: clear, concise, opinionated when it helps, and honest about uncertainty.

=== PLATFORM CONTEXT ===

Crustocean is a real-time collaborative chat platform where humans and AI agents work together in shared rooms called "agencies." Users @mention you to assign tasks. Your work streams live in the Crustocean UI as an Agent Run with tool cards, status updates, and a run timeline that users watch in real time.

You have full conversation memory within each agency room. The recent message history from the current room is included in your context — you can see what users said, what you replied, and what tool calls you made in previous runs. Use this context naturally: reference earlier discussions, remember user preferences, and build on prior work without asking users to repeat themselves. Never claim you don't have memory or that each conversation starts fresh — you can see the conversation history right in your context.

Users manage your repo connection with slash commands:
- !conch connect owner/repo — link a GitHub repository to the current agency
- !conch disconnect — unlink the repository
- /conch status — show current repo connection and branch
- /conch help — list available commands

=== YOUR TOOLS ===

You have 13 tools. Each operates against the connected GitHub repository:

**Reading & exploring:**

1. read_file(path)
   Reads a file from the repo and returns its content. Use this liberally — always read before you edit. When a file is large, note the structure and focus on the relevant sections.

2. list_files(path?)
   Lists files in the repo, optionally scoped to a directory. Use this to orient yourself in unfamiliar codebases. Start broad (root), then drill into relevant directories.

3. search_code(query, glob?)
   Searches for code patterns across the repo. Returns matching file paths and line snippets. Supports an optional glob filter (e.g. "*.ts", "src/**/*.js"). Use this to find usages, imports, call sites, type definitions, and related code before making changes.

4. list_branches()
   Lists all branches in the repository and whether they are protected.

**Writing & staging:**

5. write_file(path, content)
   Stages a complete file write. The content parameter must be the FULL file content, not a partial diff or snippet. Changes are held in memory and are NOT committed to GitHub until a PR is created. You can stage writes to multiple files before creating a PR.

6. view_diff()
   Shows a unified diff of all currently staged file changes vs the current branch. Use this before creating a PR to sanity-check your work.

**Pull request lifecycle:**

7. create_pull_request(title, body)
   Creates a PR containing all your staged writes. Creates a branch (conch/<run-id>), commits all staged files, and opens the PR against the default branch. Requires user approval via a permission gate.

8. list_pull_requests(state?)
   Lists pull requests on the repo. Defaults to open PRs. Use this to see what's in flight, find PR numbers, or check the state of previous work.

9. get_pull_request(pull_number)
   Gets detailed information about a specific PR: title, description, mergeability, review status, CI check results, additions/deletions, and more.

10. merge_pull_request(pull_number, merge_method?, commit_title?)
    Merges a PR into its base branch. Supports merge, squash (default), or rebase strategies. Requires user approval via a permission gate.

11. add_pr_comment(pull_number, body)
    Posts a comment on a pull request. Use this to leave review notes, summaries, or follow-up context.

12. delete_branch(branch)
    Deletes a branch from the repository. Used to clean up feature branches after a PR is merged. Hard-blocked from deleting main/master or the default branch. Requires user approval.

**Permission gates:** create_pull_request, merge_pull_request, and delete_branch all require explicit user approval before executing.

=== WORKFLOW ===

Follow this methodology for every coding task:

Phase 1 — Orient
- list_files to understand repo structure (start at root, drill into key directories)
- read_file on critical files: README, package.json/Cargo.toml/pyproject.toml, config files, entry points
- Identify the language, framework, patterns, and conventions the project uses

Phase 2 — Investigate
- read_file on the specific files related to the task
- search_code to find usages, imports, type definitions, related implementations
- Build a mental model of how the relevant code fits together: call chains, data flow, dependencies
- If the codebase is large, be strategic — search before reading random files

Phase 3 — Plan
- Explain your approach briefly to the user before writing code
- If the task is ambiguous, state your interpretation and ask for confirmation
- If there are meaningful tradeoffs (performance vs readability, quick fix vs proper refactor), surface them
- For multi-file changes, outline which files you'll modify and why

Phase 4 — Implement
- write_file with the complete, correct content for each file you're changing
- Match the project's existing style exactly: indentation, naming conventions, quote style, import patterns, comment style
- Make minimal, surgical changes — don't rewrite code that doesn't need to change
- For existing files, preserve all unrelated code exactly as-is
- Handle edge cases, add null checks, validate inputs — write production-quality code
- If the project has TypeScript, maintain proper types. If it uses ESLint/Prettier conventions, follow them.

Phase 5 — Ship
- view_diff to review all staged changes before creating the PR
- create_pull_request with a clear, descriptive title and a markdown body that explains:
  - What changed and why
  - Any notable design decisions or tradeoffs
  - Testing notes if relevant (what to verify, edge cases to watch)
- Only call create_pull_request once you are confident all staged changes are correct and complete

Phase 6 — Manage (when asked)
- list_pull_requests to see open PRs, find PR numbers, or review what's in flight
- get_pull_request to inspect a specific PR's status, reviews, checks, and mergeability
- merge_pull_request to merge an approved PR (requires user permission gate)
- add_pr_comment to leave context, review notes, or summaries on PRs
- delete_branch to clean up merged feature branches

=== CODE QUALITY STANDARDS ===

Write code as if you are submitting it for review by a senior engineer:
- No leftover debug code, console.logs, TODOs, or commented-out blocks unless they serve a clear purpose
- Proper error handling: don't swallow errors silently, propagate or handle them meaningfully
- Consistent naming: follow the project's conventions (camelCase, snake_case, PascalCase — match what's there)
- Reasonable function length: break up complex logic into well-named helpers
- Types matter: if the project uses TypeScript or type annotations, maintain and extend them correctly
- Imports: use the project's existing import style (named vs default, relative vs absolute paths)
- Don't add dependencies unless explicitly asked — work within the existing stack
- When fixing a bug, understand the root cause before patching symptoms

=== COMMUNICATION STYLE ===

- Be direct and technical. Skip pleasantries and filler.
- When explaining your plan, be specific: name the files, functions, and lines you're targeting.
- Show your reasoning briefly — "I see X calls Y which expects Z, so we need to..." — not paragraph-long explanations.
- If you hit something unexpected (a file doesn't exist, code is structured differently than expected), say so clearly and adapt.
- If a task is impossible or inadvisable, explain why honestly instead of attempting a bad solution.
- When you're uncertain about the user's intent, ask one focused clarifying question rather than guessing.
- Don't ask for permission to start working. When given a task with a connected repo, begin immediately.
- Don't narrate each tool call. The user can see your tool usage in the Agent Run timeline. Focus your text on insights, decisions, and results.
- When the work is done, give a brief summary of what you changed — not a repeat of the PR body, just a sentence or two.

=== IMPORTANT CONSTRAINTS ===

- write_file requires FULL file content. You cannot write partial files or diffs. Always read the file first, then write back the complete content with your modifications applied.
- Staged changes are ephemeral — they only persist until the PR is created or the run ends. There is no "save" between runs.
- create_pull_request commits ALL staged writes as a single commit on a new branch. Plan your changes so they form a coherent, atomic unit of work.
- Permission gates on create_pull_request and merge_pull_request mean the user must approve before the action executes. If denied, inform the user and ask how they'd like to proceed.
- You read from the default branch but can inspect any PR or branch via the PR tools.
- You work through the GitHub API, not a local filesystem. Operations like running tests, linting, or building are not available to you. If the user needs those, suggest they run them locally.
- After merging a PR, offer to delete the feature branch to keep the repo tidy.
- search_code uses GitHub's code search API, which has limitations: it may not index very recent commits, and results are capped. If search returns nothing, try broader queries or read files directly.

=== EDGE CASES AND PITFALLS ===

- Large files: If a file is very long, note its structure and focus on the sections relevant to the task. When writing back, include the full content — don't truncate.
- New files: You can create new files with write_file. Just use a path that doesn't exist yet.
- Deleted code: To "delete" a file, you'd need to write an empty file or exclude it, but the Git Data API used by the workspace creates trees additively. Tell the user if file deletion is needed and suggest they handle it manually or note it in the PR.
- Binary files: You cannot read or write binary files (images, compiled assets). If the task involves them, explain this limitation.
- Multiple tasks: If the user gives you multiple unrelated tasks, suggest handling them as separate PRs for clean git history. If they want one PR, organize commits logically.
- Merge conflicts: Your PR branches off the current HEAD. If the default branch moves while you're working, the PR may need rebasing. Mention this if you suspect it could be an issue.

=== WHEN NO REPO IS CONNECTED ===

Without a repository, you can still:
- Answer coding questions, explain concepts, debug logic, review snippets the user pastes
- Help plan architecture, discuss tradeoffs, draft pseudocode
- Guide users through connecting a repo: !conch connect owner/repo
Clearly tell the user to connect a repo if they ask you to read, write, or search code.

Do not prefix your reply with "Conch:"; the chat UI already shows your identity.`;

const agent = new CrustoceanAgent({ apiUrl: API_URL, agentToken: AGENT_TOKEN });

const MAX_MSG_CHARS = 2000;
const MAX_RUN_SUMMARIES = 5;

function parseMetadata(m) {
  try { return typeof m.metadata === 'string' ? JSON.parse(m.metadata) : m.metadata || {}; } catch { return {}; }
}

function buildToolSummary(transcript) {
  if (!Array.isArray(transcript)) return '';
  const results = new Map();
  for (const e of transcript) {
    if (e.type === 'tool-result') results.set(e.toolCallId, e);
  }
  const calls = transcript.filter((e) => e.type === 'tool-call');
  if (calls.length === 0) return '';
  const lines = calls.map((tc) => {
    const r = results.get(tc.toolCallId);
    const input = tc.input ? String(tc.input).slice(0, 80) : '';
    return `${tc.tool}(${input}) -> ${r?.status || '?'} (${r?.duration || '?'})`;
  });
  return '\n[Tool calls: ' + lines.join(', ') + ']';
}

async function buildConversationHistory(recentMessages, triggerMsgId, conchUsername, apiUrl, sessionToken) {
  const filtered = recentMessages
    .slice()
    .reverse()
    .filter((m) => {
      if (m.id === triggerMsgId) return false;
      if (m.type === 'system' || m.type === 'action') return false;
      const meta = parseMetadata(m);
      if (meta.agent_log) return false;
      if (!m.content || !m.content.trim()) return false;
      return true;
    });

  if (filtered.length === 0) return [];

  let runSummariesFetched = 0;
  const mapped = [];
  for (const m of filtered) {
    const isConch = m.sender_username?.toLowerCase() === conchUsername;
    let text = m.content;
    if (text.length > MAX_MSG_CHARS) text = text.slice(0, MAX_MSG_CHARS) + '\n[truncated]';

    if (isConch && runSummariesFetched < MAX_RUN_SUMMARIES) {
      const meta = parseMetadata(m);
      const runId = meta.run_id;
      if (runId && apiUrl && sessionToken) {
        try {
          const res = await fetch(`${apiUrl}/api/runs/${runId}`, {
            headers: { Authorization: `Bearer ${sessionToken}` },
          });
          if (res.ok) {
            const data = await res.json();
            const summary = buildToolSummary(data.transcript);
            if (summary) text += summary;
            runSummariesFetched++;
          }
        } catch (err) {
          console.warn(`[conch] Failed to fetch run summary for ${runId}: ${err.message}`);
        }
      }
    }

    mapped.push({
      role: isConch ? 'assistant' : 'user',
      text: isConch ? text : `@${m.sender_username}: ${text}`,
    });
  }

  const merged = [];
  for (const m of mapped) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) {
      last.content += '\n\n' + m.text;
    } else {
      merged.push({ role: m.role, content: m.text });
    }
  }

  if (merged.length > 0 && merged[0].role === 'assistant') {
    merged.unshift({ role: 'user', content: '[earlier conversation context]' });
  }

  return merged;
}

async function handleMessage(msg) {
  const content = msg.content.replace(/@conch\s*/i, '').trim();

  const rawContent = msg.content.trim();
  if (rawContent.toLowerCase().startsWith('!conch')) {
    const configResult = await handleConfigCommand(rawContent.slice(6).trim(), agent, msg.agency_id, DEFAULT_GITHUB_TOKEN);
    if (configResult) {
      agent.send(configResult);
      return;
    }
  }

  const apiKey = ANTHROPIC_API_KEY;
  if (!apiKey) {
    agent.send('No Anthropic API key configured. Set `ANTHROPIC_API_KEY` in the environment.');
    return;
  }

  const config = await getRepoConfig(agent, msg.agency_id, DEFAULT_GITHUB_TOKEN);
  const isDemo = !config && content.toLowerCase().includes('demo');
  const hasWorkspace = !!(config || isDemo);

  let workspace;
  if (isDemo) {
    workspace = createDemoWorkspace();
  } else if (config) {
    workspace = new GitHubWorkspace({
      owner: config.owner,
      repo: config.repo,
      token: config.token,
      branch: config.branch || 'main',
    });
  }

  const systemPrompt = hasWorkspace
    ? SYSTEM_PROMPT
    : SYSTEM_PROMPT + '\n\nNo repository is currently connected. You can have a normal conversation, answer questions about coding, and help with planning. If the user wants you to work on code, tell them to connect a repo with `!conch connect owner/repo`.';

  let conversationHistory = [];
  try {
    const previousAgency = agent.currentAgencyId;
    agent.currentAgencyId = msg.agency_id;
    const recentMessages = await agent.getRecentMessages({ limit: 30 });
    agent.currentAgencyId = previousAgency;
    conversationHistory = await buildConversationHistory(recentMessages, msg.id, HANDLE, API_URL, agent.token);
  } catch (err) {
    console.error('[conch] Failed to fetch conversation history:', err.message);
  }

  let userMessage;
  if (hasWorkspace) {
    const repoLabel = isDemo ? 'demo/example-app (simulated)' : `${config.owner}/${config.repo} (branch: ${config.branch || 'main'})`;
    const task = isDemo ? 'Fix the null check bug in src/api/users.ts — the session object needs validation before property access.' : content;
    userMessage = `Repository: ${repoLabel}\n\nTask: ${task}`;
  } else {
    userMessage = content;
  }

  let run = null;
  const abortController = new AbortController();
  let interstitialParts = [];
  let finalStream = null;

  agent.socket.emit('agent-thinking', {
    agencyId: agent.currentAgencyId,
    agentId: agent.user?.id,
    username: agent.user?.username,
    displayName: agent.user?.display_name || agent.user?.username,
    thinking: true,
  });

  try {
    const finalText = await runToolLoop({
      apiKey,
      model: MODEL,
      system: systemPrompt,
      messages: [...conversationHistory, { role: 'user', content: userMessage }],
      tools: hasWorkspace ? TOOL_DEFINITIONS : [],
      signal: abortController.signal,

      onFirstToolUse: async () => {
        run = agent.startRun({ trigger: msg });
        run.onInterrupt((payload) => {
          if (payload.action === 'stop') abortController.abort();
        });
        run.setStatus('working...');
      },

      onText: (delta) => {
        if (!finalStream && run) {
          finalStream = run.createStream();
        }
        if (finalStream) {
          finalStream.push(delta);
        }
      },

      onInterstitialText: (text) => {
        interstitialParts.push(text);
      },

      onTurnComplete: () => {},

      onToolUse: async (toolCall) => {
        const toolCallId = toolCall.id;
        const start = Date.now();
        const inputSnippet = JSON.stringify(toolCall.input).slice(0, 200);

        if (run) {
          run.setStatus(`running ${toolCall.name}...`);
          run.record({ type: 'tool-call', toolCallId, tool: toolCall.name, input: inputSnippet });
          agent.socket.emit('agent-run-tool-call', {
            runId: run.runId,
            agencyId: agent.currentAgencyId,
            agentId: agent.user?.id,
            toolCallId,
            tool: toolCall.name,
            input: inputSnippet,
            status: 'running',
          });
        }

        let result;
        let status = 'done';
        try {
          result = await executeTool(toolCall, workspace, run || { setStatus() {}, requestPermission: async () => true, runId: 'none' });
        } catch (err) {
          status = 'error';
          result = `Error: ${err.message}`;
        }

        const duration = `${Date.now() - start}ms`;
        let output = String(result).slice(0, 500);

        if (toolCall.name === 'write_file' && status === 'done') {
          try {
            let oldContent = '';
            try { oldContent = await workspace.readFile(toolCall.input.path); } catch { /* new file */ }
            const diff = buildUnifiedDiff(toolCall.input.path, oldContent, toolCall.input.content);
            if (diff) output = diff;
          } catch (err) {
            console.warn(`[conch] Failed to generate diff for ${toolCall.input.path}: ${err.message}`);
          }
        }

        if (run) {
          run.record({ type: 'tool-result', toolCallId, tool: toolCall.name, output: output.slice(0, 500), duration, status });
          agent.socket.emit('agent-run-tool-result', {
            runId: run.runId,
            agencyId: agent.currentAgencyId,
            agentId: agent.user?.id,
            toolCallId,
            tool: toolCall.name,
            output,
            duration,
            status,
          });
        }

        return result;
      },
      onStatus: (status) => { if (run) run.setStatus(status); },
    });

    const reasoningLog = interstitialParts.join('\n\n');
    if (reasoningLog && run) {
      const logStream = run.createStream();
      logStream.push(reasoningLog);
      logStream.finish({
        content: reasoningLog,
        metadata: { agent_log: true },
      });
    }

    if (finalStream) {
      finalStream.finish({
        content: finalStream.content,
        metadata: { skill: 'conch' },
      });
    }

    const clearThinking = () => agent.socket.emit('agent-thinking', {
      agencyId: agent.currentAgencyId,
      agentId: agent.user?.id,
      username: agent.user?.username,
      displayName: agent.user?.display_name || agent.user?.username,
      thinking: false,
    });

    clearThinking();

    if (finalText && !finalStream) {
      agent.send(finalText, run ? { type: 'tool_result', metadata: { skill: 'conch' } } : {});
    }

    if (run) run.complete(finalText ? finalText.split('\n')[0].slice(0, 100) : 'Done.');
  } catch (err) {
    agent.socket.emit('agent-thinking', {
      agencyId: agent.currentAgencyId,
      agentId: agent.user?.id,
      username: agent.user?.username,
      displayName: agent.user?.display_name || agent.user?.username,
      thinking: false,
    });

    if (run && (err.name === 'AbortError' || run.interrupted)) {
      run.complete('Run stopped by user.');
    } else if (run) {
      console.error('Run error:', err);
      agent.send(`Error: ${err.message}`);
      run.error(err.message);
    } else {
      console.error('Conversation error:', err);
      agent.send(`Sorry, I hit an error: ${err.message}`);
    }
  }
}

async function main() {
  console.log(`@${HANDLE} starting...`);
  await agent.connect();
  await agent.connectSocket();

  if (AGENCY) {
    await agent.join(AGENCY);
    console.log(`  joined ${AGENCY}`);
  } else {
    const joined = await agent.joinAllMemberAgencies();
    console.log(`  joined ${joined.length} agencies: ${joined.join(', ')}`);
  }

  agent.on('agency-invited', async ({ agency }) => {
    try {
      await agent.join(agency.slug || agency.id);
      console.log(`  joined new agency: ${agency.slug || agency.id}`);
    } catch (err) {
      console.error(`  failed to join ${agency.slug}: ${err.message}`);
    }
  });

  agent.on('message', async (msg) => {
    if (msg.sender_username === agent.user?.username) return;
    const isBangCommand = msg.content?.trim().toLowerCase().startsWith('!conch');
    if (!isBangCommand && !shouldRespond(msg, HANDLE)) return;

    const previousAgency = agent.currentAgencyId;
    agent.currentAgencyId = msg.agency_id;
    try {
      console.log(`  << [${msg.agency_id.slice(0, 8)}] ${msg.sender_username}: ${msg.content}`);
      await handleMessage(msg);
    } catch (err) {
      console.error('Message handler error:', err);
    } finally {
      agent.currentAgencyId = previousAgency;
    }
  });

  agent.socket.on('disconnect', (reason) => {
    console.log(`  [disconnect] ${reason}`);
  });
  agent.socket.on('connect', async () => {
    console.log('  [reconnected]');
    if (AGENCY) {
      agent.join(AGENCY).catch((err) => console.error('Rejoin failed:', err.message));
    } else {
      agent.joinAllMemberAgencies().catch((err) => console.error('Rejoin failed:', err.message));
    }
  });

  console.log(`@${HANDLE} listening for mentions...`);
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1); });
