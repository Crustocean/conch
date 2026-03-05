/**
 * @crustocean/workspace — Workspace providers for coding agents.
 *
 * GitHubWorkspace lets agents read, write, search, and manage code in GitHub repos.
 * Designed to be used with @crustocean/sdk's startRun() for full Agent Run UX.
 *
 * Architecture: readFile/listFiles/search hit the GitHub API directly.
 * writeFile stages changes in memory. commit() pushes all staged writes as a
 * single commit via the Git Data API (tree + commit + ref update).
 */

import { githubJSON, githubFetch, GitHubAPIError } from './github.js';
import { buildUnifiedDiff } from '../lib/diff.js';

export { GitHubAPIError };

const MAX_WRITE_BYTES = 2 * 1024 * 1024; // 2 MB

function validatePath(p) {
  if (!p || typeof p !== 'string') throw new Error('File path is required');
  if (p.includes('\0')) throw new Error('File path contains null bytes');
  const normalized = p.split('/').filter(Boolean);
  if (normalized.some((seg) => seg === '..')) throw new Error('Directory traversal (..) is not allowed');
  if (normalized.some((seg) => seg === '.')) throw new Error('Dot segments (.) are not allowed in paths');
  if (p.startsWith('/')) throw new Error('Absolute paths are not allowed — use paths relative to repo root');
  return normalized.join('/');
}

export class GitHubWorkspace {
  /**
   * @param {Object} opts
   * @param {string} opts.owner - Repository owner (user or org)
   * @param {string} opts.repo - Repository name
   * @param {string} opts.token - GitHub personal access token
   * @param {string} [opts.branch='main'] - Default branch to read from
   */
  constructor({ owner, repo, token, branch = 'main' }) {
    if (!owner || !repo) throw new Error('owner and repo are required');
    if (!token) throw new Error('GitHub token is required');
    this.owner = owner;
    this.repo = repo;
    this.token = token;
    this.branch = branch;
    this._staged = new Map();
    this._workingBranch = null;
    this._headSha = null;
    this._treeSha = null;
  }

  get fullName() { return `${this.owner}/${this.repo}`; }
  get currentBranch() { return this._workingBranch || this.branch; }

  /**
   * Read a file from the repository.
   * @param {string} path - File path relative to repo root
   * @param {Object} [opts]
   * @param {string} [opts.ref] - Branch, tag, or SHA to read from
   * @returns {Promise<string>} File content as a string
   */
  async readFile(path, { ref } = {}) {
    const safePath = validatePath(path);
    const branch = ref || this.currentBranch;
    const encodedPath = safePath.split('/').map(encodeURIComponent).join('/');
    const data = await githubJSON(
      `/repos/${this.fullName}/contents/${encodedPath}?ref=${branch}`,
      this.token
    );
    if (data.type !== 'file') throw new Error(`${safePath} is not a file (type: ${data.type})`);
    if (data.encoding === 'base64') {
      return Buffer.from(data.content, 'base64').toString('utf-8');
    }
    return data.content;
  }

  /**
   * Stage a file write. Changes are held in memory until commit().
   * @param {string} path - File path
   * @param {string} content - New file content
   */
  writeFile(path, content) {
    const safePath = validatePath(path);
    const bytes = Buffer.byteLength(content, 'utf-8');
    if (bytes > MAX_WRITE_BYTES) {
      throw new Error(`File content too large (${(bytes / 1024 / 1024).toFixed(1)} MB). Max is ${MAX_WRITE_BYTES / 1024 / 1024} MB.`);
    }
    this._staged.set(safePath, content);
  }

  /**
   * List files in the repository (recursive tree).
   * @param {string} [dirPath] - Optional directory prefix to filter by
   * @returns {Promise<Array<{path: string, type: string, size: number}>>}
   */
  async listFiles(dirPath) {
    await this._ensureHead();
    const data = await githubJSON(
      `/repos/${this.fullName}/git/trees/${this._treeSha}?recursive=1`,
      this.token
    );
    let entries = (data.tree || [])
      .filter((e) => e.type === 'blob')
      .map((e) => ({ path: e.path, type: 'file', size: e.size || 0 }));

    if (dirPath) {
      const safeDir = validatePath(dirPath);
      const prefix = safeDir.replace(/\/$/, '') + '/';
      entries = entries.filter((e) => e.path.startsWith(prefix));
    }
    return entries;
  }

