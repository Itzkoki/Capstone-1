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
const MOOD_OBS = [
  'presented with a generally subdued affect throughout the session, with limited range of emotional expression',
  'demonstrated observable fluctuations in mood, alternating between periods of engagement and visible withdrawal',
  'maintained a relatively stable affect during the assessment, though moments of flat or restricted expression were noted',
  'displayed a constricted range of affect, with limited spontaneous emotional responsiveness during the interaction',
  'showed signs of emotional dysregulation, including brief periods of tearfulness and difficulty modulating affective response',
  'exhibited muted affective expression throughout the evaluation, with minimal spontaneous emotional reactivity to session content',
  'presented with variable affective expression, demonstrating moments of genuine engagement interspersed with periods of affective blunting',
  'displayed observable signs of mood-related fatigue, including reduced affective vitality and limited motivational investment in social interaction',
  'demonstrated low-grade affective distress that was visually apparent throughout the session, manifested as reduced facial expressiveness and psychomotor quieting',
  'showed a reserved and emotionally guarded presentation, with careful regulation of emotional expression across the assessment interaction',
  // derived from Psychological_Assessment_Dataset.csv mood descriptors
  'presented with observable low mood consistent with reported dissatisfaction and reduced engagement in daily activities across the assessment period',
  'demonstrated emotional presentation characterized by reduced expressiveness and limited spontaneous affect that may reflect current psychosocial burden',
  // derived from Indicators_of_Anxiety_or_Depression CSV frequency-based symptom data
  'reported experiencing depressed mood on more days than not during the reference period, with associated functional impact on daily engagement',
  'endorsed frequent episodes of low mood and emotional exhaustion that were corroborated by behavioral observations during the evaluation',
];

// ── ANXIETY ────────────────────────────────────────────────────────────────────
const ANXIETY_OBS = [
  'exhibited behavioral indicators consistent with heightened autonomic arousal, including observable restlessness and frequent self-monitoring',
  'demonstrated signs of elevated social anxiety, showing guardedness and minimal spontaneous disclosure in interpersonal contexts',
  'displayed somatic tension signs including shallow breathing, muscle guarding, and increased psychomotor agitation during the evaluation',
  'showed notable anticipatory apprehension when transitioning between tasks, accompanied by increased latency in verbal responses',
  'exhibited cognitive avoidance behaviors, particularly when topics related to perceived threat or performance demands were introduced',
  'demonstrated somatic anxiety markers including visible muscle tension and irregular breathing patterns during periods of heightened task demand',
  'showed behavioral indicators of anticipatory anxiety, including increased fidgeting, self-referential commentary, and repeated reassurance-seeking behavior',
  'exhibited social evaluative anxiety responses, with notable behavioral constriction when attention was directed toward personal performance or personal history',
  'displayed generalized tension and hypervigilance throughout the session, with heightened startle responsiveness and difficulty relaxing between task transitions',
  'demonstrated cognitive patterns consistent with chronic worry, including repeated catastrophizing statements and difficulty maintaining a present-focused orientation',
  // derived from Psychological_Assessment_Dataset.csv — physical anxiety symptoms field
  'reported physical symptoms of anxiety including heart palpitations, perspiration, and shortness of breath, consistent with elevated physiological arousal',
  'endorsed recurring episodes of somatic anxiety expression including chest tightness and trembling, corroborating elevated anxiety burden',
  // derived from Stress_Dataset.csv — rapid heartbeat and palpitations columns
  'demonstrated behavioral and self-reported indicators of physiological stress reactivity, including rapid heartbeat and palpitation episodes during periods of heightened demand',
  'reported frequent experiences of anxious arousal including physical tension, restlessness, and a persistent sense of unease affecting daily functioning',
];

// ── SLEEP / SOMATIC ────────────────────────────────────────────────────────────
const SLEEP_SOMATIC_OBS = [
  'reported disruptions in sleep-wake patterns that were corroborated by observable fatigue and concentration lapses during the session',
  'presented with physical indicators of inadequate rest, including reduced psychomotor speed and difficulty sustaining effortful attention',
  'endorsed somatic complaints consistent with chronic stress load, including reported headaches, appetite irregularities, and generalized fatigue',
  'demonstrated reduced physical vitality across the session, with observable decline in engagement and task persistence over time',
  'reported changes in appetite and energy that, alongside behavioral observations, suggest elevated physiological stress responses',
  'reported significant sleep onset difficulties and nighttime awakenings that were reflected in observable daytime fatigue and impaired sustained attention during the evaluation',
  'endorsed chronic sleep disruption across multiple modalities — onset, maintenance, and early morning wakening — with associated daytime functional consequences',
  'described somatic complaints including headaches, gastrointestinal irregularities, and generalized physical tension correlated with heightened psychosocial stress',
  'presented with observable indicators of chronic fatigue, including reduced psychomotor tempo and difficulty maintaining alertness during cognitively demanding session phases',
  'reported appetite and weight changes alongside disrupted sleep, suggesting a constellation of somatic indicators consistent with elevated chronic stress activation',
  // derived from Stress_Dataset.csv — sleep problems, headaches, illness columns
  'reported recurring headaches and frequent sleep difficulties that appeared temporally related to periods of elevated academic or occupational stress demand',
  'endorsed somatic symptom cluster including headaches, fatigue, and sleep irregularities consistent with a chronic psychosocial stress burden',
  // derived from Psychological_Assessment_Dataset.csv — sleep quality field
  'described irregular sleep characterized by early morning wakening and difficulty achieving restorative rest, contributing to daytime functional compromise',
];

// ── MOTIVATION / ANHEDONIA ──────────────────────────────────────────────────────
const MOTIVATION_OBS = [
  'showed diminished initiative and reduced spontaneous engagement with presented tasks, requiring frequent external redirection',
  'demonstrated anhedonic behavioral markers, including flat response to typically rewarding stimuli and low motivational investment in activities',
  'exhibited variable effort and task persistence, with measurable decline in engagement as cognitive demands increased',
  'displayed limited goal-directed behavior and reduced self-initiation across both structured and unstructured portions of the assessment',
  'showed interest inconsistency, with selective engagement in preferred topics and marked avoidance of effortful or demanding tasks',
  'demonstrated limited intrinsic motivation for self-initiated activities, with performance contingent primarily on external prompting and structured environmental support',
  'showed selective engagement across the evaluation, demonstrating markedly higher task investment when activities aligned with personal interest areas compared to neutral demands',
  'exhibited behavioral indicators of motivational depletion, including early task abandonment, frequent requests for breaks, and minimal initiative in open-ended task phases',
  'reported subjective loss of motivation and purposefulness consistent with behavioral observations of reduced goal-directed activity and diminished future orientation',
  'demonstrated intact motivation for preferred domains but significant motivational restriction in areas perceived as effortful, evaluative, or socially exposing',
  // derived from Psychological_Assessment_Dataset.csv — lack of interest and enjoyable activities fields
  'endorsed frequent loss of interest and pleasure in previously enjoyable activities, with reduced engagement in leisure and recreational pursuits over the recent period',
  'reported difficulty sustaining motivation for daily tasks, with a notably reduced frequency of engagement in activities that previously provided satisfaction',
  // derived from StudentPerformanceFactors.csv — motivation_level field
  'demonstrated low academic or task motivation characterized by minimal effort investment and reduced responsiveness to achievement-oriented demands',
];

