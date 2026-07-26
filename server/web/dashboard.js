// ResumePilot - signed-in dashboard.
// Served at /dashboard by the same Express server that hosts the API, so every
// fetch below uses a relative path (same origin, no API base to configure).

const SESSION_KEY = 'rt_session';

const navSignInLink = document.querySelector('#navSignInLink');
const navUser = document.querySelector('#navUser');
const userPic = document.querySelector('#userPic');
const userName = document.querySelector('#userName');
const userPlanBadge = document.querySelector('#userPlanBadge');
const signOutButton = document.querySelector('#signOutButton');

const notifBell = document.querySelector('#notifBell');
const notifBellButton = document.querySelector('#notifBellButton');
const notifBadge = document.querySelector('#notifBadge');
const notifPanel = document.querySelector('#notifPanel');
const notifList = document.querySelector('#notifList');

const signedOutCard = document.querySelector('#signedOutCard');
const signInButton = document.querySelector('#signInButton');
const signedInWrap = document.querySelector('#signedInWrap');

const quotaText = document.querySelector('#quotaText');
const quotaFill = document.querySelector('#quotaFill');
const planBadge = document.querySelector('#planBadge');
const upgradeRow = document.querySelector('#upgradeRow');
const upgradeProButton = document.querySelector('#upgradeProButton');
const upgradeEliteButton = document.querySelector('#upgradeEliteButton');
const upgradeProCountdown = document.querySelector('#upgradeProCountdown');
const upgradeEliteCountdown = document.querySelector('#upgradeEliteCountdown');
const upgradeError = document.querySelector('#upgradeError');

const resumeGrid = document.querySelector('#resumeGrid');
const resumeEmpty = document.querySelector('#resumeEmpty');

const resumeModal = document.querySelector('#resumeModal');
const modalTitle = document.querySelector('#modalTitle');
const modalMeta = document.querySelector('#modalMeta');
const modalText = document.querySelector('#modalText');
const modalClose = document.querySelector('#modalClose');
const copyTextBtn = document.querySelector('#copyTextBtn');
const downloadTxtBtn = document.querySelector('#downloadTxtBtn');
const downloadPdfBtn = document.querySelector('#downloadPdfBtn');

const toastEl = document.querySelector('#toast');

let currentResumeDetail = null;
let toastTimer = null;

// ---- Session storage ----

function getToken() {
  try {
    return localStorage.getItem(SESSION_KEY);
  } catch (_e) {
    return null;
  }
}

function setToken(token) {
  try {
    localStorage.setItem(SESSION_KEY, token);
  } catch (_e) {
    // Storage may be unavailable (private browsing) - nothing more we can do.
  }
}

function clearToken() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch (_e) {
    // ignore
  }
}

// Google Sign-In redirects back here with #token=<sessionToken> in the fragment.
// Pull it into localStorage once, then scrub the fragment from the URL bar.
function consumeHashToken() {
  if (!location.hash || !location.hash.includes('token=')) return;
  const params = new URLSearchParams(location.hash.slice(1));
  const token = params.get('token');
  if (token) setToken(token);

  const url = new URL(location.href);
  url.hash = '';
  history.replaceState(null, '', url.toString());
}

function signInUrl() {
  const redirect = `${location.origin}/dashboard`;
  return `/auth/google/start?redirect=${encodeURIComponent(redirect)}`;
}

// ---- Backend API ----

async function apiFetch(path, options = {}) {
  const token = getToken();
  const response = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {})
    }
  });

  if (response.status === 401) {
    clearToken();
    showSignedOut();
    throw new Error('Sign in required.');
  }

  let data = null;
  try {
    data = await response.json();
  } catch (_e) {
    data = null;
  }

  if (!response.ok) {
    throw new Error(data?.error || `Request failed (${response.status}).`);
  }
  return data;
}

// ---- Signed-in / signed-out state ----

