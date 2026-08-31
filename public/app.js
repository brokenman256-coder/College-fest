const app = document.getElementById('app');
const nav = document.getElementById('nav');
const who = document.getElementById('who');
let META = { sections: [], me: null, payout: {} };

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
function h(html) { const d = document.createElement('div'); d.innerHTML = html; return d; }
function tagFor(p) {
  if (p.source === 'prompt') return '<span class="tag prompt">staff prompt</span>';
  if (p.source === 'reddit') return '<span class="tag reddit">sourced</span>';
  return '<span class="tag">' + p.section + '</span>';
}

async function boot() {
  META = await api('/api/meta');
  who.textContent = META.me ? ('@' + META.me.handle + (META.me.status !== 'active' ? ' · ' + META.me.status : '')) : 'not signed in';
  nav.innerHTML = '';
  const tabs = [
    ['feed', 'Feed'], ['write', 'Write'], ['search', 'Search'], ['events', 'Events'],
    ['sourced', 'Sourced'], ['me', META.me ? 'You' : 'Login']
  ];
  const page = pageName();
  for (const [id, label] of tabs) {
    const b = document.createElement('button');
    b.textContent = label;
    if (page === id) b.classList.add('on');
    b.onclick = () => { location.hash = id; };
    nav.appendChild(b);
  }
  route();
}

function pageName() {
  const hsh = (location.hash || '#feed').slice(1);
  return hsh.split(/[/?]/)[0] || 'feed';
}

function route() {
  const hsh = (location.hash || '#feed').slice(1);
  if (hsh.startsWith('post/')) return showPost(hsh.slice(5));
  const page = pageName();
  if (page === 'write') return showWrite();
  if (page === 'search') return showSearch();
  if (page === 'events') return showEvents();
  if (page === 'sourced') return showSourced();
  if (page === 'me') return showMe();
  showFeed();
}

async function showFeed() {
  const section = new URLSearchParams((location.hash.split('?')[1] || '')).get('section') || 'all';
  const data = await api('/api/feed' + (section !== 'all' ? '?section=' + encodeURIComponent(section) : ''));
  app.innerHTML = `<div class="row" id="sec"></div><div id="list"></div>`;
  const sec = document.getElementById('sec');
  [{ id: 'all', name: 'All' }, ...META.sections].forEach((s) => {
    const b = document.createElement('button');
    b.className = 'btn' + (s.id === section ? ' solid' : '');
    b.textContent = s.name;
    b.onclick = () => { location.hash = 'feed?section=' + s.id; };
    sec.appendChild(b);
  });
  document.getElementById('list').innerHTML = data.posts.map((p) => `
    <article class="card">
      ${tagFor(p)}
      <h3><a href="#post/${p.id}">${esc(p.title)}</a></h3>
      <div class="meta">@${esc(p.handle)} · ${p.unique_views} unique reads · ${p.created_at.slice(0,10)}</div>
      <p>${esc(p.body.slice(0, 240))}${p.body.length > 240 ? '…' : ''}</p>
    </article>`).join('') || '<p class="meta">No posts in this section yet.</p>';
}

async function showPost(id) {
  const { post: p } = await api('/api/posts/' + id);
  app.innerHTML = `<article class="card">
    ${tagFor(p)}
    <h3>${esc(p.title)}</h3>
    <div class="meta">@${esc(p.handle)} · ${p.unique_views} unique reads · ${p.created_at}</div>
    <p style="white-space:pre-wrap">${esc(p.body)}</p>
    ${p.source_url ? `<p class="meta">Source: <a href="${esc(p.source_url)}" target="_blank" rel="noopener">${esc(p.source_url)}</a></p>` : ''}
    <div class="row">
      <button class="btn" id="fol">Follow @${esc(p.handle)}</button>
      <button class="btn danger" id="rep">Report</button>
    </div>
  </article>`;
  document.getElementById('fol').onclick = async () => {
    try { const r = await api('/api/follow/' + encodeURIComponent(p.handle), { method: 'POST', body: {} }); toast('Following. Followers: ' + r.followers); }
    catch (e) { toast(e.message); }
  };
  document.getElementById('rep').onclick = async () => {
    const reason = prompt('Why report this?');
    if (!reason) return;
    try { await api('/api/reports', { method: 'POST', body: { post_id: p.id, reason } }); toast('Reported to the desk.'); }
    catch (e) { toast(e.message); }
  };
}

function showWrite() {
  if (!META.me) { location.hash = 'me'; return; }
  if (META.me.status === 'suspended') {
    app.innerHTML = '<div class="warn">Your account is suspended. You can read, not post.</div>';
    return;
  }
  app.innerHTML = `<div class="card">
    <h3>Write</h3>
    <p class="meta">Other students see your handle, not your email or phone. The desk can still see who you are.</p>
    <label>Section</label>
    <select id="section">${META.sections.map((s) => `<option value="${s.id}">${s.name}</option>`).join('')}</select>
    <label>Title</label><input id="title" maxlength="140">
    <label>What happened / what you learned</label>
    <textarea id="body" rows="8" placeholder="Stick to what you saw. Do not invent. Do not name people just to pile on."></textarea>
    <button class="btn solid" id="pub">Publish</button>
  </div>`;
  document.getElementById('pub').onclick = async () => {
    try {
      const r = await api('/api/posts', { method: 'POST', body: {
        section: document.getElementById('section').value,
        title: document.getElementById('title').value,
        body: document.getElementById('body').value
      }});
      toast(r.note || 'Published');
      location.hash = 'post/' + r.id;
    } catch (e) { toast(e.message); }
  };
}

