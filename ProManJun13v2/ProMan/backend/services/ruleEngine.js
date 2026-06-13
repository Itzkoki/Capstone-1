/**
 * Rule-Based Narrative Generation Engine
 * ---------------------------------------------------------------------------
 * Generates clinical narrative interpretations purely from OBSERVATIONAL data.
 *
 * Neurodevelopmental, clinical, and pre-employment reports are all generated
 * the same way: from the tests administered and the observational, behavioral,
 * and interview notes. No assessment-measure scoring, score bands, percentiles,
 * or scored findings tables are produced — narratives are observation-based.
 */

// ── Engine ──────────────────────────────────────────────────────────
const RuleEngine = {
  /**
   * Validate the assessment data.
   * Observation-based reports impose no numeric score bounds, so this always
   * succeeds. Kept for API compatibility with the controller.
   * @returns {{ valid: boolean, errors: string[] }}
   */
  validateAssessment(/* assessmentData, report */) {
    return { valid: true, errors: [] };
  },

  // Deterministic-but-rotating picker: a different genIndex yields a different
  // choice, so each successive generation differs from the previous one.
  _pick(arr, genIndex, salt = 0) {
    if (!arr.length) return '';
    const i = (((genIndex + salt) % arr.length) + arr.length) % arr.length;
    return arr[i];
  },

  // Lower-case the first character of a snippet so it reads naturally mid-sentence.
  _lower1(s) {
    const t = String(s || '').trim();
    return t ? t.charAt(0).toLowerCase() + t.slice(1) : t;
  },

  /**
   * Generate the three report sections from observational data.
   * @returns {Array} [{ key, title, content }]
   */
  generate(assessmentData, report, genIndex = 0) {
    const name = (report && report.client_name) || 'The examinee';
    const tests = (assessmentData && assessmentData.tests_administered) || [];
    const obsNotes  = (assessmentData && assessmentData.observational_notes || '').trim();
    const behObs    = (assessmentData && assessmentData.behavioral_observations || '').trim();
    const interview = (assessmentData && assessmentData.interview_findings || '').trim();

    // ── Section 1: Test Results and Interpretation ──
    // An observation-based summary: which instruments/procedures were used, and
    // the qualitative data gathered. No scores are reported or interpreted.
    const intros = [
      `${name} was assessed through clinical observation, behavioral observation, and interview. The results are interpreted below in light of the referral concern and the qualitative data gathered.`,
      `The following interpretation summarizes the observations recorded for ${name} during the assessment, considered alongside the behavioral and interview data.`,
      `Assessment results for ${name} are presented below, based on direct observation and interview rather than standardized scoring.`,
    ];
    const trParts = [this._pick(intros, genIndex, 0)];
    if (tests.length) {
      const lead = this._pick(
        ['Procedures and instruments used included', 'The assessment comprised', 'Methods used in this evaluation included'],
        genIndex, 3
      );
      trParts.push(`${lead}: ${tests.join(', ')}.`);
    }
    if (obsNotes)  trParts.push(`Observational notes: ${obsNotes}`);
    if (behObs)    trParts.push(`Behavioral observations: ${behObs}`);
    if (interview) trParts.push(`Interview findings: ${interview}`);
    if (!obsNotes && !behObs && !interview && !tests.length) {
      trParts.push('No observational data was recorded for this assessment.');
    }
    const testResults = trParts.join(' ');

    // ── Section 2: Findings ──
    // A qualitative impression synthesized from the recorded observations.
    let findings;
    const summaryBits = [];
    if (obsNotes)  summaryBits.push(`observational notes indicate ${this._lower1(obsNotes)}`);
    if (behObs)    summaryBits.push(`behavioral observations reflect ${this._lower1(behObs)}`);
    if (interview) summaryBits.push(`interview findings reveal ${this._lower1(interview)}`);
    if (summaryBits.length) {
      const open = this._pick(
        [`Based on the assessment of ${name}, `, `Integrating the available observations, `, `Taken together, the assessment of ${name} shows that `],
        genIndex, 6
      );
      findings = open + summaryBits.join('; ') + '. These observations form the basis of the overall impression and conclusion.';
    } else {
      findings = 'No observational findings were recorded for this assessment.';
    }

    // ── Section 3: Recommendations ──
    // General, observation-driven recommendations (no score-triggered items).
    const recPool = [];
    recPool.push(this._pick([
      'Interpret these observations in the context of the client’s history and presenting concerns.',
      'Consider the recorded observations alongside collateral information from caregivers or other professionals.',
      'Weigh these qualitative findings together with the client’s developmental and educational history.',
    ], genIndex, 1));
    recPool.push(this._pick([
      'Where further clarification is warranted, a follow-up clinical interview or additional observation is recommended.',
      'Additional observation across settings (e.g., home and school) may strengthen the impression.',
      'Further observation over time is advised if questions remain about the presenting concern.',
    ], genIndex, 2));
    recPool.push(this._pick([
      'Share these results with relevant professionals (e.g., teachers, counselors, physician) as appropriate.',
      'Coordinate findings with the client’s support network to align interventions.',
      'Communicate results to involved caregivers and professionals to support a consistent plan.',
    ], genIndex, 4));
    recPool.push(this._pick([
      'Re-evaluation is recommended within 12–24 months, or sooner if significant changes are observed.',
      'Schedule a follow-up assessment within a year to monitor progress.',
      'Plan a review assessment in 12 months to track change over time.',
    ], genIndex, 5));

    // Light rotation of ordering for additional variety between runs.
    const rotated = recPool.slice(genIndex % recPool.length).concat(recPool.slice(0, genIndex % recPool.length));
    const recommendations = rotated.map((r, i) => `${i + 1}. ${r}`).join('\n');

    return [
      { key: 'test_results',    title: 'Test Results and Interpretation', content: testResults },
      { key: 'findings',        title: 'Findings',                        content: findings },
      { key: 'recommendations', title: 'Recommendations',                 content: recommendations },
    ];
  },
};

module.exports = RuleEngine;
