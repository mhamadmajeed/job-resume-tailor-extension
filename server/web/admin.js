// ResumePilot - admin panel.
// Served at /admin by the same Express server that hosts the API, so every
// fetch below uses a relative path (same origin, no API base to configure).

const SESSION_KEY = 'rt_session';

const ROLE_TABS = {
  owner: ['members', 'broadcast', 'blog', 'discounts', 'plans', 'admins'],
  moderator: ['members', 'broadcast', 'blog'],
  writer: ['blog']
};

const navSignInLink = document.querySelector('#navSignInLink');
const navUser = document.querySelector('#navUser');
const userPic = document.querySelector('#userPic');
const userName = document.querySelector('#userName');
const userRoleBadge = document.querySelector('#userRoleBadge');
const signOutButton = document.querySelector('#signOutButton');

const signedOutCard = document.querySelector('#signedOutCard');
const signInButton = document.querySelector('#signInButton');
const deniedCard = document.querySelector('#deniedCard');
const deniedText = document.querySelector('#deniedText');
const adminWrap = document.querySelector('#adminWrap');
const roleLine = document.querySelector('#roleLine');
const tabBar = document.querySelector('#tabBar');

const toastEl = document.querySelector('#toast');

let currentAdmin = null; // { role, email, name }
let members = [];
let posts = [];
let discounts = [];
let plans = [];
let creditCosts = null;
let admins = [];
let editingPostId = null;
let slugTouched = false;
let editingDiscountId = null;
let notifyTarget = null; // { id, email }
let emailTarget = null; // { id, email }
let deleteTarget = null; // { id, email }
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
  const redirect = `${location.origin}/admin`;
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
    throw new Error((data && data.error) || `Request failed (${response.status}).`);
  }
  return data;
}

// ---- Top-level view state ----

function showSignedOut() {
  signedOutCard.classList.remove('hidden');
  deniedCard.classList.add('hidden');
  adminWrap.classList.add('hidden');
  navUser.classList.add('hidden');
  navSignInLink.classList.remove('hidden');
}

function showDenied(message) {
  signedOutCard.classList.add('hidden');
  deniedCard.classList.remove('hidden');
  adminWrap.classList.add('hidden');
  deniedText.textContent = message || 'This account does not have admin access.';
}

function showAdmin() {
  signedOutCard.classList.add('hidden');
  deniedCard.classList.add('hidden');
  adminWrap.classList.remove('hidden');
}

// ---- Toast ----

function showToast(message) {
  toastEl.textContent = message;
  toastEl.classList.remove('hidden');
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

function kebabCase(value) {
  return String(value || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function pick(obj, ...keys) {
  for (const key of keys) {
    if (obj && obj[key] != null) return obj[key];
  }
  return null;
}

// ---- Modal helpers ----

function openModal(id) {
  document.querySelector(`#${id}`).classList.remove('hidden');
}

function closeModal(id) {
  document.querySelector(`#${id}`).classList.add('hidden');
}

document.querySelectorAll('.js-close-modal').forEach((btn) => {
  btn.addEventListener('click', () => closeModal(btn.dataset.modal));
});

document.querySelectorAll('.modal-overlay').forEach((overlay) => {
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) overlay.classList.add('hidden');
  });
});

// ---- Tabs ----

function setActiveTab(tab) {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  document.querySelectorAll('.tab-panel').forEach((panel) => {
    panel.classList.toggle('active', panel.dataset.panel === tab);
  });
}

function setupTabsForRole(role) {
  const allowed = ROLE_TABS[role] || [];
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.classList.toggle('hidden', !allowed.includes(btn.dataset.tab));
  });
  tabBar.classList.toggle('hidden', allowed.length <= 1);
  setActiveTab(allowed[0] || 'members');
}

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.classList.contains('hidden')) return;
    setActiveTab(btn.dataset.tab);
    if (btn.dataset.tab === 'members' && !members.length) loadMembers();
    if (btn.dataset.tab === 'blog' && !posts.length) loadPosts();
    if (btn.dataset.tab === 'discounts' && !discounts.length) loadDiscounts();
    if (btn.dataset.tab === 'plans' && !plans.length) loadPlans();
    if (btn.dataset.tab === 'plans' && !creditCosts) loadCreditCosts();
    if (btn.dataset.tab === 'admins' && !admins.length) loadAdmins();
  });
});

// ---- Members tab ----

async function loadMembers() {
  try {
    const rows = await apiFetch('/admin/members');
    members = rows || [];
    renderMembers();
  } catch (err) {
    showToast(err.message || 'Could not load members.');
  }
}

function renderMembers() {
  const query = (document.querySelector('#memberSearch').value || '').trim().toLowerCase();
  const rows = query
    ? members.filter((m) => (m.email || '').toLowerCase().includes(query) || (m.name || '').toLowerCase().includes(query))
    : members;

  const tbody = document.querySelector('#membersBody');
  tbody.innerHTML = '';
  document.querySelector('#membersEmpty').classList.toggle('hidden', rows.length > 0);

  rows.forEach((row) => tbody.appendChild(renderMemberRow(row)));
}