// ── SOCIAL FUNCTIONING ──────────────────────────────────────────────────────────
const SOCIAL_OBS = [
  'demonstrated restricted social reciprocity, with delayed turn-taking and limited spontaneous sharing of experiences during the interaction',
  'showed pragmatic language patterns consistent with reduced social confidence, including frequent topic disengagement and minimal eye contact',
  'presented with intact basic communication skills but observable difficulty sustaining reciprocal social exchanges for extended periods',
  'exhibited social withdrawal tendencies, preferring task-focused interaction over social banter and showing minimal initiation of social contact',
  'demonstrated heightened self-consciousness in interpersonal contexts, with behavioral avoidance responses when direct social evaluation was implied',
  'demonstrated a preference for structured, task-oriented social interaction over open-ended social banter, showing greater functional comfort in procedurally predictable exchanges',
  'exhibited selective social responsiveness, engaging more fluidly with familiar topics and showing markedly reduced reciprocity when navigating interpersonal uncertainty',
  'showed adequate surface-level social competence alongside observable difficulty sustaining deeper relational engagement over extended periods',
  'demonstrated social anxiety-adjacent behaviors including prolonged gaze avoidance, careful topic monitoring, and tendency to minimize personal disclosures in the evaluation context',
  'reported reduced frequency and quality of interpersonal connections, with observable impact on sense of belonging and social confidence in group contexts',
  // derived from Mental Health Dataset.csv — social_weakness and days_indoors fields
  'reported significant reduction in social engagement and community participation, with extended periods indoors and away from usual interpersonal networks',
  'demonstrated social withdrawal consistent with prolonged stress exposure, including limited participation in peer activities and reduced initiation of interpersonal contact',
  // derived from Stress_Dataset.csv — loneliness and isolation columns
  'endorsed frequent experiences of loneliness and social isolation that appear to compound existing emotional difficulties and reduce available support resources',
];

// ── COPING MECHANISMS ────────────────────────────────────────────────────────────
const COPING_OBS = [
  'identified primarily avoidant coping strategies, with limited reported use of problem-focused or emotion-regulation approaches',
  'demonstrated reliance on disengagement and cognitive suppression as primary stress management strategies during the interview',
  'reported using social support and physical activity as adaptive coping mechanisms, though access to these resources appeared inconsistent',
  'showed mixed coping repertoire, combining some adaptive strategies (e.g., structured routines, creative expression) with maladaptive avoidance',
  'demonstrated limited coping flexibility, applying the same response pattern across varied stressor types regardless of context or effectiveness',
  'reported using prayer, spiritual engagement, and community-based activities as primary coping resources, consistent with Filipino cultural norms around psychosocial resilience',
  'demonstrated an emotion-focused coping orientation, with greater reliance on affective expression and social sharing compared to instrumental problem-solving approaches',
  'showed limited access to evidence-informed coping strategies, relying instead on habitual avoidance and disengagement that provided short-term relief but limited longer-term resolution',
  'described coping patterns that were contextually inconsistent, applying different strategies across similar stressors without an evaluative framework for selecting effective responses',
  'reported that social comparison and perceived familial obligation significantly shaped coping behavior, suggesting a collectivist-influenced stress appraisal and management style',
  // derived from Psychological_Assessment_Dataset.csv — coping strategies field
  'reported use of physical activity and brief relaxation exercises as primary coping strategies, though consistency of application appeared variable across high-stress periods',
  'endorsed reliance on avoidance and disengagement as primary stress responses, with limited use of problem-focused or socially-engaged coping approaches',
  // derived from Mental Health Dataset.csv — coping_struggles and changes_habits fields
  'reported significant difficulty managing ongoing stressors, with observable changes in daily habits and routines suggesting coping resource depletion',
];

// ── CONCENTRATION / ATTENTION ───────────────────────────────────────────────────
const CONCENTRATION_OBS = [
  'exhibited observable difficulty sustaining focused attention across extended task demands, with frequent off-task episodes',
  'demonstrated inconsistent concentration, with better performance on brief, highly structured tasks compared to open-ended or lengthier activities',
  'showed signs of attentional splitting, dividing focus between the task and environmental stimuli in a manner that disrupted task completion',
  'presented with cognitive fatigue effects — initially adequate concentration declined noticeably across the session duration',
  'reported subjective concentration difficulties that were corroborated by behavioral indicators of reduced working memory engagement',
  'demonstrated observable attentional lapses during the evaluation, with periodic disorientation to task instructions requiring examiner redirection to maintain task engagement',
  'showed working memory interference effects, with reduction in performance quality when task instructions required retention of multiple sequential steps',
  'exhibited divided attention difficulties, demonstrating performance degradation when required to process multiple simultaneous stimulus streams',
  'reported subjective concentration difficulties reflected in increased response time variability across similar task demands throughout the session',
  'demonstrated adequate attentional focus during brief, clearly bounded tasks, with marked decline as session duration increased and cognitive demands accumulated',
  // derived from Stress_Dataset.csv — trouble concentrating on academic tasks column
  'reported difficulty concentrating on academic or work-related tasks, with stress-related cognitive interference noted as a primary contributor',
  // derived from Indicators_of_Anxiety_or_Depression CSV — frequency-based symptom reporting
  'endorsed frequent concentration difficulties during the reference period, consistent with current affective and stress burden impacting cognitive efficiency',
];

// ── COGNITIVE FUNCTIONING ───────────────────────────────────────────────────────
const COGNITIVE_OBS = [
  'demonstrated adequate verbal comprehension and reasoning within the context of clinical observation, without formal standardized testing',
  'showed organized and sequential thought processes during structured questioning, though elaboration was limited',
  'displayed concrete thinking style with limited spontaneous abstraction, consistent with developmental or educational history factors',
  'exhibited generally intact receptive language and task comprehension, though processing speed appeared reduced under time pressure',
  'demonstrated logical and coherent thought organization, with no evidence of thought disorder or significant formal cognitive disruption',
  'demonstrated fluid reasoning within observationally accessible limits, with adequate capacity for categorical thinking and novel problem-solving under structured conditions',
  'showed relative strength in verbal expressive skills compared to nonverbal processing, with language-based tasks demonstrating greater complexity and elaboration',
  'exhibited adequate executive function indicators including basic planning, behavioral inhibition, and self-monitoring, with variable performance across cognitively complex demands',
  'displayed concrete-to-abstract reasoning transitions that appeared effortful, with reliance on familiar schemas rather than generative problem-solving approaches',
  'demonstrated generally organized ideation and logical reasoning within the scope of direct clinical observation, with no gross evidence of cognitive fragmentation or formal thought disorder',
];

// ── DEPRESSION ──────────────────────────────────────────────────────────────────
const DEPRESSION_OBS = [
  'displayed behavioral markers consistent with depressed mood, including diminished affective range, psychomotor slowing, and reduced expressive spontaneity throughout the session',
  'exhibited signs of anhedonia, with endorsed loss of pleasure in previously rewarding activities and significant withdrawal from social and recreational engagement',
  'demonstrated observable low energy and reduced initiative, with subjective reports of persistent feelings of emptiness and diminished sense of personal purpose',
  'showed affective presentation consistent with low mood, including decreased vocalization, prolonged response latency, and reduced spontaneous eye contact with the examiner',
  'reported pervasive feelings of worthlessness and self-blame corroborated by behavioral indicators of reduced self-efficacy and limited aspirational thinking during the evaluation',
  'demonstrated psychomotor characteristics consistent with depressed functioning, including slowed movement tempo, minimal gestural expression, and reduced postural engagement',
  'reported persistent mood lowering across multiple weeks that appeared independent of situational fluctuations, suggesting potential chronic affective dysregulation',
  'exhibited cognitive correlates of low mood including difficulty generating positive future-oriented thoughts, ruminative ideation, and reduced cognitive flexibility under neutral task conditions',
  'showed reduced social motivation and interest in interpersonal connection, with subjective reports of emotional numbness and disconnection from previously meaningful relationships',
  'demonstrated loss of spontaneous affect across the session, with affective response requiring significant external elicitation and limited carryover between emotionally activating content',
  // derived from Indicators_of_Anxiety_or_Depression CSV — symptom frequency data
  'endorsed symptoms consistent with clinically significant depressive burden based on frequency and duration of reported emotional and functional difficulties during the preceding assessment period',
  'reported persistent depressive symptoms including low mood, fatigue, reduced concentration, and diminished pleasure, consistent with elevated affective burden',
];

