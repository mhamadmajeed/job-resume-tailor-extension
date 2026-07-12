# Job Resume Tailor

A Chrome extension + Cloudflare Worker backend. Upload a resume once, generate a version tailored to
the job listing you're viewing, refine it with a chat prompt, and download it as PDF or DOCX.

The AI key lives on the backend only — the extension never holds an API key. Sign-in is by email
magic link. Free accounts get 5 generations; Pro ($29/mo) gets 100 generations a month. Follow-up
chat revisions to an existing generation don't count against the quota.

## Project layout

- `/` — the extension (popup UI, job-listing scraper, local PDF/DOCX rendering)
- `/server` — the Cloudflare Worker backend (auth, resume storage, Gemini calls, Stripe billing)

See [server/README.md](server/README.md) for backend setup and deployment.

## Run the backend

```
cd server
npm install
cp .dev.vars.example .dev.vars   # fill in AUTH_SECRET and GEMINI_API_KEY
npm run db:init
npm run dev
```

This starts the API at `http://localhost:8787`, which matches the default in [config.js](config.js).

> If `wrangler` can't run on your machine (e.g. Windows on ARM64 — Cloudflare doesn't ship a
> `workerd` build for that platform), skip local dev and deploy straight to Cloudflare instead; see
> server/README.md for the dashboard-only (no CLI) path.

## Load the extension in Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select this folder.
4. Click the extension icon (via the puzzle-piece menu) and sign in with your email.

## Use

1. Sign in (magic link opens in a new tab; return to the popup once confirmed).
2. Upload a resume file once — it's extracted locally and the text is sent to your account on the backend.
3. Open a job listing (LinkedIn, Indeed, Greenhouse, Lever, Workable, Ashby, Glassdoor, or most other job pages).
4. Click **Generate resume**.
5. Use the chat box to ask for follow-up changes ("make the summary shorter", "emphasize the Python experience").
6. Download the result as PDF or DOCX.

## Privacy

- The extension only reads the active page when you click **Generate resume** (`activeTab`), never in the background.
- The original uploaded file stays in the browser's IndexedDB; only its extracted text is sent to your account on the backend.
- The Gemini API key is stored server-side only.

## Notes

- PDF downloads support Latin-based characters. For resumes with non-Latin scripts (Arabic, Kurdish, etc.), use the DOCX download, which keeps full Unicode.
- Supported upload formats: PDF, DOCX, TXT, Markdown, CSV, JSON, basic RTF.
- AI tailoring keeps the original resume's structure and is instructed not to invent employers, dates, credentials, metrics, or skills. Chat revisions follow the same rule.
