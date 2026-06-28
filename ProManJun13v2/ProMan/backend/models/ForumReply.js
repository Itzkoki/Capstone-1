const db = require('../config/db');

// Authors may be clients (users.id) or clinical staff (staff.staff_id) — two
// SEPARATE id sequences sharing the single author_id column. Join both tables
// and use the stored author_role to resolve the correct display name + role
// (legacy rows without author_role fall back to whichever table matches).
const AUTHOR_JOIN = `
  LEFT JOIN users u ON u.id = r.author_id
  LEFT JOIN staff s ON s.staff_id = r.author_id`;
const STAFF_NAME = `NULLIF(TRIM(CONCAT(s.first_name, ' ', s.last_name)), '')`;
const AUTHOR_NAME = `COALESCE(
  CASE WHEN r.author_role IS NOT NULL AND r.author_role <> 'client' THEN ${STAFF_NAME} END,
  u.full_name,
  ${STAFF_NAME}
)`;
const AUTHOR_ROLE = `COALESCE(NULLIF(r.author_role, 'client'), CASE WHEN u.id IS NULL THEN s.role END)`;

const ForumReply = {
  async create(threadId, parentId, authorId, content, isAnonymous, authorRole = null) {
    const result = await db.query(
      `INSERT INTO forum_replies (thread_id, parent_id, author_id, content, is_anonymous, author_role)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [threadId, parentId || null, authorId, content, isAnonymous || false, authorRole]
    );
    return result.rows[0];
  },

  /**
   * All replies for a thread, ordered chronologically.
   * Anonymous author names are stripped for non-staff views.
   */
  async findByThread(threadId) {
    const result = await db.query(
      `SELECT r.*,
              CASE WHEN r.is_anonymous THEN NULL ELSE ${AUTHOR_NAME} END AS author_name,
              CASE WHEN r.is_anonymous THEN NULL ELSE ${AUTHOR_ROLE} END AS author_role,
              COALESCE((SELECT SUM(vote_value) FROM votes WHERE content_type = 'reply' AND content_id = r.id), 0) AS vote_score
       FROM forum_replies r
       ${AUTHOR_JOIN}
       WHERE r.thread_id = $1 AND r.status = 'approved'
       ORDER BY r.created_at ASC`,
      [threadId]
    );
    return result.rows;
  },

  /**
   * Staff view — includes hidden/flagged replies with full author info.
   */
  async findByThreadForStaff(threadId) {
    const result = await db.query(
      `SELECT r.*, ${AUTHOR_NAME} AS author_name, ${AUTHOR_ROLE} AS author_role,
              COALESCE((SELECT SUM(vote_value) FROM votes WHERE content_type = 'reply' AND content_id = r.id), 0) AS vote_score
       FROM forum_replies r
       ${AUTHOR_JOIN}
       WHERE r.thread_id = $1
       ORDER BY r.created_at ASC`,
      [threadId]
    );
    return result.rows;
  },

  async findById(id) {
    const result = await db.query(
      `SELECT r.*, u.full_name AS author_name
       FROM forum_replies r
       LEFT JOIN users u ON u.id = r.author_id
       WHERE r.id = $1`,
      [id]
    );
    return result.rows[0] || null;
  },

  async updateStatus(id, status) {
    const result = await db.query(
      `UPDATE forum_replies SET status = $1 WHERE id = $2 RETURNING *`,
      [status, id]
    );
    return result.rows[0] || null;
  },

  async deleteById(id) {
    // Get thread_id before deleting so we can decrement count
    const reply = await db.query('SELECT thread_id FROM forum_replies WHERE id = $1', [id]);
    await db.query('DELETE FROM forum_replies WHERE id = $1', [id]);
    return reply.rows[0] || null;
  },

  /**
   * Right-to-be-forgotten: anonymize all replies by a user.
   */
  async anonymizeByAuthor(userId) {
    const result = await db.query(
      `UPDATE forum_replies SET author_id = NULL, is_anonymous = TRUE
       WHERE author_id = $1`,
      [userId]
    );
    return result.rowCount;
  },

  async getCountByThread(threadId) {
    const result = await db.query(
      "SELECT COUNT(*) AS count FROM forum_replies WHERE thread_id = $1 AND status = 'approved'",
      [threadId]
    );
    return parseInt(result.rows[0].count, 10);
  },
};

module.exports = ForumReply;