function renderMemberRow(row) {
  const tr = document.createElement('tr');
  const isOwner = currentAdmin.role === 'owner';
  const isModerator = currentAdmin.role === 'moderator';
  const status = row.status || 'active';
  const usage = row.limit != null ? `${row.generationsUsed != null ? row.generationsUsed : 0} / ${row.limit}` : '-';

  tr.innerHTML = `
    <td>${escapeHtml(row.email)}</td>
    <td>${escapeHtml(row.name || '-')}</td>
    <td class="plan-cell"></td>
    <td class="status-cell"></td>
    <td class="cell-muted">${escapeHtml(usage)}</td>
    <td class="cell-muted">${escapeHtml(row.resumeCount != null ? row.resumeCount : 0)}</td>
    <td class="cell-muted">${escapeHtml(formatDate(row.createdAt))}</td>
    <td class="cell-muted">${escapeHtml(formatDate(row.lastActiveAt) || 'Never')}</td>
    <td class="cell-actions"></td>
  `;

  // Plan cell
  const planCell = tr.querySelector('.plan-cell');
  if (isOwner) {
    const select = document.createElement('select');
    select.className = 'plan-select';
    ['free', 'pro', 'elite'].forEach((plan) => {
      const opt = document.createElement('option');
      opt.value = plan;
      opt.textContent = plan.charAt(0).toUpperCase() + plan.slice(1);
      if (row.plan === plan) opt.selected = true;
      select.appendChild(opt);
    });
    select.addEventListener('change', () => changeMemberPlan(row, select));
    planCell.appendChild(select);
  } else {
    planCell.textContent = row.plan ? row.plan.charAt(0).toUpperCase() + row.plan.slice(1) : 'Free';
  }

  // Status cell
  const statusCell = tr.querySelector('.status-cell');
  const pill = document.createElement('span');
  pill.className = `status-pill ${status}`;
  pill.textContent = status === 'paused' ? 'Paused' : 'Active';
  statusCell.appendChild(pill);
  if (isOwner || isModerator) {
    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'btn ghost small';
    toggleBtn.style.marginLeft = '8px';
    toggleBtn.textContent = status === 'paused' ? 'Activate' : 'Pause';
    toggleBtn.addEventListener('click', () => toggleMemberStatus(row, toggleBtn));
    statusCell.appendChild(toggleBtn);
  }

  // Actions
  const actions = tr.querySelector('.cell-actions');
  const notifyBtn = document.createElement('button');
  notifyBtn.type = 'button';
  notifyBtn.className = 'btn ghost small';
  notifyBtn.textContent = 'Notify';
  notifyBtn.addEventListener('click', () => openNotifyModal(row));
  actions.appendChild(notifyBtn);

  const emailBtn = document.createElement('button');
  emailBtn.type = 'button';
  emailBtn.className = 'btn ghost small';
  emailBtn.textContent = 'Email';
  emailBtn.addEventListener('click', () => openEmailModal(row));
  actions.appendChild(emailBtn);

  if (isOwner) {
    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'btn ghost small';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', () => openDeleteModal(row));
    actions.appendChild(deleteBtn);
  }

  return tr;
}

async function changeMemberPlan(row, select) {
  const previous = row.plan;
  const next = select.value;
  select.disabled = true;
  try {
    await apiFetch(`/admin/members/${encodeURIComponent(row.accountId)}/plan`, {
      method: 'POST',
      body: JSON.stringify({ plan: next })
    });
    row.plan = next;
    showToast(`Plan updated to ${next}.`);
  } catch (err) {
    select.value = previous;
    showToast(err.message || 'Could not update plan.');
  } finally {
    select.disabled = false;
  }
}

async function toggleMemberStatus(row, button) {
  const next = row.status === 'paused' ? 'active' : 'paused';
  button.disabled = true;
  try {
    await apiFetch(`/admin/members/${encodeURIComponent(row.accountId)}/status`, {
      method: 'POST',
      body: JSON.stringify({ status: next })
    });
    row.status = next;
    renderMembers();
    showToast(next === 'paused' ? 'Account paused.' : 'Account activated.');
  } catch (err) {
    showToast(err.message || 'Could not update status.');
  } finally {
    button.disabled = false;
  }
}

document.querySelector('#memberSearch').addEventListener('input', renderMembers);
document.querySelector('#refreshMembers').addEventListener('click', loadMembers);

// ---- Notify modal ----

function openNotifyModal(row) {
  notifyTarget = { id: row.accountId, email: row.email };
  document.querySelector('#notifySub').textContent = `To: ${row.email}`;
  document.querySelector('#notifyTitle').value = '';
  document.querySelector('#notifyBody').value = '';
  openModal('notifyModal');
}