// ── EMOTIONAL REGULATION ─────────────────────────────────────────────────────────
const EMOTIONAL_REGULATION_OBS = [
  'demonstrated difficulty modulating emotional responses to mild stressors, suggesting reduced affective tolerance and limited emotional regulatory capacity under evaluative conditions',
  'showed evidence of emotional lability, with rapid shifts in affective tone that appeared disproportionate to the situational demands encountered during the assessment',
  'exhibited limited frustration tolerance, with observable behavioral escalation in response to perceived task failure or ambiguous evaluative feedback',
  'demonstrated generally intact emotional regulation under low-demand conditions, though escalating task complexity was associated with observable affective dysregulation and disengagement',
  'reported relying primarily on external co-regulation strategies, with limited capacity for independent affective self-regulation in the absence of social support',
  'showed inconsistent emotional regulation across session phases, maintaining composure during structured tasks while demonstrating increased emotional reactivity during open-ended interview components',
  'demonstrated emotional overcontrol as a regulatory strategy, presenting with minimal affective expression that appeared effortful rather than reflecting genuine emotional neutrality',
  'exhibited delayed emotional recovery following minor frustrations, with residual behavioral agitation persisting into subsequent task phases',
  'reported active use of suppression and emotional avoidance as primary regulatory strategies, which appeared to limit authentic emotional expression during the clinical interview',
  'demonstrated emotional regulation within normal functional limits in familiar low-demand contexts, with functional breakdown occurring under conditions of novelty, social evaluation, or task failure',
  // derived from Mental Health Dataset.csv — mood_swings field
  'demonstrated mood variability during the session, with fluctuations in affective tone that appeared reactive to perceived demands and interpersonal cues',
];

// ── PSYCHOSOCIAL CONTEXT ──────────────────────────────────────────────────────────
const PSYCHOSOCIAL_OBS = [
  'identified significant family-related stressors as primary psychosocial contributors to current functional difficulties, including interpersonal conflict and perceived relational instability',
  'reported occupational and financial concerns as salient psychosocial stressors, with observable impact on daily functioning, emotional stability, and future planning capacity',
  'described relational difficulties within the family system that appeared to contribute substantially to the presenting functional concerns and current affective presentation',
  'identified multiple concurrent psychosocial stressors spanning interpersonal, occupational, and economic domains, suggesting elevated cumulative stress load and reduced adaptive capacity',
  'reported limited access to social support networks, which appeared to amplify the impact of identified psychosocial stressors on current emotional and functional status',
  'described psychosocial history marked by significant life transitions and role disruptions that have cumulatively impacted adaptive functioning and stress resilience',
  'reported that socioeconomic constraints substantially limit access to mental health resources, educational opportunities, and community participation, contributing to cumulative functional burden',
  'identified school-related stressors including academic pressure, peer relational difficulties, and performance demands as significant contributors to the current presentation',
  'described a psychosocial environment characterized by limited predictability and elevated interpersonal conflict, with observed impact on sense of safety, trust, and emotional regulation',
  'reported that cultural and familial expectations regarding achievement, role obligations, and emotional expression contribute significantly to the experienced psychosocial burden',
  // derived from Philippine NSMHW Report and NSMHW Project Briefer
  'described psychosocial stressors consistent with population-level trends identified in Philippine mental health surveillance data, including economic burden, family conflict, and limited service access',
  'reported barriers to mental health help-seeking including stigma, cost, and limited availability of culturally-sensitive services, consistent with documented challenges in the Philippine context',
  // derived from Mental Health Dataset.csv — family_history, treatment, care_options fields
  'disclosed a family history of mental health difficulties relevant to current risk and protective factor assessment in the context of the Philippine Mental Health Act (RA 11036)',
];

// ── STRESS INDICATORS ───────────────────────────────────────────────────────────
const STRESS_OBS = [
  'demonstrated physiological and behavioral indicators of chronic stress activation, including persistent tension, irritability, and reduced recovery capacity between stressor exposures',
  'exhibited stress response patterns consistent with prolonged psychosocial burden, including diminished resilience, heightened reactivity, and impaired recovery between demands',
  'reported cumulative stressor exposure across multiple life domains, with insufficient coping resources to adequately buffer the associated functional impact on daily performance',
  'showed behavioral signs of stress-related functional compromise, including disruptions in sleep, appetite, concentration, and interpersonal engagement across the evaluation period',
  'demonstrated inconsistent stress tolerance, maintaining adequate functioning under baseline conditions but showing significant behavioral deterioration under acute stressor exposure',
  'reported chronic stress exposure related to role obligations and environmental demands, with observable impact on energy level, concentration, and overall sense of wellbeing',
  'exhibited stress sensitization patterns, with minor stressors eliciting disproportionate behavioral responses consistent with reduced stress buffer capacity',
  'described work- or school-related stress as the primary ongoing stressor, with reported spillover effects on sleep quality, appetite, and quality of interpersonal relationships',
  'demonstrated behavioral stress responses including increased somatization, withdrawal, and reduced engagement in previously valued activities during periods of high demand',
  'reported difficulty returning to baseline functioning following stressor exposure, suggesting impaired allostatic regulation and elevated cumulative stress burden',
  // derived from StressLevelDataset.csv — composite stress_level field
  'presented with a behavioral and self-reported profile consistent with elevated stress burden, with identifiable impact across sleep, functioning, and interpersonal engagement',
  // derived from Stress_Dataset.csv — eustress / distress type column
  'reported experiencing both performance-enhancing and distressing stress, with the cumulative stress load currently appearing to exceed available coping and support resources',
];

// ── APPETITE / NUTRITIONAL FUNCTIONING ─────────────────────────────────────────
const APPETITE_OBS = [
  'reported notable changes in appetite and eating patterns, with associated fluctuations in energy level and physical vitality corroborated during the clinical interview',
  'endorsed appetite disturbances consistent with stress-related eating pattern disruption, including either significant reduction or increased consumption beyond typical personal baseline',
  'described irregular eating patterns and reduced appetite that appeared correlated with mood fluctuations and heightened psychosocial stress exposure',
  'reported appetite changes accompanied by reduced interest in food preparation and meal planning, reflecting broader motivational and self-care deficits impacting daily living',
  'demonstrated behavioral indicators of somatic stress response, including appetite dysregulation and gastrointestinal discomfort endorsed as recurring concerns during the clinical interview',
  'described weight changes and altered eating frequency that appeared temporally correlated with onset of current psychosocial stressors and mood disruption',
  'reported increased stress-related eating characterized by consumption of comfort foods and irregular meal timing, inconsistent with previous baseline eating patterns',
  'endorsed significant reduction in appetite and food intake, with reported weight loss and reduced nutritional self-care that may contribute to observed physical fatigue and reduced vitality',
  'demonstrated patterns of nutritional dysregulation linked to affective fluctuations, with appetite serving as a behaviorally observable indicator of overall psychosocial load',
  'described eating pattern disruptions that fluctuated with mood and stress levels, suggesting appetite sensitivity as a somatic marker of the current psychological presentation',
  // derived from Psychological_Assessment_Dataset.csv — appetite_change field
  'endorsed significant changes in appetite including increased cravings and irregular meal timing correlated with current stress and mood disturbance',
];

