const app = document.getElementById('app');
const nav = document.getElementById('nav');
const who = document.getElementById('who');
const authRoot = document.getElementById('auth');
const shell = document.getElementById('shell');
let META = { sections: [], me: null, payout: {}, chat_handle: null };
let chatPoll = null;

function toast(t) {
  const el = document.getElementById('toast');
  el.textContent = t; el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2600);
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
function esc(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function tagFor(p) {
  if (p.source === 'prompt') return '<span class="section-label prompt">staff prompt</span>';
  if (p.source === 'bot') return '<span class="section-label quill">🪶 quill brief · anonymous</span>';
  if (p.source === 'reddit') return '<span class="section-label reddit">sourced</span>';
  return '<span class="section-label">' + esc(p.section) + '</span>';
}
function stopChatPoll() {
  if (chatPoll) { clearInterval(chatPoll); chatPoll = null; }
}

/* ---- privacy shield: blur chats when window loses focus, tab-switch, or PrintScreen ---- */
let chatViewOpen = false;
function shield(on, why) {
  if (on) { document.body.classList.add('shield'); if (why) toast(why); }
  else document.body.classList.remove('shield');
}
function shieldTick() { shield(chatViewOpen && document.hidden); }
window.addEventListener('blur', () => { if (chatViewOpen) shield(true); });
window.addEventListener('focus', () => { if (chatViewOpen && !document.hidden) setTimeout(() => shield(false), 200); });
document.addEventListener('visibilitychange', () => {
  if (chatViewOpen) shield(document.hidden, document.hidden ? 'Chat hidden — privacy shield' : '');
});
window.addEventListener('keyup', (e) => {
  if (chatViewOpen && e.key === 'PrintScreen') {
    shield(true, 'Screenshot blocked — privacy shield');
    try { navigator.clipboard.writeText(' '); } catch (err) {}
    setTimeout(() => shield(false), 1600);
  }
});
document.addEventListener('contextmenu', (e) => {
  if (e.target && e.target.closest && e.target.closest('.chat-main')) e.preventDefault();
});
function readingTime(body) {
  const mins = Math.max(1, Math.round(String(body || '').split(/\s+/).length / 200));
  return mins + ' min read';
}
function initials(handle) {
  return String(handle || '?').replace(/^@?/, '').slice(0, 1).toUpperCase();
}
function avatarFor(handle) {
  const h = String(handle || '');
  if (h === 'The Midnight Quill') return '🪶';
  if (/^anonymous#\d+$/i.test(h) || h === 'campus_desk') return '🎭';
  return initials(h);
}
function isSpyMail(email) {
  return /(gmail|googlemail|yahoo|hotmail|outlook|live\.|msn|icloud|me\.com|aol|proton|gmx|mail\.ru|yandex|qq\.com|rediffmail|zoho)/i.test(String(email));
}
function isCollegeEmail(email) {
  return /^@(?:[a-z0-9-]+\.)+(edu|edu\.in|edu\.au|edu\.pk|ac\.in|ac\.uk)$/i.test('@' + String(email).split('@').pop());
}
function anonLink(handle) {
  return '#u/' + encodeURIComponent(handle);
}
function bylineHTML(p) {
  const h = esc(p.handle);
  const name = p.source === 'student'
    ? `<a class="anon-link" href="${anonLink(p.handle)}">@${h}</a>`
    : `<b>${h}</b>`;
  const uni = p.university ? `<span class="dot">·</span><span class="uni-tag">${esc(p.university)}</span>` : '';
  return `<span class="avatar">${esc(avatarFor(p.handle))}</span>${name}${uni}`;
}

/* ================= AUTH GATE (anonymous — email only, no OTP, no password) ================= */
function renderAuth() {
  shell.classList.add('hidden');
  authRoot.classList.remove('hidden');
  authRoot.innerHTML = `
  <div class="auth-wrap">
    <div class="auth-hero">
      <a class="brand" href="#" onclick="return false">College Fest</a>
      <h1>Your campus. <em>Anonymous.</em> Always.</h1>
      <p>No names. No passwords. No OTP codes. One university email — and you disappear behind a mask.</p>
      <ul class="auth-points">
        <li>You appear as <b>anonymous#12</b> — everyone looks identical</li>
        <li>Your email is <b>encrypted</b> and never shown to anyone</li>
        <li>No tracking: no IP logs, no analytics, no fingerprinting</li>
        <li>Follow people, like them, DM them — all anonymous</li>
      </ul>
    </div>
    <div class="auth-card">
      <h2>Log in with your university email</h2>
      <label>University email <span class="req">*</span></label>
      <input id="email" placeholder="you@university.edu" autocomplete="off">
      <div id="emailHint" class="fine hidden" style="margin-top:6px;color:var(--danger)"></div>
      <div class="anon-note">
        🔒 <b>This will stay anonymous.</b> We only check that your email is a real university
        address (.edu / .edu.in / .ac.in) — we never show it, never share it, never track it.
        Your posts, likes, follows and chats are visible only as your anonymous# mask.
        Personal mailboxes (Gmail, Outlook…) are blocked to keep this student-only.
      </div>
      <button class="btn accent" id="go" style="width:100%;margin-top:12px">Enter anonymously →</button>
      <div class="fine" style="margin-top:12px">No verification email. No password to forget. New email? You get a fresh mask instantly.</div>
    </div>
  </div>`;
  const req = authRoot.querySelectorAll('.req');
  req.forEach((el) => { el.style.color = 'var(--accent)'; el.style.fontWeight = '700'; });

  const inp = document.getElementById('email');
  const hint = document.getElementById('emailHint');
  inp.addEventListener('input', () => {
    const v = inp.value.trim().toLowerCase();
    hint.classList.add('hidden');
    if (v.includes('@') && isSpyMail(v)) {
      hint.textContent = 'That is a personal mailbox (spy mail). Use your university .edu email.';
      hint.classList.remove('hidden');
    } else if (v.includes('@') && v.split('@')[1] && !isCollegeEmail(v)) {
      hint.textContent = 'Hmm — that does not look like a university email (.edu / .edu.in / .ac.in).';
      hint.classList.remove('hidden');
    }
  });

  async function login() {
    const email = inp.value.trim().toLowerCase();
    if (!email) return toast('Enter your university email.');
    if (isSpyMail(email)) return toast('No personal mail — use your university .edu email.');
    try {
      const r = await api('/api/auth/login', { method: 'POST', body: { email } });
      toast(r.created ? 'Mask on: @' + r.me.handle : 'Welcome back, @' + r.me.handle);
      boot();
    } catch (e) { toast(e.message); }
  }
  document.getElementById('go').onclick = login;
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });
}

