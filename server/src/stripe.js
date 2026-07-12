const STRIPE_API = 'https://api.stripe.com/v1';

function formEncode(data) {
  return Object.entries(data)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
}

async function stripeRequest(env, path, body) {
  const response = await fetch(`${STRIPE_API}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: formEncode(body)
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error?.message || 'Stripe request failed.');
  }
  return data;
}

export async function createCheckoutSession(env, user, successUrl, cancelUrl) {
  if (!env.STRIPE_SECRET_KEY) {
    throw new Error('Billing is not configured yet (missing STRIPE_SECRET_KEY).');
  }

  return stripeRequest(env, '/checkout/sessions', {
    mode: 'subscription',
    'line_items[0][price]': env.PRO_PRICE_ID,
    'line_items[0][quantity]': 1,
    customer_email: user.stripe_customer_id ? undefined : user.email,
    customer: user.stripe_customer_id || undefined,
    success_url: successUrl,
    cancel_url: cancelUrl,
    'metadata[user_id]': user.id
  });
}

function toBytes(value) {
  return new TextEncoder().encode(value);
}

async function hmacSha256Hex(secret, message) {
  const key = await crypto.subtle.importKey('raw', toBytes(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, toBytes(message));
  return Array.from(new Uint8Array(signature)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function verifyStripeWebhook(payload, signatureHeader, secret) {
  const parts = Object.fromEntries(signatureHeader.split(',').map((part) => part.split('=')));
  const expected = await hmacSha256Hex(secret, `${parts.t}.${payload}`);
  if (expected !== parts.v1) throw new Error('Invalid Stripe webhook signature.');
  return JSON.parse(payload);
}
