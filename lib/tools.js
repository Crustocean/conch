/**
 * Tool definitions and execution mapping for Conch.
 * Each tool maps to a GitHubWorkspace method and emits Agent Run events.
 */

function audit(action, details) {
  console.log(JSON.stringify({
    level: 'audit',
    ts: new Date().toISOString(),
    action,
    ...details,
  }));
}

export const TOOL_DEFINITIONS = [
  {
    name: 'read_file',
    description: 'Read a file from the GitHub repository. Returns the file content as a string.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to repo root' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write content to a file. The change is staged until a PR is created.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to repo root' },
        content: { type: 'string', description: 'Full new content for the file' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'list_files',
    description: 'List files in the repository. Optionally scoped to a directory.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path to list (empty for repo root)' },
      },
    },
  },
  {
    name: 'search_code',
    description: 'Search for code patterns in the repository. Returns matching file paths and line snippets.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (code pattern, function name, etc.)' },
        glob: { type: 'string', description: 'Optional file glob filter (e.g. "*.ts", "src/**/*.js")' },
      },
      required: ['query'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request with all staged file changes. Only call this after writing files.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'PR title' },
        body: { type: 'string', description: 'PR description in markdown' },
      },
      required: ['title', 'body'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge an open pull request into its base branch. Requires user approval via permission gate.',
    input_schema: {
      type: 'object',
      properties: {
        pull_number: { type: 'number', description: 'PR number to merge' },
        merge_method: { type: 'string', enum: ['merge', 'squash', 'rebase'], description: 'Merge strategy (default: squash)' },
        commit_title: { type: 'string', description: 'Optional custom merge commit title' },
      },
      required: ['pull_number'],
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests on the repository. Defaults to open PRs.',
    input_schema: {
      type: 'object',
      properties: {
        state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Filter by PR state (default: open)' },
      },
    },
  },
  {
    name: 'get_pull_request',
    description: 'Get detailed information about a specific PR including reviews, checks, and mergeability.',
    input_schema: {
      type: 'object',
      properties: {
        pull_number: { type: 'number', description: 'PR number' },
      },
      required: ['pull_number'],
    },
  },
  {
    name: 'add_pr_comment',
    description: 'Add a comment to a pull request.',
    input_schema: {
      type: 'object',
      properties: {
        pull_number: { type: 'number', description: 'PR number' },
        body: { type: 'string', description: 'Comment body in markdown' },
      },
      required: ['pull_number', 'body'],
    },
  },
  {
    name: 'delete_branch',
    description: 'Delete a branch from the repository. Cannot delete main/master or the default branch. Requires user approval.',
    input_schema: {
      type: 'object',
      properties: {
        branch: { type: 'string', description: 'Branch name to delete' },
      },
      required: ['branch'],
    },
  },
  {
    name: 'list_branches',
    description: 'List branches in the repository.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'view_diff',
    description: 'View a unified diff of all currently staged file changes. Use before creating a PR to verify your work.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
];

/**
 * Execute a tool call against the workspace.
 * @param {Object} toolCall - { id, name, input }
 * @param {import('@crustocean/workspace').GitHubWorkspace} workspace
 * @param {Object} run - Agent run context from startRun()
 * @returns {Promise<string>} Tool result as a string
 */
export async function executeTool(toolCall, workspace, run) {
  const { name, input } = toolCall;

  switch (name) {
    case 'read_file': {
      run.setStatus(`reading ${input.path}...`);
      const content = await workspace.readFile(input.path);
      const lines = content.split('\n').length;
      return `${input.path} (${lines} lines):\n\n${content}`;
    }

    case 'write_file': {
      run.setStatus(`writing ${input.path}...`);
      workspace.writeFile(input.path, input.content);
      return `Staged write: ${input.path} (${input.content.split('\n').length} lines)`;
    }

    case 'list_files': {
      run.setStatus(input.path ? `listing ${input.path}/...` : 'listing repository files...');
      const files = await workspace.listFiles(input.path || undefined);
      if (files.length === 0) return '(no files found)';
      return files.map((f) => `${f.path} (${f.size}b)`).join('\n');
    }

    case 'search_code': {
      run.setStatus(`searching "${input.query}"...`);
      const results = await workspace.search(input.query, { glob: input.glob });
      if (results.length === 0) return `No results for "${input.query}"`;
      return results.map((r) => {
        const snippets = r.matches.slice(0, 3).map((m) => `  L${m.line}: ${m.text}`).join('\n');
        return `${r.path}\n${snippets}`;
      }).join('\n\n');
    }

    case 'create_pull_request': {
      const approved = await run.requestPermission({
        action: 'create_pull_request',
        description: `Create PR: "${input.title}"`,
      });
      if (!approved) {
        audit('create_pull_request.denied', { title: input.title, runId: run.runId });
        return 'PR creation denied by user.';
      }

      run.setStatus('creating branch...');
      const branchName = `conch/${run.runId.slice(0, 8)}`;
      await workspace.createBranch(branchName);

      run.setStatus('committing changes...');
      await workspace.commit(input.title);

      run.setStatus('opening pull request...');
      const pr = await workspace.createPR({ title: input.title, body: input.body });
      audit('create_pull_request.created', { pr: pr.number, url: pr.html_url, title: input.title, runId: run.runId });
      return `PR #${pr.number} created: ${pr.html_url}`;
    }

    case 'merge_pull_request': {
      const approved = await run.requestPermission({
        action: 'merge_pull_request',
        description: `Merge PR #${input.pull_number}${input.merge_method ? ` (${input.merge_method})` : ''}`,
      });
      if (!approved) {
        audit('merge_pull_request.denied', { pr: input.pull_number, runId: run.runId });
        return 'PR merge denied by user.';
      }

      run.setStatus(`merging PR #${input.pull_number}...`);
      const result = await workspace.mergePR({
        pull_number: input.pull_number,
        merge_method: input.merge_method,
        commit_title: input.commit_title,
      });
      audit('merge_pull_request.result', { pr: input.pull_number, merged: result.merged, sha: result.sha?.slice(0, 7), runId: run.runId });
      return result.merged
        ? `PR #${input.pull_number} merged successfully (${result.sha.slice(0, 7)})`
        : `Merge failed: ${result.message}`;
    }

    case 'list_pull_requests': {
      run.setStatus('listing pull requests...');
      const prs = await workspace.listPRs({ state: input.state });
      if (prs.length === 0) return `No ${input.state || 'open'} pull requests.`;
      return prs.map((pr) =>
        `#${pr.number} ${pr.title} (${pr.state}${pr.draft ? ', draft' : ''}) — ${pr.user} — ${pr.head} → ${pr.base}`
      ).join('\n');
    }

    case 'get_pull_request': {
      run.setStatus(`fetching PR #${input.pull_number}...`);
      const pr = await workspace.getPR(input.pull_number);
      const lines = [
        `#${pr.number}: ${pr.title}`,
        `State: ${pr.state}${pr.draft ? ' (draft)' : ''} | ${pr.head} → ${pr.base}`,
        `Author: ${pr.user} | +${pr.additions} -${pr.deletions} across ${pr.changed_files} files`,
        `Mergeable: ${pr.mergeable ?? 'unknown'} (${pr.mergeable_state || 'unknown'})`,
        `URL: ${pr.html_url}`,
      ];
      if (pr.reviews.length > 0) {
        lines.push('', 'Reviews:');
        pr.reviews.forEach((r) => lines.push(`  ${r.user}: ${r.state}`));
      }
      if (pr.checks && pr.checks.length > 0) {
        lines.push('', 'Checks:');
        pr.checks.forEach((c) => lines.push(`  ${c.name}: ${c.status}${c.conclusion ? ` (${c.conclusion})` : ''}`));
      }
      if (pr.body) {
        lines.push('', 'Description:', pr.body.slice(0, 1000));
      }
      return lines.join('\n');
    }

    case 'add_pr_comment': {
      run.setStatus(`commenting on PR #${input.pull_number}...`);
      const comment = await workspace.addPRComment({
        pull_number: input.pull_number,
        body: input.body,
      });
      return `Comment posted: ${comment.html_url}`;
    }

    case 'delete_branch': {
      const defaultBranch = workspace.branch || 'main';
      if (input.branch === defaultBranch) {
        return `Refused: cannot delete the default branch '${defaultBranch}'.`;
      }
      if (input.branch === 'main' || input.branch === 'master') {
        return `Refused: cannot delete '${input.branch}'.`;
      }

      const approved = await run.requestPermission({
        action: 'delete_branch',
        description: `Delete branch: ${input.branch}`,
      });
      if (!approved) {
        audit('delete_branch.denied', { branch: input.branch, runId: run.runId });
        return 'Branch deletion denied by user.';
      }

      run.setStatus(`deleting branch ${input.branch}...`);
      await workspace.deleteBranch(input.branch);
      audit('delete_branch.deleted', { branch: input.branch, runId: run.runId });
      return `Branch '${input.branch}' deleted.`;
    }

    case 'list_branches': {
      run.setStatus('listing branches...');
      const branches = await workspace.listBranches();
      return branches.map((b) => `${b.name}${b.protected ? ' (protected)' : ''}`).join('\n');
    }

    case 'view_diff': {
      run.setStatus('generating diff...');
      return await workspace.diff();
    }

    default:
      return `Unknown tool: ${name}`;
  }
}
