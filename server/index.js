const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, uid, now, SECTIONS } = require('./db');

const PORT = Number(process.env.PORT || 8787);
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(24).toString('hex');
const PUBLIC = path.join(__dirname, '..', 'public');
const ALLOW_ANY_EMAIL = String(process.env.ALLOW_ANY_EMAIL || 'true') === 'true';
const MIN_FOLLOWERS = 25;
const MIN_UNIQUE_VIEWS = 200;
const USD_PER_VIEW = 0.002;

function ensureAdmin() {
  const email = (process.env.ADMIN_EMAIL || 'admin@campus.local').toLowerCase();
  let admin = db.prepare('SELECT * FROM users WHERE role = ?').get('admin');
  if (admin) return admin;
  const handle = 'desk_' + crypto.randomBytes(3).toString('hex');
  const id = uid('usr');
  db.prepare(
    `INSERT INTO users (id, email, handle, role, status, verified, follower_count, created_at)
     VALUES (?, ?, ?, 'admin', 'active', 1, 0, ?)`
  ).run(id, email, handle, now());
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}
const ADMIN = ensureAdmin();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me-now';

function hash(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}
function hmac(s) {
  return crypto.createHmac('sha256', SECRET).update(String(s)).digest('hex');
}
function timingSafe(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

const otpHits = new Map();
function rateLimit(key, max, windowMs) {
  const t = Date.now();
  const rec = otpHits.get(key) || { n: 0, t };
  if (t - rec.t > windowMs) {
    otpHits.set(key, { n: 1, t });
    return true;
  }
  rec.n++;
  otpHits.set(key, rec);
  return rec.n <= max;
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  raw.split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function send(res, code, body, extra = {}) {
  const json = typeof body === 'string' ? body : JSON.stringify(body);
  const headers = {
    'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
    ...extra
  };
  res.writeHead(code, headers);
  res.end(json);
}

function setSession(res, token) {
  res.setHeader('set-cookie', `cf_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 14}`);
}

function clearSession(res) {
  res.setHeader('set-cookie', 'cf_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
}

function currentUser(req) {
  const token = parseCookies(req).cf_session;
  if (!token) return null;
  const row = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!row || row.expires_at < Date.now()) return null;
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
  return u || null;
}

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    handle: u.handle,
    role: u.role,
    status: u.status,
    verified: !!u.verified,
    follower_count: u.follower_count,
    created_at: u.created_at
  };
}

function adminUser(u) {
  if (!u) return null;
  return {
    ...publicUser(u),
    email: u.email,
    phone: u.phone,
    college_id: u.college_id,
    wallet: u.wallet
  };
}

function isCampusEmail(email) {
  if (ALLOW_ANY_EMAIL) return /.+@.+\..+/.test(email);
  return /@.+(\.edu|\.ac\.in|\.edu\.in)$/i.test(email);
}

function uniqueViewsOf(userId) {
  const row = db.prepare(
    `SELECT COALESCE(SUM(unique_views),0) AS v FROM posts WHERE user_id = ? AND hidden = 0 AND source = 'student'`
  ).get(userId);
  return row.v;
}

function payoutEligible(u) {
  const views = uniqueViewsOf(u.id);
  return {
    ok: u.status === 'active' && u.follower_count >= MIN_FOLLOWERS && views >= MIN_UNIQUE_VIEWS && !!u.wallet,
    followers: u.follower_count,
    min_followers: MIN_FOLLOWERS,
    unique_views: views,
    min_unique_views: MIN_UNIQUE_VIEWS,
    estimated_usd: Math.round(views * USD_PER_VIEW * 100) / 100,
    wallet: u.wallet || null
  };
}

function audit(adminId, action, targetId, detail) {
  db.prepare(
    `INSERT INTO audit_log (id, admin_id, action, target_id, detail, created_at) VALUES (?,?,?,?,?,?)`
  ).run(uid('aud'), adminId, action, targetId || null, detail || null, now());
}

function curatorSection(title, body) {
  const t = (title + ' ' + body).toLowerCase();
  if (/(ragging|harass|assault|stalk|unsafe|guard|night travel|abuse)/.test(t)) return 'safety';
  if (/(hostel|mess|warden|room|pg |rent)/.test(t)) return 'hostels';
  if (/(placement|intern|offer|package|interview|company)/.test(t)) return 'placements';
  if (/(fest|concert|club|event|seminar|workshop)/.test(t)) return 'events';
  if (/(professor|faculty|course|exam|lab|assignment|grade|attendance)/.test(t)) return 'courses';
  return 'confessions';
}

