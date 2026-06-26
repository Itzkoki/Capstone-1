/**
 * communityContentAnalyzer — automated flag detection for the Community Module.
 * ─────────────────────────────────────────────────────────────────────────
 * Analyzes forum text against predefined keyword / phrase / contextual-indicator
 * lists for four categories and returns, for each match, the CATEGORY, a
 * SEVERITY (low | medium | high) and the EXACT cue that triggered it.
 *
 *   • inappropriate  — profanity, sexual content, hate speech / slurs, graphic violence
 *   • harassment     — insults, bullying, threats, discrimination
 *   • misinformation — false / deceptive claims (health, finance, politics, general)
 *   • crisis         — self-harm, severe distress, harm to others, emergencies
 *
 * Built for a Philippine (English / Filipino / Taglish) community. To resist
 * evasion (e.g. "g@g0", "t4nga", "f u c k") the input is normalized:
 *   - leet/look-alike substitution (@→a, 4→a, 3→e, 0→o, 1→i, $→s, …)
 *   - repeated-char collapsing ("fuuuuck" → "fuuck")
 *   - single-letter de-spacing ("f u c k" → "fuck")
 * Keyword matching runs on the normalized text; phrase/contextual PATTERNS run
 * on BOTH the lightly-cleaned text (keeps digits, e.g. "100%") and the
 * normalized text (catches leetspeak threats).
 *
 * @typedef {Object} Match   { category, sub, severity, term }
 * @typedef {Object} Result  { flagged, severity, categories[], matches[] }
 */

const SEV_RANK = { low: 1, medium: 2, high: 3 };
const CAT_PRIORITY = { crisis: 4, harassment: 3, inappropriate: 2, misinformation: 1 };

