import 'dotenv/config';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import express from 'express';
import { db } from './db.js';
import { uuid, nowIso, deviceAuth, accountAuth, signToken, asyncRoute } from './util.js';
import { tailorResume, reviseResume, boostResume, scoreMatch } from './claude.js';
import { createCheckoutSession, createPlanPrice, verifyStripeWebhook } from './stripe.js';
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

// Three tiers stored in users.plan: free / pro / elite, admin-editable via the
// plan_settings table (price + monthly quota + the Stripe product/price backing it).
// Env vars (FREE_GENERATION_LIMIT etc.) and hardcoded $19/$29 only matter as the
// one-time seed in db.js - from here on the DB row is the single source of truth.
function getPlanSettings(plan) {
  const row = db.prepare('SELECT * FROM plan_settings WHERE plan = ?').get(plan);
  if (row) return row;
  // Should never happen post-seed, but keep the server usable if it does.
  return { plan, price_usd: plan === 'free' ? 0 : 19, generation_limit: 5, stripe_product_id: null, stripe_price_id: null };
}

function planLimit(plan) {
  return getPlanSettings(plan).generation_limit;
}

// cycle is 'monthly' or 'yearly'. Yearly is admin-set (usually ~2 months free vs.
// monthly x12) and stored in its own column since it's a genuinely different price,
// not a derived discount.
function planPrice(plan, cycle = 'monthly') {
  const settings = getPlanSettings(plan);
  if (cycle === 'yearly') return settings.price_usd_yearly || Math.round(settings.price_usd * 12);
  return settings.price_usd;
}

// The monthly Stripe price always exists (seeded / minted on admin save). The yearly
// one is minted lazily on the first yearly checkout, so yearly billing works without
// the admin ever having to open the Plans tab.
async function resolveCheckoutPriceId(plan, cycle) {
  const settings = getPlanSettings(plan);
  if (cycle !== 'yearly') return settings.stripe_price_id;
  if (settings.stripe_price_id_yearly) return settings.stripe_price_id_yearly;
  if (!settings.price_usd_yearly || !settings.stripe_product_id) return null;

  const priceId = await createPlanPrice(process.env, settings.stripe_product_id, settings.price_usd_yearly, 'year');
  db.prepare('UPDATE plan_settings SET stripe_price_id_yearly = ?, updated_at = ? WHERE plan = ?')
    .run(priceId, nowIso(), plan);
  return priceId;
}

// intensity gates: 'max' requires pro+, 'ultra' requires elite. Returns a clear
// upgrade message, or null if the plan is allowed to use this intensity.
// Every feature is available on every plan - the only difference between tiers is
// the monthly quota. No money talk until the free allowance is actually used up.
function intensityGateError(_plan, _intensity) {
  return null;
}

function boostGateError(_plan) {
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
      maxIntensity: true,
      ultraIntensity: true,
      boost: true
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
    const eliteLimit = planLimit('elite');
    return `You have used all ${limit} generations for this billing period. Upgrade to Elite for ${eliteLimit} a month.`;
  }
  const proPrice = planPrice('pro');
  const proLimit = planLimit('pro');
  const elitePrice = planPrice('elite');
  const eliteLimit = planLimit('elite');
  return `Your ${limit} free tailored resumes for this month are used. Subscribe to keep going - Pro ($${proPrice}/mo, ${proLimit}/month) or Elite ($${elitePrice}/mo, ${eliteLimit}/month).`;
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

// ---- Discounts / offers (see DISCOUNT SPEC) ----

const URGENCY_MIN_MS = 45 * 60 * 1000;
const URGENCY_MAX_MS = 18 * 60 * 60 * 1000;
const URGENCY_COOLDOWN_MS = 15 * 24 * 60 * 60 * 1000;
const VISITOR_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

