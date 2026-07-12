const SHELL_STYLE = `
  body { font-family: system-ui, sans-serif; background: #0f1720; color: #e8edf1; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
  .card { background: #17222c; padding: 32px; border-radius: 12px; width: 360px; box-shadow: 0 12px 30px rgba(0,0,0,0.35); }
  h1 { font-size: 18px; margin: 0 0 16px; }
  p { font-size: 13px; color: #9fb0bd; line-height: 1.5; }
  input { width: 100%; box-sizing: border-box; padding: 10px 12px; border-radius: 8px; border: 1px solid #2b3948; background: #0f1720; color: #e8edf1; font-size: 14px; margin-bottom: 12px; }
  button { width: 100%; padding: 10px 12px; border-radius: 8px; border: none; background: #2f7d6b; color: white; font-size: 14px; cursor: pointer; }
  button:hover { background: #37937e; }
  a.dev-link { display: block; margin-top: 14px; color: #6fb7ff; word-break: break-all; }
`;

export function emailFormPage(sessionId, error) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Sign in - Job Resume Tailor</title><style>${SHELL_STYLE}</style></head>
<body>
  <div class="card">
    <h1>Sign in to Job Resume Tailor</h1>
    <p>Enter your email and we'll send a sign-in link.</p>
    ${error ? `<p style="color:#ff8080">${error}</p>` : ''}
    <form method="POST" action="/auth/send-link">
      <input type="hidden" name="sessionId" value="${sessionId}">
      <input type="email" name="email" placeholder="you@example.com" required autofocus>
      <button type="submit">Send sign-in link</button>
    </form>
  </div>
</body></html>`;
}

export function linkSentPage(devMagicLink) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Check your email</title><style>${SHELL_STYLE}</style></head>
<body>
  <div class="card">
    <h1>Check your email</h1>
    <p>We sent a sign-in link. Click it to finish signing in, then return to the extension.</p>
    ${devMagicLink ? `<p>Dev mode (no email service configured):</p><a class="dev-link" href="${devMagicLink}">${devMagicLink}</a>` : ''}
  </div>
</body></html>`;
}

export function confirmedPage() {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Signed in</title><style>${SHELL_STYLE}</style></head>
<body>
  <div class="card">
    <h1>You're signed in</h1>
    <p>Return to the Job Resume Tailor extension popup — it will pick this up automatically.</p>
  </div>
</body></html>`;
}

export function errorPage(message) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Error</title><style>${SHELL_STYLE}</style></head>
<body>
  <div class="card">
    <h1>Something went wrong</h1>
    <p>${message}</p>
  </div>
</body></html>`;
}
