const db = require('../config/db');

const Verification = {
  /**
   * Store a hashed OTP for a user.
   * Deletes any existing OTPs for this user first (single-use enforcement).
   */
  async create(userId, otpHash, expiresAt) {
    // Remove any previous OTPs for this user
    await db.query('DELETE FROM email_verifications WHERE user_id = $1', [userId]);

    const result = await db.query(
      `INSERT INTO email_verifications (user_id, otp_hash, expires_at)
       VALUES ($1, $2, $3)
       RETURNING id, user_id, expires_at, created_at`,
      [userId, otpHash, expiresAt]
    );
    return result.rows[0];
  },

  /**
   * Find the latest verification record for a user.
   */
  async findByUserId(userId) {
    const result = await db.query(
      `SELECT id, user_id, otp_hash, expires_at, created_at
       FROM email_verifications
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [userId]
    );
    return result.rows[0] || null;
  },

  /**
   * Delete all verification records for a user (after successful verification).
   */
  async deleteByUserId(userId) {
    await db.query('DELETE FROM email_verifications WHERE user_id = $1', [userId]);
  },
};

module.exports = Verification;
