const resumeFile = document.querySelector('#resumeFile');
const fileCta = document.querySelector('.file-cta');
const clearResume = document.querySelector('#clearResume');
const analyzeJob = document.querySelector('#analyzeJob');
const saveState = document.querySelector('#saveState');
const jobState = document.querySelector('#jobState');
const downloadOriginal = document.querySelector('#downloadOriginal');
const generatedState = document.querySelector('#generatedState');
const resumeDraft = document.querySelector('#resumeDraft');
const downloadPdf = document.querySelector('#downloadPdf');
const downloadDocx = document.querySelector('#downloadDocx');
const accountState = document.querySelector('#accountState');
const quotaState = document.querySelector('#quotaState');
const syncButton = document.querySelector('#syncButton');
const upsellPanel = document.querySelector('#upsellPanel');
const upgradeButton = document.querySelector('#upgradeButton');
const matchPanel = document.querySelector('#matchPanel');
const matchValue = document.querySelector('#matchValue');
const matchDelta = document.querySelector('#matchDelta');
const resultPanel = document.querySelector('#resultPanel');
const progressWrap = document.querySelector('#progressWrap');
const progressFill = document.querySelector('#progressFill');
const progressLabel = document.querySelector('#progressLabel');
const checkMatch = document.querySelector('#checkMatch');
const boostMatch = document.querySelector('#boostMatch');
const matchCheckPanel = document.querySelector('#matchCheckPanel');
const matchCheckScore = document.querySelector('#matchCheckScore');
const matchCheckVerdict = document.querySelector('#matchCheckVerdict');
const matchedChips = document.querySelector('#matchedChips');
const missingChips = document.querySelector('#missingChips');
const maxIntensityOption = document.querySelector('#maxIntensityOption');
const ultraIntensityOption = document.querySelector('#ultraIntensityOption');
const targetingRow = document.querySelector('#targetingRow');
const atsMatchBox = document.querySelector('#atsMatch');
const recruiterMatchBox = document.querySelector('#recruiterMatch');
const shell = document.querySelector('.shell');
const signinPanel = document.querySelector('#signinPanel');
const signinButton = document.querySelector('#signinButton');
const signinHint = document.querySelector('#signinHint');

// Shell sections that are visible by default. Captured once at load so signing in
// never force-shows panels other code toggles on its own (result, upsell).
const defaultVisibleSections = Array.from(shell.children).filter(
  (el) => el !== signinPanel && !el.classList.contains('hidden')
);

let progressTimer = null;

function progressShow(label, pct) {
  progressWrap.classList.remove('hidden');
  progressLabel.textContent = label;
  progressFill.style.width = `${pct}%`;
}

// Creeps the bar toward `limit` while a slow step (page read, AI call) is running,
// so it keeps moving instead of sitting frozen.
function progressCrawlTo(limit) {
  clearInterval(progressTimer);
  progressTimer = setInterval(() => {
    const current = parseFloat(progressFill.style.width) || 0;
    if (current >= limit) return;
    const step = Math.max(0.35, (limit - current) * 0.035);
    progressFill.style.width = `${Math.min(limit, current + step)}%`;
  }, 180);
}

function progressHide(delayMs = 1200) {
  clearInterval(progressTimer);
  progressTimer = null;
  setTimeout(() => progressWrap.classList.add('hidden'), delayMs);
}

// Watermarks are gone entirely - free vs pro is now a monthly generation quota.
// stripWatermark stays as a harmless cleaner for any legacy stored text.
const WATERMARK_MARKER = 'Made with ResumePilot';

function stripWatermark(text) {
  const idx = text.lastIndexOf(WATERMARK_MARKER);
  if (idx === -1) return text.trim();
  return text.slice(0, idx).replace(/\n+-{2,}\s*$/, '').trim();
}

function watermarkLineForPlan() {
  return '';
}
const chatLog = document.querySelector('#chatLog');
const chatInput = document.querySelector('#chatInput');
const chatSend = document.querySelector('#chatSend');
const chatPanel = document.querySelector('#chatPanel');
const editorBlock = document.querySelector('#editorBlock');

let currentResumeText = '';
let currentGeneratedResume = null;
let currentOriginalResume = null;
let storedResumeFilename = '';

// Output files are named "<original resume name> - <job title>.pdf".
function buildOutputFilename(jobTitle) {
  const original = (currentOriginalResume?.name || storedResumeFilename || 'resume').replace(/\.[^.]+$/, '');
  return `${makeSafeFilename(`${original} - ${jobTitle || 'job'}`)}.pdf`;
}
let currentDeviceId = '';
let currentQuota = null;
let currentAccount = null;
let serverHasResume = false;
// The server keeps a copy of the uploaded file itself, so "Download original
// file" works on devices that never saw the local IndexedDB record.
let serverHasResumeFile = false;
let currentMatch = { before: null, after: null };
let pollTimer = null;
let isBusyState = false;
let boostLockedByPlan = false;

function hasResume() {
  return Boolean(currentResumeText || serverHasResume);
}

function hasOriginalFile() {
  return Boolean(currentOriginalResume || serverHasResumeFile);
}

// The file picker label doubles as the replace affordance once a resume exists.
function renderFileCta() {
  fileCta.textContent = hasResume() ? 'Upload new resume' : 'Choose file';
}

// Convert in 32KB slices; one String.fromCharCode call over a multi-megabyte
// file would overflow the call stack.
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function base64ToBlob(base64, mime) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mime || 'application/octet-stream' });
}

function renderMatch() {
  const { before, after } = currentMatch;
  if (after == null) {
    matchPanel.classList.add('hidden');
    return;
  }
  matchPanel.classList.remove('hidden');
  matchValue.textContent = `${after}%`;
  matchDelta.textContent = before != null && before !== after ? `up from ${before}%` : '';
}

function renderChipList(container, keywords, chipClass) {
  container.innerHTML = '';
  const list = Array.isArray(keywords) ? keywords : [];
  list.forEach((keyword) => {
    const chip = document.createElement('span');
    chip.className = `chip ${chipClass}`;
    chip.textContent = keyword;
    container.appendChild(chip);
  });
  container.closest('.chip-group').classList.toggle('hidden', !list.length);
}