document.querySelector('#sendNotifyButton').addEventListener('click', async () => {
  if (!notifyTarget) return;
  const title = document.querySelector('#notifyTitle').value.trim();
  const body = document.querySelector('#notifyBody').value.trim();
  if (!title) {
    showToast('Add a title first.');
    return;
  }
  const btn = document.querySelector('#sendNotifyButton');
  btn.disabled = true;
  try {
    await apiFetch(`/admin/members/${encodeURIComponent(notifyTarget.id)}/notify`, {
      method: 'POST',
      body: JSON.stringify({ title, body })
    });
    showToast('Notification sent.');
    closeModal('notifyModal');
  } catch (err) {
    showToast(err.message || 'Could not send notification.');
  } finally {
    btn.disabled = false;
  }
});

// ---- Email modal ----

function openEmailModal(row) {
  emailTarget = { id: row.accountId, email: row.email };
  document.querySelector('#emailSub').textContent = `To: ${row.email}`;
  document.querySelector('#emailSubject').value = '';
  document.querySelector('#emailBody').value = '';
  openModal('emailModal');
}

document.querySelector('#sendEmailButton').addEventListener('click', async () => {
  if (!emailTarget) return;
  const subject = document.querySelector('#emailSubject').value.trim();
  const body = document.querySelector('#emailBody').value.trim();
  if (!subject) {
    showToast('Add a subject first.');
    return;
  }
  const btn = document.querySelector('#sendEmailButton');
  btn.disabled = true;
  try {
    const result = await apiFetch(`/admin/members/${encodeURIComponent(emailTarget.id)}/email`, {
      method: 'POST',
      body: JSON.stringify({ subject, body })
    });
    if (result && result.sent) {
      showToast('Email sent.');
    } else {
      showToast((result && result.reason) || 'Email service is not configured yet.');
    }
    closeModal('emailModal');
  } catch (err) {
    showToast(err.message || 'Could not send email.');
  } finally {
    btn.disabled = false;
  }
});

// ---- Delete member modal ----

function openDeleteModal(row) {
  deleteTarget = { id: row.accountId, email: row.email };
  document.querySelector('#deleteConfirmLabel').textContent = `Type "${row.email}" to confirm`;
  document.querySelector('#deleteConfirmInput').value = '';
  document.querySelector('#confirmDeleteButton').disabled = true;
  openModal('deleteModal');
}

document.querySelector('#deleteConfirmInput').addEventListener('input', (event) => {
  const match = deleteTarget && event.target.value.trim() === deleteTarget.email;
  document.querySelector('#confirmDeleteButton').disabled = !match;
});

document.querySelector('#confirmDeleteButton').addEventListener('click', async () => {
  if (!deleteTarget) return;
  const btn = document.querySelector('#confirmDeleteButton');
  btn.disabled = true;
  try {
    await apiFetch(`/admin/members/${encodeURIComponent(deleteTarget.id)}`, { method: 'DELETE' });
    members = members.filter((m) => m.accountId !== deleteTarget.id);
    renderMembers();
    showToast('Account deleted.');
    closeModal('deleteModal');
  } catch (err) {
    showToast(err.message || 'Could not delete account.');
    btn.disabled = false;
  }
});

// ---- Broadcast tab ----

document.querySelector('#sendBroadcast').addEventListener('click', async () => {
  const title = document.querySelector('#broadcastTitle').value.trim();
  const body = document.querySelector('#broadcastBody').value.trim();
  const resultEl = document.querySelector('#broadcastResult');
  if (!title) {
    showToast('Add a title first.');
    return;
  }
  const btn = document.querySelector('#sendBroadcast');
  btn.disabled = true;
  resultEl.classList.add('hidden');
  try {
    const data = await apiFetch('/admin/broadcast', {
      method: 'POST',
      body: JSON.stringify({ title, body })
    });
    const count = pick(data, 'notified', 'count', 'sent', 'total');
    resultEl.textContent = count != null
      ? `Broadcast sent to ${count} account${count === 1 ? '' : 's'}.`
      : 'Broadcast sent.';
    resultEl.classList.remove('error');
    resultEl.classList.remove('hidden');
    document.querySelector('#broadcastTitle').value = '';
    document.querySelector('#broadcastBody').value = '';
    showToast('Broadcast sent.');
  } catch (err) {
    resultEl.textContent = err.message || 'Could not send broadcast.';
    resultEl.classList.add('error');
    resultEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
  }
});

// ---- Blog tab ----

async function loadPosts() {
  try {
    const rows = await apiFetch('/admin/posts');
    posts = rows || [];
    renderPosts();
  } catch (err) {
    showToast(err.message || 'Could not load blog posts.');
  }
}

function renderPosts() {
  const tbody = document.querySelector('#postsBody');
  tbody.innerHTML = '';
  document.querySelector('#postsEmpty').classList.toggle('hidden', posts.length > 0);
  posts.forEach((post) => tbody.appendChild(renderPostRow(post)));
}

