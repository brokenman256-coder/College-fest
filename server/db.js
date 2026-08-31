const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'campus.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE,
  phone TEXT UNIQUE,
  college_id TEXT,
  handle TEXT UNIQUE NOT NULL,
  wallet TEXT,
  role TEXT NOT NULL DEFAULT 'student',
  status TEXT NOT NULL DEFAULT 'active',
  verified INTEGER NOT NULL DEFAULT 0,
  follower_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS otps (
  identifier TEXT PRIMARY KEY,
  hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  section TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  unique_views INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'student',
  source_url TEXT,
  hidden INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS post_views (
  post_id TEXT NOT NULL,
  viewer_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (post_id, viewer_key)
);

CREATE TABLE IF NOT EXISTS follows (
  follower_id TEXT NOT NULL,
  followee_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (follower_id, followee_id)
);

CREATE TABLE IF NOT EXISTS payouts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  amount_usd REAL NOT NULL,
  wallet TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  reporter_id TEXT,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  admin_id TEXT,
  action TEXT NOT NULL,
  target_id TEXT,
  detail TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  source TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_posts_section ON posts(section, created_at);
CREATE INDEX IF NOT EXISTS idx_posts_user ON posts(user_id);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
`);

function uid(prefix) {
  return prefix + '_' + crypto.randomBytes(8).toString('hex');
}

function now() {
  return new Date().toISOString();
}

const SECTIONS = [
  { id: 'safety', name: 'Safety & awareness', blurb: 'Ragging, harassment, night travel, hostels.' },
  { id: 'courses', name: 'Courses & faculty', blurb: 'Reviews of papers, labs, and teachers.' },
  { id: 'hostels', name: 'Hostels & mess', blurb: 'Food, wardens, roommates, rent.' },
  { id: 'events', name: 'Campus events', blurb: 'Fests, clubs, talks — staff-added or student-reported.' },
  { id: 'confessions', name: 'Confessions', blurb: 'Anonymous to other students. Admin can still see the account.' },
  { id: 'placements', name: 'Placements', blurb: 'Internships, companies, interview experiences.' }
];

function seedIfEmpty() {
  const n = db.prepare('SELECT COUNT(*) AS c FROM posts').get().c;
  if (n > 0) return;
  const prompts = [
    {
      section: 'safety',
      title: 'Discussion starter: night travel on campus',
      body: 'Staff prompt — not a student confession. What would actually make late-night movement safer here: lighting, shuttle, guards, or something else? Reply with what you have seen, not rumours about named people.'
    },
    {
      section: 'hostels',
      title: 'Discussion starter: mess quality this semester',
      body: 'Staff prompt — not a student confession. Describe the mess as it is this month. Stick to food, hygiene, timings. Do not name individual workers to pile on.'
    },
    {
      section: 'courses',
      title: 'Discussion starter: a paper that is harder than the brochure',
      body: 'Staff prompt — not a student confession. Which course needs a honest review (workload, grading, labs)? Keep it about the course, not a personal attack.'
    },
    {
      section: 'placements',
      title: 'Discussion starter: internships that actually taught something',
      body: 'Staff prompt — not a student confession. Share process and what you learned. No fake offer letters, no invented packages.'
    }
  ];
  const ins = db.prepare(
    `INSERT INTO posts (id, user_id, section, title, body, unique_views, source, hidden, created_at)
     VALUES (?, NULL, ?, ?, ?, 0, 'prompt', 0, ?)`
  );
  for (const p of prompts) ins.run(uid('post'), p.section, p.title, p.body, now());
}

seedIfEmpty();

module.exports = { db, uid, now, SECTIONS, DATA_DIR };