/* ================= MAIN APP ================= */
async function boot() {
  META = await api('/api/meta');
  if (!META.me) return renderAuth();
  if (META.me.role === 'admin') return showAdminChooser();
  paintLogo();
  authRoot.classList.add('hidden');
  shell.classList.remove('hidden');
  who.innerHTML = '<b>@' + esc(META.me.handle) + '</b>' + (META.me.status !== 'active' ? ' · ' + esc(META.me.status) : '');
  nav.innerHTML = '';
  const tabs = [
    ['feed', 'Stories'], ['write', 'Write'], ['chat', 'Chat'], ['search', 'Search'], ['events', 'Events'],
    ['sourced', 'Sourced'], ['earn', 'Earn'], ['me', 'You']
  ];
  const page = pageName();
  for (const [id, label] of tabs) {
    const b = document.createElement('button');
    b.textContent = label;
    b.id = 'tab-' + id;
    if (page === id) b.classList.add('on');
    b.onclick = () => { location.hash = id; };
    nav.appendChild(b);
  }
  route();
  updateChatBadge();
}

function paintLogo() {
  const a = document.querySelector('header.top h1 a');
  if (!a) return;
  if (META.site_logo) {
    a.classList.add('has-logo');
    if (!a.querySelector('img')) {
      const img = document.createElement('img');
      img.className = 'logo-img';
      img.alt = '';
      img.src = META.site_logo;
      a.prepend(img);
    }
  }
  // bosses get a permanent desk switch in the header — students never see this
  if (META.me && META.me.role === 'admin' && !document.getElementById('deskLink')) {
    const b = document.createElement('button');
    b.id = 'deskLink';
    b.className = 'btn mini';
    b.textContent = 'Desk →';
    b.onclick = () => { location.href = '/admin'; };
    who.appendChild(b);
  }
}

function showAdminChooser() {
  shell.classList.add('hidden');
  authRoot.classList.remove('hidden');
  authRoot.innerHTML = `
  <div class="admin-choose">
    <div class="auth-card" style="max-width:420px;margin:12vh auto">
      <h2>Welcome back, boss ⚡</h2>
      <p class="meta">Only admin accounts see this choice. Pick where to go:</p>
      <div class="row" style="margin-top:14px">
        <button class="btn accent" id="chDesk" style="flex:1">🛠 Open Admin Desk</button>
        <button class="btn" id="chStudent" style="flex:1">Continue as student</button>
      </div>
    </div>
  </div>`;
  document.getElementById('chDesk').onclick = () => { location.href = '/admin'; };
  document.getElementById('chStudent').onclick = () => {
    authRoot.classList.add('hidden');
    shell.classList.remove('hidden');
    paintLogo();
    who.innerHTML = '<b>@' + esc(META.me.handle) + '</b> ';
    nav.innerHTML = '';
    const tabs = [
      ['feed', 'Stories'], ['write', 'Write'], ['chat', 'Chat'], ['search', 'Search'], ['events', 'Events'],
      ['sourced', 'Sourced'], ['earn', 'Earn'], ['me', 'You']
    ];
    const page = pageName();
    for (const [id, label] of tabs) {
      const b = document.createElement('button');
      b.textContent = label;
      b.id = 'tab-' + id;
      if (page === id) b.classList.add('on');
      b.onclick = () => { location.hash = id; };
      nav.appendChild(b);
    }
    route();
    updateChatBadge();
  };
}

async function updateChatBadge() {
  stopChatPoll();
  if (!META.me) return;
  try {
    const d = await api('/api/chat/unread');
    paintBadge(d.unread);
    chatPoll = setInterval(async () => {
      try { paintBadge((await api('/api/chat/unread')).unread); } catch (e) {}
    }, 8000);
  } catch (e) {}
}
function paintBadge(n) {
  const b = document.getElementById('tab-chat');
  if (b) b.innerHTML = 'Chat' + (n ? ' <span class="badge-dot">' + n + '</span>' : '');
}