// ── SELF-CONCEPT / SELF-ESTEEM ───────────────────────────────────────────────────
const SELF_CONCEPT_OBS = [
  'expressed a negative self-concept characterized by heightened self-criticism, perceived personal inadequacy, and limited recognition of individual strengths and accomplishments',
  'demonstrated reduced self-efficacy, with observable hesitancy in task initiation and repeated verbal minimization of personal capabilities throughout the evaluation',
  'reported experiencing persistent self-doubt and difficulty attributing success to internal factors, reflecting a potentially unstable and self-critical self-concept',
  'showed evidence of a developing but fragile sense of personal identity, with observable sensitivity to perceived evaluation and tendency toward social comparison',
  'demonstrated generally intact self-concept under neutral conditions, though performance contexts evoked notable self-critical verbalizations and avoidance of challenging tasks',
  'reported a pattern of negative self-attribution wherein failures are internalized and successes are attributed to external or situational factors rather than personal competence',
  'exhibited verbal self-deprecation across multiple domains of competence, with minimal spontaneous recognition of personal strengths or past accomplishments during the interview',
  'described identity-related uncertainty and difficulty articulating a stable sense of personal values, goals, or direction, particularly within interpersonal and occupational contexts',
  'demonstrated behavioral self-monitoring and performance anxiety linked to perfectionistic self-standards and fear of negative evaluation by significant others',
  'showed evidence of contingent self-worth, with self-esteem closely tied to perceived performance outcomes and interpersonal acceptance, resulting in emotional vulnerability to perceived failure',
  // derived from StressLevelDataset.csv — self_esteem scale
  'presented with markedly reduced self-esteem as observed through self-referential statements, task avoidance, and reluctance to articulate personal strengths or achievements',
];

// ── SOCIAL SUPPORT ───────────────────────────────────────────────────────────────
const SOCIAL_SUPPORT_OBS = [
  'reported limited availability of reliable social support, with reduced access to meaningful interpersonal connections during periods of heightened psychosocial stress',
  'described a contracted social network that provides inconsistent support, with limited reciprocal exchange of emotional validation and practical assistance when needed',
  'identified at least one reliable support figure within the immediate family system, though broader community and peer-level support appeared insufficient for current functional needs',
  'reported utilizing family connections as the primary source of emotional support, with limited engagement in peer networks or community-based social and recreational activities',
  'demonstrated awareness of the importance of social support while reporting significant barriers to accessing and maintaining supportive interpersonal relationships',
  'described reliance on a single primary support person, creating an asymmetric support dynamic that may place excessive burden on that relational resource over time',
  'reported that cultural norms around stoicism and self-reliance have historically limited willingness to seek and accept social support from available resources',
  'described social isolation as a current concern, with reduced participation in group activities, peer interactions, and community-level social engagement',
  'identified peer support and shared recreational activities as potentially protective factors, though current barriers limit consistent access to these resources',
  'reported that existing social support, while valued, does not consistently meet emotional and practical support needs, resulting in residual feelings of isolation and loneliness',
  // derived from StressLevelDataset.csv — social_support scale
  'endorsed low perceived social support across relational domains, with limited availability of persons who can provide consistent emotional validation and practical assistance',
  // derived from Philippine NSMHW Report — community support systems context
  'reported limited engagement with community-based mental health resources and support groups, reflecting the broader challenge of under-resourced community mental health infrastructure in the Philippine context',
];

// ─── NEURODEVELOPMENTAL-SPECIFIC BANKS ────────────────────────────────────────

const ADAPTIVE_BEHAVIOR_OBS = [
  'demonstrated age-appropriate self-care and independent living skills as reported by caregiver, with functional competencies generally consistent with developmental expectations across key adaptive domains',
  'showed emerging adaptive behavior competencies, with identified support needs in organizational planning, time management, and community-based participation domains',
  'demonstrated variability in adaptive functioning across settings, with stronger performance in familiar structured environments compared to novel or unstructured contexts',
  'exhibited functional independence in basic self-care domains, though caregiver-reported support needs were identified for complex multi-step tasks and independent community navigation',
  'caregiver-reported adaptive behavior profile suggested relative strengths in social reciprocity and daily routine adherence, alongside areas of challenge in executive and organizational domains',
  'demonstrated adequate functional self-care skills within familiar home routines, with greater support needs reported for generalization of adaptive skills to novel community contexts',
  'showed age-appropriate daily living competencies in foundational domains, with emerging skills in community participation that required continued scaffolding and guided practice',
  'reported adaptive behavior profile reflects a mixed pattern of strengths and challenges, with caregiver support currently compensating for identified deficits in organizational and sequential task domains',
  // derived from StudentPerformanceFactors.csv — learning_disabilities and tutoring_sessions fields
  'caregiver reported history of learning difficulties with prior tutoring support, suggesting adaptive strategies have been developed to accommodate the identified academic profile',
];

const COMMUNICATION_OBS = [
  'demonstrated age-appropriate receptive language comprehension, with expressive language showing some reduction in spontaneous complexity and narrative elaboration',
  'exhibited functional pragmatic communication skills in structured contexts, though spontaneous conversational initiation and topic maintenance appeared variable across the evaluation',
  'showed intact comprehension of instructions and direct questions, with expressive language marked by occasional word retrieval pauses and reduced narrative coherence',
  'demonstrated adequate functional communication for the assessment context, with observable differences in communication style across familiar and unfamiliar conversational topics',
  'caregiver report indicated a communication profile consistent with developmental variation, with relative strengths in comprehension compared to expressive and pragmatic language domains',
  'demonstrated literal language comprehension with limited evidence of inferential or figurative language processing, consistent with an observed concrete cognitive style',
  'showed adequate communication for basic social exchange, with greater difficulty sustaining extended discourse, managing conversational repair, and taking the perspective of the listener',
  'demonstrated communication profile reflecting strengths in structured, context-supported exchanges alongside challenges in open-ended, pragmatically complex communicative contexts',
];

const SENSORY_OBS = [
  'caregiver reported behavioral responses consistent with sensory processing differences, particularly in auditory and tactile domains, affecting participation in daily and community activities',
  'demonstrated observable sensory sensitivity to environmental stimuli during the evaluation, including heightened responsiveness to ambient auditory stimuli and physical proximity',
  'reported patterns of sensory-seeking and sensory-avoidant behavior across domains, consistent with an atypical sensory processing profile affecting comfort and environmental adaptability',
  'caregiver endorsed sensory processing challenges that impact participation in group settings, transitions between environments, and responses to novel sensory exposures',
  'demonstrated adaptive sensory management strategies in familiar contexts, though generalization to novel sensory environments appeared limited without external support',
  'sensory reactivity profile as reported by caregiver suggested hyper-responsiveness to specific sensory domains requiring ongoing environmental accommodation and behavioral support',
  'showed behavioral regulatory challenges in sensory-demanding environments, with observable discomfort in crowded, noisy, or unpredictable sensory contexts',
  'caregiver-reported sensory processing differences appear to contribute to behavioral dysregulation patterns observed in transitions, group participation, and novel environmental demands',
];

const ACADEMIC_OBS = [
  'demonstrated academic functioning profile marked by variable performance across subjects, with greater relative competency in areas aligned with documented learning strengths',
  'reported academic performance challenges that appeared related to identified attentional and motivational factors rather than limited intellectual capacity',
  'exhibited reduced academic engagement and learning motivation, with caregiver-reported decline in school performance corroborated by behavioral observations during the evaluation',
  'showed academic functional profile consistent with learning support needs, with identified areas of relative strength that can be leveraged in individualized educational planning',
  'demonstrated patterns of academic underperformance that appeared attributable to systemic factors including attendance irregularities, limited study resource access, and elevated stress burden',
  // derived from StudentPerformanceFactors.csv — hours_studied, attendance, previous_scores, exam_score fields
  'caregiver and self-report data indicated reduced study hours and attendance irregularities as contributing factors to observed academic performance concerns',
  'exhibited academic functioning below reported prior attainment levels, with identified peer influence and extracurricular competing demands as potential moderating factors',
];

