/**
 * Rule-Based Narrative Generation Engine
 * Generates clinical narrative interpretations based on assessment data and test scores.
 */

// ── Configurable Rule Definitions ──────────────────────────────────

const RULES = {
  // ── Cognitive Functioning ──
  cognitive_very_superior: {
    id: 'cognitive_very_superior',
    section: 'test_results',
    category: 'cognitive',
    condition: (scores) => {
      const s = scores.find(s => s.test_category === 'cognitive');
      return s && s.standard_score >= 130;
    },
    narrative: (scores) => {
      const s = scores.find(s => s.test_category === 'cognitive');
      return `Results indicate Very Superior cognitive functioning, with a standard score of ${s.standard_score} (${s.percentile_score}th percentile). This performance falls within the Very Superior range, suggesting exceptionally well-developed intellectual abilities across measured domains.`;
    }
  },
  cognitive_superior: {
    id: 'cognitive_superior',
    section: 'test_results',
    category: 'cognitive',
    condition: (scores) => {
      const s = scores.find(s => s.test_category === 'cognitive');
      return s && s.standard_score >= 120 && s.standard_score < 130;
    },
    narrative: (scores) => {
      const s = scores.find(s => s.test_category === 'cognitive');
      return `Results indicate Superior cognitive functioning, with a standard score of ${s.standard_score} (${s.percentile_score}th percentile). The examinee demonstrates above-average intellectual abilities.`;
    }
  },
  cognitive_high_average: {
    id: 'cognitive_high_average',
    section: 'test_results',
    category: 'cognitive',
    condition: (scores) => {
      const s = scores.find(s => s.test_category === 'cognitive');
      return s && s.standard_score >= 110 && s.standard_score < 120;
    },
    narrative: (scores) => {
      const s = scores.find(s => s.test_category === 'cognitive');
      return `Results indicate High Average cognitive functioning, with a standard score of ${s.standard_score} (${s.percentile_score}th percentile). The examinee's intellectual abilities are above the general population average.`;
    }
  },
  cognitive_average: {
    id: 'cognitive_average',
    section: 'test_results',
    category: 'cognitive',
    condition: (scores) => {
      const s = scores.find(s => s.test_category === 'cognitive');
      return s && s.standard_score >= 90 && s.standard_score < 110;
    },
    narrative: (scores) => {
      const s = scores.find(s => s.test_category === 'cognitive');
      return `Results indicate Average cognitive functioning, with a standard score of ${s.standard_score} (${s.percentile_score}th percentile). The examinee's intellectual abilities fall within the normal range expected for their age group.`;
    }
  },
  cognitive_low_average: {
    id: 'cognitive_low_average',
    section: 'test_results',
    category: 'cognitive',
    condition: (scores) => {
      const s = scores.find(s => s.test_category === 'cognitive');
      return s && s.standard_score >= 80 && s.standard_score < 90;
    },
    narrative: (scores) => {
      const s = scores.find(s => s.test_category === 'cognitive');
      return `Results indicate Low Average cognitive functioning, with a standard score of ${s.standard_score} (${s.percentile_score}th percentile). The examinee's performance falls slightly below the average range, suggesting possible areas of difficulty in cognitive processing.`;
    }
  },
  cognitive_borderline: {
    id: 'cognitive_borderline',
    section: 'test_results',
    category: 'cognitive',
    condition: (scores) => {
      const s = scores.find(s => s.test_category === 'cognitive');
      return s && s.standard_score >= 70 && s.standard_score < 80;
    },
    narrative: (scores) => {
      const s = scores.find(s => s.test_category === 'cognitive');
      return `Results indicate Borderline cognitive functioning, with a standard score of ${s.standard_score} (${s.percentile_score}th percentile). This level of performance suggests significant cognitive limitations that may impact academic or occupational functioning. Further evaluation and supportive interventions are recommended.`;
    }
  },
  cognitive_below_average: {
    id: 'cognitive_below_average',
    section: 'test_results',
    category: 'cognitive',
    condition: (scores) => {
      const s = scores.find(s => s.test_category === 'cognitive');
      return s && s.standard_score < 70;
    },
    narrative: (scores) => {
      const s = scores.find(s => s.test_category === 'cognitive');
      return `Results indicate below-average cognitive functioning, with a standard score of ${s.standard_score} (${s.percentile_score}th percentile). This performance falls within the Extremely Low range, indicating significant intellectual limitations. A comprehensive multidisciplinary evaluation is strongly recommended to determine appropriate support services.`;
    }
  },

  // ── ASD Screening (AQ-10 based) ──
  asd_positive: {
    id: 'asd_positive',
    section: 'test_results',
    category: 'asd_screening',
    condition: (scores) => {
      const s = scores.find(s => s.test_category === 'asd_screening');
      return s && s.raw_score >= 6;
    },
    narrative: (scores) => {
      const s = scores.find(s => s.test_category === 'asd_screening');
      return `The Autism Spectrum Quotient-10 (AQ-10) screening results yielded a score of ${s.raw_score} out of 10, which exceeds the clinical threshold of 6. This result indicates a high likelihood of autism spectrum characteristics and warrants a comprehensive diagnostic evaluation for Autism Spectrum Disorder (ASD). The screening suggests the presence of significant difficulties in social communication, restricted interests, and/or repetitive behaviors.`;
    }
  },
  asd_borderline: {
    id: 'asd_borderline',
    section: 'test_results',
    category: 'asd_screening',
    condition: (scores) => {
      const s = scores.find(s => s.test_category === 'asd_screening');
      return s && s.raw_score >= 4 && s.raw_score < 6;
    },
    narrative: (scores) => {
      const s = scores.find(s => s.test_category === 'asd_screening');
      return `The Autism Spectrum Quotient-10 (AQ-10) screening results yielded a score of ${s.raw_score} out of 10, which falls in the borderline range. While this score does not definitively indicate ASD, it suggests the presence of some autism-related traits that may benefit from further clinical evaluation and monitoring.`;
    }
  },
  asd_negative: {
    id: 'asd_negative',
    section: 'test_results',
    category: 'asd_screening',
    condition: (scores) => {
      const s = scores.find(s => s.test_category === 'asd_screening');
      return s && s.raw_score < 4;
    },
    narrative: (scores) => {
      const s = scores.find(s => s.test_category === 'asd_screening');
      return `The Autism Spectrum Quotient-10 (AQ-10) screening results yielded a score of ${s.raw_score} out of 10, which falls below the clinical threshold. This result does not suggest the presence of significant autism spectrum characteristics at this time. However, clinical judgment should be applied in conjunction with other assessment findings.`;
    }
  },

  // ── Emotional / Behavioral Functioning ──
  emotional_elevated: {
    id: 'emotional_elevated',
    section: 'test_results',
    category: 'emotional',
    condition: (scores) => {
      const s = scores.find(s => s.test_category === 'emotional');
      return s && s.standard_score >= 70;
    },
    narrative: (scores) => {
      const s = scores.find(s => s.test_category === 'emotional');
      return `Emotional and behavioral assessment results indicate clinically elevated scores (T-score: ${s.standard_score}), suggesting significant emotional distress or behavioral difficulties. This level of elevation warrants targeted therapeutic intervention and ongoing monitoring of emotional well-being.`;
    }
  },
  emotional_at_risk: {
    id: 'emotional_at_risk',
    section: 'test_results',
    category: 'emotional',
    condition: (scores) => {
      const s = scores.find(s => s.test_category === 'emotional');
      return s && s.standard_score >= 60 && s.standard_score < 70;
    },
    narrative: (scores) => {
      const s = scores.find(s => s.test_category === 'emotional');
      return `Emotional and behavioral assessment results indicate at-risk scores (T-score: ${s.standard_score}), suggesting emerging concerns in emotional regulation or behavioral adjustment. Preventive strategies and close monitoring are recommended.`;
    }
  },
  emotional_normal: {
    id: 'emotional_normal',
    section: 'test_results',
    category: 'emotional',
    condition: (scores) => {
      const s = scores.find(s => s.test_category === 'emotional');
      return s && s.standard_score < 60;
    },
    narrative: (scores) => {
      const s = scores.find(s => s.test_category === 'emotional');
      return `Emotional and behavioral assessment results fall within normal limits (T-score: ${s.standard_score}), indicating adequate emotional regulation and age-appropriate behavioral functioning.`;
    }
  },

  // ── Adaptive Behavior ──
  adaptive_adequate: {
    id: 'adaptive_adequate',
    section: 'test_results',
    category: 'adaptive',
    condition: (scores) => {
      const s = scores.find(s => s.test_category === 'adaptive');
      return s && s.standard_score >= 85;
    },
    narrative: (scores) => {
      const s = scores.find(s => s.test_category === 'adaptive');
      return `Adaptive behavior assessment results indicate adequate adaptive functioning (standard score: ${s.standard_score}), suggesting the examinee demonstrates age-appropriate skills in daily living, communication, and socialization.`;
    }
  },
  adaptive_below: {
    id: 'adaptive_below',
    section: 'test_results',
    category: 'adaptive',
    condition: (scores) => {
      const s = scores.find(s => s.test_category === 'adaptive');
      return s && s.standard_score < 85 && s.standard_score >= 70;
    },
    narrative: (scores) => {
      const s = scores.find(s => s.test_category === 'adaptive');
      return `Adaptive behavior assessment results indicate below-average adaptive functioning (standard score: ${s.standard_score}), suggesting difficulties in one or more areas of daily living skills, communication, or social skills. Targeted skill-building interventions are recommended.`;
    }
  },
  adaptive_significant_deficit: {
    id: 'adaptive_significant_deficit',
    section: 'test_results',
    category: 'adaptive',
    condition: (scores) => {
      const s = scores.find(s => s.test_category === 'adaptive');
      return s && s.standard_score < 70;
    },
    narrative: (scores) => {
      const s = scores.find(s => s.test_category === 'adaptive');
      return `Adaptive behavior assessment results indicate significant deficits in adaptive functioning (standard score: ${s.standard_score}), suggesting marked limitations in daily living skills, communication, and/or socialization. Comprehensive support services and individualized intervention planning are strongly recommended.`;
    }
  },

  // ── Personality Assessment ──
  personality_valid: {
    id: 'personality_valid',
    section: 'test_results',
    category: 'personality',
    condition: (scores) => {
      const s = scores.find(s => s.test_category === 'personality');
      return s && s.raw_score !== null;
    },
    narrative: (scores) => {
      const s = scores.find(s => s.test_category === 'personality');
      const range = s.descriptive_range || 'within normal limits';
      return `Personality assessment results indicate a profile that is ${range}. ${s.interpretation_notes || 'The examinee demonstrated a consistent response pattern, suggesting the results are a valid representation of their personality characteristics.'}`;
    }
  },

  // ── Summary / Recommendations Generation ──
  summary_combined: {
    id: 'summary_combined',
    section: 'summary',
    category: 'summary',
    condition: (scores) => scores.length > 0,
    narrative: (scores, clientData) => {
      const parts = [];
      const cognitive = scores.find(s => s.test_category === 'cognitive');
      const asd = scores.find(s => s.test_category === 'asd_screening');
      const emotional = scores.find(s => s.test_category === 'emotional');

      if (cognitive) {
        const level = cognitive.standard_score >= 110 ? 'above-average' :
                      cognitive.standard_score >= 90 ? 'average' :
                      cognitive.standard_score >= 80 ? 'low average' : 'below-average';
        parts.push(`Cognitive assessment reveals ${level} intellectual functioning`);
      }
      if (asd) {
        const result = asd.raw_score >= 6 ? 'positive' : asd.raw_score >= 4 ? 'borderline' : 'negative';
        parts.push(`ASD screening results were ${result}`);
      }
      if (emotional) {
        const level = emotional.standard_score >= 70 ? 'clinically elevated' :
                      emotional.standard_score >= 60 ? 'at-risk' : 'within normal limits';
        parts.push(`emotional/behavioral functioning was ${level}`);
      }

      const name = clientData?.client_name || 'The examinee';
      return `Based on the comprehensive assessment conducted, ${name} demonstrated the following profile: ${parts.join('; ')}. These findings should be considered in the context of the referral question and the examinee's developmental, educational, and psychosocial history.`;
    }
  },

  recommendations_cognitive_low: {
    id: 'recommendations_cognitive_low',
    section: 'recommendations',
    category: 'recommendations',
    condition: (scores) => {
      const s = scores.find(s => s.test_category === 'cognitive');
      return s && s.standard_score < 90;
    },
    narrative: () => `1. Individualized educational support or tutoring in areas of cognitive weakness.\n2. Classroom accommodations such as extended time, simplified instructions, and visual aids.\n3. Regular progress monitoring and re-evaluation within 12 months.`
  },

  recommendations_asd_positive: {
    id: 'recommendations_asd_positive',
    section: 'recommendations',
    category: 'recommendations',
    condition: (scores) => {
      const s = scores.find(s => s.test_category === 'asd_screening');
      return s && s.raw_score >= 6;
    },
    narrative: () => `1. Comprehensive diagnostic evaluation for Autism Spectrum Disorder (ASD).\n2. Social skills training and structured social interaction opportunities.\n3. Occupational therapy assessment for sensory processing concerns.\n4. Parent/caregiver education on autism spectrum characteristics and supportive strategies.`
  },

  recommendations_emotional_elevated: {
    id: 'recommendations_emotional_elevated',
    section: 'recommendations',
    category: 'recommendations',
    condition: (scores) => {
      const s = scores.find(s => s.test_category === 'emotional');
      return s && s.standard_score >= 60;
    },
    narrative: () => `1. Individual counseling or psychotherapy to address emotional concerns.\n2. Development of coping strategies and emotional regulation skills.\n3. Coordination with school/workplace for behavioral support.\n4. Follow-up assessment in 6 months to monitor progress.`
  },

  recommendations_general: {
    id: 'recommendations_general',
    section: 'recommendations',
    category: 'recommendations',
    condition: (scores) => scores.length > 0,
    narrative: () => `1. Share assessment results with relevant professionals (teachers, counselors, pediatrician) as appropriate.\n2. Schedule follow-up consultation to discuss implementation of recommendations.\n3. Re-evaluation is recommended within 12-24 months or sooner if significant changes are observed.`
  },
};


