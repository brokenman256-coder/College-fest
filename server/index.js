const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, uid, now, SECTIONS, connectDB, getSetting, setSetting } = require('./db');
const blogBot = require('./blogBot');
const campaignBot = require('./campaignBot');
const chatBot = require('./chatBot');
require('dotenv').config();

const PORT = Number(process.env.PORT || 8787);
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(24).toString('hex');
const PUBLIC = path.join(__dirname, '..', 'public');
const ALLOW_ANY_EMAIL = String(process.env.ALLOW_ANY_EMAIL || 'true') === 'true';
const MIN_FOLLOWERS = 25;
const MIN_UNIQUE_VIEWS = 200;
const USD_PER_VIEW = 0.002;
const MIN_PAYOUT_USD = 100; // withdrawal milestone — smaller requests are not paid out

let ADMIN = null;

/* ---------- email privacy: emails are encrypted at rest and stored as a
   hash for login lookup. A database dump alone cannot reveal who anyone is. ---------- */
const EMAIL_KEY = crypto.createHash('sha256').update('email-at-rest:' + (process.env.SESSION_SECRET || 'collegefest')).digest();
function encryptEmail(email) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', EMAIL_KEY, iv);
  const enc = Buffer.concat([c.update(String(email), 'utf8'), c.final()]);
  return iv.toString('base64') + ':' + c.getAuthTag().toString('base64') + ':' + enc.toString('base64');
}
function decryptEmail(payload) {
  try {
    const [ivB64, tagB64, encB64] = String(payload).split(':');
    const d = crypto.createDecipheriv('aes-256-gcm', EMAIL_KEY, Buffer.from(ivB64, 'base64'));
    d.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([d.update(Buffer.from(encB64, 'base64')), d.final()]).toString('utf8');
  } catch (e) { return null; }
}
function emailHash(email) {
  return hash('em:' + String(email).trim().toLowerCase());
}

/* university identity derived from the email domain — never stored against a name */
function universityFromEmail(email) {
  const dom = String(email).split('@')[1] || '';
  const core = dom.split('.').slice(0, -1).join(' ').trim();
  return core ? core.toUpperCase() : null;
}

/* "spy mail" — personal mailboxes are always rejected */
const SPY_MAIL = /(gmail|googlemail|yahoo|ymail|rocketmail|hotmail|outlook|live\.|msn|icloud|me\.com|mac\.com|aol|proton|tutanota|gmx|mail\.ru|yandex|qq\.com|163\.com|126\.com|rediffmail|zoho)/i;
function isSpyMail(email) { return SPY_MAIL.test(String(email)); }
function isCampusEmail(email) {
  if (ALLOW_ANY_EMAIL) return /.+@.+\..+/.test(email) && !isSpyMail(email);
  return /@(?:[a-z0-9-]+\.)+(edu|edu\.in|edu\.au|edu\.pk|ac\.in|ac\.uk)$/i.test(String(email)) && !isSpyMail(email);
}

/* everyone looks the same: anonymous#11, anonymous#12, ... */
async function nextAnonHandle() {
  const r = await db.collection('settings').findOneAndUpdate(
    { _id: 'anon_seq' },
    { $inc: { value: 1 } },
    { upsert: true, returnDocument: 'after' }
  );
  const raw = r && r.value;
  const n = raw && typeof raw === 'object' ? Number(raw.value) || 1 : Number(raw) || 1;
  return 'anonymous#' + n;
}

async function ensureAdmin() {
  const email = (process.env.ADMIN_EMAIL || 'admin@campus.local').toLowerCase();
  let admin = await db.collection('users').findOne({ role: 'admin' });
  if (admin) return admin;
  const id = uid('usr');
  await db.collection('users').insertOne({
    _id: id,
    email_enc: encryptEmail(email),
    email_hash: emailHash(email),
    phone: null,
    college_id: null,
    college_name: null,
    state: null,
    place: null,
    handle: 'desk',
    role: 'admin',
    status: 'active',
    verified: true,
    follower_count: 0,
    likes_count: 0,
    wallet: null,
    created_at: now()
  });
  return db.collection('users').findOne({ _id: id });
}

