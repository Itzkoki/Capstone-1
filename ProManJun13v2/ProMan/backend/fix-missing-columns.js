/* =====================================================================
   One-shot repair: add columns that the running database is missing.

   WHY THIS EXISTS
   ---------------
   runMigrations() (migrations.js) runs as a single try/catch: if any one
   step throws, every step AFTER it is skipped. On some databases an earlier
   step fails, so these later additions never run:
     • team_members.photo_thumbnail / photo_full   (Meet-the-Team photos)
     • users.gender / specialization / position / staff_profile_completed
       (staff verification + appointment eligibility)
   That produces errors like: column "photo_thumbnail" does not exist.

   This script adds exactly those columns, idempotently, using your existing
   backend/.env settings. It is safe to run multiple times.

   HOW TO RUN  (from the backend folder):
     node fix-missing-columns.js
   ===================================================================== */
require('dotenv').config();
const db = require('./config/db');

async function run() {
  console.log('🔧 Repairing missing columns…');

  // ── Meet-the-Team photos ──────────────────────────────
  // Make sure the table exists (harmless if it already does).
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
  // Older databases called the thumbnail column "photo" — rename it if so.
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
  console.log('  ✓ team_members photo columns ensured');

  // ── Generic profile field (staff-only columns are no longer on users) ──
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS gender                  VARCHAR(20)`);
  console.log('  ✓ users gender column ensured');

  console.log('✅ Done. You can start the server normally now.');
}

run()
  .then(() => db.pool.end())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Repair failed:', err.message);
    db.pool.end().finally(() => process.exit(1));
  });
