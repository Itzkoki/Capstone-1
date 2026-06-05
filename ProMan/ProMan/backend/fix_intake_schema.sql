-- ============================================================
-- Fix intake_forms table: add individual columns if missing
-- Run this if your intake_forms table only has form_data JSONB
-- ============================================================

-- Add all individual columns (safe: IF NOT EXISTS)
ALTER TABLE intake_forms ADD COLUMN IF NOT EXISTS full_name VARCHAR(200);
ALTER TABLE intake_forms ADD COLUMN IF NOT EXISTS nickname VARCHAR(100);
ALTER TABLE intake_forms ADD COLUMN IF NOT EXISTS age INTEGER;
ALTER TABLE intake_forms ADD COLUMN IF NOT EXISTS date_of_birth DATE;
ALTER TABLE intake_forms ADD COLUMN IF NOT EXISTS gender VARCHAR(50);
ALTER TABLE intake_forms ADD COLUMN IF NOT EXISTS civil_status VARCHAR(50);
ALTER TABLE intake_forms ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE intake_forms ADD COLUMN IF NOT EXISTS cellphone VARCHAR(30);
ALTER TABLE intake_forms ADD COLUMN IF NOT EXISTS home_phone VARCHAR(30);
ALTER TABLE intake_forms ADD COLUMN IF NOT EXISTS email VARCHAR(200);
ALTER TABLE intake_forms ADD COLUMN IF NOT EXISTS concern_description TEXT;
ALTER TABLE intake_forms ADD COLUMN IF NOT EXISTS reason_for_counseling TEXT;
ALTER TABLE intake_forms ADD COLUMN IF NOT EXISTS since_when VARCHAR(200);
ALTER TABLE intake_forms ADD COLUMN IF NOT EXISTS how_long VARCHAR(200);
ALTER TABLE intake_forms ADD COLUMN IF NOT EXISTS therapy_before TEXT;
ALTER TABLE intake_forms ADD COLUMN IF NOT EXISTS medication_history TEXT;
ALTER TABLE intake_forms ADD COLUMN IF NOT EXISTS preferred_schedule VARCHAR(200);
ALTER TABLE intake_forms ADD COLUMN IF NOT EXISTS language_preference VARCHAR(100);
ALTER TABLE intake_forms ADD COLUMN IF NOT EXISTS session_modality VARCHAR(100);
ALTER TABLE intake_forms ADD COLUMN IF NOT EXISTS counselor_gender_pref VARCHAR(50);
ALTER TABLE intake_forms ADD COLUMN IF NOT EXISTS is_minor VARCHAR(10);
ALTER TABLE intake_forms ADD COLUMN IF NOT EXISTS guardian_name VARCHAR(200);
ALTER TABLE intake_forms ADD COLUMN IF NOT EXISTS guardian_contact VARCHAR(100);
ALTER TABLE intake_forms ADD COLUMN IF NOT EXISTS guardian_relation VARCHAR(100);
ALTER TABLE intake_forms ADD COLUMN IF NOT EXISTS minor_other_reason TEXT;
ALTER TABLE intake_forms ADD COLUMN IF NOT EXISTS emergency_name VARCHAR(200);
ALTER TABLE intake_forms ADD COLUMN IF NOT EXISTS emergency_address TEXT;
ALTER TABLE intake_forms ADD COLUMN IF NOT EXISTS emergency_contact VARCHAR(100);
ALTER TABLE intake_forms ADD COLUMN IF NOT EXISTS emergency_email VARCHAR(200);
ALTER TABLE intake_forms ADD COLUMN IF NOT EXISTS emergency_relation VARCHAR(100);

-- Make form_data nullable (no longer used for new submissions)
ALTER TABLE intake_forms ALTER COLUMN form_data DROP NOT NULL;

-- Drop the old status check constraint and add the correct one
ALTER TABLE intake_forms DROP CONSTRAINT IF EXISTS intake_forms_status_check;
ALTER TABLE intake_forms ADD CONSTRAINT intake_forms_status_check
  CHECK (status IN ('pending','reviewed','approved','rejected'));

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_intake_forms_user ON intake_forms (user_id);
CREATE INDEX IF NOT EXISTS idx_intake_forms_status ON intake_forms (status);

-- Migrate existing JSONB data to individual columns (if any old submissions exist)
UPDATE intake_forms
SET
  full_name             = COALESCE(full_name, form_data->>'fullName'),
  nickname              = COALESCE(nickname, form_data->>'nickName'),
  age                   = COALESCE(age, (form_data->>'age')::INTEGER),
  gender                = COALESCE(gender, form_data->>'gender'),
  civil_status          = COALESCE(civil_status, form_data->>'civilStatus'),
  address               = COALESCE(address, form_data->>'address'),
  cellphone             = COALESCE(cellphone, form_data->>'cellphone'),
  home_phone            = COALESCE(home_phone, form_data->>'homePhone'),
  email                 = COALESCE(email, form_data->>'email'),
  concern_description   = COALESCE(concern_description, form_data->>'concernDesc'),
  reason_for_counseling = COALESCE(reason_for_counseling, form_data->>'reasonCounseling'),
  since_when            = COALESCE(since_when, form_data->>'sinceWhen'),
  how_long              = COALESCE(how_long, form_data->>'howLong'),
  therapy_before        = COALESCE(therapy_before, form_data->>'therapyBefore'),
  medication_history    = COALESCE(medication_history, form_data->>'medicationHistory'),
  preferred_schedule    = COALESCE(preferred_schedule, form_data->>'prefSchedule'),
  language_preference   = COALESCE(language_preference, form_data->>'language'),
  session_modality      = COALESCE(session_modality, form_data->>'modality'),
  counselor_gender_pref = COALESCE(counselor_gender_pref, form_data->>'counselorGender'),
  is_minor              = COALESCE(is_minor, form_data->>'isMinor'),
  guardian_name         = COALESCE(guardian_name, form_data->>'guardianName'),
  guardian_contact      = COALESCE(guardian_contact, form_data->>'guardianContact'),
  guardian_relation     = COALESCE(guardian_relation, form_data->>'guardianRelation'),
  minor_other_reason    = COALESCE(minor_other_reason, form_data->>'minorOtherReason'),
  emergency_name        = COALESCE(emergency_name, form_data->>'emerName'),
  emergency_address     = COALESCE(emergency_address, form_data->>'emerAddress'),
  emergency_contact     = COALESCE(emergency_contact, form_data->>'emerContact'),
  emergency_email       = COALESCE(emergency_email, form_data->>'emerEmail'),
  emergency_relation    = COALESCE(emergency_relation, form_data->>'emerRelation')
WHERE form_data IS NOT NULL AND full_name IS NULL;