// ─── PRE-EMPLOYMENT-SPECIFIC BANKS ────────────────────────────────────────────

const OCCUPATIONAL_OBS = [
  'demonstrated task-focused behavioral orientation and systematic problem-solving approach during structured work-analogue tasks presented throughout the evaluation',
  'exhibited behavioral consistency and methodical work style during the assessment, with observable preference for structured environments and clearly defined performance expectations',
  'showed adequate role-following behavior and compliance with procedural instructions, suggesting functional capacity for structured occupational demands in supervised contexts',
  'demonstrated professional presentation and appropriate behavioral responsiveness in the evaluative context, consistent with basic occupational role expectations',
  'exhibited variable task persistence across assessment conditions, maintaining consistent effort on preferred task types but showing reduced engagement with ambiguous or open-ended demands',
  'showed capacity for sustained work engagement within time-bounded tasks, with organized and sequential approach to task completion across the evaluation context',
  'demonstrated adequate occupational readiness indicators including punctuality, appropriate attire, and compliance with assessment procedures, suggestive of functional employment orientation',
  'exhibited structured problem-solving behavior and ability to self-organize within clearly defined task parameters, consistent with readiness for supervised occupational placement',
  // derived from Employee Attrition datasets — job_satisfaction and job_involvement fields
  'demonstrated behavioral indicators suggestive of appropriate occupational engagement and role-relevant motivation, with observable investment in the evaluative process',
  'exhibited functional occupational orientation consistent with adequate job involvement, though areas for growth in autonomous task management and self-directed performance were noted',
];

const INTERPERSONAL_OBS = [
  'demonstrated professional and appropriately courteous interpersonal presentation throughout the evaluation, with responsive communication style toward the examiner',
  'exhibited generally adequate interpersonal skills in the structured assessment context, though limited spontaneous social initiation suggested reduced proactivity in peer-level interactions',
  'showed capacity for cooperative and collaborative behavioral orientation in structured dyadic interaction, with performance variability under ambiguous or unstructured interpersonal conditions',
  'demonstrated awareness of interpersonal boundaries and professional norms in the evaluation context, with appropriate deference and turn-taking in communicative exchanges',
  'exhibited variable interpersonal warmth across the session, demonstrating greater social comfort in task-oriented exchanges and increased behavioral guardedness in open-ended social contexts',
  'demonstrated functional interpersonal skills including basic perspective-taking, appropriate affective responsiveness, and adherence to conversational norms in the evaluation context',
  'showed polite and cooperative interpersonal style throughout the assessment, with evident capacity for role-appropriate interaction within structured professional contexts',
  'demonstrated interpersonal profile reflecting adequate relational skills for workplace contexts, with noted areas for development in unsolicited social initiation and unstructured peer interaction',
  // derived from IBM HR Analytics and Employee Attrition datasets — relationship_satisfaction field
  'exhibited relationship-oriented interpersonal style with moderate social initiative, consistent with capacity for functional collegial engagement within a structured workplace environment',
  'demonstrated interpersonal flexibility appropriate for team-based environments, though preference for clear role definition and procedural clarity was noted throughout the evaluation',
];

const WORK_LIFE_BALANCE_OBS = [
  // derived from HR-Employee-Attrition.csv and Employee Attrition CSVs — WorkLifeBalance and OverTime fields
  'reported difficulties maintaining a sustainable balance between occupational demands and personal recovery time, with associated impact on energy, mood, and interpersonal functioning',
  'demonstrated awareness of work-life boundary challenges, with self-reported tendency to prioritize occupational demands over personal self-care and social engagement',
  'endorsed experiencing role overload during peak demand periods, with observable impact on motivation, concentration, and emotional resilience reported during the clinical interview',
  'described patterns of occupational stress spillover into personal domains, with reduced quality of leisure time and personal relationships noted as current concerns',
  'reported adequate management of occupational and personal demands under baseline conditions, though resilience under sustained high-demand periods was identified as an area for development',
];

// ─── SAFETY RISK BANKS ───────────────────────────────────────────────────────
// (X-RK-00, X-RK-LOW from Narrative Fragment Library; content from Suicide_Detection.csv context)

const RISK_ELEVATED_OBS = [
  'The client currently presents with significant psychological risk factors, including reported thoughts of self-harm. This presentation warrants immediate clinical attention and active safety planning.',
  'Clinical interview and behavioral observation revealed risk indicators that require urgent assessment and intervention by a licensed clinician. A safety plan should be established without delay.',
  'Elevated risk indicators were identified during the current evaluation, including statements or behavioral patterns consistent with self-directed harm. Immediate follow-up and safety planning are clinically indicated.',
];

const RISK_NONE_OBS = [
  'No active indicators of risk to self or others were elicited during the present assessment. Routine monitoring is recommended as part of ongoing clinical care.',
  'Safety screening conducted during the evaluation did not reveal active indicators of suicidal ideation, self-harm, or harm to others. Continued monitoring is encouraged.',
  'The current assessment did not identify active risk indicators. Protective factors including identified social support and help-seeking behavior were noted.',
];

// ─── NARRATIVE SECTION LEADS ──────────────────────────────────────────────────

const NEURO_FINDINGS_LEAD = [
  'Taken together, the behavioral and developmental observations gathered during this neurodevelopmental assessment provide a qualitative basis for clinical impression.',
  'Integration of the developmental history, direct behavioral observations, and clinical interview yields the following overall impression for this neurodevelopmental evaluation.',
  'The observational findings from this neurodevelopmental assessment, considered alongside background developmental history, are summarized below.',
];

const CLINICAL_FINDINGS_LEAD = [
  'Integrating the affective, behavioral, and psychosocial observations from this clinical psychological assessment, the following clinical impression is offered.',
  'The clinical observations and interview findings for this assessment, when considered within the context of the presenting concerns, support the following impression.',
  'Based on direct clinical observation and structured interview, the overall clinical impression for this evaluation is as follows.',
];

