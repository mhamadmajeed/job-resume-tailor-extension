const resumeFile = document.querySelector('#resumeFile');
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
const upgradeButton = document.querySelector('#upgradeButton');
const chatLog = document.querySelector('#chatLog');
const chatInput = document.querySelector('#chatInput');
const chatSend = document.querySelector('#chatSend');

let currentResumeText = '';
let currentGeneratedResume = null;
let currentOriginalResume = null;
let currentDeviceId = '';
let currentQuota = null;
let pollTimer = null;

// No accounts: a random id is generated once per browser install and sent on every
// request so the backend can track free-tier usage and Stripe subscription status.
async function getOrCreateDeviceId() {
  const stored = await chrome.storage.local.get(['deviceId']);
  if (stored.deviceId) return stored.deviceId;
  const deviceId = crypto.randomUUID();
  await chrome.storage.local.set({ deviceId });
  return deviceId;
}

function setBusy(isBusy) {
  analyzeJob.disabled = isBusy || !currentResumeText;
  clearResume.disabled = isBusy;
  downloadOriginal.disabled = isBusy || !currentOriginalResume;
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
  quotaState.textContent = isPro
    ? `Pro plan active - no watermark. ${currentQuota.generationsUsed} generated so far.`
    : `Free plan - resumes include a watermark. ${currentQuota.generationsUsed} generated so far.`;
  upgradeButton.textContent = isPro ? 'Manage subscription' : 'Upgrade to Pro ($29/mo, remove watermark)';
}

async function refreshAccount() {
  const me = await apiFetch('/api/me');
  currentQuota = me;
  renderQuota();
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

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

async function buildDesignedPdfBlob(text) {
  if (!window.PDFLib) return buildPdfBlob(text);

  const { PDFDocument, StandardFonts, rgb } = window.PDFLib;
  const pdfDoc = await PDFDocument.create();
  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const italic = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);
  const pageWidth = 612;
  const pageHeight = 792;
  const marginX = 44;
  const topMargin = 42;
  const bottomMargin = 42;
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
    const size = options.size || 10.5;
    const color = options.color || ink;
    page.drawText(sanitizePdfDrawText(value), { x, y, size, font, color });
    y -= options.lineHeight || size + 3.5;
  }

  function drawWrapped(value, x, width, options = {}) {
    const font = options.font || regular;
    const size = options.size || 10.5;
    const lineHeight = options.lineHeight || 14;
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

  drawTextLine(name, marginX, { font: bold, size: 22, color: accent, lineHeight: 25 });
  if (subtitle) drawTextLine(subtitle, marginX, { font: regular, size: 11.5, color: muted, lineHeight: 15 });
  if (contact) drawWrapped(contact, marginX, pageWidth - marginX * 2, { font: regular, size: 9.5, color: muted, lineHeight: 12 });
  page.drawLine({
    start: { x: marginX, y: y - 3 },
    end: { x: pageWidth - marginX, y: y - 3 },
    thickness: 1.2,
    color: accent
  });
  y -= 18;

  blocks.forEach((block) => {
    ensureSpace(42);
    const heading = block.heading.toUpperCase();
    page.drawText(heading, { x: marginX, y, size: 10.5, font: bold, color: accent });
    page.drawLine({
      start: { x: marginX, y: y - 4 },
      end: { x: pageWidth - marginX, y: y - 4 },
      thickness: 0.6,
      color: rgb(0.72, 0.78, 0.76)
    });
    y -= 17;

    block.items.forEach((item) => {
      const bulletMatch = item.match(/^[-*•●]\s*(.+)$/);
      const isRoleLine = !bulletMatch && /^[A-Z][A-Z\s,&./'-]+(?:\d{4}|PRESENT|CURRENT|REMOTE|VA|DC|NY|CA)/i.test(item);

      if (bulletMatch) {
        ensureSpace(16);
        page.drawText('-', { x: marginX + 10, y, size: 10.5, font: bold, color: accent });
        drawWrapped(bulletMatch[1], marginX + 24, pageWidth - marginX * 2 - 24, { font: regular, size: 10, color: ink, lineHeight: 13 });
      } else if (isRoleLine) {
        y -= 2;
        drawWrapped(item, marginX, pageWidth - marginX * 2, { font: bold, size: 10.3, color: ink, lineHeight: 13 });
      } else {
        drawWrapped(item, marginX, pageWidth - marginX * 2, { font: regular, size: 10.2, color: ink, lineHeight: 13.5 });
      }
    });
    y -= 8;
  });

  const pageCount = pdfDoc.getPageCount();
  pdfDoc.getPages().forEach((pdfPage, index) => {
    pdfPage.drawText(`${index + 1} / ${pageCount}`, {
      x: pageWidth - marginX - 28,
      y: 24,
      size: 8,
      font: italic,
      color: muted
    });
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

async function buildDocxBlob(text) {
  if (!window.docx) {
    throw new Error('DOCX generator is unavailable.');
  }

  const docxLib = window.docx;
  const lines = text.split(/\n/);
  const doc = new docxLib.Document({
    sections: [
      {
        properties: {
          page: {
            margin: { top: 720, right: 720, bottom: 720, left: 720 }
          }
        },
        children: lines.map((line, index) => makeDocxParagraph(line, index))
      }
    ]
  });

  return docxLib.Packer.toBlob(doc);
}

async function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  await new Promise((resolve, reject) => {
    chrome.downloads.download({ url, filename, saveAs: true }, (downloadId) => {
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
    saveState.textContent = `Stored in extension: ${currentOriginalResume.name}`;
  } else {
    saveState.textContent = 'No resume stored';
  }

  generatedState.textContent = 'No resume generated yet.';
  resumeDraft.value = '';
  chatLog.innerHTML = '';
  updateDownloadButtons();
  downloadOriginal.disabled = !currentOriginalResume;
  analyzeJob.disabled = !currentResumeText;
}

async function getActiveJobText() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab found.');

  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_JOB_TEXT' });
    if (response?.ok) return response.job;
  } catch (_error) {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js']
    });
  }

  const response = await chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_JOB_TEXT' });
  if (!response?.ok) throw new Error('Could not read this page.');
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
    await apiFetch('/api/resume', {
      method: 'POST',
      body: JSON.stringify({ filename: file.name, resumeText: extractedText })
    });

    currentGeneratedResume = null;
    resumeDraft.value = '';
    chatLog.innerHTML = '';
    updateDownloadButtons();
    analyzeJob.disabled = false;
    generatedState.textContent = 'Resume saved. Open a job page and generate a new resume.';
    downloadOriginal.disabled = false;
    saveState.textContent = `Stored in extension: ${file.name}`;
  } catch (error) {
    saveState.textContent = error.message || 'Could not read file';
  } finally {
    setBusy(false);
  }
});

