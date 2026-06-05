const db = require('../config/db');

const ForumThread = {
  async create(authorId, title, content, category, tags, isAnonymous, status = 'pending') {
    const result = await db.query(
      `INSERT INTO forum_threads (author_id, title, content, category, tags, is_anonymous, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [authorId, title, content, category || null, tags || [], isAnonymous || false, status]
    );
    return result.rows[0];
  },

  /**
   * Public feed — approved threads with vote scores.
   */
  async findApproved(category = null, limit = 20, offset = 0) {
    let query = `
      SELECT t.*,
             CASE WHEN t.is_anonymous THEN NULL ELSE u.full_name END AS author_name,
             COALESCE((SELECT SUM(vote_value) FROM votes WHERE content_type = 'thread' AND content_id = t.id), 0) AS vote_score
      FROM forum_threads t
      LEFT JOIN users u ON u.id = t.author_id
      WHERE t.status = 'approved'`;
    const params = [];
    let idx = 1;

    if (category) {
      query += ` AND t.category = $${idx++}`;
      params.push(category);
    }

    query += ` ORDER BY t.is_pinned DESC, t.created_at DESC LIMIT $${idx++} OFFSET $${idx++}`;
    params.push(limit, offset);

    const result = await db.query(query, params);
    return result.rows;
  },

  /**
   * Staff moderation queue — pending threads only (not flagged).
   */
  async findPending(limit = 50, offset = 0) {
    const result = await db.query(
      `SELECT t.*, u.full_name AS author_name
       FROM forum_threads t
       LEFT JOIN users u ON u.id = t.author_id
       WHERE t.status = 'pending'
       ORDER BY t.created_at ASC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    return result.rows;
  },

  /**
   * Staff moderation queue — flagged/crisis threads only.
   */
  async findFlagged(limit = 50, offset = 0) {
    const result = await db.query(
      `SELECT t.*, u.full_name AS author_name
       FROM forum_threads t
       LEFT JOIN users u ON u.id = t.author_id
       WHERE t.status = 'flagged'
       ORDER BY t.created_at ASC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    return result.rows;
  },

  async findById(id) {
    const result = await db.query(
      `SELECT t.*,
              u.full_name AS author_name,
              COALESCE((SELECT SUM(vote_value) FROM votes WHERE content_type = 'thread' AND content_id = t.id), 0) AS vote_score
       FROM forum_threads t
       LEFT JOIN users u ON u.id = t.author_id
       WHERE t.id = $1`,
      [id]
    );
    return result.rows[0] || null;
  },

  async updateStatus(id, status) {
    const result = await db.query(
      `UPDATE forum_threads SET status = $1, updated_at = NOW()
       WHERE id = $2 RETURNING *`,
      [status, id]
    );
    return result.rows[0] || null;
  },

  async pin(id, isPinned) {
    const result = await db.query(
      `UPDATE forum_threads SET is_pinned = $1, updated_at = NOW()
       WHERE id = $2 RETURNING *`,
      [isPinned, id]
    );
    return result.rows[0] || null;
  },

  async incrementReplyCount(id) {
    await db.query(
      `UPDATE forum_threads SET reply_count = reply_count + 1, updated_at = NOW()
       WHERE id = $1`,
      [id]
    );
  },

  async decrementReplyCount(id) {
    await db.query(
      `UPDATE forum_threads SET reply_count = GREATEST(reply_count - 1, 0), updated_at = NOW()
       WHERE id = $1`,
      [id]
    );
  },

  async deleteById(id) {
    await db.query('DELETE FROM forum_threads WHERE id = $1', [id]);
  },

  async findByAuthor(userId, limit = 50) {
    const result = await db.query(
      `SELECT id, title, status, is_anonymous, created_at
       FROM forum_threads
       WHERE author_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [userId, limit]
    );
    return result.rows;
  },

  /**
   * Right-to-be-forgotten: anonymize all threads by a user.
   */
  async anonymizeByAuthor(userId) {
    const result = await db.query(
      `UPDATE forum_threads SET author_id = NULL, is_anonymous = TRUE, updated_at = NOW()
       WHERE author_id = $1`,
      [userId]
    );
    return result.rowCount;
  },

  async search(keyword, limit = 10) {
    const pattern = `%${keyword}%`;
    const result = await db.query(
      `SELECT id, title,
              LEFT(content, 150) AS snippet,
              category, created_at
       FROM forum_threads
       WHERE status = 'approved'
         AND (title ILIKE $1 OR content ILIKE $1)
       ORDER BY created_at DESC
       LIMIT $2`,
      [pattern, limit]
    );
    return result.rows;
  },

  async getApprovedCount() {
    const result = await db.query(
      "SELECT COUNT(*) AS count FROM forum_threads WHERE status = 'approved'"
    );
    return parseInt(result.rows[0].count, 10);
  },

  async getPendingCount() {
    const result = await db.query(
      "SELECT COUNT(*) AS count FROM forum_threads WHERE status = 'pending'"
    );
    return parseInt(result.rows[0].count, 10);
  },

  async getFlaggedCount() {
    const result = await db.query(
      "SELECT COUNT(*) AS count FROM forum_threads WHERE status = 'flagged'"
    );
    return parseInt(result.rows[0].count, 10);
  },
};

module.exports = ForumThread;
