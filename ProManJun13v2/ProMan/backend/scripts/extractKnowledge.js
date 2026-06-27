/**
 * One-off / re-runnable extractor (Item 1).
 * Dumps the rule engine's in-code knowledge to the versioned knowledge/ JSON
 * files VERBATIM, so the migration introduces zero transcription error. Re-run
 * any time the in-code content changes (until everything is fully externalized).
 *
 *   node scripts/extractKnowledge.js
 *
 * Generates: observation-banks.json, recommendation-pools.json, fragment-library.json
 * The golden test (node test/ruleEngine.golden.js) then proves the engine reading
 * from these files produces identical output.
 */
const fs = require('fs');
const path = require('path');
const RE = require('../services/ruleEngine');

const DIR = path.join(__dirname, '..', 'knowledge');
if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });

const { banks, pools, buildFragmentLibrary } = RE._internals;

// ── Observation banks + section leads ────────────────────────────────────────
fs.writeFileSync(path.join(DIR, 'observation-banks.json'), JSON.stringify(banks, null, 2) + '\n');
console.log(`✅ observation-banks.json — ${Object.keys(banks).length} banks`);

// ── Recommendation pools ─────────────────────────────────────────────────────
fs.writeFileSync(path.join(DIR, 'recommendation-pools.json'), JSON.stringify(pools, null, 2) + '\n');
console.log(`✅ recommendation-pools.json — ${Object.keys(pools).length} pools`);

// ── Fragment library (preserve any existing provenance 'source' fields) ──────
const fragPath = path.join(DIR, 'fragment-library.json');
let existing = {};
try { existing = JSON.parse(fs.readFileSync(fragPath, 'utf8')); } catch (_) {}
const lib = buildFragmentLibrary();
const out = {};
for (const [id, f] of Object.entries(lib)) {
  out[id] = {
    section: f.section,
    text: f.text,
    source: (existing[id] && existing[id].source) || 'NARRATIVE_FRAGMENTS_ALL_CATEGORIES.md',
  };
}
fs.writeFileSync(fragPath, JSON.stringify(out, null, 2) + '\n');
console.log(`✅ fragment-library.json — ${Object.keys(out).length} fragments: ${Object.keys(out).join(', ')}`);
