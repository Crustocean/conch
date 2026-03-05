/**
 * In-memory demo workspace for showcasing Conch without a real GitHub connection.
 * Simulates a small TypeScript project with a known bug for the agent to fix.
 */

const DEMO_FILES = {
  'src/api/users.ts': `import { Request, Response } from 'express';
import { db } from '../db';

export async function getUser(req: Request, res: Response) {
  const userId = req.params.id;
  const user = await db.users.findById(userId);

  // BUG: No null check on session — crashes on unauthenticated requests
  const email = req.session.user.email;
  const role = req.session.user.role;

  if (role !== 'admin' && user.id !== req.session.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  return res.json({ user, requestedBy: email });
}

export async function updateUser(req: Request, res: Response) {
  const userId = req.params.id;
  const updates = req.body;
  const updated = await db.users.update(userId, updates);
  return res.json(updated);
}`,
  'src/middleware/auth.ts': `import { Request, Response, NextFunction } from 'express';

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.session?.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.session?.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}`,
};

export function createDemoWorkspace() {
  const staged = new Map();
  return {
    async readFile(path) { return DEMO_FILES[path] || `// File not found: ${path}`; },
    writeFile(path, content) { staged.set(path, content); },
    async listFiles(dir) {
      return Object.keys(DEMO_FILES)
        .filter((f) => !dir || f.startsWith(dir))
        .map((f) => ({ path: f, type: 'file', size: DEMO_FILES[f].length }));
    },
    async search(query) {
      return Object.entries(DEMO_FILES)
        .filter(([, c]) => c.includes(query))
        .map(([path, c]) => ({
          path,
          matches: c.split('\n').filter((l) => l.includes(query)).slice(0, 3).map((text, i) => ({ line: i + 1, text: text.trim() })),
        }));
    },
    async diff() { return staged.size ? `${staged.size} file(s) modified` : '(no changes)'; },
    async createBranch() {},
    async commit() { return { sha: 'demo123', url: '#' }; },
    async createPR({ title }) { return { number: 42, html_url: 'https://github.com/demo/example-app/pull/42', title }; },
    async mergePR() { return { sha: 'demo456', merged: true, message: 'Pull request successfully merged' }; },
    async listPRs() { return [{ number: 42, title: 'Fix null check in getUser', state: 'open', html_url: '#', user: 'conch', head: 'conch/abc12345', base: 'main', draft: false }]; },
    async getPR() { return { number: 42, title: 'Fix null check in getUser', state: 'open', html_url: '#', body: 'Adds session validation', user: 'conch', head: 'conch/abc12345', base: 'main', mergeable: true, mergeable_state: 'clean', draft: false, additions: 5, deletions: 2, changed_files: 1, reviews: [], checks: [] }; },
    async addPRComment() { return { id: 1, html_url: '#' }; },
    async deleteBranch() {},
    async listBranches() { return [{ name: 'main', protected: true }, { name: 'conch/abc12345', protected: false }]; },
    reset() { staged.clear(); },
  };
}
