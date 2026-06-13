const db = require('./config/db');
const fs = require('fs');
const path = require('path');

/**
 * Run on server startup to ensure the database schema
 * supports all required notification types and tables.
 * Safe to run multiple times (idempotent).
 */
async function runMigrations() {
  try {
    console.log('🔄 Running database migrations...');

    // ── 0. Request & Concern tables (created FIRST, independently guarded) ──
    // The whole body of runMigrations() runs inside a single try/catch that
    // treats any failure as "non-fatal" and stops. Because the client_requests
    // tables used to be created near the very end (step #30), any earlier step
    // that threw would silently skip them — leaving the Request & Concern form's
    // INSERT to hit a missing relation and return a 500 Internal Server Error.
    // ensureRequestTables() runs up front and swallows its own errors, so these
    // tables are reliably created on every startup regardless of other steps.
    await ensureRequestTables();

    // Same rationale: critical feature columns are ensured up front in their own
    // guarded step so a later failing migration can never leave them missing.
    // (These previously lived deep in step #30+, so any earlier error skipped
    // them — producing "column photo_thumbnail does not exist" and breaking
    // staff verification.)
    await ensureFeatureColumns();

    // 1. Fix notification type constraint
    await db.query(`ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check`);
    await db.query(`
      ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
      CHECK (type IN (
        'case_assigned', 'review_needed', 'validation_ready',
        'report_ready', 'system_alert', 'general', 'request',
        'appointment', 'teleconference', 'report',
        'community', 'intake', 'payment', 'ticket'
      ))
    `);

    // 1b. Reconcile the `notification_category` ENUM with the canonical type list.
    // ---------------------------------------------------------------------------
    // Some databases carry a `notifications.category` column whose data type is a
    // Postgres ENUM named `notification_category`. That enum was created out of
    // band (it is not produced by these migrations or the bundled .sql schema),
    // so on those databases inserting a newer category such as 'ticket' fails with:
    //   invalid input value for enum notification_category: "ticket"
    // and the whole migration run aborts at the generic catch below
    // ("Migration error (non-fatal)").
    //
    // This step makes the enum tolerant: if (and only if) the enum type exists,
    // every canonical notification value missing from it is appended via
    // ALTER TYPE ... ADD VALUE IF NOT EXISTS. When the enum does not exist (the
    // common case — the column is a plain VARCHAR with a CHECK constraint), this
    // step does nothing. It is fully idempotent and safe to re-run.
    //
    // NOTE: `ALTER TYPE ... ADD VALUE` cannot run inside a transaction block, so
    // each value is added in its own autocommit statement (the pg Pool issues
    // each db.query() without an explicit surrounding BEGIN). Each ADD VALUE is
    // additionally wrapped in its own try/catch so a single failure can never
    // abort the broader migration.
    await ensureNotificationCategoryEnum();

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
        meeting_code            VARCHAR(20),
        twilio_room_sid         VARCHAR(100),
        twilio_room_name        VARCHAR(200),
        session_status          VARCHAR(20) DEFAULT 'scheduled'
                                CHECK (session_status IN ('scheduled','active','ended','cancelled')),
        recording_enabled       BOOLEAN DEFAULT FALSE,
        recording_consent_given BOOLEAN DEFAULT FALSE,
        recording_response      SMALLINT,
        recording_url           TEXT,
        started_at              TIMESTAMP,
        ended_at                TIMESTAMP,
        created_at              TIMESTAMP DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_teleconf_status ON teleconference_sessions (session_status)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_teleconf_psych ON teleconference_sessions (psychologist_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_teleconf_client ON teleconference_sessions (client_id)`);
    // Ensure new columns exist on older databases
    await db.query(`ALTER TABLE teleconference_sessions ADD COLUMN IF NOT EXISTS meeting_code VARCHAR(20)`);
    await db.query(`ALTER TABLE teleconference_sessions ADD COLUMN IF NOT EXISTS recording_response SMALLINT`);

    // 14b. Session participants (host + client + up to 3 staff)
    await db.query(`
      CREATE TABLE IF NOT EXISTS session_participants (
        id                SERIAL PRIMARY KEY,
        session_id        INTEGER NOT NULL REFERENCES teleconference_sessions(id) ON DELETE CASCADE,
        user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        participant_role  VARCHAR(20) NOT NULL DEFAULT 'staff'
                          CHECK (participant_role IN ('host','client','staff')),
        access_password   VARCHAR(20),
        admit_status      VARCHAR(20) NOT NULL DEFAULT 'waiting'
                          CHECK (admit_status IN ('waiting','admitted','denied')),
        joined_at         TIMESTAMP,
        created_at        TIMESTAMP DEFAULT NOW(),
        UNIQUE (session_id, user_id)
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_session_participants_session ON session_participants (session_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_session_participants_user ON session_participants (user_id)`);
    // Password removed from the teleconference flow — column kept but optional
    await db.query(`ALTER TABLE session_participants ALTER COLUMN access_password DROP NOT NULL`).catch(() => {});
    // Allow the 'invited' admit status: a provisioned participant who has NOT yet
    // attempted to join. They only move to 'waiting' when they try to enter.
    await db.query(`ALTER TABLE session_participants DROP CONSTRAINT IF EXISTS session_participants_admit_status_check`).catch(() => {});
    await db.query(`ALTER TABLE session_participants ADD CONSTRAINT session_participants_admit_status_check CHECK (admit_status IN ('invited','waiting','admitted','denied'))`).catch(() => {});

    // 14c. In-meeting chat messages
    await db.query(`
      CREATE TABLE IF NOT EXISTS session_messages (
        id          SERIAL PRIMARY KEY,
        session_id  INTEGER NOT NULL REFERENCES teleconference_sessions(id) ON DELETE CASCADE,
        user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
        message     TEXT NOT NULL,
        created_at  TIMESTAMP DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_session_messages_session ON session_messages (session_id, id)`);

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
        data_privacy_consent  BOOLEAN DEFAULT FALSE,
        created_at            TIMESTAMP DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_intake_forms_user ON intake_forms (user_id)`);
    // Intake forms no longer have a staff approve/reject validation step, so the
    // status column is removed (the appointment carries its own status instead).
    await db.query(`DROP INDEX IF EXISTS idx_intake_forms_status`).catch(() => {});
    await db.query(`ALTER TABLE intake_forms DROP COLUMN IF EXISTS status`).catch(() => {});

    // 16a. Ensure data_privacy_consent column exists on older intake_forms tables
    await db.query(`ALTER TABLE intake_forms ADD COLUMN IF NOT EXISTS data_privacy_consent BOOLEAN DEFAULT FALSE`);

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
    // Temporary review buffer holding the client's intake answers BEFORE payment
    // is verified. The official intake_forms row is only created (promoted from
    // this) once staff verify the payment; this is cleared on promotion.
    await db.query(`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS pending_intake_data JSONB`).catch(() => {});

    // 17b. Payments (payment-first booking — slot held until admin verifies)
    await db.query(`
      CREATE TABLE IF NOT EXISTS payments (
        id                   SERIAL PRIMARY KEY,
        reference_number     VARCHAR(40) UNIQUE NOT NULL,
        intake_form_id       INTEGER REFERENCES intake_forms(id) ON DELETE SET NULL,
        appointment_id       INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
        client_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        service_label        VARCHAR(200),
        payment_option       VARCHAR(10) NOT NULL
                             CHECK (payment_option IN ('half','full')),
        payment_method       VARCHAR(20) DEFAULT 'GCash',
        amount_due           NUMERIC(10,2) NOT NULL,
        total_fee            NUMERIC(10,2) NOT NULL,
        outstanding_balance  NUMERIC(10,2) DEFAULT 0,
        status               VARCHAR(20) DEFAULT 'pending'
                             CHECK (status IN ('pending','under_review','verified','expired','rejected')),
        proof_of_payment     TEXT,
        proof_filename       VARCHAR(255),
        proof_mime           VARCHAR(60),
        proof_uploaded_at    TIMESTAMP,
        verified_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
        verified_at          TIMESTAMP,
        admin_note           TEXT,
        rejection_reason     TEXT,
        expires_at           TIMESTAMP NOT NULL,
        created_at           TIMESTAMP DEFAULT NOW(),
        updated_at           TIMESTAMP DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_payments_client ON payments (client_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_payments_status ON payments (status)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_payments_appt ON payments (appointment_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_payments_ref ON payments (reference_number)`);

    // 17c. Track payment state directly on the appointment for slot reservation gating.
    await db.query(`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS payment_status VARCHAR(20) DEFAULT 'unpaid'`);

    // 17d. No-cancellation / no-refund acknowledgement the client must accept
    // before paying. Stored as 1 = agreed, 0 = not agreed (default).
    await db.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS agreed_no_cancellation SMALLINT NOT NULL DEFAULT 0`);

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

    // 19b. Read state + soft-delete (Trash) + archive support for the report dashboard.
    await db.query(`ALTER TABLE psychological_reports ADD COLUMN IF NOT EXISTS is_read BOOLEAN DEFAULT FALSE`);
    await db.query(`ALTER TABLE psychological_reports ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP`);
    await db.query(`ALTER TABLE psychological_reports ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_psy_reports_deleted ON psychological_reports (deleted_at)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_psy_reports_archived ON psychological_reports (archived_at)`);

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

    // 22. Test scores — REMOVED. The Test Scores feature was retired from the
    //     Report Generation module; drop the table so it is also removed from
    //     the database. (Safe/idempotent — narratives are now derived from
    //     assessment data only.)
    await db.query(`DROP TABLE IF EXISTS test_scores CASCADE`);

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
                                          'viewed','downloaded','version_restored','finalized','deleted','restored','archived','unarchived',
                                          'template_created','template_updated','template_deleted')),
        details         TEXT,
        ip_address      VARCHAR(45),
        user_agent      TEXT,
        created_at      TIMESTAMP DEFAULT NOW()
      )
    `);
    // 25b. Ensure existing tables allow the 'deleted' action (idempotent).
    await db.query(`ALTER TABLE report_audit_logs DROP CONSTRAINT IF EXISTS report_audit_logs_action_check`);
    await db.query(`
      ALTER TABLE report_audit_logs ADD CONSTRAINT report_audit_logs_action_check
      CHECK (action IN ('created','edited','submitted','approved','rejected',
                        'viewed','downloaded','version_restored','finalized','deleted','restored','archived','unarchived',
                        'template_created','template_updated','template_deleted'))
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

    // ── Landing-Page Website Management (Clinical Director CMS) ──

    // 28. Section ordering & visibility for the public landing page
    await db.query(`
      CREATE TABLE IF NOT EXISTS landing_sections (
        id            SERIAL PRIMARY KEY,
        section_key   VARCHAR(50) UNIQUE NOT NULL,
        display_name  VARCHAR(120) NOT NULL,
        sort_order    INTEGER DEFAULT 0,
        is_visible    BOOLEAN DEFAULT TRUE,
        created_at    TIMESTAMP DEFAULT NOW(),
        updated_at    TIMESTAMP DEFAULT NOW()
      )
    `);

    // 29. Editable text/structured content per section (flexible JSONB blob)
    await db.query(`
      CREATE TABLE IF NOT EXISTS landing_content (
        id            SERIAL PRIMARY KEY,
        section_key   VARCHAR(50) UNIQUE NOT NULL,
        content       JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
        updated_at    TIMESTAMP DEFAULT NOW()
      )
    `);

    // 30. "Meet the Team" members (add / delete / photo upload)
    // Images are stored on disk under backend/uploads/team/...; the columns
    // below hold only the file PATH (e.g. /uploads/team/thumbs/x.jpg).
    await db.query(`
      CREATE TABLE IF NOT EXISTS team_members (
        id              SERIAL PRIMARY KEY,
        name            VARCHAR(160) NOT NULL,
        role            VARCHAR(160),
        bio             TEXT,
        photo_thumbnail TEXT,
        photo_full      TEXT,
        sort_order      INTEGER DEFAULT 0,
        is_visible      BOOLEAN DEFAULT TRUE,
        created_at      TIMESTAMP DEFAULT NOW(),
        updated_at      TIMESTAMP DEFAULT NOW()
      )
    `);
    // Upgrade older databases: the thumbnail column used to be called "photo".
    await db.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'team_members' AND column_name = 'photo')
           AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'team_members' AND column_name = 'photo_thumbnail') THEN
          ALTER TABLE team_members RENAME COLUMN photo TO photo_thumbnail;
        END IF;
      END $$;
    `);
    // Backfill columns for databases created before the expanded-photo feature.
    await db.query(`ALTER TABLE team_members ADD COLUMN IF NOT EXISTS photo_thumbnail TEXT`);
    await db.query(`ALTER TABLE team_members ADD COLUMN IF NOT EXISTS photo_full TEXT`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_team_members_order ON team_members (sort_order)`);

    // ── Seed defaults (only when empty) so the CMS mirrors the current page ──
    await seedLandingDefaults(db);

    // ── 30. BPS Clients' Requests and Concerns (report tickets) ──
    // The table definitions live in ensureRequestTables() and are already
    // created up front (see step #0). The call below is a harmless, idempotent
    // safety net (CREATE TABLE IF NOT EXISTS) kept for readability of the
    // migration order.
    await ensureRequestTables();

    // ── 31. Activity logs (audit trail) — previously only in a side .sql file,
    // which meant databases built purely from migrations lacked the table and
    // any unguarded ActivityLog.log call crashed the request with a 500.
    await db.query(`
      CREATE TABLE IF NOT EXISTS activity_logs (
        id              SERIAL PRIMARY KEY,
        user_id         INTEGER       REFERENCES users(id) ON DELETE SET NULL,
        action          VARCHAR(100)  NOT NULL,
        resource_type   VARCHAR(50),
        resource_id     INTEGER,
        ip_address      VARCHAR(45),
        details         JSONB,
        created_at      TIMESTAMP     DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_activity_user_id ON activity_logs (user_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_activity_created_at ON activity_logs (created_at)`);

    // ── 32. Staff verification profile ──────────────────────────────
    // When a clinical director assigns a staff role to a user, that user must
    // complete a short verification (gender, specialization, position) the next
    // time they log in. Only staff who have completed it become eligible to be
    // chosen by clients in appointment scheduling (the intake form's counselor
    // picker). These columns hold that profile; staff_profile_completed is the
    // gate. All are nullable / default-false so existing rows are unaffected.
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS gender VARCHAR(20)`);
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS specialization VARCHAR(160)`);
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS position VARCHAR(160)`);
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS staff_profile_completed BOOLEAN DEFAULT FALSE`);

    // ── 33. Dedicated staff table ────────────────────────────────────
    // Staff records are being separated from the shared `users` table (which
    // historically held both clients and staff distinguished by `role`). This
    // table is the new home for staff accounts and powers the dedicated staff
    // login + Staff Management module. Every new account defaults to the 'staff'
    // role; the Clinical Director promotes/changes roles afterwards. Accounts are
    // created only through the internal (authenticated) management flow — there is
    // no public staff registration. `is_active` gates login (deactivate disables
    // sign-in without deleting the record).
    await db.query(`
      CREATE TABLE IF NOT EXISTS staff (
        staff_id      SERIAL PRIMARY KEY,
        first_name    VARCHAR(100),
        last_name     VARCHAR(100),
        gender        VARCHAR(20),
        email         VARCHAR(255) UNIQUE,
        username      VARCHAR(100) UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role          VARCHAR(40) NOT NULL DEFAULT 'staff'
                      CHECK (role IN ('staff','psychometrician','supervising_psychometrician',
                                      'qc_psychometrician','psychologist','clinical_director')),
        is_active     BOOLEAN DEFAULT TRUE,
        created_at    TIMESTAMP DEFAULT NOW(),
        updated_at    TIMESTAMP DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_staff_username ON staff (username)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_staff_email ON staff (email)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_staff_role ON staff (role)`);

    console.log('✅ Database migrations complete.');
  } catch (err) {
    console.error('❌ Migration error (non-fatal):', err.message);
  }
}

/**
 * Ensure the `notification_category` ENUM (when present) contains every
 * canonical notification value the application emits.
 *
 * Background
 * ----------
 * The bundled schema models the notification kind as a VARCHAR column named
 * `type` guarded by a CHECK constraint. Some live databases, however, were
 * provisioned with an additional `notifications.category` column whose type is
 * a Postgres ENUM called `notification_category`. That enum predates several
 * newer notification kinds (most notably 'ticket', added for the Clients'
 * Requests & Concerns module), so writing one of the newer values raises:
 *
 *   invalid input value for enum notification_category: "ticket"
 *
 * Because the enum is not defined anywhere in source control, we cannot simply
 * re-create it. Instead we *reconcile* it: detect the type, read its existing
 * labels, and append any missing canonical value. New values are added to the
 * end of the enum, which is always allowed and never reorders existing labels.
 *
 * Safety / idempotency
 * --------------------
 *  • Does nothing when the enum type does not exist (the common case).
 *  • `ADD VALUE IF NOT EXISTS` is itself idempotent; we additionally pre-filter
 *    against the labels already present so re-runs perform zero writes.
 *  • `ALTER TYPE ... ADD VALUE` cannot run inside a transaction block, so each
 *    value is added in its own autocommit statement and wrapped in try/catch so
 *    one failure can never abort the rest of the migration run.
 */
async function ensureNotificationCategoryEnum() {
  // Canonical set — kept in sync with the notifications_type_check constraint.
  const CANONICAL_VALUES = [
    'case_assigned', 'review_needed', 'validation_ready',
    'report_ready', 'system_alert', 'general', 'request',
    'appointment', 'teleconference', 'report',
    'community', 'intake', 'payment', 'ticket',
  ];

  try {
    // Read the labels that currently exist on the enum (empty when absent).
    const { rows } = await db.query(
      `SELECT e.enumlabel AS label
         FROM pg_type t
         JOIN pg_enum e ON e.enumtypid = t.oid
        WHERE t.typname = 'notification_category'`
    );

    // Enum type not present → nothing to reconcile.
    if (rows.length === 0) return;

    const existing = new Set(rows.map(r => r.label));
    const missing = CANONICAL_VALUES.filter(v => !existing.has(v));

    if (missing.length === 0) return; // already complete

    for (const value of missing) {
      try {
        // IF NOT EXISTS guards against a concurrent add; identifier is from our
        // own constant list (never user input), so simple interpolation is safe.
        await db.query(
          `ALTER TYPE notification_category ADD VALUE IF NOT EXISTS '${value}'`
        );
      } catch (innerErr) {
        console.error(
          `⚠️  Could not add '${value}' to notification_category enum:`,
          innerErr.message
        );
      }
    }
    console.log(
      `✅ notification_category enum reconciled (added: ${missing.join(', ')}).`
    );
  } catch (err) {
    // Never let enum reconciliation abort the wider migration run.
    console.error('⚠️  notification_category enum check skipped:', err.message);
  }
}

/**
 * Seed the landing-page CMS tables with the content that is currently
 * hard-coded into landingpage.html. Runs only when the tables are empty,
 * so it never overwrites a Clinical Director's later edits.
 */
async function seedLandingDefaults(db) {
  // 1. Sections (order + visibility)
  const secCount = await db.query('SELECT COUNT(*)::int AS c FROM landing_sections');
  if (secCount.rows[0].c === 0) {
    const sections = [
      ['hero',           'Hero / Welcome Banner'],
      ['services',       'Our Core Services'],
      ['team',           'Meet the Team'],
      ['mission_vision', 'Vision & Mission'],
      ['about',          'Why Choose Us'],
      ['cta',            'Call to Action'],
    ];
    for (let i = 0; i < sections.length; i++) {
      await db.query(
        `INSERT INTO landing_sections (section_key, display_name, sort_order, is_visible)
         VALUES ($1, $2, $3, TRUE)
         ON CONFLICT (section_key) DO NOTHING`,
        [sections[i][0], sections[i][1], i]
      );
    }
  }

  // 2. Content blobs
  const contentCount = await db.query('SELECT COUNT(*)::int AS c FROM landing_content');
  if (contentCount.rows[0].c === 0) {
    const defaults = {
      hero: {
        headline: 'BARCARSE\nPSYCHOLOGICAL\nSERVICES',
        description:
          'Barcarse Psychological Services (BPS) is a professional mental health clinic in Sampaloc, Manila, Philippines that provides psychological assessment, counseling, psychotherapy, and mental health programs for individuals, organizations, and communities.',
      },
      services: {
        label: 'What We Offer',
        heading: 'Our Core Services',
        subheading:
          'Evidence-based mental health services tailored to your unique needs, delivered with compassion and clinical excellence.',
        cards: [
          { title: 'Psychological Assessment', text: 'Comprehensive evaluations using standardized tools to understand cognitive, emotional, and behavioral functioning.' },
          { title: 'Counseling', text: 'Supportive therapeutic conversations to help you navigate life challenges, relationships, and personal growth.' },
          { title: 'Psychotherapy', text: 'Evidence-based therapeutic interventions including CBT, DBT, and other modalities for lasting mental wellness.' },
          { title: 'Mental Health Programs', text: 'Group workshops, community outreach, and organizational mental health programs for collective well-being.' },
        ],
      },
      team: {
        label: 'Meet the Team',
        heading: 'Specialists Dedicated to Your Well-being',
        subheading:
          'Our licensed psychologists and mental health professionals bring compassion, expertise, and evidence-based care to every session.',
      },
      mission_vision: {
        label: 'Who We Are',
        heading: 'Our Vision & Mission',
        subheading:
          'Guided by our commitment to quality and humane mental health care among Filipinos in workplaces, schools, and community settings.',
        vision_title: 'Vision',
        vision_text:
          'Envisioned to provide quality and humane mental health care among Filipinos — both people in the workplaces, school and community settings — through extension and development projects and programs. Through our professional services in counseling, psychotherapy, interventions, psychological assessments, and lifelong learning workshops, BPS dreams of helping and reaching more people with psychological problems cope with the demands of life through our different approaches bounded by western approaches and culture-based techniques.',
        values: ['Oneness','Individual Responsibility','Genuine Care','Inclusivity','Diversity','Equality','Helping','Creativity','Self-Fulfillment','Individual Freedom','Commitment','Openness','Acceptance'],
        mission_title: 'Mission',
        mission_text:
          'The BPS existence is to cater professional services for people in need of psychological help in a scientific, research, and experienced based in dealing with clients on their diverse dilemma, psychological problems and needs to become fully functioning person.',
        goals: [
          'Promote community awareness on the relevance of providing professional help.',
          'Provide appropriate psychological assessment according to purpose.',
          'Apply western and culture-based counseling approaches based on need.',
          'Utilize expertise of BPS Psychologist, Psychometricians and Counselors.',
          'Create lifelong learning in helping the helping professionals.',
          'Collaborate in schools, universities, corporations and communities in persuading people to address mental health needs to be catered by licensed and registered professional as required by law.',
        ],
        history_title: 'Brief History',
        history_text:
          'Barcarse Psychological Services was founded last March 8, 2023 and blessed the first Clinic located at the 4th Floor, Arizona Tower, 838 P. Campa Street, Sampaloc, Manila. The BS Psychology of Colegio De San Juan De Letran, Intramuros, Manila were the first Undergraduate Clinical Interns followed by the PhD in Clinical Psychology from the Polytechnic University of the Philippines, Manila as its first graduate level intern followed by Centro Escolar University Manila, Pamantasan ng Lungsod ng Maynila, University of Santo Tomas Manila, Adamson University, Manuel S. Enverga University Foundation Candelaria, Quezon, Batangas State University, De La Salle University Dasmarinas, CAP Colleges Foundation Makati City and San Beda University Manila and BSMA Psychology and Counseling of Philippine Normal University Manila. Clinic services in different cases of both online and face to face were opened.',
        contact_email: 'bpsychserv2023@gmail.com',
        contact_phone: '0966-263-3964 / 0915-871-9886 / 0905-255-2098',
        contact_phone2: '0285534483',
      },
      about: {
        label: 'Why Choose Us',
        heading: 'Trusted by Individuals & Organizations',
        subheading:
          'We combine clinical expertise with genuine compassion to provide holistic mental health care in a safe, welcoming environment.',
        stats: [
          { number: '500+', label: 'Clients Served' },
          { number: '10+',  label: 'Licensed Specialists' },
          { number: '98%',  label: 'Client Satisfaction' },
          { number: '5+',   label: 'Years of Service' },
        ],
        features: [
          { title: 'Confidential & Secure', text: 'HIPAA-compliant practices with AES-256 encryption for all your data and sessions.' },
          { title: 'Evidence-Based Approaches', text: 'Our team uses proven therapeutic modalities backed by scientific research and clinical evidence.' },
          { title: 'Holistic Care', text: 'We address mind, body, and social well-being for comprehensive mental health support.' },
        ],
      },
      cta: {
        label: 'Take the First Step',
        heading: 'Your Mental Health Matters',
        subheading:
          "Whether you're seeking support for yourself, your family, or your organization — we're here to help. Book a consultation today.",
        primary_label: 'Book a Consultation',
        secondary_label: 'Contact Us',
      },
    };

    for (const [key, blob] of Object.entries(defaults)) {
      await db.query(
        `INSERT INTO landing_content (section_key, content)
         VALUES ($1, $2::jsonb)
         ON CONFLICT (section_key) DO NOTHING`,
        [key, JSON.stringify(blob)]
      );
    }
  }

  // 3. Team members
  // The seed file holds only file PATHS (no Base64). The actual images ship in
  // backend/uploads/team/{thumbs,full}/ and are served from /uploads.
  let seedMembers = null;
  try {
    const seedPath = path.join(__dirname, 'seed', 'team-seed.json');
    if (fs.existsSync(seedPath)) {
      const parsed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
      if (Array.isArray(parsed) && parsed.length) seedMembers = parsed;
    }
  } catch (e) {
    console.warn('⚠️  Could not read team-seed.json:', e.message);
  }

  const teamCount = await db.query('SELECT COUNT(*)::int AS c FROM team_members');
  if (teamCount.rows[0].c === 0) {
    if (seedMembers) {
      for (let i = 0; i < seedMembers.length; i++) {
        const m = seedMembers[i];
        await db.query(
          `INSERT INTO team_members (name, role, bio, photo_thumbnail, photo_full, sort_order, is_visible)
           VALUES ($1, $2, $3, $4, $5, $6, TRUE)`,
          [m.name, m.role || null, m.bio || null,
           m.photo_thumbnail || null, m.photo_full || null, i]
        );
      }
    } else {
      const fallback = [
        ['Dr. Maria Barcarse', 'Clinical Psychologist',  'Founder · Assessment & Therapy'],
        ['Dr. James Tan',       'Counseling Psychologist','CBT · Anxiety & Mood'],
        ['Dr. Amara Okafor',    'Child Psychologist',     'Pediatric Evaluation'],
        ['Dr. Rohan Kapoor',    'Psychotherapist',        'Trauma-Informed Care'],
        ['Sofia Williams, RPm', 'Psychometrician',        'Testing & Scoring'],
        ['Elena Marquez, RGC',  'Guidance Counselor',     'Career & Family'],
        ['Dr. Liam Cruz',       'Neuropsychologist',      'Cognitive Assessment'],
        ['Nadia Reyes, RPsy',   'Community Programs Lead','Outreach & Workshops'],
      ];
      for (let i = 0; i < fallback.length; i++) {
        await db.query(
          `INSERT INTO team_members (name, role, bio, sort_order, is_visible)
           VALUES ($1, $2, $3, $4, TRUE)`,
          [fallback[i][0], fallback[i][1], fallback[i][2], i]
        );
      }
    }
  } else if (seedMembers) {
    // Idempotent upgrade: convert any legacy Base64 / NULL photo values left by
    // an earlier build into the new on-disk file paths (matched by name).
    for (const m of seedMembers) {
      await db.query(
        `UPDATE team_members
            SET photo_thumbnail = $2, photo_full = $3, updated_at = NOW()
          WHERE name = $1
            AND (photo_thumbnail IS NULL OR photo_thumbnail LIKE 'data:%'
                 OR photo_full IS NULL OR photo_full LIKE 'data:%')`,
        [m.name, m.photo_thumbnail || null, m.photo_full || null]
      );
    }
  }
}

/**
 * Create the BPS Clients' Requests & Concerns tables (report tickets) and their
 * replies table. Self-contained and idempotent (CREATE TABLE IF NOT EXISTS), it
 * swallows its own errors so it can be called up front without aborting the rest
 * of runMigrations(). This is what makes the Request & Concern form resilient:
 * the tables are guaranteed to exist regardless of whether any other migration
 * step succeeds or fails.
 *
 * Columns map 1:1 to what requestController.js reads/writes:
 *   ticket_number ............ Ticket/Reference Number
 *   client_family_name /
 *     client_given_name /
 *     client_mi .............. Client Name
 *   guardian_name ............ Parent/Guardian Name
 *   assessment_date .......... Date of Assessment
 *   contact_number ........... Contact Number
 *   center_branch ............ Center and Branch
 *   nature ................... Nature of Request
 *   concerns / concern_other . Concerns Encountered
 *   description .............. Brief Description
 *   attachment(+name/mime) ... Attached File (if any)
 *   status ................... Ticket Status
 *   assigned_staff_id ........ Assigned Staff
 *   resolution_note .......... Resolution Notes
 *   created_at / updated_at .. Timestamps
 * (payment_* and report_* support the additional-copies fee + report release flow.)
 */
async function ensureRequestTables() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS client_requests (
        id                  SERIAL PRIMARY KEY,
        ticket_number       VARCHAR(40) UNIQUE NOT NULL,
        client_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        client_family_name  VARCHAR(120),
        client_given_name   VARCHAR(120),
        client_mi           VARCHAR(10),
        guardian_name       VARCHAR(200),
        assessment_date     DATE,
        contact_number      VARCHAR(40),
        center_branch       VARCHAR(200),
        nature              VARCHAR(30) NOT NULL CHECK (nature IN ('additional_copies','report_concern')),
        concerns            JSONB,
        concern_other       TEXT,
        description         TEXT,
        attachment          TEXT,
        attachment_name     VARCHAR(255),
        attachment_mime     VARCHAR(100),
        status              VARCHAR(20) NOT NULL DEFAULT 'submitted'
                            CHECK (status IN ('submitted','under_review','resolved','closed')),
        assigned_staff_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
        deadline            DATE,
        resolution_note     TEXT,
        payment_required    BOOLEAN DEFAULT FALSE,
        payment_amount      NUMERIC(10,2),
        payment_status      VARCHAR(20) DEFAULT 'none'
                            CHECK (payment_status IN ('none','awaiting_payment','under_review','verified','rejected')),
        payment_proof       TEXT,
        payment_proof_name  VARCHAR(255),
        payment_reference   VARCHAR(40),
        report_file         TEXT,
        report_filename     VARCHAR(255),
        report_mime         VARCHAR(100),
        report_released_at  TIMESTAMP,
        created_at          TIMESTAMP DEFAULT NOW(),
        updated_at          TIMESTAMP DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_creq_client ON client_requests (client_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_creq_status ON client_requests (status)`);

    await db.query(`
      CREATE TABLE IF NOT EXISTS client_request_replies (
        id          SERIAL PRIMARY KEY,
        request_id  INTEGER NOT NULL REFERENCES client_requests(id) ON DELETE CASCADE,
        user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
        message     TEXT NOT NULL,
        created_at  TIMESTAMP DEFAULT NOW()
      )
    `);

    // ── Report-Requests workflow columns (added idempotently) ──
    // These support the Clinical Director "Report Requests" workflow:
    // review approve/reject, payment verification + receipt, and the final
    // "Send" step that delivers the report to the client's Generated Reports.
    await db.query(`ALTER TABLE client_requests ADD COLUMN IF NOT EXISTS approved_at              TIMESTAMP`);
    await db.query(`ALTER TABLE client_requests ADD COLUMN IF NOT EXISTS approved_by              INTEGER REFERENCES users(id) ON DELETE SET NULL`);
    await db.query(`ALTER TABLE client_requests ADD COLUMN IF NOT EXISTS rejection_reason         TEXT`);
    await db.query(`ALTER TABLE client_requests ADD COLUMN IF NOT EXISTS payment_rejection_reason TEXT`);
    await db.query(`ALTER TABLE client_requests ADD COLUMN IF NOT EXISTS receipt_number           VARCHAR(40)`);
    await db.query(`ALTER TABLE client_requests ADD COLUMN IF NOT EXISTS receipt_issued_at        TIMESTAMP`);
    await db.query(`ALTER TABLE client_requests ADD COLUMN IF NOT EXISTS sent_at                  TIMESTAMP`);
    await db.query(`ALTER TABLE client_requests ADD COLUMN IF NOT EXISTS sent_by                  INTEGER REFERENCES users(id) ON DELETE SET NULL`);

    // Allow the 'rejected' top-level status (request rejected at review).
    await db.query(`ALTER TABLE client_requests DROP CONSTRAINT IF EXISTS client_requests_status_check`);
    await db.query(`
      ALTER TABLE client_requests ADD CONSTRAINT client_requests_status_check
      CHECK (status IN ('submitted','under_review','resolved','closed','rejected'))
    `);

    // ── Dedicated audit log for client requests ──
    // A separate, append-only trail of every action taken on a ticket
    // (submission, staff notification, review approve/reject, payment
    // submitted/approved/rejected, report generated/sent) with the responsible
    // user, a timestamp, and free-text remarks. Kept distinct from the global
    // activity_logs so a ticket's full history is queryable on its own.
    await db.query(`
      CREATE TABLE IF NOT EXISTS client_request_audit_logs (
        id          SERIAL PRIMARY KEY,
        request_id  INTEGER NOT NULL REFERENCES client_requests(id) ON DELETE CASCADE,
        user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
        action      VARCHAR(60) NOT NULL,
        remarks     TEXT,
        created_at  TIMESTAMP DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_creq_audit_request ON client_request_audit_logs (request_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_creq_audit_created ON client_request_audit_logs (created_at)`);

    // ════════════════════════════════════════════════════════════════════
    // Report Concerns workflow additions (v2 — ProMankekJun12v2)
    // --------------------------------------------------------------------
    // The "Concerns about the report" path (nature='report_concern') now has
    // its own Clinical-Director console ("Report Concerns" tab) mirroring the
    // Report-Requests logic. These columns back the concern lifecycle status,
    // resolution / rejection / review notes, the "request additional info"
    // step, and report versioning (every correction = a new report version).
    // Idempotent — safe to re-run.
    // ════════════════════════════════════════════════════════════════════
    await db.query(`ALTER TABLE client_requests ADD COLUMN IF NOT EXISTS concern_status          VARCHAR(40) DEFAULT 'Pending Review'`);
    await db.query(`ALTER TABLE client_requests ADD COLUMN IF NOT EXISTS concern_resolution_note TEXT`);
    await db.query(`ALTER TABLE client_requests ADD COLUMN IF NOT EXISTS concern_rejection_reason TEXT`);
    await db.query(`ALTER TABLE client_requests ADD COLUMN IF NOT EXISTS concern_info_request    TEXT`);
    await db.query(`ALTER TABLE client_requests ADD COLUMN IF NOT EXISTS concern_review_note     TEXT`);
    await db.query(`ALTER TABLE client_requests ADD COLUMN IF NOT EXISTS report_version          INTEGER DEFAULT 1`);

    // Backfill an initial concern status for any pre-existing concern tickets.
    await db.query(`
      UPDATE client_requests
      SET concern_status = CASE
        WHEN status = 'rejected'              THEN 'Rejected'
        WHEN status IN ('resolved','closed')  THEN 'Resolved'
        WHEN status = 'under_review'          THEN 'Under Investigation'
        ELSE 'Pending Review' END
      WHERE nature = 'report_concern' AND concern_status IS NULL
    `);

    // ── Append-only report version store (audit-safe) ──
    // Every correction or modification of a concern's report is stored as a new
    // version. Previous versions are retained for audit purposes; the client may
    // only access the latest released version (surfaced via report_file).
    await db.query(`
      CREATE TABLE IF NOT EXISTS client_request_report_versions (
        id             SERIAL PRIMARY KEY,
        request_id     INTEGER NOT NULL REFERENCES client_requests(id) ON DELETE CASCADE,
        version_number INTEGER NOT NULL,
        file           TEXT NOT NULL,                 -- base64 data URL of the PDF
        filename       VARCHAR(255),
        mime           VARCHAR(100) DEFAULT 'application/pdf',
        change_note    TEXT,                          -- what changed in this version
        created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at     TIMESTAMP DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_creq_ver_request ON client_request_report_versions (request_id)`);
  } catch (err) {
    console.error('❌ Failed ensuring client_requests tables:', err.message);
  }
}

module.exports = runMigrations;

/**
 * Ensure the columns that the Meet-the-Team photos and the staff-verification /
 * appointment-eligibility features depend on. Runs in its OWN try/catch and is
 * called up front in runMigrations(), so these columns are created on every
 * startup even if some other (later or earlier) migration step throws.
 * Every statement is idempotent — safe to run repeatedly.
 */
async function ensureFeatureColumns() {
  try {
    // Meet-the-Team: photos are stored as on-disk paths in these columns.
    await db.query(`
      CREATE TABLE IF NOT EXISTS team_members (
        id              SERIAL PRIMARY KEY,
        name            VARCHAR(160) NOT NULL,
        role            VARCHAR(160),
        bio             TEXT,
        photo_thumbnail TEXT,
        photo_full      TEXT,
        sort_order      INTEGER DEFAULT 0,
        is_visible      BOOLEAN DEFAULT TRUE,
        created_at      TIMESTAMP DEFAULT NOW(),
        updated_at      TIMESTAMP DEFAULT NOW()
      )
    `);
    await db.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'team_members' AND column_name = 'photo')
           AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'team_members' AND column_name = 'photo_thumbnail') THEN
          ALTER TABLE team_members RENAME COLUMN photo TO photo_thumbnail;
        END IF;
      END $$;
    `);
    await db.query(`ALTER TABLE team_members ADD COLUMN IF NOT EXISTS photo_thumbnail TEXT`);
    await db.query(`ALTER TABLE team_members ADD COLUMN IF NOT EXISTS photo_full      TEXT`);
    await db.query(`ALTER TABLE team_members ADD COLUMN IF NOT EXISTS role            VARCHAR(160)`);
    await db.query(`ALTER TABLE team_members ADD COLUMN IF NOT EXISTS bio             TEXT`);
    await db.query(`ALTER TABLE team_members ADD COLUMN IF NOT EXISTS sort_order      INTEGER DEFAULT 0`);
    await db.query(`ALTER TABLE team_members ADD COLUMN IF NOT EXISTS is_visible      BOOLEAN DEFAULT TRUE`);
    await db.query(`ALTER TABLE team_members ADD COLUMN IF NOT EXISTS created_at      TIMESTAMP DEFAULT NOW()`);
    await db.query(`ALTER TABLE team_members ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMP DEFAULT NOW()`);

    // Staff verification + appointment eligibility (gender/specialization/position).
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS gender                  VARCHAR(20)`);
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS specialization          VARCHAR(160)`);
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS position                VARCHAR(160)`);
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS staff_profile_completed BOOLEAN DEFAULT FALSE`);
  } catch (err) {
    console.error('❌ Failed ensuring feature columns:', err.message);
  }
}
