# PsyGen — Narrative Fragment Library
## All Assessment Categories: Clinical, Neurodevelopmental, Pre-Employment

> **Status:** Authoritative Reference — v2  
> **Engine File:** `backend/services/ruleEngine.js`  
> **Constraints:** No ML, no diagnosis. Purely deterministic IF-THEN. PAP Code of Ethics-aligned. DSM-5-TR observational terminology, non-diagnostic application only. Philippine Mental Health Act (RA 11036) considerations embedded throughout.

---

## Table of Contents

1. [Knowledge Base Sources](#1-knowledge-base-sources)
2. [Structured Clinical Signal Enumerations](#2-structured-clinical-signal-enumerations)
3. [Input Validation Rules](#3-input-validation-rules)
4. [Safety Override Rules (All Types)](#4-safety-override-rules-all-types)
5. [Clinical Assessment Rules](#5-clinical-assessment-rules)
6. [Neurodevelopmental Assessment Rules](#6-neurodevelopmental-assessment-rules)
7. [Pre-Employment Assessment Rules](#7-pre-employment-assessment-rules)
8. [Observation Banks](#8-observation-banks)
9. [Recommendation Pools](#9-recommendation-pools)
10. [Implementation Notes](#10-implementation-notes)

---

## 1. Knowledge Base Sources

| Domain | Dataset / Resource |
|---|---|
| Clinical | `StressLevelDataset.csv`, `Stress_Dataset.csv`, `Psychological_Assessment_Dataset.csv`, `Indicators_of_Anxiety_or_Depression_Based_on_Reported_Frequency_of_Symptoms_During_Last_7_Days.csv`, `depressive_tweets_processed.csv` |
| Neurodevelopmental | `Mental Health Dataset.csv`, `Suicide_Detection.csv`, `StudentPerformanceFactors.csv` |
| Pre-Employment | `Employee Attrition Classification Dataset.csv`, `Employee Attrition Classification Dataset-2.csv`, `HR-Employee-Attrition.csv`, `IBM-HR-Analytics-Employee-Attrition-and-Performance-Revised.csv` |
| Anonymized Reports | `ANONYMIZED-CLINICAL-REPORT.docx.pdf`, `ANONYMIZED-NEURODEVELOPMENTAL-REPORT.docx.pdf`, `ANONYMIZED-PRE_EMPLOYMENT-REPORT.docx.pdf` |
| Philippine Context | `Philippine NSMHW Report version 12 n.v. 2 Final.pdf`, `NSMHW Project Briefer FIN (1).pdf` |

---

## 2. Structured Clinical Signal Enumerations

Signals are passed via `additional_data` in the assessment payload. All fields are **optional** — if absent, the engine falls back to rotation-bank generation only.

### `clinical_signals` (Assessment Type: `clinical`)

| Signal Key | Allowed Values | Notes |
|---|---|---|
| `depression` | `none`, `mild`, `moderate`, `severe` | Drives C-EF-01, C-EF-02, C-EF-06, C-CI-01 |
| `anxiety_level` | `none`, `mild`, `moderate`, `severe` | Drives C-EF-03 |
| `self_esteem` | `low`, `moderate`, `high` | Drives C-EF-05 |
| `sleep_quality` | `low`, `moderate`, `high` | Drives C-EF-04, C-RC-03 |
| `social_support` | `low`, `moderate`, `high` | Drives C-SF-01, C-SF-02, C-RC-04 |
| `mental_health_history` | `Yes`, `No` | Drives C-EF-06, C-CI-01, X-RK-01 |
| `coping` | `avoidant`, `suppression`, `adaptive`, `mixed` | Drives C-DM-01, C-DM-02 |
| `peer_pressure` | `none`, `low`, `moderate`, `high` | Drives C-SF-03 |
| `bullying` | `none`, `low`, `moderate`, `high` | Drives C-SF-03 |
| `insight` | `present`, `absent`, `partial` | Drives C-DM-03 |
| `change_readiness` | `low`, `moderate`, `high` | Drives C-DM-03 |
| `emotional_instability` | `present`, `absent` | Drives C-CI-02 |
| `fear_of_abandonment` | `present`, `absent` | Drives C-CI-02 |
| `impulsivity` | `present`, `absent` | Drives C-CI-02 |
| `risk_flag` | `NONE`, `ELEVATED` | **Default: NONE. Drives X-RK-00 safety override.** |

### `neuro_signals` (Assessment Type: `neurodevelopmental`)

| Signal Key | Allowed Values | Notes |
|---|---|---|
| `overall_cognition` | `below-age`, `age-appropriate`, `above-age` | Drives N-TR-01, N-SI-01 |
| `working_memory` | `weak`, `average`, `strong` | Drives N-TR-03 |
| `visual_spatial` | `weak`, `average`, `relative_strength` | Drives N-TR-02 |
| `knowledge` | `weak`, `average`, `strong` | Drives N-TR-04 |
| `global_adaptive` | `low`, `moderate`, `high` | Drives N-AF-01, N-RC-03, N-SI-01 |
| `communication` | `limited`, `developing`, `adequate` | Drives N-AF-02, N-RC-02 |
| `early_milestones` | `delayed`, `typical`, `advanced` | Drives N-ED-01 |
| `prior_assessment` | `Yes`, `No` | Drives N-ED-02 |
| `parental_involvement` | `low`, `moderate`, `high` | Drives N-RC-04 |
| `risk_flag` | `NONE`, `ELEVATED` | **Default: NONE. Drives X-RK-00 safety override.** |

### `employment_signals` (Assessment Type: `pre_employment`)

| Signal Key | Allowed Values | Notes |
|---|---|---|
| `reasoning` | `adequate`, `limited`, `strong` | Drives E-OR-01 |
| `organization` | `low`, `moderate`, `high` | Drives E-OR-02 |
| `WorkLifeBalance` | `poor`, `moderate`, `good` | Drives E-OR-03 |
| `OverTime` | `Yes`, `No` | Drives E-OR-03 |
| `emotional_stability` | `low`, `moderate`, `high` | Drives E-OR-04 |
| `EnvironmentSatisfaction` | `low`, `moderate`, `high` | Drives E-OR-05 |
| `attrition_risk` | `NONE`, `ELEVATED` | Drives E-ATTRITION |
| `fit_level` | `fit`, `fit_with_considerations`, `not_recommended` | Drives E-IC-FIT / E-IC-CONSIDER / E-IC-NOTREC. **Default: `fit_with_considerations`** |
| `risk_flag` | `NONE`, `ELEVATED` | **Default: NONE. Drives X-RK-00 safety override.** |

---

## 3. Input Validation Rules

Applied in `_validateTextField(value, fieldLabel)` before any generation. Returns an array of human-readable error strings; an empty array means the field passed. Blank fields are handled separately in `validateAssessment()`.

| Check | Pattern / Condition | Error Message Template |
|---|---|---|
| **Repeated characters** | `/^(.)\1{3,}$/` on string with whitespace removed | `"{fieldLabel}: Entry appears to consist of repeated characters. Please provide meaningful clinical observations written in complete sentences."` |
| **Symbol-only** | `/^[^a-zA-Z0-9\s]+$/` | `"{fieldLabel}: Entry contains only symbols and no readable text. Please provide descriptive narrative content."` |
| **Numeric-only** | `/^\d+$/` on string with whitespace removed | `"{fieldLabel}: Entry contains only numbers. Please describe observations in sentence form (e.g., \"The client presented with...\")."` |
| **Keyboard pattern** | String (lowercased, spaces removed) contains any pattern in `KEYBOARD_PATTERNS` | `"{fieldLabel}: Entry appears to contain a keyboard pattern (\"{kp}\"). Please provide meaningful clinical observations."` |
| **Placeholder exact match** | Stripped lowercase matches any word in `PLACEHOLDER_WORDS` | `"{fieldLabel}: Entry \"{v}\" appears to be placeholder text. Please provide specific, clinically meaningful observations."` |
| **All-placeholder short entry** | wordCount ≤ 3 AND every word is in `PLACEHOLDER_WORDS` | `"{fieldLabel}: Entry appears to contain only placeholder words. Please describe actual clinical observations."` |
| **Too brief** | wordCount < 5 | `"{fieldLabel}: Entry is too brief ({wordCount} word[s]). Please provide at least 5 words describing observed behaviors or clinical findings."` |
| **No vowels in long string** | letters.length > 8 AND vowels.length === 0 | `"{fieldLabel}: Entry does not appear to contain readable words. Please provide observations written in sentence form."` |
| **Single long word, vowel-sparse** | wordCount === 1 AND letters.length > 10 AND (vowels/letters) < 0.10 | `"{fieldLabel}: Entry appears to be a random character string. Please provide clinical observations in complete sentences."` |

### Keyboard Patterns List (`KEYBOARD_PATTERNS`)
`qwerty`, `qwertyuiop`, `asdfgh`, `asdfghjkl`, `zxcvbn`, `zxcvbnm`, `qazwsx`, `edcrfv`, `poiuyt`, `lkjhgf`, `mnbvcx`, `plokmijn`, `123456`, `1234567`, `12345678`, `123456789`, `0987654321`, `abcdef`, `abcdefg`, `zyxwvu`

### Placeholder Words List (`PLACEHOLDER_WORDS`)
`test`, `testing`, `sample`, `tbd`, `to follow`, `n/a`, `na`, `none`, `ok`, `yes`, `no`, `placeholder`, `draft`, `pending`, `unknown`, `lorem`, `ipsum`, `asd`, `xxx`, `zzz`, `abc`, `null`, `undefined`, `todo`, `tba`, `fill`, `enter`, `type`, `here`, `input`, `insert`, `write`, `add`

---

## 4. Safety Override Rules (All Types)

> **Evaluated FIRST, before all other rules, across ALL assessment types.**  
> `risk_flag` defaults to `NONE` in every signal group. Clinician must explicitly set it to `ELEVATED`.

### X-RK-00 — Elevated Risk: Primary Observation

**Condition:** `cs.risk_flag === 'ELEVATED'` OR `ns.risk_flag === 'ELEVATED'` OR `es.risk_flag === 'ELEVATED'`  
**Section:** `risk`  
**Fragment (verbatim):**
> "The client currently presents with significant psychological risk factors, including reported thoughts of self-harm. This presentation warrants immediate clinical attention and active safety planning."

---

### X-RK-01 — Elevated Risk: Prior History Modifier

**Condition:** X-RK-00 is active AND (`cs.mental_health_history === 'Yes'` OR `ns.mental_health_history === 'Yes'`)  
**Section:** `risk`  
**Fragment (verbatim):**
> "A prior history of psychological difficulty further increases vulnerability during periods of acute stress."

---

### X-RC-CRISIS — Elevated Risk: Safety Recommendation

**Condition:** X-RK-00 is active (any type)  
**Section:** `recommendations_safety`  
**Fragment (verbatim):**
> "Establish a safety plan addressing emotional triggers, coping strategies, and emergency support contacts. Connect immediately with crisis resources including the NCMH Crisis Hotline (1553), the DOH iCare Hotline (1800-10-HOPEPH), or the nearest licensed mental health facility. This is a clinical priority."

> **Display note:** Safety recommendations must appear under an **"IMMEDIATE ACTION"** heading in the recommendations section, rendered before all other recommendations.

---

### X-RK-LOW — No Active Risk

**Condition:** `risk_flag` is NOT `ELEVATED` in any active signal group  
**Section:** `risk`  
**Fragment (verbatim):**
> "No active indicators of risk to self or others were elicited during the present assessment. Routine monitoring is recommended as part of ongoing clinical care."

---

## 5. Clinical Assessment Rules

Applies when `template_type === 'clinical'`. Signals read from `additional_data.clinical_signals`.

### Section: `emotional_functioning` → injected into `test_results`

---

**C-EF-01 — Severe Depression**

**Condition:** `cs.depression === 'severe'`  
**Fragment (verbatim):**
> "{name} exhibits severe emotional distress characterized by persistent low mood, emotional exhaustion, and a pervasive loss of interest in usual activities."

---

**C-EF-02 — Moderate Depression**

**Condition:** `cs.depression === 'moderate'`  
**Fragment (verbatim):**
> "{name} presents with marked depressive features, including frequent low mood, reduced motivation, and diminished enjoyment of daily activities."

---

**C-EF-MILD — Mild Depression** *(supplemental, not library-assigned)*

**Condition:** `cs.depression === 'mild'`  
**Fragment (verbatim):**
> "{name} reports some degree of low mood and reduced pleasure in daily activities, with functional impact that is mild but observable in the clinical context."

---

**C-EF-03 — Notable Anxiety**

**Condition:** `cs.anxiety_level === 'moderate'` OR `cs.anxiety_level === 'severe'`  
**Fragment (verbatim):**
> "{name} reported notable anxiety, accompanied by overthinking, restlessness, and difficulty calming once distressed."

---

**C-EF-04 — Poor Sleep Quality**

**Condition:** `cs.sleep_quality === 'low'`  
**Fragment (verbatim):**
> "{name} described irregular sleep and difficulty maintaining restful sleep, which appears to compound existing emotional exhaustion."

---

**C-EF-05 — Low Self-Esteem**

**Condition:** `cs.self_esteem === 'low'`  
**Fragment (verbatim):**
> "There are indications of low self-esteem and self-critical thinking, with {name} frequently describing personal capabilities in negative terms."

---

**C-EF-06 — Longstanding History with Moderate/Severe Depression**

**Condition:** `cs.mental_health_history === 'Yes'` AND (`cs.depression === 'moderate'` OR `cs.depression === 'severe'`)  
**Fragment (verbatim):**
> "These difficulties appear longstanding rather than situational, consistent with a recurrent rather than first-onset presentation."

---

### Section: `social_functioning` → injected into `findings`

---

**C-SF-01 — Low Social Support**

**Condition:** `cs.social_support === 'low'`  
**Fragment (verbatim):**
> "{name} experiences significant difficulties in social and interpersonal functioning, particularly in forming and maintaining stable, supportive relationships."

---

**C-SF-02 — Moderate Social Support**

**Condition:** `cs.social_support === 'moderate'`  
**Fragment (verbatim):**
> "{name} maintains some meaningful connections but at times feels emotionally unsupported or misunderstood by those around them."

---

**C-SF-03 — Peer Conflict / Social Pressure**

**Condition:** `cs.bullying === 'high'` OR `cs.peer_pressure === 'high'`  
**Fragment (verbatim):**
> "Experiences of peer conflict and social pressure appear to have contributed to feelings of insecurity and guardedness in interpersonal interactions."

---

### Section: `defense_mechanisms` → injected into `findings`

---

**C-DM-01 — Avoidant Coping**

**Condition:** `cs.coping === 'avoidant'`  
**Fragment (verbatim):**
> "{name} primarily relies on avoidance and emotional withdrawal when faced with distress, distancing rather than directly confronting difficulties."

---

**C-DM-02 — Suppression-then-Release Coping**

**Condition:** `cs.coping === 'suppression'`  
**Fragment (verbatim):**
> "There are indications of emotional overcontrol followed by impulsive release, in which suppressed feelings surface abruptly during periods of overwhelm."

---

**C-DM-03 — Insight Present, Change Readiness Low**

**Condition:** `cs.insight === 'present'` AND `cs.change_readiness === 'low'`  
**Fragment (verbatim):**
> "Although {name} demonstrates self-awareness and insight, there may be difficulty translating this insight into consistent behavioral change during emotionally intense situations."

---

### Section: `clinical_impression` → injected into `findings`

---

**C-CI-01 — Recurrent Depressive Presentation**

**Condition:** `cs.depression === 'severe'` AND `cs.mental_health_history === 'Yes'`  
**Fragment (verbatim):**
> "{name} presents with symptoms consistent with a recurrent depressive presentation, marked by chronic low mood, guilt, and emotional exhaustion."

---

**C-CI-02 — Emotional Dysregulation / Interpersonal Sensitivity**

**Condition:** `cs.emotional_instability === 'present'` AND (`cs.fear_of_abandonment === 'present'` OR `cs.impulsivity === 'present'`)  
**Fragment (verbatim):**
> "The presentation is also consistent with significant emotional dysregulation and interpersonal sensitivity, particularly around situations involving rejection or conflict."

---

**C-CI-FOOTER — Clinical Impression Footer** *(always)*

**Condition:** Always, for all `clinical` assessments  
**Fragment (verbatim):**
> "Further evaluation by a licensed clinician is warranted to confirm impressions and rule out co-occurring conditions."

---

### Section: `recommendations_fragment` → injected into `recommendations`

---

**C-RC-01 — Psychotherapy Recommendation** *(always)*

**Condition:** Always, for all `clinical` assessments  
**Fragment (verbatim):**
> "Engage in regular psychotherapy with a licensed psychologist, with emphasis on emotion regulation and distress tolerance."

---

**C-RC-03 — Sleep Hygiene Recommendation**

**Condition:** `cs.sleep_quality === 'low'`  
**Fragment (verbatim):**
> "Adopt sleep-hygiene strategies and a consistent routine to support emotional stability."

---

**C-RC-04 — Social Support Strengthening**

**Condition:** `cs.social_support === 'low'`  
**Fragment (verbatim):**
> "Strengthen supportive relationships and consider structured peer or family support where appropriate."

---

**C-RC-PH — Philippine Mental Health Act Referral** *(always)*

**Condition:** Always, for all `clinical` assessments  
**Fragment (verbatim):**
> "Referral to a licensed Filipino mental health professional is encouraged, in alignment with the Philippine Mental Health Act (RA 11036). Community-based mental health programs through the local government unit (LGU) may also be explored as accessible support resources."

---

## 6. Neurodevelopmental Assessment Rules

Applies when `template_type === 'neurodevelopmental'`. Signals read from `additional_data.neuro_signals`.

### Section: `early_development` → injected into `test_results`

---

**N-ED-01 — Delayed Early Milestones**

**Condition:** `ns.early_milestones === 'delayed'`  
**Fragment (verbatim):**
> "Early developmental history reflects delays across communication and self-help skills, with prior involvement in developmental support services."

---

**N-ED-02 — Prior Assessment History**

**Condition:** `ns.prior_assessment === 'Yes'`  
**Fragment (verbatim):**
> "{name} has a history of earlier developmental assessment and intervention, providing useful continuity for the present evaluation."

---

### Section: `test_results_fragment` → injected into `test_results`

---

**N-TR-01 — Below-Age Overall Cognition**

**Condition:** `ns.overall_cognition === 'below-age'`  
**Fragment (verbatim):**
> "Overall cognitive functioning appears to fall below age-level expectations, with corresponding difficulty across reasoning and knowledge-based tasks."

---

**N-TR-02 — Visual-Spatial Relative Strength**

**Condition:** `ns.visual_spatial === 'relative_strength'`  
**Fragment (verbatim):**
> "Visual-spatial processing emerged as a relative strength, indicating a comparatively better ability to work with visual information."

---

**N-TR-03 — Weak Working Memory**

**Condition:** `ns.working_memory === 'weak'`  
**Fragment (verbatim):**
> "Working memory presents as an area of significant difficulty, affecting tasks that require holding and manipulating information over short periods."

---

**N-TR-04 — Weak Knowledge / Vocabulary**

**Condition:** `ns.knowledge === 'weak'`  
**Fragment (verbatim):**
> "Accumulated knowledge and vocabulary appear notably below expectations relative to same-age peers."

---

### Section: `adaptive_functioning` → injected into `findings`

---

**N-AF-01 — Low Global Adaptive Functioning**

**Condition:** `ns.global_adaptive === 'low'`  
**Fragment (verbatim):**
> "Adaptive functioning appears low overall, with {name} requiring support across communication, self-direction, and daily living skills."

---

**N-AF-02 — Limited Communication Skills**

**Condition:** `ns.communication === 'limited'`  
**Fragment (verbatim):**
> "Communication skills are limited and represent a priority area for continued intervention."

---

### Section: `summary_impression` → injected into `findings`

---

**N-SI-01 — Below-Age Cognition + Low Adaptive Functioning**

**Condition:** `ns.overall_cognition === 'below-age'` AND `ns.global_adaptive === 'low'`  
**Fragment (verbatim):**
> "Present findings are consistent with a neurodevelopmental profile marked by below-age cognitive and adaptive functioning, with relative strengths that can be leveraged in intervention."

---

**N-SI-FOOTER — Summary Impression Footer** *(always)*

**Condition:** Always, for all `neurodevelopmental` assessments  
**Fragment (verbatim):**
> "Continued multidisciplinary support and periodic re-assessment are warranted to track developmental progress."

---

### Section: `recommendations_fragment` → injected into `recommendations`

---

**N-RC-01 — Individualized Educational Support** *(always)*

**Condition:** Always, for all `neurodevelopmental` assessments  
**Fragment (verbatim):**
> "Continue individualized educational support tailored to {name}'s developmental level and learning needs."

---

**N-RC-02 — Speech and Language Support**

**Condition:** `ns.communication === 'limited'`  
**Fragment (verbatim):**
> "Resume or continue speech and language support to strengthen communication skills."

---

**N-RC-03 — Adaptive Skills Training**

**Condition:** `ns.global_adaptive === 'low'`  
**Fragment (verbatim):**
> "Incorporate structured adaptive-skills training focused on daily living and self-direction."

---

**N-RC-04 — Strengthen Caregiver Involvement**

**Condition:** `ns.parental_involvement === 'low'`  
**Fragment (verbatim):**
> "Strengthen caregiver involvement and home-based reinforcement of target skills."

---

## 7. Pre-Employment Assessment Rules

Applies when `template_type === 'pre_employment'`. Signals read from `additional_data.employment_signals`.

### Section: `overall_results_fragment` → injected into `findings`

---

**E-OR-01 — Adequate Reasoning**

**Condition:** `es.reasoning === 'adequate'`  
**Fragment (verbatim):**
> "{name} demonstrates good verbal and basic reasoning skills suited to routine, structured tasks."

---

**E-OR-02 — Low Organization**

**Condition:** `es.organization === 'low'`  
**Fragment (verbatim):**
> "While able to plan tasks at a basic level, lower self-directed organization and follow-through may make it difficult for {name} to manage multiple competing demands."

---

**E-OR-03 — Poor Work-Life Balance or Overtime**

**Condition:** `es.WorkLifeBalance === 'poor'` OR `es.OverTime === 'Yes'`  
**Fragment (verbatim):**
> "Balancing overlapping responsibilities can at times be overwhelming, representing an area for growth and enrichment."

---

**E-OR-04 — Low Emotional Stability**

**Condition:** `es.emotional_stability === 'low'`  
**Fragment (verbatim):**
> "When personal concerns overlap with rising workplace demands, {name} may be prone to anxiety and reduced focus that can temporarily affect confidence and composure."

---

**E-OR-05 — High Environment Satisfaction**

**Condition:** `es.EnvironmentSatisfaction === 'high'`  
**Fragment (verbatim):**
> "Performance and professional stability are closely tied to {name} operating within a structured, predictable routine under supportive leadership."

---

**E-ATTRITION — Elevated Attrition Risk**

**Condition:** `es.attrition_risk === 'ELEVATED'`  
**Fragment (verbatim):**
> "Occupational engagement indicators suggest the presence of factors associated with elevated attrition risk, including limited perceived recognition and reduced environmental satisfaction. These factors warrant consideration in role assignment and onboarding planning."

---

### Section: `impression_conclusion_fragment` → injected into `findings`

---

**E-IC-FIT — Fit for Employment**

**Condition:** `es.fit_level === 'fit'`  

*impression_conclusion_fragment (verbatim):*
> "{name} possesses adequate capabilities for the role and can maintain consistent performance within a predictable work environment under supportive supervision."

*fit_recommendation (verbatim):*
> "There is no significant psychopathology noted at the time of examination; {name} appears fit for employment."

---

**E-IC-CONSIDER — Fit with Considerations** *(default)*

**Condition:** `es.fit_level === 'fit_with_considerations'` OR `es.fit_level` is absent  

*impression_conclusion_fragment (verbatim):*
> "{name} demonstrates workable capabilities for routine tasks but may require structure and clear expectations to sustain focus and composure under heavier workloads."

*fit_recommendation (verbatim):*
> "{name} appears fit for employment, with the consideration that a structured and supportive work setting will best sustain performance."

---

**E-IC-NOTREC — Not Recommended**

**Condition:** `es.fit_level === 'not_recommended'`  

*impression_conclusion_fragment (verbatim):*
> "Present findings indicate significant concerns that should be addressed before a determination of employment suitability for {name} can be confidently made."

*fit_recommendation (verbatim):*
> "Based on present findings, {name} is not recommended for the role at this time pending further evaluation and support."

---

## 8. Universal Rules

### Z-FOOTER — Professional Sign-Off *(always, all types)*

**Condition:** Always, all assessment types  
**Section:** `footer`  
**Fragment (verbatim):**
> "Findings require review and sign-off by a licensed psychometrician/psychologist."

---

## 9. Observation Banks

All banks are used in rotation for generating narrative variety. Each bank entry is a verbatim clinically-phrased observation. Dataset sourcing is noted where applicable.

---

### `MOOD_OBS` — Mood / Affect

1. presented with a generally subdued affect throughout the session, with limited range of emotional expression
2. demonstrated observable fluctuations in mood, alternating between periods of engagement and visible withdrawal
3. maintained a relatively stable affect during the assessment, though moments of flat or restricted expression were noted
4. displayed a constricted range of affect, with limited spontaneous emotional responsiveness during the interaction
5. showed signs of emotional dysregulation, including brief periods of tearfulness and difficulty modulating affective response
6. exhibited muted affective expression throughout the evaluation, with minimal spontaneous emotional reactivity to session content
7. presented with variable affective expression, demonstrating moments of genuine engagement interspersed with periods of affective blunting
8. displayed observable signs of mood-related fatigue, including reduced affective vitality and limited motivational investment in social interaction
9. demonstrated low-grade affective distress that was visually apparent throughout the session, manifested as reduced facial expressiveness and psychomotor quieting
10. showed a reserved and emotionally guarded presentation, with careful regulation of emotional expression across the assessment interaction
11. *(Psychological_Assessment_Dataset.csv)* presented with observable low mood consistent with reported dissatisfaction and reduced engagement in daily activities across the assessment period
12. *(Psychological_Assessment_Dataset.csv)* demonstrated emotional presentation characterized by reduced expressiveness and limited spontaneous affect that may reflect current psychosocial burden
13. *(Indicators_of_Anxiety_or_Depression CSV)* reported experiencing depressed mood on more days than not during the reference period, with associated functional impact on daily engagement
14. *(Indicators_of_Anxiety_or_Depression CSV)* endorsed frequent episodes of low mood and emotional exhaustion that were corroborated by behavioral observations during the evaluation

---

### `ANXIETY_OBS` — Anxiety

1. exhibited behavioral indicators consistent with heightened autonomic arousal, including observable restlessness and frequent self-monitoring
2. demonstrated signs of elevated social anxiety, showing guardedness and minimal spontaneous disclosure in interpersonal contexts
3. displayed somatic tension signs including shallow breathing, muscle guarding, and increased psychomotor agitation during the evaluation
4. showed notable anticipatory apprehension when transitioning between tasks, accompanied by increased latency in verbal responses
5. exhibited cognitive avoidance behaviors, particularly when topics related to perceived threat or performance demands were introduced
6. demonstrated somatic anxiety markers including visible muscle tension and irregular breathing patterns during periods of heightened task demand
7. showed behavioral indicators of anticipatory anxiety, including increased fidgeting, self-referential commentary, and repeated reassurance-seeking behavior
8. exhibited social evaluative anxiety responses, with notable behavioral constriction when attention was directed toward personal performance or personal history
9. displayed generalized tension and hypervigilance throughout the session, with heightened startle responsiveness and difficulty relaxing between task transitions
10. demonstrated cognitive patterns consistent with chronic worry, including repeated catastrophizing statements and difficulty maintaining a present-focused orientation
11. *(Psychological_Assessment_Dataset.csv)* reported physical symptoms of anxiety including heart palpitations, perspiration, and shortness of breath, consistent with elevated physiological arousal
12. *(Psychological_Assessment_Dataset.csv)* endorsed recurring episodes of somatic anxiety expression including chest tightness and trembling, corroborating elevated anxiety burden
13. *(Stress_Dataset.csv)* demonstrated behavioral and self-reported indicators of physiological stress reactivity, including rapid heartbeat and palpitation episodes during periods of heightened demand
14. *(Stress_Dataset.csv)* reported frequent experiences of anxious arousal including physical tension, restlessness, and a persistent sense of unease affecting daily functioning

---

### `SLEEP_SOMATIC_OBS` — Sleep / Somatic

1. reported disruptions in sleep-wake patterns that were corroborated by observable fatigue and concentration lapses during the session
2. presented with physical indicators of inadequate rest, including reduced psychomotor speed and difficulty sustaining effortful attention
3. endorsed somatic complaints consistent with chronic stress load, including reported headaches, appetite irregularities, and generalized fatigue
4. demonstrated reduced physical vitality across the session, with observable decline in engagement and task persistence over time
5. reported changes in appetite and energy that, alongside behavioral observations, suggest elevated physiological stress responses
6. reported significant sleep onset difficulties and nighttime awakenings that were reflected in observable daytime fatigue and impaired sustained attention during the evaluation
7. endorsed chronic sleep disruption across multiple modalities — onset, maintenance, and early morning wakening — with associated daytime functional consequences
8. described somatic complaints including headaches, gastrointestinal irregularities, and generalized physical tension correlated with heightened psychosocial stress
9. presented with observable indicators of chronic fatigue, including reduced psychomotor tempo and difficulty maintaining alertness during cognitively demanding session phases
10. reported appetite and weight changes alongside disrupted sleep, suggesting a constellation of somatic indicators consistent with elevated chronic stress activation
11. *(Stress_Dataset.csv)* reported recurring headaches and frequent sleep difficulties that appeared temporally related to periods of elevated academic or occupational stress demand
12. *(Stress_Dataset.csv)* endorsed somatic symptom cluster including headaches, fatigue, and sleep irregularities consistent with a chronic psychosocial stress burden
13. *(Psychological_Assessment_Dataset.csv)* described irregular sleep characterized by early morning wakening and difficulty achieving restorative rest, contributing to daytime functional compromise

---

### `MOTIVATION_OBS` — Motivation / Anhedonia

1. showed diminished initiative and reduced spontaneous engagement with presented tasks, requiring frequent external redirection
2. demonstrated anhedonic behavioral markers, including flat response to typically rewarding stimuli and low motivational investment in activities
3. exhibited variable effort and task persistence, with measurable decline in engagement as cognitive demands increased
4. displayed limited goal-directed behavior and reduced self-initiation across both structured and unstructured portions of the assessment
5. showed interest inconsistency, with selective engagement in preferred topics and marked avoidance of effortful or demanding tasks
6. demonstrated limited intrinsic motivation for self-initiated activities, with performance contingent primarily on external prompting and structured environmental support
7. showed selective engagement across the evaluation, demonstrating markedly higher task investment when activities aligned with personal interest areas compared to neutral demands
8. exhibited behavioral indicators of motivational depletion, including early task abandonment, frequent requests for breaks, and minimal initiative in open-ended task phases
9. reported subjective loss of motivation and purposefulness consistent with behavioral observations of reduced goal-directed activity and diminished future orientation
10. demonstrated intact motivation for preferred domains but significant motivational restriction in areas perceived as effortful, evaluative, or socially exposing
11. *(Psychological_Assessment_Dataset.csv)* endorsed frequent loss of interest and pleasure in previously enjoyable activities, with reduced engagement in leisure and recreational pursuits over the recent period
12. *(Psychological_Assessment_Dataset.csv)* reported difficulty sustaining motivation for daily tasks, with a notably reduced frequency of engagement in activities that previously provided satisfaction
13. *(StudentPerformanceFactors.csv)* demonstrated low academic or task motivation characterized by minimal effort investment and reduced responsiveness to achievement-oriented demands

---

### `SOCIAL_OBS` — Social Functioning

1. demonstrated restricted social reciprocity, with delayed turn-taking and limited spontaneous sharing of experiences during the interaction
2. showed pragmatic language patterns consistent with reduced social confidence, including frequent topic disengagement and minimal eye contact
3. presented with intact basic communication skills but observable difficulty sustaining reciprocal social exchanges for extended periods
4. exhibited social withdrawal tendencies, preferring task-focused interaction over social banter and showing minimal initiation of social contact
5. demonstrated heightened self-consciousness in interpersonal contexts, with behavioral avoidance responses when direct social evaluation was implied
6. demonstrated a preference for structured, task-oriented social interaction over open-ended social banter, showing greater functional comfort in procedurally predictable exchanges
7. exhibited selective social responsiveness, engaging more fluidly with familiar topics and showing markedly reduced reciprocity when navigating interpersonal uncertainty
8. showed adequate surface-level social competence alongside observable difficulty sustaining deeper relational engagement over extended periods
9. demonstrated social anxiety-adjacent behaviors including prolonged gaze avoidance, careful topic monitoring, and tendency to minimize personal disclosures in the evaluation context
10. reported reduced frequency and quality of interpersonal connections, with observable impact on sense of belonging and social confidence in group contexts
11. *(Mental Health Dataset.csv)* reported significant reduction in social engagement and community participation, with extended periods indoors and away from usual interpersonal networks
12. *(Mental Health Dataset.csv)* demonstrated social withdrawal consistent with prolonged stress exposure, including limited participation in peer activities and reduced initiation of interpersonal contact
13. *(Stress_Dataset.csv)* endorsed frequent experiences of loneliness and social isolation that appear to compound existing emotional difficulties and reduce available support resources

---

### `COPING_OBS` — Coping Mechanisms

1. identified primarily avoidant coping strategies, with limited reported use of problem-focused or emotion-regulation approaches
2. demonstrated reliance on disengagement and cognitive suppression as primary stress management strategies during the interview
3. reported using social support and physical activity as adaptive coping mechanisms, though access to these resources appeared inconsistent
4. showed mixed coping repertoire, combining some adaptive strategies (e.g., structured routines, creative expression) with maladaptive avoidance
5. demonstrated limited coping flexibility, applying the same response pattern across varied stressor types regardless of context or effectiveness
6. reported using prayer, spiritual engagement, and community-based activities as primary coping resources, consistent with Filipino cultural norms around psychosocial resilience
7. demonstrated an emotion-focused coping orientation, with greater reliance on affective expression and social sharing compared to instrumental problem-solving approaches
8. showed limited access to evidence-informed coping strategies, relying instead on habitual avoidance and disengagement that provided short-term relief but limited longer-term resolution
9. described coping patterns that were contextually inconsistent, applying different strategies across similar stressors without an evaluative framework for selecting effective responses
10. reported that social comparison and perceived familial obligation significantly shaped coping behavior, suggesting a collectivist-influenced stress appraisal and management style
11. *(Psychological_Assessment_Dataset.csv)* reported use of physical activity and brief relaxation exercises as primary coping strategies, though consistency of application appeared variable across high-stress periods
12. *(Psychological_Assessment_Dataset.csv)* endorsed reliance on avoidance and disengagement as primary stress responses, with limited use of problem-focused or socially-engaged coping approaches
13. *(Mental Health Dataset.csv)* reported significant difficulty managing ongoing stressors, with observable changes in daily habits and routines suggesting coping resource depletion

---

### `CONCENTRATION_OBS` — Concentration / Attention

1. exhibited observable difficulty sustaining focused attention across extended task demands, with frequent off-task episodes
2. demonstrated inconsistent concentration, with better performance on brief, highly structured tasks compared to open-ended or lengthier activities
3. showed signs of attentional splitting, dividing focus between the task and environmental stimuli in a manner that disrupted task completion
4. presented with cognitive fatigue effects — initially adequate concentration declined noticeably across the session duration
5. reported subjective concentration difficulties that were corroborated by behavioral indicators of reduced working memory engagement
6. demonstrated observable attentional lapses during the evaluation, with periodic disorientation to task instructions requiring examiner redirection
7. showed working memory interference effects, with reduction in performance quality when task instructions required retention of multiple sequential steps
8. exhibited divided attention difficulties, demonstrating performance degradation when required to process multiple simultaneous stimulus streams
9. reported subjective concentration difficulties reflected in increased response time variability across similar task demands throughout the session
10. demonstrated adequate attentional focus during brief, clearly bounded tasks, with marked decline as session duration increased and cognitive demands accumulated
11. *(Stress_Dataset.csv)* reported difficulty concentrating on academic or work-related tasks, with stress-related cognitive interference noted as a primary contributor
12. *(Indicators_of_Anxiety_or_Depression CSV)* endorsed frequent concentration difficulties during the reference period, consistent with current affective and stress burden impacting cognitive efficiency

---

### `COGNITIVE_OBS` — Cognitive Functioning

1. demonstrated adequate verbal comprehension and reasoning within the context of clinical observation, without formal standardized testing
2. showed organized and sequential thought processes during structured questioning, though elaboration was limited
3. displayed concrete thinking style with limited spontaneous abstraction, consistent with developmental or educational history factors
4. exhibited generally intact receptive language and task comprehension, though processing speed appeared reduced under time pressure
5. demonstrated logical and coherent thought organization, with no evidence of thought disorder or significant formal cognitive disruption
6. demonstrated fluid reasoning within observationally accessible limits, with adequate capacity for categorical thinking and novel problem-solving under structured conditions
7. showed relative strength in verbal expressive skills compared to nonverbal processing, with language-based tasks demonstrating greater complexity and elaboration
8. exhibited adequate executive function indicators including basic planning, behavioral inhibition, and self-monitoring, with variable performance across cognitively complex demands
9. displayed concrete-to-abstract reasoning transitions that appeared effortful, with reliance on familiar schemas rather than generative problem-solving approaches
10. demonstrated generally organized ideation and logical reasoning within the scope of direct clinical observation, with no gross evidence of cognitive fragmentation or formal thought disorder

---

### `DEPRESSION_OBS` — Depression Indicators

1. displayed behavioral markers consistent with depressed mood, including diminished affective range, psychomotor slowing, and reduced expressive spontaneity throughout the session
2. exhibited signs of anhedonia, with endorsed loss of pleasure in previously rewarding activities and significant withdrawal from social and recreational engagement
3. demonstrated observable low energy and reduced initiative, with subjective reports of persistent feelings of emptiness and diminished sense of personal purpose
4. showed affective presentation consistent with low mood, including decreased vocalization, prolonged response latency, and reduced spontaneous eye contact with the examiner
5. reported pervasive feelings of worthlessness and self-blame corroborated by behavioral indicators of reduced self-efficacy and limited aspirational thinking
6. demonstrated psychomotor characteristics consistent with depressed functioning, including slowed movement tempo, minimal gestural expression, and reduced postural engagement
7. reported persistent mood lowering across multiple weeks that appeared independent of situational fluctuations, suggesting potential chronic affective dysregulation
8. exhibited cognitive correlates of low mood including difficulty generating positive future-oriented thoughts, ruminative ideation, and reduced cognitive flexibility
9. showed reduced social motivation and interest in interpersonal connection, with subjective reports of emotional numbness and disconnection from previously meaningful relationships
10. demonstrated loss of spontaneous affect across the session, with affective response requiring significant external elicitation and limited carryover between emotionally activating content
11. *(Indicators_of_Anxiety_or_Depression CSV)* endorsed symptoms consistent with clinically significant depressive burden based on frequency and duration of reported emotional and functional difficulties
12. *(Indicators_of_Anxiety_or_Depression CSV)* reported persistent depressive symptoms including low mood, fatigue, reduced concentration, and diminished pleasure, consistent with elevated affective burden

---

### `EMOTIONAL_REGULATION_OBS` — Emotional Regulation

1. demonstrated difficulty modulating emotional responses to mild stressors, suggesting reduced affective tolerance and limited emotional regulatory capacity under evaluative conditions
2. showed evidence of emotional lability, with rapid shifts in affective tone that appeared disproportionate to the situational demands encountered during the assessment
3. exhibited limited frustration tolerance, with observable behavioral escalation in response to perceived task failure or ambiguous evaluative feedback
4. demonstrated generally intact emotional regulation under low-demand conditions, though escalating task complexity was associated with observable affective dysregulation and disengagement
5. reported relying primarily on external co-regulation strategies, with limited capacity for independent affective self-regulation in the absence of social support
6. showed inconsistent emotional regulation across session phases, maintaining composure during structured tasks while demonstrating increased emotional reactivity during open-ended interview components
7. demonstrated emotional overcontrol as a regulatory strategy, presenting with minimal affective expression that appeared effortful rather than reflecting genuine emotional neutrality
8. exhibited delayed emotional recovery following minor frustrations, with residual behavioral agitation persisting into subsequent task phases
9. reported active use of suppression and emotional avoidance as primary regulatory strategies, which appeared to limit authentic emotional expression during the clinical interview
10. demonstrated emotional regulation within normal functional limits in familiar low-demand contexts, with functional breakdown occurring under conditions of novelty, social evaluation, or task failure
11. *(Mental Health Dataset.csv)* demonstrated mood variability during the session, with fluctuations in affective tone that appeared reactive to perceived demands and interpersonal cues

---

### `PSYCHOSOCIAL_OBS` — Psychosocial Context

1. identified significant family-related stressors as primary psychosocial contributors to current functional difficulties, including interpersonal conflict and perceived relational instability
2. reported occupational and financial concerns as salient psychosocial stressors, with observable impact on daily functioning, emotional stability, and future planning capacity
3. described relational difficulties within the family system that appeared to contribute substantially to the presenting functional concerns and current affective presentation
4. identified multiple concurrent psychosocial stressors spanning interpersonal, occupational, and economic domains, suggesting elevated cumulative stress load and reduced adaptive capacity
5. reported limited access to social support networks, which appeared to amplify the impact of identified psychosocial stressors on current emotional and functional status
6. described psychosocial history marked by significant life transitions and role disruptions that have cumulatively impacted adaptive functioning and stress resilience
7. reported that socioeconomic constraints substantially limit access to mental health resources, educational opportunities, and community participation, contributing to cumulative functional burden
8. identified school-related stressors including academic pressure, peer relational difficulties, and performance demands as significant contributors to the current presentation
9. described a psychosocial environment characterized by limited predictability and elevated interpersonal conflict, with observed impact on sense of safety, trust, and emotional regulation
10. reported that cultural and familial expectations regarding achievement, role obligations, and emotional expression contribute significantly to the experienced psychosocial burden
11. *(Philippine NSMHW Report / NSMHW Project Briefer)* described psychosocial stressors consistent with population-level trends identified in Philippine mental health surveillance data, including economic burden, family conflict, and limited service access
12. *(Philippine NSMHW Report)* reported barriers to mental health help-seeking including stigma, cost, and limited availability of culturally-sensitive services, consistent with documented challenges in the Philippine context
13. *(Mental Health Dataset.csv)* disclosed a family history of mental health difficulties relevant to current risk and protective factor assessment in the context of the Philippine Mental Health Act (RA 11036)

---

### `STRESS_OBS` — Stress Indicators

1. demonstrated physiological and behavioral indicators of chronic stress activation, including persistent tension, irritability, and reduced recovery capacity between stressor exposures
2. exhibited stress response patterns consistent with prolonged psychosocial burden, including diminished resilience, heightened reactivity, and impaired recovery between demands
3. reported cumulative stressor exposure across multiple life domains, with insufficient coping resources to adequately buffer the associated functional impact on daily performance
4. showed behavioral signs of stress-related functional compromise, including disruptions in sleep, appetite, concentration, and interpersonal engagement
5. demonstrated inconsistent stress tolerance, maintaining adequate functioning under baseline conditions but showing significant behavioral deterioration under acute stressor exposure
6. reported chronic stress exposure related to role obligations and environmental demands, with observable impact on energy level, concentration, and overall sense of wellbeing
7. exhibited stress sensitization patterns, with minor stressors eliciting disproportionate behavioral responses consistent with reduced stress buffer capacity
8. described work- or school-related stress as the primary ongoing stressor, with reported spillover effects on sleep quality, appetite, and quality of interpersonal relationships
9. demonstrated behavioral stress responses including increased somatization, withdrawal, and reduced engagement in previously valued activities during periods of high demand
10. reported difficulty returning to baseline functioning following stressor exposure, suggesting impaired allostatic regulation and elevated cumulative stress burden
11. *(StressLevelDataset.csv)* presented with a behavioral and self-reported profile consistent with elevated stress burden, with identifiable impact across sleep, functioning, and interpersonal engagement
12. *(Stress_Dataset.csv)* reported experiencing both performance-enhancing and distressing stress, with the cumulative stress load currently appearing to exceed available coping and support resources

---

### `APPETITE_OBS` — Appetite / Nutritional Functioning

1. reported notable changes in appetite and eating patterns, with associated fluctuations in energy level and physical vitality corroborated during the clinical interview
2. endorsed appetite disturbances consistent with stress-related eating pattern disruption, including either significant reduction or increased consumption beyond typical personal baseline
3. described irregular eating patterns and reduced appetite that appeared correlated with mood fluctuations and heightened psychosocial stress exposure
4. reported appetite changes accompanied by reduced interest in food preparation and meal planning, reflecting broader motivational and self-care deficits
5. demonstrated behavioral indicators of somatic stress response, including appetite dysregulation and gastrointestinal discomfort endorsed as recurring concerns
6. described weight changes and altered eating frequency that appeared temporally correlated with onset of current psychosocial stressors and mood disruption
7. reported increased stress-related eating characterized by consumption of comfort foods and irregular meal timing, inconsistent with previous baseline eating patterns
8. endorsed significant reduction in appetite and food intake, with reported weight loss and reduced nutritional self-care that may contribute to observed physical fatigue and reduced vitality
9. demonstrated patterns of nutritional dysregulation linked to affective fluctuations, with appetite serving as a behaviorally observable indicator of overall psychosocial load
10. described eating pattern disruptions that fluctuated with mood and stress levels, suggesting appetite sensitivity as a somatic marker of the current psychological presentation
11. *(Psychological_Assessment_Dataset.csv)* endorsed significant changes in appetite including increased cravings and irregular meal timing correlated with current stress and mood disturbance

---

### `SELF_CONCEPT_OBS` — Self-Concept / Self-Esteem

1. expressed a negative self-concept characterized by heightened self-criticism, perceived personal inadequacy, and limited recognition of individual strengths and accomplishments
2. demonstrated reduced self-efficacy, with observable hesitancy in task initiation and repeated verbal minimization of personal capabilities throughout the evaluation
3. reported experiencing persistent self-doubt and difficulty attributing success to internal factors, reflecting a potentially unstable and self-critical self-concept
4. showed evidence of a developing but fragile sense of personal identity, with observable sensitivity to perceived evaluation and tendency toward social comparison
5. demonstrated generally intact self-concept under neutral conditions, though performance contexts evoked notable self-critical verbalizations and avoidance of challenging tasks
6. reported a pattern of negative self-attribution wherein failures are internalized and successes are attributed to external or situational factors rather than personal competence
7. exhibited verbal self-deprecation across multiple domains of competence, with minimal spontaneous recognition of personal strengths or past accomplishments during the interview
8. described identity-related uncertainty and difficulty articulating a stable sense of personal values, goals, or direction, particularly within interpersonal and occupational contexts
9. demonstrated behavioral self-monitoring and performance anxiety linked to perfectionistic self-standards and fear of negative evaluation by significant others
10. showed evidence of contingent self-worth, with self-esteem closely tied to perceived performance outcomes and interpersonal acceptance, resulting in emotional vulnerability to perceived failure
11. *(StressLevelDataset.csv)* presented with markedly reduced self-esteem as observed through self-referential statements, task avoidance, and reluctance to articulate personal strengths or achievements

---

### `SOCIAL_SUPPORT_OBS` — Social Support

1. reported limited availability of reliable social support, with reduced access to meaningful interpersonal connections during periods of heightened psychosocial stress
2. described a contracted social network that provides inconsistent support, with limited reciprocal exchange of emotional validation and practical assistance when needed
3. identified at least one reliable support figure within the immediate family system, though broader community and peer-level support appeared insufficient for current functional needs
4. reported utilizing family connections as the primary source of emotional support, with limited engagement in peer networks or community-based social and recreational activities
5. demonstrated awareness of the importance of social support while reporting significant barriers to accessing and maintaining supportive interpersonal relationships
6. described reliance on a single primary support person, creating an asymmetric support dynamic that may place excessive burden on that relational resource over time
7. reported that cultural norms around stoicism and self-reliance have historically limited willingness to seek and accept social support from available resources
8. described social isolation as a current concern, with reduced participation in group activities, peer interactions, and community-level social engagement
9. identified peer support and shared recreational activities as potentially protective factors, though current barriers limit consistent access to these resources
10. reported that existing social support, while valued, does not consistently meet emotional and practical support needs, resulting in residual feelings of isolation and loneliness
11. *(StressLevelDataset.csv)* endorsed low perceived social support across relational domains, with limited availability of persons who can provide consistent emotional validation and practical assistance
12. *(Philippine NSMHW Report)* reported limited engagement with community-based mental health resources and support groups, reflecting the broader challenge of under-resourced community mental health infrastructure in the Philippine context

---

### `ADAPTIVE_BEHAVIOR_OBS` — Adaptive Behavior (Neurodevelopmental)

1. demonstrated age-appropriate self-care and independent living skills as reported by caregiver, with functional competencies generally consistent with developmental expectations across key adaptive domains
2. showed emerging adaptive behavior competencies, with identified support needs in organizational planning, time management, and community-based participation domains
3. demonstrated variability in adaptive functioning across settings, with stronger performance in familiar structured environments compared to novel or unstructured contexts
4. exhibited functional independence in basic self-care domains, though caregiver-reported support needs were identified for complex multi-step tasks and independent community navigation
5. caregiver-reported adaptive behavior profile suggested relative strengths in social reciprocity and daily routine adherence, alongside areas of challenge in executive and organizational domains
6. demonstrated adequate functional self-care skills within familiar home routines, with greater support needs reported for generalization of adaptive skills to novel community contexts
7. showed age-appropriate daily living competencies in foundational domains, with emerging skills in community participation that required continued scaffolding and guided practice
8. reported adaptive behavior profile reflects a mixed pattern of strengths and challenges, with caregiver support currently compensating for identified deficits in organizational and sequential task domains
9. *(StudentPerformanceFactors.csv)* caregiver reported history of learning difficulties with prior tutoring support, suggesting adaptive strategies have been developed to accommodate the identified academic profile

---

### `COMMUNICATION_OBS` — Communication (Neurodevelopmental)

1. demonstrated age-appropriate receptive language comprehension, with expressive language showing some reduction in spontaneous complexity and narrative elaboration
2. exhibited functional pragmatic communication skills in structured contexts, though spontaneous conversational initiation and topic maintenance appeared variable
3. showed intact comprehension of instructions and direct questions, with expressive language marked by occasional word retrieval pauses and reduced narrative coherence
4. demonstrated adequate functional communication for the assessment context, with observable differences in communication style across familiar and unfamiliar conversational topics
5. caregiver report indicated a communication profile consistent with developmental variation, with relative strengths in comprehension compared to expressive and pragmatic language domains
6. demonstrated literal language comprehension with limited evidence of inferential or figurative language processing, consistent with an observed concrete cognitive style
7. showed adequate communication for basic social exchange, with greater difficulty sustaining extended discourse, managing conversational repair, and taking the perspective of the listener
8. demonstrated communication profile reflecting strengths in structured, context-supported exchanges alongside challenges in open-ended, pragmatically complex communicative contexts

---

### `SENSORY_OBS` — Sensory Processing (Neurodevelopmental)

1. caregiver reported behavioral responses consistent with sensory processing differences, particularly in auditory and tactile domains, affecting participation in daily and community activities
2. demonstrated observable sensory sensitivity to environmental stimuli during the evaluation, including heightened responsiveness to ambient auditory stimuli and physical proximity
3. reported patterns of sensory-seeking and sensory-avoidant behavior across domains, consistent with an atypical sensory processing profile affecting comfort and environmental adaptability
4. caregiver endorsed sensory processing challenges that impact participation in group settings, transitions between environments, and responses to novel sensory exposures
5. demonstrated adaptive sensory management strategies in familiar contexts, though generalization to novel sensory environments appeared limited without external support
6. sensory reactivity profile as reported by caregiver suggested hyper-responsiveness to specific sensory domains requiring ongoing environmental accommodation and behavioral support
7. showed behavioral regulatory challenges in sensory-demanding environments, with observable discomfort in crowded, noisy, or unpredictable sensory contexts
8. caregiver-reported sensory processing differences appear to contribute to behavioral dysregulation patterns observed in transitions, group participation, and novel environmental demands

---

### `ACADEMIC_OBS` — Academic Functioning (Neurodevelopmental)

1. demonstrated academic functioning profile marked by variable performance across subjects, with greater relative competency in areas aligned with documented learning strengths
2. reported academic performance challenges that appeared related to identified attentional and motivational factors rather than limited intellectual capacity
3. exhibited reduced academic engagement and learning motivation, with caregiver-reported decline in school performance corroborated by behavioral observations during the evaluation
4. showed academic functional profile consistent with learning support needs, with identified areas of relative strength that can be leveraged in individualized educational planning
5. demonstrated patterns of academic underperformance that appeared attributable to systemic factors including attendance irregularities, limited study resource access, and elevated stress burden
6. *(StudentPerformanceFactors.csv)* caregiver and self-report data indicated reduced study hours and attendance irregularities as contributing factors to observed academic performance concerns
7. *(StudentPerformanceFactors.csv)* exhibited academic functioning below reported prior attainment levels, with identified peer influence and extracurricular competing demands as potential moderating factors

---

### `OCCUPATIONAL_OBS` — Occupational Functioning (Pre-Employment)

1. demonstrated task-focused behavioral orientation and systematic problem-solving approach during structured work-analogue tasks presented throughout the evaluation
2. exhibited behavioral consistency and methodical work style during the assessment, with observable preference for structured environments and clearly defined performance expectations
3. showed adequate role-following behavior and compliance with procedural instructions, suggesting functional capacity for structured occupational demands in supervised contexts
4. demonstrated professional presentation and appropriate behavioral responsiveness in the evaluative context, consistent with basic occupational role expectations
5. exhibited variable task persistence across assessment conditions, maintaining consistent effort on preferred task types but showing reduced engagement with ambiguous or open-ended demands
6. showed capacity for sustained work engagement within time-bounded tasks, with organized and sequential approach to task completion across the evaluation context
7. demonstrated adequate occupational readiness indicators including punctuality, appropriate attire, and compliance with assessment procedures, suggestive of functional employment orientation
8. exhibited structured problem-solving behavior and ability to self-organize within clearly defined task parameters, consistent with readiness for supervised occupational placement
9. *(Employee Attrition datasets)* demonstrated behavioral indicators suggestive of appropriate occupational engagement and role-relevant motivation, with observable investment in the evaluative process
10. *(Employee Attrition datasets)* exhibited functional occupational orientation consistent with adequate job involvement, though areas for growth in autonomous task management and self-directed performance were noted

---

### `INTERPERSONAL_OBS` — Interpersonal Style (Pre-Employment)

1. demonstrated professional and appropriately courteous interpersonal presentation throughout the evaluation, with responsive communication style toward the examiner
2. exhibited generally adequate interpersonal skills in the structured assessment context, though limited spontaneous social initiation suggested reduced proactivity in peer-level interactions
3. showed capacity for cooperative and collaborative behavioral orientation in structured dyadic interaction, with performance variability under ambiguous or unstructured interpersonal conditions
4. demonstrated awareness of interpersonal boundaries and professional norms in the evaluation context, with appropriate deference and turn-taking in communicative exchanges
5. exhibited variable interpersonal warmth across the session, demonstrating greater social comfort in task-oriented exchanges and increased behavioral guardedness in open-ended social contexts
6. demonstrated functional interpersonal skills including basic perspective-taking, appropriate affective responsiveness, and adherence to conversational norms in the evaluation context
7. showed polite and cooperative interpersonal style throughout the assessment, with evident capacity for role-appropriate interaction within structured professional contexts
8. demonstrated interpersonal profile reflecting adequate relational skills for workplace contexts, with noted areas for development in unsolicited social initiation and unstructured peer interaction
9. *(IBM HR Analytics / Employee Attrition datasets)* exhibited relationship-oriented interpersonal style with moderate social initiative, consistent with capacity for functional collegial engagement within a structured workplace environment
10. *(IBM HR Analytics / Employee Attrition datasets)* demonstrated interpersonal flexibility appropriate for team-based environments, though preference for clear role definition and procedural clarity was noted throughout the evaluation

---

### `WORK_LIFE_BALANCE_OBS` — Work-Life Balance (Pre-Employment)

1. *(HR-Employee-Attrition.csv / Employee Attrition datasets)* reported difficulties maintaining a sustainable balance between occupational demands and personal recovery time, with associated impact on energy, mood, and interpersonal functioning
2. *(HR-Employee-Attrition.csv / Employee Attrition datasets)* demonstrated awareness of work-life boundary challenges, with self-reported tendency to prioritize occupational demands over personal self-care and social engagement
3. *(HR-Employee-Attrition.csv / Employee Attrition datasets)* endorsed experiencing role overload during peak demand periods, with observable impact on motivation, concentration, and emotional resilience
4. *(HR-Employee-Attrition.csv / Employee Attrition datasets)* described patterns of occupational stress spillover into personal domains, with reduced quality of leisure time and personal relationships noted as current concerns
5. *(HR-Employee-Attrition.csv / Employee Attrition datasets)* reported adequate management of occupational and personal demands under baseline conditions, though resilience under sustained high-demand periods was identified as an area for development

---

### `RISK_ELEVATED_OBS` — Safety Risk: Elevated

1. The client currently presents with significant psychological risk factors, including reported thoughts of self-harm. This presentation warrants immediate clinical attention and active safety planning.
2. Clinical interview and behavioral observation revealed risk indicators that require urgent assessment and intervention by a licensed clinician. A safety plan should be established without delay.
3. Elevated risk indicators were identified during the current evaluation, including statements or behavioral patterns consistent with self-directed harm. Immediate follow-up and safety planning are clinically indicated.

> *(Sourced from: Suicide_Detection.csv contextual indicators; PAP Code of Ethics clinical safety framework)*

---

### `RISK_NONE_OBS` — Safety Risk: None Identified

1. No active indicators of risk to self or others were elicited during the present assessment. Routine monitoring is recommended as part of ongoing clinical care.
2. Safety screening conducted during the evaluation did not reveal active indicators of suicidal ideation, self-harm, or harm to others. Continued monitoring is encouraged.
3. The current assessment did not identify active risk indicators. Protective factors including identified social support and help-seeking behavior were noted.

---

### Narrative Section Leads (Rotation)

#### `NEURO_FINDINGS_LEAD`
1. Taken together, the behavioral and developmental observations gathered during this neurodevelopmental assessment provide a qualitative basis for clinical impression.
2. Integration of the developmental history, direct behavioral observations, and clinical interview yields the following overall impression for this neurodevelopmental evaluation.
3. The observational findings from this neurodevelopmental assessment, considered alongside background developmental history, are summarized below.

#### `CLINICAL_FINDINGS_LEAD`
1. Integrating the affective, behavioral, and psychosocial observations from this clinical psychological assessment, the following clinical impression is offered.
2. The clinical observations and interview findings for this assessment, when considered within the context of the presenting concerns, support the following impression.
3. Based on direct clinical observation and structured interview, the overall clinical impression for this evaluation is as follows.

#### `PRE_EMP_FINDINGS_LEAD`
1. The behavioral and cognitive observations recorded during this pre-employment psychological evaluation are summarized in the following overall impression.
2. Integrating observations of cognitive functioning, interpersonal style, and behavioral consistency, the following employment-relevant impression is offered.
3. The following overall impression is derived from behavioral observation, clinical interview, and administered assessment procedures relevant to occupational functioning.

---

## 10. Recommendation Pools

Banks rotated to populate the main `recommendations` section alongside fragment-injected recommendations.

### `CLINICAL_REC_POOL`

1. Individual psychotherapy is recommended to address the observed emotional and behavioral concerns within a structured therapeutic relationship.
2. Psychoeducation regarding the observed stress indicators and coping patterns is recommended as a first-line supportive intervention.
3. A structured routine incorporating regular sleep, physical activity, and social engagement may support emotional regulation and overall functioning.
4. Consider a psychiatric consultation if observed affective and somatic patterns persist or intensify beyond the current level of functioning.
5. Monitor symptom trajectory over the next 3–6 months and reassess if functional impairment in daily activities increases.
6. Encourage development of a diversified coping repertoire, including adaptive strategies such as mindfulness, social support, and structured problem-solving.
7. Family or systems-level support may benefit the client, particularly where relational stressors are contributing to the presenting concerns.
8. *(RA 11036 alignment)* Referral to a licensed Filipino mental health professional familiar with culturally informed therapeutic approaches is encouraged, in alignment with the Philippine Mental Health Act (RA 11036).
9. Sleep hygiene intervention is recommended, including structured bedtime routines, reduction of stimulant exposure prior to sleep, and regularization of the sleep-wake schedule.
10. Social support mobilization — including reconnection with family, peer, and community networks — is recommended as an adjunct to individual therapeutic intervention.
11. Appetite and nutritional self-care should be monitored and addressed within the therapeutic frame, given the observed association between eating disruptions and psychosocial stress.
12. Engagement in meaningful purposeful activity — including vocational, recreational, or community-based participation — is encouraged to support motivational engagement and sense of personal agency.
13. Crisis safety planning should be discussed in the therapeutic context if the clinical picture includes any risk indicators, in accordance with BPS and PAP clinical safety standards.
14. Regular review of therapeutic progress is recommended at 3-month intervals, with reassessment of functional domains including mood, sleep, appetite, concentration, and interpersonal engagement.
15. *(RA 11036 / NSMHW)* Connection with available community mental health resources is encouraged, including LGU-based mental health programs aligned with the Philippine Mental Health Act (RA 11036).
16. Referral to the National Center for Mental Health (NCMH) or affiliated regional mental health services is recommended if access to private therapeutic services is limited.
17. Psychoeducation regarding mental health stigma and the importance of help-seeking is recommended for the client and immediate family, consistent with NSMHW public awareness objectives.
18. *(Indicators_of_Anxiety_or_Depression CSV)* Behavioral activation strategies targeting gradual re-engagement with previously valued activities are recommended to address identified anhedonia and withdrawal patterns.

---

### `NEURO_REC_POOL`

1. Coordinate findings with the educational team, caregivers, and relevant specialists to develop a consistent and responsive support plan.
2. Consider individualized educational or developmental support strategies tailored to the observed profile of strengths and challenges.
3. Pursue functional assessment across home and school environments to provide a more comprehensive developmental picture.
4. Reassessment is recommended within 12–18 months, or sooner if significant developmental changes or regression are observed.
5. Psychoeducation for caregivers regarding the observed behavioral patterns is strongly encouraged to promote consistent environmental management.
6. Consider referral to related services (e.g., speech-language therapy, occupational therapy) based on observed functional domains of concern.
7. Regular monitoring by a developmental pediatrician or allied health professional is recommended to track progress over time.
8. Establish structured home routines with predictable schedules and clear behavioral expectations to support adaptive functioning and reduce transition-related dysregulation.
9. Encourage participation in social skills development programs or peer-mediated learning environments to support pragmatic and relational competency.
10. Provide sensory-supportive accommodations in home and school environments as appropriate to the identified sensory processing profile.
11. Collaborate with school personnel to develop and implement individualized educational accommodations or modifications that address the identified functional profile.
12. Caregiver training on evidence-based behavioral management strategies and developmental scaffolding techniques is recommended to promote consistent support across settings.
13. Consider referral for psychological support services to address emotional and behavioral regulation challenges that may be associated with the observed developmental profile.
14. Maintain open communication among the family system, educational team, and treating clinicians to ensure responsive adjustment of support strategies as developmental needs evolve.
15. *(StudentPerformanceFactors.csv)* Encourage strengthened parental or caregiver involvement in academic support and home-based learning reinforcement, given the documented association between parental engagement and academic outcomes.
16. *(Philippine NSMHW context)* Explore access to community-based tutoring and educational support resources, particularly for families with limited access to private supplemental instruction.

---

### `PRE_EMP_REC_POOL`

1. Findings should be interpreted within the full context of the applicant's background, work history, and the specific demands of the target role.
2. Continued behavioral observation during a structured onboarding or probationary period is advised to corroborate assessment impressions.
3. If placed, provide structured orientation and clear performance expectations to support initial role adjustment.
4. Assign a designated peer or mentor during the initial employment phase to support social integration and role clarity.
5. Periodic check-ins with a supervisor or HR representative are recommended during the first six months of employment.
6. Consider role-specific fit when assigning initial responsibilities, prioritizing tasks aligned with observed cognitive and behavioral strengths.
7. Re-evaluation may be conducted if significant role demands change or if occupational performance concerns arise post-placement.
8. Findings from this psychological evaluation should supplement — and not replace — other evidence-based selection criteria in the final placement decision.
9. An initial trial placement in a supervised, structured role environment is recommended prior to assignment to high-autonomy or high-complexity responsibilities.
10. Employee wellness resources, including access to Employee Assistance Programs (EAP) or occupational health support, are encouraged to maintain the applicant's psychological wellbeing post-placement.
11. Strengths identified during this evaluation should be leveraged in initial role assignment to support early confidence-building and positive performance experience.
12. Communication style preferences and interpersonal behavioral patterns observed during evaluation should inform the onboarding supervisor's approach to initial role coaching and feedback delivery.
13. If occupational adjustment difficulties are observed post-placement, early referral to occupational health or employee counseling resources is recommended rather than extended performance management.
14. Team integration activities and structured social onboarding are recommended to support the applicant's interpersonal adjustment to the assigned work group.
15. *(Employee Attrition datasets)* Attention to work-life balance, perceived fairness of recognition, and career development opportunities is recommended as part of the onboarding experience to reduce early attrition risk.
16. *(Employee Attrition datasets)* Consider the applicant's job satisfaction and environmental fit indicators when determining role assignment, given the documented relationship between environment satisfaction and occupational retention.

---

## 11. Implementation Notes

### Fragment Injection Order (per Section)

| Generated Section | Fragment Source(s) Appended |
|---|---|
| `test_results` | `early_development`, `test_results_fragment`, `emotional_functioning` |
| `findings` | `social_functioning`, `defense_mechanisms`, `clinical_impression`, `adaptive_functioning`, `summary_impression`, `overall_results_fragment`, `impression_conclusion_fragment`, `risk` |
| `recommendations` | `recommendations_safety` (IMMEDIATE ACTION — first) → rotated pool → `recommendations_fragment` → `footer` |

### Rule Evaluation Order

1. **Safety Override** (X-RK-00, X-RK-01, X-RC-CRISIS, X-RK-LOW) — always evaluated first
2. **Type-specific fragment rules** (C-*, N-*, E-*)
3. **Observation bank rotation** — fills sections where no fragment was injected
4. **Z-FOOTER** — always appended last

### Backward Compatibility

- If `additional_data.clinical_signals` / `neuro_signals` / `employment_signals` are absent, the engine falls back to pure rotation-bank generation. No fragment rules fire.
- `risk_flag` always defaults to `NONE` in the UI. Clinicians must explicitly set it to `ELEVATED` via the Clinical Indicators Panel.

### Philippine Mental Health References

- **RA 11036** — Philippine Mental Health Act (2018). Basis for referral language and community-based resource mentions.
- **NCMH Crisis Hotline** — 1553 (National Center for Mental Health)
- **DOH iCare Hotline** — 1800-10-HOPEPH
- **LGU Programs** — Referenced as accessible community-based mental health services per RA 11036 implementation guidelines.
- **NSMHW** — National Survey on Mental Health and Well-Being. Provides population-level benchmarks cited in psychosocial observation entries.

### Ethical Constraints

- All output is **observational only** — not diagnostic.
- Language must remain consistent with **DSM-5-TR observational terminology** applied non-diagnostically.
- Reports require **licensed psychometrician/psychologist review** before release (Z-FOOTER).
- **PAP Code of Ethics** governs all clinical language choices.
- No machine learning, no probabilistic inference — purely deterministic IF-THEN rules.