function parseCookies(header) {
  const cookies = {};
  String(header || '').split(';').forEach((pair) => {
    const separatorIndex = pair.indexOf('=');
    if (separatorIndex === -1) return;
    const key = pair.slice(0, separatorIndex).trim();
    const value = pair.slice(separatorIndex + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  });
  return cookies;
}

// Only the public offer endpoint issues the cookie - it needs a stable identity to
// hand a visitor their personal urgency window. Checkout routes only ever read it.
function getOrSetVisitorId(req, res) {
  const existing = parseCookies(req.headers.cookie).rp_visitor;
  if (existing) return existing;

  const visitorId = uuid();
  const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
  const attributes = [
    `rp_visitor=${visitorId}`,
    'HttpOnly',
    `Max-Age=${VISITOR_COOKIE_MAX_AGE}`,
    'SameSite=Lax',
    'Path=/'
  ];
  if (isHttps) attributes.push('Secure');
  res.setHeader('Set-Cookie', attributes.join('; '));
  return visitorId;
}

function randomUrgencyDurationMs() {
  return URGENCY_MIN_MS + Math.random() * (URGENCY_MAX_MS - URGENCY_MIN_MS);
}

function getActiveDiscount(type) {
  return db.prepare('SELECT * FROM discounts WHERE type = ? AND active = 1 LIMIT 1').get(type);
}

// Resolves (lazily creating if needed) one visitor's personal urgency window for the
// given urgency discount. An open window is never reset by a refresh; once it expires
// the visitor is in cooldown (no offer); once the cooldown lapses, the next call opens
// a brand-new random window.
function resolveUrgencyWindow(visitorId, discount) {
  if (!visitorId || !discount) return null;
  const now = Date.now();
  const existing = db.prepare(
    'SELECT * FROM visitor_offers WHERE visitor_id = ? AND discount_id = ?'
  ).get(visitorId, discount.id);

  if (existing) {
    if (now < new Date(existing.expires_at).getTime()) {
      return { expiresAt: existing.expires_at };
    }
    if (now < new Date(existing.cooldown_until).getTime()) {
      return null; // window expired, still cooling down
    }
    // cooldown lapsed - fall through to open a fresh window
  }

  const expiresAt = new Date(now + randomUrgencyDurationMs()).toISOString();
  const cooldownUntil = new Date(new Date(expiresAt).getTime() + URGENCY_COOLDOWN_MS).toISOString();
  db.prepare(
    `INSERT INTO visitor_offers (visitor_id, discount_id, expires_at, cooldown_until, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(visitor_id, discount_id) DO UPDATE SET
       expires_at = excluded.expires_at, cooldown_until = excluded.cooldown_until, created_at = excluded.created_at`
  ).run(visitorId, discount.id, expiresAt, cooldownUntil, nowIso());

  return { expiresAt };
}

// Single source of truth for "what offer applies right now", shared by GET /api/offer
// and both checkout routes. Urgency takes precedence over standard when both are
// active and applicable to this visitor.
function resolveActiveOffer(visitorId) {
  const urgencyDiscount = getActiveDiscount('urgency');
  if (urgencyDiscount) {
    const window = resolveUrgencyWindow(visitorId, urgencyDiscount);
    if (window) return { type: 'urgency', discount: urgencyDiscount, expiresAt: window.expiresAt };
  }

  const standardDiscount = getActiveDiscount('standard');
  if (standardDiscount) return { type: 'standard', discount: standardDiscount, expiresAt: null };

  return null;
}

// Displayed prices are always whole dollars - $16.33 reads as a bug, not a deal.
// Stripe coupons still apply the exact percent/amount under the hood; this rounding
// only affects what we show on the pricing UI before checkout.
function discountedPricePercent(full, percentOff) {
  return Math.max(1, Math.round(full * (100 - percentOff) / 100));
}

function discountedPriceAmount(full, amountOff) {
  return Math.max(1, Math.round(full - amountOff));
}

function offerPrices(discount, cycle = 'monthly') {
  const prices = {};
  for (const plan of ['pro', 'elite']) {
    if (discount.applies_to === 'both' || discount.applies_to === plan) {
      const full = planPrice(plan, cycle);
      const discounted = discount.value_type === 'amount'
        ? discountedPriceAmount(full, discount.amount_off)
        : discountedPricePercent(full, discount.percent_off);
      prices[plan] = { full, discounted };
    }
  }
  return prices;
}

// "20% off" or "$5 off" ("$5.50 off" when fractional) - the preformatted label the
// landing bar / pricing chips / dashboard buttons show, so no client-side math needed.
function offerText(discount) {
  if (discount.value_type === 'amount') {
    const amount = discount.amount_off;
    const isWhole = Math.abs(amount - Math.round(amount)) < 1e-9;
    return isWhole ? `$${Math.round(amount)} off` : `$${amount.toFixed(2)} off`;
  }
  return `${discount.percent_off}% off`;
}

// Checkout-time enforcement: read the visitor cookie (never create one here - checkout
// isn't the public pricing surface) and resolve the same offer /api/offer would, then
// narrow it to whether it actually covers this plan. Returns the discounts row (or
// null) - stripe.js decides the coupon shape from discount.value_type.
function checkoutDiscountForPlan(req, plan) {
  const visitorId = parseCookies(req.headers.cookie).rp_visitor || null;
  const offer = resolveActiveOffer(visitorId);
  if (!offer) return null;
  if (offer.discount.applies_to !== 'both' && offer.discount.applies_to !== plan) {
    return null;
  }
  return offer.discount;
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

// ---- Public offer API (no device auth - it's for the public website) ----
// Registered before the authed router mount below so it never needs X-Device-Id.

// Live plan prices/quotas for the pricing UI (landing page, dashboard) - lets admin
// price edits show up on the site without a redeploy. cycle=yearly returns yearly prices.
app.get('/api/plans', (req, res) => {
  const cycle = req.query.cycle === 'yearly' ? 'yearly' : 'monthly';
  res.json({
    cycle,
    plans: {
      free: { price: 0, limit: planLimit('free') },
      pro: { price: planPrice('pro', cycle), limit: planLimit('pro') },
      elite: { price: planPrice('elite', cycle), limit: planLimit('elite') }
    }
  });
});

app.get('/api/offer', (req, res) => {
  const visitorId = getOrSetVisitorId(req, res);
  const cycle = req.query.cycle === 'yearly' ? 'yearly' : 'monthly';
  const offer = resolveActiveOffer(visitorId);
  if (!offer) return res.json({ active: false });

  const response = {
    type: offer.type,
    valueType: offer.discount.value_type,
    percentOff: offer.discount.value_type === 'amount' ? null : offer.discount.percent_off,
    amountOff: offer.discount.value_type === 'amount' ? offer.discount.amount_off : null,
    offText: offerText(offer.discount),
    appliesTo: offer.discount.applies_to,
    cycle,
    prices: offerPrices(offer.discount, cycle)
  };
  if (offer.type === 'urgency') response.expiresAt = offer.expiresAt;
  res.json(response);
});

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
  const cycle = req.body?.cycle === 'yearly' ? 'yearly' : 'monthly';

  const successUrl = req.body?.successUrl || `${process.env.PUBLIC_BASE_URL}/billing/success`;
  const cancelUrl = req.body?.cancelUrl || `${process.env.PUBLIC_BASE_URL}/billing/cancel`;
  const discount = checkoutDiscountForPlan(req, plan);

  try {
    const priceId = await resolveCheckoutPriceId(plan, cycle);
    const session = await createCheckoutSession(process.env, user, successUrl, cancelUrl, plan, priceId, discount);
    if (session.couponId && discount) {
      db.prepare('UPDATE discounts SET stripe_coupon_id = ? WHERE id = ?').run(session.couponId, discount.id);
    }
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
  const cycle = req.body?.cycle === 'yearly' ? 'yearly' : 'monthly';
  const successUrl = req.body?.successUrl || `${process.env.PUBLIC_WEB_URL}/dashboard?upgraded=1`;
  const cancelUrl = req.body?.cancelUrl || `${process.env.PUBLIC_WEB_URL}/dashboard`;
  const discount = checkoutDiscountForPlan(req, plan);

  try {
    const priceId = await resolveCheckoutPriceId(plan, cycle);
    const session = await createCheckoutSession(process.env, user, successUrl, cancelUrl, plan, priceId, discount);
    if (session.couponId && discount) {
      db.prepare('UPDATE discounts SET stripe_coupon_id = ? WHERE id = ?').run(session.couponId, discount.id);
    }
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
  console.log(`ResumePilot server listening on http://localhost:${PORT}`);
});
