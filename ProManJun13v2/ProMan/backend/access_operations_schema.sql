-- ============================================
-- Access & Operations Module Schema
-- ============================================
-- Run AFTER setup_database.sql

-- ============================================
-- 1. Add role column to users table
-- ============================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'role'
  ) THEN
    ALTER TABLE users ADD COLUMN role VARCHAR(30) DEFAULT 'client'
      CHECK (role IN (
        'client',
        'psychometrician',
        'supervising_psychometrician',
        'qc_psychometrician',
        'psychologist',
        'clinical_director'
      ));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_users_role ON users (role);

-- ============================================
-- 2. Notifications
-- ============================================
CREATE TABLE IF NOT EXISTS notifications (
    id          SERIAL PRIMARY KEY,
    user_id     INTEGER       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type        VARCHAR(30)   NOT NULL CHECK (type IN (
                  'case_assigned','review_needed','validation_ready',
                  'report_ready','system_alert','general'
                )),
    title       VARCHAR(255)  NOT NULL,
    message     TEXT,
    is_read     BOOLEAN       DEFAULT FALSE,
    link        VARCHAR(500),
    created_at  TIMESTAMP     DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications (user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications (user_id, is_read);

-- ============================================
-- 3. Activity Logs (system-wide audit)
-- ============================================
CREATE TABLE IF NOT EXISTS activity_logs (
    id              SERIAL PRIMARY KEY,
    user_id         INTEGER       REFERENCES users(id) ON DELETE SET NULL,
    action          VARCHAR(100)  NOT NULL,
    resource_type   VARCHAR(50),
    resource_id     INTEGER,
    ip_address      VARCHAR(45),
    details         JSONB,
    created_at      TIMESTAMP     DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_activity_user_id ON activity_logs (user_id);
CREATE INDEX IF NOT EXISTS idx_activity_created_at ON activity_logs (created_at);
CREATE INDEX IF NOT EXISTS idx_activity_action ON activity_logs (action);

-- ============================================
-- 4. Articles (community repository)
-- ============================================
CREATE TABLE IF NOT EXISTS articles (
    id          SERIAL PRIMARY KEY,
    author_id   INTEGER       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title       VARCHAR(255)  NOT NULL,
    content     TEXT          NOT NULL,
    created_at  TIMESTAMP     DEFAULT NOW(),
    updated_at  TIMESTAMP     DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_articles_author ON articles (author_id);
CREATE INDEX IF NOT EXISTS idx_articles_created ON articles (created_at);

-- ============================================
-- 5. Meetings (teleconference)
-- ============================================
CREATE TABLE IF NOT EXISTS meetings (
    id                SERIAL PRIMARY KEY,
    host_id           INTEGER       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title             VARCHAR(255)  NOT NULL,
    meeting_link      VARCHAR(500)  NOT NULL,
    status            VARCHAR(20)   DEFAULT 'active' CHECK (status IN ('active','ended')),
    recording_consent BOOLEAN       DEFAULT FALSE,
    created_at        TIMESTAMP     DEFAULT NOW(),
    ended_at          TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_meetings_host ON meetings (host_id);
CREATE INDEX IF NOT EXISTS idx_meetings_status ON meetings (status);

-- ============================================
-- 6. System Settings (key-value config)
-- ============================================
CREATE TABLE IF NOT EXISTS system_settings (
    key         VARCHAR(100)  PRIMARY KEY,
    value       TEXT,
    updated_by  INTEGER       REFERENCES users(id) ON DELETE SET NULL,
    updated_at  TIMESTAMP     DEFAULT NOW()
);

-- Insert defaults
INSERT INTO system_settings (key, value) VALUES
  ('timezone', 'Asia/Manila'),
  ('date_format', 'YYYY-MM-DD'),
  ('session_timeout_minutes', '60'),
  ('password_min_length', '6'),
  ('max_login_attempts', '5')
ON CONFLICT (key) DO NOTHING;

-- ============================================
-- DONE! Access & Operations tables created.
-- ============================================
