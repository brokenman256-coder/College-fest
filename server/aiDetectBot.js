/* lightweight heuristic AI-text detector — no external API calls, no cost.
   This is a triage signal for admin review, never a verdict: posts stay
   live either way, a flag only surfaces the post in the desk for a human
   to look at. False positives are expected and fine — false silencing of
   a real student's story is not. */

const AI_PHRASES = [
  'as an ai language model', 'i am an ai', "in today's fast-paced world",
  'it is important to note that', 'it is worth noting', 'in conclusion',
  'delve into', 'navigate the complexities', 'plays a pivotal role',
  'overall, it is evident', 'in summary', 'a testament to', 'in the realm of',
  'unlock the potential', 'holistic approach', 'in the digital age',
  'seamless integration', 'foster a sense of', 'multifaceted',
  'underscores the importance', 'cannot be overstated', 'stands as a',
  'serves as a reminder', 'it is crucial to', 'garnered attention'
];

const TRANSITIONS = /\b(additionally|furthermore|moreover|however|therefore|consequently|nonetheless)\b/g;
const CASUAL_MARKERS = /(lol|lmao|omg|tbh|ngl|idk|fr fr|\.\.\.|!!|👀|😭|💀|ikr|bruh|wtf|ya+r|bro)/i;
const CONTRACTION = /\b\w+'(t|re|ve|ll|s|d|m)\b/i;

function sentenceSplit(text) {
  return text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
}

function scoreAIlikelihood(text) {
  const clean = String(text || '').trim();
  if (clean.length < 80) return { score: 0, reasons: [] };
  const lower = clean.toLowerCase();
  const reasons = [];
  let score = 0;

  let phraseHits = 0;
  for (const p of AI_PHRASES) if (lower.includes(p)) phraseHits++;
  if (phraseHits > 0) { score += Math.min(45, phraseHits * 15); reasons.push(`${phraseHits} stock AI phrase(s)`); }

  const sentences = sentenceSplit(clean);
  if (sentences.length >= 4) {
    const lens = sentences.map((s) => s.split(/\s+/).length);
    const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
    const variance = lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length;
    const cv = mean > 0 ? Math.sqrt(variance) / mean : 0;
    if (cv < 0.35) { score += 20; reasons.push('unusually uniform sentence length'); }
  }

  if (!CASUAL_MARKERS.test(clean) && clean.length > 400) {
    score += 10; reasons.push('no casual/slang markers in a long post');
  }
  if (!CONTRACTION.test(clean) && clean.length > 300) {
    score += 10; reasons.push('no contractions');
  }

  const transitions = (lower.match(TRANSITIONS) || []).length;
  const wordCount = clean.split(/\s+/).length;
  if (wordCount > 0 && transitions / wordCount > 0.02) {
    score += 15; reasons.push('heavy use of formal transition words');
  }

  return { score: Math.min(100, Math.round(score)), reasons };
}

const AI_FLAG_THRESHOLD = 55;

module.exports = { scoreAIlikelihood, AI_FLAG_THRESHOLD };
