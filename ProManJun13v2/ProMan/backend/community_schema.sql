-- =====================================================
-- COMMUNITY MODULE — Database Schema
-- =====================================================
-- These tables are auto-created by migrations.js on 
-- server startup. This file exists as a reference and
-- can be run manually if needed.
--
-- Run: psql -U your_user -d your_db -f community_schema.sql
-- =====================================================

-- 1. Extend articles table with community fields
ALTER TABLE articles ADD COLUMN IF NOT EXISTS category VARCHAR(50);
ALTER TABLE articles ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT '{}';
ALTER TABLE articles ADD COLUMN IF NOT EXISTS is_anonymous BOOLEAN DEFAULT FALSE;

-- 2. FAQs
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
);
CREATE INDEX IF NOT EXISTS idx_faqs_category ON faqs (category);

-- 3. Forum Threads
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
);
CREATE INDEX IF NOT EXISTS idx_threads_status   ON forum_threads (status);
CREATE INDEX IF NOT EXISTS idx_threads_category ON forum_threads (category);
CREATE INDEX IF NOT EXISTS idx_threads_created  ON forum_threads (created_at DESC);

-- 4. Forum Replies (nested via parent_id)
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
);
CREATE INDEX IF NOT EXISTS idx_replies_thread ON forum_replies (thread_id);

-- 5. Unified Votes (polymorphic — works across all content types)
CREATE TABLE IF NOT EXISTS votes (
    id            SERIAL PRIMARY KEY,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content_type  VARCHAR(20) NOT NULL
                  CHECK (content_type IN ('article','faq','thread','reply')),
    content_id    INTEGER NOT NULL,
    vote_value    SMALLINT NOT NULL CHECK (vote_value IN (-1, 1)),
    created_at    TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, content_type, content_id)
);
CREATE INDEX IF NOT EXISTS idx_votes_content ON votes (content_type, content_id);

-- 6. Content Flags (moderation)
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
);
CREATE INDEX IF NOT EXISTS idx_flags_status ON content_flags (status);

-- 7. Data Deletion Log (right to be forgotten audit trail)
CREATE TABLE IF NOT EXISTS data_deletion_log (
    id                    SERIAL PRIMARY KEY,
    user_id               INTEGER,
    deleted_by            INTEGER REFERENCES users(id),
    content_types_deleted TEXT[],
    item_count            INTEGER,
    reason                VARCHAR(50) DEFAULT 'user_request',
    created_at            TIMESTAMP DEFAULT NOW()
);

-- =====================================================
-- VERIFICATION: Run this to confirm all tables exist
-- =====================================================
-- SELECT table_name FROM information_schema.tables 
-- WHERE table_schema = 'public' 
-- AND table_name IN ('faqs','forum_threads','forum_replies',
--                    'votes','content_flags','data_deletion_log')
-- ORDER BY table_name;
-- =====================================================
