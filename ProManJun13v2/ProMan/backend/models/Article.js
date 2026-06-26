const db = require('../config/db');

// Article authors may live in EITHER the legacy `users` table (clients) OR the
// dedicated `staff` table (clinical staff / Clinical Director, keyed by
// staff_id). An INNER JOIN to users silently dropped every staff-authored
// article. LEFT JOIN both and COALESCE the display name so all articles surface.
const AUTHOR_JOIN = `
  LEFT JOIN users u ON u.id = a.author_id
  LEFT JOIN staff s ON s.staff_id = a.author_id`;
const AUTHOR_NAME = `COALESCE(u.full_name, NULLIF(TRIM(CONCAT(s.first_name, ' ', s.last_name)), ''), 'Unknown') AS author_name`;

const Article = {
  async create(authorId, title, content, opts = {}) {
    const { category, source_url, featured_image, original_author, published_date } = opts;
    const result = await db.query(
      `INSERT INTO articles (author_id, title, content, status, category, source_url, featured_image, original_author, published_date)
       VALUES ($1, $2, $3, 'pending', $4, $5, $6, $7, $8)
       RETURNING *`,
      [authorId, title, content, category || null, source_url || null, featured_image || null, original_author || null, published_date || null]
    );
    return result.rows[0];
  },

  // Public feed — only approved articles
  async findAll(limit = 20, offset = 0) {
    const result = await db.query(
      `SELECT a.*, ${AUTHOR_NAME}
       FROM articles a
       ${AUTHOR_JOIN}
       WHERE a.status = 'approved'
       ORDER BY a.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    return result.rows;
  },

  // Staff view — all articles regardless of status
  async findAllForStaff(limit = 50, offset = 0) {
    const result = await db.query(
      `SELECT a.*, ${AUTHOR_NAME}
       FROM articles a
       ${AUTHOR_JOIN}
       ORDER BY a.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    return result.rows;
  },

  // Pending articles only — for staff moderation queue
  async findPending(limit = 50, offset = 0) {
    const result = await db.query(
      `SELECT a.*, ${AUTHOR_NAME}
       FROM articles a
       ${AUTHOR_JOIN}
       WHERE a.status = 'pending'
       ORDER BY a.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    return result.rows;
  },

  // Recently moderated articles of a given status, most-recent first.
  async findByStatus(status, limit = 20) {
    const result = await db.query(
      `SELECT a.*, ${AUTHOR_NAME}
       FROM articles a
       ${AUTHOR_JOIN}
       WHERE a.status = $1
       ORDER BY a.updated_at DESC
       LIMIT $2`,
      [status, limit]
    );
    return result.rows;
  },

  async findById(id) {
    const result = await db.query(
      `SELECT a.*, ${AUTHOR_NAME}
       FROM articles a
       ${AUTHOR_JOIN}
       WHERE a.id = $1`,
      [id]
    );
    return result.rows[0] || null;
  },

  // Find by source URL — for duplicate detection
  async findBySourceUrl(url) {
    const result = await db.query(
      `SELECT id, title, source_url, created_at
       FROM articles
       WHERE source_url = $1
       LIMIT 1`,
      [url]
    );
    return result.rows[0] || null;
  },

  async update(id, title, content) {
    const result = await db.query(
      `UPDATE articles SET title = $1, content = $2, updated_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [title, content, id]
    );
    return result.rows[0] || null;
  },

  // Update article moderation status
  async updateStatus(id, status) {
    const result = await db.query(
      `UPDATE articles SET status = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [status, id]
    );
    return result.rows[0] || null;
  },

  async deleteById(id) {
    await db.query('DELETE FROM articles WHERE id = $1', [id]);
  },

  async getCount() {
    const result = await db.query("SELECT COUNT(*) AS count FROM articles WHERE status = 'approved'");
    return parseInt(result.rows[0].count, 10);
  },

  async getPendingCount() {
    const result = await db.query("SELECT COUNT(*) AS count FROM articles WHERE status = 'pending'");
    return parseInt(result.rows[0].count, 10);
  },

  async search(keyword, limit = 10) {
    const pattern = `%${keyword}%`;
    const result = await db.query(
      `SELECT id, title, LEFT(content, 150) AS snippet, category, created_at
       FROM articles
       WHERE status = 'approved'
         AND (title ILIKE $1 OR content ILIKE $1)
       ORDER BY created_at DESC
       LIMIT $2`,
      [pattern, limit]
    );
    return result.rows;
  },

  async anonymizeByAuthor(userId) {
    const result = await db.query(
      `UPDATE articles SET author_id = NULL, updated_at = NOW()
       WHERE author_id = $1`,
      [userId]
    );
    return result.rowCount;
  },
};

module.exports = Article;