// ── Engine ──────────────────────────────────────────────────────────

const RuleEngine = {
  /**
   * Generate narratives for a given set of test scores and client data.
   * @param {Array} testScores - Array of test score objects from DB
   * @param {Object} clientData - Report info (client_name, etc.)
   * @returns {Array} Generated narratives [{section_key, rule_id, narrative_text}]
   */
  generateNarratives(testScores, clientData = {}) {
    const results = [];
    const usedCategories = new Set();

    for (const [ruleId, rule] of Object.entries(RULES)) {
      try {
        if (rule.condition(testScores, clientData)) {
          // For categories with multiple tiers, only use the first matching rule
          const catKey = `${rule.section}_${rule.category}`;
          if (rule.category !== 'recommendations' && rule.category !== 'summary' && usedCategories.has(catKey)) {
            continue;
          }
          usedCategories.add(catKey);

          const text = rule.narrative(testScores, clientData);
          results.push({
            section_key: rule.section,
            rule_id: ruleId,
            narrative_text: text,
          });
        }
      } catch (e) {
        console.error(`Rule engine error on rule ${ruleId}:`, e.message);
      }
    }

    return results;
  },

  /**
   * Get all available rule definitions (for admin/preview).
   */
  getRuleDefinitions() {
    return Object.entries(RULES).map(([id, rule]) => ({
      id,
      section: rule.section,
      category: rule.category,
    }));
  },
};

module.exports = RuleEngine;
