/**
 * GitHub API helpers with error handling and rate limit awareness.
 * Supports both classic (ghp_) and fine-grained (github_pat_) tokens.
 */

const GITHUB_API = 'https://api.github.com';

const PERMISSION_HINTS = {
  404: 'If using a fine-grained token, ensure it has access to this repository and the required permissions: Contents (read/write), Pull requests (read/write), Metadata (read).',
  403: 'Token lacks permission for this operation. Fine-grained tokens need explicit repository permissions: Contents (read/write) for commits, Pull requests (read/write) for PRs.',
  422: 'Validation failed. Check that branch names, PR fields, and file paths are valid.',
};

export class GitHubAPIError extends Error {
  constructor(message, status, response) {
    super(message);
    this.name = 'GitHubAPIError';
    this.status = status;
    this.response = response;
  }
}

export async function githubFetch(path, token, opts = {}) {
  const url = path.startsWith('http') ? path : `${GITHUB_API}${path}`;
  const headers = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'crustocean-workspace',
    ...(token && { 'Authorization': `Bearer ${token}` }),
    ...opts.headers,
  };

  const res = await fetch(url, { ...opts, headers });

  if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
    const reset = res.headers.get('x-ratelimit-reset');
    const waitSec = reset ? Math.max(0, parseInt(reset) - Math.floor(Date.now() / 1000)) : 60;
    throw new GitHubAPIError(`GitHub API rate limited. Resets in ${waitSec}s.`, 403, null);
  }

  if (!res.ok) {
    let body;
    try { body = await res.json(); } catch { body = await res.text().catch(() => ''); }
    const msg = body?.message || (typeof body === 'string' ? body : `HTTP ${res.status}`);
    const hint = PERMISSION_HINTS[res.status] || '';
    const fullMsg = hint ? `GitHub API error: ${msg}. ${hint}` : `GitHub API error: ${msg}`;
    throw new GitHubAPIError(fullMsg, res.status, body);
  }

  return res;
}

export async function githubJSON(path, token, opts = {}) {
  const res = await githubFetch(path, token, opts);
  return res.json();
}
