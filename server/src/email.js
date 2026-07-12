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
      from: env.EMAIL_FROM || 'Job Resume Tailor <onboarding@resend.dev>',
      to: [email],
      subject: 'Your sign-in link',
      html: `<p>Click to sign in to Job Resume Tailor:</p><p><a href="${link}">${link}</a></p><p>This link expires in 15 minutes.</p>`
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Email send failed: ${text.slice(0, 180)}`);
  }

  return { sent: true };
}
