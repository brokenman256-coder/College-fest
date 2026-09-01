const { db, uid, now, getSetting, setSetting } = require('./db');

const INTERVAL_MS = Number(process.env.BLOG_BOT_INTERVAL_MS || 1 * 60 * 60 * 1000);

const BRIEFS = [
  {
    section: 'safety',
    title: 'Anti-ragging: what the UGC actually requires',
    official: [
      'UGC Regulations on Curbing the Menace of Ragging in Higher Educational Institutions, 2009, follow a Supreme Court judgment (8 May 2009). Text: https://www.ugc.gov.in and https://www.antiragging.in',
      '24×7 national helpline 1800-180-5522. Email helpline@antiragging.in. Undertakings: https://www.antiragging.in',
      'UGC public notice (July 2026) tells every HEI to keep anti-ragging bodies working, put the helpline on display, run orientation, watch hostels, protect complainants, and register an FIR where there is a prima facie case.'
    ]
  },
  {
    section: 'safety',
    title: 'If you are in distress: official mental-health lines',
    official: [
      'Tele-MANAS (Ministry of Health): 14416 or 1800-891-4416, 24×7, multiple Indian languages. https://telemanas.mohfw.gov.in',
      'KIRAN (Ministry of Social Justice): 1800-599-0019, 24×7.',
      'iCall (TISS): 9152987821, trained counselling, typically Mon–Sat. These are national services, not this campus’s counselling cell — also use your college’s listed counsellor if you have one.'
    ]
  },
  {
    section: 'hostels',
    title: 'Hostels are a UGC vigilance zone, not a rumour mill',
    official: [
      'The same 2009 UGC ragging regulations name hostels and other crowded spaces as places institutions must watch, with prompt redressal and protection of the person who complained.',
      'Anti-ragging posters and the 1800-180-5522 number are supposed to be visible at admission desks, libraries, canteens, hostels, and common areas (UGC anti-ragging bureau notes).',
      'Use this board to describe lighting, wardens’ hours, mess hygiene, and lock practice — not to name a roommate for sport.'
    ]
  },
  {
    section: 'courses',
    title: 'Course reviews that help the next batch',
    official: [
      'UGC’s job is standards in teaching and examination (UGC Act, 1956). A useful review is workload, grading pattern, labs, and attendance — not a pile-on of a teacher’s looks or caste.',
      'If an evaluation process is unfair, the first paper trail is internal: controller of examinations, grievance cell, then UGC e-Samadhan 1800-111-656.',
      'Ask: would this note still be true if the faculty member read it? If not, rewrite it.'
    ]
  },
  {
    section: 'placements',
    title: 'Internship and offer talk without fake packages',
    official: [
      'Campus placement numbers get inflated in group chats. Stick to process: test, interviews, stipend, bond, joining date. Do not invent CTC.',
      'If a recruiter asks for money to “confirm” a seat, that is a red flag. Report it to your placement cell in writing.',
      'Internshala / college T&P notices are not the same as a signed offer. Say which one you mean.'
    ]
  },
  {
    section: 'events',
    title: 'Campus events: paste the notice, not a rumour',
    official: [
      'Fests and talks should start from a college notice, dean’s circular, or a public Instagram post the desk can store as a URL.',
      'This board does not scrape Instagram. Staff paste a public link on the Events tab.',
      'If an event involves money collection, name the club and the account the college uses — not a personal UPI unless the notice says so.'
    ]
  }
];

async function fetchRedditSnippets() {
  const url = 'https://www.reddit.com/r/college+Indian_Academia+collegeadvice/hot.json?limit=12';
  const res = await fetch(url, {
    headers: { 'user-agent': 'CollegeFestDeskBot/1.0 (attributed research briefs; not republished as confessions)' }
  });
  if (!res.ok) throw new Error('Reddit ' + res.status);
  const data = await res.json();
  const children = (data.data && data.data.children) || [];
  return children
    .map((c) => c.data || {})
    .filter((d) => d.title && d.permalink && !d.over_18)
    .slice(0, 8)
    .map((d) => ({
      title: String(d.title).slice(0, 180),
      url: 'https://www.reddit.com' + d.permalink,
      sub: d.subreddit
    }));
}

async function pickBrief() {
  const used = (await db.collection('posts')
    .find({ source: 'bot' })
    .sort({ created_at: -1 })
    .limit(8)
    .project({ title: 1 })
    .toArray()).map((r) => r.title);
  const fresh = BRIEFS.filter((b) => !used.includes(b.title));
  const pool = fresh.length ? fresh : BRIEFS;
  return pool[Math.floor(Math.random() * pool.length)];
}

function buildBody(brief, reddit) {
  const lines = [];
  lines.push('Desk research brief — written by the campus board bot. This is not a student confession and not a claim that these events happened on this campus.');
  lines.push('');
  lines.push('Official / trusted sources');
  for (const o of brief.official) lines.push('• ' + o);
  lines.push('');
  if (reddit.length) {
    lines.push('What students are discussing on Reddit (attributed, not rewritten as our gossip)');
    for (const r of reddit.slice(0, 3)) {
      lines.push('• r/' + r.sub + ': ' + r.title + ' — ' + r.url);
    }
    lines.push('');
    lines.push('Those threads are other campuses and other countries. Treat them as questions to test here, not as facts about this college.');
  } else {
    lines.push('Reddit was unreachable this run. The official sources above still stand.');
  }
  lines.push('');
  lines.push('If you study here: reply with what you have actually seen. Do not invent. Do not name people just to pile on.');
  return lines.join('\n');
}

async function publishOne(reason) {
  const brief = await pickBrief();
  let reddit = [];
  try {
    reddit = await fetchRedditSnippets();
  } catch (e) {
    console.warn('blog bot reddit', e.message);
  }
  const title = brief.title;
  const body = buildBody(brief, reddit);
  const sourceUrl = reddit[0] ? reddit[0].url : 'https://www.ugc.gov.in';
  const id = uid('post');
  await db.collection('posts').insertOne({
    _id: id,
    user_id: null,
    section: brief.section,
    title,
    body,
    unique_views: 0,
    likes: 0,
    source: 'bot',
    source_url: sourceUrl,
    hidden: false,
    created_at: now()
  });
  await setSetting('blog_bot_last', now());
  return { id, title, section: brief.section, reddit: reddit.length, reason: reason || 'schedule' };
}

async function isOn() {
  return (await getSetting('blog_bot_on', '1')) !== '0';
}

async function status() {
  const last = await getSetting('blog_bot_last', '');
  const count = await db.collection('posts').countDocuments({ source: 'bot' });
  return {
    on: await isOn(),
    last: last || null,
    interval_hours: INTERVAL_MS / 36e5,
    posts: count,
    note: 'Publishes labeled research briefs with UGC / Tele-MANAS citations and attributed Reddit links. Not fake student stories. Not fake views.'
  };
}

async function setOn(on) {
  await setSetting('blog_bot_on', on ? '1' : '0');
  return status();
}

async function tick() {
  if (!(await isOn())) return null;
  const last = await getSetting('blog_bot_last', '');
  if (last && Date.now() - Date.parse(last) < INTERVAL_MS) return null;
  try {
    return await publishOne('schedule');
  } catch (e) {
    console.warn('blog bot', e);
    return null;
  }
}

function start() {
  tick();
  setInterval(() => { tick(); }, Math.min(INTERVAL_MS, 60 * 60 * 1000));
}

module.exports = { publishOne, status, setOn, start, isOn };
