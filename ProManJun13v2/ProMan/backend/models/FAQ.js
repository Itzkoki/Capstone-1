const db = require('../config/db');

const FAQ = {
  async create(question, answer, category, authorId) {
    const result = await db.query(
      `INSERT INTO faqs (question, answer, category, author_id)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [question, answer, category || null, authorId]
    );
    return result.rows[0];
  },

  async findAll(category = null, limit = 50, offset = 0) {
    let query = `SELECT f.*, u.full_name AS author_name
                 FROM faqs f
                 LEFT JOIN users u ON u.id = f.author_id
                 WHERE f.is_published = TRUE`;
    const params = [];
    let idx = 1;

    if (category) {
      query += ` AND f.category = $${idx++}`;
      params.push(category);
    }

    query += ` ORDER BY f.sort_order ASC, f.created_at DESC LIMIT $${idx++} OFFSET $${idx++}`;
    params.push(limit, offset);

    const result = await db.query(query, params);
    return result.rows;
  },

  async findById(id) {
    const result = await db.query(
      `SELECT f.*, u.full_name AS author_name
       FROM faqs f
       LEFT JOIN users u ON u.id = f.author_id
       WHERE f.id = $1`,
      [id]
    );
    return result.rows[0] || null;
  },

  async update(id, fields) {
    const allowed = ['question', 'answer', 'category', 'is_published', 'sort_order'];
    const sets = [];
    const params = [];
    let idx = 1;

    for (const [key, value] of Object.entries(fields)) {
      if (allowed.includes(key) && value !== undefined) {
        sets.push(`${key} = $${idx++}`);
        params.push(value);
      }
    }

    if (sets.length === 0) return null;

    sets.push(`updated_at = NOW()`);
    params.push(id);

    const result = await db.query(
      `UPDATE faqs SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
      params
    );
    return result.rows[0] || null;
  },

  async deleteById(id) {
    await db.query('DELETE FROM faqs WHERE id = $1', [id]);
  },

  async search(keyword, limit = 20) {
    const pattern = `%${keyword}%`;
    const result = await db.query(
      `SELECT id, question, answer, category, created_at
       FROM faqs
       WHERE is_published = TRUE
         AND (question ILIKE $1 OR answer ILIKE $1)
       ORDER BY created_at DESC
       LIMIT $2`,
      [pattern, limit]
    );
    return result.rows;
  },

  async getCount() {
    const result = await db.query(
      "SELECT COUNT(*) AS count FROM faqs WHERE is_published = TRUE"
    );
    return parseInt(result.rows[0].count, 10);
  },

  async getCategories() {
    const result = await db.query(
      `SELECT DISTINCT category FROM faqs
       WHERE category IS NOT NULL AND is_published = TRUE
       ORDER BY category`
    );
    return result.rows.map(r => r.category);
  },
};

module.exports = FAQ;
