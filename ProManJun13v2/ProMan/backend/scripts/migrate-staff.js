/**
 * One-off data migration: copy existing staff accounts out of the shared
 * `users` table into the dedicated `staff` table.
 *
 *   node scripts/migrate-staff.js
 *
 * What it does
 * ------------
 *  • Selects every `users` row whose role is NOT 'client' (i.e. staff).
 *  • Splits full_name → first_name / last_name (best effort).
 *  • Derives a unique username from the email local-part (falls back to the
 *    user id), carrying over the EXISTING bcrypt password hash unchanged.
 *  • Maps the role; any role outside the staff set is reset to the default
 *    'staff'.
 *  • Inserts into `staff`, skipping rows whose username/email already exist
 *    (idempotent — safe to re-run).
 *
 * What it deliberately does NOT do
 * --------------------------------
 *  • It does NOT delete staff rows from `users`. ~35 foreign keys across the
 *    schema still reference users(id); removing those rows is deferred to a
 *    later "deep rewire" pass. This keeps the running app intact.
 *
 * Requires the same .env / DB config the server uses.
 */
require('dotenv').config();
const db = require('../config/db');

const STAFF_ROLES = new Set([
  'staff',
  'psychometrician',
  'supervising_psychometrician',
  'qc_psychometrician',
  'psychologist',
  'clinical_director',
]);

function splitName(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first_name: null, last_name: null };
  if (parts.length === 1) return { first_name: parts[0], last_name: null };
  return { first_name: parts[0], last_name: parts.slice(1).join(' ') };
}

function baseUsername(user) {
  const local = (user.email || '').split('@')[0].replace(/[^A-Za-z0-9._-]/g, '').toLowerCase();
  return local || `staff${user.id}`;
}

async function uniqueUsername(base) {
  let candidate = base;
  let n = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { rows } = await db.query('SELECT 1 FROM staff WHERE username = $1', [candidate]);
    if (rows.length === 0) return candidate;
    candidate = `${base}${n++}`;
  }
}

async function run() {
  console.log('🔄 Migrating staff from users → staff table...');

  const { rows: staffUsers } = await db.query(
    `SELECT id, full_name, email, password, role, gender
     FROM users
     WHERE role IS NOT NULL AND role <> 'client'
     ORDER BY id`
  );

  console.log(`   Found ${staffUsers.length} staff record(s) in users.`);

  let inserted = 0;
  let skipped = 0;

  for (const u of staffUsers) {
    // Skip if this email already exists in staff (idempotency).
    if (u.email) {
      const { rows } = await db.query('SELECT 1 FROM staff WHERE email = $1', [u.email]);
      if (rows.length > 0) {
        skipped++;
        continue;
      }
    }

    const { first_name, last_name } = splitName(u.full_name);
    const username = await uniqueUsername(baseUsername(u));
    const role = STAFF_ROLES.has(u.role) ? u.role : 'staff';

    try {
      await db.query(
        `INSERT INTO staff (first_name, last_name, gender, email, username, password_hash, role)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [first_name, last_name, u.gender || null, u.email || null, username, u.password, role]
      );
      inserted++;
      console.log(`   ✓ ${u.email || username} → username "${username}", role "${role}"`);
    } catch (err) {
      skipped++;
      console.warn(`   ⚠ Skipped user id ${u.id} (${u.email || 'no email'}): ${err.message}`);
    }
  }

  console.log(`✅ Done. Inserted ${inserted}, skipped ${skipped}.`);
  console.log('   NOTE: staff rows were NOT removed from users (FKs still reference them).');
}

run()
  .then(() => db.pool.end())
  .catch((err) => {
    console.error('❌ Migration failed:', err);
    db.pool.end();
    process.exit(1);
  });