// ── Keyword groups: { category, sub, severity, words[] } ─────────────────────
// `words` are stored in already-normalized form (lowercase, no leetspeak). Each
// is matched as a whole word/phrase against the normalized input.
const GROUPS = [
  // ── INAPPROPRIATE · profanity ──
  { category: 'inappropriate', sub: 'profanity', severity: 'low', words: [
    'damn', 'hell', 'crap', 'piss', 'screw you', 'bwisit', 'buwisit', 'peste', 'peste',
    'leche', 'letse', 'lintik', 'hudas', 'diablo', 'demonyo ka',
  ] },
  { category: 'inappropriate', sub: 'profanity', severity: 'medium', words: [
    'fuck', 'fuckyou', 'fucking', 'fucker', 'motherfucker', 'mother fucker', 'fuckface',
    'shit', 'bullshit', 'shitty', 'asshole', 'ass hole', 'bitch', 'son of a bitch',
    'bastard', 'dick', 'dickhead', 'prick', 'douche', 'douchebag', 'jackass', 'dumbass',
    'wanker', 'twat', 'bollocks',
    'puta', 'puta ka', 'putangina', 'putang ina', 'tangina', 'tang ina', 'tngina',
    'ptangina', 'pakshet', 'pakyu', 'pakyew', 'taena', 'taina', 'gago', 'gaga', 'gagi',
    'ulol', 'punyeta', 'punyemas', 'kupal', 'tarantado', 'tarantada', 'gunggong',
    'ungas', 'putragis', 'kingina', 'kangina ka', 'tangna', 'pisti', 'yawa', 'hayop ka',
    'hayup ka', 'animal ka', 'hindot', 'hindot ka', 'shunga', 'inutil ka',
  ] },
  { category: 'inappropriate', sub: 'profanity', severity: 'high', words: [
    'cunt', 'bilat', 'bilat ng ina',
  ] },

  // ── INAPPROPRIATE · sexually explicit ──
  { category: 'inappropriate', sub: 'sexual_explicit', severity: 'medium', words: [
    'sex', 'blowjob', 'blow job', 'handjob', 'hand job', 'nude', 'nudes', 'naked pics',
    'porn', 'pornhub', 'pornography', 'masturbate', 'masturbation', 'sexting',
    'send nudes', 'send pics', 'dick pic', 'horny', 'cum', 'orgasm', 'anal', 'oral sex',
    'hook up', 'one night stand', 'fuck buddy', 'fubu', 'naka alter', 'alter account',
    'kantot', 'kantutan', 'jakol', 'jabol', 'chupa', 'tsupa', 'tamod', 'burat',
    'malibog', 'libog', 'pokpok', 'pekpek', 'puke', 'titi', 'etits', 'pinit', 'iyot',
  ] },

  // ── INAPPROPRIATE · hate speech / offensive slurs ──
  { category: 'inappropriate', sub: 'slur', severity: 'high', words: [
    'nigger', 'nigga', 'faggot', 'fag', 'retard', 'retarded', 'chink', 'spic', 'kike',
    'tranny', 'dyke', 'coon', 'gook', 'wetback', 'sped ka', 'abnoy ka', 'unggoy ka',
  ] },

  // ── INAPPROPRIATE · graphic violence ──
  { category: 'inappropriate', sub: 'graphic_violence', severity: 'high', words: [
    'behead', 'beheading', 'decapitate', 'torture', 'massacre', 'mutilate', 'mutilation',
    'dismember', 'execution', 'bloodbath', 'slaughter', 'lynch', 'gore', 'disembowel',
  ] },

  // ── HARASSMENT · insults ──
  { category: 'harassment', sub: 'insult', severity: 'low', words: [
    'bobo', 'boba', 'inutil', 'engot', 'tanga ka', 'ang tanga mo', 'loser', 'idiot',
    'moron', 'stupid', 'clown', 'pathetic', 'dumb', 'imbecile', 'tonto', 'walang utak',
    'ang panget mo', 'ang pangit mo', 'ang baho mo', 'useless ka', 'wala kang silbi',
    'ang taba mo', 'pandak', 'corny ka',
  ] },

  // ── HARASSMENT · bullying / personal attacks ──
  { category: 'harassment', sub: 'bullying', severity: 'medium', words: [
    'walang kwenta ka', 'wala kang kwenta', 'pabigat ka', 'salot ka', 'you are worthless',
    'youre worthless', 'you are a failure', 'youre a failure', 'nobody likes you',
    'no one likes you', 'no one cares about you', 'you are nothing', 'youre nothing',
    'you are disgusting', 'kadiri ka', 'mamatay ka na', 'wala kang silbi sa mundo',
  ] },

  // ── CRISIS · self-harm / suicide ──
  { category: 'crisis', sub: 'self_harm', severity: 'high', words: [
    'i want to die', 'i wanna die', 'i want to kill myself', 'kill myself', 'killing myself',
    'kms', 'end it all', 'end my life', 'end myself', 'better off dead', 'i should die',
    'life is not worth living', 'i dont want to live', 'i do not want to live anymore',
    'no reason to live', 'self harm', 'self-harm', 'cutting myself', 'cut myself',
    'gusto ko nang mamatay', 'gusto ko ng mamatay', 'gusto ko na mamatay',
    'ayoko na mabuhay', 'ayoko nang mabuhay', 'magpapakamatay', 'magpapakamatay ako',
    'magpapatiwakal', 'tatapusin ko na ang lahat', 'tapusin ko na ang lahat',
    'tapusin ko na ito', 'papatayin ko ang sarili ko', 'hihiwa ako', 'wala nang silbi mabuhay',
  ] },
  // ── CRISIS · severe emotional distress ──
  { category: 'crisis', sub: 'distress', severity: 'medium', words: [
    'i cant go on', 'i can not go on', 'i give up', 'im done with everything',
    'i am done with everything', 'i feel hopeless', 'i am hopeless', 'im so tired of life',
    'i cant take it anymore', 'i cant do this anymore',
    'wala nang pag-asa', 'wala nang pag asa', 'wala nang silbi ang buhay ko',
    'sobrang pagod na ako sa buhay', 'sawa na ako sa buhay', 'wala na akong silbi',
    'di ko na kaya', 'hindi ko na kaya', 'suko na ako sa buhay',
  ] },
  // ── CRISIS · harm to others ──
  { category: 'crisis', sub: 'harm_others', severity: 'high', words: [
    'i will kill them', 'ill kill them', 'i will kill him', 'i will kill her',
    'i want to hurt someone', 'someone deserves to die', 'i will shoot them',
    'i will hurt them', 'papatayin ko siya', 'papatayin ko sila', 'gusto kong manakit',
    'gusto ko silang patayin', 'sasaksakin ko', 'sasaktan ko sila', 'babarilin ko sila',
  ] },
  // ── CRISIS · emergency / immediate danger ──
  { category: 'crisis', sub: 'emergency', severity: 'high', words: [
    'help me please', 'this is an emergency', 'i am in danger', 'im in danger',
    'someone is hurting me', 'call the police', 'hostage', 'attack happening',
    'may sasaktan sa akin', 'may barilan', 'may holdap', 'may nagpapakamatay',
    'tulungan niyo ako', 'nasa panganib ako', 'sinasaktan ako', 'ininment',
  ] },
];

