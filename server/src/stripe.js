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

// Stripe prices are immutable once created (you can't edit an existing price's
// amount), so "changing a plan's price" means minting a new Price on the same
// Product and pointing future checkouts at it. Existing subscribers keep whatever
// price they originally subscribed at - Stripe does this automatically since their
// subscription references the old price id, not the product.
export async function createPlanPrice(env, productId, amountUsd, interval = 'month') {
  if (!env.STRIPE_SECRET_KEY) {
    throw new Error('Billing is not configured yet (missing STRIPE_SECRET_KEY).');
  }
  if (!productId) {
    throw new Error('This plan has no Stripe product to attach a price to.');
  }

  const price = await stripeRequest(env, '/prices', {
    product: productId,
    unit_amount: Math.round(Number(amountUsd) * 100),
    currency: 'usd',
    'recurring[interval]': interval === 'year' ? 'year' : 'month'
  });
  return price.id;
}

// discount, when passed, is the discounts row to apply (see schema.sql). The Stripe
// coupon behind it is created lazily on first use and reused afterward; when this call
// creates a brand-new coupon its id is returned as .couponId so the caller can persist
// it onto discounts.stripe_coupon_id (this module never writes to the DB itself).
// discount.value_type decides the coupon shape: 'percent' -> percent_off, 'amount' ->
// amount_off in cents (currency 'usd'). priceId is the CURRENT Stripe price for this
// plan, resolved by the caller from plan_settings (admin-editable) - not read from env.
export async function createCheckoutSession(env, user, successUrl, cancelUrl, plan, priceId, discount = null) {
  if (!env.STRIPE_SECRET_KEY) {
    throw new Error('Billing is not configured yet (missing STRIPE_SECRET_KEY).');
  }

  const normalizedPlan = plan === 'elite' ? 'elite' : 'pro';
  if (!priceId) {
    throw new Error(`Billing is not configured yet (no Stripe price set for the ${normalizedPlan} plan).`);
  }

  const params = {
    mode: 'subscription',
    'line_items[0][price]': priceId,
    'line_items[0][quantity]': 1,
    // Stripe's own Checkout page collects the payer's email; we only need to carry the
    // device id through so the webhook can mark the right (anonymous) user as pro/elite.
    customer: user?.stripe_customer_id || undefined,
    success_url: successUrl,
    cancel_url: cancelUrl,
    'metadata[device_id]': user.id,
    'metadata[plan]': normalizedPlan,
    'subscription_data[metadata][device_id]': user.id,
    'subscription_data[metadata][plan]': normalizedPlan
  };

  let couponId = null;
  if (discount) {
    couponId = discount.stripe_coupon_id || null;
    if (!couponId) {
      const couponParams = discount.value_type === 'amount'
        ? { amount_off: Math.round(discount.amount_off * 100), currency: 'usd', duration: 'forever', name: discount.name }
        : { percent_off: discount.percent_off, duration: 'forever', name: discount.name };
      const coupon = await stripeRequest(env, '/coupons', couponParams);
      couponId = coupon.id;
    }
    params['discounts[0][coupon]'] = couponId;
  }

  const session = await stripeRequest(env, '/checkout/sessions', params);
  // Only surface couponId when this call minted a brand-new coupon (i.e. the discount
  // row didn't already have one) - that's the signal the caller needs to persist it.
  return { ...session, couponId: discount && !discount.stripe_coupon_id ? couponId : null };
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
