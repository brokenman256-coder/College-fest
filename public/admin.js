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
  const tabs = [['overview','Overview'],['users','People'],['posts','Posts'],['chat','DMs'],['room','Town hall'],['payouts','Payouts'],['reports','Reports'],['events','Events'],['prompts','Prompts'],['blog','Blog bot'],['audit','Audit']];
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
  if (page === 'chat') return showChatMonitor();
  if (page === 'room') return showRoom();
  if (page === 'payouts') return showPayouts();
  if (page === 'reports') return showReports();
  if (page === 'events') return showEvents();
  if (page === 'prompts') return showPrompts();
  if (page === 'blog') return showBlogBot();
  if (page === 'audit') return showAudit();
  showOverview();
}

function showLogin() {
  app.innerHTML = `<div class="card" style="max-width:420px">
    <h3>Desk login</h3>
    <label>Email</label><input id="email" value="brokenman256@gmail.com">
    <label>Password</label><input id="pw" type="password" placeholder="admin password">
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
  app.innerHTML = `
    <div class="stat-grid">
      <div class="stat"><b>${s.users}</b>students<span class="delta">+${s.signups_week} this week</span></div>
      <div class="stat"><b>${s.posts}</b>posts<span class="delta">+${s.posts_week} this week</span></div>
      <div class="stat"><b>${s.total_reads}</b>unique reads</div>
      <div class="stat"><b>${s.chats}</b>DMs</div>
      <div class="stat"><b>${s.room_messages}</b>town hall msgs</div>
      <div class="stat"><b>${s.pending_payouts}</b>payouts waiting<span class="delta">$${Number(s.pending_usd || 0).toFixed(2)}</span></div>
      <div class="stat"><b>${s.suspended}</b>suspended</div>
      <div class="stat"><b>${s.banned}</b>banned</div>
      <div class="stat"><b>${s.reports}</b>open reports</div>
    </div>
    <div class="grid">
      <div class="card">
        <h3>Top stories</h3>
        ${(d.top_posts || []).map((p) => `<div class="mini-row">
          <span class="section-label">${esc(p.section || '')}</span>
          <b>${esc(p.title)}</b>
          <span class="meta">@${esc(p.handle || 'desk')} · ${p.unique_views} reads · ♥ ${p.likes || 0}</span>
        </div>`).join('') || '<p class="meta">No posts yet.</p>'}
      </div>
      <div class="card">
        <h3>Newest students</h3>
        ${(d.recent_users || []).map((u) => `<div class="mini-row">
          <b>@${esc(u.handle)}</b> ${u.status !== 'active' ? `<span class="tag">${esc(u.status)}</span>` : ''}
          <span class="meta">${esc(u.college_name || '—')}${u.place ? ' · ' + esc(u.place) : ''} · ${esc((u.created_at || '').slice(0, 10))}</span>
        </div>`).join('') || '<p class="meta">No students yet.</p>'}
      </div>
    </div>
    <div class="warn">Identities stay on this desk. Share a record with authorities only through a lawful request — export is the audit log plus user rows, not a fake-view dump.</div>`;
}

async function showRoom() {
  app.innerHTML = `<div class="card">
    <h3>Town hall — public room monitor</h3>
    <p class="meta">Every message in the public room, with the real account behind the handle. Delete anything abusive or ban the sender.</p>
    <div class="card" style="background:#f8fafc;margin-bottom:14px">
      <label>Post to the room as @${esc((ME && ME.handle) || 'desk')}</label>
      <input id="roomMsg" placeholder="Announcement to everyone in the town hall…" maxlength="1000">
      <button class="btn solid" id="roomPost">Post announcement</button>
    </div>
    <div id="roomTbl"></div>
  </div>`;
  const render = async () => {
    try {
      const d = await api('/api/admin/room');
      document.getElementById('roomTbl').innerHTML = `<table>
        <tr><th>When</th><th>Handle</th><th>Identity</th><th>Message</th><th></th></tr>
        ${d.messages.map((m) => `<tr>
          <td class="meta">${esc((m.timestamp || '').slice(0, 16).replace('T', ' '))}</td>
          <td><b>@${esc(m.sender_handle)}</b></td>
          <td class="meta">${esc(m.sender_email || '—')} · ${esc(m.sender_status || '?')}</td>
          <td>${m.image_url ? `<img class="msg-img" src="${esc(m.image_url)}" alt="photo">` : ''}${esc(m.message || '')}</td>
          <td>
            <button class="btn danger" data-del="${esc(m._id)}">Delete</button>
            <button class="btn danger" data-ban="${esc(m.sender_user_id || '')}">Ban sender</button>
          </td>
        </tr>`).join('') || '<tr><td colspan="5" class="meta">Room is quiet.</td></tr>'}
      </table>`;
      document.getElementById('roomTbl').onclick = async (e) => {
        const b = e.target.closest('button'); if (!b) return;
        try {
          if (b.dataset.del) {
            if (!confirm('Delete this room message?')) return;
            await api('/api/admin/chat/delete', { method: 'POST', body: { room_id: b.dataset.del } });
          } else if (b.dataset.ban) {
            if (!confirm('Ban this sender?')) return;
            await api('/api/admin/chat/ban-user', { method: 'POST', body: { user_id: b.dataset.ban } });
          }
          toast('Done'); render();
        } catch (err) { toast(err.message); }
      };
    } catch (e) {
      document.getElementById('roomTbl').innerHTML = '<p class="meta">' + esc(e.message) + '</p>';
    }
  };
  document.getElementById('roomPost').onclick = async () => {
    const inp = document.getElementById('roomMsg');
    const v = inp.value.trim();
    if (!v) return toast('Write something first.');
    try {
      await api('/api/room/send', { method: 'POST', body: { message: v } });
      inp.value = '';
      toast('Posted to town hall');
    } catch (e) { toast(e.message); }
  };
  render();
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

async function showChatMonitor(page = 1) {
  app.innerHTML = `<div class="card">
    <h3>Chat monitor</h3>
    <p class="meta">Anonymous chat handles are pseudonyms. This desk can map them to accounts when there is a lawful reason.</p>
    <div class="row">
      <input id="cq" placeholder="filter by chat handle (ch_xxxxxxxxxx)" style="max-width:340px">
      <button class="btn" id="csearch">Filter</button>
      <button class="btn" id="call">All messages</button>
    </div>
    <div id="ctbl"></div>
    <div class="row" id="cnav"></div>
  </div>`;

  const render = async (url) => {
    try {
      const d = await api(url);
      const msgs = d.messages || [];
      document.getElementById('ctbl').innerHTML = `<table>
        <tr><th>When</th><th>From</th><th>To</th><th>Message</th><th>Actions</th></tr>
        ${msgs.map((m) => `<tr>
          <td class="meta">${esc((m.timestamp || '').slice(0, 16).replace('T', ' '))}</td>
          <td><b>@${esc(m.sender_handle)}</b><div class="meta">${esc(m.sender_email || '—')} · ${esc(m.sender_status || '?')}</div></td>
          <td>@${esc(m.receiver_handle)}</td>
          <td>${m.image_url ? `<img class="msg-img" src="${esc(m.image_url)}" alt="photo">` : ''}${esc(m.message || '')}</td>
          <td>
            <button class="btn danger" data-del="${esc(m.chat_id)}">Delete</button>
            <button class="btn danger" data-ban-user="${esc(m.sender_user_id || '')}" data-banh="${esc(m.sender_handle)}">Ban sender</button>
          </td>
        </tr>`).join('') || '<tr><td colspan="5" class="meta">Nothing here.</td></tr>'}
      </table>`;
      const navBox = document.getElementById('cnav');
      if (d.pages > 1 && url.includes('chat/all')) {
        navBox.innerHTML = `
          <button class="btn" ${page <= 1 ? 'disabled' : ''} id="cprev">← Prev</button>
          <span class="meta">page ${d.page} / ${d.pages} · ${d.total} messages</span>
          <button class="btn" ${page >= d.pages ? 'disabled' : ''} id="cnext">Next →</button>`;
        const prev = document.getElementById('cprev');
        const next = document.getElementById('cnext');
        if (prev) prev.onclick = () => showChatMonitor(page - 1);
        if (next) next.onclick = () => showChatMonitor(page + 1);
      } else navBox.innerHTML = '';
      document.getElementById('ctbl').onclick = async (e) => {
        const b = e.target.closest('button'); if (!b) return;
        try {
          if (b.dataset.del) {
            if (!confirm('Delete this message?')) return;
            await api('/api/admin/chat/delete', { method: 'POST', body: { chat_id: b.dataset.del } });
          } else if (b.dataset.ban !== undefined && b.dataset.ban !== '') {
            if (!confirm('Ban this sender?')) return;
            await api('/api/admin/chat/ban-user', { method: 'POST', body: { user_id: b.dataset.ban } });
          }
          toast('Done'); render(url);
        } catch (err) { toast(err.message); }
      };
    } catch (e) {
      document.getElementById('ctbl').innerHTML = '<p class="meta">' + esc(e.message) + '</p>';
    }
  };

  document.getElementById('csearch').onclick = () => {
    const q = document.getElementById('cq').value.trim();
    if (!q) return toast('Type a chat handle.');
    render('/api/admin/chat/user?handle=' + encodeURIComponent(q));
  };
  document.getElementById('cq').addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('csearch').onclick(); });
  document.getElementById('call').onclick = () => showChatMonitor(1);

  render('/api/admin/chat/all?page=' + page + '&limit=50');
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

async function showBlogBot() {
  const d = await api('/api/admin/blog-bot');
  app.innerHTML = `<div class="card">
    <h3>Desk blog bot</h3>
    <p class="meta">${esc(d.note)}</p>
    <p>Status: <b>${d.on ? 'on' : 'off'}</b> · every ${d.interval_hours} hours · ${d.posts} briefs published · last ${esc(d.last || 'never')}</p>
    <div class="row">
      <button class="btn solid" id="run">Write one now</button>
      <button class="btn" id="tog">${d.on ? 'Pause bot' : 'Turn bot on'}</button>
    </div>
    <div class="warn">Each post cites UGC / Tele-MANAS (or similar) and lists Reddit threads with links. It will never post as an anonymous student or add fake views.</div>
  </div>`;
  document.getElementById('run').onclick = async () => {
    try { const r = await api('/api/admin/blog-bot/run', { method: 'POST', body: {} }); toast('Published: ' + r.title); boot(); }
    catch (e) { toast(e.message); }
  };
  document.getElementById('tog').onclick = async () => {
    try { await api('/api/admin/blog-bot', { method: 'POST', body: { on: !d.on } }); boot(); }
    catch (e) { toast(e.message); }
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
