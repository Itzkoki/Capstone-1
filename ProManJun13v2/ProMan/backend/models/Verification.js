const db = require('../config/db');

// Max wrong guesses allowed against a single OTP code before it is invalidated.
// A 6-digit code has 1,000,000 combinations; capping guesses per code makes
// brute-forcing self-defeating — the attacker's wrong tries destroy the very
// code they are trying to guess. Requesting a new code starts a fresh row
// (attempts = 0), so this never traps a legitimate user.
const MAX_OTP_ATTEMPTS = 5;

const Verification = {
  MAX_OTP_ATTEMPTS,

  /**
   * Store a hashed OTP for a user.
   * Deletes any existing OTPs for this user first (single-use enforcement).
   */
  async create(userId, otpHash, expiresAt) {
    // Remove only EXPIRED codes — keep recent ones so the resend rate limiter
    // (resendStatus) can count how many were sent in the cooldown window.
    // findByUserId/verify always use the most recent code, so older ones are inert.
    await db.query('DELETE FROM email_verifications WHERE user_id = $1 AND expires_at < NOW()', [userId]);

    const result = await db.query(
      `INSERT INTO email_verifications (user_id, otp_hash, expires_at)
       VALUES ($1, $2, $3)
       RETURNING id, user_id, expires_at, created_at`,
      [userId, otpHash, expiresAt]
    );
    return result.rows[0];
  },

  /**
   * Resend rate limit with a "first resend free" allowance (matches the
   * Teleconference OTP workflow): the initial code + one resend are allowed
   * immediately; after that a cooldown applies, timed from the latest code.
   * Returns { allowed, retryAfter } (retryAfter in seconds).
   */
  async resendStatus(userId, windowSeconds = 120) {
    const r = await db.query(
      `SELECT created_at FROM email_verifications
       WHERE user_id = $1 AND created_at > NOW() - ($2 * interval '1 second')
       ORDER BY created_at DESC`,
      [userId, windowSeconds]
    );
    if (r.rows.length < 2) return { allowed: true, retryAfter: 0 };
    const latest = new Date(r.rows[0].created_at).getTime();
    const remaining = Math.ceil(windowSeconds - (Date.now() - latest) / 1000);
    return remaining > 0 ? { allowed: false, retryAfter: remaining } : { allowed: true, retryAfter: 0 };
  },

  /**
   * Find the latest verification record for a user.
   */
  async findByUserId(userId) {
    const result = await db.query(
      `SELECT id, user_id, otp_hash, expires_at, created_at, attempts
       FROM email_verifications
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [userId]
    );
    return result.rows[0] || null;
  },

  /**
   * Record a failed OTP guess against a specific code row and return the new
   * failed-attempt count. Callers invalidate the code once this reaches
   * MAX_OTP_ATTEMPTS (see verifyLoginOtp), so wrong guesses are self-defeating.
   */
  async incrementAttempts(id) {
    const r = await db.query(
      `UPDATE email_verifications
          SET attempts = attempts + 1
        WHERE id = $1
        RETURNING attempts`,
      [id]
    );
    return r.rows[0]?.attempts ?? 0;
  },

  /**
   * Delete all verification records for a user (after successful verification).
   */
  async deleteByUserId(userId) {
    await db.query('DELETE FROM email_verifications WHERE user_id = $1', [userId]);
  },
};

module.exports = Verification;
