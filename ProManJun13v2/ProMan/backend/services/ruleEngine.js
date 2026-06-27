/**
 * PsyGen Rule-Based Narrative Generation Engine — v2
 * ─────────────────────────────────────────────────────────────────────────────
 * KNOWLEDGE BASE SOURCES
 *   Clinical:            StressLevelDataset.csv · Stress_Dataset.csv
 *                        Psychological_Assessment_Dataset.csv
 *                        Indicators_of_Anxiety_or_Depression CSV
 *                        depressive_tweets_processed.csv
 *   Neurodevelopmental:  Mental Health Dataset.csv · Suicide_Detection.csv
 *                        StudentPerformanceFactors.csv
 *   Pre-Employment:      Employee Attrition Classification Dataset.csv
 *                        Employee Attrition Classification Dataset-2.csv
 *                        HR-Employee-Attrition.csv
 *                        IBM-HR-Analytics-Employee-Attrition-and-Performance-Revised.csv
 *   Anonymized Reports:  ANONYMIZED-CLINICAL-REPORT.docx.pdf
 *                        ANONYMIZED-NEURODEVELOPMENTAL-REPORT.docx.pdf
 *                        ANONYMIZED-PRE_EMPLOYMENT-REPORT.docx.pdf
 *   Philippine Context:  Philippine NSMHW Report v12 · NSMHW Project Briefer
 *   Fragment Library:    NARRATIVE_FRAGMENTS_ALL_CATEGORIES.md
 *
 * CONSTRAINTS
 *   • No ML, no predictive models, no AI diagnosis — purely deterministic IF-THEN
 *   • All output is observation-based and subject to licensed psychologist review
 *   • PAP Code of Ethics-aligned language throughout
 *   • DSM-5-TR observational terminology, non-diagnostic application only
 *   • Philippine Mental Health Act (RA 11036) considerations embedded
 *
 * STRUCTURED CLINICAL SIGNALS (optional — passed via additional_data)
 *   clinical_signals:    depression, anxiety_level, self_esteem, sleep_quality,
 *                        social_support, mental_health_history, coping, risk_flag,
 *                        bullying, peer_pressure, insight, change_readiness
 *   neuro_signals:       overall_cognition, working_memory, visual_spatial, knowledge,
 *                        global_adaptive, communication, early_milestones,
 *                        prior_assessment, parental_involvement, risk_flag
 *   employment_signals:  reasoning, organization, WorkLifeBalance, OverTime,
 *                        emotional_stability, EnvironmentSatisfaction,
 *                        attrition_risk, fit_level, risk_flag
 */

// ─────────────────────────────────────────────────────────────────────────────
// 1. INPUT VALIDATION MODULE
// ─────────────────────────────────────────────────────────────────────────────

// Externalized rule knowledge (Item 1). Banks/fragments migrated into the
// knowledge/ files are served from here; not-yet-migrated content stays inline.
const KB = require('./knowledgeBase');

const KEYBOARD_PATTERNS = [
  'qwerty', 'qwertyuiop', 'asdfgh', 'asdfghjkl', 'zxcvbn', 'zxcvbnm',
  'qazwsx', 'edcrfv', 'poiuyt', 'lkjhgf', 'mnbvcx', 'plokmijn',
  '123456', '1234567', '12345678', '123456789', '0987654321',
  'abcdef', 'abcdefg', 'zyxwvu',
];

const PLACEHOLDER_WORDS = new Set([
  'test', 'testing', 'sample', 'tbd', 'to follow', 'n/a', 'na', 'none', 'ok',
  'yes', 'no', 'placeholder', 'draft', 'pending', 'unknown', 'lorem', 'ipsum',
  'asd', 'xxx', 'zzz', 'abc', 'null', 'undefined', 'todo', 'tba', 'fill',
  'enter', 'type', 'here', 'input', 'insert', 'write', 'add',
]);

const MIN_WORDS_REQUIRED = 5;

// Lightweight validation for short proper-name fields (e.g. a test/procedure
// name such as "Wonderlic", "16PF", or "Raven's Progressive Matrices").
// Unlike _validateTextField, it does NOT require a multi-word clinical
// narrative — it only rejects empty/placeholder/gibberish names.
function _validateName(value, fieldLabel) {
  const errors = [];
  const v = String(value || '').trim();
  if (!v) return errors; // blank check is handled by the caller

  const lower = v.toLowerCase();
  const noSpaces = v.replace(/\s+/g, '');
  const stripped = lower.replace(/[^a-z0-9\s]/g, '').trim();

  // Repeated-character or symbol-only strings: "aaaaaaa", "@@@@@"
  if (/^(.)\1{3,}$/.test(noSpaces) || /^[^a-zA-Z0-9\s]+$/.test(v)) {
    errors.push(`${fieldLabel}: "${v}" does not appear to be a valid name.`);
    return errors;
  }
  // Numeric-only entries
  if (/^\d+$/.test(noSpaces)) {
    errors.push(`${fieldLabel}: "${v}" must be the test or procedure name, not just numbers.`);
    return errors;
  }
  // Keyboard-pattern sequences
  for (const kp of KEYBOARD_PATTERNS) {
    if (lower.replace(/\s/g, '').includes(kp)) {
      errors.push(`${fieldLabel}: "${v}" appears to contain a keyboard pattern.`);
      return errors;
    }
  }
  // Placeholder text
  if (PLACEHOLDER_WORDS.has(stripped)) {
    errors.push(`${fieldLabel}: "${v}" appears to be placeholder text. Please enter the actual test or procedure name.`);
    return errors;
  }
  // Must contain at least one letter
  if (!/[a-zA-Z]/.test(v)) {
    errors.push(`${fieldLabel}: "${v}" does not appear to be a valid name.`);
    return errors;
  }
  return errors;
}

// Returns an array of error strings; empty array means field passed.
function _validateTextField(value, fieldLabel) {
  const errors = [];
  const v = String(value || '').trim();
  if (!v) return errors; // blank check is handled in validateAssessment

  const lower = v.toLowerCase();
  const words = v.split(/\s+/).filter(Boolean);
  const wordCount = words.length;
  const noSpaces = v.replace(/\s+/g, '');
  const letters = (noSpaces.match(/[a-zA-Z]/g) || []);
  const vowels  = (noSpaces.match(/[aeiouAEIOU]/g) || []);

  // Repeated-character strings: "aaaaaaa", "bbbbbb"
  if (/^(.)\1{3,}$/.test(noSpaces)) {
    errors.push(
      `${fieldLabel}: Entry appears to consist of repeated characters. ` +
      'Please provide meaningful clinical observations written in complete sentences.'
    );
    return errors;
  }

  // Symbol-only entries: "@@@@@", "!!!!!!!"
  if (/^[^a-zA-Z0-9\s]+$/.test(v)) {
    errors.push(
      `${fieldLabel}: Entry contains only symbols and no readable text. ` +
      'Please provide descriptive narrative content.'
    );
    return errors;
  }

  // Numeric-only entries: "123456789"
  if (/^\d+$/.test(noSpaces)) {
    errors.push(
      `${fieldLabel}: Entry contains only numbers. ` +
      'Please describe observations in sentence form (e.g., "The client presented with...").'
    );
    return errors;
  }

  // Keyboard-pattern sequences
  for (const kp of KEYBOARD_PATTERNS) {
    if (lower.replace(/\s/g, '').includes(kp)) {
      errors.push(
        `${fieldLabel}: Entry appears to contain a keyboard pattern ("${kp}"). ` +
        'Please provide meaningful clinical observations.'
      );
      return errors;
    }
  }

  // Placeholder text — exact match after stripping punctuation
  const stripped = lower.replace(/[^a-z0-9\s]/g, '').trim();
  if (PLACEHOLDER_WORDS.has(stripped)) {
    errors.push(
      `${fieldLabel}: Entry "${v}" appears to be placeholder text. ` +
      'Please provide specific, clinically meaningful observations.'
    );
    return errors;
  }

  // All words are placeholder words
  if (wordCount <= 3 && words.every(w => PLACEHOLDER_WORDS.has(w.toLowerCase().replace(/[^a-z0-9]/g, '')))) {
    errors.push(
      `${fieldLabel}: Entry appears to contain only placeholder words. ` +
      'Please describe actual clinical observations.'
    );
    return errors;
  }

  // Minimum word count
  if (wordCount < MIN_WORDS_REQUIRED) {
    errors.push(
      `${fieldLabel}: Entry is too brief (${wordCount} word${wordCount === 1 ? '' : 's'}). ` +
      `Please provide at least ${MIN_WORDS_REQUIRED} words describing observed behaviors or clinical findings.`
    );
    return errors;
  }

  // Random consonant-string detection (no vowels in a long stretch)
  if (letters.length > 8 && vowels.length === 0) {
    errors.push(
      `${fieldLabel}: Entry does not appear to contain readable words. ` +
      'Please provide observations written in sentence form.'
    );
    return errors;
  }

  // Single long word with virtually no vowels
  if (wordCount === 1 && letters.length > 10 && (vowels.length / letters.length) < 0.1) {
    errors.push(
      `${fieldLabel}: Entry appears to be a random character string. ` +
      'Please provide clinical observations in complete sentences.'
    );
    return errors;
  }

  // Word-level gibberish analysis — catches strings of nonsense "words" that
  // individually clear the simpler checks (e.g. "baixbshsjsh baixbshsjsh ...").
  const alphaWords = words
    .map(w => w.toLowerCase().replace(/[^a-z]/g, ''))
    .filter(w => w.length >= 2);
  if (alphaWords.length >= 3) {
    const realWords = alphaWords.filter(_looksLikeRealWord);
    const realRatio = realWords.length / alphaWords.length;
    // Require the majority of words to be plausible real words.
    if (realRatio < 0.5) {
      errors.push(
        `${fieldLabel}: Entry does not appear to contain meaningful words. ` +
        'Please describe actual clinical observations in complete, readable sentences.'
      );
      return errors;
    }
    // Reject low-variety repetition (e.g. the same token typed several times).
    const uniqueWords = new Set(alphaWords);
    if (alphaWords.length >= 4 && uniqueWords.size <= 2 && realWords.length < alphaWords.length) {
      errors.push(
        `${fieldLabel}: Entry appears to repeat the same token. ` +
        'Please provide a varied, meaningful clinical description.'
      );
      return errors;
    }
  }

  return errors;
}