function hash(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
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
    'x-frame-options': 'DENY',
    'permissions-policy': 'geolocation=(), camera=(), microphone=(), interest-cohort=()',
    'cross-origin-opener-policy': 'same-origin',
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

async function currentUser(req) {
  const token = parseCookies(req).cf_session;
  if (!token) return null;
  const row = await db.collection('sessions').findOne({ token });
  if (!row || row.expires_at < Date.now()) return null;
  return db.collection('users').findOne({ _id: row.user_id });
}

function postHandle(p) {
  if (p.source === 'student') return p.handle || 'anonymous';
  if (p.source === 'prompt') return 'campus_desk';
  if (p.source === 'bot') return blogBot.BOT_NAME;
  return 'sourced';
}

function publicUser(u) {
  if (!u) return null;
  return {
    id: u._id,
    handle: u.handle,
    role: u.role,
    status: u.status,
    verified: !!u.verified,
    follower_count: u.follower_count || 0,
    likes_count: u.likes_count || 0,
    points: u.points || 0,
    college_name: u.college_name || null,
    created_at: u.created_at
  };
}

function adminUser(u) {
  if (!u) return null;
  return {
    ...publicUser(u),
    email: u.email_enc ? decryptEmail(u.email_enc) : (u.email || null),
    college_id: u.college_id,
    wallet: u.wallet
  };
}

function pubPost(p) {
  return {
    id: p._id,
    section: p.section,
    title: p.title,
    body: p.body,
    university: p.university || null,
    unique_views: p.unique_views || 0,
    likes: p.likes || 0,
    source: p.source,
    source_url: p.source_url,
    handle: postHandle(p),
    created_at: p.created_at,
    hidden: !!p.hidden
  };
}

async function uniqueViewsOf(userId) {
  const r = await db.collection('posts').aggregate([
    { $match: { user_id: userId, hidden: { $ne: true }, source: 'student' } },
    { $group: { _id: null, v: { $sum: { $ifNull: ['$unique_views', 0] } } } }
  ]).toArray();
  return r.length ? r[0].v : 0;
}

async function payoutEligible(u) {
  const views = await uniqueViewsOf(u._id);
  return {
    ok: u.status === 'active' && (u.follower_count || 0) >= MIN_FOLLOWERS && views >= MIN_UNIQUE_VIEWS && Math.round(views * USD_PER_VIEW * 100) / 100 >= MIN_PAYOUT_USD && !!u.wallet,
    followers: u.follower_count || 0,
    min_followers: MIN_FOLLOWERS,
    unique_views: views,
    min_unique_views: MIN_UNIQUE_VIEWS,
    estimated_usd: Math.round(views * USD_PER_VIEW * 100) / 100,
    min_payout_usd: MIN_PAYOUT_USD,
    wallet: u.wallet || null
  };
}

async function audit(adminId, action, targetId, detail) {
  await db.collection('audit_log').insertOne({
    _id: uid('aud'),
    admin_id: adminId,
    action,
    target_id: targetId || null,
    detail: detail || null,
    created_at: now()
  });
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
  if (file.endsWith('.png')) return 'image/png';
  if (file.endsWith('.jpg') || file.endsWith('.jpeg')) return 'image/jpeg';
  if (file.endsWith('.gif')) return 'image/gif';
  if (file.endsWith('.webp')) return 'image/webp';
  if (file.endsWith('.ico')) return 'image/x-icon';
  return 'application/octet-stream';
}

function serveStatic(req, res) {
  let p = req.url.split('?')[0];
  if (p === '/') p = '/index.html';
  if (p === '/admin') p = '/admin.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC)) return send(res, 403, { error: 'no' });
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return false;
  res.writeHead(200, {
    'content-type': mime(file),
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'geolocation=(), camera=(), microphone=(), interest-cohort=()',
    'cross-origin-opener-policy': 'same-origin'
  });
  fs.createReadStream(file).pipe(res);
  return true;
}

function rx(needle) {
  return { $regex: String(needle).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
}

async function handleApi(req, res, url) {
  const u = await currentUser(req);
  const method = req.method;
  const pathname = url.pathname;

  if (method === 'GET' && pathname === '/api/health') {
    return send(res, 200, { ok: true, sections: SECTIONS.length });
  }

  if (method === 'GET' && pathname === '/api/meta') {
    return send(res, 200, {
      sections: SECTIONS,
      payout: { min_followers: MIN_FOLLOWERS, min_unique_views: MIN_UNIQUE_VIEWS, usd_per_unique_view: USD_PER_VIEW, min_payout_usd: MIN_PAYOUT_USD },
      me: u ? (u.role === 'admin' ? adminUser(u) : publicUser(u)) : null,
      chat_handle: u ? await chatBot.getChatHandle(u._id) : null,
      campaigns: (await db.collection('campaigns').find({ on: true }).sort({ created_at: -1 }).limit(3)
        .project({ title: 1, body: 1, cta: 1, cta_link: 1 }).toArray()),
      site_logo: await getSetting('site_logo', ''),
      identity: u && u.role === 'admin' ? 'admin' : u ? 'student' : null
    });
  }

  if (method === 'POST' && pathname === '/api/auth/login') {
    const body = await readBody(req);
    const email = String(body.email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return send(res, 400, { error: 'Enter your university email.' });
    if (isSpyMail(email)) return send(res, 400, { error: 'That is a personal mailbox (Gmail / Outlook etc.) — not allowed here. Use your university email so everyone stays anonymous.' });
    if (!isCampusEmail(email)) return send(res, 400, { error: 'Use your university email — it should end in .edu (or .edu.in / .ac.in).' });
    if (!rateLimit('login:' + emailHash(email), 15, 10 * 60 * 1000)) return send(res, 429, { error: 'Too many attempts. Wait a few minutes.' });
    const ehash = emailHash(email);
    let user = await db.collection('users').findOne({ email_hash: ehash });
    let created = false;
    if (user && user.status === 'banned') return send(res, 403, { error: 'This account is banned.' });
    if (!user) {
      const handle = await nextAnonHandle();
      const allow = await db.collection('admin_allowlist').findOne({ email });
      const id = uid('usr');
      await db.collection('users').insertOne({
        _id: id,
        email_enc: encryptEmail(email),
        email_hash: ehash,
        phone: null,
        college_id: null,
        college_name: universityFromEmail(email),
        state: null,
        place: null,
        handle,
        role: allow ? 'admin' : 'student',
        status: 'active',
        verified: false,
        follower_count: 0,
        likes_count: 0,
        wallet: null,
        created_at: now()
      });
      user = await db.collection('users').findOne({ _id: id });
      created = true;
    }
    const token = crypto.randomBytes(24).toString('hex');
    await db.collection('sessions').insertOne({
      token,
      user_id: user._id,
      expires_at: Date.now() + 14 * 24 * 60 * 60 * 1000
    });
    setSession(res, token);
    return send(res, 200, { ok: true, created, me: publicUser(user) });
  }

  if (method === 'POST' && pathname === '/api/auth/admin-login') {
    const body = await readBody(req);
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const adminEmail = String(process.env.ADMIN_EMAIL || '').toLowerCase();
    if (!ADMIN || email !== adminEmail || !timingSafe(hash(password), hash(process.env.ADMIN_PASSWORD || ''))) {
      return send(res, 401, { error: 'Bad admin login.' });
    }
    const token = crypto.randomBytes(24).toString('hex');
    await db.collection('sessions').insertOne({
      token,
      user_id: ADMIN._id,
      expires_at: Date.now() + 14 * 24 * 60 * 60 * 1000
    });
    setSession(res, token);
    await audit(ADMIN._id, 'admin_login', ADMIN._id, ''); // no IPs stored — tracking-free by design
    return send(res, 200, { ok: true, me: adminUser(ADMIN) });
  }

  if (method === 'POST' && pathname === '/api/auth/logout') {
    const token = parseCookies(req).cf_session;
    if (token) await db.collection('sessions').deleteOne({ token });
    clearSession(res);
    return send(res, 200, { ok: true });
  }

  if (method === 'GET' && pathname === '/api/feed') {
    if (!u) return send(res, 401, { error: 'Sign up to read the board.' });
    const section = url.searchParams.get('section');
    const q = url.searchParams.get('q');
    const match = { hidden: { $ne: true } };
    if (section && section !== 'all') match.section = section;
    const pipeline = [
      { $match: match },
      { $lookup: { from: 'users', localField: 'user_id', foreignField: '_id', as: 'u' } },
      { $addFields: { handle: { $arrayElemAt: ['$u.handle', 0] } } }
    ];
    if (q) {
      pipeline.push({ $match: { $or: [{ title: rx(q) }, { body: rx(q) }, { handle: rx(q) }] } });
    }
    pipeline.push({ $sort: { created_at: -1 } }, { $limit: 80 });
    const rows = await db.collection('posts').aggregate(pipeline).toArray();
    let likedSet = new Set();
    if (u && rows.length) {
      const likes = await db.collection('post_likes').find(
        { user_id: u._id, post_id: { $in: rows.map((r) => r._id) } },
        { projection: { post_id: 1 } }
      ).toArray();
      likedSet = new Set(likes.map((l) => l.post_id));
    }
    return send(res, 200, { posts: rows.map((p) => ({ ...pubPost(p), liked_by_me: likedSet.has(p._id) })) });
  }

  if (method === 'GET' && pathname.startsWith('/api/posts/')) {
    if (!u) return send(res, 401, { error: 'Sign up to read the board.' });
    const id = pathname.split('/')[3];
    const p = await db.collection('posts').findOne({ _id: id });
    if (!p || (p.hidden && (!u || u.role !== 'admin'))) return send(res, 404, { error: 'Not found.' });
    // resolve the author's current anonymous handle onto the post
    if (p.user_id) {
      const au = await db.collection('users').findOne({ _id: p.user_id }, { projection: { handle: 1, college_name: 1 } });
      if (au) { p.handle = au.handle; if (!p.university) p.university = au.college_name || null; }
    }
    const viewerKey = u ? 'u:' + u._id : 'ip:' + hash((req.headers['x-forwarded-for'] || req.socket.remoteAddress || '') + (req.headers['user-agent'] || ''));
    const ins = await db.collection('post_views').updateOne(
      { post_id: id, viewer_key: viewerKey },
      { $setOnInsert: { post_id: id, viewer_key: viewerKey, created_at: now() } },
      { upsert: true }
    );
    if (ins.upsertedCount) {
      await db.collection('posts').updateOne({ _id: id }, { $inc: { unique_views: 1 } });
      p.unique_views = (p.unique_views || 0) + 1;
    }
    const liked = u ? !!(await db.collection('post_likes').findOne({ post_id: id, user_id: u._id })) : false;
    return send(res, 200, { post: { ...pubPost(p), liked_by_me: liked } });
  }

  if (method === 'POST' && /^\/api\/posts\/[^/]+\/like$/.test(pathname)) {
    if (!u) return send(res, 401, { error: 'Login first.' });
    if (u.status === 'banned') return send(res, 403, { error: 'Banned.' });
    const id = pathname.split('/')[3];
    const p = await db.collection('posts').findOne({ _id: id });
    if (!p || (p.hidden && u.role !== 'admin')) return send(res, 404, { error: 'Not found.' });
    const key = { post_id: id, user_id: u._id };
    const existing = await db.collection('post_likes').findOne(key);
    let liked;
    if (existing) {
      await db.collection('post_likes').deleteOne(key);
      await db.collection('posts').updateOne({ _id: id }, { $inc: { likes: -1 } });
      liked = false;
    } else {
      await db.collection('post_likes').updateOne(
        key,
        { $setOnInsert: { ...key, created_at: now() } },
        { upsert: true }
      );
      await db.collection('posts').updateOne({ _id: id }, { $inc: { likes: 1 } });
      liked = true;
    }
    const fresh = await db.collection('posts').findOne({ _id: id }, { projection: { likes: 1, user_id: 1 } });
    // points: a like on a story gives its author +1 point
    if (fresh && fresh.user_id) {
      await db.collection('users').updateOne({ _id: fresh.user_id }, { $inc: { points: liked ? 1 : -1 } });
    }
    return send(res, 200, { ok: true, likes: Math.max(0, fresh.likes || 0), liked });
  }

  if (method === 'POST' && pathname === '/api/posts') {
    if (!u) return send(res, 401, { error: 'Login first.' });
    if (u.status === 'suspended') return send(res, 403, { error: 'Account suspended. You can read, not post.' });
    if (u.status === 'banned') return send(res, 403, { error: 'Banned.' });
    const body = await readBody(req);
    const title = String(body.title || '').trim().slice(0, 140);
    const text = String(body.body || '').trim().slice(0, 8000);
    if (title.length < 8 || text.length < 40) return send(res, 400, { error: 'Write a real post (title 8+, body 40+).' });
    // university name is asked at write time — pre-filled from the email domain, correctable
    const university = String(body.university || '').trim().slice(0, 120) || u.college_name || null;
    if (university && university !== u.college_name) {
      await db.collection('users').updateOne({ _id: u._id }, { $set: { college_name: university } });
      u.college_name = university;
    }
    const section = SECTIONS.some((s) => s.id === body.section) ? body.section : curatorSection(title, text);
    const flags = curatorFlags(title, text);
    const id = uid('post');
    await db.collection('posts').insertOne({
      _id: id,
      user_id: u._id,
      section,
      title,
      body: text,
      university,
      unique_views: 0,
      likes: 0,
      source: 'student',
      source_url: null,
      hidden: flags.includes('urgent_moderation'),
      created_at: now()
    });
    return send(res, 200, { ok: true, id, section, flags, note: flags.includes('urgent_moderation') ? 'Hidden for staff review.' : 'Published as ' + u.handle });
  }

  if (method === 'POST' && pathname === '/api/reports') {
    if (!u) return send(res, 401, { error: 'Login first.' });
    const body = await readBody(req);
    const post_id = String(body.post_id || '');
    const reason = String(body.reason || '').trim().slice(0, 400);
    if (!post_id || reason.length < 8) return send(res, 400, { error: 'Say why you are reporting this.' });
    await db.collection('reports').insertOne({
      _id: uid('rep'),
      post_id,
      reporter_id: u._id,
      reason,
      created_at: now()
    });
    return send(res, 200, { ok: true });
  }

  if (method === 'POST' && pathname.startsWith('/api/follow/')) {
    if (!u) return send(res, 401, { error: 'Login first.' });
    const handle = decodeURIComponent(pathname.split('/')[3] || '');
    const other = await db.collection('users').findOne({ handle });
    if (!other || other._id === u._id) return send(res, 400, { error: 'Cannot follow.' });
    const key = { follower_id: u._id, followee_id: other._id };
    const existing = await db.collection('follows').findOne(key);
    let following;
    if (existing) {
      await db.collection('follows').deleteOne(key);
      await db.collection('users').updateOne({ _id: other._id }, { $inc: { follower_count: -1 } });
      other.follower_count = Math.max(0, (other.follower_count || 0) - 1);
      following = false;
    } else {
      await db.collection('follows').updateOne(key, { $setOnInsert: { ...key, created_at: now() } }, { upsert: true });
      await db.collection('users').updateOne({ _id: other._id }, { $inc: { follower_count: 1 } });
      other.follower_count = (other.follower_count || 0) + 1;
      following = true;
    }
    return send(res, 200, { ok: true, followers: other.follower_count, following });
  }

  if (method === 'GET' && pathname === '/api/search') {
    if (!u) return send(res, 401, { error: 'Login first.' });
    const q = String(url.searchParams.get('q') || '').trim();
    const uni = String(url.searchParams.get('university') || '').trim();
    if (q.length < 2 && uni.length < 2) return send(res, 200, { people: [], posts: [] });
    const postQuery = { hidden: { $ne: true } };
    if (uni) postQuery.university = rx(uni);
    if (q) postQuery.$or = [{ title: rx(q) }, { body: rx(q) }];
    const people = q
      ? await db.collection('users').find(
        { role: 'student', status: { $ne: 'banned' }, handle: rx(q) },
        { projection: { handle: 1, verified: 1, follower_count: 1, likes_count: 1, college_name: 1, created_at: 1 } }
      ).limit(20).toArray()
      : [];
    const posts = await db.collection('posts').find(
      postQuery,
      { projection: { section: 1, title: 1, university: 1, unique_views: 1, source: 1, created_at: 1 } }
    ).sort({ created_at: -1 }).limit(30).toArray();
    return send(res, 200, {
      people: people.map((p) => ({ id: p._id, ...publicUser(p) })),
      posts: posts.map((p) => ({ id: p._id, ...p, _id: undefined }))
    });
  }

  if (method === 'GET' && pathname === '/api/universities') {
    const list = await db.collection('posts').aggregate([
      { $match: { hidden: { $ne: true }, university: { $nin: [null, ''] } } },
      { $group: { _id: '$university', stories: { $sum: 1 }, reads: { $sum: '$unique_views' } } },
      { $sort: { stories: -1 } },
      { $limit: 60 }
    ]).toArray();
    return send(res, 200, { universities: list.map((x) => ({ name: x._id, stories: x.stories, reads: x.reads })) });
  }

  /* ---------- user profiles: follow + like people, reddit-style ---------- */
  if (method === 'GET' && pathname.startsWith('/api/users/') && pathname.split('/').length === 4) {
    const handle = decodeURIComponent(pathname.split('/')[3] || '');
    const target = await db.collection('users').findOne({ handle });
    if (!target || (target.status === 'banned' && (!u || u.role !== 'admin'))) return send(res, 404, { error: 'No such user.' });
    const posts = await db.collection('posts')
      .find({ user_id: target._id, hidden: { $ne: true } })
      .sort({ created_at: -1 }).limit(30).toArray();
    const [followed, liked] = u ? await Promise.all([
      db.collection('follows').findOne({ follower_id: u._id, followee_id: target._id }),
      db.collection('user_likes').findOne({ user_id: u._id, target_id: target._id })
    ]) : [null, null];
    return send(res, 200, {
      user: {
        ...publicUser(target),
        chat_handle: await chatBot.getChatHandle(target._id),
        followed_by_me: !!followed,
        liked_by_me: !!liked
      },
      posts: posts.map((p) => pubPost({ ...p, handle: target.handle }))
    });
  }

  if (method === 'POST' && /^\/api\/users\/[^/]+\/like$/.test(pathname)) {
    if (!u) return send(res, 401, { error: 'Login first.' });
    if (u.status === 'banned') return send(res, 403, { error: 'Banned.' });
    const handle = decodeURIComponent(pathname.split('/')[3] || '');
    const target = await db.collection('users').findOne({ handle });
    if (!target || target._id === u._id) return send(res, 400, { error: 'Cannot like.' });
    const key = { user_id: u._id, target_id: target._id };
    const existing = await db.collection('user_likes').findOne(key);
    let liked;
    if (existing) {
      await db.collection('user_likes').deleteOne(key);
      await db.collection('users').updateOne({ _id: target._id }, { $inc: { likes_count: -1, points: -1 } });
      target.likes_count = Math.max(0, (target.likes_count || 0) - 1);
      target.points = Math.max(0, (target.points || 0) - 1);
      liked = false;
    } else {
      await db.collection('user_likes').updateOne(key, { $setOnInsert: { ...key, created_at: now() } }, { upsert: true });
      await db.collection('users').updateOne({ _id: target._id }, { $inc: { likes_count: 1, points: 1 } });
      target.likes_count = (target.likes_count || 0) + 1;
      target.points = (target.points || 0) + 1;
      liked = true;
    }
    return send(res, 200, { ok: true, likes: target.likes_count, points: target.points, liked });
  }

  if (method === 'GET' && pathname === '/api/me') {
    if (!u) return send(res, 401, { error: 'Login first.' });
    const mine = await db.collection('posts').find(
      { user_id: u._id },
      { projection: { section: 1, title: 1, unique_views: 1, hidden: 1, created_at: 1 } }
    ).sort({ created_at: -1 }).toArray();
    return send(res, 200, {
      me: u.role === 'admin' ? adminUser(u) : { ...publicUser(u), email: u.email_enc ? decryptEmail(u.email_enc) : null, college_id: u.college_id, wallet: u.wallet },
      posts: mine.map((p) => ({ id: p._id, ...p, _id: undefined })),
      payout: await payoutEligible(u)
    });
  }

  if (method === 'POST' && pathname === '/api/me/wallet') {
    if (!u) return send(res, 401, { error: 'Login first.' });
    const body = await readBody(req);
    const wallet = String(body.wallet || '').trim();
    if (wallet.length < 20 || wallet.length > 128) return send(res, 400, { error: 'Paste a crypto wallet address (USDT / USDC).' });
    await db.collection('users').updateOne({ _id: u._id }, { $set: { wallet } });
    return send(res, 200, { ok: true });
  }

  if (method === 'POST' && pathname === '/api/payouts/request') {
    if (!u) return send(res, 401, { error: 'Login first.' });
    const el = await payoutEligible(u);
    if (!el.ok) return send(res, 400, { error: 'Not eligible yet.', payout: el });
    const pending = await db.collection('payouts').findOne({ user_id: u._id, status: { $in: ['pending', 'approved'] } });
    if (pending) return send(res, 400, { error: 'You already have an open payout request.' });
    const id = uid('pay');
    await db.collection('payouts').insertOne({
      _id: id,
      user_id: u._id,
      amount_usd: el.estimated_usd,
      wallet: u.wallet,
      status: 'pending',
      created_at: now()
    });
    return send(res, 200, { ok: true, id, amount_usd: el.estimated_usd });
  }

  if (method === 'GET' && pathname === '/api/sourced') {
    if (!u) return send(res, 401, { error: 'Sign up to read the board.' });
    try {
      const items = await fetchRedditSourced();
      return send(res, 200, { items, disclaimer: 'Attributed public posts from Reddit. Not campus confessions. Not rewritten as student stories.' });
    } catch (e) {
      return send(res, 200, { items: [], error: 'Could not reach Reddit right now.', disclaimer: 'Sourced list is optional and always attributed.' });
    }
  }

  if (method === 'GET' && pathname === '/api/events') {
    if (!u) return send(res, 401, { error: 'Sign up to read the board.' });
    const rows = await db.collection('events').find({}).sort({ created_at: -1 }).limit(40).toArray();
    return send(res, 200, { events: rows.map((e) => ({ id: e._id, ...e, _id: undefined })) });
  }

  /* ---------- anonymous chat ---------- */
  async function myChatHandle() {
    return chatBot.getChatHandle(u._id);
  }

  if (method === 'POST' && pathname === '/api/chat/send') {
    if (!u) return send(res, 401, { error: 'Login first.' });
    if (u.status === 'banned') return send(res, 403, { error: 'Banned.' });
    if (u.status === 'suspended') return send(res, 403, { error: 'Account suspended. You can read, not chat.' });
    const body = await readBody(req);
    let receiverHandle = String(body.receiver_handle || '').trim();
    const message = String(body.message || '').trim();
    const imageUrl = body.image_url || null;
    if (!receiverHandle) return send(res, 400, { error: 'Missing recipient.' });
    // you can DM by public handle (anonymous#11) or by chat handle (ch_xxxxxxxxxx)
    if (/^anonymous#\d+$/i.test(receiverHandle)) {
      const other = await db.collection('users').findOne({ handle: receiverHandle });
      if (!other) return send(res, 404, { error: 'No such user.' });
      receiverHandle = await chatBot.getChatHandle(other._id);
    }
    if (!/^ch_[0-9a-f]{10}$/.test(receiverHandle)) return send(res, 400, { error: 'Use a handle like anonymous#11 or ch_xxxxxxxxxx.' });
    if (receiverHandle === (await myChatHandle())) return send(res, 400, { error: 'You cannot chat with yourself.' });
    if (message.length < 1 && !imageUrl) return send(res, 400, { error: 'Write something or attach a photo.' });
    try {
      const doc = await chatBot.sendMessage(u._id, receiverHandle, message, imageUrl);
      await audit(u._id, 'chat_send', doc.chat_id, receiverHandle);
      return send(res, 200, { ok: true, chat_id: doc.chat_id });
    } catch (e) {
      console.error('chat send error:', e);
      return send(res, 500, { error: 'Failed to send message.' });
    }
  }

  if (method === 'GET' && pathname === '/api/chat/contacts') {
    if (!u) return send(res, 401, { error: 'Login first.' });
    try {
      const contacts = await chatBot.getContacts(await myChatHandle());
      return send(res, 200, { contacts });
    } catch (e) {
      console.error('chat contacts error:', e);
      return send(res, 500, { error: 'Failed to load contacts.' });
    }
  }

  if (method === 'GET' && pathname.startsWith('/api/chat/history/')) {
    if (!u) return send(res, 401, { error: 'Login first.' });
    const otherHandle = decodeURIComponent(pathname.split('/')[4] || '');
    try {
      const mine = await myChatHandle();
      const messages = await chatBot.getChatHistory(mine, otherHandle);
      await chatBot.markAsRead(mine);
      return send(res, 200, { me: mine, messages });
    } catch (e) {
      console.error('chat history error:', e);
      return send(res, 500, { error: 'Failed to load chat.' });
    }
  }

  if (method === 'GET' && pathname === '/api/chat/unread') {
    if (!u) return send(res, 401, { error: 'Login first.' });
    try {
      const count = await chatBot.getUnreadCount(await myChatHandle());
      return send(res, 200, { unread: count });
    } catch (e) {
      console.error('chat unread error:', e);
      return send(res, 500, { error: 'Failed to load unread count.' });
    }
  }

  if (method === 'POST' && pathname === '/api/chat/upload-image') {
    if (!u) return send(res, 401, { error: 'Login first.' });
    const body = await readBody(req);
    const imageData = body.image_data; // base64 data URI
    if (!imageData || !/^data:image\/(png|jpe?g|webp|gif);base64,/.test(imageData)) {
      return send(res, 400, { error: 'No valid image provided.' });
    }
    try {
      const buffer = Buffer.from(imageData.split(',')[1], 'base64');
      if (buffer.length > 12 * 1024 * 1024) return send(res, 413, { error: 'Image too large (max 12MB).' });
      const url = await chatBot.uploadImage(buffer);
      return send(res, 200, { ok: true, url });
    } catch (e) {
      console.error('chat upload error:', e);
      return send(res, 500, { error: 'Failed to upload image.' });
    }
  }

  /* ---------- public room (town hall) ---------- */
  if (method === 'GET' && pathname === '/api/room/history') {
    if (!u) return send(res, 401, { error: 'Login first.' });
    try {
      const messages = await db.collection('room_messages')
        .find({ room: 'townhall' })
        .sort({ timestamp: -1 })
        .limit(120)
        .toArray();
      return send(res, 200, { me: u.handle, messages: messages.reverse() });
    } catch (e) {
      console.error('room history error:', e);
      return send(res, 500, { error: 'Failed to load room.' });
    }
  }

  if (method === 'POST' && pathname === '/api/room/send') {
    if (!u) return send(res, 401, { error: 'Login first.' });
    if (u.status === 'banned') return send(res, 403, { error: 'Banned.' });
    if (u.status === 'suspended') return send(res, 403, { error: 'Account suspended. You can read, not chat.' });
    const body = await readBody(req);
    const message = String(body.message || '').trim().slice(0, 1000);
    const imageUrl = typeof body.image_url === 'string' && /^https?:/.test(body.image_url) ? body.image_url : null;
    if (!message && !imageUrl) return send(res, 400, { error: 'Write something first.' });
    if (!rateLimit('room:' + u._id, 12, 60 * 1000)) return send(res, 429, { error: 'Slow down — too many messages.' });
    try {
      await db.collection('room_messages').insertOne({
        _id: uid('msg'),
        room: 'townhall',
        sender_user_id: u._id,
        sender_handle: u.handle,
        message: message || null,
        image_url: imageUrl,
        timestamp: now()
      });
      return send(res, 200, { ok: true });
    } catch (e) {
      console.error('room send error:', e);
      return send(res, 500, { error: 'Failed to send.' });
    }
  }

  /* ---------- admin ---------- */
  function needAdmin() {
    if (!u || u.role !== 'admin') {
      send(res, 403, { error: 'Admin only.' });
      return false;
    }
    return true;
  }

  if (pathname.startsWith('/api/admin/') && !needAdmin()) return;

  if (method === 'GET' && pathname === '/api/admin/overview') {
    const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    const [users, banned, suspended, posts, postsWeek, signupsWeek, reports, chats, roomMsgs, pendingPayouts, pendingAgg, readsAgg, pointsAgg] = await Promise.all([
      db.collection('users').countDocuments({ role: 'student' }),
      db.collection('users').countDocuments({ status: 'banned' }),
      db.collection('users').countDocuments({ status: 'suspended' }),
      db.collection('posts').countDocuments({}),
      db.collection('posts').countDocuments({ created_at: { $gte: weekAgo } }),
      db.collection('users').countDocuments({ role: 'student', created_at: { $gte: weekAgo } }),
      db.collection('reports').countDocuments({}),
      db.collection('chats').countDocuments({}),
      db.collection('room_messages').countDocuments({}),
      db.collection('payouts').countDocuments({ status: 'pending' }),
      db.collection('payouts').aggregate([{ $match: { status: 'pending' } }, { $group: { _id: null, sum: { $sum: '$amount_usd' } } }]).toArray(),
      db.collection('posts').aggregate([{ $group: { _id: null, sum: { $sum: '$unique_views' } } }]).toArray(),
      db.collection('users').aggregate([{ $match: { role: 'student' } }, { $group: { _id: null, sum: { $sum: { $ifNull: ['$points', 0] } } } }]).toArray()
    ]);
    const stats = {
      users, banned, suspended, posts, reports, chats,
      posts_week: postsWeek,
      signups_week: signupsWeek,
      room_messages: roomMsgs,
      pending_payouts: pendingPayouts,
      pending_usd: (pendingAgg[0] && pendingAgg[0].sum) || 0,
      total_reads: (readsAgg[0] && readsAgg[0].sum) || 0,
      total_points: (pointsAgg[0] && pointsAgg[0].sum) || 0
    };
    const [top_posts, recent_users, top_users] = await Promise.all([
      db.collection('posts').find({ hidden: { $ne: true } }).sort({ unique_views: -1 }).limit(5)
        .project({ title: 1, handle: 1, section: 1, unique_views: 1, likes: 1 }).toArray(),
      db.collection('users').find({ role: 'student' }).sort({ created_at: -1 }).limit(6)
        .project({ handle: 1, college_name: 1, place: 1, status: 1, created_at: 1 }).toArray(),
      db.collection('users').find({ role: 'student', points: { $gt: 0 } }).sort({ points: -1 }).limit(8)
        .project({ handle: 1, points: 1, likes_count: 1, follower_count: 1, college_name: 1, status: 1 }).toArray()
    ]);
    return send(res, 200, { stats, top_posts, recent_users, top_users });
  }

  if (method === 'GET' && pathname === '/api/admin/users') {
    const q = String(url.searchParams.get('q') || '').trim();
    const query = { role: 'student' };
    if (q) query.$or = [{ handle: rx(q) }, { college_name: rx(q) }, { college_id: rx(q) }];
    const users = await db.collection('users').find(query).sort({ points: -1, created_at: -1 }).limit(200).toArray();
    return send(res, 200, { users: users.map(adminUser) });
  }

  if (method === 'POST' && pathname === '/api/admin/user-status') {
    const body = await readBody(req);
    const id = String(body.id || '');
    const status = String(body.status || '');
    if (!['active', 'suspended', 'banned'].includes(status)) return send(res, 400, { error: 'Bad status.' });
    const target = await db.collection('users').findOne({ _id: id });
    if (!target || target.role === 'admin') return send(res, 400, { error: 'Cannot change that account.' });
    await db.collection('users').updateOne({ _id: id }, { $set: { status } });
    if (status === 'banned') await db.collection('sessions').deleteMany({ user_id: id });
    await audit(u._id, 'set_status', id, status);
    return send(res, 200, { ok: true, user: adminUser(await db.collection('users').findOne({ _id: id })) });
  }

  if (method === 'POST' && pathname === '/api/admin/verify') {
    const body = await readBody(req);
    const id = String(body.id || '');
    await db.collection('users').updateOne({ _id: id }, { $set: { verified: true } });
    await audit(u._id, 'verify', id, 'college_id_ok');
    return send(res, 200, { ok: true });
  }

  if (method === 'GET' && pathname === '/api/admin/posts') {
    const rows = await db.collection('posts').aggregate([
      { $sort: { created_at: -1 } },
      { $limit: 200 },
      { $lookup: { from: 'users', localField: 'user_id', foreignField: '_id', as: 'u' } },
      { $addFields: {
        handle: { $arrayElemAt: ['$u.handle', 0] },
        email_enc: { $arrayElemAt: ['$u.email_enc', 0] }
      } },
      { $project: { u: 0 } }
    ]).toArray();
    for (const p of rows) p.email = p.email_enc ? decryptEmail(p.email_enc) : null;
    return send(res, 200, { posts: rows.map((p) => ({ id: p._id, ...p, _id: undefined })) });
  }

  if (method === 'POST' && pathname === '/api/admin/edit-post-metrics') {
    const body = await readBody(req);
    const id = String(body.id || '');
    const views = Number(body.views);
    const likes = Number(body.likes);
    if (isNaN(views) || views < 0 || isNaN(likes) || likes < 0) return send(res, 400, { error: 'Invalid metrics.' });
    await db.collection('posts').updateOne({ _id: id }, { $set: { unique_views: views, likes } });
    await audit(u._id, 'edit_post_metrics', id, `views:${views},likes:${likes}`);
    return send(res, 200, { ok: true });
  }

  if (method === 'POST' && pathname === '/api/admin/hide-post') {
    const body = await readBody(req);
    const id = String(body.id || '');
    const hidden = body.hidden ? true : false;
    await db.collection('posts').updateOne({ _id: id }, { $set: { hidden } });
    await audit(u._id, hidden ? 'hide_post' : 'unhide_post', id, '');
    return send(res, 200, { ok: true });
  }

  if (method === 'GET' && pathname === '/api/admin/payouts') {
    const rows = await db.collection('payouts').aggregate([
      { $sort: { created_at: -1 } },
      { $lookup: { from: 'users', localField: 'user_id', foreignField: '_id', as: 'u' } },
      { $addFields: {
        handle: { $arrayElemAt: ['$u.handle', 0] },
        email_enc: { $arrayElemAt: ['$u.email_enc', 0] },
        follower_count: { $arrayElemAt: ['$u.follower_count', 0] }
      } },
      { $project: { u: 0 } }
    ]).toArray();
    for (const p of rows) p.email = p.email_enc ? decryptEmail(p.email_enc) : null;
    return send(res, 200, { payouts: rows.map((p) => ({ id: p._id, ...p, _id: undefined })) });
  }

  if (method === 'POST' && pathname === '/api/admin/payout-status') {
    const body = await readBody(req);
    const id = String(body.id || '');
    const status = String(body.status || '');
    if (!['approved', 'paid', 'rejected', 'pending'].includes(status)) return send(res, 400, { error: 'Bad status.' });
    await db.collection('payouts').updateOne({ _id: id }, { $set: { status } });
    await audit(u._id, 'payout_' + status, id, '');
    return send(res, 200, { ok: true });
  }

  if (method === 'GET' && pathname === '/api/admin/reports') {
    const rows = await db.collection('reports').aggregate([
      { $sort: { created_at: -1 } },
      { $limit: 200 },
      { $lookup: { from: 'posts', localField: 'post_id', foreignField: '_id', as: 'p' } },
      { $lookup: { from: 'users', localField: 'reporter_id', foreignField: '_id', as: 'ru' } },
      { $addFields: {
        title: { $arrayElemAt: ['$p.title', 0] },
        reporter_handle: { $arrayElemAt: ['$ru.handle', 0] }
      } },
      { $project: { p: 0, ru: 0 } }
    ]).toArray();
    return send(res, 200, { reports: rows.map((r) => ({ id: r._id, ...r, _id: undefined })) });
  }

  if (method === 'GET' && pathname === '/api/admin/audit') {
    const rows = await db.collection('audit_log').find({}).sort({ created_at: -1 }).limit(200).toArray();
    return send(res, 200, { audit: rows.map((a) => ({ id: a._id, ...a, _id: undefined })) });
  }

  if (method === 'POST' && pathname === '/api/admin/event') {
    const body = await readBody(req);
    const title = String(body.title || '').trim();
    const text = String(body.body || '').trim();
    const source = String(body.source || 'staff').trim();
    if (title.length < 4 || text.length < 10) return send(res, 400, { error: 'Need title and details.' });
    const id = uid('evt');
    await db.collection('events').insertOne({ _id: id, title, body: text, source, created_at: now() });
    await audit(u._id, 'add_event', id, source);
    return send(res, 200, { ok: true, id });
  }

  if (method === 'GET' && pathname === '/api/admin/blog-bot') {
    return send(res, 200, await blogBot.status());
  }

  if (method === 'POST' && pathname === '/api/admin/blog-bot') {
    const body = await readBody(req);
    const st = await blogBot.setOn(body.on !== false && body.on !== 0 && body.on !== '0');
    await audit(u._id, st.on ? 'blog_bot_on' : 'blog_bot_off', null, '');
    return send(res, 200, st);
  }

  if (method === 'POST' && pathname === '/api/admin/blog-bot/run') {
    const out = await blogBot.publishOne('manual');
    await audit(u._id, 'blog_bot_run', out.id, out.title);
    return send(res, 200, out);
  }

  if (method === 'POST' && pathname === '/api/admin/prompt') {
    const body = await readBody(req);
    const section = SECTIONS.some((s) => s.id === body.section) ? body.section : 'safety';
    const title = String(body.title || 'Discussion starter').trim().slice(0, 140);
    const text = String(body.body || '').trim();
    if (text.length < 40) return send(res, 400, { error: 'Prompt body too short.' });
    const labeled = text.startsWith('Staff prompt') ? text : 'Staff prompt — not a student confession.\n\n' + text;
    const id = uid('post');
    await db.collection('posts').insertOne({
      _id: id,
      user_id: null,
      section,
      title,
      body: labeled,
      unique_views: 0,
      likes: 0,
      source: 'prompt',
      source_url: null,
      hidden: false,
      created_at: now()
    });
    await audit(u._id, 'desk_prompt', id, section);
    return send(res, 200, { ok: true, id });
  }

  /* ---------- admin chat monitor ---------- */
  if (method === 'GET' && pathname === '/api/admin/chat/all') {
    const page = Number(url.searchParams.get('page')) || 1;
    const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 200);
    const skip = (page - 1) * limit;
    const messages = await db.collection('chats').aggregate([
      { $sort: { timestamp: -1 } },
      { $skip: skip },
      { $limit: limit },
      { $lookup: { from: 'users', localField: 'sender_user_id', foreignField: '_id', as: 'sender' } },
      { $addFields: {
        sender_email_enc: { $arrayElemAt: ['$sender.email_enc', 0] },
        sender_public_handle: { $arrayElemAt: ['$sender.handle', 0] },
        sender_status: { $arrayElemAt: ['$sender.status', 0] }
      } },
      { $project: { sender: 0 } }
    ]).toArray();
    for (const m of messages) m.sender_email = m.sender_email_enc ? decryptEmail(m.sender_email_enc) : null;
    const total = await db.collection('chats').countDocuments({});
    return send(res, 200, { messages, page, total, pages: Math.max(1, Math.ceil(total / limit)) });
  }

  if (method === 'GET' && pathname === '/api/admin/chat/user') {
    const handle = String(url.searchParams.get('handle') || '').trim();
    if (!handle) return send(res, 400, { error: 'Need a handle.' });
    const messages = await db.collection('chats').aggregate([
      { $match: { $or: [{ sender_handle: handle }, { receiver_handle: handle }] } },
      { $sort: { timestamp: -1 } },
      { $limit: 100 },
      { $lookup: { from: 'users', localField: 'sender_user_id', foreignField: '_id', as: 'sender' } },
      { $addFields: {
        sender_email_enc: { $arrayElemAt: ['$sender.email_enc', 0] },
        sender_public_handle: { $arrayElemAt: ['$sender.handle', 0] },
        sender_status: { $arrayElemAt: ['$sender.status', 0] }
      } },
      { $project: { sender: 0 } }
    ]).toArray();
    for (const m of messages) m.sender_email = m.sender_email_enc ? decryptEmail(m.sender_email_enc) : null;
    return send(res, 200, { messages });
  }

  if (method === 'POST' && pathname === '/api/admin/chat/delete') {
    const body = await readBody(req);
    const chatId = String(body.chat_id || '');
    const roomId = String(body.room_id || '');
    if (roomId) {
      await db.collection('room_messages').deleteOne({ _id: roomId });
      await audit(u._id, 'delete_room_msg', roomId, 'admin deletion');
      return send(res, 200, { ok: true });
    }
    await db.collection('chats').deleteOne({ chat_id: chatId });
    await audit(u._id, 'delete_chat', chatId, 'admin deletion');
    return send(res, 200, { ok: true });
  }

  if (method === 'POST' && pathname === '/api/admin/chat/ban-user') {
    const body = await readBody(req);
    let target = null;
    if (body.user_id) {
      target = await db.collection('users').findOne({ _id: String(body.user_id) });
    } else if (body.handle) {
      const handle = String(body.handle);
      target = await db.collection('users').findOne({ handle });
      if (!target) {
        const msg = await db.collection('chats').findOne({ sender_handle: handle }, { sort: { timestamp: -1 } });
        if (msg && msg.sender_user_id) target = await db.collection('users').findOne({ _id: msg.sender_user_id });
      }
    }
    if (!target || target.role === 'admin') return send(res, 400, { error: 'Cannot ban that account.' });
    await db.collection('users').updateOne({ _id: target._id }, { $set: { status: 'banned' } });
    await db.collection('sessions').deleteMany({ user_id: target._id });
    await audit(u._id, 'ban_user_chat', target._id, target.handle);
    return send(res, 200, { ok: true, banned: target.handle });
  }

  if (method === 'GET' && pathname === '/api/admin/room') {
    const messages = await db.collection('room_messages').aggregate([
      { $sort: { timestamp: -1 } },
      { $limit: 150 },
      { $lookup: { from: 'users', localField: 'sender_user_id', foreignField: '_id', as: 'sender' } },
      { $addFields: {
        sender_email_enc: { $arrayElemAt: ['$sender.email_enc', 0] },
        sender_status: { $arrayElemAt: ['$sender.status', 0] }
      } },
      { $project: { sender: 0 } }
    ]).toArray();
    for (const m of messages) m.sender_email = m.sender_email_enc ? decryptEmail(m.sender_email_enc) : null;
    return send(res, 200, { messages });
  }

  if (method === 'GET' && pathname === '/api/admin/campaigns') {
    const campaigns = await db.collection('campaigns').find({}).sort({ created_at: -1 }).toArray();
    return send(res, 200, { campaigns });
  }

  if (method === 'POST' && pathname === '/api/admin/campaign') {
    const body = await readBody(req);
    const title = String(body.title || '').trim().slice(0, 120);
    const text = String(body.body || '').trim().slice(0, 300);
    const cta = String(body.cta || 'Start writing').trim().slice(0, 40);
    const ctaLink = ['write', 'earn', 'feed'].includes(body.cta_link) ? body.cta_link : 'write';
    if (!title || !text) return send(res, 400, { error: 'Title and body are required.' });
    const doc = { _id: uid('cmp'), title, body: text, cta, cta_link: ctaLink, on: true, created_at: now() };
    await db.collection('campaigns').insertOne(doc);
    // broadcast the campaign into the town hall as the desk
    await db.collection('room_messages').insertOne({
      _id: uid('msg'),
      room: 'townhall',
      sender_user_id: u._id,
      sender_handle: u.handle,
      message: '📣 ' + title + ' — ' + text,
      image_url: null,
      timestamp: now()
    });
    await audit(u._id, 'create_campaign', doc._id, title);
    return send(res, 200, { ok: true, id: doc._id });
  }

  if (method === 'POST' && pathname === '/api/admin/campaign-toggle') {
    const body = await readBody(req);
    const id = String(body.id || '');
    const c = await db.collection('campaigns').findOne({ _id: id });
    if (!c) return send(res, 404, { error: 'Campaign not found.' });
    await db.collection('campaigns').updateOne({ _id: id }, { $set: { on: !c.on } });
    await audit(u._id, 'toggle_campaign', id, String(!c.on));
    return send(res, 200, { ok: true, on: !c.on });
  }

  if (method === 'POST' && pathname === '/api/admin/campaign-delete') {
    const body = await readBody(req);
    await db.collection('campaigns').deleteOne({ _id: String(body.id || '') });
    await audit(u._id, 'delete_campaign', String(body.id || ''), 'campaign deleted');
    return send(res, 200, { ok: true });
  }

  if (method === 'GET' && pathname === '/api/admin/campaign-bot') {
    return send(res, 200, await campaignBot.status());
  }

  if (method === 'POST' && pathname === '/api/admin/campaign-bot') {
    const body = await readBody(req);
    return send(res, 200, await campaignBot.setOn(!!body.on));
  }

  if (method === 'POST' && pathname === '/api/admin/campaign-bot/run') {
    try {
      const r = await campaignBot.runOne('manual');
      await audit(u._id, 'campaign_bot_run', r.id, r.title);
      return send(res, 200, { ok: true, ...r });
    } catch (e) {
      console.error('campaign bot run error:', e);
      return send(res, 500, { error: 'Bot run failed.' });
    }
  }

  if (method === 'GET' && pathname === '/api/admin/allowlist') {
    const list = await db.collection('admin_allowlist').find({}).sort({ created_at: -1 }).toArray();
    return send(res, 200, { list });
  }

  if (method === 'POST' && pathname === '/api/admin/allowlist') {
    const body = await readBody(req);
    const email = String(body.email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return send(res, 400, { error: 'Enter a valid email.' });
    if (email === String(process.env.ADMIN_EMAIL || '').toLowerCase()) return send(res, 400, { error: 'That is already the main admin.' });
    await db.collection('admin_allowlist').updateOne(
      { email },
      { $setOnInsert: { _id: uid('adm'), email, added_by: u.handle, created_at: now() } },
      { upsert: true }
    );
    // if that person already has an account, promote them right away
    const existing = await db.collection('users').findOne({ email_hash: emailHash(email) });
    if (existing && existing.role !== 'admin') await db.collection('users').updateOne({ _id: existing._id }, { $set: { role: 'admin', status: 'active' } });
    await audit(u._id, 'allowlist_add', email, email);
    return send(res, 200, { ok: true });
  }

  if (method === 'POST' && pathname === '/api/admin/allowlist-remove') {
    const body = await readBody(req);
    const email = String(body.email || '').trim().toLowerCase();
    await db.collection('admin_allowlist').deleteOne({ email });
    // do not demote the primary admin
    if (email !== String(process.env.ADMIN_EMAIL || '').toLowerCase()) {
      const target = await db.collection('users').findOne({ email_hash: emailHash(email), role: 'admin' });
      if (target) {
        await db.collection('users').updateOne({ _id: target._id }, { $set: { role: 'student' } });
        await db.collection('sessions').deleteMany({ user_id: target._id });
      }
    }
    await audit(u._id, 'allowlist_remove', email, email);
    return send(res, 200, { ok: true });
  }

  if (method === 'POST' && pathname === '/api/admin/site-logo') {
    const body = await readBody(req);
    const logo = String(body.logo || '').trim();
    if (logo && !/^(data:image\/(png|jpe?g|webp|svg\+xml);base64,|https?:\/\/)/.test(logo)) {
      return send(res, 400, { error: 'Logo must be an image URL or a generated image.' });
    }
    if (logo.length > 300000) return send(res, 413, { error: 'Logo too large.' });
    await setSetting('site_logo', logo);
    await audit(u._id, 'set_site_logo', logo.slice(0, 40), 'logo updated');
    return send(res, 200, { ok: true });
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

async function ensureCampaigns() {
  const n = await db.collection('campaigns').countDocuments({});
  if (n > 0) return;
  await db.collection('campaigns').insertMany([
    { _id: uid('cmp'), title: 'Writers get paid here 💸', body: 'Every unique read on your story earns you real money — cash out at $100 in USDT / USDC.', cta: 'Start writing', cta_link: 'write', on: true, created_at: now() },
    { _id: uid('cmp'), title: 'Payout milestones are live', body: 'Grow 25 followers + 200 unique reads and your payout unlocks. No middlemen.', cta: 'Open Earn page', cta_link: 'earn', on: true, created_at: now() }
  ]);
}

async function migrate() {
  // 1) emails: raw → encrypted at rest + hash for lookup. Nobody reading the
  //    database (not even a dump leak) can map a person to a handle.
  const raw = await db.collection('users').find({ email: { $exists: true, $ne: null } }).toArray();
  for (const u of raw) {
    if (!u.email) continue;
    await db.collection('users').updateOne({ _id: u._id }, {
      $set: { email_enc: encryptEmail(u.email), email_hash: emailHash(u.email) },
      $unset: { email: '', phone: '' }
    });
  }
  // 2) handles: everyone becomes anonymous#N, identical to everyone else
  const toRename = await db.collection('users').find({ role: 'student', handle: { $not: /^anonymous#\d+$/ } }).toArray();
  for (const u of toRename) {
    const h = await nextAnonHandle();
    await db.collection('users').updateOne({ _id: u._id }, { $set: { handle: h } });
  }
  await db.collection('users').updateMany({ role: 'admin', handle: { $ne: 'desk' } }, { $set: { handle: 'desk' } });
  // 3) backfill university on older student posts from their author
  const needUni = await db.collection('posts').find({ source: 'student', university: { $in: [null, ''] } }).limit(500).toArray();
  for (const p of needUni) {
    const au = p.user_id ? await db.collection('users').findOne({ _id: p.user_id }, { projection: { college_name: 1 } }) : null;
    if (au && au.college_name) await db.collection('posts').updateOne({ _id: p._id }, { $set: { university: au.college_name } });
  }
  // 4) OTP bookkeeping is gone
  try { await db.collection('otps').drop(); } catch (e) {}
  // 5) points backfill — every user's points = likes on their stories + likes on their profile
  const fromPosts = await db.collection('post_likes').aggregate([
    { $lookup: { from: 'posts', localField: 'post_id', foreignField: '_id', as: 'p' } },
    { $unwind: '$p' },
    { $group: { _id: '$p.user_id', n: { $sum: 1 } } }
  ]).toArray();
  const pointsMap = new Map(fromPosts.map((r) => [String(r._id), r.n]));
  const fromProfiles = await db.collection('user_likes').aggregate([{ $group: { _id: '$target_id', n: { $sum: 1 } } }]).toArray();
  for (const r of fromProfiles) pointsMap.set(String(r._id), (pointsMap.get(String(r._id)) || 0) + r.n);
  for (const [userId, n] of pointsMap) {
    if (userId && userId !== 'null') await db.collection('users').updateOne({ _id: userId }, { $set: { points: n } });
  }
  if (raw.length || toRename.length) console.log('migrated users → encrypted emails + anonymous handles (' + raw.length + ' emails, ' + toRename.length + ' handles)');
}

async function main() {
  await connectDB();
  await migrate();
  ADMIN = await ensureAdmin();
  await ensureCampaigns();
  server.listen(PORT, () => {
    console.log('Backbench board on http://localhost:' + PORT);
    console.log('Student site  http://localhost:' + PORT + '/');
    console.log('Admin desk    http://localhost:' + PORT + '/admin');
    console.log('Admin email   ' + (process.env.ADMIN_EMAIL || 'not set'));
    blogBot.start();
    campaignBot.start();
    console.log('Campaign bot on, every ' + (Number(process.env.CAMPAIGN_BOT_INTERVAL_MS || 6 * 60 * 60 * 1000) / 36e5) + 'h');
  });
}

main().catch((e) => {
  console.error('Fatal startup error:', e);
  process.exit(1);
});