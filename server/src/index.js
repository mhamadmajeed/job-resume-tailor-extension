import 'dotenv/config';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import express from 'express';
import { db } from './db.js';
import { uuid, nowIso, deviceAuth, accountAuth, signToken, asyncRoute } from './util.js';
import { tailorResume, reviseResume, boostResume, scoreMatch } from './claude.js';
import { createCheckoutSession, verifyStripeWebhook } from './stripe.js';
import { exchangeCodeForTokens, verifyGoogleIdToken } from './google.js';
import { errorPage, deviceConnectedPage } from './pages.js';
import { adminRouter, bindAdminOnSignIn } from './admin.js';
import { blogRouter } from './blog.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// web/ lives inside server/ because the Railway service builds from the server/
// subdirectory only - anything outside it never reaches the container.
const WEB_DIR = path.join(__dirname, '..', 'web');

const app = express();
const PORT = process.env.PORT || 8787;


app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-Device-Id');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Stripe webhook needs the raw body for signature verification; register before the JSON parser.
app.post('/webhook/stripe', express.raw({ type: 'application/json' }), asyncRoute(async (req, res) => {
  const signature = req.headers['stripe-signature'];
  let event;
  try {
    event = await verifyStripeWebhook(req.body.toString('utf8'), signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (verifyError) {
    return res.status(400).json({ error: verifyError.message });
  }

  const object = event.data?.object;

  if (event.type === 'checkout.session.completed') {
    // metadata.device_id actually holds whatever "owner id" the checkout was created
    // for - an anonymous device id, or an account id for signed-in web/dashboard users.
    const ownerId = object.metadata?.device_id;
    const email = object.customer_details?.email || object.customer_email || null;
    const plan = object.metadata?.plan === 'elite' ? 'elite' : 'pro';
    if (ownerId) {
      db.prepare(
        `INSERT INTO users (id, email, plan, generations_used, period_start, stripe_customer_id, stripe_subscription_id, created_at)
         VALUES (?, ?, ?, 0, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           plan = excluded.plan,
           email = COALESCE(excluded.email, users.email),
           stripe_customer_id = excluded.stripe_customer_id,
           stripe_subscription_id = excluded.stripe_subscription_id`
      ).run(ownerId, email, plan, nowIso(), object.customer, object.subscription, nowIso());
    }
  }

  if (event.type === 'customer.subscription.updated') {
    const activePlan = object.metadata?.plan === 'elite' ? 'elite' : 'pro';
    const plan = ['active', 'trialing'].includes(object.status) ? activePlan : 'free';
    db.prepare('UPDATE users SET plan = ? WHERE stripe_subscription_id = ?').run(plan, object.id);
  }

  if (event.type === 'customer.subscription.deleted') {
    db.prepare('UPDATE users SET plan = ? WHERE stripe_subscription_id = ?').run('free', object.id);
  }

  res.json({ received: true });
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PERIOD_DAYS = 30;

// Three tiers stored in users.plan: free / pro / elite. See PLAN SPEC.
const PLAN_ENV_KEYS = { free: 'FREE_GENERATION_LIMIT', pro: 'PRO_GENERATION_LIMIT', elite: 'ELITE_GENERATION_LIMIT' };
const PLAN_DEFAULTS = { free: 5, pro: 100, elite: 300 };

function planLimit(plan) {
  const envKey = PLAN_ENV_KEYS[plan] || PLAN_ENV_KEYS.free;
  const fallback = PLAN_DEFAULTS[plan] || PLAN_DEFAULTS.free;
  return Number(process.env[envKey] || fallback);
}

// intensity gates: 'max' requires pro+, 'ultra' requires elite. Returns a clear
// upgrade message, or null if the plan is allowed to use this intensity.
function intensityGateError(plan, intensity) {
  if (intensity === 'max' && plan === 'free') {
    return 'The Max level needs the Pro plan ($19/mo).';
  }
  if (intensity === 'ultra' && plan !== 'elite') {
    return 'The Ultra level needs the Elite plan ($29/mo).';
  }
  return null;
}

function boostGateError(plan) {
  if (plan === 'free') return 'Boost needs the Pro plan ($19/mo).';
  return null;
}

// Rolls the 30-day usage window for every plan, resetting the counter when a new
// period starts.
function refreshQuotaPeriod(user) {
  const daysElapsed = (Date.now() - new Date(user.period_start).getTime()) / (1000 * 60 * 60 * 24);
  if (daysElapsed < PERIOD_DAYS) return user;

  const period_start = nowIso();
  db.prepare('UPDATE users SET generations_used = 0, period_start = ? WHERE id = ?').run(period_start, user.id);
  return { ...user, generations_used: 0, period_start };
}

function userSummary(user) {
  const limit = planLimit(user.plan);
  return {
    plan: user.plan,
    tier: user.plan,
    isPro: user.plan !== 'free',
    generationsUsed: user.generations_used,
    limit,
    remaining: Math.max(0, limit - user.generations_used),
    features: {
      maxIntensity: user.plan !== 'free',
      ultraIntensity: user.plan === 'elite',
      boost: user.plan !== 'free'
    }
  };
}

function getOrCreateUser(deviceId) {
  const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(deviceId);
  if (existing) return refreshQuotaPeriod(existing);

  const user = { id: deviceId, plan: 'free', generations_used: 0, period_start: nowIso(), created_at: nowIso(), status: 'active' };
  db.prepare(
    'INSERT INTO users (id, plan, generations_used, period_start, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(user.id, user.plan, user.generations_used, user.period_start, user.created_at);
  return user;
}

function quotaExceededError(user) {
  const limit = planLimit(user.plan);
  if (user.plan === 'elite') {
    return `You have used all ${limit} generations for this billing period.`;
  }
  if (user.plan === 'pro') {
    return `You have used all ${limit} generations for this billing period. Upgrade to Elite for 300 a month.`;
  }
  return `Free plan limit reached (${limit} tailored resumes every 30 days). Upgrade to Pro for 100 a month.`;
}

// Check-match and generate must agree on the "before" score, so check results are
// cached per (user, job) and generate reuses them as its baseline. The hash ignores
// whitespace/case noise so re-extracting the same posting maps to the same entry.
function jobHash(jobText) {
  const normalized = String(jobText || '').slice(0, 16000).toLowerCase().replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(normalized).digest('hex');
}

function saveMatchCheck(userId, jobText, score) {
  if (score == null) return;
  db.prepare(
    `INSERT INTO match_checks (user_id, job_hash, score, checked_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, job_hash) DO UPDATE SET score = excluded.score, checked_at = excluded.checked_at`
  ).run(userId, jobHash(jobText), score, nowIso());
}

function getCachedMatchScore(userId, jobText) {
  const row = db.prepare('SELECT score FROM match_checks WHERE user_id = ? AND job_hash = ?').get(userId, jobHash(jobText));
  return row ? row.score : null;
}

// A device is anonymous (owner id = its own device id) until it's linked to an
// account (Google Sign-In), at which point the account becomes the owner of
// everything that device reads and writes - resumes, generations, quota, all of it.
function resolveOwnerId(deviceId) {
  const device = db.prepare('SELECT account_id FROM devices WHERE device_id = ?').get(deviceId);
  return device?.account_id || deviceId;
}

function getOrCreateAccount(profile) {
  const existing = db.prepare('SELECT * FROM accounts WHERE google_sub = ?').get(profile.sub);
  if (existing) {
    const email = profile.email || existing.email;
    const name = profile.name || existing.name;
    const pictureUrl = profile.picture || existing.picture_url;
    db.prepare('UPDATE accounts SET email = ?, name = ?, picture_url = ? WHERE id = ?').run(email, name, pictureUrl, existing.id);
    return { ...existing, email, name, picture_url: pictureUrl };
  }

  const account = {
    id: uuid(),
    google_sub: profile.sub,
    email: profile.email || '',
    name: profile.name || '',
    picture_url: profile.picture || '',
    created_at: nowIso()
  };
  db.prepare(
    'INSERT INTO accounts (id, google_sub, email, name, picture_url, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(account.id, account.google_sub, account.email, account.name, account.picture_url, account.created_at);
  return account;
}

// One-time data promotion: the FIRST device ever linked to a fresh account inherits
// that device's existing resume/generations/quota history (simple rename of the owner
// key - safe because these tables have no enforced foreign keys). If the account
// already has its own data (e.g. a second device, or the account signed in on the
// website first), this device's older anonymous data is left behind rather than
// risking an ambiguous merge; the account's existing data wins going forward.
function linkDeviceToAccount(linkToken, account) {
  const link = db.prepare("SELECT * FROM device_links WHERE token = ? AND status = 'pending'").get(linkToken);
  if (!link || new Date(link.expires_at) < new Date()) return null;

  const deviceId = link.device_id;
  const existingAccountUser = db.prepare('SELECT * FROM users WHERE id = ?').get(account.id);
  const deviceUser = db.prepare('SELECT * FROM users WHERE id = ?').get(deviceId);

  if (deviceUser && !existingAccountUser) {
    db.prepare('UPDATE users SET id = ? WHERE id = ?').run(account.id, deviceId);
    db.prepare('UPDATE resumes SET user_id = ? WHERE user_id = ?').run(account.id, deviceId);
    db.prepare('UPDATE generations SET user_id = ? WHERE user_id = ?').run(account.id, deviceId);
    db.prepare('UPDATE match_checks SET user_id = ? WHERE user_id = ?').run(account.id, deviceId);
  }

  db.prepare(
    `INSERT INTO devices (device_id, account_id, linked_at) VALUES (?, ?, ?)
     ON CONFLICT(device_id) DO UPDATE SET account_id = excluded.account_id, linked_at = excluded.linked_at`
  ).run(deviceId, account.id, nowIso());

  db.prepare("UPDATE device_links SET status = 'consumed', account_email = ? WHERE token = ?").run(account.email, linkToken);
  return deviceId;
}

// ---- Google Sign-In (used by both the website and the extension's "sync" flow) ----

app.get('/auth/google/start', (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID) return res.status(500).send(errorPage('Google Sign-In is not configured yet.'));

  const redirect = String(req.query.redirect || `${process.env.PUBLIC_WEB_URL || process.env.PUBLIC_BASE_URL}/dashboard`);
  const linkToken = req.query.linkToken ? String(req.query.linkToken) : null;
  const state = uuid();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  db.prepare('INSERT INTO oauth_states (state, redirect_uri, link_token, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(state, redirect, linkToken, nowIso(), expiresAt);

  const googleUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  googleUrl.searchParams.set('client_id', process.env.GOOGLE_CLIENT_ID);
  googleUrl.searchParams.set('redirect_uri', `${process.env.PUBLIC_BASE_URL}/auth/google/callback`);
  googleUrl.searchParams.set('response_type', 'code');
  googleUrl.searchParams.set('scope', 'openid email profile');
  googleUrl.searchParams.set('state', state);
  googleUrl.searchParams.set('prompt', 'select_account');
  res.redirect(googleUrl.toString());
});

app.get('/auth/google/callback', asyncRoute(async (req, res) => {
  const { code, state, error: googleError } = req.query;
  const stateRow = state ? db.prepare('SELECT * FROM oauth_states WHERE state = ?').get(String(state)) : null;
  if (stateRow) db.prepare('DELETE FROM oauth_states WHERE state = ?').run(String(state)); // one-time use

  if (googleError) return res.status(400).send(errorPage('Google sign-in was cancelled.'));
  if (!stateRow || new Date(stateRow.expires_at) < new Date()) {
    return res.status(400).send(errorPage('This sign-in link expired. Please try again from the extension or website.'));
  }
  if (!code) return res.status(400).send(errorPage('Google did not return a sign-in code.'));

  const tokens = await exchangeCodeForTokens({
    code: String(code),
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    redirectUri: `${process.env.PUBLIC_BASE_URL}/auth/google/callback`
  });
  const profile = await verifyGoogleIdToken(tokens.id_token, process.env.GOOGLE_CLIENT_ID);
  const account = getOrCreateAccount(profile);
  bindAdminOnSignIn(account, process.env.OWNER_EMAIL);

  if (stateRow.link_token) {
    linkDeviceToAccount(stateRow.link_token, account);
    return res.send(deviceConnectedPage(account.email));
  }

  const sessionToken = await signToken({ aid: account.id }, process.env.AUTH_SECRET, 60 * 60 * 24 * 30);
  const redirectUrl = new URL(stateRow.redirect_uri);
  redirectUrl.hash = `token=${sessionToken}`;
  res.redirect(redirectUrl.toString());
}));

// ---- Authenticated (device-id) API - used by the extension, no sign-in required ----

const authed = express.Router();
authed.use(deviceAuth);

authed.get('/me', (req, res) => {
  res.json(userSummary(getOrCreateUser(resolveOwnerId(req.deviceId))));
});

// Everything the popup needs to restore itself when reopened: plan, stored resume,
// and the most recent generation (with match scores) so nothing "goes away".
authed.get('/state', (req, res) => {
  const ownerId = resolveOwnerId(req.deviceId);
  const user = getOrCreateUser(ownerId);
  const resumeRow = db.prepare('SELECT filename, updated_at FROM resumes WHERE user_id = ?').get(ownerId);
  const generation = db.prepare(
    'SELECT id, job_title, job_url, current_text, match_before, match_after, updated_at FROM generations WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1'
  ).get(ownerId);
  const accountRow = db.prepare(
    'SELECT a.email, a.name FROM devices d JOIN accounts a ON a.id = d.account_id WHERE d.device_id = ?'
  ).get(req.deviceId);

  res.json({
    user: userSummary(user),
    resume: resumeRow ? { filename: resumeRow.filename, updatedAt: resumeRow.updated_at } : null,
    generation: generation
      ? {
          id: generation.id,
          jobTitle: generation.job_title,
          jobUrl: generation.job_url,
          text: generation.current_text,
          matchBefore: generation.match_before,
          matchAfter: generation.match_after,
          updatedAt: generation.updated_at
        }
      : null,
    account: accountRow ? { email: accountRow.email, name: accountRow.name } : null
  });
});

authed.post('/resume', (req, res) => {
  const ownerId = resolveOwnerId(req.deviceId);
  getOrCreateUser(ownerId);
  const text = String(req.body.resumeText || '').trim();
  const filename = String(req.body.filename || 'resume').slice(0, 200);
  if (!text) return res.status(400).json({ error: 'resumeText is required.' });

  db.prepare(
    `INSERT INTO resumes (user_id, filename, resume_text, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET filename = excluded.filename, resume_text = excluded.resume_text, updated_at = excluded.updated_at`
  ).run(ownerId, filename, text, nowIso());

  // A different resume invalidates every cached check score.
  db.prepare('DELETE FROM match_checks WHERE user_id = ?').run(ownerId);

  res.json({ ok: true });
});

authed.post('/generate', asyncRoute(async (req, res) => {
  const ownerId = resolveOwnerId(req.deviceId);
  const user = getOrCreateUser(ownerId);
  if (user.status === 'paused') {
    return res.status(403).json({ error: 'Your account is paused. Contact support.' });
  }
  if (user.generations_used >= planLimit(user.plan)) {
    return res.status(402).json({ error: quotaExceededError(user), quota: userSummary(user) });
  }

  const resumeRow = db.prepare('SELECT * FROM resumes WHERE user_id = ?').get(ownerId);
  if (!resumeRow) return res.status(400).json({ error: 'Upload a resume first.' });

  const job = { title: req.body.jobTitle || '', url: req.body.jobUrl || '', text: req.body.jobText || '' };
  if (!job.text.trim()) return res.status(400).json({ error: 'jobText is required.' });

  const intensity = ['minimal', 'balanced', 'max', 'ultra'].includes(req.body.intensity) ? req.body.intensity : 'balanced';
  const intensityGate = intensityGateError(user.plan, intensity);
  if (intensityGate) return res.status(403).json({ error: intensityGate, upgrade: true });

  // Single source of truth for the before-score: reuse the cached Check-match result
  // for this exact job, or run the same score-only pass now. The tailoring call is
  // then anchored to it, so Check match and Generate can never disagree.
  let anchoredBefore = getCachedMatchScore(ownerId, job.text);
  if (anchoredBefore == null) {
    const check = await scoreMatch(resumeRow.resume_text, job, process.env.ANTHROPIC_API_KEY);
    anchoredBefore = check.match;
    saveMatchCheck(ownerId, job.text, anchoredBefore);
  }

  const result = await tailorResume(resumeRow.resume_text, job, process.env.ANTHROPIC_API_KEY, intensity, anchoredBefore);
  const matchBefore = anchoredBefore ?? result.matchBefore;
  const matchAfter = result.matchAfter;

  const generationId = uuid();
  const timestamp = nowIso();
  db.prepare(
    'INSERT INTO generations (id, user_id, job_title, job_url, job_text, current_text, match_before, match_after, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(generationId, ownerId, job.title, job.url, job.text.slice(0, 20000), result.text, matchBefore, matchAfter, timestamp, timestamp);

  db.prepare('UPDATE users SET generations_used = generations_used + 1 WHERE id = ?').run(ownerId);
  const updatedUser = { ...user, generations_used: user.generations_used + 1 };

  res.json({
    generationId,
    text: result.text,
    summary: result.summary,
    match: { before: matchBefore, after: matchAfter },
    quota: userSummary(updatedUser)
  });
}));

// Score-only check: one Claude call, no rewriting, nothing stored, no quota used.
authed.post('/match', asyncRoute(async (req, res) => {
  const ownerId = resolveOwnerId(req.deviceId);
  const user = getOrCreateUser(ownerId);
  if (user.status === 'paused') {
    return res.status(403).json({ error: 'Your account is paused. Contact support.' });
  }

  const resumeRow = db.prepare('SELECT * FROM resumes WHERE user_id = ?').get(ownerId);
  if (!resumeRow) return res.status(400).json({ error: 'Upload a resume first.' });

  const job = { title: req.body.jobTitle || '', url: req.body.jobUrl || '', text: req.body.jobText || '' };
  if (!job.text.trim()) return res.status(400).json({ error: 'jobText is required.' });

  const result = await scoreMatch(resumeRow.resume_text, job, process.env.ANTHROPIC_API_KEY);
  saveMatchCheck(ownerId, job.text, result.match);

  res.json({
    match: result.match,
    matchedKeywords: result.matchedKeywords,
    missingKeywords: result.missingKeywords,
    verdict: result.verdict
  });
}));

authed.post('/revise', asyncRoute(async (req, res) => {
  const ownerId = resolveOwnerId(req.deviceId);
  const user = getOrCreateUser(ownerId);
  if (user.status === 'paused') {
    return res.status(403).json({ error: 'Your account is paused. Contact support.' });
  }
  const generationId = String(req.body.generationId || '');
  const instruction = String(req.body.instruction || '').trim();
  if (!instruction) return res.status(400).json({ error: 'instruction is required.' });

  const generation = db.prepare('SELECT * FROM generations WHERE id = ? AND user_id = ?').get(generationId, ownerId);
  if (!generation) return res.status(404).json({ error: 'Generation not found.' });

  const result = await reviseResume(generation.current_text, instruction, generation.job_text || '', process.env.ANTHROPIC_API_KEY);
  const timestamp = nowIso();

  db.prepare('UPDATE generations SET current_text = ?, match_after = COALESCE(?, match_after), updated_at = ? WHERE id = ?')
    .run(result.text, result.matchAfter, timestamp, generationId);
  db.prepare('INSERT INTO revisions (id, generation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(uuid(), generationId, 'user', instruction, timestamp);
  db.prepare('INSERT INTO revisions (id, generation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(uuid(), generationId, 'assistant', result.summary, timestamp);

  res.json({
    text: result.text,
    summary: result.summary,
    match: { before: generation.match_before, after: result.matchAfter ?? generation.match_after }
  });
}));

authed.post('/boost', asyncRoute(async (req, res) => {
  const ownerId = resolveOwnerId(req.deviceId);
  const user = getOrCreateUser(ownerId);
  if (user.status === 'paused') {
    return res.status(403).json({ error: 'Your account is paused. Contact support.' });
  }
  const boostGate = boostGateError(user.plan);
  if (boostGate) return res.status(403).json({ error: boostGate, upgrade: true });
  if (user.generations_used >= planLimit(user.plan)) {
    return res.status(402).json({ error: quotaExceededError(user), quota: userSummary(user) });
  }
  const generationId = String(req.body.generationId || '');

  const generation = db.prepare('SELECT * FROM generations WHERE id = ? AND user_id = ?').get(generationId, ownerId);
  if (!generation) return res.status(404).json({ error: 'Generation not found.' });

  const previousAfter = generation.match_after;
  const result = await boostResume(generation.current_text, generation.job_text || '', previousAfter, process.env.ANTHROPIC_API_KEY);
  const timestamp = nowIso();

  db.prepare('UPDATE generations SET current_text = ?, match_after = COALESCE(?, match_after), updated_at = ? WHERE id = ?')
    .run(result.text, result.matchAfter, timestamp, generationId);
  db.prepare('INSERT INTO revisions (id, generation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(uuid(), generationId, 'user', 'Boost the match higher.', timestamp);
  db.prepare('INSERT INTO revisions (id, generation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(uuid(), generationId, 'assistant', result.summary, timestamp);

  db.prepare('UPDATE users SET generations_used = generations_used + 1 WHERE id = ?').run(ownerId);
  const updatedUser = { ...user, generations_used: user.generations_used + 1 };

  res.json({
    text: result.text,
    summary: result.summary,
    match: { before: previousAfter, after: result.matchAfter ?? previousAfter },
    quota: userSummary(updatedUser)
  });
}));

authed.post('/checkout', asyncRoute(async (req, res) => {
  const ownerId = resolveOwnerId(req.deviceId);
  const user = getOrCreateUser(ownerId);
  const plan = req.body?.plan === 'elite' ? 'elite' : 'pro';

  const successUrl = req.body?.successUrl || `${process.env.PUBLIC_BASE_URL}/billing/success`;
  const cancelUrl = req.body?.cancelUrl || `${process.env.PUBLIC_BASE_URL}/billing/cancel`;

  try {
    const session = await createCheckoutSession(process.env, user, successUrl, cancelUrl, plan);
    res.json({ url: session.url });
  } catch (checkoutError) {
    res.status(500).json({ error: checkoutError.message });
  }
}));

// Device-code style handshake: the extension gets a link to open in a new tab (Google
// Sign-In happens there, never inside the extension popup), then polls until the
// device has been linked to an account.
authed.post('/link/start', (req, res) => {
  const token = uuid();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO device_links (token, device_id, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(token, req.deviceId, 'pending', nowIso(), expiresAt);

  const webBase = process.env.PUBLIC_WEB_URL || process.env.PUBLIC_BASE_URL;
  const linkUrl = `${process.env.PUBLIC_BASE_URL}/auth/google/start?linkToken=${token}&redirect=${encodeURIComponent(`${webBase}/connected`)}`;
  res.json({ token, linkUrl, expiresAt });
});

authed.get('/link/status', (req, res) => {
  const token = String(req.query.token || '');
  const link = db.prepare('SELECT * FROM device_links WHERE token = ?').get(token);
  if (!link) return res.status(404).json({ error: 'Unknown link request.' });
  res.json({ status: link.status, email: link.account_email || null });
});

app.use('/api', authed);

// ---- Account API (website dashboard) - Google session, not device id ----

const account = express.Router();
account.use(accountAuth);

account.get('/me', (req, res) => {
  const user = getOrCreateUser(req.accountId);
  const acct = db.prepare('SELECT email, name, picture_url FROM accounts WHERE id = ?').get(req.accountId);
  res.json({ ...userSummary(user), email: acct?.email, name: acct?.name, pictureUrl: acct?.picture_url });
});

// Every tailored resume the account owns, most recent first - the dashboard's list.
account.get('/resumes', (req, res) => {
  const rows = db.prepare(
    'SELECT id, job_title, job_url, match_before, match_after, created_at, updated_at FROM generations WHERE user_id = ? ORDER BY updated_at DESC'
  ).all(req.accountId);
  res.json(rows.map((row) => ({
    id: row.id,
    jobTitle: row.job_title,
    jobUrl: row.job_url,
    matchBefore: row.match_before,
    matchAfter: row.match_after,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  })));
});

account.get('/resumes/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM generations WHERE id = ? AND user_id = ?').get(req.params.id, req.accountId);
  if (!row) return res.status(404).json({ error: 'Resume not found.' });
  res.json({
    id: row.id,
    jobTitle: row.job_title,
    jobUrl: row.job_url,
    text: row.current_text,
    matchBefore: row.match_before,
    matchAfter: row.match_after,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
});

account.post('/checkout', asyncRoute(async (req, res) => {
  const user = getOrCreateUser(req.accountId);
  const plan = req.body?.plan === 'elite' ? 'elite' : 'pro';
  const successUrl = req.body?.successUrl || `${process.env.PUBLIC_WEB_URL}/dashboard?upgraded=1`;
  const cancelUrl = req.body?.cancelUrl || `${process.env.PUBLIC_WEB_URL}/dashboard`;

  try {
    const session = await createCheckoutSession(process.env, user, successUrl, cancelUrl, plan);
    res.json({ url: session.url });
  } catch (checkoutError) {
    res.status(500).json({ error: checkoutError.message });
  }
}));

// Newest 50 in-app notifications for the signed-in account, and marking one read.
account.get('/notifications', (req, res) => {
  const rows = db.prepare(
    'SELECT id, title, body, created_at, read_at FROM notifications WHERE account_id = ? ORDER BY created_at DESC LIMIT 50'
  ).all(req.accountId);
  res.json(rows.map((row) => ({
    id: row.id,
    title: row.title,
    body: row.body,
    createdAt: row.created_at,
    readAt: row.read_at
  })));
});

account.post('/notifications/:id/read', (req, res) => {
  const row = db.prepare('SELECT id FROM notifications WHERE id = ? AND account_id = ?').get(req.params.id, req.accountId);
  if (!row) return res.status(404).json({ error: 'Notification not found.' });
  db.prepare('UPDATE notifications SET read_at = ? WHERE id = ?').run(nowIso(), req.params.id);
  res.json({ ok: true });
});

app.use('/account', account);

app.get('/billing/success', (req, res) => res.send('<h1>Payment successful</h1><p>Go back to the extension - your plan will update within a few seconds.</p>'));
app.get('/billing/cancel', (req, res) => res.send('<h1>Checkout canceled</h1><p>No charge was made. You can close this tab.</p>'));

// ---- Admin (JSON API + the admin page shell; auth is enforced client-side by /admin/me) ----
// The HTML route must be registered BEFORE the router, or the router's auth middleware
// intercepts GET /admin itself and 401s the page.

app.get('/admin', (req, res) => res.sendFile(path.join(WEB_DIR, 'admin.html')));
app.use('/admin', adminRouter);

// ---- Public blog ----

app.use('/blog', blogRouter);

// ---- Website (static files) ----

app.use(express.static(WEB_DIR));
app.get('/dashboard', (req, res) => res.sendFile(path.join(WEB_DIR, 'dashboard.html')));

app.use((req, res) => res.status(404).json({ error: 'Not found.' }));

app.listen(PORT, () => {
  console.log(`Job Resume Tailor server listening on http://localhost:${PORT}`);
});
