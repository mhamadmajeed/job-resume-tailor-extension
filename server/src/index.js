import 'dotenv/config';
import express from 'express';
import { db } from './db.js';
import { uuid, nowIso, signToken, requireAuth, asyncRoute } from './util.js';
import { emailFormPage, linkSentPage, confirmedPage, errorPage } from './pages.js';
import { sendMagicLinkEmail } from './email.js';
import { tailorResume, reviseResume } from './gemini.js';
import { createCheckoutSession, verifyStripeWebhook } from './stripe.js';

const app = express();
const PORT = process.env.PORT || 8787;
const SESSION_TTL_SECONDS = 15 * 60;
const AUTH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const PRO_PERIOD_DAYS = 30;

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
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
    const userId = object.metadata?.user_id;
    if (userId) {
      db.prepare(
        'UPDATE users SET plan = ?, stripe_customer_id = ?, stripe_subscription_id = ?, generations_used = 0, period_start = ? WHERE id = ?'
      ).run('pro', object.customer, object.subscription, nowIso(), userId);
    }
  }

  if (event.type === 'customer.subscription.deleted') {
    db.prepare('UPDATE users SET plan = ? WHERE stripe_subscription_id = ?').run('free', object.id);
  }

  res.json({ received: true });
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

function planLimit(plan) {
  return plan === 'pro' ? Number(process.env.PRO_GENERATION_LIMIT || 100) : Number(process.env.FREE_GENERATION_LIMIT || 5);
}

function refreshQuotaPeriod(user) {
  if (user.plan !== 'pro') return user;
  const daysElapsed = (Date.now() - new Date(user.period_start).getTime()) / (1000 * 60 * 60 * 24);
  if (daysElapsed < PRO_PERIOD_DAYS) return user;

  const period_start = nowIso();
  db.prepare('UPDATE users SET generations_used = 0, period_start = ? WHERE id = ?').run(period_start, user.id);
  return { ...user, generations_used: 0, period_start };
}

function userSummary(user) {
  const limit = planLimit(user.plan);
  return {
    email: user.email,
    plan: user.plan,
    generationsUsed: user.generations_used,
    limit,
    remaining: Math.max(0, limit - user.generations_used)
  };
}

function getOrCreateUser(email) {
  const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (existing) return existing;

  const user = { id: uuid(), email, plan: 'free', generations_used: 0, period_start: nowIso(), created_at: nowIso() };
  db.prepare(
    'INSERT INTO users (id, email, plan, generations_used, period_start, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(user.id, user.email, user.plan, user.generations_used, user.period_start, user.created_at);
  return user;
}

// ---- Auth (email magic link, device-code style polling) ----

app.post('/auth/start', asyncRoute(async (req, res) => {
  const sessionId = uuid();
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();
  db.prepare('INSERT INTO login_sessions (session_id, status, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(sessionId, 'pending', createdAt, expiresAt);

  res.json({ sessionId, verifyUrl: `${process.env.PUBLIC_BASE_URL}/auth/verify-page?session=${sessionId}` });
}));

app.get('/auth/verify-page', (req, res) => {
  const session = db.prepare('SELECT * FROM login_sessions WHERE session_id = ?').get(req.query.session);
  if (!session) return res.status(404).send(errorPage('This sign-in link is invalid or has expired.'));
  res.send(emailFormPage(req.query.session));
});

app.post('/auth/send-link', asyncRoute(async (req, res) => {
  const sessionId = String(req.body.sessionId || '');
  const email = String(req.body.email || '').trim().toLowerCase();

  const session = db.prepare('SELECT * FROM login_sessions WHERE session_id = ?').get(sessionId);
  if (!session) return res.status(404).send(errorPage('This sign-in link is invalid or has expired.'));
  if (!email || !email.includes('@')) return res.send(emailFormPage(sessionId, 'Enter a valid email address.'));

  const magicToken = uuid();
  db.prepare('UPDATE login_sessions SET email = ?, magic_token = ? WHERE session_id = ?').run(email, magicToken, sessionId);

  const confirmUrl = `${process.env.PUBLIC_BASE_URL}/auth/confirm?token=${magicToken}`;
  const result = await sendMagicLinkEmail(process.env, email, confirmUrl);
  res.send(linkSentPage(result.sent ? null : confirmUrl));
}));

app.get('/auth/confirm', asyncRoute(async (req, res) => {
  const session = db.prepare('SELECT * FROM login_sessions WHERE magic_token = ?').get(req.query.token);
  if (!session) return res.status(404).send(errorPage('This sign-in link is invalid or has already been used.'));
  if (new Date(session.expires_at).getTime() < Date.now()) {
    return res.status(410).send(errorPage('This sign-in link has expired. Go back to the extension and try again.'));
  }

  const user = getOrCreateUser(session.email);
  const bearerToken = await signToken({ uid: user.id, email: user.email }, process.env.AUTH_SECRET, AUTH_TOKEN_TTL_SECONDS);

  db.prepare('UPDATE login_sessions SET status = ?, bearer_token = ? WHERE session_id = ?')
    .run('verified', bearerToken, session.session_id);

  res.send(confirmedPage());
}));

app.get('/auth/poll', (req, res) => {
  const session = db.prepare('SELECT * FROM login_sessions WHERE session_id = ?').get(req.query.sessionId);
  if (!session) return res.status(404).json({ error: 'Unknown session.' });
  if (session.status !== 'verified') return res.json({ status: session.status });

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(session.email);
  res.json({ status: 'verified', token: session.bearer_token, user: userSummary(user) });
});

// ---- Authenticated API ----

const authed = express.Router();
authed.use(requireAuth);

authed.get('/me', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.auth.uid);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  res.json(userSummary(user));
});