function hideMatchCheck() {
  matchCheckPanel.classList.add('hidden');
  matchedChips.innerHTML = '';
  missingChips.innerHTML = '';
}

// A random id is generated once per browser install and sent on every request; the
// backend maps it to the Google account the user links during mandatory sign-in.
async function getOrCreateDeviceId() {
  const stored = await chrome.storage.local.get(['deviceId']);
  if (stored.deviceId) return stored.deviceId;
  const deviceId = crypto.randomUUID();
  await chrome.storage.local.set({ deviceId });
  return deviceId;
}

function showError(element, message) {
  element.classList.add('error');
  element.textContent = message;
}

function clearError(element) {
  element.classList.remove('error');
}

function setBusy(isBusy) {
  isBusyState = isBusy;
  analyzeJob.disabled = isBusy || !hasResume();
  checkMatch.disabled = isBusy || !hasResume();
  boostMatch.disabled = isBusy || !currentGeneratedResume || boostLockedByPlan;
  clearResume.disabled = isBusy;
  downloadOriginal.disabled = isBusy || !hasOriginalFile();
  downloadPdf.disabled = isBusy || !resumeDraft.value.trim();
  downloadDocx.disabled = isBusy || !resumeDraft.value.trim();
  chatSend.disabled = isBusy || !currentGeneratedResume;
  chatInput.disabled = isBusy || !currentGeneratedResume;
}

function extractJobTitle(jobText, pageTitle) {
  const lines = jobText.split(/[.\n]/).map((line) => line.trim()).filter(Boolean);
  const firstUseful = lines.find((line) => line.length >= 8 && line.length <= 90);
  return firstUseful || pageTitle || 'Target Role';
}

function isSectionHeading(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > 48) return false;
  return /^[A-Z][A-Z\s/&+-]{2,}$/.test(trimmed) || /^(summary|profile|objective|skills|technical skills|core skills|experience|work experience|professional experience|education|projects)$/i.test(trimmed);
}

function makeSafeFilename(value) {
  return value.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80) || 'matched-resume';
}

// ---- Backend API ----

async function apiFetch(path, options = {}) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Device-Id': currentDeviceId,
      ...(options.headers || {})
    }
  });

  let data = null;
  try {
    data = await response.json();
  } catch (_e) {
    data = null;
  }

  if (!response.ok) {
    // Any endpoint can answer "sign in first"; flip the popup to the gate.
    if (data?.code === 'SIGNIN_REQUIRED') setSignedInUI(false);
    throw new Error(data?.error || `Request failed (${response.status}).`);
  }
  return data;
}

function renderQuota() {
  if (!currentQuota) {
    quotaState.textContent = '';
    return;
  }
  const isPro = currentQuota.isPro;
  accountState.textContent = isPro ? 'Pro plan' : 'Free plan';
  if (isPro && currentQuota.credits) {
    quotaState.textContent = `${currentQuota.credits.remaining} credits`;
  } else if (currentQuota.limit != null) {
    quotaState.textContent = `${currentQuota.remaining} of ${currentQuota.limit} left this month`;
  } else {
    quotaState.textContent = '';
  }

  const upsellText = document.querySelector('#upsellText');
  if (upsellText && !isPro && currentQuota.limit != null) {
    upsellText.textContent = `Your ${currentQuota.limit} free tailored resumes for this month are used. Subscribe to keep going.`;
  }

  applyPlanGating();
  applyFeatureGates();
  renderIntensityCosts();
  maybeShowUpsell();
}

// Every feature (Max, Ultra, Boost) is available on every plan - the only limit is
// the monthly quota. Keep everything unlocked; the server agrees.
function applyPlanGating() {
  [maxIntensityOption, ultraIntensityOption].forEach((optionEl) => {
    if (!optionEl) return;
    const input = optionEl.querySelector('input');
    const badge = optionEl.querySelector('.lock-badge');
    optionEl.classList.remove('locked');
    if (input) input.disabled = false;
    if (badge) badge.classList.add('hidden');
    optionEl.title = '';
  });

  boostLockedByPlan = false;
  boostMatch.title = '';
  boostMatch.disabled = isBusyState || !currentGeneratedResume;
}

// Feature gates come from the server (userSummary.features). When a feature is off
// for the plan, its UI disappears entirely - no teaser, no upgrade copy - because
// money is never mentioned before the free quota runs out. Only the specific
// sub-elements are toggled here; #resultPanel visibility stays under its own logic.
// A missing features object (older server response) leaves everything visible.
function applyFeatureGates() {
  const features = currentQuota?.features || null;
  const canEdit = !features || features.editor !== false;
  const canRefine = !features || features.refine !== false;
  const canBoost = !features || features.boost !== false;

  if (editorBlock) editorBlock.classList.toggle('hidden', !canEdit);
  if (chatPanel) chatPanel.classList.toggle('hidden', !canRefine);
  boostMatch.classList.toggle('hidden', !canBoost);
  boostLockedByPlan = !canBoost;
  boostMatch.disabled = isBusyState || !currentGeneratedResume || boostLockedByPlan;

  // ATS / recruiter targeting is an Elite modifier. Free and unknown plans never
  // see the row at all, Pro sees it locked behind an Elite badge, and Elite gets
  // live checkboxes. Locked or hidden boxes always reset to unchecked so a stale
  // check can never ride along in a generate request.
  const plan = String(currentQuota?.plan || currentQuota?.tier || '').toLowerCase();
  const isElitePlan = plan === 'elite';
  const isPaidPlan = isElitePlan || plan === 'pro' || Boolean(currentQuota?.isPro);
  if (targetingRow) {
    targetingRow.classList.toggle('hidden', !isPaidPlan);
    [atsMatchBox, recruiterMatchBox].forEach((box) => {
      if (!box) return;
      box.disabled = !isElitePlan;
      if (!isElitePlan) box.checked = false;
    });
    targetingRow.querySelectorAll('.lock-badge').forEach((badge) => {
      badge.classList.toggle('hidden', isElitePlan);
    });
  }
}