function showSignedOut() {
  signedOutCard.classList.remove('hidden');
  signedInWrap.classList.add('hidden');
  navUser.classList.add('hidden');
  navSignInLink.classList.remove('hidden');
  hideModal();
  closeNotifPanel();
  notifications = [];
  renderNotifications();
}

function showSignedIn() {
  signedOutCard.classList.add('hidden');
  signedInWrap.classList.remove('hidden');
  navSignInLink.classList.add('hidden');
  navUser.classList.remove('hidden');
}

// ---- Toast ----

function showToast(message) {
  toastEl.textContent = message;
  toastEl.classList.remove('hidden');
  // Force layout so the transition runs even if a toast is already visible.
  void toastEl.offsetWidth;
  toastEl.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.classList.remove('show');
    setTimeout(() => toastEl.classList.add('hidden'), 200);
  }, 3500);
}

// ---- Formatting helpers ----

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[ch]));
}

function formatDate(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function matchBadgeText(row) {
  if (row.matchAfter == null) return '';
  if (row.matchBefore != null) return `${row.matchAfter}% (up from ${row.matchBefore}%)`;
  return `${row.matchAfter}%`;
}

function makeSafeFilename(value) {
  return String(value || '').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Untitled job';
}

// ---- Account + quota ----

async function loadAccount() {
  try {
    const account = await apiFetch('/account/me');
    renderAccount(account);
  } catch (err) {
    if (getToken()) showToast(err.message || 'Could not load your account.');
  }
}

// Free/Pro/Elite - falls back to the older isPro boolean for any cached
// response that predates the `plan` field.
function planOf(account) {
  return account.plan || (account.isPro ? 'pro' : 'free');
}

function planLabelFor(plan) {
  if (plan === 'elite') return 'Elite';
  if (plan === 'pro') return 'Pro';
  return 'Free';
}

function setPlanBadge(el, plan) {
  el.textContent = planLabelFor(plan);
  el.classList.toggle('pro', plan === 'pro');
  el.classList.toggle('elite', plan === 'elite');
}

function renderAccount(account) {
  userPic.src = account.pictureUrl || '';
  userPic.classList.toggle('hidden', !account.pictureUrl);
  userName.textContent = account.name || account.email || 'Signed in';

  const plan = planOf(account);
  setPlanBadge(userPlanBadge, plan);
  setPlanBadge(planBadge, plan);

  if (account.limit != null) {
    quotaText.textContent = `${account.remaining} of ${account.limit} tailored resumes left this month`;
    const used = account.generationsUsed != null ? account.generationsUsed : account.limit - account.remaining;
    const pct = account.limit > 0 ? Math.min(100, Math.max(0, (used / account.limit) * 100)) : 0;
    quotaFill.style.width = `${pct}%`;
  } else {
    quotaText.textContent = 'Unlimited tailored resumes this month';
    quotaFill.style.width = '100%';
  }

  // free: both upgrade buttons. pro: Elite only. elite: neither, row hidden.
  upgradeProButton.classList.toggle('hidden', plan !== 'free');
  upgradeEliteButton.classList.toggle('hidden', plan === 'elite');
  upgradeRow.classList.toggle('hidden', plan === 'elite');
  updateUpgradeButtonPricing();
}

async function startCheckout(plan, button) {
  button.disabled = true;
  upgradeError.classList.add('hidden');
  try {
    const data = await apiFetch('/account/checkout', { method: 'POST', body: JSON.stringify({ plan }) });
    if (data?.url) {
      window.location = data.url;
      return;
    }
    throw new Error('Billing is not configured yet. Please try again later.');
  } catch (err) {
    upgradeError.textContent = err.message || 'Billing is not configured yet. Please try again later.';
    upgradeError.classList.remove('hidden');
  } finally {
    button.disabled = false;
  }
}

upgradeProButton.addEventListener('click', () => startCheckout('pro', upgradeProButton));
upgradeEliteButton.addEventListener('click', () => startCheckout('elite', upgradeEliteButton));

// ---- Discount offer (upgrade button pricing + compact countdown) ----
// GET /api/offer is public (no device auth) and same-origin, so the
// rp_visitor cookie it sets/reads flows automatically. Discount enforcement
// itself happens server-side at checkout - this only affects what the
// buttons display.

const PLAN_FULL_PRICE = { pro: 19, elite: 29 };
const PLAN_BUTTON_LABEL = { pro: 'Upgrade to Pro', elite: 'Go Elite' };

let currentOffer = null;
let offerCountdownTimer = null;

function formatOfferDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad2 = (n) => (n < 10 ? `0${n}` : String(n));
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`;
}

function updateUpgradeButtonPricing() {
  [
    { plan: 'pro', button: upgradeProButton, countdownEl: upgradeProCountdown },
    { plan: 'elite', button: upgradeEliteButton, countdownEl: upgradeEliteCountdown }
  ].forEach(({ plan, button, countdownEl }) => {
    const fullPrice = PLAN_FULL_PRICE[plan];
    const baseLabel = PLAN_BUTTON_LABEL[plan];
    const planPrice = currentOffer && currentOffer.prices ? currentOffer.prices[plan] : null;

    button.textContent = planPrice
      ? `${baseLabel} - $${planPrice.discounted}/mo (was $${planPrice.full})`
      : `${baseLabel} - $${fullPrice}/mo`;

    const showCountdown = Boolean(planPrice) && currentOffer.type === 'urgency' && currentOffer.expiresAt;
    countdownEl.classList.toggle('hidden', !showCountdown);
    if (!showCountdown) countdownEl.textContent = '';
  });
}

function tickOfferCountdown() {
  if (!currentOffer || currentOffer.type !== 'urgency' || !currentOffer.expiresAt) return;
  const remaining = new Date(currentOffer.expiresAt).getTime() - Date.now();
  if (remaining <= 0) {
    currentOffer = null;
    if (offerCountdownTimer) {
      clearInterval(offerCountdownTimer);
      offerCountdownTimer = null;
    }
    updateUpgradeButtonPricing();
    return;
  }
  const text = `${formatOfferDuration(remaining)} left`;
  [upgradeProCountdown, upgradeEliteCountdown].forEach((el) => {
    if (!el.classList.contains('hidden')) el.textContent = text;
  });
}

async function loadOffer() {
  try {
    const response = await fetch('/api/offer');
    const data = response.ok ? await response.json() : { active: false };
    currentOffer = data && data.active !== false && data.prices ? data : null;
  } catch (_err) {
    currentOffer = null;
  }

  updateUpgradeButtonPricing();
  if (offerCountdownTimer) {
    clearInterval(offerCountdownTimer);
    offerCountdownTimer = null;
  }
  if (currentOffer && currentOffer.type === 'urgency' && currentOffer.expiresAt) {
    tickOfferCountdown();
    offerCountdownTimer = setInterval(tickOfferCountdown, 1000);
  }
}

// ---- Notifications ----

let notifications = [];

function notifIsUnread(notif) {
  return notif.readAt == null && notif.read_at == null;
}

function notifCreatedAt(notif) {
  return notif.createdAt || notif.created_at || '';
}

async function loadNotifications() {
  try {
    const rows = await apiFetch('/account/notifications');
    notifications = Array.isArray(rows) ? rows : [];
    renderNotifications();
  } catch (_err) {
    // Notifications are a non-critical enhancement - fail silently.
  }
}

function renderNotifications() {
  const unreadCount = notifications.filter(notifIsUnread).length;
  notifBadge.classList.toggle('hidden', unreadCount === 0);
  notifBadge.textContent = unreadCount > 99 ? '99+' : String(unreadCount);

  notifList.innerHTML = '';

  if (!notifications.length) {
    const empty = document.createElement('p');
    empty.className = 'notif-empty';
    empty.textContent = 'No notifications';
    notifList.appendChild(empty);
    return;
  }

  notifications
    .slice()
    .sort((a, b) => new Date(notifCreatedAt(b)).getTime() - new Date(notifCreatedAt(a)).getTime())
    .forEach((notif) => notifList.appendChild(renderNotifItem(notif)));
}

function renderNotifItem(notif) {
  const item = document.createElement('button');
  item.type = 'button';
  item.className = `notif-item${notifIsUnread(notif) ? ' unread' : ''}`;
  item.setAttribute('role', 'menuitem');
  item.innerHTML = `
    <p class="notif-item-title">${escapeHtml(notif.title || 'Notification')}</p>
    ${notif.body ? `<p class="notif-item-body">${escapeHtml(notif.body)}</p>` : ''}
    <p class="notif-item-date">${escapeHtml(formatDate(notifCreatedAt(notif)))}</p>
  `;
  item.addEventListener('click', () => markNotificationRead(notif));
  return item;
}

async function markNotificationRead(notif) {
  if (!notifIsUnread(notif)) return;
  const readNow = new Date().toISOString();
  notif.readAt = readNow;
  notif.read_at = readNow;
  renderNotifications();
  try {
    await apiFetch(`/account/notifications/${encodeURIComponent(notif.id)}/read`, { method: 'POST', body: JSON.stringify({}) });
  } catch (_err) {
    // Best effort - local state already reflects "read"; next load resyncs.
  }
}

function closeNotifPanel() {
  notifPanel.classList.add('hidden');
  notifBellButton.setAttribute('aria-expanded', 'false');
}

notifBellButton.addEventListener('click', (event) => {
  event.stopPropagation();
  const opening = notifPanel.classList.contains('hidden');
  notifPanel.classList.toggle('hidden', !opening);
  notifBellButton.setAttribute('aria-expanded', String(opening));
});

document.addEventListener('click', (event) => {
  if (!notifBell.contains(event.target)) closeNotifPanel();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeNotifPanel();
});

// ---- Resume list ----

async function loadResumes() {
  try {
    const rows = await apiFetch('/account/resumes');
    renderResumeList(rows || []);
  } catch (err) {
    if (getToken()) showToast(err.message || 'Could not load your resumes.');
  }
}

function renderResumeList(rows) {
  resumeGrid.innerHTML = '';
  if (!rows.length) {
    resumeEmpty.classList.remove('hidden');
    return;
  }
  resumeEmpty.classList.add('hidden');
  rows.forEach((row) => resumeGrid.appendChild(renderResumeCard(row)));
}

function renderResumeCard(row) {
  const card = document.createElement('div');
  card.className = 'card resume-card';
  card.setAttribute('role', 'button');
  card.setAttribute('tabindex', '0');

  const title = row.jobTitle || 'Untitled job';
  const badge = matchBadgeText(row);
  card.innerHTML = `
    <div class="resume-card-head">
      <h3 class="resume-title">${escapeHtml(title)}</h3>
      ${badge ? `<span class="chip ok">${escapeHtml(badge)}</span>` : ''}
    </div>
    <p class="resume-date">${escapeHtml(formatDate(row.updatedAt))}</p>
  `;

  const open = () => openResumeDetail(row.id);
  card.addEventListener('click', open);
  card.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      open();
    }
  });

  return card;
}

// ---- Resume detail modal ----

function showModal() {
  resumeModal.classList.remove('hidden');
}

function hideModal() {
  resumeModal.classList.add('hidden');
  currentResumeDetail = null;
}

function openResumeDetail(id) {
  showModal();
  modalTitle.textContent = 'Loading...';
  modalMeta.textContent = '';
  modalText.textContent = '';

  apiFetch(`/account/resumes/${encodeURIComponent(id)}`)
    .then((data) => {
      currentResumeDetail = data;
      modalTitle.textContent = data.jobTitle || 'Untitled job';
      const badge = matchBadgeText(data);
      modalMeta.textContent = [formatDate(data.updatedAt), badge].filter(Boolean).join(' · ');
      modalText.textContent = data.text || '';
    })
    .catch((err) => {
      modalTitle.textContent = 'Could not load resume';
      modalMeta.textContent = err.message || '';
    });
}

modalClose.addEventListener('click', hideModal);
resumeModal.addEventListener('click', (event) => {
  if (event.target === resumeModal) hideModal();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !resumeModal.classList.contains('hidden')) hideModal();
});

copyTextBtn.addEventListener('click', async () => {
  if (!currentResumeDetail) return;
  try {
    await navigator.clipboard.writeText(currentResumeDetail.text || '');
    showToast('Copied to clipboard.');
  } catch (_err) {
    showToast('Could not copy - select the text manually.');
  }
});

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

downloadTxtBtn.addEventListener('click', () => {
  if (!currentResumeDetail) return;
  const base = makeSafeFilename(currentResumeDetail.jobTitle || 'Untitled job');
  const blob = new Blob([currentResumeDetail.text || ''], { type: 'text/plain' });
  triggerDownload(blob, `${base} - tailored resume.txt`);
});

downloadPdfBtn.addEventListener('click', async () => {
  if (!currentResumeDetail) return;
  downloadPdfBtn.disabled = true;
  try {
    const blob = await buildTailoredResumePdf(currentResumeDetail.text || '');
    const base = makeSafeFilename(currentResumeDetail.jobTitle || 'Untitled job');
    triggerDownload(blob, `${base} - tailored resume.pdf`);
  } catch (err) {
    showToast(err.message || 'Could not build the PDF.');
  } finally {
    downloadPdfBtn.disabled = false;
  }
});

// ---- PDF generation (pdf-lib, loaded from unpkg) ----
// Mirrors the extension popup's designed PDF layout: bold accent name line,
// section headings with a thin rule, hanging-indent bullets, WinAnsi-safe text.

function isSectionHeading(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > 48) return false;
  return /^[A-Z][A-Z\s/&+-]{2,}$/.test(trimmed) ||
    /^(summary|profile|objective|skills|technical skills|core skills|experience|work experience|professional experience|education|projects)$/i.test(trimmed);
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
  // Standard PDF fonts only encode WinAnsi (Latin-1); anything wider is stripped.
  return normalizeResumeText(value).replace(/[^\x09\x0A\x0D\x20-\x7E¡-ÿ]/g, '');
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
  return lines.length ? lines : [''];
}

async function buildTailoredResumePdf(text) {
  const { PDFDocument, StandardFonts, rgb } = window.PDFLib;
  const pdfDoc = await PDFDocument.create();
  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const italic = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);

  const pageWidth = 612;
  const pageHeight = 792;
  const margin = 40;
  const accent = rgb(0.08, 0.4, 0.37);
  const muted = rgb(0.31, 0.35, 0.36);
  const ink = rgb(0.09, 0.1, 0.1);

  let page = pdfDoc.addPage([pageWidth, pageHeight]);
  let y = pageHeight - margin;

  function addPage() {
    page = pdfDoc.addPage([pageWidth, pageHeight]);
    y = pageHeight - margin;
  }

  function ensureSpace(height) {
    if (y - height < margin) addPage();
  }

  function drawTextLine(value, x, options = {}) {
    const font = options.font || regular;
    const size = options.size || 9.7;
    const color = options.color || ink;
    page.drawText(sanitizePdfDrawText(value), { x, y, size, font, color });
    y -= options.lineHeight || size + 2.8;
  }

  function drawWrapped(value, x, width, options = {}) {
    const font = options.font || regular;
    const size = options.size || 9.7;
    const lineHeight = options.lineHeight || 12.4;
    const lines = wrapPdfTextByWidth(value, font, size, width);
    ensureSpace(Math.max(lineHeight, lines.length * lineHeight));
    lines.forEach((line) => drawTextLine(line, x, { ...options, font, size, lineHeight }));
  }

  const { headerLines, blocks } = parseResumeBlocks(text);
  const name = headerLines[0] || 'Resume';
  const subtitle = headerLines[1] || '';
  const contact = headerLines.slice(2).join(' | ');

  drawTextLine(name, margin, { font: bold, size: 19, color: accent, lineHeight: 22 });
  if (subtitle) drawTextLine(subtitle, margin, { font: regular, size: 10.8, color: muted, lineHeight: 13.5 });
  if (contact) drawWrapped(contact, margin, pageWidth - margin * 2, { font: regular, size: 9, color: muted, lineHeight: 11.2 });

  page.drawLine({
    start: { x: margin, y: y - 2 },
    end: { x: pageWidth - margin, y: y - 2 },
    thickness: 1.1,
    color: accent
  });
  y -= 14;

  blocks.forEach((block) => {
    ensureSpace(38);
    page.drawText(block.heading.toUpperCase(), { x: margin, y, size: 9.5, font: bold, color: accent });
    page.drawLine({
      start: { x: margin, y: y - 3.5 },
      end: { x: pageWidth - margin, y: y - 3.5 },
      thickness: 0.5,
      color: rgb(0.76, 0.82, 0.8)
    });
    y -= 14;

    block.items.forEach((item) => {
      const bulletMatch = item.match(/^[-*•●]\s*(.+)$/);
      const isRoleLine = !bulletMatch && /^[A-Z][A-Z\s,&./'-]+(?:\d{4}|PRESENT|CURRENT|REMOTE|VA|DC|NY|CA)/i.test(item);

      if (bulletMatch) {
        ensureSpace(14);
        page.drawText('-', { x: margin + 8, y, size: 9.8, font: bold, color: accent });
        drawWrapped(bulletMatch[1], margin + 20, pageWidth - margin * 2 - 20, { font: regular, size: 9.6, color: ink, lineHeight: 12.2 });
      } else if (isRoleLine) {
        y -= 2.5;
        drawWrapped(item, margin, pageWidth - margin * 2, { font: bold, size: 9.9, color: ink, lineHeight: 12.2 });
      } else {
        drawWrapped(item, margin, pageWidth - margin * 2, { font: regular, size: 9.7, color: ink, lineHeight: 12.4 });
      }
    });
    y -= 7;
  });

  const pageCount = pdfDoc.getPageCount();
  if (pageCount > 1) {
    pdfDoc.getPages().forEach((pdfPage, index) => {
      pdfPage.drawText(`${index + 1} / ${pageCount}`, {
        x: pageWidth - margin - 24,
        y: 22,
        size: 8,
        font: italic,
        color: muted
      });
    });
  }

  const bytes = await pdfDoc.save();
  return new Blob([bytes], { type: 'application/pdf' });
}

// ---- Sign in / sign out ----

navSignInLink.addEventListener('click', (event) => {
  event.preventDefault();
  window.location.href = signInUrl();
});

signInButton.addEventListener('click', () => {
  window.location.href = signInUrl();
});

signOutButton.addEventListener('click', () => {
  clearToken();
  window.location.reload();
});

// ---- Upgrade success toast (?upgraded=1) ----

function maybeShowUpgradeToast() {
  const params = new URLSearchParams(location.search);
  if (params.get('upgraded') !== '1') return;

  showToast('Your plan has been upgraded!');
  params.delete('upgraded');
  const query = params.toString();
  history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}`);
  loadAccount();
}

// ---- Boot ----

consumeHashToken();

if (getToken()) {
  showSignedIn();
  loadAccount();
  loadResumes();
  loadNotifications();
} else {
  showSignedOut();
}

loadOffer();
maybeShowUpgradeToast();
