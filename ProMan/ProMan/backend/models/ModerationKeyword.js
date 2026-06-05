const db = require('../config/db');

const ModerationKeyword = {
  async create(word, category, severity, language, addedBy) {
    const result = await db.query(
      `INSERT INTO moderation_keywords (word, normalized, category, severity, language, added_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (normalized, language) DO UPDATE
       SET category = $3, severity = $4, is_active = TRUE, updated_at = NOW()
       RETURNING *`,
      [word, ModerationKeyword.normalize(word), category, severity, language || 'en', addedBy]
    );
    return result.rows[0];
  },

  /**
   * Normalize a word for matching: lowercase, strip accents,
   * replace common leet/obfuscation characters.
   */
  normalize(word) {
    return word
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip accents
      .replace(/0/g, 'o')
      .replace(/1/g, 'i')
      .replace(/3/g, 'e')
      .replace(/4/g, 'a')
      .replace(/5/g, 's')
      .replace(/7/g, 't')
      .replace(/8/g, 'b')
      .replace(/9/g, 'g')
      .replace(/@/g, 'a')
      .replace(/\$/g, 's')
      .replace(/\*/g, '')
      .replace(/[!|]/g, 'i')
      .replace(/\+/g, 't')
      .replace(/[^a-z]/g, ''); // strip remaining non-alpha
  },

  async findAll(language = null, category = null) {
    let query = 'SELECT * FROM moderation_keywords WHERE is_active = TRUE';
    const params = [];
    let idx = 1;
    if (language) { query += ` AND language = $${idx++}`; params.push(language); }
    if (category) { query += ` AND category = $${idx++}`; params.push(category); }
    query += ' ORDER BY severity DESC, word ASC';
    const result = await db.query(query, params);
    return result.rows;
  },

  async findById(id) {
    const result = await db.query('SELECT * FROM moderation_keywords WHERE id = $1', [id]);
    return result.rows[0] || null;
  },

  async deactivate(id) {
    const result = await db.query(
      'UPDATE moderation_keywords SET is_active = FALSE, updated_at = NOW() WHERE id = $1 RETURNING *',
      [id]
    );
    return result.rows[0] || null;
  },

  async deleteById(id) {
    await db.query('DELETE FROM moderation_keywords WHERE id = $1', [id]);
  },

  async getCategories() {
    const result = await db.query(
      'SELECT DISTINCT category FROM moderation_keywords WHERE is_active = TRUE ORDER BY category'
    );
    return result.rows.map(r => r.category);
  },

  async getCount() {
    const result = await db.query('SELECT COUNT(*) AS count FROM moderation_keywords WHERE is_active = TRUE');
    return parseInt(result.rows[0].count, 10);
  },

  /**
   * Bulk insert default keywords. Used for initial seeding.
   */
  async bulkCreate(keywords, addedBy) {
    let count = 0;
    for (const kw of keywords) {
      try {
        await ModerationKeyword.create(kw.word, kw.category, kw.severity, kw.language, addedBy);
        count++;
      } catch (err) { /* skip duplicates */ }
    }
    return count;
  },
};

module.exports = ModerationKeyword;