function pageName() {
  const hsh = (location.hash || '#feed').slice(1);
  return hsh.split(/[/?]/)[0] || 'feed';
}

function route() {
  stopChatPoll();
  if (!META.me) return renderAuth();
  const hsh = (location.hash || '#feed').slice(1);
  chatViewOpen = pageName() === 'chat';
  if (hsh.startsWith('post/')) return showPost(hsh.slice(5));
  if (hsh.startsWith('u/')) return showProfile(decodeURIComponent(hsh.slice(2)));
  const page = pageName();
  if (page === 'write') return showWrite();
  if (page === 'search') return showSearch();
  if (page === 'events') return showEvents();
  if (page === 'sourced') return showSourced();
  if (page === 'me') return showMe();
  if (page === 'earn') return showEarn();
  if (page === 'chat') return showChat();
  showFeed();
}

async function showFeed() {
  const section = new URLSearchParams((location.hash.split('?')[1] || '')).get('section') || 'all';
  const data = await api('/api/feed' + (section !== 'all' ? '?section=' + encodeURIComponent(section) : ''));
  const promo = (META.campaigns || [])[0];
  app.innerHTML = `
    ${promo ? `<div class="promo"><div><b>${esc(promo.title)}</b><span>${esc(promo.body)}</span></div><button class="promo-cta" id="promoCta">${esc(promo.cta || 'Start writing')}</button></div>` : ''}
    <div class="row" id="sec" style="margin:14px 0 6px"></div><div id="list"></div>`;
  if (promo) {
    document.getElementById('promoCta').onclick = () => {
      location.hash = promo.cta_link === 'earn' ? 'earn' : promo.cta_link === 'feed' ? 'feed' : 'write';
    };
  }
  const sec = document.getElementById('sec');
  [{ id: 'all', name: 'All' }, ...META.sections].forEach((s) => {
    const b = document.createElement('button');
    b.className = 'btn mini' + (s.id === section ? ' solid' : '');
    b.textContent = s.name;
    b.onclick = () => { location.hash = 'feed?section=' + s.id; };
    sec.appendChild(b);
  });
  document.getElementById('list').innerHTML = data.posts.map((p) => `
    <article class="card post-card">
      ${tagFor(p)}
      <h2><a href="#post/${esc(p.id)}">${esc(p.title)}</a></h2>
      <div class="byline">
        ${bylineHTML(p)}<span class="dot">·</span>
        <span>${p.created_at.slice(0, 10)}</span><span class="dot">·</span>
        <span>${readingTime(p.body)}</span><span class="dot">·</span>
        <span class="mono">${p.unique_views} reads</span><span class="dot">·</span>
        <span class="mono">♥ ${p.likes || 0}</span>
      </div>
      <p class="excerpt">${esc(p.body.slice(0, 220))}${p.body.length > 220 ? '…' : ''}</p>
    </article>`).join('') || '<p class="meta" style="padding:30px 0">No stories in this section yet. Be the first to <a href="#write">write one</a>.</p>';
}

async function showPost(id) {
  const { post: p } = await api('/api/posts/' + id);
  const mine = META.me && p.handle === META.me.handle;
  app.innerHTML = `<article class="card post-full">
    ${tagFor(p)}
    <h1>${esc(p.title)}</h1>
    <div class="byline" style="margin:10px 0 4px">
      ${bylineHTML(p)}<span class="dot">·</span>
      <span class="mono">${esc(p.created_at)}</span><span class="dot">·</span>
      <span class="mono">${p.unique_views} unique reads</span><span class="dot">·</span>
      <span>${readingTime(p.body)}</span>
    </div>
    <div class="body">${esc(p.body)}</div>
    ${p.source_url ? `<p class="meta">Source: <a href="${esc(p.source_url)}" target="_blank" rel="noopener">${esc(p.source_url)}</a></p>` : ''}
    <div class="post-actions">
      <button class="btn ${p.liked_by_me ? 'accent liked' : ''}" id="like">${p.liked_by_me ? '♥' : '♡'} ${p.likes || 0}</button>
      ${p.source === 'student' && !mine ? `<button class="btn" id="fol">@ Follow ${esc(p.handle)}</button><button class="btn" id="dm">💬 DM</button>` : ''}
      <button class="btn mini" id="rep">Report</button>
      <span style="flex:1"></span>
      <button class="btn mini" id="shW">WhatsApp</button>
      <button class="btn mini" id="shX">X</button>
      <button class="btn mini" id="shC">Copy link</button>
    </div>
  </article>`;
  const shareUrl = location.origin + location.pathname + '#post/' + p.id;
  const shareText = encodeURIComponent(p.title + ' — College Fest');
  document.getElementById('like').onclick = async () => {
    try {
      const r = await api('/api/posts/' + p.id + '/like', { method: 'POST', body: {} });
      const b = document.getElementById('like');
      b.textContent = (r.liked ? '♥' : '♡') + ' ' + r.likes;
      b.classList.toggle('accent', r.liked);
      b.classList.toggle('liked', r.liked);
      toast(r.liked ? 'Liked ♥' : 'Like removed');
    } catch (e) { toast(e.message); }
  };
  document.getElementById('shW').onclick = () => window.open('https://wa.me/?text=' + shareText + '%20' + encodeURIComponent(shareUrl), '_blank', 'noopener');
  document.getElementById('shX').onclick = () => window.open('https://twitter.com/intent/tweet?text=' + shareText + '&url=' + encodeURIComponent(shareUrl), '_blank', 'noopener');
  document.getElementById('shC').onclick = async () => {
    try { await navigator.clipboard.writeText(shareUrl); toast('Link copied'); }
    catch (e) { toast(shareUrl); }
  };
  if (document.getElementById('fol')) {
    document.getElementById('fol').onclick = async () => {
      try {
        const r = await api('/api/follow/' + encodeURIComponent(p.handle), { method: 'POST', body: {} });
        document.getElementById('fol').textContent = (r.following ? '✓ Following ' : '@ Follow ') + p.handle;
        toast(r.following ? 'Following anonymously' : 'Unfollowed');
      } catch (e) { toast(e.message); }
    };
    document.getElementById('dm').onclick = () => { location.hash = 'chat'; setTimeout(() => openConversation(p.handle), 400); };
  }
  document.getElementById('rep').onclick = async () => {
    const reason = prompt('Why report this?');
    if (!reason) return;
    try { await api('/api/reports', { method: 'POST', body: { post_id: p.id, reason } }); toast('Reported to the desk.'); }
    catch (e) { toast(e.message); }
  };
}

