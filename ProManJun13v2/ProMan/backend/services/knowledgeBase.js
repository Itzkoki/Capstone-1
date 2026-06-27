/**
 * Knowledge Base loader (Item 1 — separate knowledge from logic).
 * ─────────────────────────────────────────────────────────────────────────────
 * Loads the externalized rule knowledge (observation banks, narrative fragment
 * library, recommendation pools, data-derived thresholds) ONCE at startup and
 * caches it. The rule engine queries this module instead of holding the content
 * as inline literals — the IF-THEN logic, routing, and rotation are unchanged;
 * only the SOURCE of the knowledge moves out of code into versioned files.
 *
 * Fails fast (throws at load) on a missing/malformed knowledge file so a bad
 * deploy surfaces immediately rather than silently producing empty reports.
 *
 * NOTE: this is the PROOF SLICE — only the files/keys migrated so far are
 * present (mood/anxiety banks, C-EF-* fragments). Banks/fragments not yet
 * extracted remain inline in ruleEngine.js and are simply not requested here.
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'knowledge');

function _loadJson(file, { optional = false } = {}) {
  const p = path.join(DIR, file);
  if (!fs.existsSync(p)) {
    if (optional) return {};
    throw new Error(`KnowledgeBase: required knowledge file missing: ${file}`);
  }
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    throw new Error(`KnowledgeBase: failed to parse ${file}: ${e.message}`);
  }
}

// ── Load + cache once ────────────────────────────────────────────────────────
const _banks       = _loadJson('observation-banks.json');
const _fragments   = _loadJson('fragment-library.json');
const _recPools    = _loadJson('recommendation-pools.json', { optional: true });
const _thresholds  = _loadJson('thresholds.json',          { optional: true });
const _themeLex    = _loadJson('theme-lexicon.json');

// ── Structural validation — fail fast on malformed knowledge ─────────────────
for (const [k, v] of Object.entries(_banks)) {
  if (!Array.isArray(v) || v.length === 0) {
    throw new Error(`KnowledgeBase: observation bank "${k}" must be a non-empty array.`);
  }
}
for (const [id, f] of Object.entries(_fragments)) {
  if (!f || typeof f.text !== 'string' || !f.text.trim()) {
    throw new Error(`KnowledgeBase: fragment "${id}" must have non-empty "text".`);
  }
}

const KnowledgeBase = {
  /** Observation bank (array of sentences) for a category, e.g. 'mood'. */
  bank(category) {
    const b = _banks[category];
    if (!b) throw new Error(`KnowledgeBase: unknown observation bank "${category}".`);
    return b;
  },

  /** Has a bank been extracted yet? (Lets the engine fall back to inline during migration.) */
  hasBank(category) {
    return Object.prototype.hasOwnProperty.call(_banks, category);
  },

  /**
   * Resolve a narrative fragment by rule ID, interpolating template vars.
   * Templates use {name} placeholders (JSON cannot hold ${} interpolation).
   */
  fragment(id, vars = {}) {
    const f = _fragments[id];
    if (!f) throw new Error(`KnowledgeBase: unknown fragment "${id}".`);
    return f.text.replace(/\{(\w+)\}/g, (_m, key) => (vars[key] != null ? String(vars[key]) : ''));
  },

  hasFragment(id) {
    return Object.prototype.hasOwnProperty.call(_fragments, id);
  },

  /** Recommendation pool for a report type ('clinical' | 'neuro' | 'pre_employment'). */
  recPool(ttype) {
    return _recPools[ttype] || null;
  },

  /** Data-derived thresholds (populated in Item 3). */
  thresholds() {
    return _thresholds;
  },

  /** Theme-detection lexicon (Item 2): { negators, themes{key:[tokens]}, patterns{key:src} }. */
  themeLexicon() {
    return _themeLex;
  },

  // Exposed for diagnostics / tests.
  _banks, _fragments,
};

module.exports = KnowledgeBase;