// Heuristic: does a single alphabetic token look like a real word?
// Real words contain a vowel, avoid long consonant runs, and have a sensible
// vowel/consonant balance. Tuned to reject keyboard mash and random strings
// while accepting ordinary clinical vocabulary.
function _looksLikeRealWord(w) {
  if (w.length < 2) return false;
  if (w.length <= 3) return /[aeiou]/.test(w);   // short words: just need a vowel
  if (!/[aeiouy]/.test(w)) return false;          // no vowel at all → gibberish
  if (/(.)\1\1/.test(w)) return false;            // 3+ same letter in a row
  if (/[^aeiouy]{5,}/.test(w)) return false;      // 5+ consonants in a row
  const vowelCount = (w.match(/[aeiouy]/g) || []).length;
  const ratio = vowelCount / w.length;
  return ratio >= 0.2 && ratio <= 0.8;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. CLINICAL SIGNAL INTERPRETER
//    Reads optional structured signals from additional_data and makes them
//    available to the fragment rule engine.
//    Signals are OPTIONAL — if absent, the engine falls back to rotation banks.
// ─────────────────────────────────────────────────────────────────────────────

function _resolveSignals(additional_data) {
  const raw = (additional_data && typeof additional_data === 'object') ? additional_data : {};
  return {
    cs: raw.clinical_signals    || {},
    ns: raw.neuro_signals       || {},
    es: raw.employment_signals  || {},
  };
}

// Bridge: converts text-detected themes into the structured signal format so
// the IF-THEN fragment rules in _applyNarrativeFragments fire from free text
// alone — no UI panel required. Only fills slots that are not already set by
// explicit structured signals from additional_data.
function _themesToSignals(themes, ttype, existing) {
  const cs = Object.assign({}, existing.cs);
  const ns = Object.assign({}, existing.ns);
  const es = Object.assign({}, existing.es);

  if (ttype === 'clinical') {
    if (!cs.depression         && themes.depression)    cs.depression             = 'moderate';
    if (!cs.anxiety_level      && themes.anxiety)       cs.anxiety_level          = 'moderate';
    if (!cs.self_esteem        && themes.selfEsteem)    cs.self_esteem            = 'low';
    if (!cs.sleep_quality      && themes.sleep)         cs.sleep_quality          = 'low';
    if (!cs.social_support     && themes.socialSupport) cs.social_support         = 'low';
    if (!cs.coping             && themes.coping)        cs.coping                 = 'avoidant';
    if (!cs.peer_pressure      && themes.social)        cs.peer_pressure          = 'high';
    // C-EF-06 / X-RK-01: prior mental health history mentioned in clinician text
    if (!cs.mental_health_history && themes.priorHistory) cs.mental_health_history = 'Yes';
  }

  if (ttype === 'neurodevelopmental') {
    if (!ns.overall_cognition  && themes.cognitive)     ns.overall_cognition      = 'below-age';
    if (!ns.communication      && themes.communication) ns.communication          = 'limited';
    if (!ns.global_adaptive    && themes.adaptive)      ns.global_adaptive        = 'low';
    if (!ns.working_memory     && themes.attention)     ns.working_memory         = 'weak';
    // N-TR-04: vocabulary/knowledge deficits — also inferred from communication theme
    if (!ns.knowledge && (themes.knowledgeWeak || themes.communication)) ns.knowledge = 'weak';
    // N-ED-01: developmental delay — use targeted pattern, not broad academic theme
    if (!ns.early_milestones   && themes.developDelay)  ns.early_milestones       = 'delayed';
    // N-ED-02: prior assessment history
    if (!ns.prior_assessment   && themes.priorHistory)  ns.prior_assessment       = 'Yes';
    if (!ns.parental_involvement && themes.psychosocial) ns.parental_involvement  = 'low';
  }

  if (ttype === 'pre_employment') {
    if (!es.WorkLifeBalance    && themes.workLife)       es.WorkLifeBalance        = 'poor';
    if (!es.emotional_stability && themes.emotion)       es.emotional_stability    = 'low';
    if (!es.OverTime           && themes.stress)         es.OverTime               = 'Yes';
    // E-OR-02: organization difficulty — only from specific organization-difficulty text
    if (!es.organization       && themes.organizationDiff) es.organization         = 'low';
    // E-OR-01: reasoning adequate — positive default when reasoning/cognitive mentioned
    if (!es.reasoning          && themes.cognitive)      es.reasoning              = 'adequate';
    if (!es.EnvironmentSatisfaction && themes.interpersonal) es.EnvironmentSatisfaction = 'high';
    // Attrition risk elevated — only from specific resignation/attrition signals
    if (!es.attrition_risk     && themes.attritionRisk)  es.attrition_risk         = 'ELEVATED';
    if (!es.fit_level)                                   es.fit_level              = 'fit_with_considerations';
  }

  return { cs, ns, es };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. OBSERVATION BANKS
//    Derived from: anonymized report corpus, StressLevelDataset, Stress_Dataset,
//    Psychological_Assessment_Dataset, Indicators_of_Anxiety_or_Depression CSV,
//    depressive_tweets_processed, Mental Health Dataset, Suicide_Detection,
//    StudentPerformanceFactors, all Employee Attrition / HR datasets,
//    Philippine NSMHW Report, NSMHW Briefer, DSM-5-TR observational language.
// ─────────────────────────────────────────────────────────────────────────────

// ── MOOD / AFFECT ─────────────────────────────────────────────────────────────
// Externalized to knowledge/observation-banks.json ("mood"). Served via KB so the
// content lives in a versioned data file; rotation/use below is unchanged.
const MOOD_OBS = KB.bank('mood');

// ── ANXIETY ────────────────────────────────────────────────────────────────────
// Externalized to knowledge/observation-banks.json ("anxiety").
const ANXIETY_OBS = KB.bank('anxiety');

// ── SLEEP / SOMATIC ────────────────────────────────────────────────────────────
const SLEEP_SOMATIC_OBS = KB.bank('sleep_somatic');

// ── MOTIVATION / ANHEDONIA ──────────────────────────────────────────────────────
const MOTIVATION_OBS = KB.bank('motivation');

// ── SOCIAL FUNCTIONING ──────────────────────────────────────────────────────────
const SOCIAL_OBS = KB.bank('social');

// ── COPING MECHANISMS ────────────────────────────────────────────────────────────
const COPING_OBS = KB.bank('coping');

// ── CONCENTRATION / ATTENTION ───────────────────────────────────────────────────
const CONCENTRATION_OBS = KB.bank('concentration');

// ── COGNITIVE FUNCTIONING ───────────────────────────────────────────────────────
const COGNITIVE_OBS = KB.bank('cognitive');

// ── DEPRESSION ──────────────────────────────────────────────────────────────────
const DEPRESSION_OBS = KB.bank('depression');

// ── EMOTIONAL REGULATION ─────────────────────────────────────────────────────────
const EMOTIONAL_REGULATION_OBS = KB.bank('emotional_regulation');

// ── PSYCHOSOCIAL CONTEXT ──────────────────────────────────────────────────────────
const PSYCHOSOCIAL_OBS = KB.bank('psychosocial');

// ── STRESS INDICATORS ───────────────────────────────────────────────────────────
const STRESS_OBS = KB.bank('stress');

// ── APPETITE / NUTRITIONAL FUNCTIONING ─────────────────────────────────────────
const APPETITE_OBS = KB.bank('appetite');

// ── SELF-CONCEPT / SELF-ESTEEM ───────────────────────────────────────────────────
const SELF_CONCEPT_OBS = KB.bank('self_concept');

// ── SOCIAL SUPPORT ───────────────────────────────────────────────────────────────
const SOCIAL_SUPPORT_OBS = KB.bank('social_support');

// ─── NEURODEVELOPMENTAL-SPECIFIC BANKS ────────────────────────────────────────

const ADAPTIVE_BEHAVIOR_OBS = KB.bank('adaptive_behavior');

const COMMUNICATION_OBS = KB.bank('communication');

const SENSORY_OBS = KB.bank('sensory');

const ACADEMIC_OBS = KB.bank('academic');

// ─── PRE-EMPLOYMENT-SPECIFIC BANKS ────────────────────────────────────────────

const OCCUPATIONAL_OBS = KB.bank('occupational');

const INTERPERSONAL_OBS = KB.bank('interpersonal');

const WORK_LIFE_BALANCE_OBS = KB.bank('work_life_balance');

// ─── SAFETY RISK BANKS ───────────────────────────────────────────────────────
// (X-RK-00, X-RK-LOW from Narrative Fragment Library; content from Suicide_Detection.csv context)

const RISK_ELEVATED_OBS = KB.bank('risk_elevated');

const RISK_NONE_OBS = KB.bank('risk_none');

// ─── NARRATIVE SECTION LEADS ──────────────────────────────────────────────────

const NEURO_FINDINGS_LEAD = KB.bank('neuro_findings_lead');

const CLINICAL_FINDINGS_LEAD = KB.bank('clinical_findings_lead');

const PRE_EMP_FINDINGS_LEAD = KB.bank('pre_emp_findings_lead');

// ─────────────────────────────────────────────────────────────────────────────
// 4. NARRATIVE FRAGMENT RULE ENGINE
//    Implements IF-THEN rules from NARRATIVE_FRAGMENTS_ALL_CATEGORIES.md.
//    Each rule maps a signal condition to a verbatim fixed sentence.
//    Returns an array of { section, text } objects for injection into generated
//    narrative sections.
// ─────────────────────────────────────────────────────────────────────────────

function _applyNarrativeFragments(ttype, signals, name) {
  const { cs, ns, es } = signals;
  const frags = [];
  // push records the firing rule's ID alongside the fragment so the engine can
  // emit an explainability trace (which rules fired → which sentences). The
  // ruleId is metadata only; it never changes the generated prose.
  const push = (section, text, ruleId) => frags.push({ section, text, ruleId: ruleId || null });

  // ── SAFETY OVERRIDE — evaluated FIRST across ALL assessment types ─────────
  // (Rules: X-RK-00, X-RK-01, X-RC-CRISIS, X-RK-LOW)
  const riskElevated =
    cs.risk_flag === 'ELEVATED' ||
    ns.risk_flag === 'ELEVATED' ||
    es.risk_flag === 'ELEVATED';

  if (riskElevated) {
    push('risk', KB.fragment('X-RK-00', { name }), 'X-RK-00');
    if (cs.mental_health_history === 'Yes' || ns.mental_health_history === 'Yes') {
      push('risk', KB.fragment('X-RK-01', { name }), 'X-RK-01');
    }
    push('recommendations_safety', KB.fragment('X-RC-CRISIS', { name }), 'X-RC-CRISIS');
  } else {
    push('risk', KB.fragment('X-RK-LOW', { name }), 'X-RK-LOW');
  }

  // ── CLINICAL ASSESSMENT RULES ─────────────────────────────────────────────
  if (ttype === 'clinical') {

    // C-EF-01: depression = severe   (text → knowledge/fragment-library.json)
    if (cs.depression === 'severe') {
      push('emotional_functioning', KB.fragment('C-EF-01', { name }), 'C-EF-01');
    }
    // C-EF-02: depression = moderate
    else if (cs.depression === 'moderate') {
      push('emotional_functioning', KB.fragment('C-EF-02', { name }), 'C-EF-02');
    }
    // C-EF-MILD: mild depression — non-library supplemental
    else if (cs.depression === 'mild') {
      push('emotional_functioning', KB.fragment('C-EF-MILD', { name }), 'C-EF-MILD');
    }

    // C-EF-03: anxiety ≥ moderate
    if (cs.anxiety_level === 'moderate' || cs.anxiety_level === 'severe') {
      push('emotional_functioning', KB.fragment('C-EF-03', { name }), 'C-EF-03');
    }

    // C-EF-04: sleep_quality = low
    if (cs.sleep_quality === 'low') {
      push('emotional_functioning', KB.fragment('C-EF-04', { name }), 'C-EF-04');
    }

    // C-EF-05: self_esteem = low
    if (cs.self_esteem === 'low') {
      push('emotional_functioning', KB.fragment('C-EF-05', { name }), 'C-EF-05');
    }

    // C-EF-06: history = Yes AND depression ≥ moderate
    if (cs.mental_health_history === 'Yes' &&
        (cs.depression === 'moderate' || cs.depression === 'severe')) {
      push('emotional_functioning', KB.fragment('C-EF-06', { name }), 'C-EF-06');
    }

    // C-SF-01: social_support = low
    if (cs.social_support === 'low') {
      push('social_functioning', KB.fragment('C-SF-01', { name }), 'C-SF-01');
    }
    // C-SF-02: social_support = moderate
    else if (cs.social_support === 'moderate') {
      push('social_functioning', KB.fragment('C-SF-02', { name }), 'C-SF-02');
    }

    // C-SF-03: bullying = high OR peer_pressure = high
    if (cs.bullying === 'high' || cs.peer_pressure === 'high') {
      push('social_functioning', KB.fragment('C-SF-03', { name }), 'C-SF-03');
    }

    // C-DM-01: coping = avoidant
    if (cs.coping === 'avoidant') {
      push('defense_mechanisms', KB.fragment('C-DM-01', { name }), 'C-DM-01');
    }
    // C-DM-02: coping = suppression-then-release
    else if (cs.coping === 'suppression') {
      push('defense_mechanisms', KB.fragment('C-DM-02', { name }), 'C-DM-02');
    }

    // C-DM-03: insight present AND change_readiness low
    if (cs.insight === 'present' && cs.change_readiness === 'low') {
      push('defense_mechanisms', KB.fragment('C-DM-03', { name }), 'C-DM-03');
    }

    // C-CI-01: depression = severe AND history = Yes
    if (cs.depression === 'severe' && cs.mental_health_history === 'Yes') {
      push('clinical_impression', KB.fragment('C-CI-01', { name }), 'C-CI-01');
    }

    // C-CI-02: instability + fear_of_abandonment + impulsivity
    if (cs.emotional_instability === 'present' &&
        (cs.fear_of_abandonment === 'present' || cs.impulsivity === 'present')) {
      push('clinical_impression', KB.fragment('C-CI-02', { name }), 'C-CI-02');
    }

    // C-CI-FOOTER: always
    push('clinical_impression', KB.fragment('C-CI-FOOTER', { name }), 'C-CI-FOOTER');

    // C-RC-01: always
    push('recommendations_fragment', KB.fragment('C-RC-01', { name }), 'C-RC-01');
    // C-RC-03: sleep_quality = low
    if (cs.sleep_quality === 'low') {
      push('recommendations_fragment', KB.fragment('C-RC-03', { name }), 'C-RC-03');
    }
    // C-RC-04: social_support = low
    if (cs.social_support === 'low') {
      push('recommendations_fragment', KB.fragment('C-RC-04', { name }), 'C-RC-04');
    }
    // C-RC-RA11036: Philippine RA 11036 alignment
    push('recommendations_fragment', KB.fragment('C-RC-RA11036', { name }), 'C-RC-RA11036');
  }

  // ── NEURODEVELOPMENTAL ASSESSMENT RULES ───────────────────────────────────
  if (ttype === 'neurodevelopmental') {

    // N-ED-01: early_milestones = delayed
    if (ns.early_milestones === 'delayed') {
      push('early_development', KB.fragment('N-ED-01', { name }), 'N-ED-01');
    }
    // N-ED-02: prior_assessment = Yes
    if (ns.prior_assessment === 'Yes') {
      push('early_development', KB.fragment('N-ED-02', { name }), 'N-ED-02');
    }

    // N-TR-01: overall_cognition = below-age
    if (ns.overall_cognition === 'below-age') {
      push('test_results_fragment', KB.fragment('N-TR-01', { name }), 'N-TR-01');
    }
    // N-TR-02: visual_spatial = relative_strength
    if (ns.visual_spatial === 'relative_strength') {
      push('test_results_fragment', KB.fragment('N-TR-02', { name }), 'N-TR-02');
    }
    // N-TR-03: working_memory = weak
    if (ns.working_memory === 'weak') {
      push('test_results_fragment', KB.fragment('N-TR-03', { name }), 'N-TR-03');
    }
    // N-TR-04: knowledge = weak
    if (ns.knowledge === 'weak') {
      push('test_results_fragment', KB.fragment('N-TR-04', { name }), 'N-TR-04');
    }

    // N-AF-01: global_adaptive = low
    if (ns.global_adaptive === 'low') {
      push('adaptive_functioning', KB.fragment('N-AF-01', { name }), 'N-AF-01');
    }
    // N-AF-02: communication = limited
    if (ns.communication === 'limited') {
      push('adaptive_functioning', KB.fragment('N-AF-02', { name }), 'N-AF-02');
    }

    // N-SI-01: composite below-age + adaptive low
    if (ns.overall_cognition === 'below-age' && ns.global_adaptive === 'low') {
      push('summary_impression', KB.fragment('N-SI-01', { name }), 'N-SI-01');
    }
    // N-SI-FOOTER: always
    push('summary_impression', KB.fragment('N-SI-FOOTER', { name }), 'N-SI-FOOTER');

    // N-RC-01: always
    push('recommendations_fragment', KB.fragment('N-RC-01', { name }), 'N-RC-01');
    // N-RC-02: communication = limited
    if (ns.communication === 'limited') {
      push('recommendations_fragment', KB.fragment('N-RC-02', { name }), 'N-RC-02');
    }
    // N-RC-03: adaptive low
    if (ns.global_adaptive === 'low') {
      push('recommendations_fragment', KB.fragment('N-RC-03', { name }), 'N-RC-03');
    }
    // N-RC-04: parental_involvement = low
    if (ns.parental_involvement === 'low') {
      push('recommendations_fragment', KB.fragment('N-RC-04', { name }), 'N-RC-04');
    }
  }

  // ── PRE-EMPLOYMENT ASSESSMENT RULES ──────────────────────────────────────
  if (ttype === 'pre_employment') {

    // E-OR-01: reasoning = adequate
    if (es.reasoning === 'adequate') {
      push('overall_results_fragment', KB.fragment('E-OR-01', { name }), 'E-OR-01');
    }
    // E-OR-02: organization = low
    if (es.organization === 'low') {
      push('overall_results_fragment', KB.fragment('E-OR-02', { name }), 'E-OR-02');
    }
    // E-OR-03: WorkLifeBalance = poor OR OverTime = Yes
    if (es.WorkLifeBalance === 'poor' || es.OverTime === 'Yes') {
      push('overall_results_fragment', KB.fragment('E-OR-03', { name }), 'E-OR-03');
    }
    // E-OR-04: emotional_stability = low
    if (es.emotional_stability === 'low') {
      push('overall_results_fragment', KB.fragment('E-OR-04', { name }), 'E-OR-04');
    }
    // E-OR-05: EnvironmentSatisfaction = high
    if (es.EnvironmentSatisfaction === 'high') {
      push('overall_results_fragment', KB.fragment('E-OR-05', { name }), 'E-OR-05');
    }

    // E-IC-FIT / E-IC-CONSIDER / E-IC-NOTREC
    const fit = es.fit_level || 'fit_with_considerations';
    if (fit === 'fit') {
      push('impression_conclusion_fragment', KB.fragment('E-IC-FIT', { name }), 'E-IC-FIT');
      push('fit_recommendation', KB.fragment('E-RC-FIT', { name }), 'E-RC-FIT');
    } else if (fit === 'not_recommended') {
      push('impression_conclusion_fragment', KB.fragment('E-IC-NOTREC', { name }), 'E-IC-NOTREC');
      push('fit_recommendation', KB.fragment('E-RC-NOTREC', { name }), 'E-RC-NOTREC');
    } else {
      // fit_with_considerations — default
      push('impression_conclusion_fragment', KB.fragment('E-IC-CONSIDER', { name }), 'E-IC-CONSIDER');
      push('fit_recommendation', KB.fragment('E-RC-CONSIDER', { name }), 'E-RC-CONSIDER');
    }

    // E-OR-ATTRITION: Attrition risk flag
    if (es.attrition_risk === 'ELEVATED') {
      push('overall_results_fragment', KB.fragment('E-OR-ATTRITION', { name }), 'E-OR-ATTRITION');
    }
  }



  return frags;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. RECOMMENDATION POOLS
//    Expanded with Philippines-context references, dataset-derived patterns,
//    and RA 11036 alignment.
// ─────────────────────────────────────────────────────────────────────────────

const NEURO_REC_POOL = KB.recPool('neuro');

const CLINICAL_REC_POOL = KB.recPool('clinical');

const PRE_EMP_REC_POOL = KB.recPool('pre_employment');

// ─────────────────────────────────────────────────────────────────────────────
// 6. THEME DETECTION & THEME-AWARE NARRATIVE SELECTION
//    Analyzes all clinician-provided text to detect which clinical themes are
//    present. Only observation banks matching detected themes are drawn from,
//    ensuring generated narratives reflect only what was documented in the input.
//    Datasets remain as the narrative knowledge repository — never referenced
//    in output, only used to select appropriate professional phrasing.
// ─────────────────────────────────────────────────────────────────────────────

// Theme-detection knowledge + precompiled matchers (Item 2). Tokens/patterns are
// sourced from knowledge/theme-lexicon.json; the simple-theme regexes are built
// identically to the previous inline ones, so POSITIVE matching is unchanged
// (Taglish tokens only add coverage). A match is SUPPRESSED when a negator
// appears in the short window before it (e.g. "denies anxiety", "walang kaba").
const _THEME_LEX = KB.themeLexicon();
const _THEME_RES = {};
for (const [k, toks] of Object.entries(_THEME_LEX.themes || {})) {
  _THEME_RES[k] = new RegExp('\\b(' + toks.join('|') + ')\\b', 'g');
}
const _PATTERN_RES = {};
for (const [k, src] of Object.entries(_THEME_LEX.patterns || {})) {
  _PATTERN_RES[k] = new RegExp(src, 'g');
}
const _NEGATOR_RE = new RegExp('\\b(' + (_THEME_LEX.negators || []).join('|') + ')\\b');

// Is a match at index `idx` negated by a negator before it IN THE SAME CLAUSE?
// Negation must not cross a sentence/clause break — in "No prior treatment. Some
// social withdrawal", the "No" negates the prior-treatment clause, NOT "social".
// So we restrict to the text after the last sentence terminator, then scan the
// last ~4 tokens of that clause for a negator.
function _isNegated(t, idx) {
  let pre = t.slice(Math.max(0, idx - 80), idx);
  const parts = pre.split(/[.;!?\n]/);     // keep only the current clause
  pre = parts[parts.length - 1];
  const tokens = pre.split(/[^a-z']+/).filter(Boolean);
  const windowStr = ' ' + tokens.slice(-4).join(' ') + ' ';
  return _NEGATOR_RE.test(windowStr);
}

// A theme is present if it has at least one NON-negated match in the text.
function _themeMatches(re, t) {
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(t)) !== null) {
    if (!_isNegated(t, m.index)) return true;
    if (m.index === re.lastIndex) re.lastIndex++; // zero-width guard
  }
  return false;
}

function _detectThemes(text) {
  const t = (text || '').toLowerCase();
  const out = {};
  for (const k of Object.keys(_THEME_RES))   out[k] = _themeMatches(_THEME_RES[k], t);
  for (const k of Object.keys(_PATTERN_RES)) out[k] = _themeMatches(_PATTERN_RES[k], t);
  return out;
}

// Returns observation strings from banks whose themes were detected in clinician input.
// maxCount caps total entries. Only theme-matched banks are used — no fabrication.
function _selectThemeObservations(themes, g, maxCount, ttype) {
  const picks = [];
  const add = (bank, salt) => {
    if (picks.length >= maxCount) return;
    const idx = (((g + salt) % bank.length) + bank.length) % bank.length;
    const entry = bank[idx];
    if (entry && !picks.includes(entry)) picks.push(entry);
  };

  if (themes.mood || themes.depression)    add(MOOD_OBS, 0);
  if (themes.anxiety)                       add(ANXIETY_OBS, 1);
  if (themes.depression)                    add(DEPRESSION_OBS, 2);
  if (themes.attention)                     add(CONCENTRATION_OBS, 3);
  if (themes.emotion)                       add(EMOTIONAL_REGULATION_OBS, 4);
  if (themes.motivation)                    add(MOTIVATION_OBS, 5);
  if (themes.cognitive)                     add(COGNITIVE_OBS, 6);
  if (themes.social)                        add(SOCIAL_OBS, 7);
  if (themes.socialSupport)                 add(SOCIAL_SUPPORT_OBS, 8);
  if (themes.coping || themes.stress)       add(COPING_OBS, 9);
  if (themes.selfEsteem)                    add(SELF_CONCEPT_OBS, 10);
  if (themes.stress)                        add(STRESS_OBS, 11);
  if (themes.psychosocial)                  add(PSYCHOSOCIAL_OBS, 12);
  if (themes.sleep)                         add(SLEEP_SOMATIC_OBS, 13);
  if (themes.appetite)                      add(APPETITE_OBS, 14);

  if (ttype === 'neurodevelopmental') {
    if (themes.adaptive)      add(ADAPTIVE_BEHAVIOR_OBS, 15);
    if (themes.communication) add(COMMUNICATION_OBS, 16);
    if (themes.sensory)       add(SENSORY_OBS, 17);
    if (themes.academic)      add(ACADEMIC_OBS, 18);
  }
  if (ttype === 'pre_employment') {
    if (themes.occupational || themes.workLife) add(OCCUPATIONAL_OBS, 15);
    if (themes.interpersonal)                   add(INTERPERSONAL_OBS, 16);
    if (themes.workLife)                        add(WORK_LIFE_BALANCE_OBS, 17);
  }

  return picks;
}

// Selects recommendations from pool that match detected themes.
// Always includes RA 11036 / licensed-professional entries as a universal baseline.
// Returns between minCount and maxCount entries.
function _selectThemeRecs(pool, themes, g, minCount, maxCount) {
  const matchers = [];
  if (themes.sleep)                          matchers.push(/sleep|bedtime|insomni|rest/i);
  if (themes.social || themes.socialSupport) matchers.push(/social|peer|relationship|support|connect|network|isolation/i);
  if (themes.coping || themes.stress)        matchers.push(/coping|cope|stress.manag|resilience|strategy|distress/i);
  if (themes.anxiety)                        matchers.push(/anxi|worry|relaxation|mindfulness|calm/i);
  if (themes.depression || themes.mood)      matchers.push(/depress|mood|activat|motivation|therapy|psychotherapy/i);
  if (themes.selfEsteem)                     matchers.push(/self.esteem|confidence|self.worth/i);
  if (themes.psychosocial)                   matchers.push(/family|psychoeducation|community|relational/i);
  if (themes.academic)                       matchers.push(/academic|educational|school|tutoring|learning/i);
  if (themes.adaptive)                       matchers.push(/adaptive|daily living|self.care|routine|self.direct/i);
  if (themes.communication)                  matchers.push(/speech|language|communication/i);
  if (themes.occupational || themes.workLife) matchers.push(/work|employ|occupational|onboard|placement|role/i);
  if (themes.appetite)                       matchers.push(/appetite|nutritional|eating/i);
  if (themes.motivation)                     matchers.push(/motivat|activat|engag|goal/i);
  if (themes.cognitive)                      matchers.push(/cognitive|assessment|reassess/i);

  // Always-include: universal professional/RA 11036 baselines
  const alwaysInclude = pool.filter(r =>
    /ra 11036|licensed.*(filipino|psychologist)|ncmh|licensed mental health|lgu/i.test(r)
  );
  const alwaysSet = new Set(alwaysInclude);

  // Score remaining recs by theme relevance
  const scored = pool
    .filter(r => !alwaysSet.has(r))
    .map((rec, i) => ({ rec, score: matchers.filter(re => re.test(rec)).length, i }))
    .sort((a, b) => b.score - a.score || ((a.i - g + pool.length * 10) % pool.length) - ((b.i - g + pool.length * 10) % pool.length));

  const result = [...alwaysInclude];
  for (const { rec } of scored) {
    if (result.length >= maxCount) break;
    result.push(rec);
  }

  // Pad to minCount with rotation if needed
  let n = 0;
  while (result.length < minCount && n < pool.length) {
    const r = pool[((g + n) % pool.length)];
    if (!result.includes(r)) result.push(r);
    n++;
  }

  return result.slice(0, maxCount);
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. RULE ENGINE — PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

const RuleEngine = {

  /**
   * Validates assessment data fields before narrative generation.
   * Applies strict input validation per requirements:
   *   - Rejects random character strings, repeated chars, keyboard patterns
   *   - Rejects numeric-only, symbol-only, placeholder text
   *   - Rejects extremely short responses
   *   - Provides descriptive feedback explaining what is wrong and what is needed
   *
   * @param {object} assessmentData - { observational_notes, behavioral_observations, interview_findings, ... }
   * @param {object} report         - { template_type, ... }
   * @returns {{ valid: boolean, errors: string[] }}
   */
  validateAssessment(assessmentData, report) {
    const errors = [];
    const ttype = (report && report.template_type) || 'clinical';
    const data = assessmentData || {};

    // A report must not be generated from empty/absent assessment data.
    const textFields = [
      { key: 'observational_notes',     label: 'Observational Notes' },
      { key: 'behavioral_observations', label: 'Behavioral Observations' },
      { key: 'interview_findings',      label: 'Interview Findings' },
    ];

    // Require every observational free-text field to be present — these are the
    // basis of the narrative, so a blank field means there is no valid data.
    for (const { key, label } of textFields) {
      const val = String(data[key] || '').trim();
      if (!val) {
        errors.push(`${label}: This field is required. Please provide clinical observations before generating the report.`);
      } else {
        errors.push(..._validateTextField(val, label));
      }
    }

    // Pre-employment reports additionally require at least one named test.
    const addData = data.additional_data || {};
    if (ttype === 'pre_employment') {
      const tests = Array.isArray(addData.preemp_tests) ? addData.preemp_tests : [];
      const namedTests = tests.filter(t => t && t.name && String(t.name).trim());
      if (!namedTests.length) {
        errors.push('Tests Administered: Please add at least one test/procedure with a valid name.');
      }
      for (const t of namedTests) {
        errors.push(..._validateName(t.name, 'Test/Procedure Name'));
      }
    }

    return { valid: errors.length === 0, errors };
  },

  // Validate only the fields that were actually provided (non-empty). Used at
  // save time for data integrity — rejects nonsensical content without forcing
  // every field to be completed before a partial save.
  validateProvidedFields(assessmentData) {
    const errors = [];
    const data = assessmentData || {};
    const textFields = [
      { key: 'observational_notes',     label: 'Observational Notes' },
      { key: 'behavioral_observations', label: 'Behavioral Observations' },
      { key: 'interview_findings',      label: 'Interview Findings' },
    ];
    for (const { key, label } of textFields) {
      const val = String(data[key] || '').trim();
      if (val) errors.push(..._validateTextField(val, label));
    }
    const tests = Array.isArray(data.additional_data && data.additional_data.preemp_tests)
      ? data.additional_data.preemp_tests : [];
    for (const t of tests) {
      if (t && t.name && String(t.name).trim()) {
        errors.push(..._validateName(t.name, 'Test/Procedure Name'));
      }
    }
    return { valid: errors.length === 0, errors };
  },

  // ── Internal utilities ──────────────────────────────────────────────────

  _pick(arr, genIndex, salt = 0) {
    if (!arr || !arr.length) return '';
    const i = (((genIndex + salt) % arr.length) + arr.length) % arr.length;
    return arr[i];
  },

  _lower1(s) {
    const t = String(s || '').trim();
    return t ? t.charAt(0).toLowerCase() + t.slice(1) : t;
  },

  _rotateN(arr, n, offset) {
    if (!arr || !arr.length) return [];
    const start = ((offset % arr.length) + arr.length) % arr.length;
    const out = [];
    for (let i = 0; i < n && i < arr.length; i++) {
      out.push(arr[(start + i) % arr.length]);
    }
    return out;
  },

  // ── Main generation method ──────────────────────────────────────────────

  /**
   * Generate narrative report sections from observational data.
   *
   * Structured clinical signals (optional) can be passed via
   * assessmentData.additional_data.clinical_signals (clinical),
   *   .neuro_signals (neurodevelopmental), or
   *   .employment_signals (pre_employment).
   * When present, the Narrative Fragment Library IF-THEN rules activate and
   * inject additional fixed sentences into the rotation-based narrative.
   *
   * @param {object} assessmentData
   * @param {object} report         - { client_name, template_type }
   * @param {number} genIndex       - rotation counter
   * @returns {Array<{ key, title, content }>}
   */
  generate(assessmentData, report, genIndex = 0) {
    const name   = (report && report.client_name) || 'The examinee';
    const ttype  = (report && report.template_type) || 'clinical';
    const tests  = (assessmentData && Array.isArray(assessmentData.tests_administered))
      ? assessmentData.tests_administered : [];
    const obsNotes = ((assessmentData && assessmentData.observational_notes) || '').trim();
    const behObs   = ((assessmentData && assessmentData.behavioral_observations) || '').trim();
    const interview = ((assessmentData && assessmentData.interview_findings) || '').trim();
    const addData   = (assessmentData && assessmentData.additional_data) || {};

    // Detect clinical themes from all clinician-provided text.
    // Only banks matching detected themes will contribute to the narrative —
    // no observations are generated for themes absent from the clinician's input.
    const combinedInput = [obsNotes, behObs, interview].join(' ');
    const themes = _detectThemes(combinedInput);

    const g = genIndex;

    // Resolve structured clinical signals. If none were explicitly provided,
    // bridge from text-detected themes so the IF-THEN fragment rules still fire.
    const rawSignals = _resolveSignals(addData);
    const hasExplicit = Object.keys(rawSignals.cs).length > 0 ||
                        Object.keys(rawSignals.ns).length > 0 ||
                        Object.keys(rawSignals.es).length > 0;
    const signals = hasExplicit ? rawSignals : _themesToSignals(themes, ttype, rawSignals);
    const frags   = _applyNarrativeFragments(ttype, signals, name);
    const fragText  = (section) => frags.filter(f => f.section === section).map(f => f.text).join(' ');
    const hasFrags  = (section) => frags.some(f => f.section === section);

    // ──────────────────────────────────────────────────────────────────────
    // SECTION 1: Test Results and Interpretation
    // ──────────────────────────────────────────────────────────────────────

    const methodLeads = {
      neurodevelopmental: [
        `${name} underwent a neurodevelopmental assessment employing direct behavioral observation, developmental interview, and selected evaluation procedures. The assessment was conducted in a structured clinical setting, with observations made across multiple task demands relevant to adaptive, cognitive, and behavioral functioning.`,
        `This neurodevelopmental evaluation of ${name} was conducted through a combination of caregiver-assisted developmental history review, direct behavioral observation, and structured clinical interview. Observations were recorded across both structured and unstructured contexts to capture a representative behavioral sample.`,
        `A neurodevelopmental assessment was conducted with ${name} using direct observation, clinical interview, and standardized and non-standardized evaluation procedures. The evaluation focused on gathering qualitative observational data across developmental, behavioral, and adaptive domains.`,
      ],
      clinical: [
        `${name} was seen for a clinical psychological assessment conducted through structured clinical interview, behavioral observation, and formal assessment procedures. All findings reported herein are derived from direct clinical observation and examiner-documented behavioral data.`,
        `A clinical psychological assessment was conducted with ${name} using a multi-method approach combining structured interview, direct behavioral observation, and administered psychological procedures. The interpretation below is based exclusively on the observational and clinical data gathered during the evaluation.`,
        `${name} participated in a clinical psychological assessment involving direct behavioral observation, clinical interview, and administered evaluation procedures. The following interpretation is grounded in examiner observations and client-reported information gathered during the evaluation.`,
      ],
      pre_employment: [
        `${name} completed a pre-employment psychological evaluation comprising direct behavioral observation, clinical interview, and administered assessment procedures. The evaluation focused on occupationally relevant behavioral and cognitive functioning as observed during the assessment context.`,
        `A pre-employment psychological evaluation was conducted with ${name} using behavioral observation, structured interview, and formal assessment procedures designed to capture functionally relevant cognitive and interpersonal characteristics.`,
        `${name} was evaluated as part of a pre-employment psychological screening. The evaluation employed direct observation, clinical interview, and formal assessment procedures. Reported findings are based exclusively on observational data collected during the evaluation session.`,
      ],
    };
    const methodLead = this._pick(methodLeads[ttype] || methodLeads.clinical, g, 0);

    // P1 — method overview + instruments
    let p1 = methodLead;
    if (tests.length) {
      const instrLead = this._pick([
        'Instruments and procedures administered included',
        'The assessment battery comprised',
        'Evaluation methods utilized in this assessment included',
        'The following instruments and procedures were employed',
      ], g, 2);
      p1 += ` ${instrLead}: ${tests.join(', ')}.`;
    }

    // P2 — behavioral observation
    // Clinician-provided text is the primary source. Theme-matched observation
    // banks supplement with professional phrasing only for themes detected in input.
    const themeObs2 = _selectThemeObservations(themes, g, 3, ttype);
    const behDomains = [];

    // Opening verb-phrase: pick from a theme-matched bank if available,
    // otherwise use a neutral cognitive/behavioral opener.
    behDomains.push(
      themeObs2.length > 0
        ? themeObs2[0]
        : this._pick(COGNITIVE_OBS, g, 0)
    );

    // Clinician-provided text always follows (primary source)
    if (behObs) {
      behDomains.push(`direct behavioral observation further noted: ${this._lower1(behObs)}`);
    }
    if (obsNotes) {
      behDomains.push(`examiner observational notes: ${this._lower1(obsNotes)}`);
    }

    // Remaining theme-matched observations (up to 2 more)
    for (let i = 1; i < themeObs2.length && behDomains.length < 5; i++) {
      behDomains.push(themeObs2[i]);
    }

    const p2 = `During the assessment, ${name} ` + behDomains[0] + '. ' +
      behDomains.slice(1).join('. ') + '.';

    // P3 — interview findings + conditional somatic/coping/psychosocial
    // Somatic, coping, and psychosocial bank entries are only added when the
    // corresponding themes are present in the clinician's documented input.
    const interviewParts = [];
    if (interview) {
      interviewParts.push(`Clinical interview findings indicated: ${this._lower1(interview)}`);
    } else {
      interviewParts.push(
        `Clinical interview findings provided additional context regarding ${name}'s presenting concerns and current functional status`
      );
    }
    if (themes.sleep || themes.appetite) {
      interviewParts.push(this._pick(SLEEP_SOMATIC_OBS, g, 4));
    }
    if (themes.coping || themes.stress) {
      interviewParts.push(this._pick(COPING_OBS, g, 6));
    }
    if (themes.psychosocial || themes.social || themes.socialSupport) {
      interviewParts.push(this._pick(PSYCHOSOCIAL_OBS, g, 20));
    }
    const p3 = interviewParts.join('. ') + '.';

    // Collect fragment additions for test_results section
    const trFragParts = [];
    if (hasFrags('early_development'))       trFragParts.push(fragText('early_development'));
    if (hasFrags('test_results_fragment'))   trFragParts.push(fragText('test_results_fragment'));
    if (hasFrags('emotional_functioning'))   trFragParts.push(fragText('emotional_functioning'));

    const testResults = [p1, p2, p3, ...trFragParts].filter(Boolean).join('\n\n');

    // ──────────────────────────────────────────────────────────────────────
    // SECTION 2: Findings
    // ──────────────────────────────────────────────────────────────────────

    const findLeads = {
      neurodevelopmental: NEURO_FINDINGS_LEAD,
      clinical:           CLINICAL_FINDINGS_LEAD,
      pre_employment:     PRE_EMP_FINDINGS_LEAD,
    };
    const findLead = this._pick(findLeads[ttype] || CLINICAL_FINDINGS_LEAD, g, 0);

    // P1 — observed domains: only include banks matching detected themes.
    // Clinician input is the authority; banks provide professional phrasing
    // only where a theme has been documented.
    const findDomains = [];
    if (themes.mood || themes.depression) {
      findDomains.push(`${name} ` + this._pick(MOOD_OBS, g, 7));
    }
    if (themes.anxiety) {
      findDomains.push(this._pick(ANXIETY_OBS, g, 8));
    }
    if (themes.motivation) {
      findDomains.push(this._pick(MOTIVATION_OBS, g, 9));
    }
    if (themes.selfEsteem) {
      findDomains.push(this._pick(SELF_CONCEPT_OBS, g, 21));
    }
    if (themes.emotion) {
      findDomains.push(this._pick(EMOTIONAL_REGULATION_OBS, g, 7));
    }
    if (themes.depression) {
      findDomains.push(this._pick(DEPRESSION_OBS, g, 8));
    }
    // Fallback: if no specific emotional/behavioral themes detected, include a
    // neutral general observation so the findings section is not empty.
    if (!findDomains.length) {
      findDomains.push(`${name} ` + this._pick(COGNITIVE_OBS, g, 7));
    }
    const findP1 = findLead + ' ' + findDomains.join('. ') + '.';

    // P2 — social, attention, support: conditional on detected themes.
    const findP2Parts = [];
    if (themes.social) {
      findP2Parts.push(`${name} ` + this._pick(SOCIAL_OBS, g, 10));
    }
    if (themes.attention) {
      findP2Parts.push(this._pick(CONCENTRATION_OBS, g, 11));
    }
    if (themes.socialSupport || themes.social) {
      findP2Parts.push(this._pick(SOCIAL_SUPPORT_OBS, g, 22));
    }
    if (themes.stress || themes.coping) {
      findP2Parts.push(this._pick(STRESS_OBS, g, 10));
    }
    findP2Parts.push(
      'These observational domains, considered collectively, form the basis of the overall clinical impression and the recommendations that follow.'
    );
    const findP2 = findP2Parts.join('. ') + '.';

    // Fragment-based finding additions
    const findingFragParts = [];
    if (hasFrags('social_functioning'))             findingFragParts.push(fragText('social_functioning'));
    if (hasFrags('defense_mechanisms'))             findingFragParts.push(fragText('defense_mechanisms'));
    if (hasFrags('clinical_impression'))            findingFragParts.push(fragText('clinical_impression'));
    if (hasFrags('adaptive_functioning'))           findingFragParts.push(fragText('adaptive_functioning'));
    if (hasFrags('summary_impression'))             findingFragParts.push(fragText('summary_impression'));
    if (hasFrags('overall_results_fragment'))       findingFragParts.push(fragText('overall_results_fragment'));
    if (hasFrags('impression_conclusion_fragment')) findingFragParts.push(fragText('impression_conclusion_fragment'));
    // Risk statement always appended in findings
    if (hasFrags('risk')) findingFragParts.push(fragText('risk'));

    const findings = [findP1, findP2, ...findingFragParts].filter(Boolean).join('\n\n');

    // ──────────────────────────────────────────────────────────────────────
    // SECTION 3: Recommendations
    // ──────────────────────────────────────────────────────────────────────

    const recPools = {
      neurodevelopmental: NEURO_REC_POOL,
      clinical:           CLINICAL_REC_POOL,
      pre_employment:     PRE_EMP_REC_POOL,
    };
    const pool    = recPools[ttype] || CLINICAL_REC_POOL;
    // Select recommendations relevant to documented concerns (theme-matched).
    // RA 11036 / licensed-professional entries are always included as baselines.
    const selected = _selectThemeRecs(pool, themes, g, 3, 5);
    const recIntro = this._pick([
      `Based on the observations gathered during this assessment, the following recommendations are offered for ${name}:`,
      `The following recommendations are provided in light of the clinical and behavioral observations documented above:`,
      `To support ${name}'s wellbeing and functional outcomes, the following course of action is recommended:`,
    ], g, 0);
    const rotatedRecs = recIntro + '\n\n' + selected.map((r, i) => `${i + 1}. ${r}`).join('\n');

    // Assemble recommendations: safety first, then rotated list, then fragment recs, then footer
    const recParts = [];
    if (hasFrags('recommendations_safety')) {
      recParts.push('IMMEDIATE ACTION REQUIRED:\n' + fragText('recommendations_safety'));
    }
    recParts.push(rotatedRecs);
    if (hasFrags('recommendations_fragment')) {
      recParts.push('Additional recommendations:\n' + fragText('recommendations_fragment'));
    }
    if (hasFrags('fit_recommendation')) {
      recParts.push('Employment Fitness Determination:\n' + fragText('fit_recommendation'));
    }
    // Z-FOOTER
    if (hasFrags('footer')) {
      recParts.push(fragText('footer'));
    }
    const recommendations = recParts.join('\n\n');

    // ──────────────────────────────────────────────────────────────────────
    // Build output array (core sections)
    // ──────────────────────────────────────────────────────────────────────

    const output = [
      { key: 'test_results',    title: 'Test Results and Interpretation', content: testResults },
      { key: 'findings',        title: 'Findings',                        content: findings },
      { key: 'recommendations', title: 'Recommendations',                 content: recommendations },
    ];

    // ──────────────────────────────────────────────────────────────────────
    // SECTION 4+ — Template-specific sections
    // ──────────────────────────────────────────────────────────────────────

    // ── NEURODEVELOPMENTAL: Behavioral Observation and MSE ─────────────────
    if (ttype === 'neurodevelopmental') {
      const mseLeads = [
        `During the evaluation, ${name} was observed to display the following behavioral and mental status characteristics.`,
        `The following behavioral observations and mental status findings were documented during the assessment of ${name}.`,
        `Behavioral observation and mental status examination of ${name} yielded the following clinical impressions.`,
      ];
      const mseP1 = this._pick(mseLeads, g, 0) + ' ' +
        `${name} ` + this._pick(MOOD_OBS, g, 12) + '. ' +
        this._pick(CONCENTRATION_OBS, g, 13) + '. ' +
        this._pick(COGNITIVE_OBS, g, 14) + '. ' +
        this._pick(COMMUNICATION_OBS, g, 23) + '.';

      const mseP2Parts = [
        'Psychomotor activity was within observable limits, with no gross evidence of abnormal involuntary movements or significant psychomotor retardation',
        this._pick(ANXIETY_OBS, g, 15),
        this._pick(SENSORY_OBS, g, 24),
        'Speech rate, rhythm, and volume were within functional range for the assessment context, with no evidence of formal thought disorder or disorganized communication',
      ];
      const mseP2 = mseP2Parts.join('. ') + '.';

      // Supplement with academic functioning observations
      const mseP3 = this._pick(ACADEMIC_OBS, g, 0) + ' ' +
        this._pick(ADAPTIVE_BEHAVIOR_OBS, g, 25) + '.';

      output.push({
        key: 'behavioral_observation_mse',
        title: 'Behavioral Observation and Mental Status Exam',
        content: [mseP1, mseP2, mseP3].join('\n\n'),
      });
    }

    // ── CLINICAL: General Observations, Interview, MSE + Diagnostic Impression
    if (ttype === 'clinical') {
      const genObsLeads = [
        `The following observations were documented across general behavioral observation, structured clinical interview, and mental status examination of ${name}.`,
        `General observation and clinical interview with ${name} yielded the following findings for the mental status examination.`,
        `Mental status examination and structured interview of ${name} produced the following general observational findings.`,
      ];
      const genObsP1 = this._pick(genObsLeads, g, 0) + ' ' +
        `${name} ` + this._pick(MOOD_OBS, g, 12) + '. ' +
        this._pick(ANXIETY_OBS, g, 13) + '. ' +
        this._pick(DEPRESSION_OBS, g, 25) + '.';

      const genObsP2 = `On mental status examination, ${name} presented with ${
        this._pick([
          'coherent and goal-directed thought processes, with no evidence of formal thought disorder',
          'generally organized ideation and linear thought progression, with no observed loosening of associations',
          'sequential and reality-oriented thought content, with no evidence of delusional or hallucinatory phenomena',
        ], g, 14)
      }. ` +
        this._pick(COGNITIVE_OBS, g, 15) + '. ' +
        (interview
          ? `Clinical interview findings further revealed: ${this._lower1(interview)}.`
          : `Clinical interview provided additional context pertaining to ${name}'s presenting concerns and current life circumstances.`);

      // Enrich with stress and appetite observations (derived from clinical datasets)
      const genObsP3 = this._pick(STRESS_OBS, g, 26) + '. ' +
        this._pick(APPETITE_OBS, g, 27) + '.';

      output.push({
        key: 'general_observations_interview_mse',
        title: 'General Observations, Interview, and MSE',
        content: [genObsP1, genObsP2, genObsP3].join('\n\n'),
      });

      // Diagnostic Impression
      const diagLeads = [
        'Based on the clinical observations, behavioral findings, and interview data gathered during this assessment, the following diagnostic impression is offered.',
        `Integrating all available clinical data, the following diagnostic impression is formulated for ${name}.`,
        'The diagnostic impression below is derived from direct clinical observation, mental status examination, and structured interview.',
      ];
      const diagP1 = this._pick(diagLeads, g, 0) + ' ' +
        `The observed affective, behavioral, and cognitive presentation of ${name} is consistent with clinically significant functional concerns warranting further evaluation and monitoring. ` +
        this._pick(COPING_OBS, g, 16) + '. ' +
        this._pick(STRESS_OBS, g, 28) + '.';

      const diagP2 =
        'This diagnostic impression is based solely on observational and interview data obtained during the current evaluation. ' +
        'Formal diagnostic conclusions require comprehensive longitudinal assessment, collateral information, and professional clinical judgment consistent with the DSM-5-TR and applicable Philippine Mental Health Act (RA 11036) standards. ' +
        'The examining clinician is encouraged to interpret these impressions within the broader clinical context.';

      output.push({
        key: 'diagnostic_impression',
        title: 'Diagnostic Impression',
        content: [diagP1, diagP2].join('\n\n'),
      });
    }

    // ── PRE-EMPLOYMENT: Overall Result, Impression & Conclusion, Recommendation
    if (ttype === 'pre_employment') {
      const overallLeads = [
        `The overall psychological assessment result for ${name} is summarized below, based on the behavioral observations, interview findings, and administered assessment procedures.`,
        `Following the completion of the pre-employment psychological evaluation, the overall assessment result for ${name} is presented.`,
        `The following overall result is derived from a comprehensive review of all behavioral, cognitive, and interpersonal data gathered during the assessment of ${name}.`,
      ];
      const overallP1 = this._pick(overallLeads, g, 0) + ' ' +
        `${name} ` + this._pick(MOTIVATION_OBS, g, 12) + '. ' +
        this._pick(COGNITIVE_OBS, g, 13) + '.';

      const overallP2 = `In terms of interpersonal functioning and role-relevant behavioral characteristics, ` +
        `${name} ` + this._pick(SOCIAL_OBS, g, 14) + '. ' +
        this._pick(CONCENTRATION_OBS, g, 15) + '. ' +
        this._pick(INTERPERSONAL_OBS, g, 27) + '. ' +
        this._pick(WORK_LIFE_BALANCE_OBS, g, 28) + '. ' +
        'These observations provide a composite picture of the applicant\'s functional readiness for occupational placement.';

      output.push({
        key: 'overall_result',
        title: 'Overall Psychological Assessment Result',
        content: [overallP1, overallP2].join('\n\n'),
      });

      // Impression and Conclusion
      const impLeads = [
        `Based on the cumulative findings of this pre-employment psychological evaluation, the following impression and conclusion are offered for ${name}.`,
        `The following impression and conclusion summarize the findings of the psychological evaluation conducted with ${name}.`,
        `Integrating all pre-employment assessment data, the following impression and conclusion are presented for ${name}.`,
      ];
      const impP1 = this._pick(impLeads, g, 0) + ' ' +
        this._pick(PRE_EMP_FINDINGS_LEAD, g, 1) + ' ' +
        `${name} ` + this._pick(MOOD_OBS, g, 16) + '. ' +
        this._pick(COPING_OBS, g, 17) + '. ' +
        this._pick(STRESS_OBS, g, 29) + '.';

      const impP2 = `Based on the behavioral and cognitive profile observed during this evaluation, ${name} demonstrates ${
        this._pick([
          'functional readiness for structured occupational demands, with noted areas for developmental support',
          'adequate behavioral competencies for role placement, subject to the recommendations outlined below',
          'sufficient occupational behavioral characteristics, with identified growth areas that may be addressed through structured onboarding',
        ], g, 18)
      }. The examining psychologist recommends careful review of these findings alongside other selection criteria before final placement decisions are made.`;

      output.push({
        key: 'impression_conclusion',
        title: 'Impression and Conclusion',
        content: [impP1, impP2].join('\n\n'),
      });

      // Pre-Employment Recommendation (separate section)
      const pool2 = PRE_EMP_REC_POOL;
      const selected2 = _selectThemeRecs(pool2, themes, g + 3, 3, 5);
      const recIntro2 = this._pick([
        `Based on the pre-employment psychological evaluation of ${name}, the following recommendations are provided:`,
        `The following recommendations are offered to support the optimal placement and onboarding of ${name}:`,
        `In light of the behavioral and cognitive findings documented above, the following recommendations are put forward for ${name}:`,
      ], g, 1);

      const rec2Parts = [recIntro2 + '\n\n' + selected2.map((r, i) => `${i + 1}. ${r}`).join('\n')];
      if (hasFrags('fit_recommendation')) {
        rec2Parts.push('Employment Fitness Determination:\n' + fragText('fit_recommendation'));
      }
      if (hasFrags('footer')) {
        rec2Parts.push(fragText('footer'));
      }

      output.push({
        key: 'recommendation',
        title: 'Recommendation',
        content: rec2Parts.join('\n\n'),
      });
    }

    // ── Explainability trace (Item 4) ────────────────────────────────────────
    // Metadata describing WHY this output was produced: which themes were
    // detected, the resolved signals, and which IF-THEN rules fired. Attached as
    // a NON-enumerable property so `output` still serializes as a pure array of
    // sections (callers that ignore it, and JSON.stringify, are unaffected).
    const onlyTrue = (obj) => Object.keys(obj || {}).filter((k) => obj[k]);
    const nonEmpty = (obj) => (obj && Object.keys(obj).length ? obj : undefined);
    const trace = {
      template_type: ttype,
      genIndex: g,
      themesDetected: onlyTrue(themes),
      signals: {
        clinical: nonEmpty(signals.cs),
        neuro: nonEmpty(signals.ns),
        employment: nonEmpty(signals.es),
      },
      firedRules: [...new Set(frags.map((f) => f.ruleId).filter(Boolean))],
      fragmentCount: frags.length,
      sections: output.map((s) => s.key),
    };
    try { Object.defineProperty(output, 'trace', { value: trace, enumerable: false }); } catch (_) {}

    return output;
  },
};

// ── Extraction hook (Item 1) ─────────────────────────────────────────────────
// Exposes the module-scoped knowledge so scripts/extractKnowledge.js can dump it
// to the knowledge/ JSON files verbatim. buildFragmentLibrary runs the fragment
// rules with a '{name}' placeholder so each fragment's stored TEXT is the exact
// template (the `${name}` interpolation becomes the literal "{name}"). Harmless
// at runtime; used only by the extractor and tests.
RuleEngine._internals = {
  banks: {
    mood: MOOD_OBS, anxiety: ANXIETY_OBS, sleep_somatic: SLEEP_SOMATIC_OBS,
    motivation: MOTIVATION_OBS, social: SOCIAL_OBS, coping: COPING_OBS,
    concentration: CONCENTRATION_OBS, cognitive: COGNITIVE_OBS, depression: DEPRESSION_OBS,
    emotional_regulation: EMOTIONAL_REGULATION_OBS, psychosocial: PSYCHOSOCIAL_OBS,
    stress: STRESS_OBS, appetite: APPETITE_OBS, self_concept: SELF_CONCEPT_OBS,
    social_support: SOCIAL_SUPPORT_OBS, adaptive_behavior: ADAPTIVE_BEHAVIOR_OBS,
    communication: COMMUNICATION_OBS, sensory: SENSORY_OBS, academic: ACADEMIC_OBS,
    occupational: OCCUPATIONAL_OBS, interpersonal: INTERPERSONAL_OBS,
    work_life_balance: WORK_LIFE_BALANCE_OBS, risk_elevated: RISK_ELEVATED_OBS,
    risk_none: RISK_NONE_OBS, neuro_findings_lead: NEURO_FINDINGS_LEAD,
    clinical_findings_lead: CLINICAL_FINDINGS_LEAD, pre_emp_findings_lead: PRE_EMP_FINDINGS_LEAD,
  },
  pools: { clinical: CLINICAL_REC_POOL, neuro: NEURO_REC_POOL, pre_employment: PRE_EMP_REC_POOL },
  detectThemes: (text) => _detectThemes(text),
  buildFragmentLibrary() {
    const lib = {};
    for (const ttype of ['clinical', 'neurodevelopmental', 'pre_employment']) {
      // Fire every rule by supplying signals that satisfy all branches.
      const all = {
        cs: { depression: 'severe', anxiety_level: 'severe', sleep_quality: 'low', self_esteem: 'low',
          mental_health_history: 'Yes', social_support: 'low', bullying: 'high', coping: 'avoidant',
          insight: 'present', change_readiness: 'low', emotional_instability: 'present',
          fear_of_abandonment: 'present', risk_flag: 'ELEVATED' },
        ns: { early_milestones: 'delayed', prior_assessment: 'Yes', overall_cognition: 'below-age',
          visual_spatial: 'relative_strength', working_memory: 'weak', knowledge: 'weak',
          global_adaptive: 'low', communication: 'limited', parental_involvement: 'low',
          mental_health_history: 'Yes', risk_flag: 'ELEVATED' },
        es: { reasoning: 'adequate', organization: 'low', WorkLifeBalance: 'poor', OverTime: 'Yes',
          emotional_stability: 'low', EnvironmentSatisfaction: 'high', attrition_risk: 'ELEVATED' },
      };
      for (const fit of ['fit', 'not_recommended', 'fit_with_considerations']) {
        const sig = { cs: all.cs, ns: all.ns, es: { ...all.es, fit_level: fit } };
        // Also exercise the mild/moderate/suppression alternatives.
        for (const variant of [{}, { cs: { ...all.cs, depression: 'moderate', coping: 'suppression', social_support: 'moderate' } },
                               { cs: { ...all.cs, depression: 'mild' } }]) {
          const s = { cs: variant.cs || sig.cs, ns: sig.ns, es: sig.es };
          for (const f of _applyNarrativeFragments(ttype, s, '{name}')) {
            if (f.ruleId && !lib[f.ruleId]) lib[f.ruleId] = { section: f.section, text: f.text };
          }
        }
      }
      // No-risk pass — captures X-RK-LOW (no elevated risk), which the
      // all-ELEVATED passes above never reach.
      const stripRisk = (o) => { const c = { ...o }; delete c.risk_flag; return c; };
      for (const f of _applyNarrativeFragments(ttype, { cs: stripRisk(all.cs), ns: stripRisk(all.ns), es: stripRisk(all.es) }, '{name}')) {
        if (f.ruleId && !lib[f.ruleId]) lib[f.ruleId] = { section: f.section, text: f.text };
      }
    }
    return lib;
  },
};

module.exports = RuleEngine;
