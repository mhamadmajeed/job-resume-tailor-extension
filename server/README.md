# Job Resume Tailor — Backend

Cloudflare Worker + D1 backend for the extension. Holds the Gemini API key server-side, stores each
user's resume and generation history, enforces free/pro quotas, and handles Stripe billing.

## Local setup

```
cd server
npm install
cp .dev.vars.example .dev.vars
```

Edit `.dev.vars`:
- `AUTH_SECRET`: any long random string (used to sign session tokens).
- `GEMINI_API_KEY`: your Gemini API key.
- Leave `RESEND_API_KEY` and `STRIPE_SECRET_KEY` empty for local testing — see "Dev mode" below.

Create the local D1 database and load the schema:

```
npx wrangler d1 create resume-tailor-db
```

Copy the `database_id` it prints into `wrangler.toml`, then:

```
npm run db:init
npm run dev
```

The worker runs at `http://localhost:8787`.

## Dev mode (no email/billing setup required)

- **Sign-in**: with `RESEND_API_KEY` unset, the sign-in page shows the magic link directly on-screen instead of emailing it — click it to sign in.
- **Billing**: with `STRIPE_SECRET_KEY` unset, `/api/checkout` returns a clear error instead of crashing. To test the "pro" experience locally without Stripe, update a row directly:
  ```
  npx wrangler d1 execute resume-tailor-db --local --command "UPDATE users SET plan='pro' WHERE email='you@example.com'"
  ```

## Deploying without a local wrangler CLI (e.g. Windows on ARM64)

Cloudflare's local runtime (`workerd`) only ships for Windows x64, Linux x64/ARM64, and macOS
x64/ARM64 — it does not run on Windows ARM64, so `wrangler dev`/`deploy` will fail there with
"Unsupported platform". If that's your machine, deploy entirely from the Cloudflare dashboard
instead (their build servers run the CLI for you):

1. Push this repo to GitHub (already done if you're reading this from the pushed repo).
2. In the Cloudflare dashboard: **Workers & Pages → Create → Import a Git repository**, pick this repo, and set the root directory to `server`.
3. Cloudflare auto-detects `wrangler.toml` and runs the build/deploy on its own infrastructure — no local CLI needed.
4. **Workers & Pages → D1 → Create database** named `resume-tailor-db`, then copy its ID into `wrangler.toml`'s `database_id` (commit and push — this redeploys automatically).
5. Open the D1 database's **Console** tab in the dashboard and paste the contents of `schema.sql` to run it (this replaces `wrangler d1 execute`).
6. In the Worker's **Settings → Variables and Secrets**, add `AUTH_SECRET`, `GEMINI_API_KEY`, and once ready `RESEND_API_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` as encrypted secrets, and set `PUBLIC_BASE_URL` to the `*.workers.dev` URL Cloudflare assigns you.
7. Update `config.js` in the extension root with that same URL, and add it to `manifest.json`'s `host_permissions`.

## Going live

1. `npm run db:init:remote` to apply the schema to your real D1 database.
2. Set real secrets: `npx wrangler secret put AUTH_SECRET`, `GEMINI_API_KEY`, `RESEND_API_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`.
3. Set `PUBLIC_BASE_URL` in `wrangler.toml` to your deployed Worker URL (or custom domain).
4. Create a Stripe Product + recurring $29/month Price, put its ID in `PRO_PRICE_ID` (wrangler.toml `[vars]` or as a secret).
5. Add a Stripe webhook endpoint pointing at `<your-worker-url>/webhook/stripe` for `checkout.session.completed` and `customer.subscription.deleted`, and set `STRIPE_WEBHOOK_SECRET` to its signing secret.
6. `npm run deploy`.

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