function renderPostRow(post) {
  const canEdit = currentAdmin.role === 'owner' || currentAdmin.role === 'writer';
  const status = post.status || 'draft';
  const slug = pick(post, 'slug');
  const id = pick(post, 'id');

  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td>${escapeHtml(post.title || 'Untitled')}</td>
    <td><span class="status-pill ${status}">${status === 'published' ? 'Published' : 'Draft'}</span></td>
    <td class="cell-muted">${escapeHtml(formatDate(pick(post, 'createdAt')))}</td>
    <td class="cell-muted">${escapeHtml(formatDate(pick(post, 'updatedAt')))}</td>
    <td class="cell-muted">${escapeHtml(formatDate(pick(post, 'publishedAt')) || '-')}</td>
    <td class="cell-actions"></td>
  `;

  const actions = tr.querySelector('.cell-actions');

  if (status === 'published' && slug) {
    const viewLink = document.createElement('a');
    viewLink.href = `/blog/${encodeURIComponent(slug)}`;
    viewLink.target = '_blank';
    viewLink.rel = 'noopener noreferrer';
    viewLink.className = 'btn ghost small';
    viewLink.textContent = 'View';
    actions.appendChild(viewLink);
  }

  if (canEdit) {
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'btn ghost small';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => openPostEditor(post));
    actions.appendChild(editBtn);

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'btn ghost small';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', () => deletePost(id));
    actions.appendChild(deleteBtn);
  }

  return tr;
}

function openPostEditor(post) {
  editingPostId = post ? pick(post, 'id') : null;
  slugTouched = Boolean(post);
  document.querySelector('#postEditorTitle').textContent = post ? 'Edit post' : 'New post';
  document.querySelector('#postTitle').value = (post && post.title) || '';
  document.querySelector('#postSlug').value = (post && pick(post, 'slug')) || '';
  document.querySelector('#postExcerpt').value = (post && post.excerpt) || '';
  document.querySelector('#postContent').value = (post && post.content) || '';
  document.querySelector('#postEditor').classList.remove('hidden');
}

function closePostEditor() {
  editingPostId = null;
  slugTouched = false;
  document.querySelector('#postEditor').classList.add('hidden');
}

document.querySelector('#newPostButton').addEventListener('click', () => openPostEditor(null));
document.querySelector('#cancelPostEdit').addEventListener('click', closePostEditor);

document.querySelector('#postTitle').addEventListener('input', (event) => {
  if (slugTouched) return;
  document.querySelector('#postSlug').value = kebabCase(event.target.value);
});

document.querySelector('#postSlug').addEventListener('input', () => {
  slugTouched = true;
});

async function savePost(status) {
  const title = document.querySelector('#postTitle').value.trim();
  const slug = document.querySelector('#postSlug').value.trim();
  const excerpt = document.querySelector('#postExcerpt').value.trim();
  const content = document.querySelector('#postContent').value;

  if (!title) {
    showToast('Add a title first.');
    return;
  }

  const payload = { title, excerpt, content, status };
  if (slug) payload.slug = slug;

  try {
    if (editingPostId) {
      await apiFetch(`/admin/posts/${encodeURIComponent(editingPostId)}`, {
        method: 'PUT',
        body: JSON.stringify(payload)
      });
      showToast('Post updated.');
    } else {
      await apiFetch('/admin/posts', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      showToast(status === 'published' ? 'Post published.' : 'Draft saved.');
    }
    closePostEditor();
    loadPosts();
  } catch (err) {
    showToast(err.message || 'Could not save post.');
  }
}

document.querySelector('#savePostDraft').addEventListener('click', () => savePost('draft'));
document.querySelector('#publishPost').addEventListener('click', () => savePost('published'));

async function deletePost(id) {
  if (!window.confirm('Delete this post? This cannot be undone.')) return;
  try {
    await apiFetch(`/admin/posts/${encodeURIComponent(id)}`, { method: 'DELETE' });
    posts = posts.filter((p) => pick(p, 'id') !== id);
    renderPosts();
    showToast('Post deleted.');
  } catch (err) {
    showToast(err.message || 'Could not delete post.');
  }
}

// ---- Discounts tab ----

async function loadDiscounts() {
  try {
    const rows = await apiFetch('/admin/discounts');
    discounts = rows || [];
    renderDiscounts();
  } catch (err) {
    showToast(err.message || 'Could not load discounts.');
  }
}

function discountTypeLabel(type) {
  return type === 'urgency' ? 'Urgency' : 'Standard';
}

function appliesToLabel(value) {
  if (value === 'pro') return 'Pro only';
  if (value === 'elite') return 'Elite only';
  return 'Pro & Elite';
}

function formatMoney(amount) {
  const num = Number(amount);
  if (Number.isNaN(num)) return '-';
  return Number.isInteger(num) ? `$${num}` : `$${num.toFixed(2)}`;
}

// Value type is additive on top of the v1 percent-only discounts, so a row
// missing value_type entirely (old data, or a backend that hasn't rolled
// the column out yet) is treated as 'percent' for display purposes.
function discountValueLabel(discount) {
  const valueType = pick(discount, 'value_type', 'valueType') || 'percent';
  if (valueType === 'amount') {
    const amountOff = pick(discount, 'amount_off', 'amountOff');
    return amountOff != null ? formatMoney(amountOff) : '-';
  }
  const percentOff = pick(discount, 'percent_off', 'percentOff');
  return percentOff != null ? `${percentOff}%` : '-';
}

function renderDiscounts() {
  const tbody = document.querySelector('#discountsBody');
  tbody.innerHTML = '';
  document.querySelector('#discountsEmpty').classList.toggle('hidden', discounts.length > 0);
  discounts.forEach((discount) => tbody.appendChild(renderDiscountRow(discount)));
}

function renderDiscountRow(discount) {
  const id = pick(discount, 'id');
  const active = Boolean(pick(discount, 'active'));
  const appliesTo = pick(discount, 'applies_to', 'appliesTo');

  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td>${escapeHtml(pick(discount, 'name') || 'Untitled')}</td>
    <td>${escapeHtml(discountTypeLabel(pick(discount, 'type')))}</td>
    <td class="cell-muted">${escapeHtml(discountValueLabel(discount))}</td>
    <td class="cell-muted">${escapeHtml(appliesToLabel(appliesTo))}</td>
    <td class="status-cell"></td>
    <td class="cell-actions"></td>
  `;

  const statusCell = tr.querySelector('.status-cell');
  const pill = document.createElement('span');
  pill.className = `status-pill ${active ? 'active' : 'paused'}`;
  pill.textContent = active ? 'Active' : 'Inactive';
  statusCell.appendChild(pill);

  const actions = tr.querySelector('.cell-actions');

  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'btn ghost small';
  editBtn.textContent = 'Edit';
  editBtn.addEventListener('click', () => startEditDiscount(discount));
  actions.appendChild(editBtn);

  const toggleBtn = document.createElement('button');
  toggleBtn.type = 'button';
  toggleBtn.className = 'btn ghost small';
  toggleBtn.textContent = active ? 'Deactivate' : 'Activate';
  toggleBtn.addEventListener('click', () => toggleDiscount(discount, toggleBtn));
  actions.appendChild(toggleBtn);

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'btn ghost small';
  deleteBtn.textContent = 'Delete';
  deleteBtn.addEventListener('click', () => deleteDiscount(id));
  actions.appendChild(deleteBtn);

  return tr;
}

