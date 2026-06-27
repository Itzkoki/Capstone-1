/* ─────────────────────────────────────────────────────────────────────────────
 * Item 3 — data-derived thresholds + severity preservation (dependency-free).
 * Proves: (1) KB.band maps numeric values to data-derived labels,
 * (2) numeric explicit signals are banded (depression:20 → severe → C-EF-01),
 * (3) free-text severity is preserved (severe → C-EF-01, mild → C-EF-MILD).
 *
 *   node test/thresholds.test.js
 * ────────────────────────────────────────────────────────────────────────────*/
const KB = require('../services/knowledgeBase');
const RE = require('../services/ruleEngine');

let failures = 0;
function eq(desc, got, expected) {
  const ok = got === expected;
  if (!ok) failures++;
  console.log(`${ok ? '✅' : '❌'} ${desc} → ${JSON.stringify(got)} (expected ${JSON.stringify(expected)})`);
}

// Which depression fragment fired, via the trace.
function depFragment(assessmentData, signals) {
  const ad = { ...assessmentData };
  if (signals) ad.additional_data = { clinical_signals: signals };
  const out = RE.generate(ad, { client_name: 'Test', template_type: 'clinical' }, 1);
  return ['C-EF-01', 'C-EF-02', 'C-EF-MILD'].find((id) => out.trace.firedRules.includes(id)) || null;
}

console.log('── KB.band maps numeric values to data-derived labels ──');
eq('depression 20 → severe', KB.band('depression', 20), 'severe');
eq('depression 12 → moderate', KB.band('depression', 12), 'moderate');
eq('depression 5  → mild', KB.band('depression', 5), 'mild');
eq('anxiety_level 18 → severe', KB.band('anxiety_level', 18), 'severe');
eq('self_esteem 5 → low', KB.band('self_esteem', 5), 'low');
eq('sleep_quality 1 → low', KB.band('sleep_quality', 1), 'low');
eq('unknown signal → null', KB.band('not_a_signal', 5), null);
eq('non-numeric → null', KB.band('depression', 'severe'), null);

console.log('\n── Numeric explicit signal is banded into the right fragment ──');
const base = { observational_notes: 'x', behavioral_observations: 'x', interview_findings: 'x' };
eq('clinical_signals {depression:20} → C-EF-01 (severe)', depFragment(base, { depression: 20 }), 'C-EF-01');
eq('clinical_signals {depression:5}  → C-EF-MILD',        depFragment(base, { depression: 5 }), 'C-EF-MILD');
eq('clinical_signals {depression:12} → C-EF-02 (moderate)', depFragment(base, { depression: 12 }), 'C-EF-02');

console.log('\n── Free-text severity is preserved in the bridge ──');
eq('"severe low mood" → C-EF-01', depFragment({ observational_notes: 'The client shows severe low mood and hopelessness.', behavioral_observations: '', interview_findings: '' }), 'C-EF-01');
eq('"mild low mood"   → C-EF-MILD', depFragment({ observational_notes: 'Reports mild low mood lately.', behavioral_observations: '', interview_findings: '' }), 'C-EF-MILD');
eq('"low mood" (no qualifier) → C-EF-02', depFragment({ observational_notes: 'Reports low mood and reduced interest.', behavioral_observations: '', interview_findings: '' }), 'C-EF-02');

console.log('');
if (failures) { console.error(`❌ ${failures} threshold/severity assertion(s) failed.`); process.exit(1); }
console.log('✅ All threshold/severity assertions passed.');
process.exit(0);
