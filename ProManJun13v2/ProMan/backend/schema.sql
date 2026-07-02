-- ============================================
-- ProMan Authentication Database Schema
-- ============================================

-- Create the database (run manually if needed):
-- CREATE DATABASE proman_db;

-- Connect to the database, then run:

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

-- Index on email for fast lookup during login
CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);

-- ============================================
-- Email Verification OTPs
-- ============================================

CREATE TABLE IF NOT EXISTS email_verifications (
    id          SERIAL PRIMARY KEY,
    user_id     INTEGER       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    otp_hash    VARCHAR(255)  NOT NULL,
    expires_at  TIMESTAMP     NOT NULL,
    attempts    INTEGER       NOT NULL DEFAULT 0,
    created_at  TIMESTAMP     DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_verifications_user_id ON email_verifications (user_id);

-- ============================================
-- Password Reset Tokens
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