async function toggleDiscount(discount, button) {
  const id = pick(discount, 'id');
  const active = Boolean(pick(discount, 'active'));
  const path = active
    ? `/admin/discounts/${encodeURIComponent(id)}/deactivate`
    : `/admin/discounts/${encodeURIComponent(id)}/activate`;
  button.disabled = true;
  try {
    await apiFetch(path, { method: 'POST', body: JSON.stringify({}) });
    showToast(active ? 'Discount deactivated.' : 'Discount activated.');
    // Activating a discount also deactivates every other discount of the
    // same type on the server, so reload the full list rather than patch
    // this row locally.
    loadDiscounts();
  } catch (err) {
    showToast(err.message || 'Could not update discount.');
    button.disabled = false;
  }
}

async function deleteDiscount(id) {
  if (!window.confirm('Delete this discount? This also clears any visitor offer windows tied to it.')) return;
  try {
    await apiFetch(`/admin/discounts/${encodeURIComponent(id)}`, { method: 'DELETE' });
    discounts = discounts.filter((d) => pick(d, 'id') !== id);
    if (editingDiscountId === id) resetDiscountForm();
    renderDiscounts();
    showToast('Discount deleted.');
  } catch (err) {
    showToast(err.message || 'Could not delete discount.');
  }
}

// ---- Discounts tab: create / edit form ----
// The same form drives both create and edit. editingDiscountId tracks which
// mode we're in; the value-type select swaps the value input between a
// percent field (1-90) and a dollar field (must stay under the cheapest
// applicable plan price), and Save sends a POST or PUT accordingly.

const discountFormTitle = document.querySelector('#discountFormTitle');
const discountValueTypeSelect = document.querySelector('#discountValueType');
const discountValueInput = document.querySelector('#newDiscountValue');
const saveDiscountButton = document.querySelector('#addDiscountButton');
const cancelDiscountEditLink = document.querySelector('#cancelDiscountEdit');

function updateDiscountValueField() {
  const isAmount = discountValueTypeSelect.value === 'amount';
  discountValueInput.placeholder = isAmount ? '$ off (e.g. 5)' : '% off';
  discountValueInput.setAttribute('aria-label', isAmount ? '$ off' : '% off');
  discountValueInput.min = isAmount ? '0.01' : '1';
  discountValueInput.step = isAmount ? '0.01' : '1';
  if (isAmount) {
    discountValueInput.removeAttribute('max');
  } else {
    discountValueInput.max = '90';
  }
}

discountValueTypeSelect.addEventListener('change', updateDiscountValueField);
updateDiscountValueField();

