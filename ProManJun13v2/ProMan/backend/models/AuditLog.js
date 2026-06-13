const db = require('../config/db');

const AuditLog = {
  /**
   * Log one or more profile field changes.
   * @param {number} userId
   * @param {Array<{field: string, oldValue: string|null, newValue: string|null}>} changes
   * @param {string} ipAddress - Client IP address
   */
  async log(userId, changes, ipAddress) {
    if (!changes || changes.length === 0) return;

    // Build a multi-row INSERT
    const values = [];
    const params = [];
    let paramIdx = 1;

    for (const change of changes) {
      values.push(`($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++})`);
      params.push(userId, change.field, change.oldValue, change.newValue, ipAddress);
    }

    await db.query(
      `INSERT INTO profile_audit_logs (user_id, field_changed, old_value, new_value, ip_address)
       VALUES ${values.join(', ')}`,
      params
    );
  },

  /**
   * Log changes within an existing transaction client.
   */
  async logWithClient(client, userId, changes, ipAddress) {
    if (!changes || changes.length === 0) return;

    const values = [];
    const params = [];
    let paramIdx = 1;

    for (const change of changes) {
      values.push(`($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++})`);
      params.push(userId, change.field, change.oldValue, change.newValue, ipAddress);
    }

    await client.query(
      `INSERT INTO profile_audit_logs (user_id, field_changed, old_value, new_value, ip_address)
       VALUES ${values.join(', ')}`,
      params
    );
  },

  /**
   * Get audit history for a user.
   */
  async getByUserId(userId, limit = 50) {
    const result = await db.query(
      `SELECT id, field_changed, old_value, new_value, ip_address, changed_at
       FROM profile_audit_logs
       WHERE user_id = $1
       ORDER BY changed_at DESC
       LIMIT $2`,
      [userId, limit]
    );
    return result.rows;
  },
};

module.exports = AuditLog;
