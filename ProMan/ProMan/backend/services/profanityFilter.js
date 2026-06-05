/**
 * Profanity & Harmful Language Filter Service
 * ─────────────────────────────────────────────────
 * Multi-layer detection engine:
 *  1. Database keyword matching (customizable by moderators)
 *  2. Built-in pattern matching (obfuscation-resistant)
 *  3. Context-aware severity scoring
 *
 * Supports: English, Filipino/Tagalog, Taglish
 * Detects: Direct profanity, leet-speak, spacing tricks,
 *          repeated chars, unicode substitutions
 */

const ModerationKeyword = require('../models/ModerationKeyword');

// ── BUILT-IN PATTERNS (always active, cannot be removed by moderators) ──

const BUILTIN_PATTERNS = [
  // === ENGLISH — Severe ===
  { pattern: /\bn+[i!1|]+g+[g9]+[aeiou@4]+[r]*s?\b/gi, category: 'racist_slur', severity: 'severe', lang: 'en' },
  { pattern: /\bf+[a@4]+g+[g9]*[o0]+t*s?\b/gi, category: 'homophobic_slur', severity: 'severe', lang: 'en' },
  { pattern: /\bd+[y]+k+[e3]*s?\b/gi, category: 'homophobic_slur', severity: 'severe', lang: 'en' },
  { pattern: /\bt+r+[a@4]+n+n+[yi1!]+[e3]*s?\b/gi, category: 'transphobic_slur', severity: 'severe', lang: 'en' },
  { pattern: /\bk+[i!1]+k+[e3]+s?\b/gi, category: 'racist_slur', severity: 'severe', lang: 'en' },
  { pattern: /\bc+[h]+[i!1]+n+k+s?\b/gi, category: 'racist_slur', severity: 'severe', lang: 'en' },
  { pattern: /\bsp+[i!1]+[ck]+s?\b/gi, category: 'racist_slur', severity: 'severe', lang: 'en' },
  { pattern: /\br+[e3]+t+[a@4]+r+d/gi, category: 'ableist_slur', severity: 'severe', lang: 'en' },

  // === ENGLISH — Threats & Harassment ===
  { pattern: /\b(i('?ll|.*will)|gonna)\s+(kill|murder|hurt|rape|shoot|stab|beat)\s+(you|u|her|him|them)\b/gi, category: 'threat', severity: 'severe', lang: 'en' },
  { pattern: /\byou\s+(should|deserve\s+to)\s+(die|be\s+killed|get\s+raped)\b/gi, category: 'threat', severity: 'severe', lang: 'en' },
  { pattern: /\bgo\s+kill\s+your\s*self\b/gi, category: 'threat', severity: 'severe', lang: 'en' },
  { pattern: /\bkys\b/gi, category: 'threat', severity: 'severe', lang: 'en' },

  // === ENGLISH — Moderate Profanity ===
  { pattern: /\bf+[u*]+c*k+/gi, category: 'profanity', severity: 'moderate', lang: 'en' },
  { pattern: /\bs+h+[i!1]+t+/gi, category: 'profanity', severity: 'moderate', lang: 'en' },
  { pattern: /\bb+[i!1]+t+c+h+/gi, category: 'profanity', severity: 'moderate', lang: 'en' },
  { pattern: /\ba+s+s+h+[o0]+l+e+/gi, category: 'profanity', severity: 'moderate', lang: 'en' },
  { pattern: /\bc+[u*]+n+t+s?\b/gi, category: 'profanity', severity: 'severe', lang: 'en' },
  { pattern: /\bd+[i!1]+c*k+s?\b/gi, category: 'profanity', severity: 'moderate', lang: 'en' },
  { pattern: /\bp+[u*]+s+s+[yi1!]+/gi, category: 'profanity', severity: 'moderate', lang: 'en' },
  { pattern: /\bw+h+[o0]+r+[e3]+/gi, category: 'profanity', severity: 'moderate', lang: 'en' },
  { pattern: /\bs+l+[u*]+t+s?\b/gi, category: 'sexist', severity: 'moderate', lang: 'en' },
  { pattern: /\bd+[a@4]+m+n+/gi, category: 'profanity', severity: 'mild', lang: 'en' },
  { pattern: /\bh+[e3]+l+l+\b/gi, category: 'profanity', severity: 'mild', lang: 'en' },
  { pattern: /\bc+r+[a@4]+p+/gi, category: 'profanity', severity: 'mild', lang: 'en' },
  { pattern: /\bstfu\b/gi, category: 'profanity', severity: 'moderate', lang: 'en' },

  // === FILIPINO/TAGALOG — Severe ===
  { pattern: /\bp+[u*]+t+[a@4]+n*g*\s*[i!1]+n+[a@4]+/gi, category: 'profanity', severity: 'severe', lang: 'tl' },
  { pattern: /\bp+[u*]+t+[a@4]+\b/gi, category: 'profanity', severity: 'severe', lang: 'tl' },
  { pattern: /\bp+[u*]+[n]+[y]+[e3]+t+[a@4]+/gi, category: 'profanity', severity: 'severe', lang: 'tl' },
  { pattern: /\bg+[a@4]+g+[o0]+\b/gi, category: 'profanity', severity: 'severe', lang: 'tl' },
  { pattern: /\bt+[a@4]+r+[a@4]+n+t+[a@4]+d+[o0]+/gi, category: 'profanity', severity: 'severe', lang: 'tl' },
  { pattern: /\bl+[i!1]+n+t+[i!1]+k+/gi, category: 'profanity', severity: 'severe', lang: 'tl' },
  { pattern: /\bp+[a@4]+k+y+[u*]+/gi, category: 'profanity', severity: 'severe', lang: 'tl' },
  { pattern: /\bt+[a@4]+n+g+[i!1]+n+[a@4]+/gi, category: 'profanity', severity: 'severe', lang: 'tl' },
  { pattern: /\bg+[a@4]+g+[o0]+/gi, category: 'profanity', severity: 'severe', lang: 'tl' },
  { pattern: /\bu+l+[o0]+l+/gi, category: 'profanity', severity: 'moderate', lang: 'tl' },
  { pattern: /\bt+[i!1]+t+[i!1]+\b/gi, category: 'profanity', severity: 'moderate', lang: 'tl' },
  { pattern: /\bb+[o0]+b+[o0]+\b/gi, category: 'profanity', severity: 'moderate', lang: 'tl' },
  { pattern: /\bt+[a@4]+n+g+[a@4]+\b/gi, category: 'profanity', severity: 'moderate', lang: 'tl' },
  { pattern: /\bl+[e3]+c+h+[e3]+/gi, category: 'profanity', severity: 'moderate', lang: 'tl' },
  { pattern: /\bg+[a@4]+y+[a@4]+t+/gi, category: 'profanity', severity: 'moderate', lang: 'tl' },
  { pattern: /\bb+[a@4]+k+l+[a@4]+\b/gi, category: 'profanity', severity: 'moderate', lang: 'tl' },
  { pattern: /\bp+[e3]+k+p+[e3]+k+/gi, category: 'profanity', severity: 'moderate', lang: 'tl' },
  { pattern: /\bk+[u*]+p+[a@4]+l+/gi, category: 'profanity', severity: 'moderate', lang: 'tl' },

  // === FILIPINO — Threats ===
  { pattern: /\bp+[a@4]+p+[a@4]+t+[a@4]+y+[i!1]+n+/gi, category: 'threat', severity: 'severe', lang: 'tl' },
  { pattern: /\bm+[a@4]+m+[a@4]+t+[a@4]+y+/gi, category: 'threat', severity: 'severe', lang: 'tl' },
  { pattern: /\bs+[a@4]+s+[a@4]+k+s+[a@4]+k+[i!1]+n+/gi, category: 'threat', severity: 'severe', lang: 'tl' },

  // === BULLYING ===
  { pattern: /\b(you('?re|r))\s+(ugly|fat|stupid|worthless|useless|pathetic|disgusting|trash|garbage)\b/gi, category: 'bullying', severity: 'moderate', lang: 'en' },
  { pattern: /\bno\s*one\s+(likes|loves|cares\s+about)\s+you\b/gi, category: 'bullying', severity: 'moderate', lang: 'en' },
  { pattern: /\bk+[i!1]+l+l+\s*y+[o0]+[u*]+r+\s*s+[e3]+l+f+/gi, category: 'threat', severity: 'severe', lang: 'en' },
];

// ── Cache for DB keywords (refreshed periodically) ──
let keywordCache = [];
let cacheTimestamp = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function refreshCache() {
  if (Date.now() - cacheTimestamp < CACHE_TTL && keywordCache.length > 0) return;
  try {
    keywordCache = await ModerationKeyword.findAll();
    cacheTimestamp = Date.now();
  } catch (err) {
    console.error('Failed to refresh keyword cache:', err.message);
  }
}

/**
 * Pre-process text to normalize obfuscation attempts.
 */
function preprocess(text) {
  if (!text) return '';
  return text
    // Remove zero-width characters
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    // Collapse repeated chars (>3 in a row) e.g. "fuuuuck" → "fuuck"
    .replace(/(.)\1{3,}/g, '$1$1')
    // Remove spaces between single chars (bypass attempts) e.g. "f u c k" → "fuck"
    .replace(/\b(\w)\s+(?=\w\s+\w\b)/g, '$1')
    // Normalize common unicode look-alikes
    .replace(/[αа]/gi, 'a')  // cyrillic/greek a
    .replace(/[еёε]/gi, 'e')  // cyrillic e
    .replace(/[іι]/gi, 'i')   // cyrillic/greek i
    .replace(/[оο]/gi, 'o')   // cyrillic/greek o
    .replace(/[υу]/gi, 'u');  // cyrillic/greek u
}

/**
 * Check text against all detection layers.
 *
 * @param {string} text - The content to check
 * @returns {Promise<FilterResult>}
 *
 * @typedef {Object} FilterResult
 * @property {boolean} flagged - Whether any violation was detected
 * @property {string} action - 'allow' | 'warn' | 'hide' | 'review'
 * @property {string} severity - 'none' | 'mild' | 'moderate' | 'severe'
 * @property {Detection[]} detections - Array of detected violations
 *
 * @typedef {Object} Detection
 * @property {string} term - The detected term
 * @property {string} category - Category of violation
 * @property {string} severity - 'mild' | 'moderate' | 'severe'
 * @property {string} source - 'builtin' | 'database'
 */
async function filterContent(text) {
  if (!text || typeof text !== 'string') {
    return { flagged: false, action: 'allow', severity: 'none', detections: [] };
  }

  await refreshCache();

  const processed = preprocess(text);
  const normalized = ModerationKeyword.normalize(text);
  const detections = [];

  // Layer 1: Built-in pattern matching
  for (const rule of BUILTIN_PATTERNS) {
    // Reset regex lastIndex
    rule.pattern.lastIndex = 0;
    const match = rule.pattern.exec(processed);
    if (match) {
      detections.push({
        term: match[0],
        category: rule.category,
        severity: rule.severity,
        source: 'builtin',
      });
    }
  }

  // Layer 2: Database keyword matching (normalized)
  for (const kw of keywordCache) {
    if (normalized.includes(kw.normalized)) {
      // Avoid duplicate detections
      const alreadyDetected = detections.some(d =>
        d.category === kw.category && d.source === 'builtin'
      );
      if (!alreadyDetected) {
        detections.push({
          term: kw.word,
          category: kw.category,
          severity: kw.severity,
          source: 'database',
        });
      }
    }
  }

  // Layer 3: Spaced-out word detection (e.g. "f u c k")
  const spacedNormalized = ModerationKeyword.normalize(text.replace(/\s+/g, ''));
  if (spacedNormalized !== normalized) {
    for (const kw of keywordCache) {
      if (spacedNormalized.includes(kw.normalized)) {
        const alreadyDetected = detections.some(d => d.term === kw.word);
        if (!alreadyDetected) {
          detections.push({
            term: kw.word + ' (spaced)',
            category: kw.category,
            severity: kw.severity,
            source: 'database',
          });
        }
      }
    }
  }

  // Determine overall severity and action
  const severityRank = { mild: 1, moderate: 2, severe: 3 };
  let maxSeverity = 'none';
  for (const d of detections) {
    if ((severityRank[d.severity] || 0) > (severityRank[maxSeverity] || 0)) {
      maxSeverity = d.severity;
    }
  }

  const action = determineAction(maxSeverity, detections.length);

  return {
    flagged: detections.length > 0,
    action,
    severity: maxSeverity,
    detections,
  };
}

/**
 * Map severity + count to a moderation action.
 */
function determineAction(severity, count) {
  if (severity === 'severe') return 'review';      // Always send to moderator
  if (severity === 'moderate' && count >= 2) return 'review';
  if (severity === 'moderate') return 'hide';       // Temporarily hide
  if (severity === 'mild' && count >= 3) return 'hide';
  if (severity === 'mild') return 'warn';           // Show warning
  return 'allow';
}

/**
 * Force-refresh the keyword cache (called after moderator updates keywords).
 */
function invalidateCache() {
  cacheTimestamp = 0;
}

module.exports = { filterContent, invalidateCache, preprocess };
