export async function sendMagicLinkEmail(env, email, link) {
  if (!env.RESEND_API_KEY) {
    // Dev mode: no email service configured, caller falls back to showing the link on-page.
    return { sent: false };
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM || 'ResumePilot <onboarding@resend.dev>',
      to: [email],
      subject: 'Your sign-in link',
      html: `<p>Click to sign in to ResumePilot:</p><p><a href="${link}">${link}</a></p><p>This link expires in 15 minutes.</p>`
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Email send failed: ${text.slice(0, 180)}`);
  }

  return { sent: true };
}

// Generic transactional email used by the admin panel (per-member notices, etc).
// Never throws - callers always get a clear {sent, reason?} result, even when the
// email service is not configured or the request to it fails.
export async function sendEmail(env, { to, subject, text }) {
  if (!env.RESEND_API_KEY) {
    return { sent: false, reason: 'Email service is not configured (missing RESEND_API_KEY).' };
  }
  if (!to) {
    return { sent: false, reason: 'Recipient has no email address on file.' };
  }

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: env.EMAIL_FROM || 'ResumePilot <onboarding@resend.dev>',
        to: [to],
        subject,
        text: text || ''
      })
    });

    if (!response.ok) {
      const body = await response.text();
      return { sent: false, reason: `Email send failed: ${body.slice(0, 180)}` };
    }

    return { sent: true };
  } catch (networkError) {
    return { sent: false, reason: networkError.message || 'Could not reach the email service.' };
  }
}