// The intensity radio values predate the credit system, so map them to the keys
// the server uses in userSummary.costs.
const INTENSITY_COST_KEYS = { minimal: 'light', balanced: 'medium', max: 'max', ultra: 'ultra' };

// Paid plans see the live per-use credit cost on each intensity card, e.g.
// "Ultra - 5 cr". Free plans see plain labels with no credit talk at all.
function renderIntensityCosts() {
  const costs = currentQuota?.isPro ? currentQuota?.costs : null;
  document.querySelectorAll('.intensity-option').forEach((optionEl) => {
    const input = optionEl.querySelector('input');
    const costEl = optionEl.querySelector('.intensity-cost');
    if (!input || !costEl) return;
    const cost = costs ? costs[INTENSITY_COST_KEYS[input.value]] : null;
    costEl.textContent = cost != null ? ` - ${cost} cr` : '';
  });
}

// Never mention money until the free quota is actually used up.
function maybeShowUpsell() {
  const exhausted = currentQuota && !currentQuota.isPro && currentQuota.remaining <= 0;
  upsellPanel.classList.toggle('hidden', !exhausted);
}

async function refreshAccount() {
  const me = await apiFetch('/api/me');
  currentQuota = me;
  renderQuota();
}

// Signed-out mode hides every top-level shell section except the topbar branding
// and the sign-in gate. Signed-in mode restores only the sections that are visible
// by default; conditional panels (result, upsell) stay under their own logic.
function setSignedInUI(signedIn) {
  Array.from(shell.children).forEach((el) => {
    if (el === signinPanel || el.tagName === 'HEADER') return;
    if (!signedIn) {
      el.classList.add('hidden');
    } else if (defaultVisibleSections.includes(el)) {
      el.classList.remove('hidden');
    }
  });
  signinPanel.classList.toggle('hidden', signedIn);
}