function showSearch() {
  app.innerHTML = `<div class="card">
    <h3>Search people and posts</h3>
    <p class="meta">Students search by handle. The desk can also search email, phone, and college ID.</p>
    <input id="q" placeholder="handle or words">
    <div id="out"></div>
  </div>`;
  const run = async () => {
    const q = document.getElementById('q').value;
    const d = await api('/api/search?q=' + encodeURIComponent(q));
    document.getElementById('out').innerHTML =
      '<h3>People</h3>' + (d.people.map((p) => `<div class="card">@${esc(p.handle)} · ${p.follower_count} followers ${p.verified ? '· verified' : ''}</div>`).join('') || '<p class="meta">None</p>') +
      '<h3>Posts</h3>' + (d.posts.map((p) => `<div class="card"><a href="#post/${p.id}">${esc(p.title)}</a></div>`).join('') || '<p class="meta">None</p>');
  };
  document.getElementById('q').oninput = debounce(run, 250);
}

async function showEvents() {
  const d = await api('/api/events');
  app.innerHTML = `<div class="warn">Instagram reels are not scraped. Staff can paste a public event here. Connecting a Meta app later is optional and official-API only.</div>` +
    (d.events.map((e) => `<article class="card"><h3>${esc(e.title)}</h3><div class="meta">${esc(e.source || 'staff')} · ${e.created_at.slice(0,10)}</div><p>${esc(e.body)}</p></article>`).join('') || '<p class="meta">No events yet.</p>');
}

async function showSourced() {
  const d = await api('/api/sourced');
  app.innerHTML = `<div class="warn">${esc(d.disclaimer)}</div>` +
    (d.items || []).map((i) => `<article class="card">
      <span class="tag reddit">r/${esc(i.subreddit)}</span>
      <h3><a href="${esc(i.url)}" target="_blank" rel="noopener">${esc(i.title)}</a></h3>
      <p>${esc(i.excerpt || '')}</p>
      <div class="meta">${esc(i.labeled)}</div>
    </article>`).join('') || `<p class="meta">${esc(d.error || 'Nothing sourced right now.')}</p>`;
}

async function showMe() {
  if (!META.me) {
    app.innerHTML = `<div class="grid">
      <div class="card">
        <h3>Student login</h3>
        <p class="meta">College email (.edu / .ac.in) or phone + OTP. Optional college ID. Demo OTP is shown once on this screen.</p>
        <label>College email</label><input id="email" placeholder="you@college.ac.in">
        <label>Phone</label><input id="phone" placeholder="10-digit">
        <label>College ID (optional)</label><input id="cid">
        <button class="btn solid" id="otp">Send OTP</button>
        <div id="otpBox" class="hidden">
          <label>OTP</label><input id="code">
          <button class="btn" id="go">Verify</button>
        </div>
      </div>
      <div class="card">
        <h3>Desk login</h3>
        <p class="meta">Admins use email + password, not OTP.</p>
        <p><a href="/admin">Open admin desk →</a></p>
      </div>
    </div>`;
    document.getElementById('otp').onclick = async () => {
      try {
        const r = await api('/api/auth/request-otp', { method: 'POST', body: {
          email: document.getElementById('email').value,
          phone: document.getElementById('phone').value,
          college_id: document.getElementById('cid').value
        }});
        document.getElementById('otpBox').classList.remove('hidden');
        toast(r.dev_otp ? ('Demo OTP: ' + r.dev_otp) : 'OTP sent');
      } catch (e) { toast(e.message); }
    };
    document.getElementById('go').onclick = async () => {
      try {
        await api('/api/auth/verify-otp', { method: 'POST', body: {
          email: document.getElementById('email').value,
          phone: document.getElementById('phone').value,
          code: document.getElementById('code').value
        }});
        location.hash = 'feed'; boot();
      } catch (e) { toast(e.message); }
    };
    return;
  }
  const d = await api('/api/me');
  const p = d.payout;
  app.innerHTML = `<div class="card">
    <h3>@${esc(d.me.handle)}</h3>
    <div class="meta">Status: ${d.me.status} · followers ${d.me.follower_count}</div>
    <p>Payouts use <b>unique real reads</b> only. Fake view bots are not in this product.</p>
    <p>Need ${p.min_followers} followers and ${p.min_unique_views} unique reads across your posts. You have ${p.followers} / ${p.unique_views}. Estimate $${p.estimated_usd} USDT.</p>
    <label>Crypto wallet</label><input id="wallet" value="${esc(p.wallet || '')}" placeholder="USDT / USDC address">
    <div class="row">
      <button class="btn" id="saveW">Save wallet</button>
      <button class="btn solid" id="pay">Request payout</button>
      <button class="btn danger" id="out">Log out</button>
    </div>
    <h3>Your posts</h3>
    ${d.posts.map((x) => `<div class="meta"><a href="#post/${x.id}">${esc(x.title)}</a> · ${x.unique_views} unique ${x.hidden ? '· hidden' : ''}</div>`).join('') || '<p class="meta">None yet.</p>'}
  </div>`;
  document.getElementById('saveW').onclick = async () => {
    try { await api('/api/me/wallet', { method: 'POST', body: { wallet: document.getElementById('wallet').value } }); toast('Wallet saved'); }
    catch (e) { toast(e.message); }
  };
  document.getElementById('pay').onclick = async () => {
    try { const r = await api('/api/payouts/request', { method: 'POST', body: {} }); toast('Requested $' + r.amount_usd); }
    catch (e) { toast(e.message); }
  };
  document.getElementById('out').onclick = async () => { await api('/api/auth/logout', { method: 'POST', body: {} }); location.hash = 'me'; boot(); };
}

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function debounce(fn, ms) {
  let t; return () => { clearTimeout(t); t = setTimeout(fn, ms); };
}
window.addEventListener('hashchange', () => boot());
boot();
