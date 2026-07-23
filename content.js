// LinkedIn is the primary target: dedicated selectors for both the logged-in job
// view (/jobs/view/... and the /jobs/collections right-hand pane) and the public
// logged-out job pages.
const LINKEDIN_TITLE_SELECTORS = [
  '.job-details-jobs-unified-top-card__job-title h1',
  '.job-details-jobs-unified-top-card__job-title',
  '.jobs-unified-top-card__job-title',
  '.top-card-layout__title',
  'h1.t-24'
];

const LINKEDIN_COMPANY_SELECTORS = [
  '.job-details-jobs-unified-top-card__company-name a',
  '.job-details-jobs-unified-top-card__company-name',
  '.jobs-unified-top-card__company-name',
  '.topcard__org-name-link',
  '.top-card-layout__second-subline a'
];

const LINKEDIN_DESCRIPTION_SELECTORS = [
  '.jobs-description__content',
  '#job-details',
  '.jobs-box__html-content',
  'article.jobs-description__container',
  '.jobs-search__job-details--container',
  '.description__text',
  '.show-more-less-html__markup'
];

const SITE_SELECTORS = {
  'linkedin.com': LINKEDIN_DESCRIPTION_SELECTORS,
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

function cleanText(value) {
  return value
    .replace(/ /g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

function visibleText(element) {
  const clone = element.cloneNode(true);
  clone.querySelectorAll(NOISE_SELECTOR).forEach((node) => node.remove());
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

function firstMatchText(selectors) {
  for (const selector of selectors) {
    const element = document.querySelector(selector);
    if (!element) continue;
    const text = cleanText(element.innerText || element.textContent || '');
    if (text) return text.split('\n')[0].trim();
  }
  return '';
}

function isLinkedIn() {
  return /(^|\.)linkedin\.com$/.test(location.hostname.replace(/^www\./, ''));
}

function extractLinkedInJob() {
  const title = firstMatchText(LINKEDIN_TITLE_SELECTORS);
  const company = firstMatchText(LINKEDIN_COMPANY_SELECTORS);

  let description = '';
  for (const selector of LINKEDIN_DESCRIPTION_SELECTORS) {
    const element = document.querySelector(selector);
    if (!element) continue;
    const text = visibleText(element);
    if (text.length > description.length) description = text;
  }
  if (description.length < 250) return null;

  const displayTitle = [title, company].filter(Boolean).join(' at ') || cleanText(document.title);
  const header = [
    title ? `Job title: ${title}` : '',
    company ? `Company: ${company}` : ''
  ].filter(Boolean).join('\n');

  return {
    title: displayTitle,
    url: location.href,
    text: `${header}${header ? '\n\n' : ''}${description}`.slice(0, 30000)
  };
}

function extractJobText() {
  if (isLinkedIn()) {
    const linkedInJob = extractLinkedInJob();
    if (linkedInJob) return linkedInJob;
  }

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
    url: location.href,
    text: best.slice(0, 30000)
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'EXTRACT_JOB_TEXT') return false;

  sendResponse({ ok: true, job: extractJobText() });
  return true;
});
