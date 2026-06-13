const db = require('../config/db');

const User = {
  /**
   * Create a new user in the database.
   * @param {Object} userData - { full_name, email, password (hashed), contact_number }
   * @returns {Object} The newly created user (without password)
   */
  async create({ full_name, email, password, contact_number }) {
    const result = await db.query(
      `INSERT INTO users (full_name, email, password, contact_number, role)
       VALUES ($1, $2, $3, $4, 'client')
       RETURNING id, full_name, email, contact_number, role, is_verified, created_at`,
      [full_name, email, password, contact_number]
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
      `SELECT id, full_name, email, password, contact_number, role, is_verified, created_at
       FROM users
       WHERE email = $1`,
      [email]
    );
    return result.rows[0] || null;
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
      `SELECT id, full_name, email, contact_number, role, is_verified, created_at
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
      `SELECT id, full_name, email, password, contact_number, role, is_verified, created_at
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
    let query = `SELECT id, full_name, email, contact_number, role, is_verified, created_at, updated_at FROM users`;
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
    const result = await db.query(
      `UPDATE users SET role = $1, updated_at = NOW() WHERE id = $2
       RETURNING id, full_name, email, contact_number, role, is_verified`,
      [role, userId]
    );
    return result.rows[0] || null;
  },

  async findByRole(role) {
    const result = await db.query(
      `SELECT id, full_name, email, contact_number, role, is_verified, created_at
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
