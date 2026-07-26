import express from 'express';
import { db } from './db.js';
import { uuid, nowIso, accountAuth, asyncRoute } from './util.js';
import { sendEmail } from './email.js';
import { toSlug } from './blog.js';

// Kept local (rather than imported from index.js) to avoid a circular import between
// index.js (which mounts this router) and this file.
const PLAN_ENV_KEYS = { free: 'FREE_GENERATION_LIMIT', pro: 'PRO_GENERATION_LIMIT', elite: 'ELITE_GENERATION_LIMIT' };
const PLAN_DEFAULTS = { free: 5, pro: 100, elite: 300 };

function planLimit(plan) {
  const envKey = PLAN_ENV_KEYS[plan] || PLAN_ENV_KEYS.free;
  const fallback = PLAN_DEFAULTS[plan] || PLAN_DEFAULTS.free;
  return Number(process.env[envKey] || fallback);
}

function ensureUserRow(accountId) {
  const existing = db.prepare('SELECT id FROM users WHERE id = ?').get(accountId);
  if (existing) return;
  const timestamp = nowIso();
  db.prepare(
    'INSERT INTO users (id, plan, generations_used, period_start, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(accountId, 'free', 0, timestamp, timestamp);
}

// ---- Owner seeding + pending-admin binding, called from the Google OAuth callback ----

// Runs on every sign-in. Two independent jobs:
// 1. If this is OWNER_EMAIL's very first sign-in (no admins row for that email yet),
//    seed a permanent 'owner' row bound to their account.
// 2. Bind any pending admin row (invited by email before they ever signed in) to the
//    account that just signed in with that same email.
export function bindAdminOnSignIn(account, ownerEmail) {
  if (!account?.email) return;
  const email = account.email;

  if (ownerEmail && email.toLowerCase() === String(ownerEmail).toLowerCase()) {
    const existingByEmail = db.prepare('SELECT id FROM admins WHERE email = ? COLLATE NOCASE').get(email);
    if (!existingByEmail) {
      db.prepare('INSERT INTO admins (id, email, account_id, role, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(uuid(), email, account.id, 'owner', nowIso());
    }
  }

  db.prepare('UPDATE admins SET account_id = ? WHERE email = ? COLLATE NOCASE AND account_id IS NULL')
    .run(account.id, email);
}

// ---- Auth ----

function attachAdmin(req, res, next) {
  const admin = db.prepare('SELECT * FROM admins WHERE account_id = ?').get(req.accountId);
  if (!admin) return res.status(403).json({ error: 'Admin access required.' });
  req.adminRole = admin.role;
  req.adminId = admin.id;
  next();
}

// Express accepts an array of middleware in .use()/.get() etc - accountAuth runs first
// (same session auth the /account/* router uses), then the admin-table lookup above.
export const adminAuth = [accountAuth, attachAdmin];

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.adminRole)) return res.status(403).json({ error: 'Admin access required.' });
    next();
  };
}

// ---- Router ----

export const adminRouter = express.Router();
adminRouter.use(adminAuth);

adminRouter.get('/me', (req, res) => {
  const account = db.prepare('SELECT email, name FROM accounts WHERE id = ?').get(req.accountId);
  res.json({ role: req.adminRole, email: account?.email || null, name: account?.name || null });
});

// ---- Members ----

adminRouter.get('/members', requireRole('owner', 'moderator'), (req, res) => {
  const rows = db.prepare(`
    SELECT
      a.id AS account_id,
      a.email AS email,
      a.name AS name,
      a.created_at AS created_at,
      COALESCE(u.plan, 'free') AS plan,
      COALESCE(u.status, 'active') AS status,
      COALESCE(u.generations_used, 0) AS generations_used,
      (SELECT COUNT(*) FROM generations g WHERE g.user_id = a.id) AS resume_count,
      (SELECT MAX(g.updated_at) FROM generations g WHERE g.user_id = a.id) AS last_active_at
    FROM accounts a
    LEFT JOIN users u ON u.id = a.id
    ORDER BY a.created_at DESC
  `).all();

  res.json(rows.map((row) => ({
    accountId: row.account_id,
    email: row.email,
    name: row.name,
    plan: row.plan,
    status: row.status,
    generationsUsed: row.generations_used,
    limit: planLimit(row.plan),
    resumeCount: row.resume_count,
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at
  })));
});

