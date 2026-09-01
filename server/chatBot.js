const { db, uid, now } = require('./db');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const { v2: cloudinary } = require('cloudinary');
require('dotenv').config();

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const COLLECTION = 'chats';

function cloudEnabled() {
  return !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);
}

// Stable anonymous chat handle derived from the user id — students see this,
// never the email/phone. Admin docs keep sender_user_id for moderation.
async function getChatHandle(userId) {
  const row = await db.collection('users').findOne({ _id: userId });
  if (!row) return null;
  const salt = 'campus_anon_';
  const digest = crypto.createHash('sha256').update(salt + row._id + process.env.SESSION_SECRET).digest('hex');
  return 'ch_' + digest.slice(0, 10);
}

async function sendMessage(senderId, receiverHandle, message, imageUrl = null) {
  const chatId = uid('chat');
  const senderHandle = await getChatHandle(senderId);
  const doc = {
    chat_id: chatId,
    sender_handle: senderHandle,
    sender_user_id: senderId,
    receiver_handle: receiverHandle,
    message: String(message || '').slice(0, 2000),
    image_url: imageUrl || null,
    timestamp: now(),
    read: false
  };
  await db.collection(COLLECTION).insertOne(doc);
  return doc;
}

async function getChatHistory(handle1, handle2) {
  const messages = await db.collection(COLLECTION)
    .find({
      $or: [
        { sender_handle: handle1, receiver_handle: handle2 },
        { sender_handle: handle2, receiver_handle: handle1 }
      ]
    })
    .sort({ timestamp: 1 })
    .limit(200)
    .toArray();
  return messages;
}

async function getContacts(myHandle) {
  const msgs = await db.collection(COLLECTION)
    .find({ $or: [{ sender_handle: myHandle }, { receiver_handle: myHandle }] })
    .sort({ timestamp: -1 })
    .limit(400)
    .toArray();
  const contacts = new Map();
  for (const m of msgs) {
    const other = m.sender_handle === myHandle ? m.receiver_handle : m.sender_handle;
    if (!other) continue;
    if (!contacts.has(other)) {
      contacts.set(other, {
        handle: other,
        last: m.image_url && !m.message ? '[photo]' : String(m.message || '').slice(0, 90),
        last_at: m.timestamp,
        from_me: m.sender_handle === myHandle,
        unread: 0
      });
    }
    if (m.receiver_handle === myHandle && !m.read) contacts.get(other).unread++;
  }
  return [...contacts.values()].sort((a, b) => (a.last_at < b.last_at ? 1 : -1));
}

async function getUnreadCount(handle) {
  return db.collection(COLLECTION).countDocuments({ receiver_handle: handle, read: false });
}

async function markAsRead(handle) {
  await db.collection(COLLECTION).updateMany(
    { receiver_handle: handle, read: false },
    { $set: { read: true } }
  );
}

async function uploadImage(buffer) {
  const processed = await sharp(buffer)
    .rotate()
    .resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer();

  if (cloudEnabled()) {
    const dataUri = 'data:image/jpeg;base64,' + processed.toString('base64');
    const result = await cloudinary.uploader.upload(dataUri, {
      folder: 'collegefest_chats',
      resource_type: 'image'
    });
    return result.secure_url;
  }

  // Local disk fallback so the demo works without Cloudinary keys
  const name = uid('img') + '.jpg';
  const dir = path.join(__dirname, '..', 'public', 'uploads');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), processed);
  return '/uploads/' + name;
}

function status() {
  return { chats: COLLECTION, cloudinary: cloudEnabled() };
}

module.exports = { getChatHandle, sendMessage, getChatHistory, getContacts, getUnreadCount, markAsRead, uploadImage, status };