const db = require('./config/db');

/**
 * Run on server startup to ensure the database schema
 * supports all required notification types and tables.
 * Safe to run multiple times (idempotent).
 */
async function runMigrations() {
  try {
    console.log('🔄 Running database migrations...');

    // 1. Fix notification type constraint
    await db.query(`ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check`);
    await db.query(`
      ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
      CHECK (type IN (
        'case_assigned', 'review_needed', 'validation_ready',
        'report_ready', 'system_alert', 'general',
        'appointment', 'teleconference', 'report',
        'community', 'intake'
      ))
    `);

    // 2. (Removed old intake_forms JSONB migration — see migration #16 for correct schema)

    // 3. Add status column to articles
    const colCheck = await db.query(`
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'articles' AND column_name = 'status'
    `);
    if (colCheck.rows.length === 0) {
      await db.query(`
        ALTER TABLE articles ADD COLUMN status VARCHAR(20) DEFAULT 'approved'
      `);
    }

    // ── Community Module Tables ─────────────────────────

    // 4. Extend articles with category, tags, is_anonymous
    const catCheck = await db.query(`
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'articles' AND column_name = 'category'
    `);
    if (catCheck.rows.length === 0) {
      await db.query(`ALTER TABLE articles ADD COLUMN category VARCHAR(50)`);
      await db.query(`ALTER TABLE articles ADD COLUMN tags TEXT[] DEFAULT '{}'`);
      await db.query(`ALTER TABLE articles ADD COLUMN is_anonymous BOOLEAN DEFAULT FALSE`);
    }

    // 5. FAQs table
    await db.query(`
      CREATE TABLE IF NOT EXISTS faqs (
        id           SERIAL PRIMARY KEY,
        question     TEXT NOT NULL,
        answer       TEXT NOT NULL,
        category     VARCHAR(50),
        author_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
        is_published BOOLEAN DEFAULT TRUE,
        sort_order   INTEGER DEFAULT 0,
        created_at   TIMESTAMP DEFAULT NOW(),
        updated_at   TIMESTAMP DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_faqs_category ON faqs (category)`);

    // 6. Forum threads
    await db.query(`
      CREATE TABLE IF NOT EXISTS forum_threads (
        id            SERIAL PRIMARY KEY,
        author_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
        title         VARCHAR(255) NOT NULL,
        content       TEXT NOT NULL,
        category      VARCHAR(50),
        tags          TEXT[] DEFAULT '{}',
        is_anonymous  BOOLEAN DEFAULT FALSE,
        is_pinned     BOOLEAN DEFAULT FALSE,
        status        VARCHAR(20) DEFAULT 'pending'
                      CHECK (status IN ('pending','approved','rejected','locked','flagged')),
        reply_count   INTEGER DEFAULT 0,
        created_at    TIMESTAMP DEFAULT NOW(),
        updated_at    TIMESTAMP DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_threads_status ON forum_threads (status)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_threads_category ON forum_threads (category)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_threads_created ON forum_threads (created_at DESC)`);

    // 7. Forum replies
    await db.query(`
      CREATE TABLE IF NOT EXISTS forum_replies (
        id            SERIAL PRIMARY KEY,
        thread_id     INTEGER NOT NULL REFERENCES forum_threads(id) ON DELETE CASCADE,
        parent_id     INTEGER REFERENCES forum_replies(id) ON DELETE CASCADE,
        author_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
        content       TEXT NOT NULL,
        is_anonymous  BOOLEAN DEFAULT FALSE,
        status        VARCHAR(20) DEFAULT 'approved'
                      CHECK (status IN ('approved','hidden','flagged')),
        created_at    TIMESTAMP DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_replies_thread ON forum_replies (thread_id)`);

    // 8. Unified votes (polymorphic)
    await db.query(`
      CREATE TABLE IF NOT EXISTS votes (
        id            SERIAL PRIMARY KEY,
        user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        content_type  VARCHAR(20) NOT NULL
                      CHECK (content_type IN ('article','faq','thread','reply')),
        content_id    INTEGER NOT NULL,
        vote_value    SMALLINT NOT NULL CHECK (vote_value IN (-1, 1)),
        created_at    TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id, content_type, content_id)
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_votes_content ON votes (content_type, content_id)`);

    // 9. Content flags (moderation)
    await db.query(`
      CREATE TABLE IF NOT EXISTS content_flags (
        id            SERIAL PRIMARY KEY,
        reporter_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
        content_type  VARCHAR(20) NOT NULL
                      CHECK (content_type IN ('article','thread','reply','faq')),
        content_id    INTEGER NOT NULL,
        reason        VARCHAR(50) NOT NULL
                      CHECK (reason IN ('inappropriate','spam','harassment',
                                        'misinformation','crisis_content','other')),
        details       TEXT,
        status        VARCHAR(20) DEFAULT 'pending'
                      CHECK (status IN ('pending','reviewed','dismissed','actioned')),
        reviewed_by   INTEGER REFERENCES users(id),
        review_note   TEXT,
        reviewed_at   TIMESTAMP,
        created_at    TIMESTAMP DEFAULT NOW(),
        UNIQUE(reporter_id, content_type, content_id)
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_flags_status ON content_flags (status)`);

    // 10. Data deletion log (right to be forgotten audit)
    await db.query(`
      CREATE TABLE IF NOT EXISTS data_deletion_log (
        id                    SERIAL PRIMARY KEY,
        user_id               INTEGER,
        deleted_by            INTEGER REFERENCES users(id),
        content_types_deleted TEXT[],
        item_count            INTEGER,
        reason                VARCHAR(50) DEFAULT 'user_request',
        created_at            TIMESTAMP DEFAULT NOW()
      )
    `);

    // 11. Moderation keywords (customizable profanity blacklist)
    await db.query(`
      CREATE TABLE IF NOT EXISTS moderation_keywords (
        id          SERIAL PRIMARY KEY,
        word        VARCHAR(100) NOT NULL,
        normalized  VARCHAR(100) NOT NULL,
        category    VARCHAR(50) NOT NULL
                    CHECK (category IN ('profanity','racist_slur','homophobic_slur',
                                        'transphobic_slur','ableist_slur','sexist',
                                        'threat','bullying','harassment','spam','other')),
        severity    VARCHAR(20) NOT NULL CHECK (severity IN ('mild','moderate','severe')),
        language    VARCHAR(10) DEFAULT 'en',
        is_active   BOOLEAN DEFAULT TRUE,
        added_by    INTEGER REFERENCES users(id),
        created_at  TIMESTAMP DEFAULT NOW(),
        updated_at  TIMESTAMP DEFAULT NOW(),
        UNIQUE(normalized, language)
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_keywords_active ON moderation_keywords (is_active)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_keywords_lang ON moderation_keywords (language)`);

    // 12. Article import fields (source_url, featured_image, original_author, published_date)
    const srcUrlCheck = await db.query(`
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'articles' AND column_name = 'source_url'
    `);
    if (srcUrlCheck.rows.length === 0) {
      await db.query(`ALTER TABLE articles ADD COLUMN source_url TEXT`);
      await db.query(`ALTER TABLE articles ADD COLUMN featured_image TEXT`);
      await db.query(`ALTER TABLE articles ADD COLUMN original_author VARCHAR(200)`);
      await db.query(`ALTER TABLE articles ADD COLUMN published_date TIMESTAMP`);
      await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_articles_source_url ON articles (source_url) WHERE source_url IS NOT NULL`);
    }

    // 13. Login attempts & account lockout tracking
    await db.query(`
      CREATE TABLE IF NOT EXISTS login_attempts (
        id            SERIAL PRIMARY KEY,
        email         VARCHAR(255) NOT NULL,
        ip_address    VARCHAR(45),
        attempt_type  VARCHAR(20) DEFAULT 'failed_login'
                      CHECK (attempt_type IN ('failed_login','lockout','unlock')),
        locked_until  TIMESTAMP,
        created_at    TIMESTAMP DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_login_attempts_email ON login_attempts (email)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_login_attempts_created ON login_attempts (created_at DESC)`);

    // 14. Teleconference sessions
    await db.query(`
      CREATE TABLE IF NOT EXISTS teleconference_sessions (
        id                      SERIAL PRIMARY KEY,
        meeting_id              INTEGER REFERENCES meetings(id) ON DELETE SET NULL,
        psychologist_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
        client_id               INTEGER REFERENCES users(id) ON DELETE SET NULL,
        access_token            VARCHAR(128) NOT NULL,
        twilio_room_sid         VARCHAR(100),
        twilio_room_name        VARCHAR(200),
        session_status          VARCHAR(20) DEFAULT 'scheduled'
                                CHECK (session_status IN ('scheduled','active','ended','cancelled')),
        recording_enabled       BOOLEAN DEFAULT FALSE,
        recording_consent_given BOOLEAN DEFAULT FALSE,
        recording_url           TEXT,
        started_at              TIMESTAMP,
        ended_at                TIMESTAMP,
        created_at              TIMESTAMP DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_teleconf_status ON teleconference_sessions (session_status)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_teleconf_psych ON teleconference_sessions (psychologist_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_teleconf_client ON teleconference_sessions (client_id)`);

    // 15. Session logs (audit trail)
    await db.query(`
      CREATE TABLE IF NOT EXISTS session_logs (
        id              SERIAL PRIMARY KEY,
        session_id      INTEGER NOT NULL REFERENCES teleconference_sessions(id) ON DELETE CASCADE,
        event_type      VARCHAR(50) NOT NULL,
        participant_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
        details         TEXT,
        created_at      TIMESTAMP DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_session_logs_session ON session_logs (session_id)`);

    // 16. Intake forms
    await db.query(`
      CREATE TABLE IF NOT EXISTS intake_forms (
        id                    SERIAL PRIMARY KEY,
        user_id               INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        full_name             VARCHAR(200),
        nickname              VARCHAR(100),
        age                   INTEGER,
        date_of_birth         DATE,
        gender                VARCHAR(50),
        civil_status          VARCHAR(50),
        address               TEXT,
        cellphone             VARCHAR(30),
        home_phone            VARCHAR(30),
        email                 VARCHAR(200),
        concern_description   TEXT,
        reason_for_counseling TEXT,
        since_when            VARCHAR(200),
        how_long              VARCHAR(200),
        therapy_before        TEXT,
        medication_history    TEXT,
        preferred_schedule    VARCHAR(200),
        language_preference   VARCHAR(100),
        session_modality      VARCHAR(100),
        counselor_gender_pref VARCHAR(50),
        is_minor              VARCHAR(10),
        guardian_name         VARCHAR(200),
        guardian_contact      VARCHAR(100),
        guardian_relation     VARCHAR(100),
        minor_other_reason    TEXT,
        emergency_name        VARCHAR(200),
        emergency_address     TEXT,
        emergency_contact     VARCHAR(100),
        emergency_email       VARCHAR(200),
        emergency_relation    VARCHAR(100),
        status                VARCHAR(20) DEFAULT 'pending'
                              CHECK (status IN ('pending','reviewed','approved','rejected')),
        created_at            TIMESTAMP DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_intake_forms_user ON intake_forms (user_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_intake_forms_status ON intake_forms (status)`);

    // 16b. Fix existing intake_forms tables that have old JSONB-only schema — add individual columns if missing
    const colFullName = await db.query(`
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'intake_forms' AND column_name = 'full_name'
    `);
    if (colFullName.rows.length === 0) {
      console.log('🔄 Adding individual columns to intake_forms (fixing old JSONB schema)...');
      await db.query(`ALTER TABLE intake_forms ADD COLUMN IF NOT EXISTS full_name VARCHAR(200)`);
      await db.query(`ALTER TABLE intake_forms ADD COLUMN IF NOT EXISTS nickname VARCHAR(100)`);
      await db.query(`ALTER TABLE intake_forms ADD COLUMN IF NOT EXISTS age INTEGER`);
      await db.query(`ALTER TABLE intake_forms ADD COLUMN IF NOT EXISTS date_of_birth DATE`);
      await db.query(`ALTER TABLE intake_forms ADD COLUMN IF NOT EXISTS gender VARCHAR(50)`);
      await db.query(`ALTER TABLE intake_forms ADD COLUMN IF NOT EXISTS civil_status VARCHAR(50)`);
      await db.query(`ALTER TABLE intake_forms ADD COLUMN IF NOT EXISTS address TEXT`);
      await db.query(`ALTER TABLE intake_forms ADD COLUMN IF NOT EXISTS cellphone VARCHAR(30)`);
      await db.query(`ALTER TABLE intake_forms ADD COLUMN IF NOT EXISTS home_phone VARCHAR(30)`);
      await db.query(`ALTER TABLE intake_forms ADD COLUMN IF NOT EXISTS email VARCHAR(200)`);
      await db.query(`ALTER TABLE intake_forms ADD COLUMN IF NOT EXISTS concern_description TEXT`);
      await db.query(`ALTER TABLE intake_forms ADD COLUMN IF NOT EXISTS reason_for_counseling TEXT`);
      await db.query(`ALTER TABLE intake_forms ADD COLUMN IF NOT EXISTS since_when VARCHAR(200)`);
      await db.query(`ALTER TABLE intake_forms ADD COLUMN IF NOT EXISTS how_long VARCHAR(200)`);
      await db.query(`ALTER TABLE intake_forms ADD COLUMN IF NOT EXISTS therapy_before TEXT`);
      await db.query(`ALTER TABLE intake_forms ADD COLUMN IF NOT EXISTS medication_history TEXT`);
      await db.query(`ALTER TABLE intake_forms ADD COLUMN IF NOT EXISTS preferred_schedule VARCHAR(200)`);
      await db.query(`ALTER TABLE intake_forms ADD COLUMN IF NOT EXISTS language_preference VARCHAR(100)`);
      await db.query(`ALTER TABLE intake_forms ADD COLUMN IF NOT EXISTS session_modality VARCHAR(100)`);
      await db.query(`ALTER TABLE intake_forms ADD COLUMN IF NOT EXISTS counselor_gender_pref VARCHAR(50)`);
      await db.query(`ALTER TABLE intake_forms ADD COLUMN IF NOT EXISTS is_minor VARCHAR(10)`);
      await db.query(`ALTER TABLE intake_forms ADD COLUMN IF NOT EXISTS guardian_name VARCHAR(200)`);
      await db.query(`ALTER TABLE intake_forms ADD COLUMN IF NOT EXISTS guardian_contact VARCHAR(100)`);
      await db.query(`ALTER TABLE intake_forms ADD COLUMN IF NOT EXISTS guardian_relation VARCHAR(100)`);
      await db.query(`ALTER TABLE intake_forms ADD COLUMN IF NOT EXISTS minor_other_reason TEXT`);
      await db.query(`ALTER TABLE intake_forms ADD COLUMN IF NOT EXISTS emergency_name VARCHAR(200)`);
      await db.query(`ALTER TABLE intake_forms ADD COLUMN IF NOT EXISTS emergency_address TEXT`);
      await db.query(`ALTER TABLE intake_forms ADD COLUMN IF NOT EXISTS emergency_contact VARCHAR(100)`);
      await db.query(`ALTER TABLE intake_forms ADD COLUMN IF NOT EXISTS emergency_email VARCHAR(200)`);
      await db.query(`ALTER TABLE intake_forms ADD COLUMN IF NOT EXISTS emergency_relation VARCHAR(100)`);
      // Make form_data nullable (it's no longer used for new submissions)
      await db.query(`ALTER TABLE intake_forms ALTER COLUMN form_data DROP NOT NULL`);
      console.log('✅ intake_forms columns added successfully.');
    }

    // 17. Appointments (linked to intake forms)
    await db.query(`
      CREATE TABLE IF NOT EXISTS appointments (
        id                    SERIAL PRIMARY KEY,
        intake_form_id        INTEGER REFERENCES intake_forms(id) ON DELETE SET NULL,
        client_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        staff_id              INTEGER REFERENCES users(id) ON DELETE SET NULL,
        preferred_datetime    TIMESTAMP NOT NULL,
        approved_datetime     TIMESTAMP,
        proposed_datetime     TIMESTAMP,
        status                VARCHAR(30) DEFAULT 'pending_review'
                              CHECK (status IN (
                                'pending_review','approved','reschedule_proposed',
                                'confirmed','declined','cancelled'
                              )),
        staff_notes           TEXT,
        client_response_notes TEXT,
        modality              VARCHAR(50),
        created_at            TIMESTAMP DEFAULT NOW(),
        updated_at            TIMESTAMP DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_appt_client ON appointments (client_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_appt_staff ON appointments (staff_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_appt_status ON appointments (status)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_appt_approved_dt ON appointments (approved_datetime)`);

    // ── Psychological Report Module Tables ─────────────────

    // 18. Report templates
    await db.query(`
      CREATE TABLE IF NOT EXISTS report_templates (
        id              SERIAL PRIMARY KEY,
        name            VARCHAR(200) NOT NULL,
        description     TEXT,
        template_type   VARCHAR(50) NOT NULL
                        CHECK (template_type IN ('neurodevelopmental','clinical','pre_employment')),
        sections_config JSONB NOT NULL DEFAULT '[]',
        is_active       BOOLEAN DEFAULT TRUE,
        created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at      TIMESTAMP DEFAULT NOW(),
        updated_at      TIMESTAMP DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_report_tpl_type ON report_templates (template_type)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_report_tpl_active ON report_templates (is_active)`);

    // 18b. Fix existing report_templates tables missing sections_config and created_by columns
    const colSectionsConfig = await db.query(`
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'report_templates' AND column_name = 'sections_config'
    `);
    if (colSectionsConfig.rows.length === 0) {
      console.log('🔄 Adding missing columns to report_templates...');
      await db.query(`ALTER TABLE report_templates ADD COLUMN sections_config JSONB NOT NULL DEFAULT '[]'`);
      await db.query(`ALTER TABLE report_templates ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(id) ON DELETE SET NULL`);
      console.log('✅ report_templates columns added.');
    }

    // ── Canonical section definitions for each template type ───────
    const NEURO_SECTIONS = [
      { key: 'identifying_information', title: 'Identifying Information', required: true },
      { key: 'reason_for_referral', title: 'Reason for Referral', required: true },
      { key: 'early_developmental_background', title: 'Early Developmental and Background', required: true },
      { key: 'behavioral_observation_mse', title: 'Behavioral Observation and Mental Status Exam', required: true },
      { key: 'assessment_battery', title: 'Assessment Battery', required: true },
      { key: 'test_results', title: 'Test Results and Interpretation', required: true },
      { key: 'findings', title: 'Findings', required: true },
      { key: 'recommendations', title: 'Recommendations', required: true },
      { key: 'prepared_approved_by', title: 'Prepared By and Approved By', required: true }
    ];

    const CLINICAL_SECTIONS = [
      { key: 'identifying_information', title: 'Identifying Information', required: true },
      { key: 'reason_for_referral', title: 'Reason for Referral', required: true },
      { key: 'case_history', title: 'Case History', required: true },
      { key: 'general_observations_interview_mse', title: 'General Observations, Interview, and MSE', required: true },
      { key: 'assessment_tests_methods', title: 'Assessment Tests/Methods', required: true },
      { key: 'assessment_results_interpretations', title: 'Assessment Results and Interpretations', required: true },
      { key: 'summary_formulation', title: 'Summary Formulation', required: true },
      { key: 'diagnostic_impression', title: 'Diagnostic Impression', required: true },
      { key: 'recommendation', title: 'Recommendation', required: true },
      { key: 'prepared_approved_by', title: 'Prepared By and Approved By', required: true }
    ];

    const PRE_EMP_SECTIONS = [
      { key: 'identifying_information', title: 'Identifying Information', required: true },
      { key: 'reason_for_referral', title: 'Reason for Referral', required: true },
      { key: 'client_background', title: 'Client Background', required: true },
      { key: 'assessment_tools_procedure', title: 'Assessment Tools/Procedure', required: true,
        default_content: 'Test Administered                              | Date Administered\n-----------------------------------------------|-----------------\nMAS Mental Ability Test                         |\nPurdue Non-Language Test                        |\nDifferential Aptitude Test - Fifth Edition      |\nBarOn EQ Inventory: Short Version               |\nMasaklaw na Panukat ng Loob                     |\nBasic Personality Inventory                     |\nHouse-Tree-Person Test                          |\nSacks Sentence Completion Test                  |\nMental Status Exam                              |'
      },
      { key: 'overall_result', title: 'Overall Psychological Assessment Result', required: true },
      { key: 'impression_conclusion', title: 'Impression and Conclusion', required: true },
      { key: 'recommendation', title: 'Recommendation', required: true },
      { key: 'prepared_approved_by', title: 'Prepared By and Approved By', required: true }
    ];

    // 18c. Update existing templates with correct section configs
    const neuroJson = JSON.stringify(NEURO_SECTIONS);
    const clinicalJson = JSON.stringify(CLINICAL_SECTIONS);
    const preEmpJson = JSON.stringify(PRE_EMP_SECTIONS);

    await db.query(`UPDATE report_templates SET sections_config = $1 WHERE template_type = 'neurodevelopmental'`, [neuroJson]);
    await db.query(`UPDATE report_templates SET sections_config = $1 WHERE template_type = 'clinical'`, [clinicalJson]);
    await db.query(`UPDATE report_templates SET sections_config = $1 WHERE template_type = 'pre_employment'`, [preEmpJson]);
    console.log('✅ Template sections updated to latest structure.');

    // Seed default templates if none exist
    const tplCount = await db.query(`SELECT COUNT(*) AS cnt FROM report_templates`);
    if (parseInt(tplCount.rows[0].cnt, 10) === 0) {
      await db.query(`
        INSERT INTO report_templates (name, description, template_type, sections_config) VALUES
        ('Neurodevelopmental / Educational Assessment', 'Comprehensive assessment for neurodevelopmental and educational evaluations including ASD screening, cognitive, and adaptive behavior assessments.', 'neurodevelopmental', $1),
        ('Clinical Psychological Assessment', 'Standard clinical psychological assessment for psychotherapy and counseling, diagnostic evaluation, personality assessment, and emotional functioning.', 'clinical', $2),
        ('Pre-Employment Psychological Assessment', 'Psychological evaluation for employment screening including cognitive aptitude, personality profiling, and behavioral assessment.', 'pre_employment', $3)
      `, [neuroJson, clinicalJson, preEmpJson]);
      console.log('✅ Default report templates seeded.');
    }

    // 19. Psychological reports
    await db.query(`
      CREATE TABLE IF NOT EXISTS psychological_reports (
        id                SERIAL PRIMARY KEY,
        template_id       INTEGER NOT NULL REFERENCES report_templates(id) ON DELETE RESTRICT,
        psychologist_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        client_name       VARCHAR(200) NOT NULL,
        client_age        INTEGER,
        client_gender     VARCHAR(50),
        date_of_assessment DATE,
        status            VARCHAR(20) DEFAULT 'draft'
                          CHECK (status IN ('draft','submitted','approved','rejected','finalized')),
        current_version   INTEGER DEFAULT 1,
        created_at        TIMESTAMP DEFAULT NOW(),
        updated_at        TIMESTAMP DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_psy_reports_psych ON psychological_reports (psychologist_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_psy_reports_status ON psychological_reports (status)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_psy_reports_created ON psychological_reports (created_at DESC)`);

    // 20. Report sections
    await db.query(`
      CREATE TABLE IF NOT EXISTS report_sections (
        id              SERIAL PRIMARY KEY,
        report_id       INTEGER NOT NULL REFERENCES psychological_reports(id) ON DELETE CASCADE,
        section_key     VARCHAR(100) NOT NULL,
        section_title   VARCHAR(200) NOT NULL,
        content         TEXT DEFAULT '',
        sort_order      INTEGER DEFAULT 0,
        created_at      TIMESTAMP DEFAULT NOW(),
        updated_at      TIMESTAMP DEFAULT NOW(),
        UNIQUE(report_id, section_key)
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_report_sections_report ON report_sections (report_id)`);

    // 20b. Fix report_sections created externally with wrong FK and NOT NULL constraints
    //   - report_id FK may point to 'reports' instead of 'psychological_reports'
    //   - template_section_id may be NOT NULL but the app code doesn't populate it
    const fkCheck = await db.query(`
      SELECT ccu.table_name AS foreign_table
      FROM information_schema.table_constraints tc
      JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
      JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
      WHERE tc.table_name = 'report_sections'
        AND tc.constraint_type = 'FOREIGN KEY'
        AND kcu.column_name = 'report_id'
    `);
    if (fkCheck.rows.length > 0 && fkCheck.rows[0].foreign_table !== 'psychological_reports') {
      console.log(`🔄 Fixing report_sections FK: report_id points to '${fkCheck.rows[0].foreign_table}', should be 'psychological_reports'...`);
      await db.query(`ALTER TABLE report_sections DROP CONSTRAINT IF EXISTS report_sections_report_id_fkey`);
      await db.query(`ALTER TABLE report_sections ADD CONSTRAINT report_sections_report_id_fkey FOREIGN KEY (report_id) REFERENCES psychological_reports(id) ON DELETE CASCADE`);
      console.log('✅ report_sections FK fixed to reference psychological_reports.');
    }

    const colTplSectionId = await db.query(`
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'report_sections' AND column_name = 'template_section_id' AND is_nullable = 'NO'
    `);
    if (colTplSectionId.rows.length > 0) {
      console.log('🔄 Fixing report_sections: making template_section_id nullable...');
      await db.query(`ALTER TABLE report_sections ALTER COLUMN template_section_id DROP NOT NULL`);
      console.log('✅ report_sections template_section_id is now nullable.');
    }

    // 21. Assessment data
    await db.query(`
      CREATE TABLE IF NOT EXISTS assessment_data (
        id                      SERIAL PRIMARY KEY,
        report_id               INTEGER NOT NULL REFERENCES psychological_reports(id) ON DELETE CASCADE,
        tests_administered      TEXT[] DEFAULT '{}',
        observational_notes     TEXT DEFAULT '',
        behavioral_observations TEXT DEFAULT '',
        interview_findings      TEXT DEFAULT '',
        additional_data         JSONB DEFAULT '{}',
        created_at              TIMESTAMP DEFAULT NOW(),
        updated_at              TIMESTAMP DEFAULT NOW(),
        UNIQUE(report_id)
      )
    `);

    // 22. Test scores
    await db.query(`
      CREATE TABLE IF NOT EXISTS test_scores (
        id                  SERIAL PRIMARY KEY,
        report_id           INTEGER NOT NULL REFERENCES psychological_reports(id) ON DELETE CASCADE,
        test_name           VARCHAR(200) NOT NULL,
        test_category       VARCHAR(100),
        raw_score           NUMERIC,
        percentile_score    NUMERIC,
        standard_score      NUMERIC,
        scaled_score        NUMERIC,
        descriptive_range   VARCHAR(100),
        interpretation_notes TEXT DEFAULT '',
        created_at          TIMESTAMP DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_test_scores_report ON test_scores (report_id)`);

    // 23. Generated narratives
    await db.query(`
      CREATE TABLE IF NOT EXISTS generated_narratives (
        id              SERIAL PRIMARY KEY,
        report_id       INTEGER NOT NULL REFERENCES psychological_reports(id) ON DELETE CASCADE,
        section_key     VARCHAR(100) NOT NULL,
        rule_id         VARCHAR(100),
        narrative_text  TEXT NOT NULL,
        is_edited       BOOLEAN DEFAULT FALSE,
        created_at      TIMESTAMP DEFAULT NOW(),
        updated_at      TIMESTAMP DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_narratives_report ON generated_narratives (report_id)`);

    // 24. Report versions
    await db.query(`
      CREATE TABLE IF NOT EXISTS report_versions (
        id                SERIAL PRIMARY KEY,
        report_id         INTEGER NOT NULL REFERENCES psychological_reports(id) ON DELETE CASCADE,
        version_number    INTEGER NOT NULL,
        editor_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
        sections_snapshot JSONB NOT NULL,
        modified_sections TEXT[] DEFAULT '{}',
        notes             TEXT,
        created_at        TIMESTAMP DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_report_versions_report ON report_versions (report_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_report_versions_num ON report_versions (report_id, version_number DESC)`);

    // 24b. Fix report_versions created externally with wrong column names or FK
    //   - Column may be 'snapshot_data' instead of 'sections_snapshot'
    //   - Column may be 'change_summary' instead of 'notes'
    //   - report_id FK may point to 'reports' instead of 'psychological_reports'
    const colSnapshotData = await db.query(`
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'report_versions' AND column_name = 'snapshot_data'
    `);
    if (colSnapshotData.rows.length > 0) {
      console.log('🔄 Fixing report_versions: renaming snapshot_data -> sections_snapshot...');
      await db.query(`ALTER TABLE report_versions RENAME COLUMN snapshot_data TO sections_snapshot`);
      console.log('✅ report_versions column snapshot_data renamed to sections_snapshot.');
    }

    const colChangeSummary = await db.query(`
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'report_versions' AND column_name = 'change_summary'
    `);
    if (colChangeSummary.rows.length > 0) {
      console.log('🔄 Fixing report_versions: renaming change_summary -> notes...');
      await db.query(`ALTER TABLE report_versions RENAME COLUMN change_summary TO notes`);
      console.log('✅ report_versions column change_summary renamed to notes.');
    }

    const rvFkCheck = await db.query(`
      SELECT ccu.table_name AS foreign_table
      FROM information_schema.table_constraints tc
      JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
      JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
      WHERE tc.table_name = 'report_versions'
        AND tc.constraint_type = 'FOREIGN KEY'
        AND kcu.column_name = 'report_id'
    `);
    if (rvFkCheck.rows.length > 0 && rvFkCheck.rows[0].foreign_table !== 'psychological_reports') {
      console.log(`🔄 Fixing report_versions FK: report_id points to '${rvFkCheck.rows[0].foreign_table}', should be 'psychological_reports'...`);
      await db.query(`ALTER TABLE report_versions DROP CONSTRAINT IF EXISTS report_versions_report_id_fkey`);
      await db.query(`ALTER TABLE report_versions ADD CONSTRAINT report_versions_report_id_fkey FOREIGN KEY (report_id) REFERENCES psychological_reports(id) ON DELETE CASCADE`);
      console.log('✅ report_versions FK fixed to reference psychological_reports.');
    }

    // 25. Report audit logs
    await db.query(`
      CREATE TABLE IF NOT EXISTS report_audit_logs (
        id              SERIAL PRIMARY KEY,
        report_id       INTEGER REFERENCES psychological_reports(id) ON DELETE SET NULL,
        user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
        action          VARCHAR(50) NOT NULL
                        CHECK (action IN ('created','edited','submitted','approved','rejected',
                                          'viewed','downloaded','version_restored','finalized',
                                          'template_created','template_updated','template_deleted')),
        details         TEXT,
        ip_address      VARCHAR(45),
        user_agent      TEXT,
        created_at      TIMESTAMP DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_report_audit_report ON report_audit_logs (report_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_report_audit_user ON report_audit_logs (user_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_report_audit_action ON report_audit_logs (action)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_report_audit_created ON report_audit_logs (created_at DESC)`);

    // 26. Report approvals
    await db.query(`
      CREATE TABLE IF NOT EXISTS report_approvals (
        id              SERIAL PRIMARY KEY,
        report_id       INTEGER NOT NULL REFERENCES psychological_reports(id) ON DELETE CASCADE,
        reviewer_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        decision        VARCHAR(20) NOT NULL CHECK (decision IN ('approved','rejected')),
        comments        TEXT,
        created_at      TIMESTAMP DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_report_approvals_report ON report_approvals (report_id)`);

    // 27. Report permissions
    await db.query(`
      CREATE TABLE IF NOT EXISTS report_permissions (
        id              SERIAL PRIMARY KEY,
        report_id       INTEGER NOT NULL REFERENCES psychological_reports(id) ON DELETE CASCADE,
        user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        permission      VARCHAR(20) NOT NULL CHECK (permission IN ('view','edit','approve','export')),
        granted_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at      TIMESTAMP DEFAULT NOW(),
        UNIQUE(report_id, user_id, permission)
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_report_perms_report ON report_permissions (report_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_report_perms_user ON report_permissions (user_id)`);

    // 28. Report signatures (e-signature placement, embedded into the PDF on export)
    //   image_data  → the signature image as a base64 data URL (PNG/JPEG)
    //   pos_x/pos_y → top-left position of the signature as a 0..1 fraction of the page
    //   width/height→ signature size as a 0..1 fraction of the page
    //   page_number → 1-indexed page the signature is stamped on
    await db.query(`
      CREATE TABLE IF NOT EXISTS report_signatures (
        id              SERIAL PRIMARY KEY,
        report_id       INTEGER NOT NULL REFERENCES psychological_reports(id) ON DELETE CASCADE,
        signer_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
        image_data      TEXT NOT NULL,
        pos_x           NUMERIC NOT NULL DEFAULT 0.6,
        pos_y           NUMERIC NOT NULL DEFAULT 0.85,
        width           NUMERIC NOT NULL DEFAULT 0.25,
        height          NUMERIC NOT NULL DEFAULT 0.08,
        page_number     INTEGER NOT NULL DEFAULT 1,
        created_at      TIMESTAMP DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_report_signatures_report ON report_signatures (report_id)`);

    console.log('✅ Database migrations complete.');
  } catch (err) {
    console.error('❌ Migration error (non-fatal):', err.message);
  }
}

module.exports = runMigrations;
