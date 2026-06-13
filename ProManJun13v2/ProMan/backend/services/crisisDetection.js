/**
 * Crisis Content Detection Service
 * ─────────────────────────────────────────────────
 * Keyword-based detection for crisis/suicidal content.
 * No external API — runs locally against a curated pattern list.
 *
 * Design philosophy: Posts are NOT blocked. Vulnerable people
 * should not be silenced. Instead, flagged content triggers
 * immediate staff notification for human review.
 */

const CRISIS_PATTERNS = [
  { pattern: /\bsuicid(e|al|ality|ing)\b/i,        label: 'suicidal ideation' },
  { pattern: /\bkill\s+(my|him|her|them)?self\b/i,  label: 'self-harm intent' },
  { pattern: /\bwant\s+to\s+die\b/i,                label: 'suicidal ideation' },
  { pattern: /\bend\s+(my\s+life|it\s+all|everything)\b/i, label: 'suicidal ideation' },
  { pattern: /\bself[- ]?harm(ing)?\b/i,            label: 'self-harm' },
  { pattern: /\bno\s+reason\s+to\s+live\b/i,        label: 'suicidal ideation' },
  { pattern: /\bcut(ting)?\s+(my|him|her)?self\b/i,  label: 'self-harm' },
  { pattern: /\boverdos(e|ing)\b/i,                  label: 'overdose risk' },
  { pattern: /\bbetter\s+off\s+(dead|without\s+me)\b/i, label: 'suicidal ideation' },
  { pattern: /\bdon'?t\s+want\s+to\s+(be\s+here|exist|live)\b/i, label: 'suicidal ideation' },
];

/**
 * Philippines crisis resources — shown to users when crisis content is detected.
 */
const CRISIS_RESOURCES = {
  hotlines: [
    { name: 'National Center for Mental Health Crisis Hotline', number: '0917-899-8727', available: '24/7' },
    { name: 'In Touch Community Services', number: '(02) 8893-7603', available: '24/7' },
    { name: 'Hopeline Philippines', number: '0917-558-4673', available: '24/7' },
  ],
  message: 'If you or someone you know is in crisis, please reach out to a professional immediately. You are not alone.',
  disclaimer: 'This community is a peer support space and is not a substitute for professional mental health care.',
};

/**
 * Check content for crisis patterns.
 * @param {string} text - The content to check
 * @returns {{ isCrisis: boolean, matchedLabels: string[] }}
 */
function checkContent(text) {
  if (!text || typeof text !== 'string') {
    return { isCrisis: false, matchedLabels: [] };
  }

  const matchedLabels = [];
  for (const { pattern, label } of CRISIS_PATTERNS) {
    if (pattern.test(text)) {
      if (!matchedLabels.includes(label)) {
        matchedLabels.push(label);
      }
    }
  }

  return {
    isCrisis: matchedLabels.length > 0,
    matchedLabels,
  };
}

module.exports = { checkContent, CRISIS_RESOURCES };
