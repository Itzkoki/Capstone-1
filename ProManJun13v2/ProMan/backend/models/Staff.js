const db = require('../config/db');

// Columns safe to return to clients (never the password hash).
const PUBLIC_COLS = `staff_id, first_name, last_name, gender, email, username, role, is_active, created_at, updated_at`;

const Staff = {
  /**
   * Create a new staff account. The role is always forced to 'staff' here —
   * the Clinical Director changes it afterwards via the management module.
   * @param {Object} data - { first_name, last_name, gender, email, username, password_hash }
   * @returns {Object} The newly created staff row (without password_hash)
   */
  async create({ first_name, last_name, gender, email, username, password_hash }) {
    const result = await db.query(
      `INSERT INTO staff (first_name, last_name, gender, email, username, password_hash, role)
       VALUES ($1, $2, $3, $4, $5, $6, 'staff')
       RETURNING ${PUBLIC_COLS}`,
      [first_name, last_name, gender || null, email || null, username, password_hash]
    );
    return result.rows[0];
  },

  /**
   * Find a staff member by username, INCLUDING the password hash (auth use).
   * @param {string} username
   * @returns {Object|null}
   */
  async findByUsername(username) {
    const result = await db.query(
      `SELECT staff_id, first_name, last_name, gender, email, username, password_hash, role, is_active, created_at, updated_at
       FROM staff WHERE username = $1`,
      [username]
    );
    return result.rows[0] || null;
  },

  /**
   * Find a staff member by email, INCLUDING the password hash (auth use).
   * @param {string} email
   * @returns {Object|null}
   */
  async findByEmail(email) {
    const result = await db.query(
      `SELECT staff_id, first_name, last_name, gender, email, username, password_hash, role, is_active, created_at, updated_at
       FROM staff WHERE email = $1`,
      [email]
    );
    return result.rows[0] || null;
  },

  /**
   * Find a staff member by ID (without password hash).
   * @param {number} staffId
   * @returns {Object|null}
   */
  async findById(staffId) {
    const result = await db.query(
      `SELECT ${PUBLIC_COLS} FROM staff WHERE staff_id = $1`,
      [staffId]
    );
    return result.rows[0] || null;
  },

  /**
   * List staff accounts (without password hash), optionally filtered by role.
   * @param {Object} opts - { role }
   * @returns {Array}
   */
  async findAll({ role } = {}) {
    let query = `SELECT ${PUBLIC_COLS} FROM staff`;
    const params = [];
    if (role) {
      params.push(role);
      query += ` WHERE role = $1`;
    }
    query += ` ORDER BY created_at DESC`;
    const result = await db.query(query, params);
    return result.rows;
  },

  /**
   * Update a staff member's role.
   * @param {number} staffId
   * @param {string} role
   * @returns {Object|null}
   */
  async updateRole(staffId, role) {
    const result = await db.query(
      `UPDATE staff SET role = $1, updated_at = NOW() WHERE staff_id = $2
       RETURNING ${PUBLIC_COLS}`,
      [role, staffId]
    );
    return result.rows[0] || null;
  },

  /**
   * Activate or deactivate a staff account.
   * @param {number} staffId
   * @param {boolean} isActive
   * @returns {Object|null}
   */
  async setActive(staffId, isActive) {
    const result = await db.query(
      `UPDATE staff SET is_active = $1, updated_at = NOW() WHERE staff_id = $2
       RETURNING ${PUBLIC_COLS}`,
      [isActive, staffId]
    );
    return result.rows[0] || null;
  },

  /**
   * Whether a username already exists.
   * @param {string} username
   * @returns {boolean}
   */
  async existsUsername(username) {
    const result = await db.query(`SELECT 1 FROM staff WHERE username = $1`, [username]);
    return result.rows.length > 0;
  },

  /**
   * Whether an email already exists.
   * @param {string} email
   * @returns {boolean}
   */
  async existsEmail(email) {
    if (!email) return false;
    const result = await db.query(`SELECT 1 FROM staff WHERE email = $1`, [email]);
    return result.rows.length > 0;
  },
};

module.exports = Staff;
