/**
 * Per-agency repository configuration for Conch.
 *
 * Repo slug: stored in Crustocean notes (`conch-repo`) — non-sensitive.
 * GitHub token: stored in per-agency agent config via
 *   /agent customize conch github_token <token> --agency
 * The token is AES-encrypted server-side. The agent fetches the merged &
 * decrypted config via GET /api/agents/:id/config?agencyId=X.
 */

const REPO_NOTE = 'conch-repo';
const REPO_SLUG_RE = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;

function parseRepoNote(content) {
  const text = String(content).trim();
  // Try owner/repo format first: "crustoceandev/docs" or "crustoceandev/docs main"
  const slashMatch = text.match(/^([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)(?:\s+(\S+))?$/);
  if (slashMatch) return { owner: slashMatch[1], repo: slashMatch[2], branch: slashMatch[3] || 'main' };
  // Try JSON (may have been saved with quotes stripped by tokenizer)
  try {
    const parsed = JSON.parse(text);
    if (parsed.owner && parsed.repo) return { owner: parsed.owner, repo: parsed.repo, branch: parsed.branch || 'main' };
  } catch {}
  // Try key:value format (from stripped JSON)
  const ownerMatch = text.match(/owner[:\s]+([a-zA-Z0-9_.-]+)/);
  const repoMatch = text.match(/repo[:\s]+([a-zA-Z0-9_.-]+)/);
  if (ownerMatch && repoMatch) return { owner: ownerMatch[1], repo: repoMatch[1], branch: 'main' };
  return null;
}

/**
 * Get the repo config for the current agency.
 * Repo slug from notes, GitHub token from per-agency agent config or env default.
 */
export async function getRepoConfig(agent, agencyId, defaultToken) {
  const previousAgency = agent.currentAgencyId;
  agent.currentAgencyId = agencyId;

  try {
    const repoResult = await agent.executeCommand(`/get ${REPO_NOTE}`);
    if (!repoResult?.ok || !repoResult.content) return null;

    const config = parseRepoNote(repoResult.content);
    if (!config) return null;

    let token = null;
    let tokenSource = 'none';

    try {
      const agentUserId = agent.user?.id;
      const sessionToken = agent.token;
      const url = `${agent.apiUrl}/api/agents/${agentUserId}/config?agencyId=${agencyId}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${sessionToken}` },
      });
      if (res.ok) {
        const data = await res.json();
        token = data.config?.github_token || null;
        if (token) tokenSource = 'per-agency';
      }
    } catch (err) {
      console.warn(`[conch] Failed to fetch per-agency config: ${err.message}`);
    }

    if (!token && defaultToken) {
      token = defaultToken;
      tokenSource = 'env-default';
    }

    console.log(`[conch] repo=${config.owner}/${config.repo} token=${tokenSource}`);

    if (!token) return null;

    return { owner: config.owner, repo: config.repo, branch: config.branch || 'main', token };
  } finally {
    agent.currentAgencyId = previousAgency;
  }
}

/**
 * Handle !conch subcommands (connect, disconnect, status, help).
 * Content arrives with the "!conch" prefix already stripped.
 * Returns a response string, or null if not a config command.
 */
export async function handleConfigCommand(content, agent, agencyId, defaultToken) {
  const args = content.trim().split(/\s+/);
  const sub = args[0]?.toLowerCase();

  const previousAgency = agent.currentAgencyId;
  agent.currentAgencyId = agencyId;

  try {
    if (sub === 'connect') {
      const repoSlug = args[1];

      if (!repoSlug || !REPO_SLUG_RE.test(repoSlug)) {
        return [
          'Usage: `!conch connect owner/repo`',
          '',
          'Owner and repo must contain only letters, numbers, hyphens, dots, or underscores.',
          '',
          'Then set the GitHub token (needs `repo` scope):',
          '`/agent customize conch github_token ghp_... --agency`',
          '',
          'If a default token is configured on the server, the second step is optional.',
        ].join('\n');
      }

      const [owner, repo] = repoSlug.split('/');

      if (!defaultToken) {
        await agent.executeCommand(`/save ${REPO_NOTE} ${owner}/${repo}`);
        return [
          `Linked to **${owner}/${repo}** (branch: main).`,
          '',
          'Next, set your GitHub token:',
          '```',
          '/agent customize conch github_token ghp_your_token --agency',
          '```',
          '',
          'The token is encrypted server-side and stored per-agency.',
        ].join('\n');
      }

      await agent.executeCommand(`/save ${REPO_NOTE} ${owner}/${repo}`);
      return `Connected to **${owner}/${repo}** (branch: main). Using server default GitHub token.`;
    }

    if (sub === 'disconnect') {
      await agent.executeCommand(`/clearnote ${REPO_NOTE}`);
      return 'Repository disconnected. To also remove the GitHub token: `/agent customize conch github_token --agency`';
    }

    if (sub === 'status') {
      const config = await getRepoConfig(agent, agencyId, defaultToken);
      if (!config) return 'No repository connected. Use `!conch connect owner/repo`';
      const tokenSource = defaultToken ? 'server default' : 'per-agency config';
      return `Connected to **${config.owner}/${config.repo}** (branch: ${config.branch}). Token: ${tokenSource}`;
    }

    if (sub === 'help' || !sub) {
      return [
        '**Conch — Crustocean Coding Agent**',
        '',
        '`!conch connect owner/repo` — Link a GitHub repository',
        '`!conch disconnect` — Unlink the repository',
        '`!conch status` — Show current repo connection',
        '',
        'Set GitHub token (encrypted, per-agency):',
        '`/agent customize conch github_token ghp_... --agency`',
        '',
        'Once connected, @mention me with a coding task:',
        '`@conch fix the null check bug in src/api/users.ts`',
        '',
        'Or just talk to me — I can help with coding questions anytime.',
      ].join('\n');
    }

    return null;
  } finally {
    agent.currentAgencyId = previousAgency;
  }
}
