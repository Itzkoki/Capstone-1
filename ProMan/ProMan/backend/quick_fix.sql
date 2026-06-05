-- ============================================
-- QUICK FIX: Run this in pgAdmin Query Tool
-- on the proman_db database
-- ============================================

-- 1. Fix notification types
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN (
    'case_assigned', 'review_needed', 'validation_ready',
    'report_ready', 'system_alert', 'general',
    'appointment', 'teleconference', 'report',
    'community', 'intake'
  ));

-- 2. Create intake_forms table if not exists
CREATE TABLE IF NOT EXISTS intake_forms (
    id          SERIAL PRIMARY KEY,
    user_id     INTEGER       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    form_data   JSONB         NOT NULL,
    status      VARCHAR(20)   DEFAULT 'pending'
                CHECK (status IN ('pending', 'reviewed', 'approved', 'rejected')),
    created_at  TIMESTAMP     DEFAULT NOW(),
    updated_at  TIMESTAMP     DEFAULT NOW()
);

-- 3. Add status column to articles for moderation
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'articles' AND column_name = 'status'
  ) THEN
    ALTER TABLE articles ADD COLUMN status VARCHAR(20) DEFAULT 'approved'
      CHECK (status IN ('pending', 'approved', 'rejected'));
  END IF;
END $$;

-- DONE!
SELECT 'Migration complete!' AS result;