adminRouter.post('/members/:id/plan', requireRole('owner'), (req, res) => {
  const plan = String(req.body?.plan || '');
  if (!['free', 'pro', 'elite'].includes(plan)) {
    return res.status(400).json({ error: 'plan must be free, pro, or elite.' });
  }
  const account = db.prepare('SELECT id FROM accounts WHERE id = ?').get(req.params.id);
  if (!account) return res.status(404).json({ error: 'Member not found.' });

  ensureUserRow(req.params.id);
  db.prepare('UPDATE users SET plan = ? WHERE id = ?').run(plan, req.params.id);
  res.json({ ok: true });
});

adminRouter.post('/members/:id/status', requireRole('owner', 'moderator'), (req, res) => {
  const status = String(req.body?.status || '');
  if (!['active', 'paused'].includes(status)) {
    return res.status(400).json({ error: 'status must be active or paused.' });
  }
  const account = db.prepare('SELECT id FROM accounts WHERE id = ?').get(req.params.id);
  if (!account) return res.status(404).json({ error: 'Member not found.' });

  ensureUserRow(req.params.id);
  db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, req.params.id);
  res.json({ ok: true });
});

adminRouter.delete('/members/:id', requireRole('owner'), (req, res) => {
  const id = req.params.id;
  const account = db.prepare('SELECT id FROM accounts WHERE id = ?').get(id);
  if (!account) return res.status(404).json({ error: 'Member not found.' });

  const generationIds = db.prepare('SELECT id FROM generations WHERE user_id = ?').all(id).map((row) => row.id);
  for (const generationId of generationIds) {
    db.prepare('DELETE FROM revisions WHERE generation_id = ?').run(generationId);
  }
  db.prepare('DELETE FROM match_checks WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM generations WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM resumes WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  db.prepare('DELETE FROM devices WHERE account_id = ?').run(id);
  db.prepare('DELETE FROM notifications WHERE account_id = ?').run(id);
  db.prepare('DELETE FROM accounts WHERE id = ?').run(id);

  res.json({ ok: true });
});

adminRouter.post('/members/:id/notify', requireRole('owner', 'moderator'), (req, res) => {
  const account = db.prepare('SELECT id FROM accounts WHERE id = ?').get(req.params.id);
  if (!account) return res.status(404).json({ error: 'Member not found.' });

  const title = String(req.body?.title || '').trim();
  const body = String(req.body?.body || '').trim();
  if (!title) return res.status(400).json({ error: 'title is required.' });

  db.prepare('INSERT INTO notifications (id, account_id, title, body, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(uuid(), req.params.id, title, body, nowIso());
  res.json({ ok: true });
});

adminRouter.post('/broadcast', requireRole('owner', 'moderator'), (req, res) => {
  const title = String(req.body?.title || '').trim();
  const body = String(req.body?.body || '').trim();
  if (!title) return res.status(400).json({ error: 'title is required.' });

  const accounts = db.prepare('SELECT id FROM accounts').all();
  const insert = db.prepare('INSERT INTO notifications (id, account_id, title, body, created_at) VALUES (?, ?, ?, ?, ?)');
  const timestamp = nowIso();
  for (const acct of accounts) {
    insert.run(uuid(), acct.id, title, body, timestamp);
  }
  res.json({ ok: true, count: accounts.length });
});

adminRouter.post('/members/:id/email', requireRole('owner', 'moderator'), asyncRoute(async (req, res) => {
  const account = db.prepare('SELECT email FROM accounts WHERE id = ?').get(req.params.id);
  if (!account) return res.status(404).json({ error: 'Member not found.' });

  const subject = String(req.body?.subject || '').trim();
  const body = String(req.body?.body || '').trim();
  if (!subject) return res.status(400).json({ error: 'subject is required.' });

  const result = await sendEmail(process.env, { to: account.email, subject, text: body });
  res.json(result);
}));

// ---- Blog CRUD (owner, writer full access; moderator read-only) ----

function mapPost(row) {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    excerpt: row.excerpt,
    content: row.content,
    status: row.status,
    authorAdminId: row.author_admin_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at
  };
}

adminRouter.get('/posts', requireRole('owner', 'writer', 'moderator'), (req, res) => {
  const rows = db.prepare('SELECT * FROM blog_posts ORDER BY created_at DESC').all();
  res.json(rows.map(mapPost));
});

adminRouter.post('/posts', requireRole('owner', 'writer'), (req, res) => {
  const title = String(req.body?.title || '').trim();
  if (!title) return res.status(400).json({ error: 'title is required.' });

  const excerpt = String(req.body?.excerpt || '');
  const content = String(req.body?.content || '');
  const status = req.body?.status === 'published' ? 'published' : 'draft';
  const slug = String(req.body?.slug || '').trim() || toSlug(title);

  const clash = db.prepare('SELECT id FROM blog_posts WHERE slug = ?').get(slug);
  if (clash) return res.status(400).json({ error: 'A post with this slug already exists.' });

  const id = uuid();
  const timestamp = nowIso();
  const publishedAt = status === 'published' ? timestamp : null;

  db.prepare(
    `INSERT INTO blog_posts (id, slug, title, excerpt, content, status, author_admin_id, created_at, updated_at, published_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, slug, title, excerpt, content, status, req.adminId, timestamp, timestamp, publishedAt);

  res.json(mapPost(db.prepare('SELECT * FROM blog_posts WHERE id = ?').get(id)));
});

adminRouter.put('/posts/:id', requireRole('owner', 'writer'), (req, res) => {
  const existing = db.prepare('SELECT * FROM blog_posts WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Post not found.' });

  const title = req.body?.title !== undefined ? String(req.body.title).trim() : existing.title;
  if (!title) return res.status(400).json({ error: 'title is required.' });

  const excerpt = req.body?.excerpt !== undefined ? String(req.body.excerpt) : existing.excerpt;
  const content = req.body?.content !== undefined ? String(req.body.content) : existing.content;
  const status = req.body?.status === 'published' || req.body?.status === 'draft' ? req.body.status : existing.status;
  const slug = String(req.body?.slug || '').trim() || existing.slug || toSlug(title);

  if (slug !== existing.slug) {
    const clash = db.prepare('SELECT id FROM blog_posts WHERE slug = ? AND id != ?').get(slug, req.params.id);
    if (clash) return res.status(400).json({ error: 'A post with this slug already exists.' });
  }

  const publishedAt = status === 'published' ? (existing.published_at || nowIso()) : existing.published_at;

  db.prepare(
    'UPDATE blog_posts SET slug = ?, title = ?, excerpt = ?, content = ?, status = ?, updated_at = ?, published_at = ? WHERE id = ?'
  ).run(slug, title, excerpt, content, status, nowIso(), publishedAt, req.params.id);

  res.json(mapPost(db.prepare('SELECT * FROM blog_posts WHERE id = ?').get(req.params.id)));
});

adminRouter.delete('/posts/:id', requireRole('owner', 'writer'), (req, res) => {
  const existing = db.prepare('SELECT id FROM blog_posts WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Post not found.' });
  db.prepare('DELETE FROM blog_posts WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---- Admins management ----

adminRouter.get('/admins', requireRole('owner'), (req, res) => {
  const rows = db.prepare('SELECT * FROM admins ORDER BY created_at DESC').all();
  res.json(rows.map((row) => ({
    id: row.id,
    email: row.email,
    accountId: row.account_id,
    role: row.role,
    createdAt: row.created_at
  })));
});

adminRouter.post('/admins', requireRole('owner'), (req, res) => {
  const email = String(req.body?.email || '').trim();
  const role = String(req.body?.role || '');
  if (!email) return res.status(400).json({ error: 'email is required.' });
  if (!['owner', 'moderator', 'writer'].includes(role)) {
    return res.status(400).json({ error: 'role must be owner, moderator, or writer.' });
  }

  const existing = db.prepare('SELECT id FROM admins WHERE email = ? COLLATE NOCASE').get(email);
  if (existing) return res.status(400).json({ error: 'An admin with this email already exists.' });

  const account = db.prepare('SELECT id FROM accounts WHERE email = ? COLLATE NOCASE').get(email);
  const id = uuid();
  db.prepare('INSERT INTO admins (id, email, account_id, role, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, email, account?.id || null, role, nowIso());

  res.json({ id, email, accountId: account?.id || null, role });
});

adminRouter.delete('/admins/:id', requireRole('owner'), (req, res) => {
  const target = db.prepare('SELECT * FROM admins WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'Admin not found.' });
  if (target.id === req.adminId) return res.status(400).json({ error: 'You cannot delete your own admin row.' });

  db.prepare('DELETE FROM admins WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});