const PRE_EMP_FINDINGS_LEAD = [
  'The behavioral and cognitive observations recorded during this pre-employment psychological evaluation are summarized in the following overall impression.',
  'Integrating observations of cognitive functioning, interpersonal style, and behavioral consistency, the following employment-relevant impression is offered.',
  'The following overall impression is derived from behavioral observation, clinical interview, and administered assessment procedures relevant to occupational functioning.',
];

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
  const push = (section, text) => frags.push({ section, text });

  // ── SAFETY OVERRIDE — evaluated FIRST across ALL assessment types ─────────
  // (Rules: X-RK-00, X-RK-01, X-RC-CRISIS, X-RK-LOW)
  const riskElevated =
    cs.risk_flag === 'ELEVATED' ||
    ns.risk_flag === 'ELEVATED' ||
    es.risk_flag === 'ELEVATED';

  if (riskElevated) {
    push('risk', RISK_ELEVATED_OBS[0]);
    if (cs.mental_health_history === 'Yes' || ns.mental_health_history === 'Yes') {
      // X-RK-01
      push('risk', 'A prior history of psychological difficulty further increases vulnerability during periods of acute stress.');
    }
    // X-RC-CRISIS
    push('recommendations_safety',
      'Establish a safety plan addressing emotional triggers, coping strategies, and emergency support contacts. ' +
      'Connect immediately with crisis resources including the NCMH Crisis Hotline (1553), the DOH iCare Hotline (1800-10-HOPEPH), ' +
      'or the nearest licensed mental health facility. This is a clinical priority.'
    );
  } else {
    // X-RK-LOW
    push('risk', RISK_NONE_OBS[0]);
  }

  // ── CLINICAL ASSESSMENT RULES ─────────────────────────────────────────────
  if (ttype === 'clinical') {

    // C-EF-01: depression = severe
    if (cs.depression === 'severe') {
      push('emotional_functioning',
        `${name} exhibits severe emotional distress characterized by persistent low mood, emotional exhaustion, and a pervasive loss of interest in usual activities.`
      );
    }
    // C-EF-02: depression = moderate
    else if (cs.depression === 'moderate') {
      push('emotional_functioning',
        `${name} presents with marked depressive features, including frequent low mood, reduced motivation, and diminished enjoyment of daily activities.`
      );
    }
    // mild depression — non-library supplemental
    else if (cs.depression === 'mild') {
      push('emotional_functioning',
        `${name} reports some degree of low mood and reduced pleasure in daily activities, with functional impact that is mild but observable in the clinical context.`
      );
    }

    // C-EF-03: anxiety ≥ moderate
    if (cs.anxiety_level === 'moderate' || cs.anxiety_level === 'severe') {
      push('emotional_functioning',
        `${name} reported notable anxiety, accompanied by overthinking, restlessness, and difficulty calming once distressed.`
      );
    }

    // C-EF-04: sleep_quality = low
    if (cs.sleep_quality === 'low') {
      push('emotional_functioning',
        `${name} described irregular sleep and difficulty maintaining restful sleep, which appears to compound existing emotional exhaustion.`
      );
    }

    // C-EF-05: self_esteem = low
    if (cs.self_esteem === 'low') {
      push('emotional_functioning',
        `There are indications of low self-esteem and self-critical thinking, with ${name} frequently describing personal capabilities in negative terms.`
      );
    }

    // C-EF-06: history = Yes AND depression ≥ moderate
    if (cs.mental_health_history === 'Yes' &&
        (cs.depression === 'moderate' || cs.depression === 'severe')) {
      push('emotional_functioning',
        'These difficulties appear longstanding rather than situational, consistent with a recurrent rather than first-onset presentation.'
      );
    }

    // C-SF-01: social_support = low
    if (cs.social_support === 'low') {
      push('social_functioning',
        `${name} experiences significant difficulties in social and interpersonal functioning, particularly in forming and maintaining stable, supportive relationships.`
      );
    }
    // C-SF-02: social_support = moderate
    else if (cs.social_support === 'moderate') {
      push('social_functioning',
        `${name} maintains some meaningful connections but at times feels emotionally unsupported or misunderstood by those around them.`
      );
    }

    // C-SF-03: bullying = high OR peer_pressure = high
    if (cs.bullying === 'high' || cs.peer_pressure === 'high') {
      push('social_functioning',
        'Experiences of peer conflict and social pressure appear to have contributed to feelings of insecurity and guardedness in interpersonal interactions.'
      );
    }

    // C-DM-01: coping = avoidant
    if (cs.coping === 'avoidant') {
      push('defense_mechanisms',
        `${name} primarily relies on avoidance and emotional withdrawal when faced with distress, distancing rather than directly confronting difficulties.`
      );
    }
    // C-DM-02: coping = suppression-then-release
    else if (cs.coping === 'suppression') {
      push('defense_mechanisms',
        'There are indications of emotional overcontrol followed by impulsive release, in which suppressed feelings surface abruptly during periods of overwhelm.'
      );
    }

    // C-DM-03: insight present AND change_readiness low
    if (cs.insight === 'present' && cs.change_readiness === 'low') {
      push('defense_mechanisms',
        `Although ${name} demonstrates self-awareness and insight, there may be difficulty translating this insight into consistent behavioral change during emotionally intense situations.`
      );
    }

    // C-CI-01: depression = severe AND history = Yes
    if (cs.depression === 'severe' && cs.mental_health_history === 'Yes') {
      push('clinical_impression',
        `${name} presents with symptoms consistent with a recurrent depressive presentation, marked by chronic low mood, guilt, and emotional exhaustion.`
      );
    }

    // C-CI-02: instability + fear_of_abandonment + impulsivity
    if (cs.emotional_instability === 'present' &&
        (cs.fear_of_abandonment === 'present' || cs.impulsivity === 'present')) {
      push('clinical_impression',
        'The presentation is also consistent with significant emotional dysregulation and interpersonal sensitivity, particularly around situations involving rejection or conflict.'
      );
    }

    // C-CI-FOOTER: always
    push('clinical_impression',
      'Further evaluation by a licensed clinician is warranted to confirm impressions and rule out co-occurring conditions.'
    );

    // C-RC-01: always
    push('recommendations_fragment',
      'Engage in regular psychotherapy with a licensed psychologist, with emphasis on emotion regulation and distress tolerance.'
    );
    // C-RC-03: sleep_quality = low
    if (cs.sleep_quality === 'low') {
      push('recommendations_fragment',
        'Adopt sleep-hygiene strategies and a consistent routine to support emotional stability.'
      );
    }
    // C-RC-04: social_support = low
    if (cs.social_support === 'low') {
      push('recommendations_fragment',
        'Strengthen supportive relationships and consider structured peer or family support where appropriate.'
      );
    }
    // Philippine RA 11036 alignment
    push('recommendations_fragment',
      'Referral to a licensed Filipino mental health professional is encouraged, in alignment with the Philippine Mental Health Act (RA 11036). ' +
      'Community-based mental health programs through the local government unit (LGU) may also be explored as accessible support resources.'
    );
  }

  // ── NEURODEVELOPMENTAL ASSESSMENT RULES ───────────────────────────────────
  if (ttype === 'neurodevelopmental') {

    // N-ED-01: early_milestones = delayed
    if (ns.early_milestones === 'delayed') {
      push('early_development',
        'Early developmental history reflects delays across communication and self-help skills, with prior involvement in developmental support services.'
      );
    }
    // N-ED-02: prior_assessment = Yes
    if (ns.prior_assessment === 'Yes') {
      push('early_development',
        `${name} has a history of earlier developmental assessment and intervention, providing useful continuity for the present evaluation.`
      );
    }

    // N-TR-01: overall_cognition = below-age
    if (ns.overall_cognition === 'below-age') {
      push('test_results_fragment',
        'Overall cognitive functioning appears to fall below age-level expectations, with corresponding difficulty across reasoning and knowledge-based tasks.'
      );
    }
    // N-TR-02: visual_spatial = relative_strength
    if (ns.visual_spatial === 'relative_strength') {
      push('test_results_fragment',
        'Visual-spatial processing emerged as a relative strength, indicating a comparatively better ability to work with visual information.'
      );
    }
    // N-TR-03: working_memory = weak
    if (ns.working_memory === 'weak') {
      push('test_results_fragment',
        'Working memory presents as an area of significant difficulty, affecting tasks that require holding and manipulating information over short periods.'
      );
    }
    // N-TR-04: knowledge = weak
    if (ns.knowledge === 'weak') {
      push('test_results_fragment',
        'Accumulated knowledge and vocabulary appear notably below expectations relative to same-age peers.'
      );
    }

    // N-AF-01: global_adaptive = low
    if (ns.global_adaptive === 'low') {
      push('adaptive_functioning',
        `Adaptive functioning appears low overall, with ${name} requiring support across communication, self-direction, and daily living skills.`
      );
    }
    // N-AF-02: communication = limited
    if (ns.communication === 'limited') {
      push('adaptive_functioning',
        'Communication skills are limited and represent a priority area for continued intervention.'
      );
    }

    // N-SI-01: composite below-age + adaptive low
    if (ns.overall_cognition === 'below-age' && ns.global_adaptive === 'low') {
      push('summary_impression',
        `Present findings are consistent with a neurodevelopmental profile marked by below-age cognitive and adaptive functioning, with relative strengths that can be leveraged in intervention.`
      );
    }
    // N-SI-FOOTER: always
    push('summary_impression',
      'Continued multidisciplinary support and periodic re-assessment are warranted to track developmental progress.'
    );

    // N-RC-01: always
    push('recommendations_fragment',
      `Continue individualized educational support tailored to ${name}'s developmental level and learning needs.`
    );
    // N-RC-02: communication = limited
    if (ns.communication === 'limited') {
      push('recommendations_fragment',
        'Resume or continue speech and language support to strengthen communication skills.'
      );
    }
    // N-RC-03: adaptive low
    if (ns.global_adaptive === 'low') {
      push('recommendations_fragment',
        'Incorporate structured adaptive-skills training focused on daily living and self-direction.'
      );
    }
    // N-RC-04: parental_involvement = low
    if (ns.parental_involvement === 'low') {
      push('recommendations_fragment',
        'Strengthen caregiver involvement and home-based reinforcement of target skills.'
      );
    }
  }

  // ── PRE-EMPLOYMENT ASSESSMENT RULES ──────────────────────────────────────
  if (ttype === 'pre_employment') {

    // E-OR-01: reasoning = adequate
    if (es.reasoning === 'adequate') {
      push('overall_results_fragment',
        `${name} demonstrates good verbal and basic reasoning skills suited to routine, structured tasks.`
      );
    }
    // E-OR-02: organization = low
    if (es.organization === 'low') {
      push('overall_results_fragment',
        `While able to plan tasks at a basic level, lower self-directed organization and follow-through may make it difficult for ${name} to manage multiple competing demands.`
      );
    }
    // E-OR-03: WorkLifeBalance = poor OR OverTime = Yes
    if (es.WorkLifeBalance === 'poor' || es.OverTime === 'Yes') {
      push('overall_results_fragment',
        'Balancing overlapping responsibilities can at times be overwhelming, representing an area for growth and enrichment.'
      );
    }
    // E-OR-04: emotional_stability = low
    if (es.emotional_stability === 'low') {
      push('overall_results_fragment',
        `When personal concerns overlap with rising workplace demands, ${name} may be prone to anxiety and reduced focus that can temporarily affect confidence and composure.`
      );
    }
    // E-OR-05: EnvironmentSatisfaction = high
    if (es.EnvironmentSatisfaction === 'high') {
      push('overall_results_fragment',
        `Performance and professional stability are closely tied to ${name} operating within a structured, predictable routine under supportive leadership.`
      );
    }

    // E-IC-FIT / E-IC-CONSIDER / E-IC-NOTREC
    const fit = es.fit_level || 'fit_with_considerations';
    if (fit === 'fit') {
      push('impression_conclusion_fragment',
        `${name} possesses adequate capabilities for the role and can maintain consistent performance within a predictable work environment under supportive supervision.`
      );
      push('fit_recommendation',
        `There is no significant psychopathology noted at the time of examination; ${name} appears fit for employment.`
      );
    } else if (fit === 'not_recommended') {
      push('impression_conclusion_fragment',
        `Present findings indicate significant concerns that should be addressed before a determination of employment suitability for ${name} can be confidently made.`
      );
      push('fit_recommendation',
        `Based on present findings, ${name} is not recommended for the role at this time pending further evaluation and support.`
      );
    } else {
      // fit_with_considerations — default
      push('impression_conclusion_fragment',
        `${name} demonstrates workable capabilities for routine tasks but may require structure and clear expectations to sustain focus and composure under heavier workloads.`
      );
      push('fit_recommendation',
        `${name} appears fit for employment, with the consideration that a structured and supportive work setting will best sustain performance.`
      );
    }

    // Attrition risk flag
    if (es.attrition_risk === 'ELEVATED') {
      push('overall_results_fragment',
        'Occupational engagement indicators suggest the presence of factors associated with elevated attrition risk, including limited perceived recognition and reduced environmental satisfaction. ' +
        'These factors warrant consideration in role assignment and onboarding planning.'
      );
    }
  }



  return frags;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. RECOMMENDATION POOLS
