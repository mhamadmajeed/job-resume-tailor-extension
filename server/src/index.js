import { uuid, nowIso, json, html, error, signToken, requireAuth } from './util.js';
import { emailFormPage, linkSentPage, confirmedPage, errorPage } from './pages.js';
import { sendMagicLinkEmail } from './email.js';
import { tailorResume, reviseResume } from './gemini.js';
import { createCheckoutSession, verifyStripeWebhook } from './stripe.js';

const SESSION_TTL_SECONDS = 15 * 60;
const AUTH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const PRO_PERIOD_DAYS = 30;

function corsPreflight() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
    }
  });
}

async function getOrCreateUser(env, email) {
  const existing = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  if (existing) return existing;

  const user = {
    id: uuid(),
    email,
    plan: 'free',
    generations_used: 0,
    period_start: nowIso(),
    created_at: nowIso()
  };
  await env.DB.prepare(
    'INSERT INTO users (id, email, plan, generations_used, period_start, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(user.id, user.email, user.plan, user.generations_used, user.period_start, user.created_at).run();
  return user;
}

function planLimit(env, plan) {
  return plan === 'pro' ? Number(env.PRO_GENERATION_LIMIT || 100) : Number(env.FREE_GENERATION_LIMIT || 5);
}

async function refreshQuotaPeriod(env, user) {
  if (user.plan !== 'pro') return user;
  const periodStart = new Date(user.period_start);
  const daysElapsed = (Date.now() - periodStart.getTime()) / (1000 * 60 * 60 * 24);
  if (daysElapsed < PRO_PERIOD_DAYS) return user;

  const period_start = nowIso();
  await env.DB.prepare('UPDATE users SET generations_used = 0, period_start = ? WHERE id = ?')
    .bind(period_start, user.id).run();
  return { ...user, generations_used: 0, period_start };
}

function userSummary(env, user) {
  const limit = planLimit(env, user.plan);
  return {
    email: user.email,
    plan: user.plan,
    generationsUsed: user.generations_used,
    limit,
    remaining: Math.max(0, limit - user.generations_used)
  };
}

async function handleAuthStart(env) {
  const sessionId = uuid();
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();
  await env.DB.prepare(
    'INSERT INTO login_sessions (session_id, status, created_at, expires_at) VALUES (?, ?, ?, ?)'
  ).bind(sessionId, 'pending', createdAt, expiresAt).run();

  return json({ sessionId, verifyUrl: `${env.PUBLIC_BASE_URL}/auth/verify-page?session=${sessionId}` });
}

async function handleVerifyPage(env, url) {
  const sessionId = url.searchParams.get('session');
  const session = await env.DB.prepare('SELECT * FROM login_sessions WHERE session_id = ?').bind(sessionId).first();
  if (!session) return html(errorPage('This sign-in link is invalid or has expired.'), { status: 404 });
  return html(emailFormPage(sessionId));
}

async function handleSendLink(env, request) {
  const form = await request.formData();
  const sessionId = String(form.get('sessionId') || '');
  const email = String(form.get('email') || '').trim().toLowerCase();

  const session = await env.DB.prepare('SELECT * FROM login_sessions WHERE session_id = ?').bind(sessionId).first();
  if (!session) return html(errorPage('This sign-in link is invalid or has expired.'), { status: 404 });
  if (!email || !email.includes('@')) return html(emailFormPage(sessionId, 'Enter a valid email address.'));

  const magicToken = uuid();
  await env.DB.prepare('UPDATE login_sessions SET email = ?, magic_token = ? WHERE session_id = ?')
    .bind(email, magicToken, sessionId).run();

  const confirmUrl = `${env.PUBLIC_BASE_URL}/auth/confirm?token=${magicToken}`;
  const result = await sendMagicLinkEmail(env, email, confirmUrl);
  return html(linkSentPage(result.sent ? null : confirmUrl));
}

async function handleConfirm(env, url) {
  const token = url.searchParams.get('token');
  const session = await env.DB.prepare('SELECT * FROM login_sessions WHERE magic_token = ?').bind(token).first();
  if (!session) return html(errorPage('This sign-in link is invalid or has already been used.'), { status: 404 });
  if (new Date(session.expires_at).getTime() < Date.now()) {
    return html(errorPage('This sign-in link has expired. Go back to the extension and try again.'), { status: 410 });
  }

  const user = await getOrCreateUser(env, session.email);
  const bearerToken = await signToken({ uid: user.id, email: user.email }, env.AUTH_SECRET, AUTH_TOKEN_TTL_SECONDS);

  await env.DB.prepare('UPDATE login_sessions SET status = ?, bearer_token = ? WHERE session_id = ?')
    .bind('verified', bearerToken, session.session_id).run();

  return html(confirmedPage());
}

async function handlePoll(env, url) {
  const sessionId = url.searchParams.get('sessionId');
  const session = await env.DB.prepare('SELECT * FROM login_sessions WHERE session_id = ?').bind(sessionId).first();
  if (!session) return error(404, 'Unknown session.');
  if (session.status !== 'verified') return json({ status: session.status });

  const user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(session.email).first();
  return json({ status: 'verified', token: session.bearer_token, user: userSummary(env, user) });
}

async function handleMe(env, auth) {
  const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(auth.uid).first();
  if (!user) return error(404, 'User not found.');
  return json(userSummary(env, user));
}

async function handleSaveResume(env, auth, request) {
  const body = await request.json();
  const text = String(body.resumeText || '').trim();
  const filename = String(body.filename || 'resume').slice(0, 200);
  if (!text) return error(400, 'resumeText is required.');

  await env.DB.prepare(
    `INSERT INTO resumes (user_id, filename, resume_text, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET filename = excluded.filename, resume_text = excluded.resume_text, updated_at = excluded.updated_at`
  ).bind(auth.uid, filename, text, nowIso()).run();

  return json({ ok: true });
}

async function handleGenerate(env, auth, request) {
  let user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(auth.uid).first();
  if (!user) return error(404, 'User not found.');
  user = await refreshQuotaPeriod(env, user);

  const limit = planLimit(env, user.plan);
  if (user.generations_used >= limit) {
    return error(402, user.plan === 'pro'
      ? 'You have used all generations for this billing period.'
      : 'Free plan limit reached (5 generations). Upgrade for 100 generations a month.');
  }

  const resumeRow = await env.DB.prepare('SELECT * FROM resumes WHERE user_id = ?').bind(auth.uid).first();
  if (!resumeRow) return error(400, 'Upload a resume first.');

  const body = await request.json();
  const job = { title: body.jobTitle || '', url: body.jobUrl || '', text: body.jobText || '' };
  if (!job.text.trim()) return error(400, 'jobText is required.');

  const result = await tailorResume(resumeRow.resume_text, job, env.GEMINI_API_KEY);

  const generationId = uuid();
  const timestamp = nowIso();
  await env.DB.prepare(
    'INSERT INTO generations (id, user_id, job_title, job_url, current_text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(generationId, auth.uid, job.title, job.url, result.text, timestamp, timestamp).run();

  await env.DB.prepare('UPDATE users SET generations_used = generations_used + 1 WHERE id = ?').bind(auth.uid).run();
  const updatedUser = { ...user, generations_used: user.generations_used + 1 };

  return json({
    generationId,
    text: result.text,
    summary: result.summary,
    quota: userSummary(env, updatedUser)
  });
}

async function handleRevise(env, auth, request) {
  const body = await request.json();
  const generationId = String(body.generationId || '');
  const instruction = String(body.instruction || '').trim();
  if (!instruction) return error(400, 'instruction is required.');

  const generation = await env.DB.prepare('SELECT * FROM generations WHERE id = ? AND user_id = ?')
    .bind(generationId, auth.uid).first();
  if (!generation) return error(404, 'Generation not found.');

  const result = await reviseResume(generation.current_text, instruction, env.GEMINI_API_KEY);
  const timestamp = nowIso();

  await env.DB.prepare('UPDATE generations SET current_text = ?, updated_at = ? WHERE id = ?')
    .bind(result.text, timestamp, generationId).run();

  await env.DB.batch([
    env.DB.prepare('INSERT INTO revisions (id, generation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(uuid(), generationId, 'user', instruction, timestamp),
    env.DB.prepare('INSERT INTO revisions (id, generation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(uuid(), generationId, 'assistant', result.summary, timestamp)
  ]);

  return json({ text: result.text, summary: result.summary });
}

async function handleCheckout(env, auth, request) {
  const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(auth.uid).first();
  if (!user) return error(404, 'User not found.');

  const body = await request.json().catch(() => ({}));
  const successUrl = body.successUrl || `${env.PUBLIC_BASE_URL}/billing/success`;
  const cancelUrl = body.cancelUrl || `${env.PUBLIC_BASE_URL}/billing/cancel`;

  try {
    const session = await createCheckoutSession(env, user, successUrl, cancelUrl);
    return json({ url: session.url });
  } catch (checkoutError) {
    return error(500, checkoutError.message);
  }
}

async function handleStripeWebhook(env, request) {
  const signature = request.headers.get('Stripe-Signature');
  const payload = await request.text();

  let event;
  try {
    event = await verifyStripeWebhook(payload, signature, env.STRIPE_WEBHOOK_SECRET);
  } catch (verifyError) {
    return error(400, verifyError.message);
  }

  const object = event.data?.object;

  if (event.type === 'checkout.session.completed') {
    const userId = object.metadata?.user_id;
    if (userId) {
      await env.DB.prepare(
        'UPDATE users SET plan = ?, stripe_customer_id = ?, stripe_subscription_id = ?, generations_used = 0, period_start = ? WHERE id = ?'
      ).bind('pro', object.customer, object.subscription, nowIso(), userId).run();
    }
  }

  if (event.type === 'customer.subscription.deleted') {
    await env.DB.prepare('UPDATE users SET plan = ? WHERE stripe_subscription_id = ?')
      .bind('free', object.id).run();
  }

  return json({ received: true });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') return corsPreflight();

    try {
      if (path === '/auth/start' && request.method === 'POST') return handleAuthStart(env);
      if (path === '/auth/verify-page' && request.method === 'GET') return handleVerifyPage(env, url);
      if (path === '/auth/send-link' && request.method === 'POST') return handleSendLink(env, request);
      if (path === '/auth/confirm' && request.method === 'GET') return handleConfirm(env, url);
      if (path === '/auth/poll' && request.method === 'GET') return handlePoll(env, url);
      if (path === '/webhook/stripe' && request.method === 'POST') return handleStripeWebhook(env, request);

      // Everything below requires a bearer token.
      const auth = await requireAuth(request, env);
      if (!auth) return error(401, 'Sign in required.');

      if (path === '/api/me' && request.method === 'GET') return handleMe(env, auth);
      if (path === '/api/resume' && request.method === 'POST') return handleSaveResume(env, auth, request);
      if (path === '/api/generate' && request.method === 'POST') return handleGenerate(env, auth, request);
      if (path === '/api/revise' && request.method === 'POST') return handleRevise(env, auth, request);
      if (path === '/api/checkout' && request.method === 'POST') return handleCheckout(env, auth, request);

      return error(404, 'Not found.');
    } catch (err) {
      return error(500, err.message || 'Unexpected server error.');
    }
  }
};