function showWrite() {
  if (META.me.status === 'suspended') {
    app.innerHTML = '<div class="warn">Your account is suspended. You can read, not post.</div>';
    return;
  }
  app.innerHTML = `<div class="card" style="max-width:720px;margin:26px auto">
    <h3 style="font-size:26px">Write a story</h3>
    <p class="meta">Published as <b>🎭 @${esc(META.me.handle)}</b> — readers never see your email. Only your university is attached so others can search it.</p>
    <label>Section</label>
    <select id="section">${META.sections.map((s) => `<option value="${s.id}">${s.name}</option>`).join('')}</select>
    <label>University name <span class="req">*</span></label>
    <input id="university" value="${esc(META.me.college_name || '')}" placeholder="e.g. MIT, NYU, University of Michigan" maxlength="120">
    <div class="fine" style="margin-bottom:12px">Readers will find this story when they search incidents at this university.</div>
    <label>Title</label><input id="title" maxlength="140" placeholder="Give it a real headline">
    <label>Story</label>
    <textarea id="body" rows="10" placeholder="Stick to what you saw at your university. Do not invent. Do not name people just to pile on."></textarea>
    <button class="btn accent" id="pub">Publish story</button>
  </div>`;
  document.getElementById('pub').onclick = async () => {
    try {
      const r = await api('/api/posts', { method: 'POST', body: {
        section: document.getElementById('section').value,
        university: document.getElementById('university').value,
        title: document.getElementById('title').value,
        body: document.getElementById('body').value
      }});
      toast(r.note || 'Published');
      location.hash = 'post/' + r.id;
    } catch (e) { toast(e.message); }
  };
}

/* ---------------- chat: town hall (public) + DMs ---------------- */
function showChat() {
  app.innerHTML = `<div class="chat-layout">
    <div class="chat-side">
      <div class="card room-card" id="roomCard">
        <h3>Town hall <span class="meta">public room</span></h3>
        <p class="meta">Everyone on campus in one room. Handles only — the desk moderates.</p>
      </div>
      <div class="card">
        <h3>Your chat handle</h3>
        <div class="row">
          <code class="handle-chip" id="myHandle">${esc(META.chat_handle || '—')}</code>
          <button class="btn mini" id="copyHandle">copy</button>
        </div>
        <p class="meta">Share this handle to receive anonymous messages. It reveals nothing about you.</p>
        <h3 style="font-size:16px">Start a direct chat</h3>
        <input id="newChat" placeholder="anonymous#11 or ch_xxxxxxxxxx">
        <button class="btn accent" id="startChat">Open chat</button>
      </div>
      <div class="card">
        <h3>Direct chats</h3>
        <div id="contacts"><p class="meta">Loading…</p></div>
      </div>
    </div>
    <div class="chat-main card" id="chatMain"><p class="meta">Loading…</p></div>
  </div>`;
  document.getElementById('roomCard').onclick = openRoom;
  document.getElementById('copyHandle').onclick = () => {
    navigator.clipboard && navigator.clipboard.writeText(META.chat_handle || '');
    toast('Chat handle copied');
  };
  document.getElementById('startChat').onclick = () => {
    const v = document.getElementById('newChat').value.trim();
    if (!/^anonymous#\d+$/i.test(v) && !/^ch_[0-9a-f]{10}$/.test(v)) return toast('Use a handle like anonymous#11 or ch_xxxxxxxxxx');
    openConversation(v);
  };
  renderContacts();
  openRoom();
}

function chatComposer(inputId, filePrefix, onPush) {
  const fileInput = document.getElementById(filePrefix + 'File');
  document.getElementById(filePrefix + 'Attach').onclick = () => fileInput.click();
  fileInput.onchange = (e) => {
    const f = e.target.files[0];
    if (!f) return;
    if (!window.openImageEditor) return toast('Editor missing');
    openImageEditor(f, async (dataUrl) => {
      toast('Uploading photo…');
      try {
        const r = await api('/api/chat/upload-image', { method: 'POST', body: { image_data: dataUrl } });
        await onPush({ message: document.getElementById(inputId).value.trim(), image_url: r.url });
        document.getElementById(inputId).value = '';
        toast('Photo sent');
      } catch (err) { toast(err.message); }
    });
  };
  document.getElementById(filePrefix + 'Send').onclick = () => {
    const inp = document.getElementById(inputId);
    const v = inp.value.trim();
    if (!v) return;
    inp.value = '';
    onPush({ message: v });
  };
  document.getElementById(inputId).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById(filePrefix + 'Send').onclick();
  });
}