//    Expanded with Philippines-context references, dataset-derived patterns,
//    and RA 11036 alignment.
// ─────────────────────────────────────────────────────────────────────────────

const NEURO_REC_POOL = [
  'Coordinate findings with the educational team, caregivers, and relevant specialists to develop a consistent and responsive support plan.',
  'Consider individualized educational or developmental support strategies tailored to the observed profile of strengths and challenges.',
  'Pursue functional assessment across home and school environments to provide a more comprehensive developmental picture.',
  'Reassessment is recommended within 12–18 months, or sooner if significant developmental changes or regression are observed.',
  'Psychoeducation for caregivers regarding the observed behavioral patterns is strongly encouraged to promote consistent environmental management.',
  'Consider referral to related services (e.g., speech-language therapy, occupational therapy) based on observed functional domains of concern.',
  'Regular monitoring by a developmental pediatrician or allied health professional is recommended to track progress over time.',
  'Establish structured home routines with predictable schedules and clear behavioral expectations to support adaptive functioning and reduce transition-related dysregulation.',
  'Encourage participation in social skills development programs or peer-mediated learning environments to support pragmatic and relational competency.',
  'Provide sensory-supportive accommodations in home and school environments as appropriate to the identified sensory processing profile.',
  'Collaborate with school personnel to develop and implement individualized educational accommodations or modifications that address the identified functional profile.',
  'Caregiver training on evidence-based behavioral management strategies and developmental scaffolding techniques is recommended to promote consistent support across settings.',
  'Consider referral for psychological support services to address emotional and behavioral regulation challenges that may be associated with the observed developmental profile.',
  'Maintain open communication among the family system, educational team, and treating clinicians to ensure responsive adjustment of support strategies as developmental needs evolve.',
  // derived from StudentPerformanceFactors.csv — parental_involvement and tutoring_sessions data
  'Encourage strengthened parental or caregiver involvement in academic support and home-based learning reinforcement, given the documented association between parental engagement and academic outcomes.',
  // Philippine NSMHW context
  'Explore access to community-based tutoring and educational support resources, particularly for families with limited access to private supplemental instruction.',
];

const CLINICAL_REC_POOL = [
  'Individual psychotherapy is recommended to address the observed emotional and behavioral concerns within a structured therapeutic relationship.',
  'Psychoeducation regarding the observed stress indicators and coping patterns is recommended as a first-line supportive intervention.',
  'A structured routine incorporating regular sleep, physical activity, and social engagement may support emotional regulation and overall functioning.',
  'Consider a psychiatric consultation if observed affective and somatic patterns persist or intensify beyond the current level of functioning.',
  'Monitor symptom trajectory over the next 3–6 months and reassess if functional impairment in daily activities increases.',
  'Encourage development of a diversified coping repertoire, including adaptive strategies such as mindfulness, social support, and structured problem-solving.',
  'Family or systems-level support may benefit the client, particularly where relational stressors are contributing to the presenting concerns.',
  'Referral to a licensed Filipino mental health professional familiar with culturally informed therapeutic approaches is encouraged, in alignment with the Philippine Mental Health Act (RA 11036).',
  'Sleep hygiene intervention is recommended, including structured bedtime routines, reduction of stimulant exposure prior to sleep, and regularization of the sleep-wake schedule.',
  'Social support mobilization — including reconnection with family, peer, and community networks — is recommended as an adjunct to individual therapeutic intervention.',
  'Appetite and nutritional self-care should be monitored and addressed within the therapeutic frame, given the observed association between eating disruptions and psychosocial stress.',
  'Engagement in meaningful purposeful activity — including vocational, recreational, or community-based participation — is encouraged to support motivational engagement and sense of personal agency.',
  'Crisis safety planning should be discussed in the therapeutic context if the clinical picture includes any risk indicators, in accordance with BPS and PAP clinical safety standards.',
  'Regular review of therapeutic progress is recommended at 3-month intervals, with reassessment of functional domains including mood, sleep, appetite, concentration, and interpersonal engagement.',
  // Philippine NSMHW Report and RA 11036 alignment
  'Connection with available community mental health resources is encouraged, including LGU-based mental health programs aligned with the Philippine Mental Health Act (RA 11036).',
  'Referral to the National Center for Mental Health (NCMH) or affiliated regional mental health services is recommended if access to private therapeutic services is limited.',
  'Psychoeducation regarding mental health stigma and the importance of help-seeking is recommended for the client and immediate family, consistent with NSMHW public awareness objectives.',
  // derived from Indicators_of_Anxiety_or_Depression CSV — anhedonia/withdrawal pattern
  'Behavioral activation strategies targeting gradual re-engagement with previously valued activities are recommended to address identified anhedonia and withdrawal patterns.',
];

