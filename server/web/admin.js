// ResumePilot - admin panel.
// Served at /admin by the same Express server that hosts the API, so every
// fetch below uses a relative path (same origin, no API base to configure).

const SESSION_KEY = 'rt_session';

const ROLE_TABS = {
  owner: ['members', 'broadcast', 'blog', 'discounts', 'admins'],
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
let admins = [];
let editingPostId = null;
let slugTouched = false;
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

function renderDiscounts() {
  const tbody = document.querySelector('#discountsBody');
  tbody.innerHTML = '';
  document.querySelector('#discountsEmpty').classList.toggle('hidden', discounts.length > 0);
  discounts.forEach((discount) => tbody.appendChild(renderDiscountRow(discount)));
}

function renderDiscountRow(discount) {
  const id = pick(discount, 'id');
  const active = Boolean(pick(discount, 'active'));
  const percentOff = pick(discount, 'percent_off', 'percentOff');
  const appliesTo = pick(discount, 'applies_to', 'appliesTo');

  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td>${escapeHtml(pick(discount, 'name') || 'Untitled')}</td>
    <td>${escapeHtml(discountTypeLabel(pick(discount, 'type')))}</td>
    <td class="cell-muted">${escapeHtml(percentOff != null ? `${percentOff}%` : '-')}</td>
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
    renderDiscounts();
    showToast('Discount deleted.');
  } catch (err) {
    showToast(err.message || 'Could not delete discount.');
  }
}

document.querySelector('#addDiscountButton').addEventListener('click', async () => {
  const name = document.querySelector('#newDiscountName').value.trim();
  const type = document.querySelector('#newDiscountType').value;
  const percentRaw = document.querySelector('#newDiscountPercent').value.trim();
  const appliesTo = document.querySelector('#newDiscountAppliesTo').value;
  const percentOff = Number(percentRaw);

  if (!name) {
    showToast('Add a name first.');
    return;
  }
  if (!percentRaw || Number.isNaN(percentOff) || percentOff < 1 || percentOff > 90) {
    showToast('Enter a percent off between 1 and 90.');
    return;
  }

  const btn = document.querySelector('#addDiscountButton');
  btn.disabled = true;
  try {
    await apiFetch('/admin/discounts', {
      method: 'POST',
      body: JSON.stringify({ name, type, percent_off: percentOff, applies_to: appliesTo })
    });
    document.querySelector('#newDiscountName').value = '';
    document.querySelector('#newDiscountPercent').value = '';
    showToast('Discount created.');
    loadDiscounts();
  } catch (err) {
    showToast(err.message || 'Could not create discount.');
  } finally {
    btn.disabled = false;
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
