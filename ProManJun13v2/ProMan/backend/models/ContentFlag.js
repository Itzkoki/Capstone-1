const db = require('../config/db');

const ContentFlag = {
  async create(reporterId, contentType, contentId, reason, details) {
    const result = await db.query(
      `INSERT INTO content_flags (reporter_id, content_type, content_id, reason, details)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [reporterId, contentType, contentId, reason, details || null]
    );
    return result.rows[0];
  },

  /**
   * Staff moderation queue — pending flags with a content preview.
   */
  async findPending(limit = 50, offset = 0) {
    const result = await db.query(
      `SELECT cf.*,
              reporter.full_name AS reporter_name,
              CASE cf.content_type
                WHEN 'article' THEN (SELECT title FROM articles WHERE id = cf.content_id)
                WHEN 'thread'  THEN (SELECT title FROM forum_threads WHERE id = cf.content_id)
                WHEN 'reply'   THEN (SELECT LEFT(content, 100) FROM forum_replies WHERE id = cf.content_id)
                WHEN 'faq'     THEN (SELECT LEFT(question, 100) FROM faqs WHERE id = cf.content_id)
              END AS content_preview,
              CASE cf.content_type
                WHEN 'article' THEN (SELECT content FROM articles WHERE id = cf.content_id)
                WHEN 'thread'  THEN (SELECT content FROM forum_threads WHERE id = cf.content_id)
                WHEN 'reply'   THEN (SELECT content FROM forum_replies WHERE id = cf.content_id)
                WHEN 'faq'     THEN (SELECT answer FROM faqs WHERE id = cf.content_id)
              END AS content_body
       FROM content_flags cf
       LEFT JOIN users reporter ON reporter.id = cf.reporter_id
       WHERE cf.status = 'pending'
       ORDER BY cf.created_at ASC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    return result.rows;
  },

  /**
   * Pending (unreviewed) flags for a specific content item — used to mark the
   * exact flagged message in the community forum (staff view).
   */
  async findPendingByContent(contentType, contentId) {
    const result = await db.query(
      `SELECT cf.reason, cf.details, cf.created_at,
              reporter.full_name AS reporter_name
       FROM content_flags cf
       LEFT JOIN users reporter ON reporter.id = cf.reporter_id
       WHERE cf.status = 'pending' AND cf.content_type = $1 AND cf.content_id = $2
       ORDER BY cf.created_at DESC`,
      [contentType, contentId]
    );
    return result.rows;
  },

  async findById(id) {
    const result = await db.query(
      `SELECT cf.*,
              reporter.full_name AS reporter_name,
              reviewer.full_name AS reviewer_name
       FROM content_flags cf
       LEFT JOIN users reporter ON reporter.id = cf.reporter_id
       LEFT JOIN users reviewer ON reviewer.id = cf.reviewed_by
       WHERE cf.id = $1`,
      [id]
    );
    return result.rows[0] || null;
  },

  /**
   * Staff reviews a flag — mark as dismissed or actioned.
   */
  async review(id, reviewedBy, status, reviewNote) {
    const result = await db.query(
      `UPDATE content_flags
       SET status = $1, reviewed_by = $2, review_note = $3, reviewed_at = NOW()
       WHERE id = $4
       RETURNING *`,
      [status, reviewedBy, reviewNote || null, id]
    );
    return result.rows[0] || null;
  },

  async getCountByStatus(status) {
    const result = await db.query(
      'SELECT COUNT(*) AS count FROM content_flags WHERE status = $1',
      [status]
    );
    return parseInt(result.rows[0].count, 10);
  },

  /**
   * Check if a user has already flagged this content (prevent spam-flagging).
   */
  async existsForUser(reporterId, contentType, contentId) {
    const result = await db.query(
      `SELECT 1 FROM content_flags
       WHERE reporter_id = $1 AND content_type = $2 AND content_id = $3`,
      [reporterId, contentType, contentId]
    );
    return result.rows.length > 0;
  },

  /**
   * Right-to-be-forgotten: delete all flags submitted by a user.
   */
  async deleteByUser(userId) {
    const result = await db.query(
      'DELETE FROM content_flags WHERE reporter_id = $1',
      [userId]
    );
    return result.rowCount;
  },
};

module.exports = ContentFlag;
