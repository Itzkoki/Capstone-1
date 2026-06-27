/* ─────────────────────────────────────────────────────────────────────────────
 * Item 2 — Theme-detection unit test (dependency-free).
 * Proves: (1) negation suppresses a theme, (2) Taglish terms are detected,
 * (3) non-negated positives are preserved.
 *
 *   node test/themeDetection.test.js   → exits 0 on pass, 1 on failure.
 * ────────────────────────────────────────────────────────────────────────────*/
const RE = require('../services/ruleEngine');
const detect = RE._internals.detectThemes;

let failures = 0;
function check(desc, text, theme, expected) {
  const got = !!detect(text)[theme];
  const ok = got === expected;
  if (!ok) failures++;
  console.log(`${ok ? '✅' : '❌'} ${desc} — themes.${theme} = ${got} (expected ${expected})`);
}

console.log('── Negation suppresses an otherwise-detected theme ──');
check('plain positive detects mood',          'The client reports a sad and tearful mood.',   'mood',         true);
check('"denies" suppresses social',           'Cooperative; denies social withdrawal.',       'social',       false);
check('"no" suppresses prior-history',        'Reports low mood. No prior treatment.',         'priorHistory', false);
check('"without" suppresses panic',           'Calm presentation, without panic or dread.',    'anxiety',      false);
check('non-negated panic still detected',     'Reports recurrent panic and dread.',            'anxiety',      true);
check('negator does not over-reach',          'No appetite changes, but reports sad mood.',    'mood',         true);

console.log('\n── Taglish coverage ──');
check('Taglish kabado → anxiety',             'Palaging kabado at balisa ang kliyente.',       'anxiety',      true);
check('Taglish puyat → sleep',                'Laging puyat, hirap matulog sa gabi.',          'sleep',        true);
check('Taglish negator: walang kaba',         'Kalmado, walang kaba o takot.',                 'anxiety',      false);

console.log('\n── Positives preserved (regression vs. previous behavior) ──');
check('mood: low mood',                       'persistent low mood over two weeks',            'mood',         true);
check('social: withdrawal',                   'notable social withdrawal and isolation',       'social',       true);
check('priorHistory: prior treatment',        'has a history of prior treatment',              'priorHistory', true);
check('attrition: considering leaving',       'the applicant is considering leaving the job',  'attritionRisk',true);

console.log('');
if (failures) { console.error(`❌ ${failures} theme-detection assertion(s) failed.`); process.exit(1); }
console.log('✅ All theme-detection assertions passed.');
process.exit(0);
