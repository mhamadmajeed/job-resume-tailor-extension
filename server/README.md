# Job Resume Tailor — Backend

Plain Node.js + Express backend for the extension. Holds the Claude API key server-side, stores
each user's resume and generation history, enforces free/pro quotas, and handles Stripe billing.
Uses Node's built-in `node:sqlite` for storage — no native modules, no platform-specific binaries,
runs the same everywhere (this is why it replaced an earlier Cloudflare Workers version: Cloudflare's
local runtime doesn't support Windows on ARM64, and this doesn't have that problem).

## Local setup

```
cd server
npm install
cp .env.example .env
```

Edit `.env`:
- `AUTH_SECRET`: any long random string (signs session tokens).
- `ANTHROPIC_API_KEY`: your Claude API key.
- Leave `RESEND_API_KEY` and `STRIPE_SECRET_KEY` empty for local testing — see "Dev mode" below.

```
npm run dev
```

The server runs at `http://localhost:8787` and creates `data/app.db` automatically on first run.

## Dev mode (no email/billing setup required)

- **Sign-in**: with `RESEND_API_KEY` unset, the sign-in page shows the magic link directly on-screen instead of emailing it — click it to sign in.
- **Billing**: with `STRIPE_SECRET_KEY` unset, `/api/checkout` returns a clear error instead of crashing. To test the "pro" experience locally without Stripe, edit the database directly:
  ```
  node -e "import('./src/db.js').then(({db}) => db.prepare(\"UPDATE users SET plan='pro' WHERE email=?\").run('you@example.com'))"
  ```

## Deploying to Railway

1. Push this repo to GitHub (already done if you're reading this from the pushed repo).
2. In Railway: **New Project → Deploy from GitHub repo**, pick this repo, set the root directory to `server`.
3. Railway auto-detects the Node app from `package.json` and runs `npm install && npm start`.
4. In the service's **Variables** tab, add everything from `.env.example`: `AUTH_SECRET`, `ANTHROPIC_API_KEY`, and once ready `RESEND_API_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `PRO_PRICE_ID`. Set `PUBLIC_BASE_URL` to the `*.up.railway.app` domain Railway assigns (Settings → Networking → Generate Domain).
5. Add a **volume** mounted at `/app/data` so `data/app.db` persists across deploys (Railway → your service → Settings → Volumes). Without this, the database resets on every redeploy.
6. Redeploy. Your API is live at the Railway domain.
7. Update `config.js` in the extension root with that domain, and confirm it matches the `https://*.up.railway.app/*` entry in `manifest.json`'s `host_permissions` (already set up for any Railway domain).

## Going live with real billing

1. Create a Stripe Product + recurring $29/month Price, put its ID in `PRO_PRICE_ID`.
2. Add a Stripe webhook endpoint pointing at `<your-railway-url>/webhook/stripe` for `checkout.session.completed` and `customer.subscription.deleted`, and set `STRIPE_WEBHOOK_SECRET` to its signing secret.
3. Sign up for Resend (or similar), set `RESEND_API_KEY` and `EMAIL_FROM` so magic links actually get emailed instead of shown on-page.

## Endpoints

- `POST /auth/start` → `{ sessionId, verifyUrl }`
- `GET /auth/verify-page?session=` → HTML email-entry form
- `POST /auth/send-link` → sends/shows magic link
- `GET /auth/confirm?token=` → completes sign-in, session becomes pollable
- `GET /auth/poll?sessionId=` → `{ status }` or `{ status: 'verified', token, user }`
- `GET /api/me` → plan + quota
- `POST /api/resume` → `{ filename, resumeText }` stores the extracted resume text
- `POST /api/generate` → `{ jobTitle, jobUrl, jobText }` → tailored resume, consumes one generation
- `POST /api/revise` → `{ generationId, instruction }` → applies a follow-up edit, free (doesn't consume quota)
- `POST /api/checkout` → Stripe Checkout session URL
- `POST /webhook/stripe` → Stripe webhook receiver