clearResume.addEventListener('click', async () => {
  await deleteResumeRecord();
  currentResumeText = '';
  currentGeneratedResume = null;
  currentOriginalResume = null;
  resumeDraft.value = '';
  chatLog.innerHTML = '';
  updateDownloadButtons();
  downloadOriginal.disabled = true;
  analyzeJob.disabled = true;
  saveState.textContent = 'No resume stored';
  jobState.textContent = 'Upload once, open a job page, then generate.';
  generatedState.textContent = 'No resume generated yet.';
});

analyzeJob.addEventListener('click', async () => {
  const resume = currentResumeText.trim();
  if (!resume) {
    saveState.textContent = 'Upload a resume first';
    return;
  }

  setBusy(true);
  jobState.textContent = 'Reading page...';

  try {
    const job = await getActiveJobText();
    jobState.textContent = 'Generating your tailored resume...';

    const result = await apiFetch('/api/generate', {
      method: 'POST',
      body: JSON.stringify({ jobTitle: job.title, jobUrl: job.url, jobText: job.text })
    });

    const filename = `${makeSafeFilename(extractJobTitle(job.text, job.title))}-matched-resume.pdf`;
    currentGeneratedResume = {
      id: result.generationId,
      text: result.text,
      filename,
      aiSummary: result.summary
    };
    currentQuota = result.quota;
    renderQuota();

    resumeDraft.value = result.text;
    chatLog.innerHTML = '';
    updateDownloadButtons();
    jobState.textContent = job.title || 'Resume generated from this job listing';
    generatedState.textContent = 'Generated. Review, refine with chat, then download.';
  } catch (error) {
    jobState.textContent = error.message || 'Unable to tailor this page';
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
    currentGeneratedResume.text = result.text;
    resumeDraft.value = result.text;
    updateDownloadButtons();
    appendChatMessage('assistant', result.summary);
  } catch (error) {
    appendChatMessage('assistant', error.message || 'Could not apply that change.');
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
    const blob = await buildDesignedPdfBlob(text);
    await downloadBlob(blob, filename.replace(/\.docx$/i, '.pdf'));
    generatedState.textContent = textNeedsUnicodeFont(text)
      ? 'PDF downloaded. Some non-Latin characters were dropped; use DOCX to keep them.'
      : 'PDF downloaded.';
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
    const blob = await buildDocxBlob(text);
    await downloadBlob(blob, filename);
    generatedState.textContent = 'DOCX downloaded.';
  } catch (error) {
    generatedState.textContent = error.message || 'Could not download DOCX.';
  } finally {
    setBusy(false);
  }
});

downloadOriginal.addEventListener('click', async () => {
  const file = currentOriginalResume || await readResumeRecord();
  if (!file?.blob) {
    saveState.textContent = 'No original file stored';
    return;
  }

  const url = URL.createObjectURL(file.blob);
  chrome.downloads.download({
    url,
    filename: file.name || 'original-resume',
    saveAs: true
  });
});

async function init() {
  currentDeviceId = await getOrCreateDeviceId();

  try {
    await refreshAccount();
  } catch (error) {
    quotaState.textContent = error.message || 'Could not reach the server.';
  }

  await loadSavedState();
}

init();