  /**
   * Search code in the repository.
   * @param {string} query - Search term
   * @param {Object} [opts]
   * @param {string} [opts.glob] - File glob filter (e.g. '*.ts')
   * @returns {Promise<Array<{path: string, matches: Array<{line: number, text: string}>}>>}
   */
  async search(query, { glob } = {}) {
    let q = `${query}+repo:${this.fullName}`;
    if (glob) q += `+path:${glob}`;

    const data = await githubJSON(
      `/search/code?q=${encodeURIComponent(q)}&per_page=20`,
      this.token,
      { headers: { 'Accept': 'application/vnd.github.text-match+json' } }
    );

    return (data.items || []).map((item) => ({
      path: item.path,
      matches: (item.text_matches || []).flatMap((tm) =>
        (tm.fragment || '').split('\n').map((line, i) => ({ line: i + 1, text: line }))
      ),
    }));
  }

  /**
   * Get a unified diff of all staged writes vs the current branch.
   * @returns {Promise<string>} Unified diff text
   */
  async diff() {
    if (this._staged.size === 0) return '(no staged changes)';

    const diffs = [];
    for (const [path, newContent] of this._staged) {
      let oldContent = '';
      try {
        oldContent = await this.readFile(path);
      } catch (err) {
        if (err.status !== 404) throw err;
      }

      const d = buildUnifiedDiff(path, oldContent, newContent);
      if (d) diffs.push(d);
    }
    return diffs.length ? diffs.join('\n\n') : '(no changes)';
  }