async function openRoom() {
  stopChatPoll();
  const main = document.getElementById('chatMain');
  if (!main) return;
  main.innerHTML = `
    <div class="chat-head"><span class="neon-title">Town hall</span><span class="meta">public room · be decent · desk can remove messages</span></div>
    <div class="chat-msgs" id="roomMsgs"><p class="meta">Loading…</p></div>
    <div class="chat-input">
      <input type="file" id="roomFile" accept="image/*" class="hidden">
      <button class="btn mini" id="roomAttach">📷</button>
      <input id="roomText" placeholder="Say something to the whole campus…" maxlength="1000">
      <button class="btn accent mini" id="roomSend">Send</button>
    </div>`;
  let lastCount = -1;

  async function load() {
    try {
      const d = await api('/api/room/history');
      if (!document.getElementById('roomMsgs')) return;
      if (d.messages.length === lastCount) return;
      lastCount = d.messages.length;
      document.getElementById('roomMsgs').innerHTML = d.messages.map((m) => `
        <div class="bubble ${m.sender_handle === d.me ? 'me' : 'them'}">
          ${m.sender_handle !== d.me ? `<div class="room-who">@${esc(m.sender_handle)}</div>` : ''}
          ${m.image_url ? `<img class="msg-img" src="${esc(m.image_url)}" alt="photo">` : ''}
          ${m.message ? `<p>${esc(m.message)}</p>` : ''}
          <span class="meta">${esc((m.timestamp || '').slice(0, 16).replace('T', ' '))}</span>
        </div>`).join('') || '<p class="meta">No messages yet. Start the conversation.</p>';
      const box = document.getElementById('roomMsgs');
      box.scrollTop = box.scrollHeight;
    } catch (e) {
      const b = document.getElementById('roomMsgs');
      if (b) b.innerHTML = '<p class="meta">' + esc(e.message) + '</p>';
    }
  }
  await load();
  chatPoll = setInterval(load, 4000);

  chatComposer('roomText', 'room', async (body) => {
    try {
      await api('/api/room/send', { method: 'POST', body });
      lastCount = -1;
      await load();
    } catch (e) { toast(e.message); }
  });
}

async function renderContacts() {
  try {
    const d = await api('/api/chat/contacts');
    const box = document.getElementById('contacts');
    if (!box) return;
    box.innerHTML = d.contacts.length
      ? d.contacts.map((c) => `<div class="contact ${c.unread ? 'unread' : ''}" data-h="${esc(c.handle)}">
          <b>@${esc(c.handle)}</b>
          <div class="meta">${c.from_me ? 'you: ' : ''}${esc(c.last)}${c.unread ? ' · <span class="neon-mention">●' + c.unread + '</span>' : ''}</div>
        </div>`).join('')
      : '<p class="meta">No chats yet. Share your handle or open one.</p>';
    box.querySelectorAll('.contact').forEach((c) => { c.onclick = () => openConversation(c.dataset.h); });
  } catch (e) {
    const box = document.getElementById('contacts');
    if (box) box.innerHTML = '<p class="meta">' + esc(e.message) + '</p>';
  }
}

