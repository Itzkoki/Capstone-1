const db = require('../config/db');

// Password-reset tokens for STAFF accounts. Deliberately separate from the
// client `password_resets` table: staff_id and users.id come from different,
// overlapping sequences, so one shared table keyed by a bare id would let a
// client and a staff member with the same integer id consume each other's
// tokens. Structure mirrors models/PasswordReset.js.
const StaffPasswordReset = {
  /**
   * Store a hashed reset token for a staff member, invalidating prior tokens.
   */
  async create(staffId, tokenHash, expiresAt) {
    await db.query(
      'UPDATE staff_password_resets SET used = TRUE WHERE staff_id = $1 AND used = FALSE',
      [staffId]
    );

    const result = await db.query(
      `INSERT INTO staff_password_resets (staff_id, token_hash, expires_at)
       VALUES ($1, $2, $3)
       RETURNING id, staff_id, expires_at, created_at`,
      [staffId, tokenHash, expiresAt]
    );
    return result.rows[0];
  },

  /**
   * All valid (not used, not expired) records — iterated to match a hashed token.
   */
  async findAllValid() {
    const result = await db.query(
      `SELECT id, staff_id, token_hash, expires_at, created_at
       FROM staff_password_resets
       WHERE used = FALSE AND expires_at > NOW()
       ORDER BY created_at DESC`
    );
    return result.rows;
  },

  /**
   * Mark a token as used (single-use).
   */
  async markUsed(id) {
    await db.query('UPDATE staff_password_resets SET used = TRUE WHERE id = $1', [id]);
  },
};

module.exports = StaffPasswordReset;