// Pulls plan, stored resume, and the latest generation from the server so closing
// and reopening the popup never loses the user's work.
async function restoreServerState() {
  const state = await apiFetch('/api/state');
  currentQuota = state.user;
  serverHasResume = Boolean(state.resume);
  renderQuota();

  if (state.account) {
    currentAccount = state.account;
    syncButton.classList.add('hidden');
    accountState.textContent = `${currentQuota?.isPro ? 'Pro plan' : 'Free plan'} - ${state.account.email}`;
  } else {
    currentAccount = null;
    syncButton.classList.remove('hidden');
  }

  setSignedInUI(Boolean(state.account));

  if (state.resume) {
    storedResumeFilename = state.resume.filename || '';
    serverHasResumeFile = Boolean(state.resume.hasFile);
    if (!currentOriginalResume) {
      saveState.textContent = `On file: ${state.resume.filename || 'your resume'}`;
    }
  } else {
    serverHasResumeFile = false;
  }
  renderFileCta();
  downloadOriginal.disabled = isBusyState || !hasOriginalFile();

  if (state.generation) {
    const restoredBody = stripWatermark(state.generation.text);
    currentGeneratedResume = {
      id: state.generation.id,
      text: restoredBody,
      filename: buildOutputFilename(state.generation.jobTitle),
      aiSummary: ''
    };
    currentMatch = { before: state.generation.matchBefore, after: state.generation.matchAfter };
    renderMatch();
    resultPanel.classList.remove('hidden');
    resumeDraft.value = restoredBody;
    updateDownloadButtons();
    chatInput.disabled = false;
    chatSend.disabled = false;
    jobState.textContent = state.generation.jobTitle || 'Your last tailored resume';
    generatedState.textContent = currentQuota?.features?.refine === false
      ? 'Your last tailored resume is ready. Download it again anytime.'
      : 'Your last tailored resume is ready. Refine it or download again.';
    maybeShowUpsell();
  }

  applyFeatureGates();
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// Device-code style handshake: open the Google Sign-In tab, then poll link/status
// every 2s until the device is linked (or the 10-minute link expires). Shared by
// the header sync button and the sign-in gate button.
async function startSignIn(button) {
  button.disabled = true;
  try {
    const r = await apiFetch('/api/link/start', { method: 'POST', body: JSON.stringify({}) });
    await chrome.tabs.create({ url: r.linkUrl });

    stopPolling();
    let attempts = 0;
    const maxAttempts = Math.ceil((10 * 60 * 1000) / 2000);
    pollTimer = setInterval(async () => {
      attempts += 1;
      try {
        const s = await apiFetch('/api/link/status?token=' + r.token);
        if (s.status === 'consumed') {
          stopPolling();
          await restoreServerState();
          button.disabled = false;
          return;
        }
      } catch (_pollError) {
        // Transient errors are fine here; keep polling until the attempt cap.
      }
      if (attempts >= maxAttempts) {
        stopPolling();
        button.disabled = false;
      }
    }, 2000);
  } catch (error) {
    quotaState.textContent = error.message || 'Could not start sync.';
    button.disabled = false;
  }
}

syncButton.addEventListener('click', () => startSignIn(syncButton));
signinButton.addEventListener('click', () => startSignIn(signinButton));

upgradeButton.addEventListener('click', async () => {
  upgradeButton.disabled = true;
  try {
    const result = await apiFetch('/api/checkout', { method: 'POST', body: JSON.stringify({}) });
    await chrome.tabs.create({ url: result.url });

    // Poll for a couple of minutes so the popup flips to Pro as soon as the Stripe
    // webhook lands, without the user having to reopen the extension.
    stopPolling();
    let attempts = 0;
    pollTimer = setInterval(async () => {
      attempts += 1;
      try {
        await refreshAccount();
        if (currentQuota?.isPro || attempts > 60) stopPolling();
      } catch (_pollError) {
        // Transient errors are fine here; keep polling until the attempt cap.
      }
    }, 2000);
  } catch (error) {
    quotaState.textContent = error.message || 'Could not start checkout.';
  } finally {
    upgradeButton.disabled = false;
  }
});

// ---- PDF/DOCX generation (unchanged local rendering) ----

function escapePdfText(value) {
  return value
    .normalize('NFKD')
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function wrapPdfLine(line, maxChars) {
  const words = line.trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';

  words.forEach((word) => {
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  });

  if (current) lines.push(current);
  return lines.length ? lines : [''];
}

function buildPdfBlob(text) {
  const pageWidth = 612;
  const pageHeight = 792;
  const margin = 54;
  const lineHeight = 14;
  const maxLines = Math.floor((pageHeight - margin * 2) / lineHeight);
  const wrappedLines = [];

  text.split(/\n/).forEach((rawLine) => {
    if (!rawLine.trim()) {
      wrappedLines.push('');
      return;
    }
    wrapPdfLine(rawLine, 88).forEach((line) => wrappedLines.push(line));
  });

  const pages = [];
  for (let index = 0; index < wrappedLines.length; index += maxLines) {
    pages.push(wrappedLines.slice(index, index + maxLines));
  }
  if (!pages.length) pages.push(['']);

  const objects = [];
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  const kids = pages.map((_page, index) => `${3 + index * 2} 0 R`).join(' ');
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);

  pages.forEach((pageLines, index) => {
    const pageObjectNumber = 3 + index * 2;
    const contentObjectNumber = pageObjectNumber + 1;
    const streamLines = ['BT', '/F1 11 Tf', '14 TL', `${margin} ${pageHeight - margin} Td`];

    pageLines.forEach((line, lineIndex) => {
      if (lineIndex > 0) streamLines.push('T*');
      streamLines.push(`(${escapePdfText(line)}) Tj`);
    });
    streamLines.push('ET');

    const stream = streamLines.join('\n');
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 ${3 + pages.length * 2} 0 R >> >> /Contents ${contentObjectNumber} 0 R >>`);
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });

  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });

  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach((offset) => {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;

  return new Blob([pdf], { type: 'application/pdf' });
}

function parseResumeBlocks(text) {
  const lines = text
    .split(/\n/)
    .map((line) => sanitizePdfDrawText(line).trim())
    .filter(Boolean);
  const firstHeadingIndex = lines.findIndex((line, index) => index > 0 && isSectionHeading(line));
  const headerLines = lines.slice(0, firstHeadingIndex > 0 ? firstHeadingIndex : Math.min(lines.length, 3));
  const bodyLines = lines.slice(headerLines.length);
  const blocks = [];
  let current = null;

  bodyLines.forEach((line) => {
    if (isSectionHeading(line)) {
      current = { heading: line, items: [] };
      blocks.push(current);
      return;
    }

    if (!current) {
      current = { heading: 'Profile', items: [] };
      blocks.push(current);
    }
    current.items.push(line);
  });

  return { headerLines, blocks };
}

function wrapPdfTextByWidth(text, font, fontSize, maxWidth) {
  const words = sanitizePdfDrawText(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';

  words.forEach((word) => {
    const next = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(next, fontSize) > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  });

  if (current) lines.push(current);
  return lines;
}

async function buildDesignedPdfBlob(text, watermarkLine = '') {
  if (!window.PDFLib) {
    return buildPdfBlob(watermarkLine ? `${text}\n\n${watermarkLine}` : text);
  }

  const { PDFDocument, StandardFonts, rgb, degrees } = window.PDFLib;
  const pdfDoc = await PDFDocument.create();
  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const italic = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);
  const pageWidth = 612;
  const pageHeight = 792;
  const marginX = 40;
  const topMargin = 38;
  const bottomMargin = 40;
  const accent = rgb(0.12, 0.34, 0.37);
  const muted = rgb(0.31, 0.35, 0.36);
  const ink = rgb(0.09, 0.1, 0.1);
  let page = pdfDoc.addPage([pageWidth, pageHeight]);
  let y = pageHeight - topMargin;

  function addPage() {
    page = pdfDoc.addPage([pageWidth, pageHeight]);
    y = pageHeight - topMargin;
  }

  function ensureSpace(height) {
    if (y - height < bottomMargin) addPage();
  }

  function drawTextLine(value, x, options = {}) {
    const font = options.font || regular;
    const size = options.size || 10;
    const color = options.color || ink;
    page.drawText(sanitizePdfDrawText(value), { x, y, size, font, color });
    y -= options.lineHeight || size + 2.8;
  }

  function drawWrapped(value, x, width, options = {}) {
    const font = options.font || regular;
    const size = options.size || 10;
    const lineHeight = options.lineHeight || 12.6;
    const lines = wrapPdfTextByWidth(value, font, size, width);
    ensureSpace(Math.max(lineHeight, lines.length * lineHeight));
    lines.forEach((line) => {
      drawTextLine(line, x, { ...options, font, size, lineHeight });
    });
  }

  const { headerLines, blocks } = parseResumeBlocks(text);
  const name = headerLines[0] || 'Resume';
  const subtitle = headerLines[1] || '';
  const contact = headerLines.slice(2).join(' | ');

  drawTextLine(name, marginX, { font: bold, size: 19, color: accent, lineHeight: 22 });
  if (subtitle) drawTextLine(subtitle, marginX, { font: regular, size: 10.8, color: muted, lineHeight: 13.5 });
  if (contact) drawWrapped(contact, marginX, pageWidth - marginX * 2, { font: regular, size: 9, color: muted, lineHeight: 11.2 });
  page.drawLine({
    start: { x: marginX, y: y - 2 },
    end: { x: pageWidth - marginX, y: y - 2 },
    thickness: 1.1,
    color: accent
  });
  y -= 14;

  blocks.forEach((block) => {
    ensureSpace(38);
    const heading = block.heading.toUpperCase();
    page.drawText(heading, { x: marginX, y, size: 9.5, font: bold, color: accent });
    page.drawLine({
      start: { x: marginX, y: y - 3.5 },
      end: { x: pageWidth - marginX, y: y - 3.5 },
      thickness: 0.5,
      color: rgb(0.76, 0.82, 0.8)
    });
    y -= 14;

    block.items.forEach((item) => {
      const bulletMatch = item.match(/^[-*•●]\s*(.+)$/);
      const isRoleLine = !bulletMatch && /^[A-Z][A-Z\s,&./'-]+(?:\d{4}|PRESENT|CURRENT|REMOTE|VA|DC|NY|CA)/i.test(item);

      if (bulletMatch) {
        ensureSpace(14);
        page.drawText('-', { x: marginX + 8, y, size: 9.8, font: bold, color: accent });
        drawWrapped(bulletMatch[1], marginX + 20, pageWidth - marginX * 2 - 20, { font: regular, size: 9.6, color: ink, lineHeight: 12.2 });
      } else if (isRoleLine) {
        y -= 2.5;
        drawWrapped(item, marginX, pageWidth - marginX * 2, { font: bold, size: 9.9, color: ink, lineHeight: 12.2 });
      } else {
        drawWrapped(item, marginX, pageWidth - marginX * 2, { font: regular, size: 9.7, color: ink, lineHeight: 12.4 });
      }
    });
    y -= 7;
  });

  const pageCount = pdfDoc.getPageCount();
  pdfDoc.getPages().forEach((pdfPage, index) => {
    if (watermarkLine) {
      // Three big diagonal stamps so the watermark covers roughly half the page.
      const stampText = 'JOB RESUME TAILOR - FREE';
      const stampSize = 42;
      const stampWidth = bold.widthOfTextAtSize(stampText, stampSize);
      const angleDeg = 32;
      const rad = (angleDeg * Math.PI) / 180;
      const extentX = stampWidth * Math.cos(rad);
      const extentY = stampWidth * Math.sin(rad);
      const baseX = (pageWidth - extentX) / 2;
      const baseY = (pageHeight - extentY) / 2;

      [-0.30, 0, 0.30].forEach((offset) => {
        pdfPage.drawText(stampText, {
          x: baseX,
          y: baseY + pageHeight * offset,
          size: stampSize,
          font: bold,
          color: rgb(0.6, 0.65, 0.63),
          opacity: 0.2,
          rotate: degrees(angleDeg)
        });
      });
    }
    if (pageCount > 1) {
      pdfPage.drawText(`${index + 1} / ${pageCount}`, {
        x: pageWidth - marginX - 24,
        y: 22,
        size: 8,
        font: italic,
        color: muted
      });
    }
  });

  const bytes = await pdfDoc.save();
  return new Blob([bytes], { type: 'application/pdf' });
}

function normalizeResumeText(value) {
  return value
    .normalize('NFC')
    .replace(/[•●▪◦]/g, '-')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, '-')
    .replace(/ /g, ' ');
}

function sanitizePdfDrawText(value) {
  // Standard PDF fonts only encode WinAnsi (Latin-1); wider scripts must use the DOCX download.
  return normalizeResumeText(value)
    .replace(/[^\x09\x0A\x0D\x20-\x7E¡-ÿ]/g, '');
}

function textNeedsUnicodeFont(value) {
  return /[^\x09\x0A\x0D\x20-\x7E¡-ÿ]/.test(normalizeResumeText(value));
}

function getEditedResumeText() {
  return resumeDraft.value.trim();
}

function updateDownloadButtons() {
  const hasDraft = Boolean(getEditedResumeText());
  downloadPdf.disabled = !hasDraft;
  downloadDocx.disabled = !hasDraft;
}

function makeDocxParagraph(line, index) {
  const docxLib = window.docx;
  const trimmed = normalizeResumeText(line).trim();
  const isHeader = index === 0;
  const isSection = isSectionHeading(trimmed);
  const bullet = trimmed.match(/^[-*•●]\s*(.+)$/);

  if (bullet) {
    return new docxLib.Paragraph({
      children: [new docxLib.TextRun({ text: bullet[1], size: 21 })],
      bullet: { level: 0 },
      spacing: { after: 90 }
    });
  }

  if (isHeader) {
    return new docxLib.Paragraph({
      children: [new docxLib.TextRun({ text: trimmed, bold: true, size: 32, color: '1F5F5B' })],
      spacing: { after: 100 }
    });
  }

  if (isSection) {
    return new docxLib.Paragraph({
      children: [new docxLib.TextRun({ text: trimmed.toUpperCase(), bold: true, size: 22, color: '1F5F5B' })],
      spacing: { before: 220, after: 80 },
      border: {
        bottom: { color: 'B8C8C3', space: 1, style: docxLib.BorderStyle.SINGLE, size: 6 }
      }
    });
  }

  return new docxLib.Paragraph({
    children: [new docxLib.TextRun({ text: trimmed, size: 21 })],
    spacing: { after: 90 }
  });
}

async function buildDocxBlob(text, watermarkLine = '') {
  if (!window.docx) {
    throw new Error('DOCX generator is unavailable.');
  }

  const docxLib = window.docx;
  const lines = text.split(/\n/);
  const children = lines.map((line, index) => makeDocxParagraph(line, index));

  if (watermarkLine) {
    children.push(new docxLib.Paragraph({
      children: [new docxLib.TextRun({ text: watermarkLine, italics: true, size: 15, color: '8C9693' })],
      spacing: { before: 280 },
      alignment: docxLib.AlignmentType.CENTER
    }));
  }

  const doc = new docxLib.Document({
    sections: [
      {
        properties: {
          page: {
            margin: { top: 720, right: 720, bottom: 720, left: 720 }
          }
        },
        children
      }
    ]
  });

  return docxLib.Packer.toBlob(doc);
}

async function downloadBlob(blob, filename, saveAs = false) {
  const url = URL.createObjectURL(blob);
  await new Promise((resolve, reject) => {
    chrome.downloads.download({ url, filename, saveAs }, (downloadId) => {
      const downloadError = chrome.runtime.lastError;
      if (downloadError) {
        reject(new Error(downloadError.message));
        return;
      }
      resolve(downloadId);
    });
  });
}

// ---- Local file storage (IndexedDB keeps the original file for download-original) ----

function openResumeDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('job-resume-tailor', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('resume');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Could not open extension storage.'));
  });
}

async function readResumeRecord() {
  const db = await openResumeDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('resume', 'readonly');
    const request = transaction.objectStore('resume').get('current');
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(new Error('Could not read stored resume.'));
    transaction.oncomplete = () => db.close();
  });
}

async function writeResumeRecord(record) {
  const db = await openResumeDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('resume', 'readwrite');
    transaction.objectStore('resume').put(record, 'current');
    transaction.oncomplete = () => {
      db.close();
      resolve();
    };
    transaction.onerror = () => reject(new Error('Could not store resume.'));
  });
}

async function deleteResumeRecord() {
  const db = await openResumeDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('resume', 'readwrite');
    transaction.objectStore('resume').delete('current');
    transaction.oncomplete = () => {
      db.close();
      resolve();
    };
    transaction.onerror = () => reject(new Error('Could not clear stored resume.'));
  });
}

function readFileAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read file.'));
    reader.readAsArrayBuffer(file);
  });
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Could not read file.'));
    reader.readAsText(file);
  });
}

async function extractPdfText(file) {
  const pdfjsLib = await import(chrome.runtime.getURL('vendor/pdf.mjs'));
  pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('vendor/pdf.worker.mjs');

  const data = await readFileAsArrayBuffer(file);
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  const pages = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const lines = groupPdfItemsIntoLines(content.items);
    pages.push(lines.map((line) => line.text).join('\n'));
  }

  return pages.join('\n\n').trim();
}

function groupPdfItemsIntoLines(items) {
  const textItems = items
    .filter((item) => item.str && item.str.trim())
    .map((item) => ({
      text: item.str,
      x: item.transform[4],
      y: item.transform[5],
      width: item.width,
      height: item.height || 11
    }));
  const rows = [];

  textItems.forEach((item) => {
    let row = rows.find((candidate) => Math.abs(candidate.y - item.y) < 3);
    if (!row) {
      row = { y: item.y, items: [] };
      rows.push(row);
    }
    row.items.push(item);
  });

  return rows
    .sort((a, b) => b.y - a.y)
    .map((row) => {
      const sorted = row.items.sort((a, b) => a.x - b.x);
      const text = sorted.map((item, index) => {
        if (index === 0) return item.text;
        const previous = sorted[index - 1];
        const gap = item.x - (previous.x + previous.width);
        return gap > 4 ? ` ${item.text}` : item.text;
      }).join('').replace(/\s+/g, ' ').trim();

      return {
        text,
        x: Math.min(...sorted.map((item) => item.x)),
        y: row.y,
        width: Math.max(...sorted.map((item) => item.x + item.width)) - Math.min(...sorted.map((item) => item.x)),
        height: Math.max(...sorted.map((item) => item.height))
      };
    });
}

async function extractDocxText(file) {
  if (!window.mammoth?.extractRawText) {
    throw new Error('DOCX parser is unavailable.');
  }

  const arrayBuffer = await readFileAsArrayBuffer(file);
  const result = await window.mammoth.extractRawText({ arrayBuffer });
  return String(result.value || '').trim();
}

function extractRtfText(rawText) {
  return rawText
    .replace(/\\par[d]?/g, '\n')
    .replace(/\\tab/g, ' ')
    .replace(/\\'[0-9a-fA-F]{2}/g, ' ')
    .replace(/[{}]/g, '')
    .replace(/\\[a-zA-Z]+-?\d* ?/g, '')
    .replace(/\s+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function extractResumeText(file) {
  const name = file.name.toLowerCase();
  const type = file.type.toLowerCase();

  if (type === 'application/pdf' || name.endsWith('.pdf')) {
    return extractPdfText(file);
  }

  if (
    type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    name.endsWith('.docx')
  ) {
    return extractDocxText(file);
  }

  const text = await readFileAsText(file);
  return name.endsWith('.rtf') || type === 'application/rtf' ? extractRtfText(text) : text.trim();
}

async function storeOriginalResume(file) {
  const record = {
    name: file.name,
    type: file.type || 'application/octet-stream',
    size: file.size,
    blob: file,
    text: currentResumeText,
    savedAt: new Date().toISOString()
  };
  await writeResumeRecord(record);
  currentOriginalResume = record;
}

// ---- App state ----

function appendChatMessage(role, text) {
  const bubble = document.createElement('div');
  bubble.className = `chat-message ${role}`;
  bubble.textContent = text;
  chatLog.appendChild(bubble);
  chatLog.scrollTop = chatLog.scrollHeight;
}

async function loadSavedState() {
  currentOriginalResume = await readResumeRecord();
  currentResumeText = currentOriginalResume?.text || '';

  if (currentOriginalResume?.name && currentResumeText) {
    saveState.textContent = `On file: ${currentOriginalResume.name}`;
  } else if (serverHasResume) {
    saveState.textContent = 'Your resume is on file.';
  } else {
    saveState.textContent = 'No resume yet';
  }

  updateDownloadButtons();
  downloadOriginal.disabled = !hasOriginalFile();
  analyzeJob.disabled = !hasResume();
  checkMatch.disabled = !hasResume();
  renderFileCta();
}

async function getActiveJobText() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab found.');

  let response = null;
  try {
    response = await chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_JOB_TEXT' });
  } catch (_error) {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js']
    });
    response = await chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_JOB_TEXT' });
  }

  if (response?.ok !== true) throw new Error(response?.error || 'Could not read this page.');
  return response.job;
}

resumeFile.addEventListener('change', async () => {
  const file = resumeFile.files?.[0];
  if (!file) return;

  setBusy(true);
  saveState.textContent = `Reading ${file.name}...`;

  try {
    const extractedText = await extractResumeText(file);
    if (!extractedText) throw new Error('No readable resume text found.');

    currentResumeText = extractedText;
    await storeOriginalResume(file);
    // Sync the file bytes too, so any signed-in device can re-download the original.
    const fileBuffer = await readFileAsArrayBuffer(file);
    await apiFetch('/api/resume', {
      method: 'POST',
      body: JSON.stringify({
        filename: file.name,
        resumeText: extractedText,
        originalFile: {
          name: file.name,
          mime: file.type || 'application/octet-stream',
          data: arrayBufferToBase64(fileBuffer)
        }
      })
    });

    serverHasResume = true;
    serverHasResumeFile = true;
    currentGeneratedResume = null;
    resumeDraft.value = '';
    chatLog.innerHTML = '';
    currentMatch = { before: null, after: null };
    renderMatch();
    updateDownloadButtons();
    analyzeJob.disabled = false;
    checkMatch.disabled = false;
    generatedState.textContent = 'Resume saved. Open a job page and click Generate.';
    downloadOriginal.disabled = false;
    saveState.textContent = `On file: ${file.name}`;
    renderFileCta();
  } catch (error) {
    saveState.textContent = error.message || 'Could not read file';
  } finally {
    setBusy(false);
  }
});

clearResume.addEventListener('click', async () => {
  try { await apiFetch('/api/resume', { method: 'DELETE' }); } catch (_e) {}
  await deleteResumeRecord();
  currentResumeText = '';
  serverHasResume = false;
  serverHasResumeFile = false;
  currentGeneratedResume = null;
  currentOriginalResume = null;
  resumeDraft.value = '';
  chatLog.innerHTML = '';
  updateDownloadButtons();
  downloadOriginal.disabled = true;
  analyzeJob.disabled = true;
  checkMatch.disabled = true;
  saveState.textContent = 'No resume yet';
  renderFileCta();
  jobState.textContent = 'Open a job listing in this tab, then generate.';
  generatedState.textContent = 'No resume generated yet.';
  upsellPanel.classList.add('hidden');
  resultPanel.classList.add('hidden');
  hideMatchCheck();
  currentMatch = { before: null, after: null };
  renderMatch();
});

checkMatch.addEventListener('click', async () => {
  setBusy(true);
  clearError(jobState);
  progressShow('Reading the job page...', 6);
  progressCrawlTo(18);

  try {
    const job = await getActiveJobText();
    progressShow('Scoring your resume against this job...', 25);
    progressCrawlTo(85);

    const result = await apiFetch('/api/match', {
      method: 'POST',
      body: JSON.stringify({ jobTitle: job.title, jobUrl: job.url, jobText: job.text })
    });

    matchCheckScore.textContent = `${result.match}%`;
    matchCheckVerdict.textContent = result.verdict || '';
    renderChipList(matchedChips, result.matchedKeywords, 'ok');
    renderChipList(missingChips, result.missingKeywords, 'gap');
    matchCheckPanel.classList.remove('hidden');
    jobState.textContent = job.title;
    progressShow('Done', 100);
    progressHide();
  } catch (error) {
    progressHide(0);
    showError(jobState, error.message || 'Could not check the match.');
  } finally {
    setBusy(false);
  }
});

analyzeJob.addEventListener('click', async () => {
  if (!hasResume()) {
    saveState.textContent = 'Upload a resume first';
    return;
  }

  setBusy(true);
  clearError(jobState);
  jobState.textContent = 'Working...';
  progressShow('Reading the job page...', 6);
  progressCrawlTo(18);

  try {
    const job = await getActiveJobText();
    progressShow('AI is tailoring your resume...', 22);
    progressCrawlTo(82);

    const intensity = document.querySelector('input[name="intensity"]:checked')?.value || 'balanced';
    // Send the real checkbox states; the server rejects them for non-Elite plans anyway.
    const result = await apiFetch('/api/generate', {
      method: 'POST',
      body: JSON.stringify({
        jobTitle: job.title,
        jobUrl: job.url,
        jobText: job.text,
        intensity,
        atsMatch: Boolean(atsMatchBox?.checked),
        recruiterMatch: Boolean(recruiterMatchBox?.checked)
      })
    });

    const filename = buildOutputFilename(job.title || extractJobTitle(job.text, job.title));
    const bodyText = stripWatermark(result.text);
    currentGeneratedResume = {
      id: result.generationId,
      text: bodyText,
      filename,
      aiSummary: result.summary
    };
    currentQuota = result.quota;
    renderQuota();
    maybeShowUpsell();
    currentMatch = { before: result.match?.before ?? null, after: result.match?.after ?? null };
    renderMatch();

    hideMatchCheck();
    resultPanel.classList.remove('hidden');
    resumeDraft.value = bodyText;
    chatLog.innerHTML = '';
    updateDownloadButtons();
    jobState.textContent = job.title || 'Resume generated from this job listing';

    // Deliver the finished PDF immediately - no extra click needed.
    progressShow('Building your PDF...', 88);
    generatedState.textContent = 'Building your PDF...';
    const pdfBlob = await buildDesignedPdfBlob(bodyText, watermarkLineForPlan());
    await downloadBlob(pdfBlob, filename);

    progressShow('Done - PDF saved to Downloads', 100);
    progressHide();
    const matchNote = currentMatch.before != null && currentMatch.after != null
      ? ` Match went from ${currentMatch.before}% to ${currentMatch.after}%.`
      : '';
    const refineNote = currentQuota?.features?.refine === false ? '' : ' Refine below and it re-downloads.';
    generatedState.textContent = `PDF saved to your Downloads.${matchNote}${refineNote}`;
  } catch (error) {
    progressHide(0);
    showError(jobState, error.message || 'Unable to tailor this page');
    // A quota error means the free allowance just ran out - refresh so the
    // subscribe panel appears at exactly that moment.
    refreshAccount().catch(() => {});
  } finally {
    setBusy(false);
  }
});

boostMatch.addEventListener('click', async () => {
  if (!currentGeneratedResume) return;

  setBusy(true);
  clearError(generatedState);
  progressShow('Boosting your match...', 8);
  progressCrawlTo(85);

  try {
    const result = await apiFetch('/api/boost', {
      method: 'POST',
      body: JSON.stringify({ generationId: currentGeneratedResume.id })
    });

    const body = stripWatermark(result.text);
    currentGeneratedResume.text = body;
    resumeDraft.value = body;
    updateDownloadButtons();

    const prevAfter = currentMatch.after;
    currentMatch = { before: currentMatch.before, after: result.match?.after ?? currentMatch.after };
    renderMatch();
    if (result.quota) {
      currentQuota = result.quota;
      renderQuota();
    }
    maybeShowUpsell();

    progressShow('Building your PDF...', 90);
    const pdfBlob = await buildDesignedPdfBlob(body, watermarkLineForPlan());
    await downloadBlob(pdfBlob, currentGeneratedResume.filename);

    progressShow('Done - boosted PDF saved', 100);
    progressHide();

    const scoreNote = result.match?.after != null && prevAfter != null && result.match.after !== prevAfter
      ? ` (Job match: ${prevAfter}% -> ${result.match.after}%)`
      : '';
    appendChatMessage('assistant', `${result.summary || 'Boosted the resume.'}${scoreNote} Updated PDF saved to your Downloads.`);
    generatedState.textContent = result.match?.after != null && prevAfter != null && result.match.after > prevAfter
      ? `Boosted from ${prevAfter}% to ${result.match.after}%. PDF saved to your Downloads.`
      : 'Boost applied. PDF saved to your Downloads.';
  } catch (error) {
    progressHide(0);
    showError(generatedState, error.message || 'Could not boost the resume.');
    refreshAccount().catch(() => {});
  } finally {
    setBusy(false);
  }
});

resumeDraft.addEventListener('input', () => {
  if (currentGeneratedResume) {
    currentGeneratedResume.text = getEditedResumeText();
  }
  updateDownloadButtons();
});

async function sendChatRevision() {
  const instruction = chatInput.value.trim();
  if (!instruction || !currentGeneratedResume) return;

  appendChatMessage('user', instruction);
  chatInput.value = '';
  setBusy(true);

  try {
    const result = await apiFetch('/api/revise', {
      method: 'POST',
      body: JSON.stringify({ generationId: currentGeneratedResume.id, instruction })
    });
    const revisedBody = stripWatermark(result.text);
    currentGeneratedResume.text = revisedBody;
    resumeDraft.value = revisedBody;
    updateDownloadButtons();
    if (result.quota) {
      currentQuota = result.quota;
      renderQuota();
    }
    maybeShowUpsell();

    const previousAfter = currentMatch.after;
    currentMatch = { before: result.match?.before ?? currentMatch.before, after: result.match?.after ?? currentMatch.after };
    renderMatch();

    let summaryText = result.summary;
    if (result.match?.after != null && previousAfter != null && result.match.after !== previousAfter) {
      summaryText += ` (Job match: ${previousAfter}% -> ${result.match.after}%)`;
    }

    // Ship the updated PDF right away so the latest version is always the one on disk.
    const revisedPdf = await buildDesignedPdfBlob(revisedBody, watermarkLineForPlan());
    await downloadBlob(revisedPdf, currentGeneratedResume.filename);
    appendChatMessage('assistant', `${summaryText} Updated PDF saved to your Downloads.`);
  } catch (error) {
    appendChatMessage('assistant', error.message || 'Could not apply that change.');
    refreshAccount().catch(() => {});
  } finally {
    setBusy(false);
  }
}

chatSend.addEventListener('click', sendChatRevision);
chatInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') sendChatRevision();
});

downloadPdf.addEventListener('click', async () => {
  const text = getEditedResumeText();
  if (!text) return;

  setBusy(true);
  try {
    const filename = currentGeneratedResume?.filename || 'generated-resume.pdf';
    const blob = await buildDesignedPdfBlob(text, watermarkLineForPlan());
    await downloadBlob(blob, filename.replace(/\.docx$/i, '.pdf'));
    generatedState.textContent = textNeedsUnicodeFont(text)
      ? 'PDF saved to your Downloads. Some non-Latin characters were dropped; use DOCX to keep them.'
      : 'PDF saved to your Downloads.';
  } catch (error) {
    generatedState.textContent = error.message || 'Could not download PDF.';
  } finally {
    setBusy(false);
  }
});

downloadDocx.addEventListener('click', async () => {
  const text = getEditedResumeText();
  if (!text) return;

  setBusy(true);
  try {
    const filename = (currentGeneratedResume?.filename || 'generated-resume.pdf').replace(/\.pdf$/i, '.docx');
    const blob = await buildDocxBlob(text, watermarkLineForPlan());
    await downloadBlob(blob, filename);
    generatedState.textContent = 'DOCX saved to your Downloads.';
  } catch (error) {
    generatedState.textContent = error.message || 'Could not download DOCX.';
  } finally {
    setBusy(false);
  }
});

downloadOriginal.addEventListener('click', async () => {
  clearError(saveState);
  const file = currentOriginalResume || await readResumeRecord();
  if (file?.blob) {
    const url = URL.createObjectURL(file.blob);
    chrome.downloads.download({
      url,
      filename: file.name || 'original-resume',
      saveAs: true
    });
    return;
  }

  if (!serverHasResumeFile) {
    saveState.textContent = 'No original file stored';
    return;
  }

  // No local copy on this device; pull the synced file from the server.
  downloadOriginal.disabled = true;
  try {
    const remote = await apiFetch('/api/resume/file');
    const url = URL.createObjectURL(base64ToBlob(remote.data, remote.mime));
    chrome.downloads.download({
      url,
      filename: remote.name || 'original-resume',
      saveAs: true
    });
  } catch (error) {
    showError(saveState, error.message || 'Could not download the original file.');
  } finally {
    downloadOriginal.disabled = isBusyState || !hasOriginalFile();
  }
});

async function init() {
  currentDeviceId = await getOrCreateDeviceId();
  await loadSavedState();

  try {
    await restoreServerState();
    analyzeJob.disabled = !hasResume();
    checkMatch.disabled = !hasResume();
  } catch (error) {
    // Can't tell if the device is linked, so fall back to the gate and surface
    // the problem on its hint line.
    setSignedInUI(false);
    showError(signinHint, error.message || 'Could not reach the server.');
  }
}

init();