function curatorFlags(title, body) {
  const t = (title + ' ' + body).toLowerCase();
  const flags = [];
  if (/(kill|rape|bomb|suicide)/.test(t)) flags.push('urgent_moderation');
  if (t.length < 40) flags.push('too_short');
  return flags;
}

async function fetchRedditSourced() {
  const url = 'https://www.reddit.com/r/college+Indian_Academia+collegeadvice/hot.json?limit=10';
  const res = await fetch(url, {
    headers: { 'user-agent': 'CollegeFestCampusBoard/1.0 (awareness board; attributed source list)' }
  });
  if (!res.ok) throw new Error('Reddit ' + res.status);
  const data = await res.json();
  const children = (data.data && data.data.children) || [];
  return children.map((c) => {
    const d = c.data || {};
    return {
      id: d.id,
      subreddit: d.subreddit,
      title: d.title,
      excerpt: String(d.selftext || '').slice(0, 280),
      url: 'https://www.reddit.com' + d.permalink,
      score: d.score,
      labeled: 'Sourced from Reddit. This is not a post by a student on this campus.'
    };
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function mime(file) {
  if (file.endsWith('.html')) return 'text/html; charset=utf-8';
  if (file.endsWith('.css')) return 'text/css; charset=utf-8';
  if (file.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (file.endsWith('.svg')) return 'image/svg+xml';
  return 'application/octet-stream';
}

function serveStatic(req, res) {
  let p = req.url.split('?')[0];
  if (p === '/') p = '/index.html';
  if (p === '/admin') p = '/admin.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC)) return send(res, 403, { error: 'no' });
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return false;
  res.writeHead(200, { 'content-type': mime(file), 'x-content-type-options': 'nosniff' });
  fs.createReadStream(file).pipe(res);
  return true;
}

async function handleApi(req, res, url) {
  const u = currentUser(req);
  const method = req.method;
  const pathname = url.pathname;

  if (method === 'GET' && pathname === '/api/health') {
    return send(res, 200, { ok: true, sections: SECTIONS.length });
  }

  if (method === 'GET' && pathname === '/api/meta') {
    return send(res, 200, {
      sections: SECTIONS,
      payout: { min_followers: MIN_FOLLOWERS, min_unique_views: MIN_UNIQUE_VIEWS, usd_per_unique_view: USD_PER_VIEW },
      me: u ? (u.role === 'admin' ? adminUser(u) : publicUser(u)) : null,
      identity: u && u.role === 'admin' ? 'admin' : u ? 'student' : null
    });
  }

  if (method === 'POST' && pathname === '/api/auth/request-otp') {
    const body = await readBody(req);
    const email = String(body.email || '').trim().toLowerCase();
    const phone = String(body.phone || '').replace(/\D/g, '');
    const college_id = String(body.college_id || '').trim();
    const identifier = email || phone;
    if (!identifier) return send(res, 400, { error: 'Use a college email or a phone number.' });
    if (email && !isCampusEmail(email)) return send(res, 400, { error: 'Use a college email (.edu / .ac.in / .edu.in).' });
    if (phone && (phone.length < 10 || phone.length > 15)) return send(res, 400, { error: 'Bad phone number.' });
    if (!rateLimit('otp:' + identifier, 5, 15 * 60 * 1000)) return send(res, 429, { error: 'Too many OTP requests. Wait 15 minutes.' });
    const existing = email
      ? db.prepare('SELECT * FROM users WHERE email = ?').get(email)
      : db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
    if (existing && existing.status === 'banned') return send(res, 403, { error: 'This account is banned.' });
    const code = String(crypto.randomInt(100000, 999999));
    db.prepare('INSERT OR REPLACE INTO otps (identifier, hash, expires_at) VALUES (?,?,?)').run(
      identifier,
      hash(code),
      Date.now() + 10 * 60 * 1000
    );
    if (!existing) {
      const handle = 'anon_' + crypto.randomBytes(3).toString('hex');
      db.prepare(
        `INSERT INTO users (id, email, phone, college_id, handle, role, status, verified, follower_count, created_at)
         VALUES (?,?,?,?,?,'student','active',0,0,?)`
      ).run(uid('usr'), email || null, phone || null, college_id || null, handle, now());
    } else if (college_id && !existing.college_id) {
      db.prepare('UPDATE users SET college_id = ? WHERE id = ?').run(college_id, existing.id);
    }
    const payload = { ok: true, sent_to: email ? email.replace(/(^.).*(@.*$)/, '$1***$2') : 'phone ***' + phone.slice(-4) };
    if (ALLOW_ANY_EMAIL) payload.dev_otp = code;
    return send(res, 200, payload);
  }

  if (method === 'POST' && pathname === '/api/auth/verify-otp') {
    const body = await readBody(req);
    const email = String(body.email || '').trim().toLowerCase();
    const phone = String(body.phone || '').replace(/\D/g, '');
    const identifier = email || phone;
    const code = String(body.code || '').trim();
    const row = db.prepare('SELECT * FROM otps WHERE identifier = ?').get(identifier);
    if (!row || row.expires_at < Date.now() || !timingSafe(row.hash, hash(code))) {
      return send(res, 400, { error: 'Invalid or expired OTP.' });
    }
    db.prepare('DELETE FROM otps WHERE identifier = ?').run(identifier);
    const user = email
      ? db.prepare('SELECT * FROM users WHERE email = ?').get(email)
      : db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
    if (!user) return send(res, 400, { error: 'No account.' });
    if (user.status === 'banned') return send(res, 403, { error: 'This account is banned.' });
    const token = crypto.randomBytes(24).toString('hex');
    db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)').run(
      token,
      user.id,
      Date.now() + 14 * 24 * 60 * 60 * 1000
    );
    setSession(res, token);
    return send(res, 200, { ok: true, me: publicUser(user) });
  }

  if (method === 'POST' && pathname === '/api/auth/admin-login') {
    const body = await readBody(req);
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (email !== String(ADMIN.email).toLowerCase() || !timingSafe(hash(password), hash(ADMIN_PASSWORD))) {
      return send(res, 401, { error: 'Bad admin login.' });
    }
    const token = crypto.randomBytes(24).toString('hex');
    db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)').run(
      token,
      ADMIN.id,
      Date.now() + 14 * 24 * 60 * 60 * 1000
    );
    setSession(res, token);
    audit(ADMIN.id, 'admin_login', ADMIN.id, req.socket.remoteAddress || '');
    return send(res, 200, { ok: true, me: adminUser(ADMIN) });
  }

  if (method === 'POST' && pathname === '/api/auth/logout') {
    const token = parseCookies(req).cf_session;
    if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    clearSession(res);
    return send(res, 200, { ok: true });
  }

  if (method === 'GET' && pathname === '/api/feed') {
    const section = url.searchParams.get('section');
    const q = url.searchParams.get('q');
    let sql = `SELECT p.*, u.handle FROM posts p LEFT JOIN users u ON u.id = p.user_id WHERE p.hidden = 0`;
    const args = [];
    if (section && section !== 'all') {
      sql += ' AND p.section = ?';
      args.push(section);
    }
    if (q) {
      sql += ' AND (p.title LIKE ? OR p.body LIKE ? OR u.handle LIKE ?)';
      args.push('%' + q + '%', '%' + q + '%', '%' + q + '%');
    }
    sql += ' ORDER BY p.created_at DESC LIMIT 80';
    const rows = db.prepare(sql).all(...args);
    return send(res, 200, {
      posts: rows.map((p) => ({
        id: p.id,
        section: p.section,
        title: p.title,
        body: p.body,
        unique_views: p.unique_views,
        source: p.source,
        source_url: p.source_url,
        handle: p.source === 'student' ? p.handle : p.source === 'prompt' ? 'campus_desk' : 'sourced',
        created_at: p.created_at
      }))
    });
  }

  if (method === 'GET' && pathname.startsWith('/api/posts/')) {
    const id = pathname.split('/')[3];
    const p = db.prepare(
      `SELECT p.*, u.handle FROM posts p LEFT JOIN users u ON u.id = p.user_id WHERE p.id = ?`
    ).get(id);
    if (!p || (p.hidden && (!u || u.role !== 'admin'))) return send(res, 404, { error: 'Not found.' });
    const viewerKey = u ? 'u:' + u.id : 'ip:' + hash((req.headers['x-forwarded-for'] || req.socket.remoteAddress || '') + (req.headers['user-agent'] || ''));
    const ins = db.prepare('INSERT OR IGNORE INTO post_views (post_id, viewer_key, created_at) VALUES (?,?,?)').run(
      p.id,
      viewerKey,
      now()
    );
    if (ins.changes) {
      db.prepare('UPDATE posts SET unique_views = unique_views + 1 WHERE id = ?').run(p.id);
      p.unique_views += 1;
    }
    return send(res, 200, {
      post: {
        id: p.id,
        section: p.section,
        title: p.title,
        body: p.body,
        unique_views: p.unique_views,
        source: p.source,
        source_url: p.source_url,
        handle: p.source === 'student' ? p.handle : p.source === 'prompt' ? 'campus_desk' : 'sourced',
        created_at: p.created_at
      }
    });
  }

  if (method === 'POST' && pathname === '/api/posts') {
    if (!u) return send(res, 401, { error: 'Login first.' });
    if (u.status === 'suspended') return send(res, 403, { error: 'Account suspended. You can read, not post.' });
    if (u.status === 'banned') return send(res, 403, { error: 'Banned.' });
    const body = await readBody(req);
    const title = String(body.title || '').trim().slice(0, 140);
    const text = String(body.body || '').trim().slice(0, 8000);
    if (title.length < 8 || text.length < 40) return send(res, 400, { error: 'Write a real post (title 8+, body 40+).' });
    const section = SECTIONS.some((s) => s.id === body.section) ? body.section : curatorSection(title, text);
    const flags = curatorFlags(title, text);
    const id = uid('post');
    db.prepare(
      `INSERT INTO posts (id, user_id, section, title, body, unique_views, source, hidden, created_at)
       VALUES (?, ?, ?, ?, ?, 0, 'student', ?, ?)`
    ).run(id, u.id, section, title, text, flags.includes('urgent_moderation') ? 1 : 0, now());
    return send(res, 200, { ok: true, id, section, flags, note: flags.includes('urgent_moderation') ? 'Hidden for staff review.' : 'Published as ' + u.handle });
  }

  if (method === 'POST' && pathname === '/api/reports') {
    if (!u) return send(res, 401, { error: 'Login first.' });
    const body = await readBody(req);
    const post_id = String(body.post_id || '');
    const reason = String(body.reason || '').trim().slice(0, 400);
    if (!post_id || reason.length < 8) return send(res, 400, { error: 'Say why you are reporting this.' });
    db.prepare(`INSERT INTO reports (id, post_id, reporter_id, reason, created_at) VALUES (?,?,?,?,?)`).run(
      uid('rep'),
      post_id,
      u.id,
      reason,
      now()
    );
    return send(res, 200, { ok: true });
  }

  if (method === 'POST' && pathname.startsWith('/api/follow/')) {
    if (!u) return send(res, 401, { error: 'Login first.' });
    const handle = decodeURIComponent(pathname.split('/')[3] || '');
    const other = db.prepare('SELECT * FROM users WHERE handle = ?').get(handle);
    if (!other || other.id === u.id) return send(res, 400, { error: 'Cannot follow.' });
    const ins = db.prepare('INSERT OR IGNORE INTO follows (follower_id, followee_id, created_at) VALUES (?,?,?)').run(
      u.id,
      other.id,
      now()
    );
    if (ins.changes) {
      db.prepare('UPDATE users SET follower_count = follower_count + 1 WHERE id = ?').run(other.id);
    }
    return send(res, 200, { ok: true, followers: db.prepare('SELECT follower_count FROM users WHERE id = ?').get(other.id).follower_count });
  }

  if (method === 'GET' && pathname === '/api/search') {
    const q = String(url.searchParams.get('q') || '').trim();
    if (q.length < 2) return send(res, 200, { people: [], posts: [] });
    const people = db.prepare(
      `SELECT handle, verified, follower_count, created_at FROM users
       WHERE role = 'student' AND status != 'banned' AND handle LIKE ? LIMIT 20`
    ).all('%' + q + '%');
    const posts = db.prepare(
      `SELECT id, section, title, unique_views, source, created_at FROM posts
       WHERE hidden = 0 AND (title LIKE ? OR body LIKE ?) LIMIT 20`
    ).all('%' + q + '%', '%' + q + '%');
    return send(res, 200, { people, posts });
  }

  if (method === 'GET' && pathname === '/api/me') {
    if (!u) return send(res, 401, { error: 'Login first.' });
    const mine = db.prepare(`SELECT id, section, title, unique_views, created_at, hidden FROM posts WHERE user_id = ? ORDER BY created_at DESC`).all(u.id);
    return send(res, 200, {
      me: u.role === 'admin' ? adminUser(u) : { ...publicUser(u), email: u.email, phone: u.phone, college_id: u.college_id, wallet: u.wallet },
      posts: mine,
      payout: payoutEligible(u)
    });
  }

  if (method === 'POST' && pathname === '/api/me/wallet') {
    if (!u) return send(res, 401, { error: 'Login first.' });
    const body = await readBody(req);
    const wallet = String(body.wallet || '').trim();
    if (wallet.length < 20 || wallet.length > 128) return send(res, 400, { error: 'Paste a crypto wallet address (USDT / USDC).' });
    db.prepare('UPDATE users SET wallet = ? WHERE id = ?').run(wallet, u.id);
    return send(res, 200, { ok: true });
  }

  if (method === 'POST' && pathname === '/api/payouts/request') {
    if (!u) return send(res, 401, { error: 'Login first.' });
    const el = payoutEligible(u);
    if (!el.ok) return send(res, 400, { error: 'Not eligible yet.', payout: el });
    const pending = db.prepare(`SELECT id FROM payouts WHERE user_id = ? AND status IN ('pending','approved')`).get(u.id);
    if (pending) return send(res, 400, { error: 'You already have an open payout request.' });
    const id = uid('pay');
    db.prepare(`INSERT INTO payouts (id, user_id, amount_usd, wallet, status, created_at) VALUES (?,?,?,?, 'pending', ?)`).run(
      id,
      u.id,
      el.estimated_usd,
      u.wallet,
      now()
    );
    return send(res, 200, { ok: true, id, amount_usd: el.estimated_usd });
  }

  if (method === 'GET' && pathname === '/api/sourced') {
    try {
      const items = await fetchRedditSourced();
      return send(res, 200, { items, disclaimer: 'Attributed public posts from Reddit. Not campus confessions. Not rewritten as student stories.' });
    } catch (e) {
      return send(res, 200, { items: [], error: 'Could not reach Reddit right now.', disclaimer: 'Sourced list is optional and always attributed.' });
    }
  }

  if (method === 'GET' && pathname === '/api/events') {
    const rows = db.prepare('SELECT * FROM events ORDER BY created_at DESC LIMIT 40').all();
    return send(res, 200, { events: rows });
  }

  /* ---------- admin ---------- */
  function needAdmin() {
    if (!u || u.role !== 'admin') {
      send(res, 403, { error: 'Admin only.' });
      return false;
    }
    return true;
  }

  if (pathname.startsWith('/api/admin/')) {
    if (!needAdmin()) return;
  }

  if (method === 'GET' && pathname === '/api/admin/overview') {
    const stats = {
      users: db.prepare('SELECT COUNT(*) AS c FROM users WHERE role = ?').get('student').c,
      banned: db.prepare(`SELECT COUNT(*) AS c FROM users WHERE status = 'banned'`).get().c,
      suspended: db.prepare(`SELECT COUNT(*) AS c FROM users WHERE status = 'suspended'`).get().c,
      posts: db.prepare('SELECT COUNT(*) AS c FROM posts').get().c,
      reports: db.prepare('SELECT COUNT(*) AS c FROM reports').get().c,
      pending_payouts: db.prepare(`SELECT COUNT(*) AS c FROM payouts WHERE status = 'pending'`).get().c
    };
    return send(res, 200, { stats });
  }

  if (method === 'GET' && pathname === '/api/admin/users') {
    const q = String(url.searchParams.get('q') || '').trim();
    let sql = `SELECT * FROM users WHERE role = 'student'`;
    const args = [];
    if (q) {
      sql += ' AND (handle LIKE ? OR email LIKE ? OR phone LIKE ? OR college_id LIKE ?)';
      args.push('%' + q + '%', '%' + q + '%', '%' + q + '%', '%' + q + '%');
    }
    sql += ' ORDER BY created_at DESC LIMIT 200';
    return send(res, 200, { users: db.prepare(sql).all(...args).map(adminUser) });
  }

  if (method === 'POST' && pathname === '/api/admin/user-status') {
    const body = await readBody(req);
    const id = String(body.id || '');
    const status = String(body.status || '');
    if (!['active', 'suspended', 'banned'].includes(status)) return send(res, 400, { error: 'Bad status.' });
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!target || target.role === 'admin') return send(res, 400, { error: 'Cannot change that account.' });
    db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, id);
    if (status === 'banned') db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    audit(u.id, 'set_status', id, status);
    return send(res, 200, { ok: true, user: adminUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id)) });
  }

  if (method === 'POST' && pathname === '/api/admin/verify') {
    const body = await readBody(req);
    const id = String(body.id || '');
    db.prepare('UPDATE users SET verified = 1 WHERE id = ?').run(id);
    audit(u.id, 'verify', id, 'college_id_ok');
    return send(res, 200, { ok: true });
  }

  if (method === 'GET' && pathname === '/api/admin/posts') {
    const rows = db.prepare(
      `SELECT p.*, u.handle, u.email FROM posts p LEFT JOIN users u ON u.id = p.user_id ORDER BY p.created_at DESC LIMIT 200`
    ).all();
    return send(res, 200, { posts: rows });
  }

  if (method === 'POST' && pathname === '/api/admin/hide-post') {
    const body = await readBody(req);
    const id = String(body.id || '');
    const hidden = body.hidden ? 1 : 0;
    db.prepare('UPDATE posts SET hidden = ? WHERE id = ?').run(hidden, id);
    audit(u.id, hidden ? 'hide_post' : 'unhide_post', id, '');
    return send(res, 200, { ok: true });
  }

  if (method === 'GET' && pathname === '/api/admin/payouts') {
    const rows = db.prepare(
      `SELECT p.*, u.handle, u.email, u.follower_count FROM payouts p JOIN users u ON u.id = p.user_id ORDER BY p.created_at DESC`
    ).all();
    return send(res, 200, { payouts: rows });
  }

  if (method === 'POST' && pathname === '/api/admin/payout-status') {
    const body = await readBody(req);
    const id = String(body.id || '');
    const status = String(body.status || '');
    if (!['approved', 'paid', 'rejected', 'pending'].includes(status)) return send(res, 400, { error: 'Bad status.' });
    db.prepare('UPDATE payouts SET status = ? WHERE id = ?').run(status, id);
    audit(u.id, 'payout_' + status, id, '');
    return send(res, 200, { ok: true });
  }

  if (method === 'GET' && pathname === '/api/admin/reports') {
    const rows = db.prepare(
      `SELECT r.*, p.title, u.handle AS reporter_handle FROM reports r
       LEFT JOIN posts p ON p.id = r.post_id
       LEFT JOIN users u ON u.id = r.reporter_id
       ORDER BY r.created_at DESC LIMIT 200`
    ).all();
    return send(res, 200, { reports: rows });
  }

  if (method === 'GET' && pathname === '/api/admin/audit') {
    const rows = db.prepare('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 200').all();
    return send(res, 200, { audit: rows });
  }

  if (method === 'POST' && pathname === '/api/admin/event') {
    const body = await readBody(req);
    const title = String(body.title || '').trim();
    const text = String(body.body || '').trim();
    const source = String(body.source || 'staff').trim();
    if (title.length < 4 || text.length < 10) return send(res, 400, { error: 'Need title and details.' });
    const id = uid('evt');
    db.prepare(`INSERT INTO events (id, title, body, source, created_at) VALUES (?,?,?,?,?)`).run(id, title, text, source, now());
    audit(u.id, 'add_event', id, source);
    return send(res, 200, { ok: true, id });
  }

  if (method === 'POST' && pathname === '/api/admin/prompt') {
    const body = await readBody(req);
    const section = SECTIONS.some((s) => s.id === body.section) ? body.section : 'safety';
    const title = String(body.title || 'Discussion starter').trim().slice(0, 140);
    const text = String(body.body || '').trim();
    if (text.length < 40) return send(res, 400, { error: 'Prompt body too short.' });
    const labeled = text.startsWith('Staff prompt') ? text : 'Staff prompt — not a student confession.\n\n' + text;
    const id = uid('post');
    db.prepare(
      `INSERT INTO posts (id, user_id, section, title, body, unique_views, source, hidden, created_at)
       VALUES (?, NULL, ?, ?, ?, 0, 'prompt', 0, ?)`
    ).run(id, section, title, labeled, now());
    audit(u.id, 'desk_prompt', id, section);
    return send(res, 200, { ok: true, id });
  }

  return send(res, 404, { error: 'Unknown API route.' });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (serveStatic(req, res)) return;
    send(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) send(res, 500, { error: 'Server error' });
  }
});

server.listen(PORT, () => {
  console.log('College Fest board on http://localhost:' + PORT);
  console.log('Student site  http://localhost:' + PORT + '/');
  console.log('Admin desk    http://localhost:' + PORT + '/admin');
  console.log('Admin email   ' + ADMIN.email);
});
