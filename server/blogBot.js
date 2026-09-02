const { db, uid, now, getSetting, setSetting } = require('./db');

const INTERVAL_MS = Number(process.env.BLOG_BOT_INTERVAL_MS || 1 * 60 * 60 * 1000);

/* ================= THE MIDNIGHT QUILL =================
   The site's resident ghostwriter. Posts labeled research
   briefs about American universities — always under the
   anonymous tag, never as a student, never fake stories. */

const BOT_NAME = 'The Midnight Quill';

const BRIEFS = [
  {
    section: 'safety',
    title: 'The Clery Act: your university publishes its crime record every year — read it',
    official: [
      'Every US university that gets federal aid must publish an Annual Security Report: crime on and around campus, arrests, disciplinary referrals. Find it on your school\'s site (search "<your university> annual security report").',
      'The US Department of Education keeps a public campus safety data tool — you can compare universities side by side: https://ope.ed.gov/campussafety',
      'Schools must keep a public daily crime log at campus police. Ask for it by name — they are required to show it within two business days.'
    ]
  },
  {
    section: 'safety',
    title: 'Title IX: what your university legally owes you when you report',
    official: [
      'Title IX (20 U.S.C. §1681) bans sex discrimination at any school that takes federal money. Every university must have a named Title IX Coordinator — their email is on the school site.',
      'When you report, the school must offer support measures (no-contact directives, schedule changes, dorm moves) whether or not you ask for an investigation.',
      'If the school ignores a report, complaints go to the US Department of Education Office for Civil Rights: https://www2.ed.gov/about/offices/list/ocr'
    ]
  },
  {
    section: 'safety',
    title: 'Hazing is now a federal reporting requirement — the record is public',
    official: [
      'The Stop Campus Hazing Act (signed Dec 2024) forces every university to publish hazing violations by organizations — including Greek life and clubs — on a public website.',
      'Most states also have anti-hazing laws; many make hazing a crime even when the person "agreed" to it. Consent is not a defense.',
      'If you see it happening, campus police and the student conduct office both take anonymous tips. You do not have to attach your name to a report.'
    ]
  },
  {
    section: 'hostels',
    title: 'Dorm life: the checks that actually matter at move-in',
    official: [
      'Your university must publish an Annual Fire Safety Report (part of Clery): fires on campus, alarm systems, false alarms per residence hall. It tells you which dorms actually have working systems.',
      'US Fire Administration campus fire safety guidance: most dorm fires start with cooking and candles. Know where the pull stations and extinguishers on your floor are.',
      'RA on-duty schedules, guest policies, and quiet hours are set by the housing office — get the written policy, not the rumor version.'
    ]
  },
  {
    section: 'courses',
    title: 'FERPA: your grade records belong to you, not your parents, not the group chat',
    official: [
      'FERPA (20 U.S.C. §1232g) gives you the right to inspect your education records and demand correction of anything wrong. File the request with the registrar — they must respond in a reasonable time.',
      'Schools may not share your records with outsiders without your written consent (with narrow exceptions). "We told your professor" is not how it works.',
      'Grade appeals: every school has a written procedure — syllabus policy, department chair, then dean. Start the paper trail in writing, keep copies.'
    ]
  },
  {
    section: 'placements',
    title: 'Internship and offer talk without fake packages',
    official: [
      'If a "recruiter" asks you to pay for training, equipment, or to "release" an offer, it is a scam. Real US employers never charge candidates — report it to your career center.',
      'Compare offers in writing: base, signing bonus, benefits, start date, location. NACE (National Association of Colleges and Employers) publishes real salary trend data — https://www.naceweb.org',
      'An internship offer that arrives without an interview, or a check you are asked to deposit, is the classic advance-fee scam. Forward it to the FTC: https://reportfraud.ftc.gov'
    ]
  },
  {
    section: 'events',
    title: 'Campus events: verify the notice before you queue up',
    official: [
      'Real campus events trace to a student activities office posting, a club\'s official channel, or a dean\'s circular — ask for the link, not a screenshot of a screenshot.',
      'If an event collects money, the payment should go through the university or the club\'s registered account — never a personal Venmo / Zelle unless the official notice says so.',
      'Big speakers and fests are usually booked through the student union. If the venue and the ticket link do not match the official calendar, ask the activities office before paying.'
    ]
  }
];

async function fetchRedditSnippets() {
  const url = 'https://www.reddit.com/r/college+collegeadvice+ApplyingToCollege/hot.json?limit=12';
  const res = await fetch(url, {
    headers: { 'user-agent': 'MidnightQuillBot/1.0 (attributed research briefs; not republished as confessions)' }
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
  lines.push('A brief by The Midnight Quill 🪶 — the campus board\'s resident writer. Posted under the anonymous tag like everything else here. This is not a student confession and not a claim that these events happened at one campus.');
  lines.push('');
  lines.push('Official / trusted sources');
  for (const o of brief.official) lines.push('• ' + o);
  lines.push('');
  if (reddit.length) {
    lines.push('What students are discussing on Reddit (attributed, never rewritten as our gossip)');
    for (const r of reddit.slice(0, 3)) {
      lines.push('• r/' + r.sub + ': ' + r.title + ' — ' + r.url);
    }
    lines.push('');
    lines.push('Those threads are other campuses. Treat them as questions to test at your university, not as facts.');
  } else {
    lines.push('Reddit was unreachable this run. The official sources above still stand.');
  }
  lines.push('');
  lines.push('If you study at one of these universities: reply with what you have actually seen. Do not invent. Do not name people just to pile on.');
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
  const sourceUrl = reddit[0] ? reddit[0].url : 'https://www.ed.gov';
  const id = uid('post');
  await db.collection('posts').insertOne({
    _id: id,
    user_id: null,
    section: brief.section,
    title,
    body,
    university: null,
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
    name: BOT_NAME,
    last: last || null,
    interval_hours: INTERVAL_MS / 36e5,
    posts: count,
    note: 'The Midnight Quill writes labeled research briefs about American universities — Clery Act records, Title IX, FERPA, hazing law — with citations and attributed Reddit links. Always under the anonymous tag. Not fake student stories. Not fake views.'
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

module.exports = { publishOne, status, setOn, start, isOn, BOT_NAME };