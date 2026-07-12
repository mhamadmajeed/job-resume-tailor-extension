export function uuid() {
  return crypto.randomUUID();
}

export function nowIso() {
  return new Date().toISOString();
}

const DEVICE_ID_PATTERN = /^[a-zA-Z0-9-]{8,64}$/;

// No accounts: the extension generates a random device id once and sends it on every
// request. It identifies a browser install for quota stats and Stripe subscription
// lookups, not a person - there's nothing secret to sign or verify.
export function deviceAuth(req, res, next) {
  const deviceId = String(req.headers['x-device-id'] || '').trim();
  if (!DEVICE_ID_PATTERN.test(deviceId)) {
    return res.status(400).json({ error: 'Missing or invalid X-Device-Id header.' });
  }
  req.deviceId = deviceId;
  next();
}

export function asyncRoute(handler) {
  return (req, res) => {
    Promise.resolve(handler(req, res)).catch((err) => {
      res.status(500).json({ error: err.message || 'Unexpected server error.' });
    });
  };
}