authed.post('/resume', (req, res) => {
  const text = String(req.body.resumeText || '').trim();
  const filename = String(req.body.filename || 'resume').slice(0, 200);
  if (!text) return res.status(400).json({ error: 'resumeText is required.' });

  db.prepare(
    `INSERT INTO resumes (user_id, filename, resume_text, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET filename = excluded.filename, resume_text = excluded.resume_text, updated_at = excluded.updated_at`
  ).run(req.auth.uid, filename, text, nowIso());

  res.json({ ok: true });
});

authed.post('/generate', asyncRoute(async (req, res) => {
  let user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.auth.uid);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  user = refreshQuotaPeriod(user);

  const limit = planLimit(user.plan);
  if (user.generations_used >= limit) {
    return res.status(402).json({
      error: user.plan === 'pro'
        ? 'You have used all generations for this billing period.'
        : 'Free plan limit reached (5 generations). Upgrade for 100 generations a month.'
    });
  }

  const resumeRow = db.prepare('SELECT * FROM resumes WHERE user_id = ?').get(req.auth.uid);
  if (!resumeRow) return res.status(400).json({ error: 'Upload a resume first.' });

  const job = { title: req.body.jobTitle || '', url: req.body.jobUrl || '', text: req.body.jobText || '' };
  if (!job.text.trim()) return res.status(400).json({ error: 'jobText is required.' });

  const result = await tailorResume(resumeRow.resume_text, job, process.env.GEMINI_API_KEY);

  const generationId = uuid();
  const timestamp = nowIso();
  db.prepare(
    'INSERT INTO generations (id, user_id, job_title, job_url, current_text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(generationId, req.auth.uid, job.title, job.url, result.text, timestamp, timestamp);

  db.prepare('UPDATE users SET generations_used = generations_used + 1 WHERE id = ?').run(req.auth.uid);
  const updatedUser = { ...user, generations_used: user.generations_used + 1 };

  res.json({ generationId, text: result.text, summary: result.summary, quota: userSummary(updatedUser) });
}));

authed.post('/revise', asyncRoute(async (req, res) => {
  const generationId = String(req.body.generationId || '');
  const instruction = String(req.body.instruction || '').trim();
  if (!instruction) return res.status(400).json({ error: 'instruction is required.' });

  const generation = db.prepare('SELECT * FROM generations WHERE id = ? AND user_id = ?').get(generationId, req.auth.uid);
  if (!generation) return res.status(404).json({ error: 'Generation not found.' });

  const result = await reviseResume(generation.current_text, instruction, process.env.GEMINI_API_KEY);
  const timestamp = nowIso();

  db.prepare('UPDATE generations SET current_text = ?, updated_at = ? WHERE id = ?').run(result.text, timestamp, generationId);
  db.prepare('INSERT INTO revisions (id, generation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(uuid(), generationId, 'user', instruction, timestamp);
  db.prepare('INSERT INTO revisions (id, generation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(uuid(), generationId, 'assistant', result.summary, timestamp);

  res.json({ text: result.text, summary: result.summary });
}));

authed.post('/checkout', asyncRoute(async (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.auth.uid);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  const successUrl = req.body?.successUrl || `${process.env.PUBLIC_BASE_URL}/billing/success`;
  const cancelUrl = req.body?.cancelUrl || `${process.env.PUBLIC_BASE_URL}/billing/cancel`;

  try {
    const session = await createCheckoutSession(process.env, user, successUrl, cancelUrl);
    res.json({ url: session.url });
  } catch (checkoutError) {
    res.status(500).json({ error: checkoutError.message });
  }
}));

app.use('/api', authed);

app.use((req, res) => res.status(404).json({ error: 'Not found.' }));

app.listen(PORT, () => {
  console.log(`Job Resume Tailor server listening on http://localhost:${PORT}`);
});