async function openConversation(handle) {
  stopChatPoll();
  const main = document.getElementById('chatMain');
  if (!main) return;
  main.innerHTML = `
    <div class="chat-head"><span class="neon-title">@${esc(handle)}</span><span class="meta">anonymous · visible to the desk for safety</span></div>
    <div class="chat-msgs" id="msgs"><p class="meta">Loading…</p></div>
    <div class="chat-input">
      <input type="file" id="chatFile" accept="image/*" class="hidden">
      <button class="btn mini" id="attach">📷</button>
      <input id="chatText" placeholder="Type a message…" maxlength="2000">
      <button class="btn accent mini" id="sendMsg">Send</button>
    </div>`;
  let lastCount = -1;

  async function load() {
    try {
      const d = await api('/api/chat/history/' + encodeURIComponent(handle));
      if (!document.getElementById('msgs')) return;
      if (d.messages.length === lastCount) return;
      lastCount = d.messages.length;
      document.getElementById('msgs').innerHTML = d.messages.map((m) => `
        <div class="bubble ${m.sender_handle === d.me ? 'me' : 'them'}">
          ${m.image_url ? `<img class="msg-img" src="${esc(m.image_url)}" alt="photo">` : ''}
          ${m.message ? `<p>${esc(m.message)}</p>` : ''}
          <span class="meta">${esc((m.timestamp || '').slice(0, 16).replace('T', ' '))}</span>
        </div>`).join('') || '<p class="meta">No messages yet. Say hi.</p>';
      const box = document.getElementById('msgs');
      box.scrollTop = box.scrollHeight;
    } catch (e) {
      const b = document.getElementById('msgs');
      if (b) b.innerHTML = '<p class="meta">' + esc(e.message) + '</p>';
    }
  }
  await load();
  chatPoll = setInterval(load, 4000);

  async function push(body) {
    try {
      await api('/api/chat/send', { method: 'POST', body: { receiver_handle: handle, ...body } });
      lastCount = -1;
      await load();
      updateChatBadge();
    } catch (e) { toast(e.message); }
  }
  document.getElementById('sendMsg').onclick = () => {
    const inp = document.getElementById('chatText');
    const v = inp.value.trim();
    if (!v) return;
    inp.value = '';
    push({ message: v });
  };
  document.getElementById('chatText').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('sendMsg').onclick();
  });
  document.getElementById('attach').onclick = () => document.getElementById('chatFile').click();
  document.getElementById('chatFile').onchange = (e) => {
    const f = e.target.files[0];
    if (!f) return;
    if (!window.openImageEditor) return toast('Editor missing');
    openImageEditor(f, async (dataUrl) => {
      toast('Uploading photo…');
      try {
        const r = await api('/api/chat/upload-image', { method: 'POST', body: { image_data: dataUrl } });
        await push({ message: document.getElementById('chatText').value.trim(), image_url: r.url });
        document.getElementById('chatText').value = '';
        toast('Photo sent');
      } catch (err) { toast(err.message); }
    });
  };
}

/* ---------------- search: incidents at any university ---------------- */
async function showSearch() {
  let unis = [];
  try { unis = (await api('/api/universities')).universities; } catch (e) {}
  app.innerHTML = `<div class="card" style="max-width:680px;margin:26px auto">
    <h3>Search incidents &amp; records by university</h3>
    <p class="meta">Search what really happened at any university — safety records, dorm life, courses, internships. Everything stays anonymous.</p>
    <label>University</label>
    <input id="uni" list="uniList" placeholder="e.g. MIT, NYU — or pick from the list">
    <datalist id="uniList">${unis.map((x) => `<option value="${esc(x.name)}">${x.stories} stories</option>`).join('')}</datalist>
    <label>Keyword</label>
    <input id="q" placeholder="hazing, fire alarm, professor, internship…">
    ${unis.length ? `<div class="row" style="flex-wrap:wrap;margin:10px 0 0">${unis.slice(0, 8).map((x) => `<button class="btn mini uni-chip" data-u="${esc(x.name)}">${esc(x.name)} <span class="mono">${x.stories}</span></button>`).join('')}</div>` : ''}
    <div id="out"></div>
  </div>`;
  app.querySelectorAll('.uni-chip').forEach((b) => {
    b.onclick = () => { document.getElementById('uni').value = b.dataset.u; run(); };
  });
  const run = async () => {
    const q = document.getElementById('q').value.trim();
    const uni = document.getElementById('uni').value.trim();
    if (q.length < 2 && uni.length < 2) { document.getElementById('out').innerHTML = ''; return; }
    const d = await api('/api/search?q=' + encodeURIComponent(q) + '&university=' + encodeURIComponent(uni));
    document.getElementById('out').innerHTML =
      '<h3>People</h3>' + (d.people.map((p) => `<div class="card person-row"><a href="${anonLink(p.handle)}">🎭 @${esc(p.handle)}</a> · ${p.follower_count} followers · ♥ ${p.likes_count || 0}${p.college_name ? ' · ' + esc(p.college_name) : ''}</div>`).join('') || '<p class="meta">None</p>') +
      '<h3>Stories</h3>' + (d.posts.map((p) => `<div class="card"><a href="#post/${esc(p.id)}">${esc(p.title)}</a><div class="meta">${esc(p.university || 'unknown university')} · ${p.unique_views} reads · ${p.created_at.slice(0, 10)}</div></div>`).join('') || '<p class="meta">None</p>');
  };
  document.getElementById('q').oninput = debounce(run, 250);
  document.getElementById('uni').oninput = debounce(run, 250);
}

