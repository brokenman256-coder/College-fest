const { db, uid, now, getSetting, setSetting } = require('./db');

const INTERVAL_MS = Number(process.env.CAMPAIGN_BOT_INTERVAL_MS || 6 * 60 * 60 * 1000);

/* The bot rotates these promos: each run makes one the live banner
   and announces it in the town hall. It never invents earnings. */
const PROMOS = [
  { title: '💸 Writers get paid here', body: 'Every unique read on your story earns real money. Publish today — the counter starts with your first reader.', cta: 'Start writing', cta_link: 'write' },
  { title: '⬆ Your stories are worth money', body: 'Reach 25 followers + 200 unique reads and unlock your payout in USDT / USDC.', cta: 'Open Earn page', cta_link: 'earn' },
  { title: '📈 Cash out at $100', body: 'No middlemen. The desk pays your crypto wallet directly. Track every dollar on the Earn page.', cta: 'See progress', cta_link: 'earn' },
  { title: '✍️ Write what you actually saw', body: 'Honest mess, hostel and placement reviews get the most reads — and reads pay.', cta: 'Start writing', cta_link: 'write' },
  { title: '🔥 Payout season is open', body: 'Bloggers who hit the milestone get paid in USDT / USDC. Check how close you are.', cta: 'Open Earn page', cta_link: 'earn' },
  { title: '📣 Readers = earnings', body: 'Share your story link in the town hall and your hostel groups. Every unique read adds money to your balance.', cta: 'Start writing', cta_link: 'write' },
  { title: '🏆 Leaderboard money', body: 'The most-read stories this week earn the most. One good post can clear half your milestone.', cta: 'Write yours', cta_link: 'write' },
  { title: '💰 Anonymous but paid', body: 'Nobody sees your name — but the desk pays your wallet. Anonymous does not mean unpaid.', cta: 'Open Earn page', cta_link: 'earn' }
];

async function isOn() {
  return (await getSetting('campaign_bot_on', '1')) !== '0';
}

async function pickPromo() {
  const used = (await db.collection('campaign_log')
    .find({})
    .sort({ created_at: -1 })
    .limit(PROMOS.length)
    .project({ title: 1 })
    .toArray()).map((r) => r.title);
  const fresh = PROMOS.filter((p) => !used.includes(p.title));
  const pool = fresh.length ? fresh : PROMOS;
  return pool[Math.floor(Math.random() * pool.length)];
}

async function runOne(reason) {
  const promo = await pickPromo();
  // retire the previous bot banner, promote the new one
  await db.collection('campaigns').updateMany({ source: 'bot', on: true }, { $set: { on: false } });
  const id = uid('cmp');
  await db.collection('campaigns').insertOne({
    _id: id,
    title: promo.title,
    body: promo.body,
    cta: promo.cta,
    cta_link: promo.cta_link,
    source: 'bot',
    on: true,
    created_at: now()
  });
  // broadcast into the town hall as the desk
  const desk = await db.collection('users').findOne({ role: 'admin' });
  await db.collection('room_messages').insertOne({
    _id: uid('msg'),
    room: 'townhall',
    sender_user_id: desk ? desk._id : null,
    sender_handle: desk ? desk.handle : 'desk',
    message: '📣 ' + promo.title + ' — ' + promo.body,
    image_url: null,
    timestamp: now()
  });
  await db.collection('campaign_log').insertOne({
    _id: uid('clog'),
    campaign_id: id,
    title: promo.title,
    reason: reason || 'schedule',
    created_at: now()
  });
  await setSetting('campaign_bot_last', now());
  return { id, title: promo.title, reason: reason || 'schedule' };
}

async function status() {
  const last = await getSetting('campaign_bot_last', '');
  const runs = await db.collection('campaign_log').countDocuments({});
  const log = await db.collection('campaign_log').find({}).sort({ created_at: -1 }).limit(8).toArray();
  return {
    on: await isOn(),
    last: last || null,
    interval_hours: INTERVAL_MS / 36e5,
    runs,
    log,
    note: 'Rotates earnings-promo banners site-wide and announces each one in the town hall. It never posts as a student and never fakes views.'
  };
}

async function setOn(on) {
  await setSetting('campaign_bot_on', on ? '1' : '0');
  return status();
}

async function tick() {
  if (!(await isOn())) return null;
  const last = await getSetting('campaign_bot_last', '');
  if (last && Date.now() - Date.parse(last) < INTERVAL_MS) return null;
  try {
    return await runOne('schedule');
  } catch (e) {
    console.warn('campaign bot', e);
    return null;
  }
}

function start() {
  tick();
  setInterval(() => { tick(); }, Math.min(INTERVAL_MS, 30 * 60 * 1000));
}

module.exports = { runOne, status, setOn, start, isOn };