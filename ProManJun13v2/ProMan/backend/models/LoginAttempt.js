const db = require('../config/db');

// ── Configurable constants ──────────────────────────────
const MAX_FAILED_ATTEMPTS     = 5;
const ATTEMPT_WINDOW_MINUTES  = 3;
const LOCKOUT_DURATION_MINUTES = 15;

const LoginAttempt = {
  /**
   * Record a failed login attempt.
   * @param {string} email
   * @param {string} ipAddress
   */
  async recordFailedAttempt(email, ipAddress) {
    await db.query(
      `INSERT INTO login_attempts (email, ip_address, attempt_type)
       VALUES ($1, $2, 'failed_login')`,
      [email, ipAddress || null]
    );
  },

  /**
   * Count recent failed login attempts within the configured time window.
   * @param {string} email
   * @returns {number}
   */
  async getRecentFailedCount(email) {
    const result = await db.query(
      `SELECT COUNT(*) AS count FROM login_attempts
       WHERE email = $1
         AND attempt_type = 'failed_login'
         AND created_at > NOW() - INTERVAL '1 minute' * $2`,
      [email, ATTEMPT_WINDOW_MINUTES]
    );
    return parseInt(result.rows[0].count, 10);
  },

  /**
   * Lock the account by recording a lockout event with an expiry timestamp.
   * @param {string} email
   * @param {string} ipAddress
   */
  async lockAccount(email, ipAddress) {
    const lockedUntil = new Date(Date.now() + LOCKOUT_DURATION_MINUTES * 60 * 1000);
    await db.query(
      `INSERT INTO login_attempts (email, ip_address, attempt_type, locked_until)
       VALUES ($1, $2, 'lockout', $3)`,
      [email, ipAddress || null, lockedUntil]
    );
    console.log(`🔒 Account locked: ${email} until ${lockedUntil.toISOString()}`);
    return lockedUntil;
  },

  /**
   * Check if there is an active lockout for the given email.
   * Returns the lockout record if active, or null.
   * @param {string} email
   * @returns {Object|null} { locked_until, created_at } or null
   */
  async getActiveLock(email) {
    const result = await db.query(
      `SELECT locked_until, created_at FROM login_attempts
       WHERE email = $1
         AND attempt_type = 'lockout'
         AND locked_until > NOW()
       ORDER BY created_at DESC
       LIMIT 1`,
      [email]
    );
    return result.rows[0] || null;
  },

  /**
   * Clear all failed login attempts for the given email (called on successful login).
   * Lockout and unlock records are preserved for audit trail.
   * @param {string} email
   */
  async clearFailedAttempts(email) {
    await db.query(
      `DELETE FROM login_attempts
       WHERE email = $1 AND attempt_type = 'failed_login'`,
      [email]
    );
  },

  /**
   * Record an unlock event (when lockout expires and user logs in again).
   * @param {string} email
   * @param {string} ipAddress
   */
  async recordUnlock(email, ipAddress) {
    await db.query(
      `INSERT INTO login_attempts (email, ip_address, attempt_type)
       VALUES ($1, $2, 'unlock')`,
      [email, ipAddress || null]
    );
  },

  /**
   * Get the login attempts audit log for security monitoring.
   * @param {number} limit
   * @param {number} offset
   * @returns {Array}
   */
  async getAuditLog(limit = 100, offset = 0) {
    const result = await db.query(
      `SELECT id, email, ip_address, attempt_type, locked_until, created_at
       FROM login_attempts
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    return result.rows;
  },

  // Expose config for use in controller
  MAX_FAILED_ATTEMPTS,
  ATTEMPT_WINDOW_MINUTES,
  LOCKOUT_DURATION_MINUTES,
};

module.exports = LoginAttempt;
