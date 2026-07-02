const db = require('../config/db');

// Max wrong guesses allowed against a single staff OTP before it is invalidated
// (mirrors the client Verification policy). Requesting a new code starts a fresh
// row (attempts = 0), so this never traps a legitimate user.
const MAX_OTP_ATTEMPTS = 5;

/**
 * Per-login email OTP store for STAFF accounts.
 * Mirrors the client-side Verification model but is keyed by staff_id and
 * backed by the `staff_verifications` table (staff cannot reuse
 * `email_verifications`, whose user_id references users(id)).
 */
const StaffVerification = {
  MAX_OTP_ATTEMPTS,

  /**
   * Store a hashed OTP for a staff member, replacing any previous code
   * (single active code per staff at a time).
   */
  async create(staffId, otpHash, expiresAt) {
    // Keep recent codes (drop only expired) so resendStatus can rate-limit by
    // counting codes in the window. findByStaffId/verify always use the latest.
    await db.query('DELETE FROM staff_verifications WHERE staff_id = $1 AND expires_at < NOW()', [staffId]);
    const result = await db.query(
      `INSERT INTO staff_verifications (staff_id, otp_hash, expires_at)
       VALUES ($1, $2, $3)
       RETURNING id, staff_id, expires_at, created_at`,
      [staffId, otpHash, expiresAt]
    );
    return result.rows[0];
  },

  /**
   * Resend rate limit with a "first resend free" allowance (matches the
   * Teleconference OTP workflow): initial code + one resend allowed immediately,
   * then a cooldown timed from the latest code. Returns { allowed, retryAfter }.
   */
  async resendStatus(staffId, windowSeconds = 120) {
    const r = await db.query(
      `SELECT created_at FROM staff_verifications
       WHERE staff_id = $1 AND created_at > NOW() - ($2 * interval '1 second')
       ORDER BY created_at DESC`,
      [staffId, windowSeconds]
    );
    if (r.rows.length < 2) return { allowed: true, retryAfter: 0 };
    const latest = new Date(r.rows[0].created_at).getTime();
    const remaining = Math.ceil(windowSeconds - (Date.now() - latest) / 1000);
    return remaining > 0 ? { allowed: false, retryAfter: remaining } : { allowed: true, retryAfter: 0 };
  },

  /** Latest verification record for a staff member. */
  async findByStaffId(staffId) {
    const result = await db.query(
      `SELECT id, staff_id, otp_hash, expires_at, created_at, attempts
       FROM staff_verifications
       WHERE staff_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [staffId]
    );
    return result.rows[0] || null;
  },

  /**
   * Record a failed OTP guess against a specific code row and return the new
   * failed-attempt count. Callers invalidate the code once this reaches
   * MAX_OTP_ATTEMPTS, so wrong guesses are self-defeating.
   */
  async incrementAttempts(id) {
    const r = await db.query(
      `UPDATE staff_verifications
          SET attempts = attempts + 1
        WHERE id = $1
        RETURNING attempts`,
      [id]
    );
    return r.rows[0]?.attempts ?? 0;
  },

  /** Remove all codes for a staff member (after successful verification). */
  async deleteByStaffId(staffId) {
    await db.query('DELETE FROM staff_verifications WHERE staff_id = $1', [staffId]);
  },
};

module.exports = StaffVerification;
