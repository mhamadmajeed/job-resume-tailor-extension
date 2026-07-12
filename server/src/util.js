export function uuid() {
  return crypto.randomUUID();
}

export function nowIso() {
  return new Date().toISOString();
}

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

export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const payload = await verifyToken(token, process.env.AUTH_SECRET);
  if (!payload?.uid) return res.status(401).json({ error: 'Sign in required.' });
  req.auth = payload;
  next();
}

export function asyncRoute(handler) {
  return (req, res) => {
    Promise.resolve(handler(req, res)).catch((err) => {
      res.status(500).json({ error: err.message || 'Unexpected server error.' });
    });
  };
}