/* ---------------- user profile: follow, like, chat ---------------- */
async function showProfile(handle) {
  if (!/^anonymous#\d+$/i.test(handle) && handle !== 'campus_desk' && !/^ch_[0-9a-f]{10}$/.test(handle)) {
    app.innerHTML = '<div class="card">No such user.</div>';
    return;
  }
  let d;
  try { d = await api('/api/users/' + encodeURIComponent(handle)); }
  catch (e) { app.innerHTML = `<div class="card">${esc(e.message)}</div>`; return; }
  const u2 = d.user;
  const mine = META.me && u2.handle === META.me.handle;
  app.innerHTML = `<div style="max-width:680px;margin:26px auto">
    <div class="card profile-head">
      <span class="avatar big">🎭</span>
      <div>
        <h3 style="font-size:26px;margin:0">@${esc(u2.handle)}</h3>
        <div class="meta">${esc(u2.college_name || 'university unknown')} · joined ${esc((u2.created_at || '').slice(0, 10))}</div>
        <div class="row" style="margin-top:10px">
          <span class="mono"><b>${u2.follower_count}</b> followers</span><span class="dot">·</span>
          <span class="mono"><b>${u2.likes_count || 0}</b> likes</span><span class="dot">·</span>
          <span class="mono"><b>${d.posts.length}</b> stories</span>
        </div>
        ${!mine ? `<div class="row" style="margin-top:14px">
          <button class="btn ${u2.followed_by_me ? '' : 'accent'}" id="pfFollow">${u2.followed_by_me ? '✓ Following' : '@ Follow'}</button>
          <button class="btn ${u2.liked_by_me ? 'accent' : ''}" id="pfLike">${u2.liked_by_me ? '♥ Liked' : '♡ Like'} (${u2.likes_count || 0})</button>
          <button class="btn" id="pfChat">💬 Chat</button>
        </div>` : '<div class="meta" style="margin-top:10px">This is you. Others see only this mask — nothing else.</div>'}
      </div>
    </div>
    <h3 style="margin:20px 0 8px">Stories by @${esc(u2.handle)}</h3>
    ${d.posts.map((p) => `
      <article class="card post-card">
        ${tagFor(p)}
        <h2><a href="#post/${esc(p.id)}">${esc(p.title)}</a></h2>
        <div class="byline">${bylineHTML(p)}<span class="dot">·</span><span>${p.created_at.slice(0, 10)}</span><span class="dot">·</span><span class="mono">${p.unique_views} reads</span><span class="dot">·</span><span class="mono">♥ ${p.likes || 0}</span></div>
        <p class="excerpt">${esc(p.body.slice(0, 180))}${p.body.length > 180 ? '…' : ''}</p>
      </article>`).join('') || '<p class="meta">No stories yet.</p>'}
  </div>`;
  if (!mine) {
    document.getElementById('pfFollow').onclick = async () => {
      try {
        const r = await api('/api/follow/' + encodeURIComponent(u2.handle), { method: 'POST', body: {} });
        toast(r.following ? 'Following anonymously' : 'Unfollowed');
        showProfile(handle);
      } catch (e) { toast(e.message); }
    };
    document.getElementById('pfLike').onclick = async () => {
      try {
        const r = await api('/api/users/' + encodeURIComponent(u2.handle) + '/like', { method: 'POST', body: {} });
        toast(r.liked ? 'Liked ♥' : 'Like removed');
        showProfile(handle);
      } catch (e) { toast(e.message); }
    };
    document.getElementById('pfChat').onclick = () => {
      location.hash = 'chat';
      setTimeout(() => openConversation(u2.chat_handle || u2.handle), 400);
    };
  }
}

async function showEvents() {
  const d = await api('/api/events');
  app.innerHTML = `<div class="warn">Campus events are posted by staff. Connecting a Meta app later is optional and official-API only.</div>` +
    (d.events.map((e) => `<article class="card"><h3>${esc(e.title)}</h3><div class="meta">${esc(e.source || 'staff')} · ${e.created_at.slice(0,10)}</div><p>${esc(e.body)}</p></article>`).join('') || '<p class="meta">No events yet.</p>');
}

async function showSourced() {
  const d = await api('/api/sourced');
  app.innerHTML = `<div class="warn">${esc(d.disclaimer)}</div>` +
    (d.items || []).map((i) => `<article class="card post-card">
      <span class="section-label reddit">r/${esc(i.subreddit)}</span>
      <h2><a href="${esc(i.url)}" target="_blank" rel="noopener">${esc(i.title)}</a></h2>
      <p class="excerpt">${esc(i.excerpt || '')}</p>
      <div class="meta">${esc(i.labeled)}</div>
    </article>`).join('') || `<p class="meta">${esc(d.error || 'Nothing sourced right now.')}</p>`;
}

/* ---------------- earn (payout milestone) ---------------- */
function milestoneRow(done, label, sub) {
  return `<div class="milestone ${done ? 'done' : ''}">
    <div class="tick">${done ? '✓' : '○'}</div>
    <div><div class="m-label">${label}</div><div class="m-sub">${sub}</div></div>
  </div>`;
}

