const db     = require('../config/db');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

// Match the rest of the platform's email-OTP policy: codes are valid for 2
// minutes and may only be re-sent once every 2 minutes (server-enforced).
const OTP_EXPIRY_MINUTES       = 2;
const RESEND_COOLDOWN_SECONDS  = 120;
const SALT_ROUNDS              = 10;
// Max wrong guesses allowed against a single code before it is burned, matching
// the platform-wide OTP policy (see Verification.MAX_OTP_ATTEMPTS).
const MAX_OTP_ATTEMPTS         = 5;

const TeleconfOtp = {
  // Rate limit with a "first resend free" allowance: the user may send the
  // initial code AND one resend immediately; only after that does the 2-minute
  // cooldown apply (timed from the latest code). Returns { allowed, retryAfter }.
  async resendStatus(userId) {
    const r = await db.query(
      `SELECT created_at FROM teleconf_otp
       WHERE user_id = $1 AND created_at > NOW() - ($2 * interval '1 second')
       ORDER BY created_at DESC`,
      [userId, RESEND_COOLDOWN_SECONDS]
    );
    // 0 or 1 code in the window → the (first) resend is always allowed.
    if (r.rows.length < 2) return { allowed: true, retryAfter: 0 };
    // 2+ codes already sent in the window → wait out the cooldown from the latest.
    const latest = new Date(r.rows[0].created_at).getTime();
    const remaining = Math.ceil(RESEND_COOLDOWN_SECONDS - (Date.now() - latest) / 1000);
    return remaining > 0 ? { allowed: false, retryAfter: remaining } : { allowed: true, retryAfter: 0 };
  },

  async create(userId) {
    const otp     = crypto.randomInt(100000, 999999).toString();
    const hash    = await bcrypt.hash(otp, SALT_ROUNDS);
    const expires = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

    // Remove only spent/expired codes — keep recent unused codes so the resend
    // rate limiter (resendStatus) can count how many were sent in the window.
    // verify() always uses the most recent code, so older ones are inert.
    await db.query(
      `DELETE FROM teleconf_otp WHERE user_id = $1 AND (is_used = TRUE OR expires_at < NOW())`,
      [userId]
    );

    await db.query(
      `INSERT INTO teleconf_otp (user_id, otp_hash, expires_at, is_used, created_at)
       VALUES ($1, $2, $3, FALSE, NOW())`,
      [userId, hash, expires]
    );

    return otp; // plaintext OTP sent via email
  },

  async verify(userId, otp) {
    const result = await db.query(
      `SELECT id, otp_hash, expires_at, attempts FROM teleconf_otp
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
    if (!match) {
      // Per-code brute-force guard: count the wrong guess and burn the code
      // (mark it used, so verify() no longer finds it) once too many have been
      // made, forcing the user to request a new one.
      const r = await db.query(
        `UPDATE teleconf_otp SET attempts = attempts + 1 WHERE id = $1 RETURNING attempts`,
        [record.id]
      );
      if ((r.rows[0]?.attempts ?? 0) >= MAX_OTP_ATTEMPTS) {
        await db.query(`UPDATE teleconf_otp SET is_used = TRUE WHERE id = $1`, [record.id]);
        return { valid: false, reason: 'Too many incorrect attempts. Please request a new code.' };
      }
      return { valid: false, reason: 'Invalid code. Please try again.' };
    }

    // Mark as used
    await db.query(`UPDATE teleconf_otp SET is_used = TRUE WHERE id = $1`, [record.id]);
    return { valid: true };
  },

  OTP_EXPIRY_MINUTES,
  RESEND_COOLDOWN_SECONDS,
  MAX_OTP_ATTEMPTS,
};

module.exports = TeleconfOtp;
