const db = require('../config/db');

/**
 * Unverified-account retention rule:
 * A newly registered user exists in `users` with is_verified = FALSE until they
 * enter the emailed OTP. Sign-ups that never verify (typos, throwaway/disposable
 * inboxes, abandoned registrations) leave dead rows behind and can be used to
 * spam the system. Any account that is still unverified more than
 * UNVERIFIED_TTL_HOURS after creation is treated as abandoned and removed here.
 *
 * Mirrors the lazy-sweep approach of services/intakeCleanup.js — there is no
 * cron; this runs opportunistically on auth activity (register / resend OTP).
 *
 * All `users(id)` foreign keys are ON DELETE CASCADE (email_verifications,
 * profiles, etc.), so deleting the row cleans up its dependents. We still delete
 * one id at a time so a single blocked row never aborts the whole sweep.
 * Verified accounts and staff are never touched.
 */

const UNVERIFIED_TTL_HOURS = 24;

async function sweepUnverifiedAccounts() {
  try {
    const { rows } = await db.query(
      `SELECT id FROM users
        WHERE is_verified = FALSE
          AND created_at < NOW() - ($1 * INTERVAL '1 hour')`,
      [UNVERIFIED_TTL_HOURS]
    );

    let removed = 0;
    for (const r of rows) {
      try {
        // Re-check is_verified in the DELETE so we never race a user who just
        // verified between the SELECT and the DELETE.
        const res = await db.query(
          `DELETE FROM users WHERE id = $1 AND is_verified = FALSE`,
          [r.id]
        );
        removed += res.rowCount || 0;
      } catch (err) {
        // A lingering FK (rare for an unverified account) — skip, don't abort.
        console.error(`sweepUnverifiedAccounts: could not remove user ${r.id}:`, err.message);
      }
    }
    return removed;
  } catch (err) {
    console.error('sweepUnverifiedAccounts failed:', err.message);
    return 0;
  }
}

module.exports = { sweepUnverifiedAccounts, UNVERIFIED_TTL_HOURS };
