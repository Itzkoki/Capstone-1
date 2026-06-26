const db = require('../config/db');

const User = {
  async generateUserCode(role = 'client') {
    const year = new Date().getFullYear();
    // All `users` rows use the USR- prefix. The clinical-director code (CDR-)
    // lives exclusively on the `staff` table; minting CDR here too would collide
    // with staff_code in the merged audit view (auditController uses
    // user_code || staff_code).
    const prefix = `USR-${year}-`;
    for (let attempt = 0; attempt < 5; attempt++) {
      const last = await db.query(
        `SELECT user_code FROM users WHERE user_code LIKE $1 ORDER BY user_code DESC LIMIT 1`,
        [prefix + '%']
      );
      let seq = 1 + attempt;
      if (last.rows.length > 0) {
        const parsed = parseInt(last.rows[0].user_code.split('-').pop(), 10);
        if (!isNaN(parsed)) seq = parsed + 1 + attempt;
      }
      const candidate = `${prefix}${String(seq).padStart(4, '0')}`;
      const taken = await db.query(`SELECT 1 FROM users WHERE user_code = $1`, [candidate]);
      if (taken.rows.length === 0) return candidate;
    }
    return `${prefix}${String(Date.now()).slice(-4)}`;
  },

  async create({ full_name, email, password, contact_number }) {
    const user_code = await this.generateUserCode();
    const result = await db.query(
      `INSERT INTO users (full_name, email, password, contact_number, role, user_code)
       VALUES ($1, $2, $3, $4, 'client', $5)
       RETURNING id, user_code, full_name, email, contact_number, role, is_verified, created_at`,
      [full_name, email, password, contact_number, user_code]
    );
    return result.rows[0];
  },

  /**
   * Find a user by their email address.
   * @param {string} email
   * @returns {Object|null} The user row including password hash, or null
   */
  async findByEmail(email) {
    const result = await db.query(
      `SELECT id, user_code, full_name, email, password, contact_number, role, is_verified,
              COALESCE(is_active, TRUE) AS is_active,
              COALESCE(must_reset_password, FALSE) AS must_reset_password,
              sessions_invalid_after, created_at
       FROM users
       WHERE email = $1`,
      [email]
    );
    return result.rows[0] || null;
  },

  /**
   * Activate or deactivate (suspend) a client account. Enforced at login.
   * @param {number} userId
   * @param {boolean} isActive
   */
  async setActive(userId, isActive) {
    const result = await db.query(
      `UPDATE users SET is_active = $1, updated_at = NOW() WHERE id = $2
       RETURNING id, email, full_name, COALESCE(is_active, TRUE) AS is_active`,
      [isActive, userId]
    );
    return result.rows[0] || null;
  },

  /**
   * Flag (or clear) a forced password reset. When TRUE, the next successful
   * login redirects the client to the reset-password page (no email sent).
   * @param {number} userId
   * @param {boolean} value
   */
  async setMustResetPassword(userId, value) {
    await db.query(
      `UPDATE users SET must_reset_password = $1, updated_at = NOW() WHERE id = $2`,
      [value, userId]
    );
  },

  /**
   * Terminate all active sessions in real time: any JWT issued before now is
   * rejected on its next request (live-checked in the auth middleware).
   * @param {number} userId
   */
  async invalidateSessions(userId) {
    await db.query(
      `UPDATE users SET sessions_invalid_after = NOW(), updated_at = NOW() WHERE id = $1`,
      [userId]
    );
  },

  /**
   * Mark a user's email as verified.
   * @param {number} userId
   */
  async markAsVerified(userId) {
    await db.query(
      `UPDATE users SET is_verified = TRUE, updated_at = NOW() WHERE id = $1`,
      [userId]
    );
  },

  /**
   * Mark a user's email as unverified (used when email is changed).
   * @param {number} userId
   */
  async markAsUnverified(userId) {
    await db.query(
      `UPDATE users SET is_verified = FALSE, updated_at = NOW() WHERE id = $1`,
      [userId]
    );
  },

  /**
   * Update a single field on the users table.
   * @param {number} userId
   * @param {string} field - Column name (must be whitelisted)
   * @param {*} value
   */
  async updateField(userId, field, value) {
    const allowed = ['full_name', 'email', 'contact_number'];
    if (!allowed.includes(field)) {
      throw new Error(`Field "${field}" is not allowed for update`);
    }
    await db.query(
      `UPDATE users SET ${field} = $1, updated_at = NOW() WHERE id = $2`,
      [value, userId]
    );
  },

  /**
   * Find a user by ID.
   * @param {number} userId
   * @returns {Object|null}
   */
  async findById(userId) {
    const result = await db.query(
      `SELECT id, user_code, full_name, email, contact_number, role, is_verified,
              COALESCE(is_active, TRUE) AS is_active, sessions_invalid_after, created_at
       FROM users WHERE id = $1`,
      [userId]
    );
    return result.rows[0] || null;
  },

  /**
   * Find a user by ID, including the password hash.
   * Used for password verification on protected actions.
   * @param {number} userId
   * @returns {Object|null}
   */
  async findByIdWithPassword(userId) {
    const result = await db.query(
      `SELECT id, user_code, full_name, email, password, contact_number, role, is_verified, created_at
       FROM users WHERE id = $1`,
      [userId]
    );
    return result.rows[0] || null;
  },

  /**
   * Update a user's password.
   * @param {number} userId
   * @param {string} hashedPassword - Already hashed password
   */
  async updatePassword(userId, hashedPassword) {
    await db.query(
      `UPDATE users SET password = $1, updated_at = NOW() WHERE id = $2`,
      [hashedPassword, userId]
    );
  },

  /**
   * Delete a user by ID (cascades to profiles, verifications, etc.).
   * @param {number} userId
   */
  async deleteById(userId) {
    await db.query('DELETE FROM users WHERE id = $1', [userId]);
  },

  async findAll({ role, limit = 50, offset = 0 } = {}) {
    let query = `SELECT id, user_code, full_name, email, contact_number, role, is_verified, created_at, updated_at FROM users`;
    const params = [];
    let idx = 1;
    if (role) {
      query += ` WHERE role = $${idx++}`;
      params.push(role);
    }
    query += ` ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`;
    params.push(limit, offset);
    const result = await db.query(query, params);
    return result.rows;
  },

  async updateRole(userId, role) {
    const newCode = await this.generateUserCode(role);
    const result = await db.query(
      `UPDATE users SET role = $1, user_code = $2, updated_at = NOW() WHERE id = $3
       RETURNING id, user_code, full_name, email, contact_number, role, is_verified`,
      [role, newCode, userId]
    );
    return result.rows[0] || null;
  },

  async findByRole(role) {
    const result = await db.query(
      `SELECT id, user_code, full_name, email, contact_number, role, is_verified, created_at
       FROM users WHERE role = $1 ORDER BY full_name`,
      [role]
    );
    return result.rows;
  },

  async getTotalCount() {
    const result = await db.query('SELECT COUNT(*) AS count FROM users');
    return parseInt(result.rows[0].count, 10);
  },
};

module.exports = User;
