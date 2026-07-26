export async function exchangeCodeForTokens({ code, clientId, clientSecret, redirectUri }) {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code'
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Google sign-in failed (${response.status}): ${text.slice(0, 200)}`);
  }
  return response.json(); // { access_token, id_token, expires_in, ... }
}

// Google's tokeninfo endpoint verifies the id_token's signature and expiry for us -
// avoids needing a JWKS/crypto library on our end for what is a low-volume server-side call.
export async function verifyGoogleIdToken(idToken, clientId) {
  const response = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
  if (!response.ok) throw new Error('Could not verify your Google identity. Please try again.');

  const payload = await response.json();
  if (payload.aud !== clientId) throw new Error('Google token audience mismatch.');
  if (payload.email_verified !== 'true' && payload.email_verified !== true) {
    throw new Error('Your Google email is not verified.');
  }
  return payload; // sub, email, name, picture, ...
}
