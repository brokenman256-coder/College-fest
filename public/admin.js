const app = document.getElementById('app');
const nav = document.getElementById('nav');
const who = document.getElementById('who');
let ME = null;

function toast(t) {
  const el = document.getElementById('toast');
  el.textContent = t; el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2400);
}
async function api(path, opts) {
  const r = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    ...opts,
    body: opts && opts.body ? JSON.stringify(opts.body) : undefined
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Request failed');
  return j;
}
function esc(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function boot() {
  try {
    const m = await api('/api/meta');
    ME = m.me;
  } catch (e) { ME = null; }
  who.textContent = ME && ME.role === 'admin' ? ME.email : 'desk locked';
  nav.innerHTML = '';
  if (!ME || ME.role !== 'admin') return showLogin();
  const tabs = [['overview','Overview'],['users','People'],['posts','Posts'],['payouts','Payouts'],['reports','Reports'],['events','Events'],['prompts','Prompts'],['audit','Audit']];
  const hash = (location.hash || '#overview').slice(1);
  for (const [id, label] of tabs) {
    const b = document.createElement('button');
    b.textContent = label;
    if (hash === id) b.classList.add('on');
    b.onclick = () => { location.hash = id; boot(); };
    nav.appendChild(b);
  }
  const out = document.createElement('button');
  out.textContent = 'Log out'; out.className = 'btn danger';
  out.onclick = async () => { await api('/api/auth/logout', { method: 'POST', body: {} }); location.reload(); };
  nav.appendChild(out);
  const page = hash || 'overview';
  if (page === 'users') return showUsers();
  if (page === 'posts') return showPosts();
  if (page === 'payouts') return showPayouts();
  if (page === 'reports') return showReports();
  if (page === 'events') return showEvents();
  if (page === 'prompts') return showPrompts();
  if (page === 'audit') return showAudit();
  showOverview();
}

function showLogin() {
  app.innerHTML = `<div class="card" style="max-width:420px">
    <h3>Desk login</h3>
    <label>Email</label><input id="email" value="admin@campus.local">
    <label>Password</label><input id="pw" type="password" value="change-me-now">
    <button class="btn solid" id="go">Enter</button>
    <p class="meta">Change ADMIN_PASSWORD in the environment before this is public.</p>
  </div>`;
  document.getElementById('go').onclick = async () => {
    try {
      await api('/api/auth/admin-login', { method: 'POST', body: {
        email: document.getElementById('email').value,
        password: document.getElementById('pw').value
      }});
      location.hash = 'overview'; boot();
    } catch (e) { toast(e.message); }
  };
}

async function showOverview() {
  const d = await api('/api/admin/overview');
  const s = d.stats;
  app.innerHTML = `<div class="card">
    <div class="stat"><b>${s.users}</b>students</div>
    <div class="stat"><b>${s.suspended}</b>suspended</div>
    <div class="stat"><b>${s.banned}</b>banned</div>
    <div class="stat"><b>${s.posts}</b>posts</div>
    <div class="stat"><b>${s.reports}</b>reports</div>
    <div class="stat"><b>${s.pending_payouts}</b>payouts waiting</div>
    <div class="warn">Identities stay on this desk. Share a record with authorities only through a lawful request — export is the audit log plus user rows, not a fake-view dump.</div>
  </div>`;
}

async function showUsers() {
  app.innerHTML = `<div class="card">
    <input id="q" placeholder="search handle, email, phone, college id">
    <div id="tbl"></div>
  </div>`;
  const render = async () => {
    const d = await api('/api/admin/users?q=' + encodeURIComponent(document.getElementById('q').value));
    document.getElementById('tbl').innerHTML = `<table>
      <tr><th>Handle</th><th>Identity</th><th>Status</th><th>Followers</th><th>Actions</th></tr>
      ${d.users.map((u) => `<tr>
        <td>@${esc(u.handle)} ${u.verified ? '✓' : ''}</td>
        <td>${esc(u.email || '—')}<br>${esc(u.phone || '')}<br>${esc(u.college_id || '')}</td>
        <td>${esc(u.status)}</td>
        <td>${u.follower_count}</td>
        <td>
          <button class="btn" data-act="active" data-id="${u.id}">Unsuspend</button>
          <button class="btn" data-act="suspended" data-id="${u.id}">Suspend</button>
          <button class="btn danger" data-act="banned" data-id="${u.id}">Ban</button>
          <button class="btn good" data-v="${u.id}">Verify ID</button>
        </td>
      </tr>`).join('')}
    </table>`;
    document.getElementById('tbl').onclick = async (e) => {
      const b = e.target.closest('button'); if (!b) return;
      try {
        if (b.dataset.v) await api('/api/admin/verify', { method: 'POST', body: { id: b.dataset.v } });
        else await api('/api/admin/user-status', { method: 'POST', body: { id: b.dataset.id, status: b.dataset.act } });
        toast('Updated'); render();
      } catch (err) { toast(err.message); }
    };
  };
  document.getElementById('q').oninput = debounce(render, 200);
  render();
}

async function showPosts() {
  const d = await api('/api/admin/posts');
  app.innerHTML = `<table>
    <tr><th>Title</th><th>Author</th><th>Email</th><th>Views</th><th></th></tr>
    ${d.posts.map((p) => `<tr>
      <td>${esc(p.title)}<div class="meta">${esc(p.section)} · ${esc(p.source)}</div></td>
      <td>@${esc(p.handle || 'desk')}</td>
      <td>${esc(p.email || '')}</td>
      <td>${p.unique_views}</td>
      <td><button class="btn" data-id="${p.id}" data-h="${p.hidden ? 0 : 1}">${p.hidden ? 'Unhide' : 'Hide'}</button></td>
    </tr>`).join('')}
  </table>`;
  app.onclick = async (e) => {
    const b = e.target.closest('button'); if (!b || !b.dataset.id) return;
    await api('/api/admin/hide-post', { method: 'POST', body: { id: b.dataset.id, hidden: Number(b.dataset.h) } });
    boot();
  };
}

async function showPayouts() {
  const d = await api('/api/admin/payouts');
  app.innerHTML = `<div class="warn">Pay only against unique reads stored in post_views. There is no view-boost endpoint.</div>
  <table>
    <tr><th>Who</th><th>USD</th><th>Wallet</th><th>Status</th><th></th></tr>
    ${d.payouts.map((p) => `<tr>
      <td>@${esc(p.handle)}<div class="meta">${esc(p.email)}</div></td>
      <td>${p.amount_usd}</td>
      <td class="meta">${esc(p.wallet)}</td>
      <td>${esc(p.status)}</td>
      <td>
        <button class="btn" data-id="${p.id}" data-s="approved">Approve</button>
        <button class="btn good" data-id="${p.id}" data-s="paid">Mark paid</button>
        <button class="btn danger" data-id="${p.id}" data-s="rejected">Reject</button>
      </td>
    </tr>`).join('')}
  </table>`;
  app.onclick = async (e) => {
    const b = e.target.closest('button'); if (!b || !b.dataset.id) return;
    await api('/api/admin/payout-status', { method: 'POST', body: { id: b.dataset.id, status: b.dataset.s } });
    boot();
  };
}

async function showReports() {
  const d = await api('/api/admin/reports');
  app.innerHTML = `<table>
    <tr><th>Post</th><th>Reporter</th><th>Reason</th><th>When</th></tr>
    ${d.reports.map((r) => `<tr>
      <td>${esc(r.title || r.post_id)}</td>
      <td>@${esc(r.reporter_handle || '')}</td>
      <td>${esc(r.reason)}</td>
      <td>${esc(r.created_at)}</td>
    </tr>`).join('')}
  </table>`;
}

function showEvents() {
  app.innerHTML = `<div class="card">
    <h3>Add campus event</h3>
    <p class="meta">Paste a public Instagram / college page URL in Source. We do not scrape reels.</p>
    <input id="title" placeholder="title">
    <textarea id="body" rows="4" placeholder="what / when / where"></textarea>
    <input id="source" placeholder="https://instagram.com/p/... or college notice">
    <button class="btn solid" id="add">Add</button>
  </div>`;
  document.getElementById('add').onclick = async () => {
    try {
      await api('/api/admin/event', { method: 'POST', body: {
        title: document.getElementById('title').value,
        body: document.getElementById('body').value,
        source: document.getElementById('source').value
      }});
      toast('Event added');
    } catch (e) { toast(e.message); }
  };
}

function showPrompts() {
  app.innerHTML = `<div class="card">
    <h3>Desk discussion prompt</h3>
    <p class="meta">This is labeled staff prompt. It is not posted as a fake student confession.</p>
    <select id="section">
      <option value="safety">Safety</option>
      <option value="hostels">Hostels</option>
      <option value="courses">Courses</option>
      <option value="placements">Placements</option>
      <option value="events">Events</option>
      <option value="confessions">Confessions</option>
    </select>
    <input id="title" placeholder="title">
    <textarea id="body" rows="6" placeholder="Prompt students to share what they actually saw."></textarea>
    <button class="btn solid" id="add">Publish prompt</button>
  </div>`;
  document.getElementById('add').onclick = async () => {
    try {
      await api('/api/admin/prompt', { method: 'POST', body: {
        section: document.getElementById('section').value,
        title: document.getElementById('title').value,
        body: document.getElementById('body').value
      }});
      toast('Prompt on the feed');
    } catch (e) { toast(e.message); }
  };
}

async function showAudit() {
  const d = await api('/api/admin/audit');
  app.innerHTML = `<table>
    <tr><th>When</th><th>Action</th><th>Target</th><th>Detail</th></tr>
    ${d.audit.map((a) => `<tr>
      <td>${esc(a.created_at)}</td>
      <td>${esc(a.action)}</td>
      <td class="meta">${esc(a.target_id)}</td>
      <td>${esc(a.detail)}</td>
    </tr>`).join('')}
  </table>`;
}

function debounce(fn, ms) {
  let t; return () => { clearTimeout(t); t = setTimeout(fn, ms); };
}
window.addEventListener('hashchange', () => boot());
boot();
