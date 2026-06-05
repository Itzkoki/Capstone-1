-- ============================================
-- ProMan – FULL DATABASE SETUP
-- ============================================
-- Run this in pgAdmin connected to "proman_db".
-- If the database doesn't exist yet, create it first:
--   CREATE DATABASE proman_db;
-- Then connect to it and run everything below.
-- ============================================

-- ============================================
-- 1. Users Table (core authentication)
-- ============================================
CREATE TABLE IF NOT EXISTS users (
    id              SERIAL PRIMARY KEY,
    full_name       VARCHAR(100)  NOT NULL,
    email           VARCHAR(255)  NOT NULL UNIQUE,
    password        VARCHAR(255)  NOT NULL,
    contact_number  VARCHAR(20)   NOT NULL,
    is_verified     BOOLEAN       DEFAULT FALSE,
    created_at      TIMESTAMP     DEFAULT NOW(),
    updated_at      TIMESTAMP     DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);

-- ============================================
-- 2. Email Verification OTPs
-- ============================================
CREATE TABLE IF NOT EXISTS email_verifications (
    id          SERIAL PRIMARY KEY,
    user_id     INTEGER       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    otp_hash    VARCHAR(255)  NOT NULL,
    expires_at  TIMESTAMP     NOT NULL,
    created_at  TIMESTAMP     DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_verifications_user_id ON email_verifications (user_id);

-- ============================================
-- 3. Password Reset Tokens
-- ============================================
CREATE TABLE IF NOT EXISTS password_resets (
    id          SERIAL PRIMARY KEY,
    user_id     INTEGER       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  VARCHAR(255)  NOT NULL,
    expires_at  TIMESTAMP     NOT NULL,
    used        BOOLEAN       DEFAULT FALSE,
    created_at  TIMESTAMP     DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_password_resets_user_id ON password_resets (user_id);

-- ============================================
-- 4. User Profiles (1:1 with users)
-- ============================================
CREATE TABLE IF NOT EXISTS user_profiles (
    id                    SERIAL PRIMARY KEY,
    user_id               INTEGER       NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    gender                VARCHAR(20)   CHECK (gender IN ('male','female','other','prefer_not_to_say')),
    date_of_birth         DATE,
    civil_status          VARCHAR(20)   CHECK (civil_status IN ('single','married','widowed','separated','divorced')),
    address               VARCHAR(500),
    medical_history       TEXT,
    current_medications   TEXT,
    previous_treatments   TEXT,
    created_at            TIMESTAMP     DEFAULT NOW(),
    updated_at            TIMESTAMP     DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_profiles_user_id ON user_profiles (user_id);

-- ============================================
-- 5. Privacy Settings (1:1 with users)
-- ============================================
CREATE TABLE IF NOT EXISTS privacy_settings (
    id                          SERIAL PRIMARY KEY,
    user_id                     INTEGER   NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    show_contact_number         BOOLEAN   DEFAULT FALSE,
    show_date_of_birth          BOOLEAN   DEFAULT FALSE,
    show_address                BOOLEAN   DEFAULT FALSE,
    show_medical_history        BOOLEAN   DEFAULT FALSE,
    show_current_medications    BOOLEAN   DEFAULT FALSE,
    show_previous_treatments    BOOLEAN   DEFAULT FALSE,
    updated_at                  TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_privacy_user_id ON privacy_settings (user_id);

-- ============================================
-- 6. Profile Audit Logs
-- ============================================
CREATE TABLE IF NOT EXISTS profile_audit_logs (
    id              SERIAL PRIMARY KEY,
    user_id         INTEGER       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    field_changed   VARCHAR(100)  NOT NULL,
    old_value       TEXT,
    new_value       TEXT,
    ip_address      VARCHAR(45),
    changed_at      TIMESTAMP     DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_user_id ON profile_audit_logs (user_id);
CREATE INDEX IF NOT EXISTS idx_audit_changed_at ON profile_audit_logs (changed_at);

-- ============================================
-- DONE! All tables created successfully.
-- ============================================
