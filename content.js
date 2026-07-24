// LinkedIn is the primary target: extraction is scoped to the job posting the
// user is actively viewing (/jobs/view/<id> pages, or the right-hand detail
// pane on /jobs/search and /jobs/collections when currentJobId is present).
// The homepage/feed, search-result list items, and similar-jobs modules must
// never leak into the extracted text.
const LINKEDIN_TITLE_SELECTORS = [
  '.job-details-jobs-unified-top-card__job-title h1',
  '.job-details-jobs-unified-top-card__job-title',
  '.jobs-unified-top-card__job-title',
  '.top-card-layout__title',
  'h1.t-24',
  'h1'
];

const LINKEDIN_COMPANY_SELECTORS = [
  '.job-details-jobs-unified-top-card__company-name a',
  '.job-details-jobs-unified-top-card__company-name',
  '.jobs-unified-top-card__company-name',
  '.topcard__org-name-link',
  '.top-card-layout__second-subline a'
];

const LINKEDIN_LOCATION_SELECTORS = [
  '.job-details-jobs-unified-top-card__primary-description-container .tvm__text',
  '.job-details-jobs-unified-top-card__bullet',
  '.jobs-unified-top-card__bullet',
  '.jobs-unified-top-card__workplace-type',
  '.topcard__flavor--bullet'
];

const LINKEDIN_DESCRIPTION_SELECTORS = [
  '#job-details',
  '.jobs-description__content',
  '.jobs-box__html-content',
  'article.jobs-description__container',
  '.description__text',
  '.show-more-less-html__markup'
];

// The active job's detail pane, in priority order. 'main' is a last resort;
// on /jobs/view pages the whole document is an acceptable final fallback.
const LINKEDIN_DETAIL_CONTAINER_SELECTORS = [
  '.jobs-search__job-details--wrapper',
  '.scaffold-layout__detail',
  '.job-view-layout',
  'main'
];

const SITE_SELECTORS = {
  'indeed.com': ['#jobDescriptionText', '.jobsearch-JobComponent-description'],
  'greenhouse.io': ['.job__description', '#content'],
  'lever.co': ['.posting', '.section-wrapper'],
  'workable.com': ['[data-ui="job-description"]', '.job-description'],
  'ashbyhq.com': ['._descriptionText_1f5s8_1', '[class*="description"]'],
  'glassdoor.com': ['[class*="JobDetails_jobDescription"]', '#JobDescriptionContainer']
};

const GENERIC_SELECTORS = [
  '[data-testid*="job"]',
  '[class*="job-description"]',
  '[id*="job-description"]',
  '[class*="description"]',
  '[id*="description"]',
  '[class*="posting"]',
  '[id*="posting"]',
  'main',
  'article'
];

const NOISE_SELECTOR = 'nav, header, footer, aside, script, style, noscript, [role="navigation"], [role="banner"], [aria-hidden="true"]';

// Extra noise stripped on LinkedIn: similar/recommended-jobs modules and
// premium upsell blocks that can sit inside the detail pane.
const LINKEDIN_NOISE_SELECTOR = NOISE_SELECTOR + ', .jobs-similar-jobs, [class*="similar-jobs"], [data-view-name*="similar"], .jobs-premium-upsell, aside';