function startEditDiscount(discount) {
  editingDiscountId = pick(discount, 'id');
  const valueType = pick(discount, 'value_type', 'valueType') || 'percent';

  document.querySelector('#newDiscountName').value = pick(discount, 'name') || '';
  document.querySelector('#newDiscountType').value = pick(discount, 'type') || 'standard';
  discountValueTypeSelect.value = valueType;
  updateDiscountValueField();

  if (valueType === 'amount') {
    const amountOff = pick(discount, 'amount_off', 'amountOff');
    discountValueInput.value = amountOff != null ? amountOff : '';
  } else {
    const percentOff = pick(discount, 'percent_off', 'percentOff');
    discountValueInput.value = percentOff != null ? percentOff : '';
  }

  document.querySelector('#newDiscountAppliesTo').value = pick(discount, 'applies_to', 'appliesTo') || 'both';

  discountFormTitle.textContent = 'Edit discount';
  saveDiscountButton.textContent = 'Save changes';
  cancelDiscountEditLink.classList.remove('hidden');
}

function resetDiscountForm() {
  editingDiscountId = null;
  document.querySelector('#newDiscountName').value = '';
  document.querySelector('#newDiscountType').value = 'standard';
  discountValueTypeSelect.value = 'percent';
  discountValueInput.value = '';
  document.querySelector('#newDiscountAppliesTo').value = 'both';
  updateDiscountValueField();

  discountFormTitle.textContent = 'Create a discount';
  saveDiscountButton.textContent = 'Create discount';
  cancelDiscountEditLink.classList.add('hidden');
}

cancelDiscountEditLink.addEventListener('click', (event) => {
  event.preventDefault();
  resetDiscountForm();
});

// Returns a validated payload, or null (after showing a toast) if the form
// is incomplete/invalid. Always sends both percent_off and amount_off so a
// value-type switch on an existing discount clears the field that no
// longer applies.
function buildDiscountPayload() {
  const name = document.querySelector('#newDiscountName').value.trim();
  const type = document.querySelector('#newDiscountType').value;
  const valueType = discountValueTypeSelect.value;
  const valueRaw = discountValueInput.value.trim();
  const appliesTo = document.querySelector('#newDiscountAppliesTo').value;

  if (!name) {
    showToast('Add a name first.');
    return null;
  }

  const payload = { name, type, value_type: valueType, applies_to: appliesTo };

  if (valueType === 'amount') {
    const amountOff = Number(valueRaw);
    // Cap $-off below the cheapest applicable plan's live price (falls back to
    // the launch prices if the Plans tab hasn't been loaded yet).
    const livePrice = (name) => {
      const row = plans.find((p) => pick(p, 'plan') === name);
      return row ? Number(pick(row, 'priceUsd', 'price_usd')) : null;
    };
    const cap = appliesTo === 'elite'
      ? (livePrice('elite') || 29)
      : (livePrice('pro') || 19);
    if (!valueRaw || Number.isNaN(amountOff) || amountOff <= 0 || amountOff >= cap) {
      showToast(`Enter a dollar amount greater than $0 and less than $${cap}.`);
      return null;
    }
    payload.amount_off = amountOff;
    payload.percent_off = null;
  } else {
    const percentOff = Number(valueRaw);
    if (!valueRaw || Number.isNaN(percentOff) || !Number.isInteger(percentOff) || percentOff < 1 || percentOff > 90) {
      showToast('Enter a percent off between 1 and 90.');
      return null;
    }
    payload.percent_off = percentOff;
    payload.amount_off = null;
  }

  return payload;
}

