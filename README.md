# Job Resume Tailor Extension

A Manifest V3 Chrome extension that stores a resume locally, reads the active job listing page, uses AI to understand the role, and generates a downloadable tailored resume.

## Load in Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder: `job-resume-tailor-extension`.

## Use

1. Click the extension icon.
2. Upload a resume file once.
3. Paste a Google Gemini API key and click **Save Gemini key**.
4. Open a job listing page, such as LinkedIn, Indeed, Greenhouse, Lever, or a company careers page.
5. Click **Generate resume**.
6. Review and edit the generated resume text in the popup.
7. Download the edited resume as PDF or DOCX.

The extension requires a Google Gemini API key for generation. It sends the extracted resume text and job listing text to the Gemini API so AI can study the listing as a full hiring brief and produce a role-matched update.

The original uploaded resume file and extracted matching text are stored inside the extension with IndexedDB. Small status metadata and the optional API key are stored in `chrome.storage.local`.

## Privacy

The extension only reads a page when you click **Generate resume** (via `activeTab`). It does not run on pages in the background.

## Notes

- PDF downloads support Latin-based characters. For resumes with non-Latin scripts (Arabic, Kurdish, etc.), use the DOCX download, which keeps full Unicode.
- Job listing extraction has dedicated support for LinkedIn, Indeed, Greenhouse, Lever, Workable, Ashby, and Glassdoor, with a generic fallback for other pages.
- Gemini requests retry automatically on rate limits and server errors.

- Supported upload formats include PDF, DOCX, TXT, Markdown, CSV, JSON, and basic RTF.
- The uploaded resume is not shown as converted plain text in the popup. Extracted content is used internally only when generating a match.
- The generated resume downloads as a `.pdf` file.
- The generated PDF uses a clean resume design with aligned margins, a styled header, section dividers, and consistent bullets while preserving the original resume structure.
- The generated resume can also be downloaded as DOCX after editing.
- For non-PDF formats, the regenerated draft keeps the user's resume structure and tone as much as possible by updating existing Summary/Profile and Skills sections instead of adding generic blocks.
- AI tailoring is instructed to analyze the job's responsibilities, qualifications, seniority, tools, and employer priorities before editing. It is also instructed not to invent employers, dates, credentials, metrics, or skills.
- The extension is designed to improve the resume based on the job listing as a whole, not by adding keyword lists.