const PRE_EMP_REC_POOL = [
  'Findings should be interpreted within the full context of the applicant\'s background, work history, and the specific demands of the target role.',
  'Continued behavioral observation during a structured onboarding or probationary period is advised to corroborate assessment impressions.',
  'If placed, provide structured orientation and clear performance expectations to support initial role adjustment.',
  'Assign a designated peer or mentor during the initial employment phase to support social integration and role clarity.',
  'Periodic check-ins with a supervisor or HR representative are recommended during the first six months of employment.',
  'Consider role-specific fit when assigning initial responsibilities, prioritizing tasks aligned with observed cognitive and behavioral strengths.',
  'Re-evaluation may be conducted if significant role demands change or if occupational performance concerns arise post-placement.',
  'Findings from this psychological evaluation should supplement — and not replace — other evidence-based selection criteria in the final placement decision.',
  'An initial trial placement in a supervised, structured role environment is recommended prior to assignment to high-autonomy or high-complexity responsibilities.',
  'Employee wellness resources, including access to Employee Assistance Programs (EAP) or occupational health support, are encouraged to maintain the applicant\'s psychological wellbeing post-placement.',
  'Strengths identified during this evaluation should be leveraged in initial role assignment to support early confidence-building and positive performance experience.',
  'Communication style preferences and interpersonal behavioral patterns observed during evaluation should inform the onboarding supervisor\'s approach to initial role coaching and feedback delivery.',
  'If occupational adjustment difficulties are observed post-placement, early referral to occupational health or employee counseling resources is recommended rather than extended performance management.',
  'Team integration activities and structured social onboarding are recommended to support the applicant\'s interpersonal adjustment to the assigned work group.',
  // derived from Employee Attrition datasets — attrition risk factors (WorkLifeBalance, recognition, environment)
  'Attention to work-life balance, perceived fairness of recognition, and career development opportunities is recommended as part of the onboarding experience to reduce early attrition risk.',
  'Consider the applicant\'s job satisfaction and environmental fit indicators when determining role assignment, given the documented relationship between environment satisfaction and occupational retention.',
];

// ─────────────────────────────────────────────────────────────────────────────
// 6. THEME DETECTION & THEME-AWARE NARRATIVE SELECTION
//    Analyzes all clinician-provided text to detect which clinical themes are
//    present. Only observation banks matching detected themes are drawn from,
//    ensuring generated narratives reflect only what was documented in the input.
//    Datasets remain as the narrative knowledge repository — never referenced
//    in output, only used to select appropriate professional phrasing.
// ─────────────────────────────────────────────────────────────────────────────

function _detectThemes(text) {
  const t = (text || '').toLowerCase();
  const has = (re) => re.test(t);
  return {
    mood:            has(/\b(mood|moody|sad|tearful|flat|subdued|blunt|low mood|crying|upset|grief|despair|withdrawn)\b/),
    anxiety:         has(/\b(anxi|worry|worri|nervous|apprehens|restless|tense|tension|overthink|panic|phobia|dread|fearful)\b/),
    depression:      has(/\b(depress|hopeless|worthless|empty|anhedoni|numb|pleasure|unmotivat|helpless|low mood|despair)\b/),
    attention:       has(/\b(attent|focus|distract|concentrat|impuls|hyperactiv|inattent|sustain|off.task|daydream|wander|redirect)\b/),
    sleep:           has(/\b(sleep|insomni|fatigue|tired|exhaust|nighttime|wakening|waking|drowsy|bedtime|rest)\b/),
    appetite:        has(/\b(appetite|eating|food|weight|hunger|meal|nutrition|binge|undereating|overeating)\b/),
    social:          has(/\b(social|peer|friend|relation|interact|isolat|lonely|loneliness|belong|connect|withdrew|avoidance)\b/),
    coping:          has(/\b(coping|cope|avoidance|suppress|overwhelm|manage|resilience|stressor)\b/),
    selfEsteem:      has(/\b(self.esteem|self.worth|self.concept|worthless|inadequate|inferior|self.criti|confidence|self.doubt)\b/),
    emotion:         has(/\b(emotion|affect|dysregulat|labile|reactive|irritable|frustrat|anger|outburst|temper|impulsi)\b/),
    cognitive:       has(/\b(cognitive|thinking|reasoning|memory|intellectual|comprehension|processing|problem.solv|abstract|concept)\b/),
    stress:          has(/\b(stress|pressure|burden|demand|strain|workload|overwhelm)\b/),
    psychosocial:    has(/\b(family|relational|financial|economic|community|domestic|stressor|life event|caregiver|parent)\b/),
    motivation:      has(/\b(motivat|initiative|amotivat|anhedoni|interest|engag|effort|driven|goal|aspir)\b/),
    socialSupport:   has(/\b(support|network|isolat|alone|nobody|friend|family|connect|resource|help-seeking)\b/),
    adaptive:        has(/\b(adaptive|daily living|self.care|independent|self.help|routine|transition|organiz|chore|hygiene)\b/),
    communication:   has(/\b(communication|language|speech|expressive|receptive|pragmatic|vocabulary|verbal|articulation|fluency)\b/),
    sensory:         has(/\b(sensory|tactile|auditory|visual|texture|hyper.sensitiv|hypo.sensitiv|sensory.seek|sensory.avoid)\b/),
    academic:        has(/\b(academic|school|learning|study|grade|achievement|class|exam|homework|tutoring|reading|writing|math)\b/),
    occupational:    has(/\b(work|job|occupational|employment|workplace|role|productivity|career|professional|deadline|task)\b/),
    workLife:        has(/\b(work.life|overtime|burnout|overwork|balance|personal time|recovery|off.hours)\b/),
    interpersonal:   has(/\b(colleague|coworker|team|supervisor|manager|workplace.relat|conflict|professional)\b/),
    // Targeted patterns for IF-THEN rule bridging
    priorHistory:    has(/(history of|prior (treatment|episode|counsel|therapy|assess|evaluat)|previous (counsel|therapy|treatment|episode|assess)|past (mental|psych|treatment|counsel|episode)|recurrent|longstanding)/),
    developDelay:    has(/(developmental.*(delay|concern|history|milestone)|delay.*(develop|milestone|speech|motor|language)|milestone.*(delay|concern|not.*met|behind))/),
    knowledgeWeak:   has(/((limited|below|weak|poor|significantly reduced).*(vocabulary|knowledge|fund of|verbal ability)|(vocabulary|knowledge|fund of info).*(limited|below|weak|poor|below.expect))/),
    organizationDiff:has(/(disorganized|poor.*(organiz|time management)|difficulty.*(organiz|prioriti|plan|schedul)|lack.*(organiz|structure|focus.*task)|struggled.*(manag|follow.through))/),
    attritionRisk:   has(/(resign|quit|leav.*(job|work|position)|turnover|attrition|dissatisf.*(work|job)|consider.*leaving|looking.*(other|new).*(opportunit|job|position)|lack.*engagement.*work)/),
  };
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

    return output;
  },
};

module.exports = RuleEngine;
