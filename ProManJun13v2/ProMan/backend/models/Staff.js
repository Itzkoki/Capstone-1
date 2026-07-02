const db = require('../config/db');

// Columns safe to return to clients (never the password hash).
const PUBLIC_COLS = `staff_id, staff_code, first_name, last_name, gender, email, username, role, is_active, status, specialization, schedule, created_at, updated_at`;

const ASSIGNABLE_ROLES = [
  'psychometrician',
  'supervising_psychometrician',
  'qc_psychometrician',
  'psychologist',
  'clinical_director',
];

// Roles shown in each service-specific picker
const COUNSELING_ROLES = ['psychologist'];
// Only Psychologists may be chosen as the assessor/counselor in the Assessment Intake Form.
const ASSESSMENT_ROLES = ['psychologist'];

const ROLE_PREFIX = {
  psychologist: 'PSY',
  psychometrician: 'PSM',
  supervising_psychometrician: 'SPM',
  qc_psychometrician: 'QCP',
  clinical_director: 'CDR',
  staff: 'STF',
};

const Staff = {
  async generateStaffCode(role = 'staff') {
    const year = new Date().getFullYear();
    const pfx = ROLE_PREFIX[role] || 'STF';
    const prefix = `${pfx}-${year}-`;
    for (let attempt = 0; attempt < 5; attempt++) {
      const last = await db.query(
        `SELECT staff_code FROM staff WHERE staff_code LIKE $1 ORDER BY staff_code DESC LIMIT 1`,
        [prefix + '%']
      );
      let seq = 1 + attempt;
      if (last.rows.length > 0) {
        const parsed = parseInt(last.rows[0].staff_code.split('-').pop(), 10);
        if (!isNaN(parsed)) seq = parsed + 1 + attempt;
      }
      const candidate = `${prefix}${String(seq).padStart(4, '0')}`;
      const taken = await db.query(`SELECT 1 FROM staff WHERE staff_code = $1`, [candidate]);
      if (taken.rows.length === 0) return candidate;
    }
    return `${prefix}${String(Date.now()).slice(-4)}`;
  },

  async create({ first_name, last_name, gender, email, username, password_hash, specialization, schedule }) {
    const staff_code = await this.generateStaffCode();
    const result = await db.query(
      `INSERT INTO staff (first_name, last_name, gender, email, username, password_hash, specialization, schedule, role, status, staff_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'staff', 'active', $9)
       RETURNING ${PUBLIC_COLS}`,
      [first_name, last_name, gender || null, email || null, username, password_hash, specialization || null, JSON.stringify(schedule || []), staff_code]
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
      `SELECT staff_id, staff_code, first_name, last_name, gender, email, username, password_hash, role, is_active, status, specialization, created_at, updated_at
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
      `SELECT staff_id, staff_code, first_name, last_name, gender, email, username, password_hash, role, is_active, created_at, updated_at
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
      `SELECT ${PUBLIC_COLS}, sessions_invalid_after FROM staff WHERE staff_id = $1`,
      [staffId]
    );
    return result.rows[0] || null;
  },

  /**
   * Terminate all active staff sessions in real time: any JWT issued before now
   * is rejected on its next request (live-checked in the auth middleware).
   * @param {number} staffId
   */
  async invalidateSessions(staffId) {
    await db.query(
      `UPDATE staff SET sessions_invalid_after = NOW(), updated_at = NOW() WHERE staff_id = $1`,
      [staffId]
    );
  },

  /**
   * Find a staff member by ID, INCLUDING the password hash (for actions that
   * require re-authenticating the acting staff member, e.g. account deletion).
   * @param {number} staffId
   * @returns {Object|null}
   */
  async findByIdWithPassword(staffId) {
    const result = await db.query(
      `SELECT staff_id, username, email, role, password_hash FROM staff WHERE staff_id = $1`,
      [staffId]
    );
    return result.rows[0] || null;
  },

  /**
   * Permanently delete a staff account.
   * @param {number} staffId
   * @returns {Object|null} the deleted row (public cols) or null if not found
   */
  async remove(staffId) {
    const result = await db.query(
      `DELETE FROM staff WHERE staff_id = $1 RETURNING ${PUBLIC_COLS}`,
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
    const newCode = await this.generateStaffCode(role);
    const result = await db.query(
      `UPDATE staff SET role = $1, staff_code = $2, updated_at = NOW() WHERE staff_id = $3
       RETURNING ${PUBLIC_COLS}`,
      [role, newCode, staffId]
    );
    return result.rows[0] || null;
  },

  /**
   * Activate or deactivate a staff account. Keeps `status` in sync with the
   * legacy `is_active` flag:
   *   • deactivate → status 'inactive'
   *   • activate   → status 'active' (they must re-verify via email code at the
   *                  next login to return to 'verified').
   * @param {number} staffId
   * @param {boolean} isActive
   * @returns {Object|null}
   */
  async setActive(staffId, isActive) {
    const result = await db.query(
      `UPDATE staff
          SET is_active = $1,
              status = CASE WHEN $1 = FALSE THEN 'inactive' ELSE 'active' END,
              updated_at = NOW()
        WHERE staff_id = $2
       RETURNING ${PUBLIC_COLS}`,
      [isActive, staffId]
    );
    return result.rows[0] || null;
  },

  /**
   * Mark a staff account as 'verified' (called after a successful email-code
   * verification at login). Never demotes an inactive account.
   * @param {number} staffId
   * @returns {Object|null}
   */
  async markVerified(staffId) {
    const result = await db.query(
      `UPDATE staff SET status = 'verified', updated_at = NOW()
        WHERE staff_id = $1 AND status <> 'inactive'
       RETURNING ${PUBLIC_COLS}`,
      [staffId]
    );
    return result.rows[0] || null;
  },

  /**
   * List staff who may be assigned/chosen in client-facing flows (intake
   * counselor picker, teleconference assignment). Only active accounts with a
   * real clinical role are returned. Optionally filter by gender.
   * @param {Object} opts - { gender }
   * @returns {Array}
   */
  async findAssignable({ gender, roles } = {}) {
    const allowedRoles = Array.isArray(roles) && roles.length ? roles : ASSIGNABLE_ROLES;
    const params = [allowedRoles];
    let query = `
      SELECT staff_id, first_name, last_name, gender, role, specialization, schedule
      FROM staff
      WHERE is_active = TRUE AND role = ANY($1)`;
    if (gender === 'Male' || gender === 'Female') {
      params.push(gender);
      query += ` AND gender = $${params.length}`;
    }
    query += ` ORDER BY last_name, first_name`;
    const result = await db.query(query, params);
    return result.rows;
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
module.exports.COUNSELING_ROLES = COUNSELING_ROLES;
module.exports.ASSESSMENT_ROLES = ASSESSMENT_ROLES;
