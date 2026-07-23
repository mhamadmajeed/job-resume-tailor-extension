import 'dotenv/config';
import express from 'express';
import { db } from './db.js';
import { uuid, nowIso, deviceAuth, asyncRoute } from './util.js';
import { tailorResume, reviseResume } from './claude.js';
import { createCheckoutSession, verifyStripeWebhook } from './stripe.js';

const app = express();
const PORT = process.env.PORT || 8787;
const WATERMARK = '\n\n---\nMade with Job Resume Tailor (Free plan) - upgrade to remove this line.';

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
    const deviceId = object.metadata?.device_id;
    const email = object.customer_details?.email || object.customer_email || null;
    if (deviceId) {
      db.prepare(
        `INSERT INTO users (id, email, plan, generations_used, period_start, stripe_customer_id, stripe_subscription_id, created_at)
         VALUES (?, ?, 'pro', 0, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           plan = 'pro',
           email = COALESCE(excluded.email, users.email),
           stripe_customer_id = excluded.stripe_customer_id,
           stripe_subscription_id = excluded.stripe_subscription_id`
      ).run(deviceId, email, nowIso(), object.customer, object.subscription, nowIso());
    }
  }

  if (event.type === 'customer.subscription.updated') {
    const plan = ['active', 'trialing'].includes(object.status) ? 'pro' : 'free';
    db.prepare('UPDATE users SET plan = ? WHERE stripe_subscription_id = ?').run(plan, object.id);
  }

  if (event.type === 'customer.subscription.deleted') {
    db.prepare('UPDATE users SET plan = ? WHERE stripe_subscription_id = ?').run('free', object.id);
  }

  res.json({ received: true });
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

function userSummary(user) {
  return {
    plan: user.plan,
    isPro: user.plan === 'pro',
    generationsUsed: user.generations_used
  };
}

function getOrCreateUser(deviceId) {
  const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(deviceId);
  if (existing) return existing;

  const user = { id: deviceId, plan: 'free', generations_used: 0, period_start: nowIso(), created_at: nowIso() };
  db.prepare(
    'INSERT INTO users (id, plan, generations_used, period_start, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(user.id, user.plan, user.generations_used, user.period_start, user.created_at);
  return user;
}

function applyWatermark(text, isPro) {
  return isPro ? text : `${text}${WATERMARK}`;
}

// ---- Authenticated (device-id) API - no accounts, no sign-in ----

const authed = express.Router();
authed.use(deviceAuth);

authed.get('/me', (req, res) => {
  res.json(userSummary(getOrCreateUser(req.deviceId)));
});

// Everything the popup needs to restore itself when reopened: plan, stored resume,
// and the most recent generation (with match scores) so nothing "goes away".
authed.get('/state', (req, res) => {
  const user = getOrCreateUser(req.deviceId);
  const resumeRow = db.prepare('SELECT filename, updated_at FROM resumes WHERE user_id = ?').get(req.deviceId);
  const generation = db.prepare(
    'SELECT id, job_title, job_url, current_text, match_before, match_after, updated_at FROM generations WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1'
  ).get(req.deviceId);

  res.json({
    user: userSummary(user),
    resume: resumeRow ? { filename: resumeRow.filename, updatedAt: resumeRow.updated_at } : null,
    generation: generation
      ? {
          id: generation.id,
          jobTitle: generation.job_title,
          jobUrl: generation.job_url,
          text: applyWatermark(generation.current_text, user.plan === 'pro'),
          matchBefore: generation.match_before,
          matchAfter: generation.match_after,
          updatedAt: generation.updated_at
        }
      : null
  });
});

authed.post('/resume', (req, res) => {
  getOrCreateUser(req.deviceId);
  const text = String(req.body.resumeText || '').trim();
  const filename = String(req.body.filename || 'resume').slice(0, 200);
  if (!text) return res.status(400).json({ error: 'resumeText is required.' });

  db.prepare(
    `INSERT INTO resumes (user_id, filename, resume_text, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET filename = excluded.filename, resume_text = excluded.resume_text, updated_at = excluded.updated_at`
  ).run(req.deviceId, filename, text, nowIso());

  res.json({ ok: true });
});

authed.post('/generate', asyncRoute(async (req, res) => {
  const user = getOrCreateUser(req.deviceId);

  const resumeRow = db.prepare('SELECT * FROM resumes WHERE user_id = ?').get(req.deviceId);
  if (!resumeRow) return res.status(400).json({ error: 'Upload a resume first.' });

  const job = { title: req.body.jobTitle || '', url: req.body.jobUrl || '', text: req.body.jobText || '' };
  if (!job.text.trim()) return res.status(400).json({ error: 'jobText is required.' });

  const intensity = ['minimal', 'balanced', 'max'].includes(req.body.intensity) ? req.body.intensity : 'balanced';
  const result = await tailorResume(resumeRow.resume_text, job, process.env.ANTHROPIC_API_KEY, intensity);

  const generationId = uuid();
  const timestamp = nowIso();
  db.prepare(
    'INSERT INTO generations (id, user_id, job_title, job_url, job_text, current_text, match_before, match_after, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(generationId, req.deviceId, job.title, job.url, job.text.slice(0, 20000), result.text, result.matchBefore, result.matchAfter, timestamp, timestamp);

  db.prepare('UPDATE users SET generations_used = generations_used + 1 WHERE id = ?').run(req.deviceId);
  const updatedUser = { ...user, generations_used: user.generations_used + 1 };

  res.json({
    generationId,
    text: applyWatermark(result.text, updatedUser.plan === 'pro'),
    summary: result.summary,
    match: { before: result.matchBefore, after: result.matchAfter },
    quota: userSummary(updatedUser)
  });
}));

authed.post('/revise', asyncRoute(async (req, res) => {
  const user = getOrCreateUser(req.deviceId);
  const generationId = String(req.body.generationId || '');
  const instruction = String(req.body.instruction || '').trim();
  if (!instruction) return res.status(400).json({ error: 'instruction is required.' });

  const generation = db.prepare('SELECT * FROM generations WHERE id = ? AND user_id = ?').get(generationId, req.deviceId);
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
    text: applyWatermark(result.text, user.plan === 'pro'),
    summary: result.summary,
    match: { before: generation.match_before, after: result.matchAfter ?? generation.match_after }
  });
}));

authed.post('/checkout', asyncRoute(async (req, res) => {
  const user = getOrCreateUser(req.deviceId);

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

app.get('/billing/success', (req, res) => res.send('<h1>Payment successful</h1><p>Go back to the extension - your plan will update within a few seconds.</p>'));
app.get('/billing/cancel', (req, res) => res.send('<h1>Checkout canceled</h1><p>No charge was made. You can close this tab.</p>'));

app.use((req, res) => res.status(404).json({ error: 'Not found.' }));

app.listen(PORT, () => {
  console.log(`Job Resume Tailor server listening on http://localhost:${PORT}`);
});