saveDiscountButton.addEventListener('click', async () => {
  const payload = buildDiscountPayload();
  if (!payload) return;

  saveDiscountButton.disabled = true;
  try {
    if (editingDiscountId) {
      await apiFetch(`/admin/discounts/${encodeURIComponent(editingDiscountId)}`, {
        method: 'PUT',
        body: JSON.stringify(payload)
      });
      showToast('Discount updated.');
    } else {
      await apiFetch('/admin/discounts', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      showToast('Discount created.');
    }
    resetDiscountForm();
    loadDiscounts();
  } catch (err) {
    showToast(err.message || (editingDiscountId ? 'Could not update discount.' : 'Could not create discount.'));
  } finally {
    saveDiscountButton.disabled = false;
  }
});

// ---- Plans tab ----
// Each row is directly editable: price inputs (hidden for free) + Save.
// The free row edits its generations quota; paid rows edit their monthly
// credit pool instead. Prices are whole dollars - Stripe checkout charges
// exactly what's stored here.

async function loadPlans() {
  try {
    const rows = await apiFetch('/admin/plans');
    plans = rows || [];
    renderPlans();
  } catch (err) {
    showToast(err.message || 'Could not load plans.');
  }
}

function planLabel(plan) {
  if (plan === 'pro') return 'Pro';
  if (plan === 'elite') return 'Elite';
  return 'Free';
}

function renderPlans() {
  const tbody = document.querySelector('#plansBody');
  tbody.innerHTML = '';
  plans.forEach((planRow) => tbody.appendChild(renderPlanRow(planRow)));
}

function renderPlanRow(planRow) {
  const plan = pick(planRow, 'plan');
  const isFree = plan === 'free';

  const tr = document.createElement('tr');

  const nameCell = document.createElement('td');
  nameCell.textContent = planLabel(plan);
  tr.appendChild(nameCell);

  const monthlyCell = document.createElement('td');
  const monthlyInput = document.createElement('input');
  monthlyInput.className = 'input';
  monthlyInput.type = 'number';
  monthlyInput.min = '1';
  monthlyInput.step = '1';
  monthlyInput.style.maxWidth = '110px';
  if (isFree) {
    monthlyCell.textContent = 'Free';
  } else {
    monthlyInput.value = pick(planRow, 'priceUsd', 'price_usd') ?? '';
    monthlyCell.appendChild(monthlyInput);
  }
  tr.appendChild(monthlyCell);

  const yearlyCell = document.createElement('td');
  const yearlyInput = document.createElement('input');
  yearlyInput.className = 'input';
  yearlyInput.type = 'number';
  yearlyInput.min = '1';
  yearlyInput.step = '1';
  yearlyInput.style.maxWidth = '110px';
  if (isFree) {
    yearlyCell.textContent = '-';
  } else {
    yearlyInput.value = pick(planRow, 'priceUsdYearly', 'price_usd_yearly') ?? '';
    yearlyCell.appendChild(yearlyInput);
  }
  tr.appendChild(yearlyCell);

  const quotaCell = document.createElement('td');
  const quotaInput = document.createElement('input');
  quotaInput.className = 'input';
  quotaInput.type = 'number';
  quotaInput.min = '1';
  quotaInput.step = '1';
  quotaInput.style.maxWidth = '110px';
  if (isFree) {
    quotaInput.value = pick(planRow, 'generationLimit', 'generation_limit') ?? '';
    quotaCell.appendChild(quotaInput);
  } else {
    quotaCell.textContent = '-';
    quotaCell.className = 'cell-muted';
  }
  tr.appendChild(quotaCell);

  const creditsCell = document.createElement('td');
  const creditsInput = document.createElement('input');
  creditsInput.className = 'input';
  creditsInput.type = 'number';
  creditsInput.min = '1';
  creditsInput.step = '1';
  creditsInput.style.maxWidth = '110px';
  if (isFree) {
    creditsCell.textContent = '-';
    creditsCell.className = 'cell-muted';
  } else {
    creditsInput.value = pick(planRow, 'creditsMonthly', 'credits_monthly') ?? '';
    creditsCell.appendChild(creditsInput);
  }
  tr.appendChild(creditsCell);

  const actionsCell = document.createElement('td');
  actionsCell.className = 'cell-actions';
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'btn primary small';
  saveBtn.textContent = 'Save';
  saveBtn.addEventListener('click', () => savePlan(plan, { monthlyInput, yearlyInput, quotaInput, creditsInput, saveBtn, isFree }));
  actionsCell.appendChild(saveBtn);
  tr.appendChild(actionsCell);

  return tr;
}

async function savePlan(plan, { monthlyInput, yearlyInput, quotaInput, creditsInput, saveBtn, isFree }) {
  const payload = {};

  if (isFree) {
    const generationLimit = Number(quotaInput.value);
    if (!Number.isFinite(generationLimit) || generationLimit <= 0) {
      showToast('Generations per month must be a positive number.');
      return;
    }
    payload.generationLimit = generationLimit;
  } else {
    const priceUsd = Number(monthlyInput.value);
    if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
      showToast('Monthly price must be a positive number.');
      return;
    }
    payload.priceUsd = priceUsd;
    const yearlyRaw = yearlyInput.value.trim();
    if (yearlyRaw) {
      const priceUsdYearly = Number(yearlyRaw);
      if (!Number.isFinite(priceUsdYearly) || priceUsdYearly <= 0) {
        showToast('Yearly price must be a positive number (or leave it empty).');
        return;
      }
      payload.priceUsdYearly = priceUsdYearly;
    }
    const creditsMonthly = Number(creditsInput.value);
    if (!creditsInput.value.trim() || !Number.isInteger(creditsMonthly) || creditsMonthly <= 0) {
      showToast('Monthly credits must be a positive whole number.');
      return;
    }
    payload.creditsMonthly = creditsMonthly;
  }

  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving...';
  try {
    await apiFetch(`/admin/plans/${encodeURIComponent(plan)}`, {
      method: 'PUT',
      body: JSON.stringify(payload)
    });
    showToast(`${planLabel(plan)} plan updated.`);
    loadPlans();
  } catch (err) {
    showToast(err.message || 'Could not update plan.');
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save';
  }
}

// ---- Plans tab: feature costs ----
// Six per-use credit costs, one input each. Check-match has no row on the
// server because it is always free, so it never appears here.

const COST_FIELDS = [
  ['light', '#costLight'],
  ['medium', '#costMedium'],
  ['max', '#costMax'],
  ['ultra', '#costUltra'],
  ['revise', '#costRevise'],
  ['boost', '#costBoost']
];

const saveCreditCostsButton = document.querySelector('#saveCreditCosts');

function fillCostInputs(costs) {
  COST_FIELDS.forEach(([key, selector]) => {
    const value = costs && costs[key] != null ? costs[key] : '';
    document.querySelector(selector).value = value;
  });
}

