-- ============================================================================
-- BPS Clients' Requests & Concerns — schema
-- ============================================================================
-- Backs the "Request & Concern" form (requests.html) and the staff console
-- (request-management.html). Submitting the form INSERTs into client_requests;
-- if the table is missing the API returns a 500 Internal Server Error.
--
-- migrations.js now creates these tables automatically on server startup
-- (ensureRequestTables()). Use this file to create them immediately in an
-- already-running database WITHOUT restarting the server:
--
--   psql -h localhost -U postgres -d proman_db -f client_requests_schema.sql
--
-- Safe to run multiple times — every statement uses IF NOT EXISTS.
-- Requires the base "users" table (setup_database.sql) to exist first.
-- ============================================================================

-- ── Main ticket table ──
CREATE TABLE IF NOT EXISTS client_requests (
    id                  SERIAL PRIMARY KEY,
    ticket_number       VARCHAR(40) UNIQUE NOT NULL,                 -- Ticket/Reference Number
    client_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_family_name  VARCHAR(120),                                -- Client Name (family)
    client_given_name   VARCHAR(120),                                -- Client Name (given)
    client_mi           VARCHAR(10),                                 -- Client Name (middle initial)
    guardian_name       VARCHAR(200),                                -- Parent/Guardian Name
    assessment_date     DATE,                                        -- Date of Assessment
    contact_number      VARCHAR(40),                                 -- Contact Number
    center_branch       VARCHAR(200),                                -- Center and Branch
    nature              VARCHAR(30) NOT NULL                         -- Nature of Request
                        CHECK (nature IN ('additional_copies','report_concern')),
    concerns            JSONB,                                       -- Concerns Encountered (multi-select)
    concern_other       TEXT,                                        -- Concerns Encountered ("other" text)
    description         TEXT,                                        -- Brief Description
    attachment          TEXT,                                        -- Attached File (base64 data URL)
    attachment_name     VARCHAR(255),                                -- Attached File (original name)
    attachment_mime     VARCHAR(100),                                -- Attached File (MIME type)
    status              VARCHAR(20) NOT NULL DEFAULT 'submitted'     -- Ticket Status
                        CHECK (status IN ('submitted','under_review','resolved','closed')),
    assigned_staff_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,  -- Assigned Staff
    deadline            DATE,
    resolution_note     TEXT,                                        -- Resolution Notes
    -- Additional-copies fee flow
    payment_required    BOOLEAN DEFAULT FALSE,
    payment_amount      NUMERIC(10,2),
    payment_status      VARCHAR(20) DEFAULT 'none'
                        CHECK (payment_status IN ('none','awaiting_payment','under_review','verified','rejected')),
    payment_proof       TEXT,
    payment_proof_name  VARCHAR(255),
    payment_reference   VARCHAR(40),
    -- Finalized report release flow
    report_file         TEXT,
    report_filename     VARCHAR(255),
    report_mime         VARCHAR(100),
    report_released_at  TIMESTAMP,
    -- Timestamps
    created_at          TIMESTAMP DEFAULT NOW(),                     -- created at
    updated_at          TIMESTAMP DEFAULT NOW()                      -- updated at
);

CREATE INDEX IF NOT EXISTS idx_creq_client ON client_requests (client_id);
CREATE INDEX IF NOT EXISTS idx_creq_status ON client_requests (status);

-- ── Threaded replies / follow-ups on a ticket ──
CREATE TABLE IF NOT EXISTS client_request_replies (
    id          SERIAL PRIMARY KEY,
    request_id  INTEGER NOT NULL REFERENCES client_requests(id) ON DELETE CASCADE,
    user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    message     TEXT NOT NULL,
    created_at  TIMESTAMP DEFAULT NOW()
);

