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

    // 1. Neutralize the out-of-band `notification_category` ENUM — FIRST.
    // ---------------------------------------------------------------------------
    // Some databases carry a `notifications` column (named `type` OR `category`)
    // whose data type is a Postgres ENUM named `notification_category`. That enum
    // was created out of band (it is not produced by these migrations or the
    // bundled .sql schema) and predates newer notification kinds, so any cast of a
    // value such as 'ticket' to it fails with:
    //   invalid input value for enum notification_category: "ticket"
    //
    // This MUST run before the notifications_type_check constraint below: when the
    // enum backs the `type` column, the CHECK (type IN (..., 'ticket')) casts its
    // literal list to the column type and would otherwise fail and abort the whole
    // run. The step converts every enum-backed column to plain VARCHAR and drops
    // the orphan type, so any current/future value is accepted. When no column
    // uses the enum (the common case) it does nothing. Idempotent and safe.
    await ensureNotificationCategoryEnum();

    // 1b. Fix notification type constraint (now safe — `type` is VARCHAR).
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

    // 5b. Seed the public Community FAQ (only if the table is empty). These are
    // editable afterwards from the Moderation Dashboard.
    const faqCount = await db.query(`SELECT COUNT(*)::int AS c FROM faqs`);
    if (faqCount.rows[0].c === 0) {
      const seedFaqs = [
        ['What services does Barcarse Psychological Services offer?', 'We provide Psychological Assessment, Counseling, Psychotherapy, Mental Health Programs, and other mental health services tailored to individuals, families, schools, and organizations.', 'Services'],
        ['How do I book an appointment?', 'You can book an appointment through our online booking system by selecting your preferred service, date, and time. Our team will confirm your appointment after reviewing your request.', 'Appointments'],
        ['What is the difference between Counseling and Psychotherapy?', 'Counseling typically focuses on addressing current concerns, stressors, and life challenges, while Psychotherapy explores deeper emotional, behavioral, and psychological patterns for long-term growth and healing.', 'Services'],
        ['What is a Psychological Assessment?', "A Psychological Assessment is a professional evaluation that uses interviews, observations, and standardized psychological tests to better understand an individual's cognitive, emotional, behavioral, or personality functioning.", 'Assessments'],
        ['Who can avail of Psychological Assessment services?', 'Psychological Assessments may be recommended for students, employees, children, adolescents, and adults who require evaluations for educational, clinical, developmental, or occupational purposes.', 'Assessments'],
        ['How long does a counseling or therapy session last?', "Most sessions last approximately 45-60 minutes, although the duration may vary depending on the client's needs and the service provided.", 'Sessions'],
        ['Are online consultations available?', 'Yes. Depending on the service and clinician availability, online consultations may be offered through secure virtual platforms.', 'Sessions'],
        ['Is the information I share confidential?', 'Yes. All client information and sessions are handled with strict confidentiality in accordance with professional ethical standards and applicable privacy regulations.', 'Privacy'],
        ['How much do your services cost?', 'Service fees vary depending on the type of service requested. Detailed pricing information can be viewed during the booking process or obtained by contacting our clinic.', 'Payments'],
        ['How do I pay for my appointment?', 'Payments may be made through the payment options provided by the clinic. Proof of payment may be required for verification before appointment confirmation.', 'Payments'],
        ['Can I reschedule or cancel my appointment?', "Yes. Clients may request to reschedule or cancel appointments subject to the clinic's scheduling and cancellation policies.", 'Appointments'],
        ['How long will it take to receive my assessment report?', 'The turnaround time depends on the type and complexity of the assessment. Our team will provide an estimated completion date after the evaluation process.', 'Assessments'],
        ['Do you provide services for children and adolescents?', 'Yes. We offer selected psychological and counseling services for children and adolescents, depending on their needs and the recommendations of our professionals.', 'Services'],
        ['What should I prepare before my appointment?', 'Please prepare any required documents, valid identification, previous records (if applicable), and arrive or log in on time for your scheduled appointment.', 'Appointments'],
        ['How do I know which service is right for me?', "If you're unsure which service best fits your needs, you may contact our clinic or submit an inquiry. Our team can guide you toward the most appropriate service.", 'General'],
        ['Is seeking psychological help a sign of weakness?', 'Not at all. Seeking professional support is a proactive step toward improving mental health, emotional well-being, and personal growth.', 'General'],
        ['Do I need a referral before booking?', 'No. Most services can be booked directly unless specific requirements are communicated by the clinic.', 'General'],
        ['What happens during my first session?', 'Your first session typically involves discussing your concerns, gathering relevant information, and identifying goals to help determine the most appropriate plan moving forward.', 'Sessions'],
      ];
      let order = 0;
      for (const [question, answer, category] of seedFaqs) {
        await db.query(
          `INSERT INTO faqs (question, answer, category, is_published, sort_order)
           VALUES ($1, $2, $3, TRUE, $4)`,
          [question, answer, category, order++]
        );
      }
      console.log(`   ✓ Seeded ${seedFaqs.length} community FAQs`);
    }

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
    // recording_requested = a host request is pending the client's decision.
    // recording_enabled now means ACTIVELY recording (only true after the client
    // approves) — so recording never starts on the host's click alone.
    await db.query(`ALTER TABLE teleconference_sessions ADD COLUMN IF NOT EXISTS recording_requested BOOLEAN DEFAULT FALSE`);

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

    // 15b. Single-use teleconference invitation tokens.
    // Each invite is bound to a session, the appointment (meeting_id) and the
    // patient (client_id), with a hard expiry. Only the SHA-256 HASH of the raw
    // token is stored — the raw token lives only in the emailed link — so a DB
    // leak never exposes a usable token. `status` enforces single use.
    await db.query(`
      CREATE TABLE IF NOT EXISTS teleconference_invitations (
        id              SERIAL PRIMARY KEY,
        session_id      INTEGER NOT NULL REFERENCES teleconference_sessions(id) ON DELETE CASCADE,
        meeting_id      INTEGER REFERENCES meetings(id) ON DELETE SET NULL,
        client_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash      VARCHAR(64) NOT NULL UNIQUE,
        status          VARCHAR(20) NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','used','expired','revoked')),
        expires_at      TIMESTAMP NOT NULL,
        used_at         TIMESTAMP,
        used_ip         VARCHAR(64),
        used_user_agent TEXT,
        created_by      INTEGER,
        created_at      TIMESTAMP DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_tc_invite_token   ON teleconference_invitations (token_hash)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_tc_invite_session ON teleconference_invitations (session_id)`);

    // 15c. Live-call "seat" state for duplicate-entry prevention. connection_token
    // is a per-join secret returned only to the joining device; last_heartbeat
    // lets the server detect a dropped connection and free the seat after a
    // short staleness window.
    await db.query(`ALTER TABLE session_participants ADD COLUMN IF NOT EXISTS connection_token   VARCHAR(64)`);
    await db.query(`ALTER TABLE session_participants ADD COLUMN IF NOT EXISTS last_heartbeat     TIMESTAMP`);
    // Durable reconnect secret (hash only). Lets the SAME device reclaim its seat
    // after an accidental disconnect/refresh/crash, without re-running OTP.
    await db.query(`ALTER TABLE session_participants ADD COLUMN IF NOT EXISTS reconnect_token_hash VARCHAR(64)`);

    // 15d. Server-side teleconference OTP clearance. The frontend OTP gate is not
    // a security boundary on its own — an API-level intruder bypasses it. Here we
    // record that a user actually passed OTP, with a session-length expiry, and
    // the join/reconnect endpoints REQUIRE a fresh clearance before issuing a
    // Twilio token.
    // PER (PARTICIPANT, SESSION): keyed by (user_id, is_staff, session_id). The
    // is_staff flag distinguishes a STAFF account from a CLIENT account even when
    // their ids are the same number (staff_id and users.id are SEPARATE
    // sequences and can collide) — so a staff member and a client NEVER share a
    // clearance row, and each participant's grace/OTP is fully independent. If an
    // older version of the table exists, rebuild it (the clearance is a
    // short-lived cache, so nothing of value is lost).
    {
      const hasIsStaff = await db.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_name = 'teleconference_otp_clearance' AND column_name = 'is_staff'`
      );
      if (!hasIsStaff.rowCount) {
        await db.query(`DROP TABLE IF EXISTS teleconference_otp_clearance`);
        await db.query(`
          CREATE TABLE teleconference_otp_clearance (
            user_id     INTEGER NOT NULL,
            is_staff    BOOLEAN NOT NULL DEFAULT FALSE,
            session_id  INTEGER NOT NULL REFERENCES teleconference_sessions(id) ON DELETE CASCADE,
            verified_at TIMESTAMP NOT NULL DEFAULT NOW(),
            expires_at  TIMESTAMP NOT NULL,
            PRIMARY KEY (user_id, is_staff, session_id)
          )
        `);
      }
    }

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

    // 16a. Ensure consent columns exist on older intake_forms tables.
    // The counseling intake now captures BOTH the Data Privacy Act consent and
    // the Philippine Code of Ethics acknowledgment (shown side-by-side).
    await db.query(`ALTER TABLE intake_forms ADD COLUMN IF NOT EXISTS data_privacy_consent BOOLEAN DEFAULT FALSE`);
    await db.query(`ALTER TABLE intake_forms ADD COLUMN IF NOT EXISTS code_of_ethics_consent BOOLEAN DEFAULT FALSE`);

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

    // 16c. Assessment intake forms — the dedicated store for the Assessment
    // booking flow. It mirrors the role of intake_forms (which serves the
    // Counseling flow) but holds the assessment-specific question set. Like the
    // counseling intake, an assessment row is ONLY persisted once staff verify
    // the payment (promoted from appointments.pending_intake_data); until then
    // the answers live on the appointment's staging buffer.
    await db.query(`
      CREATE TABLE IF NOT EXISTS assessment_intake_forms (
        id                        SERIAL PRIMARY KEY,
        user_id                   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        family_name               VARCHAR(120),
        given_name                VARCHAR(120),
        middle_name               VARCHAR(120),
        nickname                  VARCHAR(120),
        birthdate                 DATE,
        age                       INTEGER,
        sex                       VARCHAR(20),
        contact_number            VARCHAR(40),
        email                     VARCHAR(200),
        home_address              TEXT,
        primary_language          TEXT,
        reason_for_referral       VARCHAR(120),
        assessed_before           VARCHAR(10),
        assessed_before_details   TEXT,
        existing_diagnoses        VARCHAR(20),
        existing_diagnoses_details TEXT,
        current_interventions     TEXT,
        intervention_other        TEXT,
        answering_for             VARCHAR(20),
        preferred_schedule        VARCHAR(200),
        session_modality          VARCHAR(100),
        data_privacy_consent      BOOLEAN DEFAULT FALSE,
        code_of_ethics_consent    BOOLEAN DEFAULT FALSE,
        created_at                TIMESTAMP DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_assessment_intake_user ON assessment_intake_forms (user_id)`);

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
                                'confirmed','declined','cancelled','completed'
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
    // Link to a promoted Assessment intake form (the counseling flow uses
    // intake_form_id; the assessment flow uses this column instead). Only one of
    // the two is set per appointment.
    await db.query(`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS assessment_form_id INTEGER REFERENCES assessment_intake_forms(id) ON DELETE SET NULL`).catch(() => {});
    // Assessment type verified by Supervising Psychometrician during appointment confirmation.
    // Neurodevelopmental assessments are auto-locked to Face-to-Face modality.
    await db.query(`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS assessment_type VARCHAR(50)`).catch(() => {});

    // Phase 2 — link a live teleconference room back to the appointment that
    // scheduled it. Added here (not at the teleconference_sessions block above)
    // because the FK target `appointments` is only created at this point in the
    // migration. Lets the client dashboard turn the matching upcoming appointment
    // card into a one-click "Join Meeting" the moment the host opens the room.
    // NULL for ad-hoc sessions not tied to an appointment.
    await db.query(`ALTER TABLE teleconference_sessions ADD COLUMN IF NOT EXISTS appointment_id INTEGER REFERENCES appointments(id) ON DELETE SET NULL`).catch(() => {});
    await db.query(`CREATE INDEX IF NOT EXISTS idx_teleconf_appt ON teleconference_sessions (appointment_id)`).catch(() => {});

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

    // 17e. `module` — which business flow a payment belongs to, so a single
    // centralized payments table can serve counseling, assessment, and report-
    // request payments (drives the CPM-/APM-/RPM- reference prefixes and the
    // Payment Verification module's grouping). Auto-derived from the row's own
    // FKs so the system "knows" the service type without a manual field:
    //   • report_request_id set            → 'report_request' (RPM-)
    //   • appointment is an assessment one  → 'assessment'     (APM-)
    //   • otherwise                         → 'counseling'     (CPM-)
    await db.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS module VARCHAR(20) DEFAULT 'counseling'`);
    // Backfill assessment payments (appointment carries an assessment_form_id).
    await db.query(`
      UPDATE payments SET module = 'assessment'
      WHERE (module IS NULL OR module = 'counseling')
        AND appointment_id IN (SELECT id FROM appointments WHERE assessment_form_id IS NOT NULL)
    `).catch(() => {});
    // (report_request payments are tagged in the report-request payment section
    // below, once payments.client_request_id exists.)
    await db.query(`UPDATE payments SET module = 'counseling' WHERE module IS NULL`).catch(() => {});
    await db.query(`CREATE INDEX IF NOT EXISTS idx_payments_module ON payments (module)`);

    // Backfill the human-readable service_label for older appointment payments
    // that were created before the label was derived (so the Payment Verification
    // page shows "Assessment — <Type>" / "Counseling" the same way report-request
    // payments show "Report request …").
    //
    // The assessment type is taken from the appointment's confirmed
    // assessment_type, falling back to the intake form's reason_for_referral
    // (older bookings never recorded a type → otherwise they'd read bare
    // "Assessment"). This corrective pass also rewrites rows previously
    // backfilled as a plain "Assessment".
    await db.query(`
      UPDATE payments p
      SET service_label = 'Assessment — ' || initcap(replace(
        COALESCE(
          a.assessment_type,
          CASE lower(trim(f.reason_for_referral))
            WHEN 'neurodevelopmental assessment'      THEN 'neurodevelopmental'
            WHEN 'clinical assessment'                THEN 'clinical'
            WHEN 'pre-employment/neuropsychological'  THEN 'pre_employment'
          END
        ), '_', ' '))
      FROM appointments a
      LEFT JOIN assessment_intake_forms f ON f.id = a.assessment_form_id
      WHERE p.appointment_id = a.id
        AND (a.assessment_form_id IS NOT NULL OR a.assessment_type IS NOT NULL)
        AND (p.service_label IS NULL OR p.service_label = 'Assessment')
        AND COALESCE(
          a.assessment_type,
          CASE lower(trim(f.reason_for_referral))
            WHEN 'neurodevelopmental assessment'      THEN 'neurodevelopmental'
            WHEN 'clinical assessment'                THEN 'clinical'
            WHEN 'pre-employment/neuropsychological'  THEN 'pre_employment'
          END
        ) IS NOT NULL
    `).catch(() => {});
    // Assessment payments with no derivable type at all still get a plain label.
    await db.query(`
      UPDATE payments p
      SET service_label = 'Assessment'
      FROM appointments a
      WHERE p.appointment_id = a.id
        AND p.service_label IS NULL
        AND (a.assessment_form_id IS NOT NULL OR a.assessment_type IS NOT NULL)
    `).catch(() => {});
    await db.query(`
      UPDATE payments p
      SET service_label = 'Counseling'
      FROM appointments a
      WHERE p.appointment_id = a.id
        AND p.service_label IS NULL
        AND a.assessment_form_id IS NULL
        AND a.assessment_type IS NULL
    `).catch(() => {});
    // Guard the allowed values (added separately so it's safe on existing tables).
    await db.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payments_module_check') THEN
          ALTER TABLE payments ADD CONSTRAINT payments_module_check
            CHECK (module IN ('counseling','assessment','report_request'));
        END IF;
      END $$;
    `).catch(() => {});

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
      { key: 'identifying_information',     title: 'Identifying Information',                        required: true },
      { key: 'reason_for_referral',          title: 'Reason for Referral',                            required: true },
      { key: 'early_developmental_background', title: 'Early Developmental and Background',           required: true },
      { key: 'behavioral_observation_mse',   title: 'Behavioral Observation and Mental Status Exam',  required: true },
      { key: 'assessment_battery',           title: 'Assessment Battery',                             required: true },
      { key: 'test_results',                 title: 'Test Results and Interpretation',                 required: true },
      { key: 'findings',                     title: 'Findings',                                       required: true },
      { key: 'recommendations',              title: 'Recommendations',                                required: true },
      { key: 'prepared_approved_by',         title: 'Prepared By and Approved By',                    required: true },
    ];

    const CLINICAL_SECTIONS = [
      { key: 'identifying_information',           title: 'Identifying Information',                   required: true },
      { key: 'reason_for_referral',               title: 'Reason for Referral',                       required: true },
      { key: 'case_history',                      title: 'Case History',                              required: true },
      { key: 'general_observations_interview_mse', title: 'General Observations, Interview, and MSE', required: true },
      { key: 'assessment_tests_methods',          title: 'Assessment Tests/Methods',                  required: true },
      { key: 'summary_formulation',               title: 'Summary Formulation',                       required: true },
      { key: 'diagnostic_impression',             title: 'Diagnostic Impression',                     required: true },
      { key: 'recommendation',                    title: 'Recommendation',                            required: true },
      { key: 'prepared_approved_by',              title: 'Prepared By and Approved By',               required: true },
    ];

    const PRE_EMP_SECTIONS = [
      { key: 'identifying_information',     title: 'Identifying Information',                        required: true },
      { key: 'reason_for_referral',          title: 'Reason for Referral',                            required: true },
      { key: 'client_background',            title: 'Client Background',                              required: true },
      { key: 'assessment_tools_procedure',   title: 'Assessment Tools/Procedure',                     required: true,
        default_content: 'Test Administered                              | Date Administered\n-----------------------------------------------|-----------------\nMAS Mental Ability Test                         |\nPurdue Non-Language Test                        |\nDifferential Aptitude Test - Fifth Edition      |\nBarOn EQ Inventory: Short Version               |\nMasaklaw na Panukat ng Loob                     |\nBasic Personality Inventory                     |\nHouse-Tree-Person Test                          |\nSacks Sentence Completion Test                  |\nMental Status Exam                              |'
      },
      { key: 'overall_result',               title: 'Overall Psychological Assessment Result',        required: true },
      { key: 'impression_conclusion',        title: 'Impression and Conclusion',                      required: true },
      { key: 'recommendation',               title: 'Recommendation',                                 required: true },
      { key: 'prepared_approved_by',         title: 'Prepared By and Approved By',                    required: true },
    ];

    // 18c. Update existing templates with correct section configs
    const neuroJson = JSON.stringify(NEURO_SECTIONS);
    const clinicalJson = JSON.stringify(CLINICAL_SECTIONS);
    const preEmpJson = JSON.stringify(PRE_EMP_SECTIONS);

    await db.query(`UPDATE report_templates SET sections_config = $1 WHERE template_type = 'neurodevelopmental'`, [neuroJson]);
    await db.query(`UPDATE report_templates SET sections_config = $1 WHERE template_type = 'clinical'`, [clinicalJson]);
    await db.query(`UPDATE report_templates SET sections_config = $1 WHERE template_type = 'pre_employment'`, [preEmpJson]);
    console.log('✅ Template sections updated to latest structure.');

    // 18d. Remove Mental Health Certificate as a report section — it is now a
    //      separate appended PDF page and must not appear in the section list.
    await db.query(`DELETE FROM report_sections WHERE section_key = 'mental_health_certificate'`);
    console.log('✅ Mental Health Certificate removed from report sections (now a standalone PDF attachment).');

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

    // 19c. QC workflow columns — added early so they are always present regardless
    // of whether later migration steps (43-47) complete successfully.
    // Widen status column first: 'revision_requested_qc' is 21 chars, VARCHAR(20) is too short.
    await db.query(`ALTER TABLE psychological_reports ALTER COLUMN status TYPE VARCHAR(30)`).catch(() => {});
    await db.query(`ALTER TABLE psychological_reports ADD COLUMN IF NOT EXISTS revision_notes TEXT`).catch(() => {});
    await db.query(`ALTER TABLE psychological_reports ADD COLUMN IF NOT EXISTS qc_revision_notes TEXT`).catch(() => {});
    await db.query(`ALTER TABLE psychological_reports ADD COLUMN IF NOT EXISTS qc_reviewed_by INTEGER`).catch(() => {});
    await db.query(`ALTER TABLE psychological_reports ADD COLUMN IF NOT EXISTS prepared_by INTEGER`).catch(() => {});
    await db.query(`ALTER TABLE psychological_reports ADD COLUMN IF NOT EXISTS reviewed_by INTEGER`).catch(() => {});
    await db.query(`ALTER TABLE psychological_reports ADD COLUMN IF NOT EXISTS approved_by INTEGER`).catch(() => {});
    await db.query(`ALTER TABLE psychological_reports ADD COLUMN IF NOT EXISTS is_locked BOOLEAN DEFAULT FALSE`).catch(() => {});
    await db.query(`ALTER TABLE psychological_reports ADD COLUMN IF NOT EXISTS case_id VARCHAR(20)`).catch(() => {});

    // 19c-bis. client_id links a report to the exact client (users.id) it was made
    // for. This is the column the release workflow uses to deliver the final signed
    // report to the right client. It was previously only ever present on legacy DBs
    // (the CREATE TABLE above omits it), so add it explicitly here — without it,
    // report creation (which INSERTs client_id) fails outright on a fresh install,
    // and released reports never reach the client.
    await db.query(`ALTER TABLE psychological_reports ADD COLUMN IF NOT EXISTS client_id INTEGER REFERENCES users(id) ON DELETE SET NULL`).catch(() => {});
    await db.query(`CREATE INDEX IF NOT EXISTS idx_psy_reports_client ON psychological_reports (client_id)`).catch(() => {});
    // Backfill: any report that has a linked case but no client_id yet inherits the
    // case's client, so it can be released to the correct client.
    await db.query(`
      UPDATE psychological_reports pr
         SET client_id = c.user_id
        FROM cases c
       WHERE pr.case_id = c.case_id
         AND pr.client_id IS NULL
    `).catch(() => {});

    // 19d. Signature & release workflow (Supervising → QC → Ready For Release → Released).
    // signature_stage tracks where the approved report is in the signing pipeline:
    //   NULL | 'supervising' | 'quality_control' | 'ready_for_release' | 'released'
    await db.query(`ALTER TABLE psychological_reports ADD COLUMN IF NOT EXISTS signature_stage VARCHAR(40)`).catch(() => {});
    await db.query(`ALTER TABLE psychological_reports ADD COLUMN IF NOT EXISTS supervising_signed_by INTEGER`).catch(() => {});
    await db.query(`ALTER TABLE psychological_reports ADD COLUMN IF NOT EXISTS supervising_signed_at TIMESTAMP`).catch(() => {});
    await db.query(`ALTER TABLE psychological_reports ADD COLUMN IF NOT EXISTS qc_signed_by INTEGER`).catch(() => {});
    await db.query(`ALTER TABLE psychological_reports ADD COLUMN IF NOT EXISTS qc_signed_at TIMESTAMP`).catch(() => {});
    await db.query(`ALTER TABLE psychological_reports ADD COLUMN IF NOT EXISTS released_at TIMESTAMP`).catch(() => {});
    await db.query(`ALTER TABLE psychological_reports ADD COLUMN IF NOT EXISTS released_by INTEGER`).catch(() => {});

    // 19e. Persisted signed-PDF versions. Each save creates a new immutable
    // version so signatures are never lost across refreshes, stage changes, or
    // release. The latest row (highest version_number) is the authoritative PDF
    // served by GET /api/reports/:id/pdf once signing has begun.
    // signed_by is a plain INTEGER (NOT a FK): staff sign in with their
    // staff.staff_id which is NOT a users.id, so a users(id) FK would reject
    // every save by a Supervising/QC Psychometrician.
    await db.query(`
      CREATE TABLE IF NOT EXISTS report_signed_pdfs (
        id              SERIAL PRIMARY KEY,
        report_id       INTEGER NOT NULL REFERENCES psychological_reports(id) ON DELETE CASCADE,
        version_number  INTEGER NOT NULL,
        signature_stage VARCHAR(40),
        pdf_base64      TEXT NOT NULL,
        signed_by       INTEGER,
        created_at      TIMESTAMP DEFAULT NOW()
      )
    `);
    // Drop the FK if an earlier build created the table with REFERENCES users(id).
    await db.query(`ALTER TABLE report_signed_pdfs DROP CONSTRAINT IF EXISTS report_signed_pdfs_signed_by_fkey`).catch(() => {});
    await db.query(`CREATE INDEX IF NOT EXISTS idx_signed_pdfs_report ON report_signed_pdfs (report_id, version_number DESC)`);
    // S3 serving copy: when the signed PDF is uploaded to the app-files bucket,
    // its object key is stored here. The DB (pdf_base64) stays the source of
    // truth; s3_key just lets downloads be served via a presigned URL. NULL for
    // older rows → callers fall back to pdf_base64.
    await db.query(`ALTER TABLE report_signed_pdfs ADD COLUMN IF NOT EXISTS s3_key VARCHAR(512)`).catch(() => {});

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
    // 25b. Ensure all workflow action values are allowed (idempotent).
    // Wrapped in its own try-catch so a constraint conflict never stops the migration.
    try {
      // Find and drop ALL check constraints on this table so none linger with old names.
      const oldCons = await db.query(`
        SELECT conname FROM pg_constraint
        WHERE conrelid = 'report_audit_logs'::regclass AND contype = 'c'
      `);
      for (const row of oldCons.rows) {
        await db.query(`ALTER TABLE report_audit_logs DROP CONSTRAINT IF EXISTS "${row.conname}"`).catch(() => {});
      }
      await db.query(`
        ALTER TABLE report_audit_logs ADD CONSTRAINT report_audit_logs_action_check
        CHECK (action IN (
          'created','edited','submitted','approved','rejected',
          'viewed','downloaded','version_restored','finalized','deleted','restored','archived','unarchived',
          'template_created','template_updated','template_deleted',
          'prepared','reviewed','revision_requested','qc_revision_requested',
          'resubmitted','locked','unlocked'
        ))
      `);
    } catch (e) { console.warn('25b constraint update skipped:', e.message); }
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

    // 27. (removed) report_permissions — per-report ACL that was never wired up
    // into any model/controller; report access is governed by RBAC roles instead.
    await db.query(`DROP TABLE IF EXISTS report_permissions`).catch(() => {});

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
    // 31b. Audit Logs enrichment — role / Success-Failed status / device (user-agent).
    // Added so the Clinical-Director "Audit Logs" view can show Role, Status and
    // Device Information columns. Idempotent: safe to run on existing databases.
    await db.query(`ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS role        VARCHAR(50)`);
    await db.query(`ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS status      VARCHAR(20)`);
    await db.query(`ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS user_agent  TEXT`);
    // FingerprintJS visitor ID — stable device identifier sent by the browser
    // (X-Device-FP header) to strengthen the Audit Logs "Device Information".
    await db.query(`ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS fingerprint VARCHAR(64)`);

    // ── 32. Staff verification profile (legacy) ─────────────────────
    // These staff-only columns predate the dedicated `staff` table (step 33) and
    // do not apply to clients (the `users` table is client-only now). They are
    // unused in application code, so they are dropped from `users`. `gender` is
    // kept as it is a generic profile field.
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS gender VARCHAR(20)`);
    await db.query(`ALTER TABLE users DROP COLUMN IF EXISTS specialization`);
    await db.query(`ALTER TABLE users DROP COLUMN IF EXISTS position`);
    await db.query(`ALTER TABLE users DROP COLUMN IF EXISTS staff_profile_completed`);

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

    // ── 33b. Staff lifecycle status + specialization ─────────────────
    // A staff account now has a 3-state lifecycle independent of the legacy
    // `is_active` boolean (which is kept in sync for backward compatibility):
    //   • inactive — deactivated by the Clinical Director; cannot sign in.
    //   • active   — created/enabled but has never completed an email-code
    //                verification at login.
    //   • verified — has completed the email verification code at least once.
    // `specialization` is captured at creation and shown to clients in the
    // intake counselor picker (but intentionally NOT in Staff Management).
    await db.query(`ALTER TABLE staff ADD COLUMN IF NOT EXISTS status VARCHAR(20)`);
    await db.query(`ALTER TABLE staff ADD COLUMN IF NOT EXISTS specialization VARCHAR(160)`);
    // Backfill: derive an initial status from the legacy is_active flag.
    await db.query(`UPDATE staff SET status = CASE WHEN is_active = FALSE THEN 'inactive' ELSE 'active' END WHERE status IS NULL`);
    await db.query(`ALTER TABLE staff ALTER COLUMN status SET DEFAULT 'active'`);
    // Guard the allowed values (added separately so it's safe on existing tables).
    await db.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'staff_status_check') THEN
          ALTER TABLE staff ADD CONSTRAINT staff_status_check
            CHECK (status IN ('inactive','active','verified'));
        END IF;
      END $$;
    `);

    // ── 33c. Staff email-OTP store ───────────────────────────────────
    // Staff cannot reuse `email_verifications` (its user_id FKs users(id)); a
    // staff actor lives in the separate `staff` table. This table holds the
    // per-login one-time code (hashed) used for the staff 2-step sign-in.
    await db.query(`
      CREATE TABLE IF NOT EXISTS staff_verifications (
        id          SERIAL PRIMARY KEY,
        staff_id    INTEGER NOT NULL REFERENCES staff(staff_id) ON DELETE CASCADE,
        otp_hash    VARCHAR(255) NOT NULL,
        expires_at  TIMESTAMP NOT NULL,
        attempts    INTEGER NOT NULL DEFAULT 0,
        created_at  TIMESTAMP DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_staff_verif_staff ON staff_verifications (staff_id)`);
    // Per-code brute-force guard (existing DBs): counts wrong guesses so the code
    // can be invalidated after too many (see StaffVerification.incrementAttempts).
    await db.query(`ALTER TABLE staff_verifications ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0`);

    // Staff password-reset tokens. Kept SEPARATE from the client `password_resets`
    // table (which is FK'd to users(id)) because staff_id and users.id overlap —
    // a shared table would let a client and a staff member with the same integer
    // id consume each other's reset tokens.
    await db.query(`
      CREATE TABLE IF NOT EXISTS staff_password_resets (
        id          SERIAL PRIMARY KEY,
        staff_id    INTEGER NOT NULL REFERENCES staff(staff_id) ON DELETE CASCADE,
        token_hash  VARCHAR(255) NOT NULL,
        expires_at  TIMESTAMP NOT NULL,
        used        BOOLEAN DEFAULT FALSE,
        created_at  TIMESTAMP DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_staff_pwreset_staff ON staff_password_resets (staff_id)`);

    // ── 33d. Decouple teleconference identities from users(id) ───────
    // Staff now live in the `staff` table, but the teleconference schema
    // originally FK-constrained the host/staff/message/log id columns to
    // users(id). That made it impossible to store a staff_id there (FK
    // violation), so staff-management accounts could never host or be assigned
    // to a meeting. We drop those specific FKs so these columns can hold an id
    // from EITHER table; name resolution disambiguates by role at query time
    // (see TeleconferenceSession model). `teleconference_sessions.client_id`
    // keeps its FK because a client is always a `users` row.
    await db.query(`ALTER TABLE teleconference_sessions DROP CONSTRAINT IF EXISTS teleconference_sessions_psychologist_id_fkey`);
    await db.query(`ALTER TABLE session_participants     DROP CONSTRAINT IF EXISTS session_participants_user_id_fkey`);
    await db.query(`ALTER TABLE session_messages         DROP CONSTRAINT IF EXISTS session_messages_user_id_fkey`);
    await db.query(`ALTER TABLE session_logs             DROP CONSTRAINT IF EXISTS session_logs_participant_id_fkey`);
    // A meeting's host is the staff member who created it (now a staff_id).
    await db.query(`ALTER TABLE meetings                 DROP CONSTRAINT IF EXISTS meetings_host_id_fkey`);

    // ── 33e. Decouple notifications from users(id) ───────────────────
    // notifications.user_id was FK-constrained to users(id), so staff-table
    // accounts (staff_id) could never be notified — every role/staff broadcast
    // to them failed the FK. Drop the constraint so notifications can target an
    // id from EITHER table; the recipient reads their own notifications by the
    // id they authenticate with (users.id for clients, staff_id for staff).
    await db.query(`ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_user_id_fkey`);

    // ── 33e-2. Namespace notification recipients (staff vs client) ────
    // Dropping the FK above let notifications target an id from EITHER table,
    // but user_id alone is ambiguous: a client (users.id = 5) and a staff member
    // (staff_id = 5) share the SAME integer, so they would read/mark/delete each
    // other's notifications. Add an explicit recipient_type discriminator; every
    // read/write filters on (user_id, recipient_type) so the two namespaces can
    // never cross. Existing rows default to 'user' (the pre-staff-table norm).
    await db.query(`
      ALTER TABLE notifications
        ADD COLUMN IF NOT EXISTS recipient_type VARCHAR(10) NOT NULL DEFAULT 'user'
    `);
    await db.query(`ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_recipient_type_check`);
    await db.query(`
      ALTER TABLE notifications
        ADD CONSTRAINT notifications_recipient_type_check
        CHECK (recipient_type IN ('user', 'staff'))
    `);
    // Replace the plain user_id indexes with (recipient_type, user_id) so the
    // namespaced lookups stay index-backed.
    await db.query(`CREATE INDEX IF NOT EXISTS idx_notifications_recipient ON notifications (recipient_type, user_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_notifications_recipient_read ON notifications (recipient_type, user_id, is_read)`);

    // ── 33f. Decouple STAFF-ACTOR columns from users(id) ─────────────
    // Staff now live in the `staff` table (staff_id), but many "who did this"
    // columns were FK-constrained to users(id). When a staff-table account
    // performs its duty (approve a schedule, verify a payment, create a report
    // or template, handle a request, moderate content, etc.) the insert/update
    // wrote a staff_id into a users(id) FK column and failed with a 500. We drop
    // the FK on every staff-actor / mixed-author column so it can hold an id
    // from EITHER table. Pure CLIENT columns (client_id, and user_id on
    // client-owned data like intake/assessment/profile) KEEP their FK.
    const STAFF_ACTOR_FKS = [
      ['appointments', 'appointments_staff_id_fkey'],
      ['payments', 'payments_verified_by_fkey'],
      ['psychological_reports', 'psychological_reports_psychologist_id_fkey'],
      ['report_approvals', 'report_approvals_reviewer_id_fkey'],
      ['report_audit_logs', 'report_audit_logs_user_id_fkey'],
      ['report_templates', 'report_templates_created_by_fkey'],
      ['report_versions', 'report_versions_editor_id_fkey'],
      ['client_requests', 'client_requests_assigned_staff_id_fkey'],
      ['client_requests', 'client_requests_approved_by_fkey'],
      ['client_requests', 'client_requests_sent_by_fkey'],
      ['client_request_audit_logs', 'client_request_audit_logs_user_id_fkey'],
      ['client_request_replies', 'client_request_replies_user_id_fkey'],
      ['client_request_report_versions', 'client_request_report_versions_created_by_fkey'],
      ['content_flags', 'content_flags_reviewed_by_fkey'],
      ['content_flags', 'content_flags_reporter_id_fkey'],
      ['data_deletion_log', 'data_deletion_log_deleted_by_fkey'],
      ['landing_content', 'landing_content_updated_by_fkey'],
      ['moderation_keywords', 'moderation_keywords_added_by_fkey'],
      ['system_settings', 'system_settings_updated_by_fkey'],
      ['articles', 'articles_author_id_fkey'],
      ['faqs', 'faqs_author_id_fkey'],
      ['forum_replies', 'forum_replies_author_id_fkey'],
      ['forum_threads', 'forum_threads_author_id_fkey'],
      ['activity_logs', 'activity_logs_user_id_fkey'],
      ['votes', 'votes_user_id_fkey'],
    ];
    for (const [tbl, con] of STAFF_ACTOR_FKS) {
      await db.query(`ALTER TABLE ${tbl} DROP CONSTRAINT IF EXISTS ${con}`).catch(() => {});
    }

    // Forum posts/replies record the author's role at creation. Staff authors are
    // stored by staff_id (a SEPARATE sequence from users.id), so a single
    // author_id cannot be resolved unambiguously — author_role disambiguates
    // staff vs client and lets the UI show the staff member's name AND role
    // instead of "Community Member".
    await db.query(`ALTER TABLE forum_threads ADD COLUMN IF NOT EXISTS author_role VARCHAR(40)`);
    await db.query(`ALTER TABLE forum_replies ADD COLUMN IF NOT EXISTS author_role VARCHAR(40)`);

    // ════════════════════════════════════════════════════════════════════
    // CASE-CENTERED ARCHITECTURE (v2) — Steps 34–40
    // ════════════════════════════════════════════════════════════════════

    // 34. Cases table — central clinical workflow entity
    await db.query(`
      CREATE TABLE IF NOT EXISTS cases (
        case_id                  VARCHAR(20) PRIMARY KEY,
        user_id                  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        assigned_psychologist_id INTEGER,
        intake_date              DATE NOT NULL DEFAULT CURRENT_DATE,
        status                   VARCHAR(50) NOT NULL DEFAULT 'Pending Intake Review',
        resubmission_count       INTEGER DEFAULT 0,
        created_at               TIMESTAMP DEFAULT NOW(),
        updated_at               TIMESTAMP DEFAULT NOW(),
        closed_at                TIMESTAMP
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_cases_user ON cases (user_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_cases_status ON cases (status)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_cases_psych ON cases (assigned_psychologist_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_cases_created ON cases (created_at DESC)`);

    // 35. Case notes — structured comments for workflow decisions
    await db.query(`
      CREATE TABLE IF NOT EXISTS case_notes (
        note_id              SERIAL PRIMARY KEY,
        case_id              VARCHAR(20) NOT NULL REFERENCES cases(case_id) ON DELETE CASCADE,
        author_staff_id      INTEGER,
        author_user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
        note_type            VARCHAR(30) NOT NULL
                             CHECK (note_type IN ('IntakeRejection','ReportRevision','AppointmentNote','ReportRequestNote','General')),
        content              TEXT NOT NULL,
        is_visible_to_client BOOLEAN DEFAULT FALSE,
        created_at           TIMESTAMP DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_case_notes_case ON case_notes (case_id)`);

    // 36. Psychologist availability — scheduling validation
    await db.query(`
      CREATE TABLE IF NOT EXISTS psychologist_availability (
        availability_id  SERIAL PRIMARY KEY,
        psychologist_id  INTEGER NOT NULL,
        day_of_week      INTEGER NOT NULL CHECK (day_of_week >= 0 AND day_of_week <= 6),
        start_time       TIME NOT NULL,
        end_time         TIME NOT NULL,
        is_available     BOOLEAN DEFAULT TRUE,
        effective_from   DATE NOT NULL DEFAULT CURRENT_DATE,
        effective_until  DATE
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_psych_avail_psych ON psychologist_availability (psychologist_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_psych_avail_day ON psychologist_availability (day_of_week)`);

    // 37. Assessments — track assessment start/completion per case
    await db.query(`
      CREATE TABLE IF NOT EXISTS assessments (
        assessment_id    SERIAL PRIMARY KEY,
        case_id          VARCHAR(20) NOT NULL REFERENCES cases(case_id) ON DELETE CASCADE,
        psychologist_id  INTEGER NOT NULL,
        started_at       TIMESTAMP,
        completed_at     TIMESTAMP,
        remarks          TEXT
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_assessments_case ON assessments (case_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_assessments_psych ON assessments (psychologist_id)`);

    // 37b. Remove any duplicate assessment rows per case (keep only the most recent),
    // then add a UNIQUE constraint so one case can only ever have one assessment row.
    await db.query(`
      DELETE FROM assessments
      WHERE assessment_id NOT IN (
        SELECT MAX(assessment_id) FROM assessments GROUP BY case_id
      )
    `).catch(() => {});
    await db.query(`
      ALTER TABLE assessments ADD CONSTRAINT assessments_case_id_unique UNIQUE (case_id)
    `).catch(() => {});

    // 37c. Add 'completed' to the appointments status check constraint.
    await db.query(`ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointments_status_check`).catch(() => {});
    await db.query(`
      ALTER TABLE appointments ADD CONSTRAINT appointments_status_check
      CHECK (status IN ('pending_review','approved','reschedule_proposed','confirmed','declined','cancelled','completed'))
    `).catch(() => {});

    // 37d-arch. Soft-delete support: archived_at timestamp on cases.
    // NULL = active, non-NULL = archived (hidden from all normal queries).
    await db.query(`ALTER TABLE cases ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP`).catch(() => {});

    // 37d. Add service_type column to cases — distinguishes Counseling vs Assessment cases.
    // Existing cases default to 'counseling'; assessment cases are backfilled by checking
    // for a matching row in assessment_intake_forms.
    await db.query(`ALTER TABLE cases ADD COLUMN IF NOT EXISTS service_type VARCHAR(20) NOT NULL DEFAULT 'counseling'`).catch(() => {});
    await db.query(`
      UPDATE cases SET service_type = 'assessment'
      WHERE case_id IN (SELECT DISTINCT case_id FROM assessment_intake_forms WHERE case_id IS NOT NULL)
    `).catch(() => {});

    // 38. report_requests — REMOVED in the DB cleanup. This was a parallel
    // "report request" table that was never populated (ReportRequest.create() had
    // no callers); the canonical, live report-request workflow runs entirely on
    // client_requests. Dropping it here. CASCADE removes the dependent
    // payments.report_request_id FK constraint; we also drop that now-orphaned
    // column. Idempotent — safe to re-run.
    await db.query(`ALTER TABLE payments DROP COLUMN IF EXISTS report_request_id`).catch(() => {});
    await db.query(`DROP TABLE IF EXISTS report_requests CASCADE`).catch(() => {});

    // 39. Audit log — append-only state change log (never updated or deleted)
    await db.query(`
      CREATE TABLE IF NOT EXISTS audit_log (
        audit_id             SERIAL PRIMARY KEY,
        table_name           VARCHAR(100) NOT NULL,
        record_id            VARCHAR(100) NOT NULL,
        action               VARCHAR(50) NOT NULL,
        changed_by_staff_id  INTEGER,
        changed_by_user_id   INTEGER,
        old_value            JSONB,
        new_value            JSONB,
        changed_at           TIMESTAMP DEFAULT NOW(),
        ip_address           VARCHAR(45)
      )
    `);
    // The original audit_log.action was VARCHAR(10) with a CHECK limited to
    // INSERT/UPDATE/DELETE. CaseAuditLog.log writes SEMANTIC actions (e.g.
    // PAYMENT_VERIFIED, PAYMENT_REJECTED) which both overflow varchar(10) AND
    // violate that CHECK, so every such write failed silently — payment
    // verifications never reached the Audit Trail. Widen the column and drop the
    // restrictive CHECK (idempotent; safe on existing DBs).
    await db.query(`ALTER TABLE audit_log ALTER COLUMN action TYPE VARCHAR(50)`).catch(() => {});
    try {
      const cons = await db.query(
        `SELECT conname FROM pg_constraint WHERE conrelid = 'audit_log'::regclass AND contype = 'c'`);
      for (const row of cons.rows) {
        await db.query(`ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS "${row.conname}"`).catch(() => {});
      }
    } catch (_) { /* table may not exist yet on a brand-new DB — CREATE above handles it */ }
    await db.query(`CREATE INDEX IF NOT EXISTS idx_audit_log_table ON audit_log (table_name, record_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_audit_log_changed ON audit_log (changed_at DESC)`);

    // 40. Add case_id FK to existing tables
    await db.query(`ALTER TABLE intake_forms ADD COLUMN IF NOT EXISTS case_id VARCHAR(20) REFERENCES cases(case_id) ON DELETE SET NULL`);
    await db.query(`ALTER TABLE intake_forms ADD COLUMN IF NOT EXISTS review_status VARCHAR(20) DEFAULT 'Pending'`);
    await db.query(`ALTER TABLE intake_forms ADD COLUMN IF NOT EXISTS reviewed_by INTEGER`);
    await db.query(`ALTER TABLE intake_forms ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMP`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_intake_case ON intake_forms (case_id)`);

    await db.query(`ALTER TABLE assessment_intake_forms ADD COLUMN IF NOT EXISTS case_id VARCHAR(20) REFERENCES cases(case_id) ON DELETE SET NULL`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_assessment_intake_case ON assessment_intake_forms (case_id)`);

    await db.query(`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS case_id VARCHAR(20) REFERENCES cases(case_id) ON DELETE SET NULL`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_appt_case ON appointments (case_id)`);

    await db.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS case_id VARCHAR(20) REFERENCES cases(case_id) ON DELETE SET NULL`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_payments_case ON payments (case_id)`);

    await db.query(`ALTER TABLE psychological_reports ADD COLUMN IF NOT EXISTS case_id VARCHAR(20) REFERENCES cases(case_id) ON DELETE SET NULL`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_psy_reports_case ON psychological_reports (case_id)`);

    await db.query(`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS case_id VARCHAR(20)`);

    console.log('✅ Case-centered architecture tables ready.');

    // ── 41. Partner Schools (logo carousel on landing page) ──────────────
    await db.query(`
      CREATE TABLE IF NOT EXISTS partner_schools (
        id          SERIAL PRIMARY KEY,
        school_name VARCHAR(200) NOT NULL,
        logo_path   TEXT NOT NULL,
        is_enabled  BOOLEAN DEFAULT TRUE,
        sort_order  INTEGER DEFAULT 0,
        created_at  TIMESTAMP DEFAULT NOW(),
        updated_at  TIMESTAMP DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_partner_schools_enabled ON partner_schools (is_enabled)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_partner_schools_order ON partner_schools (sort_order)`);

    // Seed with existing logos when table is empty
    const partnerCount = await db.query(`SELECT COUNT(*) FROM partner_schools`);
    if (parseInt(partnerCount.rows[0].count, 10) === 0) {
      const SEED_PARTNERS = [
        ['PUP', '/partnership-school-logos/PUP-logo.png'],
        ['Adamson University', '/partnership-school-logos/ADAMSON-logo.png'],
        ['De La Salle University', '/partnership-school-logos/dlsu-logo.png'],
        ['PCU', '/partnership-school-logos/PCU-logo.png'],
        ['BSU', '/partnership-school-logos/BSU-logo.png'],
        ['MSEUF', '/partnership-school-logos/MSEUF-logo.png'],
        ['University of Batangas', '/partnership-school-logos/UB-logo.png'],
        ['UST', '/partnership-school-logos/UST-logo.png'],
        ['CEU', '/partnership-school-logos/CEU-logo.png'],
        ['WCC', '/partnership-school-logos/WCC-logo.png'],
        ['National University', '/partnership-school-logos/NU-logo.png'],
        ['SPUD', '/partnership-school-logos/SPUD-logo.png'],
        ['NTC', '/partnership-school-logos/NTC-logo.png'],
        ['LSPU', '/partnership-school-logos/LSPU-logo.png'],
        ['University of the East', '/partnership-school-logos/UE-logo.png'],
        ['Lyceum of the Philippines University', '/partnership-school-logos/LPU-logo.png'],
        ['Samar State University', '/partnership-school-logos/SAMAR-STATE-logo.png'],
        ['Miriam College', '/partnership-school-logos/MIRIAM-logo.png'],
        ['San Beda University', '/partnership-school-logos/SAN-BEDA-logo.png'],
        ['PNU', '/partnership-school-logos/PNU-logo.png'],
        ['CDSGA', '/partnership-school-logos/CDSGA-logo.png'],
        ['DLSU Dasmarinas', '/partnership-school-logos/DLSU-DASMA-logo.png'],
        ['OLFU', '/partnership-school-logos/OLFU-logo.png'],
      ];
      for (let i = 0; i < SEED_PARTNERS.length; i++) {
        await db.query(
          `INSERT INTO partner_schools (school_name, logo_path, is_enabled, sort_order) VALUES ($1, $2, TRUE, $3)`,
          [SEED_PARTNERS[i][0], SEED_PARTNERS[i][1], i]
        );
      }
      console.log('✅ Partner schools seeded with', SEED_PARTNERS.length, 'logos.');
    }

    // ── 42. Staff schedule (JSONB column for appointment filtering) ───────
    await db.query(`ALTER TABLE staff ADD COLUMN IF NOT EXISTS schedule JSONB DEFAULT '[]'::jsonb`);

    // ════════════════════════════════════════════════════════════════════
    // ID-CENTRALIZATION — Steps 43–47
    // Human-readable unique codes for traceability across the system.
    // Format:
    //   User    → USR-YYYY-NNNN  (clinical_director user → CDR-YYYY-NNNN)
    //   Staff   → {PSY|PSM|SPM|QCP|CDR|STF}-YYYY-NNNN  (by role)
    //   Report  → BPS-RPT-YYYY-NNNNN (e.g. BPS-RPT-2026-00001)
    // Legacy BPS-U-/BPS-S- codes are re-normalized to the above on migrate.
    // All codes carry a UNIQUE constraint so duplicates are impossible
    // at the DB level even under concurrent inserts.
    // ════════════════════════════════════════════════════════════════════

    // ── 43. user_code on users ───────────────────────────────────────────
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS user_code VARCHAR(20) UNIQUE`);
    await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_user_code ON users (user_code)`);
    // Helper: next sequence number for a given user_code prefix (e.g. "USR-2026-").
    const nextUserSeq = async (prefix) => {
      const last = await db.query(
        `SELECT user_code FROM users WHERE user_code LIKE $1 ORDER BY user_code DESC LIMIT 1`,
        [prefix + '%']
      );
      let seq = 1;
      if (last.rows.length > 0) {
        const parsed = parseInt(last.rows[0].user_code.split('-').pop(), 10);
        if (!isNaN(parsed)) seq = parsed + 1;
      }
      return seq;
    };
    // Re-code any rows that are missing a code OR still carry the legacy
    // BPS-U- format, so every user follows the canonical scheme:
    //   client / default → USR-YYYY-NNNN
    //   clinical_director → CDR-YYYY-NNNN
    const usersToCode = await db.query(
      `SELECT id, role FROM users
       WHERE user_code IS NULL OR user_code LIKE 'BPS-U-%'
       ORDER BY id`
    );
    for (const row of usersToCode.rows) {
      const year = new Date().getFullYear();
      // Users always get USR-; CDR- is reserved for the staff table (see below).
      const prefix = `USR-${year}-`;
      const seq = await nextUserSeq(prefix);
      const code = `${prefix}${String(seq).padStart(4, '0')}`;
      await db.query(`UPDATE users SET user_code = $1 WHERE id = $2`, [code, row.id]);
    }
    if (usersToCode.rows.length > 0) {
      console.log(`✅ Normalized user_code for ${usersToCode.rows.length} user(s) (USR scheme).`);
    }

    // ── 43b. Fix the CDR- collision: re-code any legacy users.user_code that
    // used the CDR- prefix into USR-. The clinical-director identity lives on the
    // staff table now, so CDR- must be unique to staff_code; otherwise the merged
    // audit view (user_code || staff_code) shows two different people under the
    // same code. user_code is display/trace only (never an FK target), so
    // re-coding is safe.
    const cdrUsers = await db.query(
      `SELECT id FROM users WHERE user_code LIKE 'CDR-%' ORDER BY id`
    );
    for (const row of cdrUsers.rows) {
      const year = new Date().getFullYear();
      const prefix = `USR-${year}-`;
      const seq = await nextUserSeq(prefix);
      const code = `${prefix}${String(seq).padStart(4, '0')}`;
      await db.query(`UPDATE users SET user_code = $1 WHERE id = $2`, [code, row.id]);
    }
    if (cdrUsers.rows.length > 0) {
      console.log(`✅ Re-coded ${cdrUsers.rows.length} legacy CDR- user(s) to USR- (resolved staff_code collision).`);
    }

    // ── 44. staff_code on staff ──────────────────────────────────────────
    await db.query(`ALTER TABLE staff ADD COLUMN IF NOT EXISTS staff_code VARCHAR(20) UNIQUE`);
    await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_staff_code ON staff (staff_code)`);
    // Canonical role → prefix map (must stay in sync with Staff.ROLE_PREFIX).
    const STAFF_ROLE_PREFIX = {
      psychologist: 'PSY',
      psychometrician: 'PSM',
      supervising_psychometrician: 'SPM',
      qc_psychometrician: 'QCP',
      clinical_director: 'CDR',
      staff: 'STF',
    };
    const nextStaffSeq = async (prefix) => {
      const last = await db.query(
        `SELECT staff_code FROM staff WHERE staff_code LIKE $1 ORDER BY staff_code DESC LIMIT 1`,
        [prefix + '%']
      );
      let seq = 1;
      if (last.rows.length > 0) {
        const parsed = parseInt(last.rows[0].staff_code.split('-').pop(), 10);
        if (!isNaN(parsed)) seq = parsed + 1;
      }
      return seq;
    };
    // Re-code any rows that are missing a code OR still carry the legacy
    // BPS-S- format, so every staff member follows the role-based scheme
    // (PSY/PSM/SPM/QCP/CDR/STF)-YYYY-NNNN.
    const staffToCode = await db.query(
      `SELECT staff_id, role FROM staff
       WHERE staff_code IS NULL OR staff_code LIKE 'BPS-S-%'
       ORDER BY staff_id`
    );
    for (const row of staffToCode.rows) {
      const year = new Date().getFullYear();
      const pfx = STAFF_ROLE_PREFIX[row.role] || 'STF';
      const prefix = `${pfx}-${year}-`;
      const seq = await nextStaffSeq(prefix);
      const code = `${prefix}${String(seq).padStart(4, '0')}`;
      await db.query(`UPDATE staff SET staff_code = $1 WHERE staff_id = $2`, [code, row.staff_id]);
    }
    if (staffToCode.rows.length > 0) {
      console.log(`✅ Normalized staff_code for ${staffToCode.rows.length} staff member(s) (role-based scheme).`);
    }

    // ── 45. Workflow fields on psychological_reports ─────────────────────
    // report_code — human-readable traceable ID
    await db.query(`ALTER TABLE psychological_reports ADD COLUMN IF NOT EXISTS report_code VARCHAR(25) UNIQUE`);
    await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_psy_reports_code ON psychological_reports (report_code)`);
    // client_id — explicit FK to the client (users table), separate from psychologist_id
    await db.query(`ALTER TABLE psychological_reports ADD COLUMN IF NOT EXISTS client_id INTEGER REFERENCES users(id) ON DELETE SET NULL`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_psy_reports_client ON psychological_reports (client_id)`);
    // Workflow actor columns (staff_id values — FK decoupled like other staff columns)
    await db.query(`ALTER TABLE psychological_reports ADD COLUMN IF NOT EXISTS prepared_by INTEGER`);
    await db.query(`ALTER TABLE psychological_reports ADD COLUMN IF NOT EXISTS reviewed_by INTEGER`);
    await db.query(`ALTER TABLE psychological_reports ADD COLUMN IF NOT EXISTS approved_by INTEGER`);
    // Lock flag — Clinical Director can freeze a report against further edits
    await db.query(`ALTER TABLE psychological_reports ADD COLUMN IF NOT EXISTS is_locked BOOLEAN DEFAULT FALSE`);
    // Revision notes — stored when psychologist or QCP requests changes
    await db.query(`ALTER TABLE psychological_reports ADD COLUMN IF NOT EXISTS revision_notes TEXT`).catch(() => {});
    await db.query(`ALTER TABLE psychological_reports ADD COLUMN IF NOT EXISTS qc_revision_notes TEXT`).catch(() => {});
    await db.query(`ALTER TABLE psychological_reports ADD COLUMN IF NOT EXISTS qc_reviewed_by INTEGER`).catch(() => {});
    // Report-concern modification state — set when a client concern about a
    // RELEASED report requires the authoring psychologist to edit it. Layered on
    // top of signature_stage='released' (which stays intact so client delivery and
    // the released-report dropdowns keep working). modification_status drives the
    // "Modification Required" / "Modified Report Submitted" badge in the report
    // module; active_concern_id links the report to the concern being worked on.
    await db.query(`ALTER TABLE psychological_reports ADD COLUMN IF NOT EXISTS modification_status VARCHAR(40)`).catch(() => {});
    await db.query(`ALTER TABLE psychological_reports ADD COLUMN IF NOT EXISTS active_concern_id INTEGER`).catch(() => {});
    // Legacy/back-filled report: a previously-physical report digitized by the CD
    // so an old client's copy/concern request can use the normal pipeline.
    await db.query(`ALTER TABLE psychological_reports ADD COLUMN IF NOT EXISTS is_legacy BOOLEAN DEFAULT FALSE`).catch(() => {});
    // Extend status to include the 3-stage workflow values and new revision statuses
    await db.query(`ALTER TABLE psychological_reports DROP CONSTRAINT IF EXISTS psychological_reports_status_check`);
    await db.query(`
      ALTER TABLE psychological_reports ADD CONSTRAINT psychological_reports_status_check
      CHECK (status IN (
        'draft','submitted','approved','rejected','finalized',
        'Prepared','Review','Approved',
        'revision_requested','revision_requested_qc'
      ))
    `);
    // Backfill report_code for existing reports.
    const uncodedReports = await db.query(
      `SELECT id FROM psychological_reports WHERE report_code IS NULL ORDER BY id`
    );
    for (const row of uncodedReports.rows) {
      const year = new Date().getFullYear();
      const prefix = `BPS-RPT-${year}-`;
      const last = await db.query(
        `SELECT report_code FROM psychological_reports WHERE report_code LIKE $1 ORDER BY report_code DESC LIMIT 1`,
        [prefix + '%']
      );
      let seq = 1;
      if (last.rows.length > 0) {
        seq = parseInt(last.rows[0].report_code.split('-').pop(), 10) + 1;
      }
      const code = `${prefix}${String(seq).padStart(5, '0')}`;
      await db.query(`UPDATE psychological_reports SET report_code = $1 WHERE id = $2`, [code, row.id]);
    }
    if (uncodedReports.rows.length > 0) {
      console.log(`✅ Backfilled report_code for ${uncodedReports.rows.length} existing report(s).`);
    }

    // ── 46. Backfill client_id on psychological_reports from cases ───────
    // Pull the client user_id from the linked case (where case_id is set).
    await db.query(`
      UPDATE psychological_reports pr
      SET client_id = c.user_id
      FROM cases c
      WHERE pr.case_id = c.case_id
        AND pr.client_id IS NULL
        AND pr.case_id IS NOT NULL
    `);

    // ── 47. Drop dead notification deep-link columns ─────────────────────
    // related_id, related_type and report_code were never written or read —
    // notification deep-linking is handled entirely by the `link` column.
    await db.query(`ALTER TABLE notifications DROP COLUMN IF EXISTS related_id`);
    await db.query(`ALTER TABLE notifications DROP COLUMN IF EXISTS related_type`);
    await db.query(`ALTER TABLE notifications DROP COLUMN IF EXISTS report_code`);

    console.log('✅ ID-centralization columns ready (user_code, staff_code, report_code, workflow fields).');

    // ── 47b. INT- reference number on assessment_intake_forms ────────────
    // Human-readable intake reference (e.g. INT-20260624-0001), assigned by a
    // BEFORE INSERT trigger so EVERY creation path gets one automatically — the
    // direct controller insert AND the payment-promotion path (intakePromote.js)
    // — without editing either insert statement. The UNIQUE constraint makes a
    // duplicate impossible even under a concurrent-insert race (the second insert
    // simply errors and retries, same guarantee as user_code/staff_code).
    await db.query(`ALTER TABLE assessment_intake_forms ADD COLUMN IF NOT EXISTS intake_ref_no VARCHAR(20) UNIQUE`);
    await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_assessment_intake_ref ON assessment_intake_forms (intake_ref_no)`);
    await db.query(`
      CREATE OR REPLACE FUNCTION assign_intake_ref_no() RETURNS trigger AS $$
      DECLARE
        d     TEXT := to_char(COALESCE(NEW.created_at, NOW()), 'YYYYMMDD');
        pfx   TEXT;
        nextn INT;
      BEGIN
        IF NEW.intake_ref_no IS NULL THEN
          pfx := 'INT-' || d || '-';
          SELECT COALESCE(MAX(CAST(split_part(intake_ref_no, '-', 3) AS INT)), 0) + 1
            INTO nextn
            FROM assessment_intake_forms
            WHERE intake_ref_no LIKE pfx || '%';
          NEW.intake_ref_no := pfx || lpad(nextn::text, 4, '0');
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await db.query(`DROP TRIGGER IF EXISTS trg_assign_intake_ref_no ON assessment_intake_forms`);
    await db.query(`
      CREATE TRIGGER trg_assign_intake_ref_no
        BEFORE INSERT ON assessment_intake_forms
        FOR EACH ROW EXECUTE FUNCTION assign_intake_ref_no()
    `);
    // Backfill existing rows in chronological order so historical numbering is stable.
    await db.query(`
      DO $$
      DECLARE r RECORD; d TEXT; pfx TEXT; nextn INT;
      BEGIN
        FOR r IN SELECT id, created_at FROM assessment_intake_forms
                 WHERE intake_ref_no IS NULL ORDER BY created_at, id LOOP
          d   := to_char(COALESCE(r.created_at, NOW()), 'YYYYMMDD');
          pfx := 'INT-' || d || '-';
          SELECT COALESCE(MAX(CAST(split_part(intake_ref_no, '-', 3) AS INT)), 0) + 1 INTO nextn
            FROM assessment_intake_forms WHERE intake_ref_no LIKE pfx || '%';
          UPDATE assessment_intake_forms SET intake_ref_no = pfx || lpad(nextn::text, 4, '0') WHERE id = r.id;
        END LOOP;
      END $$;
    `);
    console.log('✅ INT- reference numbers ready on assessment_intake_forms (trigger + backfill).');

    // ── 48. Security – teleconference OTP table ───────────────────────────
    await db.query(`
      CREATE TABLE IF NOT EXISTS teleconf_otp (
        id         SERIAL PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        otp_hash   TEXT    NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        is_used    BOOLEAN DEFAULT FALSE,
        attempts   INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_teleconf_otp_user_id ON teleconf_otp(user_id)`);
    // Per-code brute-force guard (existing DBs): counts wrong guesses so the code
    // is burned after too many (see TeleconfOtp.verify).
    await db.query(`ALTER TABLE teleconf_otp ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0`);
    // teleconf_otp.user_id may be a users.id OR a staff.staff_id (teleconference is
    // used by both clients and staff). Drop the users(id) FK so staff can receive
    // OTPs — otherwise the INSERT fails for staff and they never get a code.
    await db.query(`ALTER TABLE teleconf_otp DROP CONSTRAINT IF EXISTS teleconf_otp_user_id_fkey`).catch(() => {});

    // ── 48b. Security – module-access OTP table ───────────────────────────
    // Email-OTP gate for sensitive STAFF-only modules (Case Management, Staff
    // Management, Payment Verification). Same shape/policy as teleconf_otp but a
    // separate table so the two flows never collide on the same user's "latest
    // unused code". user_id may be a users.id OR a staff.staff_id (staff-only in
    // practice) so the users(id) FK is dropped just like teleconf_otp.
    await db.query(`
      CREATE TABLE IF NOT EXISTS module_access_otp (
        id         SERIAL PRIMARY KEY,
        user_id    INTEGER NOT NULL,
        module     VARCHAR(60),
        otp_hash   TEXT    NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        is_used    BOOLEAN DEFAULT FALSE,
        attempts   INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_module_access_otp_user_id ON module_access_otp(user_id)`);
    // Per-code brute-force guard (existing DBs): counts wrong guesses so the code
    // is burned after too many (see ModuleOtp.verify).
    await db.query(`ALTER TABLE module_access_otp ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0`);

    // ── 49. Security audit log table ─────────────────────────────────────
    await db.query(`
      CREATE TABLE IF NOT EXISTS security_audit_log (
        id         SERIAL PRIMARY KEY,
        user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
        event_type VARCHAR(80)  NOT NULL,
        action     VARCHAR(80),
        score      NUMERIC(4,3),
        reason     VARCHAR(255),
        context    VARCHAR(80),
        ip_address VARCHAR(45),
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_sec_audit_user_id   ON security_audit_log(user_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_sec_audit_event_type ON security_audit_log(event_type)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_sec_audit_created_at ON security_audit_log(created_at DESC)`);

    console.log('✅ Security tables ready (teleconf_otp, module_access_otp, security_audit_log).');

    // ── 50. Audit Action Management (security incidents) ─────────────────
    // Severity tags every recorded security event; Medium/High/Critical events
    // open an incident that the Clinical Director tracks to resolution.
    await db.query(`ALTER TABLE security_audit_log ADD COLUMN IF NOT EXISTS severity VARCHAR(10) DEFAULT 'low'`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_sec_audit_severity ON security_audit_log(severity)`);

    await db.query(`
      CREATE TABLE IF NOT EXISTS security_incidents (
        id                   SERIAL PRIMARY KEY,
        event_id             INTEGER,
        module               VARCHAR(40)  NOT NULL,
        event_type           VARCHAR(80)  NOT NULL,
        title                VARCHAR(160) NOT NULL,
        severity             VARCHAR(10)  NOT NULL DEFAULT 'medium',
        status               VARCHAR(20)  NOT NULL DEFAULT 'open',
        recommended_action   TEXT,
        escalation_path      TEXT,
        resolution_procedure TEXT,
        resolution_notes     TEXT,
        subject_user_id      INTEGER,
        ip_address           VARCHAR(45),
        closure_approved_by  INTEGER,
        created_at           TIMESTAMPTZ DEFAULT NOW(),
        updated_at           TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_sec_inc_status   ON security_incidents(status)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_sec_inc_severity ON security_incidents(severity)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_sec_inc_module   ON security_incidents(module)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_sec_inc_created  ON security_incidents(created_at DESC)`);

    await db.query(`
      CREATE TABLE IF NOT EXISTS security_incident_actions (
        id          SERIAL PRIMARY KEY,
        incident_id INTEGER NOT NULL REFERENCES security_incidents(id) ON DELETE CASCADE,
        actor_id    INTEGER,
        action_type VARCHAR(30) NOT NULL,
        label       VARCHAR(160),
        from_value  VARCHAR(40),
        to_value    VARCHAR(40),
        note        TEXT,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_sec_inc_act_incident ON security_incident_actions(incident_id)`);

    // Subject kind disambiguates whether subject_user_id is a users.id (client)
    // or a staff.staff_id, so executable response actions target the right table.
    await db.query(`ALTER TABLE security_incidents ADD COLUMN IF NOT EXISTS subject_kind VARCHAR(10)`);

    // Account-suspension flag for clients (staff already have staff.is_active).
    // Enforced at client login so "Suspend / Restrict Access" actions take effect.
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE`);

    // Action Center → User Access response actions:
    //  • must_reset_password    → Force Password Reset (redirect to reset page after OTP)
    //  • sessions_invalid_after → Require MFA / Suspend (real-time session termination:
    //    any JWT issued before this instant is rejected on its next request)
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS must_reset_password BOOLEAN DEFAULT FALSE`);
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS sessions_invalid_after TIMESTAMPTZ`);
    await db.query(`ALTER TABLE staff ADD COLUMN IF NOT EXISTS sessions_invalid_after TIMESTAMPTZ`);

    // Target resource captured at emission so resource-specific response actions
    // (remove participant from a session, lock/hide a thread or comment, …) can
    // act on the exact record. e.g. target_type='session'|'thread'|'reply'|'article'.
    await db.query(`ALTER TABLE security_incidents ADD COLUMN IF NOT EXISTS target_type VARCHAR(40)`);
    await db.query(`ALTER TABLE security_incidents ADD COLUMN IF NOT EXISTS target_id VARCHAR(60)`);

    console.log('✅ Action Management tables ready (security_incidents, security_incident_actions).');
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
  // Permanently neutralize the out-of-band `notification_category` ENUM.
  //
  // Some databases were provisioned with a `notifications.category` column typed
  // as a Postgres ENUM (`notification_category`) that predates newer notification
  // kinds such as 'ticket'. Writing a newer value then fails with:
  //   invalid input value for enum notification_category: "ticket"
  //
  // Appending the missing values via `ALTER TYPE ... ADD VALUE` is unreliable: a
  // newly added enum label cannot be used in the same transaction that added it,
  // so the failing write can still slip through on the same migration run. Instead
  // we convert the column to a plain VARCHAR (preserving its current text values)
  // and drop the now-unused enum type. After this the column accepts any value the
  // application emits and this error class is gone for good.
  //
  // Fully idempotent and safe on fresh databases: when the column is already a
  // VARCHAR (or absent), the guarded block does nothing.
  try {
    // Convert EVERY notifications column backed by the enum (could be `type`
    // and/or `category`) to plain VARCHAR, preserving its current text values.
    await db.query(`
      DO $$
      DECLARE
        col text;
      BEGIN
        FOR col IN
          SELECT column_name
            FROM information_schema.columns
           WHERE table_name = 'notifications'
             AND udt_name   = 'notification_category'
        LOOP
          EXECUTE format('ALTER TABLE notifications ALTER COLUMN %I DROP DEFAULT', col);
          EXECUTE format('ALTER TABLE notifications ALTER COLUMN %I TYPE VARCHAR(40) USING %I::text', col, col);
        END LOOP;
      END $$;
    `);

    // Drop the orphaned enum type (best-effort — harmless if still referenced
    // elsewhere or already gone).
    await db.query(`DROP TYPE IF EXISTS notification_category`);
  } catch (err) {
    // Never let this reconciliation abort the wider migration run.
    console.error('⚠️  notification_category enum neutralize skipped:', err.message);
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
        -- NOTE: report-request payment data lives in the centralized payments
        -- table (module=report_request, RPM- ref) and report PDFs live in
        -- client_request_report_versions. The old inline payment_*/report_file
        -- columns were removed from this table (dropped below for existing DBs).
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
    // payment_rejection_reason / receipt_number / receipt_issued_at were removed —
    // that data now lives on the payments row (rejection_reason, verified_at, and
    // a derived RPM-…-RCPT receipt). Do NOT re-add them here.
    await db.query(`ALTER TABLE client_requests ADD COLUMN IF NOT EXISTS sent_at                  TIMESTAMP`);
    await db.query(`ALTER TABLE client_requests ADD COLUMN IF NOT EXISTS sent_by                  INTEGER REFERENCES users(id) ON DELETE SET NULL`);
    // Number of copies requested (only meaningful for additional_copies). Default 1.
    await db.query(`ALTER TABLE client_requests ADD COLUMN IF NOT EXISTS copies                   INTEGER DEFAULT 1`);

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

    // ════════════════════════════════════════════════════════════════════
    // Request-Concern workflow v3 — payment + psychologist-modify + release
    // --------------------------------------------------------------------
    // A report concern is now a full pipeline linked to the ORIGINAL released
    // report (and through it the Case): Clinical Director review (approve/reject)
    // → client payment → Supervising-Psychometrician verification → the assigned
    // Psychologist modifies the report + uploads a modified PDF → Clinical
    // Director final review (Release / Request Revision, looping). These columns
    // bind the concern to the source report/case, record the psychologist who
    // authored it, and store the CD's revision note. concern_status is a free
    // VARCHAR(40) (no CHECK) so the new lifecycle labels need no constraint edit.
    //   Lifecycle: Pending Review → Awaiting Payment → Payment Verification
    //   Pending → Payment Verification Failed / Payment Verified → Modified
    //   Report Submitted → Revision Required → Resolved   (or Rejected).
    // ════════════════════════════════════════════════════════════════════
    // Plain columns (no inline FK) so they always materialize regardless of
    // table-creation ordering; ownership/linkage is enforced in app logic.
    await db.query(`ALTER TABLE client_requests ADD COLUMN IF NOT EXISTS case_id                 VARCHAR(20)`).catch(() => {});
    await db.query(`ALTER TABLE client_requests ADD COLUMN IF NOT EXISTS report_id               INTEGER`).catch(() => {});
    // The PSYCHOLOGIST who finalized/approved the source report
    // (psychological_reports.approved_by = staff.staff_id) — the author of record
    // who handles concerns about it. Plain INTEGER because staff are not users.
    await db.query(`ALTER TABLE client_requests ADD COLUMN IF NOT EXISTS assigned_psychologist_id INTEGER`).catch(() => {});
    await db.query(`ALTER TABLE client_requests ADD COLUMN IF NOT EXISTS concern_revision_note   TEXT`).catch(() => {});
    // ── Legacy / external reports ──────────────────────────────────────────
    // Old clients whose report predates the online system (or is paper-only) can
    // request a copy / raise a concern about it. Such requests carry is_legacy and
    // an identity-verification stage (legacy_status) BEFORE the normal pipeline.
    // The CD verifies identity (mandatory photo ID) + digitizes the report, which
    // links report_id and hands the request to the existing pipeline.
    await db.query(`ALTER TABLE client_requests ADD COLUMN IF NOT EXISTS is_legacy        BOOLEAN DEFAULT FALSE`).catch(() => {});
    await db.query(`ALTER TABLE client_requests ADD COLUMN IF NOT EXISTS legacy_status    VARCHAR(40)`).catch(() => {});
    await db.query(`ALTER TABLE client_requests ADD COLUMN IF NOT EXISTS id_document      TEXT`).catch(() => {});
    await db.query(`ALTER TABLE client_requests ADD COLUMN IF NOT EXISTS id_document_name VARCHAR(255)`).catch(() => {});
    await db.query(`ALTER TABLE client_requests ADD COLUMN IF NOT EXISTS id_document_mime VARCHAR(100)`).catch(() => {});
    await db.query(`CREATE INDEX IF NOT EXISTS idx_creq_report ON client_requests (report_id)`).catch(() => {});
    await db.query(`CREATE INDEX IF NOT EXISTS idx_creq_concern_case ON client_requests (case_id)`).catch(() => {});

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

    // Re-route every concern to the PSYCHOLOGIST who finalized/approved its linked
    // report (psychological_reports.approved_by), not the staff member who merely
    // prepared it. Earlier builds stamped assigned_psychologist_id from the
    // report's psychologist_id (the preparer); this self-heals that data so the
    // correct psychologist is notified and can open/modify the report. Idempotent.
    await db.query(`
      UPDATE client_requests cr
      SET assigned_psychologist_id = pr.approved_by
      FROM psychological_reports pr
      WHERE cr.report_id = pr.id
        AND cr.nature = 'report_concern'
        AND pr.approved_by IS NOT NULL
        AND cr.assigned_psychologist_id IS DISTINCT FROM pr.approved_by
    `).catch((e) => console.warn('concern psychologist backfill skipped:', e.message));

    // Surface the report-concern modification state on the report itself for any
    // concern that is already mid-flight (verified/in-revision/submitted) so the
    // "Modification Required" / "Modified Report Submitted" badge + actions appear
    // without waiting for the next concern event. Picks the most recent active
    // concern per report. Idempotent / self-healing on every start.
    await db.query(`
      UPDATE psychological_reports pr
      SET modification_status = CASE WHEN a.concern_status = 'Modified Report Submitted'
                                     THEN 'Modified Report Submitted' ELSE 'Modification Required' END,
          active_concern_id = a.concern_id
      FROM (
        SELECT DISTINCT ON (cr.report_id) cr.report_id, cr.id AS concern_id, cr.concern_status
        FROM client_requests cr
        WHERE cr.nature = 'report_concern' AND cr.report_id IS NOT NULL
          AND cr.is_legacy IS NOT TRUE
          AND cr.concern_status IN ('Payment Verified', 'Revision Required', 'Modified Report Submitted')
        ORDER BY cr.report_id, cr.id DESC
      ) a
      WHERE pr.id = a.report_id
    `).catch((e) => console.warn('report modification_status backfill skipped:', e.message));

    // Legacy reports are delivered as-is (no in-report modification / "Legacy
    // Report" status) — clear any modification flag left on a digitized legacy
    // report so it shows as a normal Released report in the report module.
    await db.query(`
      UPDATE psychological_reports SET modification_status = NULL, active_concern_id = NULL
      WHERE is_legacy = TRUE AND modification_status IS NOT NULL
    `).catch((e) => console.warn('legacy modification_status cleanup skipped:', e.message));

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
    // S3 serving copy of this report version. The base64 `file` column stays the
    // source of truth (covered by the daily DB backup); s3_key lets the client's
    // Download / "Use Stored Report" be served from S3 via a presigned URL.
    // NULL for older versions → callers fall back to the base64 `file`.
    await db.query(`ALTER TABLE client_request_report_versions ADD COLUMN IF NOT EXISTS s3_key VARCHAR(512)`).catch(() => {});

    // ── Move report blobs OUT of client_requests into the version table ──
    // client_request_report_versions is the single source of truth for report
    // files. Historically the additional-copies flow wrote the base64 PDF into
    // client_requests.report_file directly; the concern flow duplicated it there
    // as a "latest" cache. Both are migrated here:
    //   • additional-copies requests with a report_file but NO version row yet
    //     get a version 1 created from that blob;
    //   • then the deprecated base64 cache is nulled everywhere.
    // client_requests retains only lightweight pointers (report_filename,
    // report_mime, report_version, report_released_at). The report_file column is
    // kept (now always NULL) to avoid a destructive drop; it is deprecated and no
    // longer written. Idempotent: re-running moves nothing once cleared.
    // Guard on the column still existing: on databases where report_file has
    // already been dropped this backfill is complete and would otherwise log
    // "column cr.report_file does not exist" on every startup.
    const hasReportFile = await db.query(`
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'client_requests' AND column_name = 'report_file'
    `);
    if (hasReportFile.rows.length) {
      await db.query(`
        INSERT INTO client_request_report_versions
          (request_id, version_number, file, filename, mime, change_note, created_at)
        SELECT cr.id, 1, cr.report_file,
               COALESCE(cr.report_filename, 'report.pdf'),
               COALESCE(cr.report_mime, 'application/pdf'),
               'Migrated from client_requests.report_file',
               COALESCE(cr.report_released_at, NOW())
        FROM client_requests cr
        WHERE cr.report_file IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM client_request_report_versions v WHERE v.request_id = cr.id
          )
      `).catch((e) => console.error('report_file → versions migration:', e.message));
      await db.query(`UPDATE client_requests SET report_file = NULL WHERE report_file IS NOT NULL`).catch(() => {});
    }

    // ── Link payments → report requests (centralized payment design) ──
    // Report-request payments now live in the centralized `payments` table (and
    // therefore in the Payment Verification module) instead of the inline
    // client_requests.payment_* columns. A payment is tagged module='report_request'
    // with an RPM- reference and points back at its request via client_request_id.
    // (The old payments.report_request_id FK pointed at the dropped report_requests
    // table and has been removed.)
    await db.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS client_request_id INTEGER REFERENCES client_requests(id) ON DELETE SET NULL`).catch(() => {});
    await db.query(`CREATE INDEX IF NOT EXISTS idx_payments_client_request ON payments (client_request_id)`).catch(() => {});
    await db.query(`UPDATE payments SET module = 'report_request' WHERE client_request_id IS NOT NULL AND module <> 'report_request'`).catch(() => {});

    // ── Backfill in-flight INLINE request payments into the payments table, then
    // DROP the redundant inline columns. client_requests is no longer a payment
    // store: report-request payments live in `payments` (module='report_request',
    // RPM-) and report PDFs in client_request_report_versions. The backfill is
    // guarded so it only runs while the legacy columns still exist (existing DBs);
    // on a fresh DB those columns never existed and the DROPs are no-ops.
    await db.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'client_requests' AND column_name = 'payment_required') THEN
          INSERT INTO payments (
            reference_number, client_request_id, client_id, module, service_label,
            payment_option, payment_method, amount_due, total_fee, outstanding_balance,
            status, proof_of_payment, proof_filename, rejection_reason, verified_at,
            expires_at, agreed_no_cancellation, created_at
          )
          SELECT
            COALESCE(NULLIF(cr.payment_reference, ''),
                     'RPM-' || to_char(COALESCE(cr.approved_at, cr.created_at), 'YYYYMMDD') || '-' || lpad(cr.id::text, 4, '0')),
            cr.id, cr.client_id, 'report_request', 'Report request ' || cr.ticket_number,
            'full', 'GCash', COALESCE(cr.payment_amount, 1), COALESCE(cr.payment_amount, 1), 0,
            CASE cr.payment_status
              WHEN 'awaiting_payment' THEN 'pending'
              WHEN 'under_review'     THEN 'under_review'
              WHEN 'verified'         THEN 'verified'
              WHEN 'rejected'         THEN 'rejected'
              ELSE 'pending' END,
            cr.payment_proof, cr.payment_proof_name, cr.payment_rejection_reason, cr.receipt_issued_at,
            NOW() + INTERVAL '1 year', 1, cr.created_at
          FROM client_requests cr
          WHERE cr.payment_required = TRUE
            AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.client_request_id = cr.id);
        END IF;
      END $$;
    `).catch((e) => console.error('client_requests payment backfill:', e.message));

    for (const col of [
      'report_file', 'payment_required', 'payment_amount', 'payment_status',
      'payment_proof', 'payment_proof_name', 'payment_reference',
      'payment_rejection_reason', 'receipt_number', 'receipt_issued_at',
    ]) {
      await db.query(`ALTER TABLE client_requests DROP COLUMN IF EXISTS ${col}`).catch(() => {});
    }
    console.log('✅ client_requests slimmed: report blobs → versions, payments → payments table, inline payment/receipt columns dropped.');
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

    // `gender` is a generic profile field. The staff-only specialization/position/
    // staff_profile_completed columns are legacy and intentionally NOT recreated
    // on `users` (clients don't use them; staff live in the `staff` table).
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS gender                  VARCHAR(20)`);

    // Per-code OTP brute-force guard: tracks how many wrong guesses have been made
    // against a single login code. verifyLoginOtp invalidates the code once this
    // reaches Verification.MAX_OTP_ATTEMPTS. Ensured up front so the model's
    // increment/select can never hit a missing column on an existing database.
    await db.query(`ALTER TABLE email_verifications ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0`);
  } catch (err) {
    console.error('❌ Failed ensuring feature columns:', err.message);
  }
}
