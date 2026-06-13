-- ============================================
-- Notification Schema Update
-- ============================================
-- Expands the notification type CHECK constraint to support
-- all system event types (intake, community, teleconference, appointment).
--
-- Run this AFTER access_operations_schema.sql:
--   psql -U postgres -d proman_db -f notification_schema_update.sql
-- ============================================

-- 1. Drop the old restrictive CHECK constraint
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;

-- 2. Add expanded CHECK constraint
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN (
    -- Original types
    'case_assigned', 'review_needed', 'validation_ready',
    'report_ready', 'system_alert', 'general',
    -- New event-driven types
    'appointment', 'teleconference', 'report',
    'community', 'intake', 'ticket'
  ));

-- 3. Add index on type for category filtering
CREATE INDEX IF NOT EXISTS idx_notifications_type ON notifications (type);

-- ============================================
-- 4. Intake Forms table
-- ============================================
CREATE TABLE IF NOT EXISTS intake_forms (
    id          SERIAL PRIMARY KEY,
    user_id     INTEGER       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    form_data   JSONB         NOT NULL,
    status      VARCHAR(20)   DEFAULT 'pending'
                CHECK (status IN ('pending', 'reviewed', 'approved', 'rejected')),
    created_at  TIMESTAMP     DEFAULT NOW(),
    updated_at  TIMESTAMP     DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_intake_forms_user_id ON intake_forms (user_id);
CREATE INDEX IF NOT EXISTS idx_intake_forms_status ON intake_forms (status);

-- ============================================
-- 5. Add status column to articles (moderation)
-- ============================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'articles' AND column_name = 'status'
  ) THEN
    ALTER TABLE articles ADD COLUMN status VARCHAR(20) DEFAULT 'pending'
      CHECK (status IN ('pending', 'approved', 'rejected'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_articles_status ON articles (status);

-- ============================================
-- DONE! Notification types expanded + intake_forms + article moderation.
-- ============================================
