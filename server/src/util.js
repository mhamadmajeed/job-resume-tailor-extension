import { db } from './db.js';

export function uuid() {
  return crypto.randomUUID();
}

export function nowIso() {
  return new Date().toISOString();
}

const DEVICE_ID_PATTERN = /^[a-zA-Z0-9-]{8,64}$/;

// The extension generates a random device id once and sends it on every request. It
// identifies a browser install, not a person - there's nothing secret to sign or
// verify. Sign-in is enforced separately: work routes require the device to be
// linked to a Google account (see requireAccount in index.js).
export function deviceAuth(req, res, next) {
  const deviceId = String(req.headers['x-device-id'] || '').trim();
  if (!DEVICE_ID_PATTERN.test(deviceId)) {
    return res.status(400).json({ error: 'Missing or invalid X-Device-Id header.' });
  }
  req.deviceId = deviceId;
  next();
}

// Signed session tokens for real accounts (Google Sign-In). Separate from deviceAuth
// above: a device id identifies an anonymous browser install, an account session
// identifies a person and is what the website's dashboard authenticates with.
function base64urlEncode(bytes) {
  let binary = '';
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return Buffer.from(binary, 'binary').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(value.length + (4 - (value.length % 4)) % 4, '=');
  return new Uint8Array(Buffer.from(padded, 'base64'));
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

export async function signToken(payload, secret, expiresInSeconds) {
  const body = { ...payload, exp: Math.floor(Date.now() / 1000) + expiresInSeconds };
  const bodyBytes = new TextEncoder().encode(JSON.stringify(body));
  const bodyEncoded = base64urlEncode(bodyBytes);
  const key = await hmacKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(bodyEncoded));
  const signatureEncoded = base64urlEncode(new Uint8Array(signature));
  return `${bodyEncoded}.${signatureEncoded}`;
}

export async function verifyToken(token, secret) {
  if (!token || !token.includes('.')) return null;
  const [bodyEncoded, signatureEncoded] = token.split('.');
  const key = await hmacKey(secret);
  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    base64urlDecode(signatureEncoded),
    new TextEncoder().encode(bodyEncoded)
  );
  if (!valid) return null;

  const payload = JSON.parse(new TextDecoder().decode(base64urlDecode(bodyEncoded)));
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

export async function accountAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const payload = await verifyToken(token, process.env.AUTH_SECRET);
  if (!payload?.aid) return res.status(401).json({ error: 'Sign in required.' });
  // A valid token can outlive its account (deleted account, restored DB).
  const account = db.prepare('SELECT id FROM accounts WHERE id = ?').get(payload.aid);
  if (!account) return res.status(401).json({ error: 'Sign in required.' });
  req.accountId = payload.aid;
  next();
}

// Fixed-window in-memory rate limiting for the routes that spend Anthropic tokens.
// Counts reset each window; the map is pruned of expired entries once it grows large.
const RATE_WINDOW_MS = 60 * 60 * 1000;
const rateHits = new Map();

function bump(key, max, now) {
  const entry = rateHits.get(key);
  if (!entry || now >= entry.resetAt) {
    rateHits.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  entry.count += 1;
  return entry.count <= max;
}

export function rateLimit(prefix, perDevice, perIp) {
  return (req, res, next) => {
    const now = Date.now();
    if (rateHits.size > 50000) {
      for (const [key, entry] of rateHits) {
        if (now >= entry.resetAt) rateHits.delete(key);
      }
    }
    const deviceOk = bump(`${prefix}:d:${req.deviceId}`, perDevice, now);
    const ipOk = bump(`${prefix}:i:${req.ip}`, perIp, now);
    if (!deviceOk || !ipOk) {
      return res.status(429).json({ error: 'Too many requests. Try again in a little while.' });
    }
    next();
  };
}

export function asyncRoute(handler) {
  return (req, res) => {
    Promise.resolve(handler(req, res)).catch((err) => {
      res.status(500).json({ error: err.message || 'Unexpected server error.' });
    });
  };
}
