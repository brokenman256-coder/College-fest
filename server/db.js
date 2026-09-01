const { MongoClient } = require('mongodb');
const crypto = require('crypto');
require('dotenv').config();

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017';
const DB_NAME = process.env.MONGO_DB || 'collegefest';

const client = new MongoClient(MONGO_URI);
const db = client.db(DB_NAME);

async function connectDB() {
  try {
    await client.connect();
    await db.command({ ping: 1 });
    console.log('Connected to MongoDB →', DB_NAME);

    // --- indexes ---
    await db.collection('users').createIndex({ handle: 1 }, { unique: true });
    await db.collection('users').createIndex({ email: 1 });
    await db.collection('users').createIndex({ phone: 1 });
    await db.collection('sessions').createIndex({ token: 1 }, { unique: true });
    await db.collection('otps').createIndex({ identifier: 1 }, { unique: true });
    await db.collection('posts').createIndex({ user_id: 1 });
    await db.collection('posts').createIndex({ created_at: -1 });
    await db.collection('posts').createIndex({ section: 1 });
    await db.collection('post_views').createIndex({ post_id: 1, viewer_key: 1 }, { unique: true });
    await db.collection('post_likes').createIndex({ post_id: 1, user_id: 1 }, { unique: true });
    await db.collection('follows').createIndex({ follower_id: 1, followee_id: 1 }, { unique: true });
    await db.collection('chats').createIndex({ chat_id: 1 }, { unique: true });
    await db.collection('chats').createIndex({ sender_handle: 1 });
    await db.collection('chats').createIndex({ receiver_handle: 1 });
    await db.collection('chats').createIndex({ timestamp: -1 });
  } catch (e) {
    console.error('MongoDB connection error:', e.message);
    process.exit(1);
  }
}

function uid(prefix) {
  return prefix + '_' + crypto.randomBytes(8).toString('hex');
}

function now() {
  return new Date().toISOString();
}

async function getSetting(key, dflt) {
  const r = await db.collection('settings').findOne({ _id: key });
  return r ? r.value : dflt;
}

async function setSetting(key, value) {
  await db.collection('settings').updateOne({ _id: key }, { $set: { value } }, { upsert: true });
}

const SECTIONS = [
  { id: 'safety', name: 'Safety & awareness', blurb: 'Ragging, harassment, night travel, hostels.' },
  { id: 'courses', name: 'Courses & faculty', blurb: 'Reviews of papers, labs, and teachers.' },
  { id: 'hostels', name: 'Hostels & mess', blurb: 'Food, wardens, roommates, rent.' },
  { id: 'events', name: 'Campus events', blurb: 'Fests, clubs, talks — staff-added or student-reported.' },
  { id: 'confessions', name: 'Confessions', blurb: 'Anonymous to other students. Admin can still see the account.' },
  { id: 'placements', name: 'Placements', blurb: 'Internships, companies, interview experiences.' }
];

module.exports = { db, client, uid, now, SECTIONS, connectDB, getSetting, setSetting };