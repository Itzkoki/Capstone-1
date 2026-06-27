/* ─────────────────────────────────────────────────────────────────────────────
 * Phase 0 — Rule-Engine GOLDEN regression test (dependency-free).
 *
 * Locks the CURRENT generated-narrative output so any later refactor (knowledge
 * extraction, theme-detection, thresholds, trace layer) is provably behavior-
 * preserving. The fixtures drive explicit structured signals so that virtually
 * EVERY IF-THEN fragment rule fires, giving broad coverage of the engine.
 *
 *   node test/ruleEngine.golden.js            → compare against the committed golden
 *   node test/ruleEngine.golden.js --update   → (re)write the golden baseline
 *
 * Exit code 0 = identical, 1 = drift (prints which fixture/section differs).
 * ────────────────────────────────────────────────────────────────────────────*/
const fs = require('fs');
const path = require('path');
const RuleEngine = require('../services/ruleEngine');

const GOLDEN = path.join(__dirname, 'ruleEngine.golden.json');

// Each fixture: { name, genIndex, report, assessmentData }. Signals are explicit
// so the fragment rules activate deterministically across all three report types.
const FIXTURES = [
  {
    name: 'clinical_explicit_severe',
    genIndex: 1,
    report: { client_name: 'Juan Dela Cruz', template_type: 'clinical' },
    assessmentData: {
      observational_notes: 'The client presented with subdued mood and visible tension throughout the interview.',
      behavioral_observations: 'Restlessness, poor concentration, and low self-esteem were observed during tasks.',
      interview_findings: 'Reports persistent low mood, anxiety, poor sleep, social withdrawal, and prior treatment history.',
      tests_administered: [],
      additional_data: {
        clinical_signals: {
          depression: 'severe', anxiety_level: 'severe', sleep_quality: 'low', self_esteem: 'low',
          mental_health_history: 'Yes', social_support: 'low', bullying: 'high', coping: 'avoidant',
          insight: 'present', change_readiness: 'low', emotional_instability: 'present',
          fear_of_abandonment: 'present', risk_flag: 'ELEVATED',
        },
      },
    },
  },
  {
    name: 'clinical_moderate',
    genIndex: 2,
    report: { client_name: 'Maria Santos', template_type: 'clinical' },
    assessmentData: {
      observational_notes: 'Cooperative but with reduced spontaneity and mild psychomotor slowing.',
      behavioral_observations: 'Engaged with structured tasks; coping appeared effortful under stress.',
      interview_findings: 'Describes moderate low mood, some anxiety, and inconsistent social support.',
      tests_administered: [],
      additional_data: {
        clinical_signals: {
          depression: 'moderate', anxiety_level: 'moderate', social_support: 'moderate', coping: 'suppression',
        },
      },
    },
  },
  {
    name: 'clinical_freetext_negation',
    genIndex: 1,
    report: { client_name: 'Pedro Reyes', template_type: 'clinical' },
    assessmentData: {
      observational_notes: 'Client reports low mood and trouble sleeping for several weeks.',
      behavioral_observations: 'Denies anxiety. Concentration appeared mildly reduced.',
      interview_findings: 'No prior treatment. Some social withdrawal noted.',
      tests_administered: [],
      additional_data: {},
    },
  },
  {
    name: 'neuro_explicit',
    genIndex: 1,
    report: { client_name: 'Baby Cruz', template_type: 'neurodevelopmental' },
    assessmentData: {
      observational_notes: 'Caregiver reports developmental milestone delays and limited communication.',
      behavioral_observations: 'Difficulty with adaptive self-care and attention to multi-step tasks.',
      interview_findings: 'Prior developmental assessment; vocabulary appears below age expectations.',
      tests_administered: [],
      additional_data: {
        neuro_signals: {
          early_milestones: 'delayed', prior_assessment: 'Yes', overall_cognition: 'below-age',
          visual_spatial: 'relative_strength', working_memory: 'weak', knowledge: 'weak',
          global_adaptive: 'low', communication: 'limited', parental_involvement: 'low',
        },
      },
    },
  },
  {
    name: 'preemp_fit',
    genIndex: 1,
    report: { client_name: 'Applicant A', template_type: 'pre_employment' },
    assessmentData: {
      observational_notes: 'Task-focused and methodical during structured work-analogue tasks.',
      behavioral_observations: 'Professional and cooperative; organized approach to assigned work.',
      interview_findings: 'Reports work pressure and overtime; values a structured environment.',
      tests_administered: [],
      additional_data: {
        employment_signals: {
          reasoning: 'adequate', organization: 'low', WorkLifeBalance: 'poor', emotional_stability: 'low',
          EnvironmentSatisfaction: 'high', fit_level: 'fit', attrition_risk: 'ELEVATED',
        },
      },
    },
  },
  {
    name: 'preemp_not_recommended',
    genIndex: 1,
    report: { client_name: 'Applicant B', template_type: 'pre_employment' },
    assessmentData: {
      observational_notes: 'Variable task persistence; difficulty under heavier workload.',
      behavioral_observations: 'Reduced composure when demands overlapped.',
      interview_findings: 'Significant occupational concerns reported.',
      tests_administered: [],
      additional_data: { employment_signals: { fit_level: 'not_recommended', emotional_stability: 'low' } },
    },
  },
  {
    name: 'preemp_considerations',
    genIndex: 1,
    report: { client_name: 'Applicant C', template_type: 'pre_employment' },
    assessmentData: {
      observational_notes: 'Workable capabilities for routine tasks observed.',
      behavioral_observations: 'Benefits from clear expectations and structure.',
      interview_findings: 'Adequate interpersonal presentation.',
      tests_administered: [],
      additional_data: { employment_signals: { fit_level: 'fit_with_considerations', reasoning: 'adequate' } },
    },
  },
];

