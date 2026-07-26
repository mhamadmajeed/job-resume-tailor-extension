import express from 'express';
import { db } from './db.js';
import { uuid, nowIso, accountAuth, asyncRoute } from './util.js';
import { sendEmail } from './email.js';
import { toSlug } from './blog.js';
import { createPlanPrice } from './stripe.js';

// Kept local (rather than imported from index.js) to avoid a circular import between
// index.js (which mounts this router) and this file. plan_settings is the single
// source of truth for price/quota - see the same helpers in index.js.
function getPlanSettings(plan) {
  const row = db.prepare('SELECT * FROM plan_settings WHERE plan = ?').get(plan);
  if (row) return row;
  return { plan, price_usd: plan === 'free' ? 0 : 19, price_usd_yearly: null, generation_limit: 5, stripe_product_id: null, stripe_price_id: null, stripe_price_id_yearly: null };
}

function planLimit(plan) {
  return getPlanSettings(plan).generation_limit;
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
  if (id === req.accountId) return res.status(400).json({ error: 'You cannot delete your own account.' });

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
  db.prepare('DELETE FROM admins WHERE account_id = ?').run(id);
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

// ---- Discounts (owner only) - see DISCOUNT SPEC ----

// $-off discounts must stay below the cheapest applicable plan's live price. The
// amount is applied per month (12x on a yearly invoice), so a yearly price counts
// at its per-month equivalent.
function cheapestApplicablePrice(appliesTo) {
  const plans = appliesTo === 'both' ? ['pro', 'elite'] : [appliesTo];
  let ceiling = Infinity;
  for (const plan of plans) {
    const settings = getPlanSettings(plan);
    ceiling = Math.min(ceiling, settings.price_usd, settings.price_usd_yearly ? settings.price_usd_yearly / 12 : Infinity);
  }
  return ceiling;
}

function mapDiscount(row) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    valueType: row.value_type,
    percentOff: row.value_type === 'amount' ? null : row.percent_off,
    amountOff: row.value_type === 'amount' ? row.amount_off : null,
    appliesTo: row.applies_to,
    active: Boolean(row.active),
    stripeCouponId: row.stripe_coupon_id,
    createdAt: row.created_at
  };
}

// Shared by create and edit: validates a discount payload and returns either
// { error } or the normalized fields ready to persist. percentOff/amountOff are
// always both present in the result - whichever one is unused for this value_type
// comes back as a safe placeholder (0 for percentOff, null for amountOff) so the
// caller can bind them straight into the INSERT/UPDATE regardless of value_type.
function validateDiscountInput(body) {
  const name = String(body?.name || '').trim();
  const type = String(body?.type || '');
  const valueType = String(body?.value_type || 'percent');
  const appliesTo = String(body?.applies_to || 'both');

  if (!name) return { error: 'name is required.' };
  if (!['standard', 'urgency'].includes(type)) {
    return { error: 'type must be standard or urgency.' };
  }
  if (!['percent', 'amount'].includes(valueType)) {
    return { error: 'value_type must be percent or amount.' };
  }
  if (!['both', 'pro', 'elite'].includes(appliesTo)) {
    return { error: 'applies_to must be both, pro, or elite.' };
  }

  if (valueType === 'percent') {
    const percentOff = Number(body?.percent_off);
    if (!Number.isInteger(percentOff) || percentOff < 1 || percentOff > 90) {
      return { error: 'percent_off must be an integer between 1 and 90.' };
    }
    return { name, type, valueType, percentOff, amountOff: null, appliesTo };
  }

  const amountOff = Number(body?.amount_off);
  const ceiling = cheapestApplicablePrice(appliesTo);
  if (!Number.isFinite(amountOff) || amountOff <= 0 || amountOff >= ceiling) {
    return { error: `amount_off must be greater than 0 and less than $${ceiling.toFixed(2)} for this applies_to.` };
  }
  return { name, type, valueType, percentOff: 0, amountOff, appliesTo };
}

adminRouter.get('/discounts', requireRole('owner'), (req, res) => {
  const rows = db.prepare('SELECT * FROM discounts ORDER BY created_at DESC').all();
  res.json(rows.map(mapDiscount));
});

