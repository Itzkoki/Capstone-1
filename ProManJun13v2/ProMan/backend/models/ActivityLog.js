const db = require('../config/db');

const ActivityLog = {
  /**
   * @param {object} [meta] - { role, status, userAgent } for the Audit Logs view.
   */
  async log(userId, action, resourceType, resourceId, ipAddress, details = null, meta = {}) {
    const result = await db.query(
      `INSERT INTO activity_logs (user_id, action, resource_type, resource_id, ip_address, details, role, status, user_agent, fingerprint)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        userId, action, resourceType, resourceId, ipAddress,
        details ? JSON.stringify(details) : null,
        meta.role || null, meta.status || null, meta.userAgent || null,
        meta.fingerprint || null,
      ]
    );
    return result.rows[0];
  },

  async findAll({ userId, action, resourceType, startDate, endDate, limit = 50, offset = 0 } = {}) {
    let query = `SELECT al.*, u.full_name, u.email
                 FROM activity_logs al
                 LEFT JOIN users u ON u.id = al.user_id
                 WHERE 1=1`;
    const params = [];
    let idx = 1;

    if (userId) {
      query += ` AND al.user_id = $${idx++}`;
      params.push(userId);
    }
    if (action) {
      query += ` AND al.action = $${idx++}`;
      params.push(action);
    }
    if (resourceType) {
      query += ` AND al.resource_type = $${idx++}`;
      params.push(resourceType);
    }
    if (startDate) {
      query += ` AND al.created_at >= $${idx++}`;
      params.push(startDate);
    }
    if (endDate) {
      query += ` AND al.created_at <= $${idx++}`;
      params.push(endDate);
    }

    query += ` ORDER BY al.created_at DESC LIMIT $${idx++} OFFSET $${idx++}`;
    params.push(limit, offset);

    const result = await db.query(query, params);
    return result.rows;
  },

  async findByUserId(userId, limit = 50) {
    const result = await db.query(
      `SELECT id, action, resource_type, resource_id, ip_address, details, created_at
       FROM activity_logs
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [userId, limit]
    );
    return result.rows;
  },

  async getCount(filters = {}) {
    let query = `SELECT COUNT(*) AS count FROM activity_logs WHERE 1=1`;
    const params = [];
    let idx = 1;

    if (filters.userId) {
      query += ` AND user_id = $${idx++}`;
      params.push(filters.userId);
    }

    const result = await db.query(query, params);
    return parseInt(result.rows[0].count, 10);
  },
};

module.exports = ActivityLog;