async function showEarn() {
  const d = await api('/api/me');
  const p = d.payout;
  const pct = Math.min(100, Math.round((p.estimated_usd / p.min_payout_usd) * 100));
  const allDone = p.estimated_usd >= p.min_payout_usd && p.followers >= p.min_followers && p.unique_views >= p.min_unique_views && !!p.wallet;
  app.innerHTML = `<div style="max-width:640px;margin:26px auto">
    <div class="balance-box">
      <div class="usd">$${p.estimated_usd.toFixed(2)}</div>
      <div class="cap">earned from ${p.unique_views} unique real reads · $${(p.usd_per_view || 0.002).toFixed(3)} per read</div>
      <div class="progress"><i style="width:${Math.min(100, (p.estimated_usd / p.min_payout_usd) * 100)}%"></i></div>
      <div class="cap">withdrawal unlocks at <b>$${p.min_payout_usd}</b> — $${Math.max(0, p.min_payout_usd - p.estimated_usd).toFixed(2)} to go</div>
    </div>
    <div class="milestones">
      <div class="milestone ${p.followers >= p.min_followers ? 'done' : ''}">
        <div class="tick">${p.followers >= p.min_followers ? '✓' : '○'}</div>
        <div><div class="m-label">${p.followers} / ${p.min_followers} followers</div>
        <div class="progress small"><i style="width:${Math.min(100, (p.followers / p.min_followers) * 100)}%"></i></div></div>
      </div>
      <div class="milestone ${p.unique_views >= p.min_unique_views ? 'done' : ''}">
        <div class="tick">${p.unique_views >= p.min_unique_views ? '✓' : '○'}</div>
        <div><div class="m-label">${p.unique_views} / ${p.min_unique_views} unique reads</div>
        <div class="progress small"><i style="width:${Math.min(100, (p.unique_views / p.min_unique_views) * 100)}%"></i></div></div>
      </div>
      <div class="milestone ${p.estimated_usd >= p.min_payout_usd ? 'done' : ''}">
        <div class="tick">${p.estimated_usd >= p.min_payout_usd ? '✓' : '○'}</div>
        <div><div class="m-label">Earn $${p.min_payout_usd}+</div>
        <div class="m-sub">minimum withdrawal is $${p.min_payout_usd}</div></div>
      </div>
      <div class="milestone ${p.wallet ? 'done' : ''}">
        <div class="tick">${p.wallet ? '✓' : '○'}</div>
        <div><div class="m-label">Wallet saved</div>
        <div class="m-sub">${p.wallet ? esc(p.wallet.slice(0, 8)) + '…' : 'add your USDT / USDC address below'}</div></div>
      </div>
    </div>
    <div class="card">
      <h3>Crypto wallet</h3>
      <label>USDT / USDC address</label>
      <input id="wallet" value="${esc(p.wallet || '')}" placeholder="0x… or T…">
      <div class="row">
        <button class="btn" id="saveW">Save wallet</button>
        <button class="btn accent" id="pay" ${allDone ? '' : 'disabled'} title="${allDone ? '' : 'Complete all milestones first'}">Request payout</button>
        ${allDone ? '' : '<span class="meta">Complete every milestone above to unlock payout.</span>'}
      </div>
      <p class="fine" style="margin-top:10px">Payouts count <b>unique real reads only</b>. Fake views never count — the desk reviews every request before it is paid.</p>
    </div>
  </div>`;
  document.getElementById('saveW').onclick = async () => {
    try { await api('/api/me/wallet', { method: 'POST', body: { wallet: document.getElementById('wallet').value } }); toast('Wallet saved'); showEarn(); }
    catch (e) { toast(e.message); }
  };
  document.getElementById('pay').onclick = async () => {
    try { const r = await api('/api/payouts/request', { method: 'POST', body: {} }); toast('Payout requested: $' + r.amount_usd); showEarn(); }
    catch (e) { toast(e.message); }
  };
}

/* ---------------- you ---------------- */
async function showMe() {
  const d = await api('/api/me');
  app.innerHTML = `<div style="max-width:640px;margin:26px auto">
    <div class="card">
      <h3 style="font-size:26px">🎭 @${esc(d.me.handle)}</h3>
      <div class="meta">This is your mask — it's all anyone sees. ${d.me.college_name ? 'University: ' + esc(d.me.college_name) + ' · ' : ''}Status: ${esc(d.me.status)} · followers ${d.me.follower_count} · likes ${d.me.likes_count || 0}</div>
      <div class="anon-note" style="margin-top:10px">🔒 Your email is stored encrypted and is never shown to anyone. We keep no IP logs. Your stories, likes, follows and chats carry only this mask.</div>
      <div class="row" style="margin-top:12px">
        <code class="handle-chip">chat: ${esc(META.chat_handle || '—')}</code>
        <button class="btn mini" id="copyChat">copy</button>
        <span class="spacer" style="flex:1"></span>
        <button class="btn" id="earnLink">Go to Earn →</button>
      </div>
      <h3 style="margin-top:18px">Your stories</h3>
      ${d.posts.map((x) => `<div class="meta" style="padding:4px 0"><a href="#post/${esc(x.id)}">${esc(x.title)}</a> · ${x.unique_views} reads ${x.hidden ? '· hidden' : ''}</div>`).join('') || '<p class="meta">None yet — <a href="#write">write your first story</a>.</p>'}
      <div class="row" style="margin-top:16px">
        <button class="btn danger" id="out">Log out</button>
      </div>
    </div>
  </div>`;
  document.getElementById('copyChat').onclick = () => {
    navigator.clipboard && navigator.clipboard.writeText(META.chat_handle || '');
    toast('Chat handle copied');
  };
  document.getElementById('earnLink').onclick = () => { location.hash = 'earn'; };
  document.getElementById('out').onclick = async () => { await api('/api/auth/logout', { method: 'POST', body: {} }); location.hash = ''; boot(); };
}

function debounce(fn, ms) {
  let t; return () => { clearTimeout(t); t = setTimeout(fn, ms); };
}
window.addEventListener('hashchange', () => boot());
boot();