function cleanText(value) {
  return value
    .replace(/ /g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

function visibleText(element, noiseSelector) {
  const clone = element.cloneNode(true);
  clone.querySelectorAll(noiseSelector || NOISE_SELECTOR).forEach((node) => node.remove());
  const holder = document.createElement('div');
  holder.style.cssText = 'position:absolute;left:-99999px;top:0;width:900px;';
  holder.appendChild(clone);
  document.body.appendChild(holder);
  const text = cleanText(clone.innerText || clone.textContent || '');
  holder.remove();
  return text;
}

function scoreElement(element) {
  const text = visibleText(element);
  if (text.length < 250) return null;

  const lower = text.toLowerCase();
  const signalWords = [
    'responsibilities',
    'requirements',
    'qualifications',
    'preferred',
    'experience',
    'skills',
    'about the role',
    'what you will do',
    'job description',
    'benefits',
    'compensation'
  ];

  const signalScore = signalWords.reduce((score, word) => {
    return score + (lower.includes(word) ? 80 : 0);
  }, 0);

  const lengthScore = Math.min(text.length / 80, 120);
  return { text, score: signalScore + lengthScore };
}

function siteSpecificText() {
  const host = location.hostname.replace(/^www\./, '');
  const entry = Object.keys(SITE_SELECTORS).find((domain) => host === domain || host.endsWith(`.${domain}`));
  if (!entry) return null;

  for (const selector of SITE_SELECTORS[entry]) {
    const element = document.querySelector(selector);
    if (!element) continue;
    const text = visibleText(element);
    if (text.length >= 250) return text;
  }
  return null;
}

function firstMatchText(selectors, root) {
  const scope = root || document;
  for (const selector of selectors) {
    const element = scope.querySelector(selector);
    if (!element) continue;
    const text = cleanText(element.innerText || element.textContent || '');
    if (text) return text.split('\n')[0].trim();
  }
  return '';
}

function isLinkedIn() {
  return /(^|\.)linkedin\.com$/.test(location.hostname.replace(/^www\./, ''));
}

// Detects whether the user is actively viewing a job posting.
// Returns { jobId, isViewPage } or null when there is no active job
// (homepage, feed, company pages, search page with nothing selected).
function linkedInActiveJob() {
  const path = location.pathname;

  if (/^\/jobs\/view\//.test(path)) {
    const segment = path.split('/')[3] || '';
    const digits = segment.match(/\d+/g);
    return { jobId: digits ? digits[digits.length - 1] : '', isViewPage: true };
  }

  if (/^\/jobs\/(search|collections)/.test(path)) {
    const currentJobId = new URLSearchParams(location.search).get('currentJobId');
    if (currentJobId) return { jobId: currentJobId, isViewPage: false };
  }

  return null;
}

// The container holding only the active job's details. Every query is scoped
// to it so list items and similar jobs can never leak in.
function linkedInDetailContainer(isViewPage) {
  for (const selector of LINKEDIN_DETAIL_CONTAINER_SELECTORS) {
    const element = document.querySelector(selector);
    if (element) return element;
  }
  return isViewPage ? document : null;
}

function linkedInDescription(container) {
  let best = '';
  for (const selector of LINKEDIN_DESCRIPTION_SELECTORS) {
    container.querySelectorAll(selector).forEach((element) => {
      // LinkedIn's "see more" clamp is CSS-only; innerText already holds the
      // full description, so nothing needs to be clicked.
      const text = visibleText(element, LINKEDIN_NOISE_SELECTOR);
      if (text.length > best.length) best = text;
    });
  }
  return best;
}

function extractLinkedInJob() {
  const active = linkedInActiveJob();
  if (!active) return null;

  const container = linkedInDetailContainer(active.isViewPage);
  if (!container) return null;

  const description = linkedInDescription(container);
  if (description.length < 200) return null;

  const title = firstMatchText(LINKEDIN_TITLE_SELECTORS, container);
  const company = firstMatchText(LINKEDIN_COMPANY_SELECTORS, container);
  const jobLocation = firstMatchText(LINKEDIN_LOCATION_SELECTORS, container);

  const displayTitle = [title, company].filter(Boolean).join(' at ') || cleanText(document.title);
  const headerLines = [];
  if (title) headerLines.push(`Job title: ${title}`);
  if (company) headerLines.push(`Company: ${company}`);
  if (jobLocation) headerLines.push(`Location: ${jobLocation}`);
  const header = headerLines.join('\n');

  return {
    title: displayTitle,
    company: company || '',
    url: location.href,
    text: `${header}${header ? '\n\n' : ''}${description}`.slice(0, 30000),
    jobId: active.jobId || ''
  };
}

function extractJobText() {
  let best = siteSpecificText();

  if (!best) {
    const candidates = [];
    GENERIC_SELECTORS.forEach((selector) => {
      document.querySelectorAll(selector).forEach((element) => {
        const scored = scoreElement(element);
        if (scored) candidates.push(scored);
      });
    });

    const fallback = scoreElement(document.body);
    if (fallback) candidates.push(fallback);

    candidates.sort((a, b) => b.score - a.score);
    best = candidates[0]?.text || cleanText(document.body.innerText || '');
  }

  return {
    title: cleanText(document.title || 'Job listing'),
    company: '',
    url: location.href,
    text: best.slice(0, 30000),
    jobId: ''
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'EXTRACT_JOB_TEXT') return false;

  if (isLinkedIn()) {
    const job = extractLinkedInJob();
    if (job) {
      sendResponse({ ok: true, job });
    } else {
      sendResponse({ ok: false, error: 'Open a LinkedIn job posting first, then try again.' });
    }
    return true;
  }

  sendResponse({ ok: true, job: extractJobText() });
  return true;
});
