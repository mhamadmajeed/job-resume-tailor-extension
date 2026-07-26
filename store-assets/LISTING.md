# ResumePilot - Chrome Web Store Listing Package

Everything below is copy-paste ready for the Chrome Web Store Developer Dashboard
(https://chrome.google.com/webstore/devconsole). Files referenced are in this folder.

---

## Store name (max 45 characters)

ResumePilot: AI Resume Tailor

## Short description (max 132 characters)

Tailor your resume to any job in one click. AI rewrite, match score, ATS keywords, and a polished PDF - right on the job page.

## Category

Productivity

## Language

English

---

## Detailed description

Stop sending the same resume to every job. ResumePilot reads the job posting you
are viewing and rewrites your resume to match it - in seconds, as a polished PDF.

HOW IT WORKS
1. Upload your resume once. It is saved to your account and synced to any device
   you sign in on.
2. Open a job posting (LinkedIn and most job sites supported).
3. Pick how deep the rewrite should go - Light, Medium, Max, or Ultra.
4. Click Generate and download a tailored PDF or DOCX.

SEE YOUR MATCH SCORE
Before you apply, run a free match check. ResumePilot shows a percentage score,
the keywords your resume already covers, and the ones the job wants but your
resume is missing.

MAKE IT EVEN STRONGER
- Boost: one click pushes your match score higher.
- Refine with AI: chat with the AI to adjust anything - "make the summary
  shorter", "highlight my leadership experience" - and download again.
- ATS Match: rewrites with the exact keywords and clean formatting that
  applicant tracking systems look for.
- Human recruiter match: optimizes for the 7-second human skim - sharp summary,
  achievement-first bullets, numbers up front.

FREE TO START
- 5 tailored resumes per month, free - every intensity included.
- 5 free match checks per month.
- No credit card needed. Sign in with Google and go.

PLANS
Paid plans add a monthly credit pool, AI refine chat, Boost, the resume text
editor, and (on Elite) ATS + human recruiter targeting. See current pricing at
https://resumepilot.co - your plan works on every device you sign in on.

YOUR DATA
Your resume is stored securely so you never upload it twice, and you can delete
it anytime with one click. We never sell your data. Full policy:
https://resumepilot.co/privacy

---

## Graphic assets (files in this folder)

| Asset | File | Requirement |
|---|---|---|
| Store icon | store-icon-128.png | 128x128 PNG |
| Screenshot 1 | screenshot-a-1280x800.png | 1280x800 |
| Screenshot 2 | screenshot-b-1280x800.png | 1280x800 |
| Screenshot 3 | screenshot-c-1280x800.png | 1280x800 |
| Small promo tile | promo-small-440x280.png | 440x280 |
| Marquee promo tile | promo-marquee-1400x560.png | 1400x560 |
| Promo video | promo-video-1280x720.mp4 (upload to YouTube, paste the link) | YouTube URL |

Upload screenshots in the order a, b, c - the first one is what most people see.

---

## Privacy practices tab

**Single purpose description:**
ResumePilot tailors the user's resume to the job posting they are viewing, using
AI, and produces a downloadable PDF with a job-match score.

**Permission justifications:**

- activeTab: Read the text of the job posting on the page the user is viewing,
  only when the user clicks Generate or Check match.
- scripting: Inject the reader that extracts the job posting text from the
  current tab when the user requests a generation.
- storage: Store the user's device identifier and preferences locally.
- unlimitedStorage: Cache the user's uploaded resume file locally so it does
  not need to be re-uploaded.
- downloads: Save the generated resume PDF/DOCX to the user's computer when
  they click Download.
- Host permission (https://resumepilot.co/*): Communicate with the ResumePilot
  backend to generate tailored resumes, sync the user's resume across devices,
  and manage their subscription.

**Remote code:** No. All code is packaged with the extension; the backend only
returns data (JSON).

**Data usage disclosures (check these boxes):**
- Personally identifiable information: YES (name, email via Google sign-in;
  resume contents)
- Authentication information: NO (Google OAuth happens on our website;
  the extension never sees passwords)
- Website content: YES (text of the job posting the user is viewing, sent only
  on user action)
- Web history / location / financial info / health info / personal
  communications / user activity such as clicks or keystroke logging: NO

Certify: data is NOT sold, is NOT used for unrelated purposes, and is NOT used
for creditworthiness.

**Privacy policy URL:** https://resumepilot.co/privacy

---

## Review notes (paste into the "Notes for reviewer" box)

Sign-in with Google is required to use the extension (this keeps free-plan
limits tied to an account, not a device). After installing: click the extension
icon, click "Sign in with Google", complete sign-in in the opened tab, then
return to the popup. Upload any resume (PDF/DOCX/TXT), open any LinkedIn job
posting, and click "Generate tailored PDF". The free plan includes 5
generations and 5 match checks per month; no payment is needed to review all
free functionality.

---

## Upload package

File: resumepilot-extension-v2.0.0.zip (repo root). Contains manifest.json,
popup.html/js/css, content.js, config.js, icons/, vendor/. No server code.

---

## BEFORE YOU SUBMIT - two blockers

1. **Publish the Google OAuth consent screen** (Google Cloud Console -> APIs &
   Services -> OAuth consent screen -> Publish app). Sign-in is mandatory in the
   extension, and the consent screen is still in Testing mode - the Chrome Web
   Store reviewer will NOT be able to sign in and will reject the extension.
   Publish it first.
2. **Developer account:** register at
   https://chrome.google.com/webstore/devconsole with a one-time $5 fee (you
   must do this yourself - it involves a payment).

Then: Developer Dashboard -> New item -> upload the zip -> paste the texts
above -> upload the images -> add the YouTube video link -> fill the privacy
tab -> submit for review. First review typically takes 1-3 business days.
