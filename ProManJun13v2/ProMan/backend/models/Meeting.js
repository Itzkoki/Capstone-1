const crypto = require('crypto');
const db = require('../config/db');

const Meeting = {
  generateLink() {
    const uuid = crypto.randomUUID();
    return `https://meet.barcarse.com/${uuid}`;
  },

  async create(hostId, title) {
    const meetingLink = this.generateLink();
    const result = await db.query(
      `INSERT INTO meetings (host_id, title, meeting_link)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [hostId, title, meetingLink]
    );
    return result.rows[0];
  },

  async findAll({ hostId, status, limit = 20, offset = 0 } = {}) {
    // Host may be a staff-table account (staff_id) or a legacy users row, so
    // resolve the name across both tables (prefer staff for the host).
    let query = `SELECT m.*,
                        COALESCE(NULLIF(TRIM(CONCAT_WS(' ', st.first_name, st.last_name)), ''), u.full_name) AS host_name
                 FROM meetings m
                 LEFT JOIN users u  ON u.id       = m.host_id
                 LEFT JOIN staff st ON st.staff_id = m.host_id
                 WHERE 1=1`;
    const params = [];
    let idx = 1;

    if (hostId) {
      query += ` AND m.host_id = $${idx++}`;
      params.push(hostId);
    }
    if (status) {
      query += ` AND m.status = $${idx++}`;
      params.push(status);
    }

    query += ` ORDER BY m.created_at DESC LIMIT $${idx++} OFFSET $${idx++}`;
    params.push(limit, offset);

    const result = await db.query(query, params);
    return result.rows;
  },

  async findById(id) {
    const result = await db.query(
      `SELECT m.*,
              COALESCE(NULLIF(TRIM(CONCAT_WS(' ', st.first_name, st.last_name)), ''), u.full_name) AS host_name
       FROM meetings m
       LEFT JOIN users u  ON u.id       = m.host_id
       LEFT JOIN staff st ON st.staff_id = m.host_id
       WHERE m.id = $1`,
      [id]
    );
    return result.rows[0] || null;
  },

  async endMeeting(id) {
    const result = await db.query(
      `UPDATE meetings SET status = 'ended', ended_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id]
    );
    return result.rows[0] || null;
  },

  async updateConsent(id, consent) {
    const result = await db.query(
      `UPDATE meetings SET recording_consent = $1
       WHERE id = $2
       RETURNING *`,
      [consent, id]
    );
    return result.rows[0] || null;
  },

  async getActiveCount() {
    const result = await db.query(
      `SELECT COUNT(*) AS count FROM meetings WHERE status = 'active'`
    );
    return parseInt(result.rows[0].count, 10);
  },
};

module.exports = Meeting;
