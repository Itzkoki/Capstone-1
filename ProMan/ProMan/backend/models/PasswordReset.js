const db = require('../config/db');

const PasswordReset = {
  /**
   * Store a hashed reset token for a user.
   * Invalidates any previous tokens for this user.
   */
  async create(userId, tokenHash, expiresAt) {
    // Mark all previous tokens as used
    await db.query(
      'UPDATE password_resets SET used = TRUE WHERE user_id = $1 AND used = FALSE',
      [userId]
    );

    const result = await db.query(
      `INSERT INTO password_resets (user_id, token_hash, expires_at)
       VALUES ($1, $2, $3)
       RETURNING id, user_id, expires_at, created_at`,
      [userId, tokenHash, expiresAt]
    );
    return result.rows[0];
  },

  /**
   * Find a valid (not used, not expired) reset record for a user.
   */
  async findValidByUserId(userId) {
    const result = await db.query(
      `SELECT id, user_id, token_hash, expires_at, created_at
       FROM password_resets
       WHERE user_id = $1 AND used = FALSE AND expires_at > NOW()
       ORDER BY created_at DESC
       LIMIT 1`,
      [userId]
    );
    return result.rows[0] || null;
  },

  /**
   * Find all valid (not used) reset records — used to look up by token.
   * Since tokens are hashed, we need to iterate and compare.
   */
  async findAllValid() {
    const result = await db.query(
      `SELECT id, user_id, token_hash, expires_at, created_at
       FROM password_resets
       WHERE used = FALSE AND expires_at > NOW()
       ORDER BY created_at DESC`
    );
    return result.rows;
  },

  /**
   * Mark a token as used.
   */
  async markUsed(id) {
    await db.query(
      'UPDATE password_resets SET used = TRUE WHERE id = $1',
      [id]
    );
  },

  /**
   * Delete all reset tokens for a user.
   */
  async deleteByUserId(userId) {
    await db.query('DELETE FROM password_resets WHERE user_id = $1', [userId]);
  },
};

module.exports = PasswordReset;
