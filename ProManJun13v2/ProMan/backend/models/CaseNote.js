const db = require('../config/db');

/**
 * CaseNote model — structured comments for workflow decisions.
 * Stores intake rejections, report revision requests, appointment notes, etc.
 */
const CaseNote = {
  async create({ caseId, authorStaffId, authorUserId, noteType, content, isVisibleToClient = false }) {
    const result = await db.query(
      `INSERT INTO case_notes (case_id, author_staff_id, author_user_id, note_type, content, is_visible_to_client)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [caseId, authorStaffId || null, authorUserId || null, noteType, content, isVisibleToClient]
    );
    return result.rows[0];
  },

  async findByCaseId(caseId, { includeInternal = false } = {}) {
    let query = `
      SELECT cn.*,
             COALESCE(
               (SELECT CONCAT(s.first_name, ' ', s.last_name) FROM staff s WHERE s.staff_id = cn.author_staff_id),
               (SELECT full_name FROM users WHERE id = cn.author_user_id),
               'System'
             ) AS author_name
      FROM case_notes cn
      WHERE cn.case_id = $1
    `;
    if (!includeInternal) {
      query += ` AND cn.is_visible_to_client = TRUE`;
    }
    query += ` ORDER BY cn.created_at DESC`;
    const result = await db.query(query, [caseId]);
    return result.rows;
  },
};

module.exports = CaseNote;