function run() {
  const out = {};
  for (const f of FIXTURES) {
    const res = RuleEngine.generate(f.assessmentData, f.report, f.genIndex);
    const sections = Array.isArray(res) ? res : res.sections; // tolerate either shape
    out[f.name] = sections.map((s) => ({ key: s.key, title: s.title, content: s.content }));
  }
  return out;
}

const current = run();
const update = process.argv.includes('--update');

if (update) {
  fs.writeFileSync(GOLDEN, JSON.stringify(current, null, 2));
  console.log('✅ Golden baseline written:', GOLDEN);
  process.exit(0);
}

if (!fs.existsSync(GOLDEN)) {
  console.error('❌ No golden baseline found. Run with --update first.');
  process.exit(1);
}

const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
const problems = [];
for (const f of FIXTURES) {
  const cur = JSON.stringify(current[f.name]);
  const gold = JSON.stringify(golden[f.name]);
  if (cur !== gold) {
    // Find the first differing section for a readable message.
    const curArr = current[f.name] || [];
    const goldArr = golden[f.name] || [];
    let detail = `section count ${goldArr.length} → ${curArr.length}`;
    const n = Math.max(curArr.length, goldArr.length);
    for (let i = 0; i < n; i++) {
      if (JSON.stringify(curArr[i]) !== JSON.stringify(goldArr[i])) {
        detail = `section "${(goldArr[i] && goldArr[i].key) || (curArr[i] && curArr[i].key) || i}" differs`;
        break;
      }
    }
    problems.push(`  • ${f.name}: ${detail}`);
  }
}

if (problems.length) {
  console.error('❌ GOLDEN DRIFT — generated output changed:');
  console.error(problems.join('\n'));
  console.error('\nIf intended, review the diff and re-run with --update.');
  process.exit(1);
}
console.log(`✅ Golden test passed — ${FIXTURES.length} fixtures identical to baseline.`);
process.exit(0);