async function loadCreditCosts() {
  try {
    const data = await apiFetch('/admin/credit-costs');
    creditCosts = data || {};
    fillCostInputs(creditCosts);
  } catch (err) {
    showToast(err.message || 'Could not load feature costs.');
  }
}

saveCreditCostsButton.addEventListener('click', async () => {
  const payload = {};
  for (const [key, selector] of COST_FIELDS) {
    const raw = document.querySelector(selector).value.trim();
    const value = Number(raw);
    if (!raw || !Number.isInteger(value) || value <= 0) {
      showToast('Every feature cost must be a positive whole number of credits.');
      return;
    }
    payload[key] = value;
  }

  saveCreditCostsButton.disabled = true;
  saveCreditCostsButton.textContent = 'Saving...';
  try {
    const data = await apiFetch('/admin/credit-costs', {
      method: 'PUT',
      body: JSON.stringify(payload)
    });
    creditCosts = data || payload;
    fillCostInputs(creditCosts);
    showToast('Feature costs updated.');
  } catch (err) {
    showToast(err.message || 'Could not update feature costs.');
  } finally {
    saveCreditCostsButton.disabled = false;
    saveCreditCostsButton.textContent = 'Save costs';
  }
});

// ---- Admins tab ----

async function loadAdmins() {
  try {
    const rows = await apiFetch('/admin/admins');
    admins = rows || [];
    renderAdmins();
  } catch (err) {
    showToast(err.message || 'Could not load admins.');
  }
}

function renderAdmins() {
  const tbody = document.querySelector('#adminsBody');
  tbody.innerHTML = '';
  admins.forEach((admin) => tbody.appendChild(renderAdminRow(admin)));
}

function renderAdminRow(admin) {
  const id = pick(admin, 'id');
  const email = pick(admin, 'email');
  const role = pick(admin, 'role');
  const accountId = pick(admin, 'accountId', 'account_id');
  const createdAt = pick(admin, 'createdAt', 'created_at');
  const isSelf = currentAdmin.email && email && currentAdmin.email.toLowerCase() === String(email).toLowerCase();

  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td>${escapeHtml(email)}</td>
    <td>${escapeHtml(role ? role.charAt(0).toUpperCase() + role.slice(1) : '')}</td>
    <td class="cell-muted">${accountId ? 'Yes' : 'Pending'}</td>
    <td class="cell-muted">${escapeHtml(formatDate(createdAt))}</td>
    <td class="cell-actions"></td>
  `;

  const actions = tr.querySelector('.cell-actions');
  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'btn ghost small';
  removeBtn.textContent = isSelf ? 'You' : 'Remove';
  removeBtn.disabled = isSelf;
  if (!isSelf) {
    removeBtn.addEventListener('click', () => removeAdmin(id, email));
  }
  actions.appendChild(removeBtn);

  return tr;
}

async function removeAdmin(id, email) {
  if (!window.confirm(`Remove admin access for ${email}?`)) return;
  try {
    await apiFetch(`/admin/admins/${encodeURIComponent(id)}`, { method: 'DELETE' });
    admins = admins.filter((a) => pick(a, 'id') !== id);
    renderAdmins();
    showToast('Admin removed.');
  } catch (err) {
    showToast(err.message || 'Could not remove admin.');
  }
}

document.querySelector('#addAdminButton').addEventListener('click', async () => {
  const email = document.querySelector('#newAdminEmail').value.trim();
  const role = document.querySelector('#newAdminRole').value;
  if (!email) {
    showToast('Enter an email first.');
    return;
  }
  try {
    await apiFetch('/admin/admins', {
      method: 'POST',
      body: JSON.stringify({ email, role })
    });
    document.querySelector('#newAdminEmail').value = '';
    showToast('Admin added.');
    loadAdmins();
  } catch (err) {
    showToast(err.message || 'Could not add admin.');
  }
});

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

// ---- Boot ----

async function boot() {
  consumeHashToken();

  if (!getToken()) {
    showSignedOut();
    return;
  }

  try {
    const me = await apiFetch('/admin/me');
    currentAdmin = me;

    navSignInLink.classList.add('hidden');
    navUser.classList.remove('hidden');
    userName.textContent = me.name || me.email || 'Signed in';
    userRoleBadge.textContent = me.role;
    userRoleBadge.classList.remove('hidden');

    roleLine.textContent = `Signed in as ${me.email} - role: ${me.role}`;
    setupTabsForRole(me.role);
    showAdmin();

    const allowed = ROLE_TABS[me.role] || [];
    if (allowed.includes('members')) loadMembers();
    if (allowed.includes('blog')) loadPosts();
    if (allowed.includes('discounts')) loadDiscounts();
    if (allowed.includes('plans')) {
      loadPlans();
      loadCreditCosts();
    }
    if (allowed.includes('admins')) loadAdmins();
  } catch (err) {
    if (err.message && err.message.toLowerCase().includes('sign in')) {
      showSignedOut();
      return;
    }
    showDenied(err.message || 'This account does not have admin access.');
  }
}

boot();