adminRouter.post('/discounts', requireRole('owner'), (req, res) => {
  const parsed = validateDiscountInput(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  const id = uuid();
  db.prepare(
    `INSERT INTO discounts (id, name, type, value_type, percent_off, amount_off, applies_to, active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`
  ).run(id, parsed.name, parsed.type, parsed.valueType, parsed.percentOff, parsed.amountOff, parsed.appliesTo, nowIso());

  res.json(mapDiscount(db.prepare('SELECT * FROM discounts WHERE id = ?').get(id)));
});

// Editing keeps the row's active state untouched. If value_type, percent_off,
// amount_off, or applies_to changed, the persisted Stripe coupons (one per billing
// cycle) no longer match the discount, so both are cleared and the next checkout
// mints fresh ones.
adminRouter.put('/discounts/:id', requireRole('owner'), (req, res) => {
  const existing = db.prepare('SELECT * FROM discounts WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Discount not found.' });

  const parsed = validateDiscountInput(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  const couponStale = parsed.valueType !== existing.value_type
    || parsed.percentOff !== existing.percent_off
    || parsed.amountOff !== existing.amount_off
    || parsed.appliesTo !== existing.applies_to;
  const stripeCouponId = couponStale ? null : existing.stripe_coupon_id;
  const stripeCouponIdYearly = couponStale ? null : existing.stripe_coupon_id_yearly;

  db.prepare(
    `UPDATE discounts SET name = ?, type = ?, value_type = ?, percent_off = ?, amount_off = ?, applies_to = ?, stripe_coupon_id = ?, stripe_coupon_id_yearly = ?
     WHERE id = ?`
  ).run(parsed.name, parsed.type, parsed.valueType, parsed.percentOff, parsed.amountOff, parsed.appliesTo, stripeCouponId, stripeCouponIdYearly, req.params.id);

  res.json(mapDiscount(db.prepare('SELECT * FROM discounts WHERE id = ?').get(req.params.id)));
});

// Activating a discount deactivates every other discount of the same type, so at most
// one standard and one urgency discount can be active at once.
adminRouter.post('/discounts/:id/activate', requireRole('owner'), (req, res) => {
  const discount = db.prepare('SELECT * FROM discounts WHERE id = ?').get(req.params.id);
  if (!discount) return res.status(404).json({ error: 'Discount not found.' });

  db.prepare('UPDATE discounts SET active = 0 WHERE type = ? AND id != ?').run(discount.type, discount.id);
  db.prepare('UPDATE discounts SET active = 1 WHERE id = ?').run(discount.id);
  res.json(mapDiscount(db.prepare('SELECT * FROM discounts WHERE id = ?').get(discount.id)));
});

adminRouter.post('/discounts/:id/deactivate', requireRole('owner'), (req, res) => {
  const discount = db.prepare('SELECT * FROM discounts WHERE id = ?').get(req.params.id);
  if (!discount) return res.status(404).json({ error: 'Discount not found.' });

  db.prepare('UPDATE discounts SET active = 0 WHERE id = ?').run(discount.id);
  res.json(mapDiscount(db.prepare('SELECT * FROM discounts WHERE id = ?').get(discount.id)));
});

adminRouter.delete('/discounts/:id', requireRole('owner'), (req, res) => {
  const discount = db.prepare('SELECT * FROM discounts WHERE id = ?').get(req.params.id);
  if (!discount) return res.status(404).json({ error: 'Discount not found.' });

  db.prepare('DELETE FROM visitor_offers WHERE discount_id = ?').run(discount.id);
  db.prepare('DELETE FROM discounts WHERE id = ?').run(discount.id);
  res.json({ ok: true });
});

// ---- Admins management ----

// ---- Plans (price + quota per plan, owner-only) ----

function mapPlan(row) {
  return {
    plan: row.plan,
    priceUsd: row.price_usd,
    priceUsdYearly: row.price_usd_yearly,
    generationLimit: row.generation_limit,
    stripeProductId: row.stripe_product_id,
    stripePriceId: row.stripe_price_id,
    stripePriceIdYearly: row.stripe_price_id_yearly
  };
}

adminRouter.get('/plans', requireRole('owner'), (req, res) => {
  const rows = db.prepare('SELECT * FROM plan_settings ORDER BY price_usd ASC').all();
  res.json(rows.map(mapPlan));
});

// Free has no Stripe price (nothing to charge). For pro/elite, changing price_usd or
// price_usd_yearly mints a NEW Stripe price (prices are immutable) and swaps the stored
// price id to it - existing subscribers keep their original price until they resubscribe.
adminRouter.put('/plans/:plan', requireRole('owner'), asyncRoute(async (req, res) => {
  const plan = req.params.plan;
  const existing = db.prepare('SELECT * FROM plan_settings WHERE plan = ?').get(plan);
  if (!existing) return res.status(404).json({ error: 'Unknown plan.' });

  const generationLimit = Number(req.body?.generationLimit);
  if (!Number.isFinite(generationLimit) || generationLimit <= 0) {
    return res.status(400).json({ error: 'generationLimit must be a positive number.' });
  }

  let priceUsd = existing.price_usd;
  let priceUsdYearly = existing.price_usd_yearly;
  let stripePriceId = existing.stripe_price_id;
  let stripePriceIdYearly = existing.stripe_price_id_yearly;

  if (plan !== 'free') {
    const nextMonthly = Number(req.body?.priceUsd);
    const nextYearly = req.body?.priceUsdYearly === '' || req.body?.priceUsdYearly == null
      ? null
      : Number(req.body.priceUsdYearly);
    if (!Number.isFinite(nextMonthly) || nextMonthly <= 0) {
      return res.status(400).json({ error: 'priceUsd must be a positive number.' });
    }
    if (nextYearly != null && (!Number.isFinite(nextYearly) || nextYearly <= 0)) {
      return res.status(400).json({ error: 'priceUsdYearly must be a positive number.' });
    }

    if (nextMonthly !== existing.price_usd) {
      stripePriceId = await createPlanPrice(process.env, existing.stripe_product_id, nextMonthly, 'month');
    }
    if (nextYearly == null) {
      stripePriceIdYearly = null;
    } else if (nextYearly !== existing.price_usd_yearly) {
      stripePriceIdYearly = await createPlanPrice(process.env, existing.stripe_product_id, nextYearly, 'year');
    }
    priceUsd = nextMonthly;
    priceUsdYearly = nextYearly;
  }

  db.prepare(
    `UPDATE plan_settings
     SET price_usd = ?, price_usd_yearly = ?, generation_limit = ?, stripe_price_id = ?, stripe_price_id_yearly = ?, updated_at = ?
     WHERE plan = ?`
  ).run(priceUsd, priceUsdYearly, generationLimit, stripePriceId, stripePriceIdYearly, nowIso(), plan);

  res.json(mapPlan(db.prepare('SELECT * FROM plan_settings WHERE plan = ?').get(plan)));
}));

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