// ── Phrase / contextual PATTERNS: { category, sub, severity, re } ────────────
const PATTERNS = [
  // Harassment · threats
  { category: 'harassment', sub: 'threat', severity: 'high',
    re: /\b(i('?ll| will)|im gonna|i am going to|gonna)\s+(kill|murder|hurt|rape|shoot|stab|beat|destroy|end|ruin)\s+(you|u|him|her|them|your)\b/ },
  { category: 'harassment', sub: 'threat', severity: 'high',
    re: /\b(watch your back|you('?re| are) dead|i('?ll| will) find you|i('?ll| will) make you pay|i('?ll| will) get you|papatayin kita|papatayin ko kayo|sasaktan kita|sasaktan kita|tatapusin kita|hahanapin kita|pagbabayaran mo|babalikan kita)\b/ },
  { category: 'harassment', sub: 'threat', severity: 'high',
    re: /\b(kill ?your ?self|kys|go kill yourself|go die|hang yourself)\b/ },
  // Harassment · bullying patterns
  { category: 'harassment', sub: 'bullying', severity: 'medium',
    re: /\byou('?re| are)\s+(so\s+)?(ugly|fat|stupid|worthless|useless|pathetic|disgusting|trash|garbage|a failure|nothing|a loser|dumb)\b/ },
  { category: 'harassment', sub: 'bullying', severity: 'medium',
    re: /\bno\s*one\s+(likes|loves|cares about|wants)\s+you\b/ },
  // Harassment · discrimination
  { category: 'harassment', sub: 'discrimination', severity: 'medium',
    re: /\b(go back to your country|you people are|because (you'?re|she'?s|he'?s) (a )?(woman|gay|muslim|christian|disabled|bakla|tomboy))\b/ },
  // Inappropriate · hate speech (targeted at a protected group)
  { category: 'inappropriate', sub: 'hate_speech', severity: 'high',
    re: /\b(all\s+)?(muslims?|christians?|catholics?|jews?|gays?|lesbians?|baklas?|tomboys?|blacks?|whites?|asians?|filipinos?|chinese|indians?|women|men|trans(gender)?|bisexuals?|disabled people)\s+(should\s+(die|be killed|be banned|disappear)|are\s+(animals|vermin|trash|subhuman|scum|disgusting)|don'?t\s+deserve)\b/ },
  // Misinformation · health
  { category: 'misinformation', sub: 'health', severity: 'medium',
    re: /\b(100\s*%?\s*(guaranteed|effective)\s*(cure|treatment)|miracle\s+(cure|drug|treatment)|cure[sd]?\s+(cancer|covid|hiv|aids)\s+(naturally|instantly|fast|overnight)|doctors?\s+(don'?t|do not|hate that you|hate when you)\s*want\s+you\s+to\s+know|vaccines?\s+cause\s+autism|covid(-19)?\s+is\s+a\s+(hoax|lie|scam|myth)|big\s*pharma\s+(coverup|cover-up|conspiracy|hides)|plandemic|drink\s+bleach)\b/ },
  // Misinformation · finance
  { category: 'misinformation', sub: 'finance', severity: 'medium',
    re: /\b(guaranteed\s+(profit|kita|returns?|income)|risk[-\s]?free\s+investment|get\s+rich\s+quick|double\s+your\s+money|triple\s+your\s+money|walang\s+talo|investment\s+with\s+no\s+risk|100\s*%?\s+legit\s+(paluwagan|investment|sideline)|kumita\s+ng\s+(libo|milyon)\s+(agad|overnight))\b/ },
  // Misinformation · general / conspiratorial framing
  { category: 'misinformation', sub: 'general', severity: 'low',
    re: /\b(secret\s+government\s+cover-?up|share\s+(this\s+)?before\s+(it('?s| is)\s+)?(deleted|taken down)|this\s+is\s+being\s+hidden\s+from\s+the\s+public|wake\s+up\s+sheeple|they\s+don'?t\s+want\s+you\s+to\s+know|no\s+proof\s+needed|trust\s+me\s+bro)\b/ },
  // Misinformation · elections
  { category: 'misinformation', sub: 'politics', severity: 'medium',
    re: /\b(dayaan\s+(ang|sa)\s+(eleksyon|halalan)|election\s+(is\s+)?rigged|rigged\s+election|fake\s+government\s+announcement|fabricated\s+(stats|statistics))\b/ },
  // Crisis · self-harm phrasing (variations)
  { category: 'crisis', sub: 'self_harm', severity: 'high',
    re: /\b(i\s+(want|wanna|wish|need)\s+to\s+(die|disappear|end (it|my life|everything))|gusto\s+ko\s+(na|ng)?\s*mamatay|ayoko\s+na(ng)?\s+(mabuhay|mag-?exist|mag exist))\b/ },
];

// ── Normalization ────────────────────────────────────────────────────────────
function clean(text) {
  // Light clean — preserves digits so misinformation patterns like "100%" match.
  return String(text || '')
    .toLowerCase()
    .replace(/[​-‍﻿]/g, '')
    .replace(/[αа]/g, 'a').replace(/[еёε]/g, 'e').replace(/[іι]/g, 'i')
    .replace(/[оο]/g, 'o').replace(/[υу]/g, 'u')
    .replace(/(.)\1{2,}/g, '$1$1');           // collapse 3+ repeats → 2
}

function normalize(text) {
  let t = clean(text)
    .replace(/[@4]/g, 'a').replace(/3/g, 'e').replace(/0/g, 'o')
    .replace(/[1!|]/g, 'i').replace(/[$5]/g, 's').replace(/7/g, 't').replace(/9/g, 'g');
  // Join single-letter spacing: "f u c k" → "fuck" (space between two lone letters).
  t = t.replace(/(?<=\b[a-z])\s+(?=[a-z]\b)/g, '');
  return t;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ── Public: analyze ──────────────────────────────────────────────────────────
function analyze(text) {
  const base = clean(text);
  const norm = normalize(text);
  const matches = [];
  const seen = new Set();

  const add = (m) => {
    const key = `${m.sub}:${m.term}`;
    if (seen.has(key)) return;
    seen.add(key);
    matches.push(m);
  };

  // Keyword groups (whole word/phrase against the normalized text).
  for (const g of GROUPS) {
    for (const w of g.words) {
      const re = new RegExp(`\\b${escapeRe(w)}\\b`, 'i');
      if (re.test(norm)) add({ category: g.category, sub: g.sub, severity: g.severity, term: w });
    }
  }

  // Phrase / contextual patterns (test against both cleaned + normalized text).
  for (const p of PATTERNS) {
    const hit = p.re.exec(base) || p.re.exec(norm);
    if (hit) add({ category: p.category, sub: p.sub, severity: p.severity, term: hit[0].trim() });
  }

  if (!matches.length) {
    return { flagged: false, severity: 'none', categories: [], matches: [] };
  }

  // Overall severity = highest match; bump low→medium when many mild hits pile up
  // (frequency / cumulative-harm signal).
  let severity = 'low';
  for (const m of matches) if (SEV_RANK[m.severity] > SEV_RANK[severity]) severity = m.severity;
  const mildCount = matches.filter(m => m.severity === 'low').length;
  if (severity === 'low' && mildCount >= 3) severity = 'medium';

  const categories = [...new Set(matches.map(m => m.category))];
  return { flagged: true, severity, categories, matches };
}

// Map an analysis to the Community incident event + severity for the Action Center.
function toIncident(result) {
  let best = result.matches[0];
  for (const m of result.matches) {
    const better = SEV_RANK[m.severity] > SEV_RANK[best.severity] ||
      (SEV_RANK[m.severity] === SEV_RANK[best.severity] && CAT_PRIORITY[m.category] > CAT_PRIORITY[best.category]);
    if (better) best = m;
  }
  const eventByCategory = {
    crisis: 'crisis_detected',
    harassment: 'harassment',
    inappropriate: 'prohibited_content',
    misinformation: 'misinformation',
  };
  return { eventType: eventByCategory[best.category] || 'prohibited_content', severity: result.severity };
}

// Human-readable detail string for the incident timeline.
function describe(result, contentType, contentId, text) {
  const cats = result.categories.join(', ');
  const cues = result.matches.map(m => `"${m.term}" (${m.category}/${m.severity})`).join(', ');
  const excerpt = text ? (text.length > 300 ? text.slice(0, 300) + '…' : text) : '';
  return `Auto-detected on ${contentType} #${contentId}. Categories: ${cats}. Severity: ${result.severity}. ` +
    `Triggered by: ${cues}.${excerpt ? ` Content: "${excerpt}"` : ''}`;
}

module.exports = { analyze, toIncident, describe, normalize };
