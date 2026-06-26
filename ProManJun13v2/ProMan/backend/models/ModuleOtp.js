const db     = require('../config/db');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

// Email-OTP gate for sensitive staff-only modules (Case Management, Staff
// Management, Payment Verification). Mirrors the platform-wide OTP policy used
// by TeleconfOtp: codes are valid for 2 minutes and may only be re-sent once
// every 2 minutes (server-enforced). Kept in its own table so it never collides
// with the teleconference OTP on the same user's "latest unused code".
const OTP_EXPIRY_MINUTES       = 2;
const RESEND_COOLDOWN_SECONDS  = 120;
const SALT_ROUNDS              = 10;

const ModuleOtp = {
  // "First resend free": the initial code AND one resend are allowed
  // immediately; only after that does the 2-minute cooldown apply (timed from
  // the latest code). Returns { allowed, retryAfter }.
  async resendStatus(userId) {
    const r = await db.query(
      `SELECT created_at FROM module_access_otp
       WHERE user_id = $1 AND created_at > NOW() - ($2 * interval '1 second')
       ORDER BY created_at DESC`,
      [userId, RESEND_COOLDOWN_SECONDS]
    );
    if (r.rows.length < 2) return { allowed: true, retryAfter: 0 };
    const latest = new Date(r.rows[0].created_at).getTime();
    const remaining = Math.ceil(RESEND_COOLDOWN_SECONDS - (Date.now() - latest) / 1000);
    return remaining > 0 ? { allowed: false, retryAfter: remaining } : { allowed: true, retryAfter: 0 };
  },

  async create(userId, module) {
    const otp     = crypto.randomInt(100000, 999999).toString();
    const hash    = await bcrypt.hash(otp, SALT_ROUNDS);
    const expires = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

    // Remove only spent/expired codes — keep recent unused codes so the resend
    // rate limiter can count how many were sent in the window. verify() always
    // uses the most recent code, so older ones are inert.
    await db.query(
      `DELETE FROM module_access_otp WHERE user_id = $1 AND (is_used = TRUE OR expires_at < NOW())`,
      [userId]
    );

    await db.query(
      `INSERT INTO module_access_otp (user_id, module, otp_hash, expires_at, is_used, created_at)
       VALUES ($1, $2, $3, $4, FALSE, NOW())`,
      [userId, module || null, hash, expires]
    );

    return otp; // plaintext OTP sent via email
  },

  async verify(userId, otp) {
    const result = await db.query(
      `SELECT id, otp_hash, expires_at FROM module_access_otp
       WHERE user_id = $1 AND is_used = FALSE
       ORDER BY created_at DESC LIMIT 1`,
      [userId]
    );

    const record = result.rows[0];
    if (!record) return { valid: false, reason: 'No pending OTP found.' };

    if (new Date() > new Date(record.expires_at)) {
      return { valid: false, reason: 'OTP has expired. Please request a new one.' };
    }

    const match = await bcrypt.compare(otp, record.otp_hash);
    if (!match) return { valid: false, reason: 'Invalid code. Please try again.' };

    await db.query(`UPDATE module_access_otp SET is_used = TRUE WHERE id = $1`, [record.id]);
    return { valid: true };
  },

  OTP_EXPIRY_MINUTES,
  RESEND_COOLDOWN_SECONDS,
};

module.exports = ModuleOtp;
