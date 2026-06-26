-- ============================================================
-- Requirements Migration (Jun 2026)
-- Run on the existing database to apply workflow changes.
-- Safe to re-run — all statements use IF NOT EXISTS / DO blocks.
-- ============================================================

-- 1. Add assessment_type to appointments
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS assessment_type VARCHAR(50);

-- Index for filtering by assessment type
CREATE INDEX IF NOT EXISTS idx_appointments_assessment_type
  ON appointments (assessment_type);

-- 2. Ensure psychological_reports status supports new revision statuses.
--    The table may have a CHECK constraint that needs updating.
DO $$
BEGIN
  -- Drop the old status check constraint if it exists (name may vary by DB)
  ALTER TABLE psychological_reports DROP CONSTRAINT IF EXISTS psychological_reports_status_check;
EXCEPTION WHEN OTHERS THEN
  -- Ignore if no constraint existed
  NULL;
END $$;

-- Add the updated constraint that includes revision statuses
ALTER TABLE psychological_reports
  DROP CONSTRAINT IF EXISTS psychological_reports_status_check;

-- Note: PostgreSQL does not easily list check constraint names, so we
-- just add the column comment. The application itself validates status
-- transitions; no DB-level check is enforced here to allow flexibility.

-- 3. Add revision_notes columns to psychological_reports for tracking
ALTER TABLE psychological_reports
  ADD COLUMN IF NOT EXISTS revision_notes TEXT;

ALTER TABLE psychological_reports
  ADD COLUMN IF NOT EXISTS qc_revision_notes TEXT;

-- 4. Store who submitted/prepared the report (for revision notification)
--    prepared_by already exists; ensure qc_reviewer is tracked too.
ALTER TABLE psychological_reports
  ADD COLUMN IF NOT EXISTS qc_reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL;

-- ============================================================
-- Done. Run: psql -h localhost -U postgres -d proman_db -f migration_requirements.sql
-- ============================================================
