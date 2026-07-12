export function uuid() {
  return crypto.randomUUID();
}

export function nowIso() {
  return new Date().toISOString();
}

export function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      ...(init.headers || {})
    }
  });
}

export function html(markup, init = {}) {
  return new Response(markup, {
    ...init,
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...(init.headers || {}) }
  });
}

export function error(status, message) {
  return json({ error: message }, { status });
}

function base64urlEncode(bytes) {
  let binary = '';
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(value.length + (4 - (value.length % 4)) % 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
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

export async function requireAuth(request, env) {
  const header = request.headers.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const payload = await verifyToken(token, env.AUTH_SECRET);
  if (!payload?.uid) return null;
  return payload;
}