  /**
   * Create a new branch from the current HEAD.
   * @param {string} name - Branch name
   */
  async createBranch(name) {
    await this._ensureHead();
    await githubJSON(
      `/repos/${this.fullName}/git/refs`,
      this.token,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref: `refs/heads/${name}`, sha: this._headSha }),
      }
    );
    this._workingBranch = name;
  }

  /**
   * Commit all staged writes to the current working branch.
   * Uses the Git Data API to create a tree + commit atomically.
   * @param {string} message - Commit message
   * @returns {Promise<{sha: string, url: string}>}
   */
  async commit(message) {
    if (this._staged.size === 0) throw new Error('No staged changes to commit');
    await this._ensureHead();

    const blobs = [];
    for (const [path, content] of this._staged) {
      const blob = await githubJSON(
        `/repos/${this.fullName}/git/blobs`,
        this.token,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content, encoding: 'utf-8' }),
        }
      );
      blobs.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
    }

    const tree = await githubJSON(
      `/repos/${this.fullName}/git/trees`,
      this.token,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base_tree: this._treeSha, tree: blobs }),
      }
    );

    const commit = await githubJSON(
      `/repos/${this.fullName}/git/commits`,
      this.token,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message,
          tree: tree.sha,
          parents: [this._headSha],
        }),
      }
    );

    const branch = this._workingBranch || this.branch;
    await githubFetch(
      `/repos/${this.fullName}/git/refs/heads/${branch}`,
      this.token,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sha: commit.sha }),
      }
    );

    this._headSha = commit.sha;
    this._treeSha = tree.sha;
    this._staged.clear();

    return { sha: commit.sha, url: commit.html_url };
  }

  /**
   * Create a pull request.
   * @param {Object} opts
   * @param {string} opts.title
   * @param {string} opts.body
   * @param {string} [opts.base] - Base branch (default: this.branch)
   * @param {string} [opts.head] - Head branch (default: working branch)
   * @returns {Promise<{number: number, html_url: string, title: string}>}
   */
  async createPR({ title, body, base, head }) {
    const data = await githubJSON(
      `/repos/${this.fullName}/pulls`,
      this.token,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          body: body || '',
          head: head || this._workingBranch,
          base: base || this.branch,
        }),
      }
    );
    return { number: data.number, html_url: data.html_url, title: data.title };
  }

  /**
   * Merge a pull request.
   * @param {Object} opts
   * @param {number} opts.pull_number - PR number
   * @param {string} [opts.merge_method='squash'] - merge, squash, or rebase
   * @param {string} [opts.commit_title] - Custom merge commit title
   * @returns {Promise<{sha: string, merged: boolean, message: string}>}
   */
  async mergePR({ pull_number, merge_method = 'squash', commit_title }) {
    const body = { merge_method };
    if (commit_title) body.commit_title = commit_title;
    const data = await githubJSON(
      `/repos/${this.fullName}/pulls/${pull_number}/merge`,
      this.token,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    );
    return { sha: data.sha, merged: data.merged, message: data.message };
  }

  /**
   * List pull requests.
   * @param {Object} [opts]
   * @param {string} [opts.state='open'] - open, closed, or all
   * @param {number} [opts.per_page=10]
   * @returns {Promise<Array<{number: number, title: string, state: string, html_url: string, user: string, head: string, base: string, created_at: string, updated_at: string}>>}
   */
  async listPRs({ state = 'open', per_page = 10 } = {}) {
    const data = await githubJSON(
      `/repos/${this.fullName}/pulls?state=${state}&per_page=${per_page}`,
      this.token
    );
    return data.map((pr) => ({
      number: pr.number,
      title: pr.title,
      state: pr.state,
      html_url: pr.html_url,
      user: pr.user?.login,
      head: pr.head?.ref,
      base: pr.base?.ref,
      created_at: pr.created_at,
      updated_at: pr.updated_at,
      mergeable: pr.mergeable,
      draft: pr.draft,
    }));
  }

  /**
   * Get details of a specific pull request including review and check status.
   * @param {number} pull_number
   * @returns {Promise<Object>}
   */
  async getPR(pull_number) {
    const [pr, reviews] = await Promise.all([
      githubJSON(`/repos/${this.fullName}/pulls/${pull_number}`, this.token),
      githubJSON(`/repos/${this.fullName}/pulls/${pull_number}/reviews`, this.token),
    ]);

    let checks = null;
    try {
      const checkData = await githubJSON(
        `/repos/${this.fullName}/commits/${pr.head.sha}/check-runs`,
        this.token
      );
      checks = (checkData.check_runs || []).map((c) => ({
        name: c.name,
        status: c.status,
        conclusion: c.conclusion,
      }));
    } catch {}

    return {
      number: pr.number,
      title: pr.title,
      state: pr.state,
      html_url: pr.html_url,
      body: pr.body,
      user: pr.user?.login,
      head: pr.head?.ref,
      base: pr.base?.ref,
      mergeable: pr.mergeable,
      mergeable_state: pr.mergeable_state,
      draft: pr.draft,
      additions: pr.additions,
      deletions: pr.deletions,
      changed_files: pr.changed_files,
      created_at: pr.created_at,
      updated_at: pr.updated_at,
      reviews: reviews.map((r) => ({
        user: r.user?.login,
        state: r.state,
        submitted_at: r.submitted_at,
      })),
      checks,
    };
  }

  /**
   * Add a comment to a pull request.
   * @param {Object} opts
   * @param {number} opts.pull_number
   * @param {string} opts.body - Comment body in markdown
   * @returns {Promise<{id: number, html_url: string}>}
   */
  async addPRComment({ pull_number, body }) {
    const data = await githubJSON(
      `/repos/${this.fullName}/issues/${pull_number}/comments`,
      this.token,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
      }
    );
    return { id: data.id, html_url: data.html_url };
  }

  /**
   * Delete a branch.
   * @param {string} branchName
   */
  async deleteBranch(branchName) {
    await githubFetch(
      `/repos/${this.fullName}/git/refs/heads/${branchName}`,
      this.token,
      { method: 'DELETE' }
    );
  }

  /**
   * List branches in the repository.
   * @param {Object} [opts]
   * @param {number} [opts.per_page=30]
   * @returns {Promise<Array<{name: string, protected: boolean}>>}
   */
  async listBranches({ per_page = 30 } = {}) {
    const data = await githubJSON(
      `/repos/${this.fullName}/branches?per_page=${per_page}`,
      this.token
    );
    return data.map((b) => ({ name: b.name, protected: b.protected }));
  }

  /** Ensure we have the HEAD SHA and root tree SHA for the current branch. */
  async _ensureHead() {
    if (this._headSha && this._treeSha) return;
    const ref = await githubJSON(
      `/repos/${this.fullName}/git/ref/heads/${this.currentBranch}`,
      this.token
    );
    this._headSha = ref.object.sha;
    const commit = await githubJSON(
      `/repos/${this.fullName}/git/commits/${this._headSha}`,
      this.token
    );
    this._treeSha = commit.tree.sha;
  }

  /** Reset workspace state (clear staged files, working branch, cached SHAs). */
  reset() {
    this._staged.clear();
    this._workingBranch = null;
    this._headSha = null;
    this._treeSha = null;
  }
}