-- ============================================================================
-- Report-Requests workflow additions (v2)
-- ----------------------------------------------------------------------------
-- Columns + audit table backing the Clinical Director "Report Requests"
-- workflow (review approve/reject, payment verification + receipt, and the
-- final "Send" step). Idempotent — safe to run on an existing database.
-- ============================================================================

ALTER TABLE client_requests ADD COLUMN IF NOT EXISTS approved_at              TIMESTAMP;
ALTER TABLE client_requests ADD COLUMN IF NOT EXISTS approved_by              INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE client_requests ADD COLUMN IF NOT EXISTS rejection_reason         TEXT;
ALTER TABLE client_requests ADD COLUMN IF NOT EXISTS payment_rejection_reason TEXT;
ALTER TABLE client_requests ADD COLUMN IF NOT EXISTS receipt_number           VARCHAR(40);
ALTER TABLE client_requests ADD COLUMN IF NOT EXISTS receipt_issued_at        TIMESTAMP;
ALTER TABLE client_requests ADD COLUMN IF NOT EXISTS sent_at                  TIMESTAMP;
ALTER TABLE client_requests ADD COLUMN IF NOT EXISTS sent_by                  INTEGER REFERENCES users(id) ON DELETE SET NULL;

-- Allow the 'rejected' top-level status (request rejected at review).
ALTER TABLE client_requests DROP CONSTRAINT IF EXISTS client_requests_status_check;
ALTER TABLE client_requests ADD CONSTRAINT client_requests_status_check
  CHECK (status IN ('submitted','under_review','resolved','closed','rejected'));

-- Dedicated, append-only audit trail for each ticket.
CREATE TABLE IF NOT EXISTS client_request_audit_logs (
    id          SERIAL PRIMARY KEY,
    request_id  INTEGER NOT NULL REFERENCES client_requests(id) ON DELETE CASCADE,
    user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,  -- responsible user
    action      VARCHAR(60) NOT NULL,                             -- e.g. REQUEST_APPROVED
    remarks     TEXT,                                             -- free-text detail / reason
    created_at  TIMESTAMP DEFAULT NOW()                           -- date & time
);
CREATE INDEX IF NOT EXISTS idx_creq_audit_request ON client_request_audit_logs (request_id);
CREATE INDEX IF NOT EXISTS idx_creq_audit_created ON client_request_audit_logs (created_at);

-- ============================================================================
-- Report Concerns workflow additions (v2 — ProMankekJun12v2)
-- ----------------------------------------------------------------------------
-- Backs the Clinical Director "Report Concerns" tab (nature='report_concern'),
-- mirroring the Report-Requests logic: lifecycle status, resolution / rejection
-- / review notes, the "request additional information" step, report versioning,
-- Idempotent.
-- ============================================================================
ALTER TABLE client_requests ADD COLUMN IF NOT EXISTS concern_status           VARCHAR(40) DEFAULT 'Pending Review';
ALTER TABLE client_requests ADD COLUMN IF NOT EXISTS concern_resolution_note  TEXT;
ALTER TABLE client_requests ADD COLUMN IF NOT EXISTS concern_rejection_reason TEXT;
ALTER TABLE client_requests ADD COLUMN IF NOT EXISTS concern_info_request     TEXT;
ALTER TABLE client_requests ADD COLUMN IF NOT EXISTS concern_review_note      TEXT;
ALTER TABLE client_requests ADD COLUMN IF NOT EXISTS report_version           INTEGER DEFAULT 1;

-- Append-only report version store (every correction = a new version).
CREATE TABLE IF NOT EXISTS client_request_report_versions (
    id             SERIAL PRIMARY KEY,
    request_id     INTEGER NOT NULL REFERENCES client_requests(id) ON DELETE CASCADE,
    version_number INTEGER NOT NULL,
    file           TEXT NOT NULL,
    filename       VARCHAR(255),
    mime           VARCHAR(100) DEFAULT 'application/pdf',
    change_note    TEXT,
    created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at     TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_creq_ver_request ON client_request_report_versions (request_id);
