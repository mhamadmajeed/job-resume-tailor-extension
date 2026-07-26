import express from 'express';
import { db } from './db.js';

// ---- Markdown-lite: escape first, then support a small safe subset. ----

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Runs on already-escaped text, so the only special characters left to interpret
// are the markdown-lite ones themselves ([]()  ** *).
function renderInline(escapedText) {
  let out = escapedText.replace(/\[([^\]]+)\]\((https:\/\/[^\s)]+)\)/g, (match, label, url) => {
    return `<a href="${url}" target="_blank" rel="noopener">${label}</a>`;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  return out;
}

export function renderMarkdownLite(rawContent) {
  const escaped = escapeHtml(rawContent);
  const lines = escaped.split('\n');
  const blocks = [];

  let listItems = [];
  let paragraphLines = [];

  function flushList() {
    if (!listItems.length) return;
    blocks.push(`<ul>${listItems.map((item) => `<li>${renderInline(item)}</li>`).join('')}</ul>`);
    listItems = [];
  }

  function flushParagraph() {
    if (!paragraphLines.length) return;
    blocks.push(`<p>${renderInline(paragraphLines.join(' '))}</p>`);
    paragraphLines = [];
  }

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed) {
      flushParagraph();
      flushList();
      continue;
    }

    if (trimmed.startsWith('## ')) {
      flushParagraph();
      flushList();
      blocks.push(`<h2>${renderInline(trimmed.slice(3).trim())}</h2>`);
      continue;
    }

    if (trimmed.startsWith('- ')) {
      flushParagraph();
      listItems.push(trimmed.slice(2).trim());
      continue;
    }

    flushList();
    paragraphLines.push(trimmed);
  }

  flushParagraph();
  flushList();

  return blocks.join('\n');
}

export function toSlug(title) {
  const slug = String(title || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || 'post';
}

// ---- Page shell (shared nav + site.css) ----

function pageShell({ title, description, bodyHtml }) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    ${description ? `<meta name="description" content="${escapeHtml(description)}">` : ''}
    <link rel="stylesheet" href="/site.css">
  </head>
  <body>
    <header class="site-header">
      <div class="container nav">
        <a class="brand" href="/">
          <span class="logo" aria-hidden="true">RP</span>
          <span class="wordmark">ResumePilot</span>
        </a>
        <nav class="nav-links" aria-label="Primary">
          <a href="/">Home</a>
          <a href="/#pricing">Pricing</a>
          <a href="/dashboard">Dashboard</a>
        </nav>
      </div>
    </header>
    <main>
      <div class="container section">
        ${bodyHtml}
      </div>
    </main>
  </body>
</html>`;
}

function formatDate(isoString) {
  if (!isoString) return '';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

function blogListPage(posts) {
  const items = posts.map((post) => `
    <article class="card" style="padding:24px 28px;margin-bottom:16px;">
      <h2 style="font-size:20px;margin-bottom:8px;"><a href="/blog/${encodeURIComponent(post.slug)}">${escapeHtml(post.title)}</a></h2>
      <p class="muted" style="margin-bottom:8px;">${formatDate(post.published_at)}</p>
      <p class="muted">${escapeHtml(post.excerpt || '')}</p>
    </article>`).join('');

  return pageShell({
    title: 'Blog - ResumePilot',
    description: 'Resume writing and job search advice from ResumePilot.',
    bodyHtml: `
      <div class="section-head" style="text-align:left;max-width:none;margin-bottom:32px;">
        <h2>Blog</h2>
      </div>
      ${items || '<p class="muted">No posts yet - check back soon.</p>'}`
  });
}

function blogArticlePage(post) {
  return pageShell({
    title: `${post.title} - ResumePilot Blog`,
    description: post.excerpt || '',
    bodyHtml: `
      <div style="max-width:720px;margin:0 auto;">
        <a href="/blog" class="muted" style="text-decoration:none;font-size:14px;">&larr; Back to blog</a>
        <h1 style="font-size:32px;font-weight:800;margin:16px 0 8px;">${escapeHtml(post.title)}</h1>
        <p class="muted" style="margin-bottom:28px;">${formatDate(post.published_at)}</p>
        <div class="blog-content">${renderMarkdownLite(post.content)}</div>
      </div>`
  });
}

function blogNotFoundPage() {
  return pageShell({
    title: 'Post not found - ResumePilot Blog',
    bodyHtml: `
      <div style="max-width:720px;margin:0 auto;text-align:center;">
        <h2>Post not found</h2>
        <p class="muted" style="margin:12px 0 20px;">This post does not exist or has not been published yet.</p>
        <a class="btn primary" href="/blog">Back to blog</a>
      </div>`
  });
}

// ---- Router: public, read-only, published posts only ----

export const blogRouter = express.Router();

blogRouter.get('/', (req, res) => {
  const posts = db.prepare("SELECT * FROM blog_posts WHERE status = 'published' ORDER BY published_at DESC").all();
  res.type('html').send(blogListPage(posts));
});

blogRouter.get('/:slug', (req, res) => {
  const post = db.prepare("SELECT * FROM blog_posts WHERE slug = ? AND status = 'published'").get(req.params.slug);
  if (!post) return res.status(404).type('html').send(blogNotFoundPage());
  res.type('html').send(blogArticlePage(post));
});
