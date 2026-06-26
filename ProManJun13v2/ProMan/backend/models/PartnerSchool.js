const db = require('../config/db');

const PartnerSchool = {
  async findEnabled() {
    const result = await db.query(
      `SELECT id, school_name, logo_path, sort_order
       FROM partner_schools
       WHERE is_enabled = TRUE
       ORDER BY sort_order ASC, id ASC`
    );
    return result.rows;
  },

  async findAll() {
    const result = await db.query(
      `SELECT id, school_name, logo_path, is_enabled, sort_order, created_at
       FROM partner_schools
       ORDER BY sort_order ASC, id ASC`
    );
    return result.rows;
  },

  async findById(id) {
    const result = await db.query(
      `SELECT id, school_name, logo_path, is_enabled, sort_order FROM partner_schools WHERE id = $1`,
      [id]
    );
    return result.rows[0] || null;
  },

  async create({ school_name, logo_path, is_enabled = true }) {
    const result = await db.query(
      `INSERT INTO partner_schools (school_name, logo_path, is_enabled, sort_order)
       VALUES ($1, $2, $3,
         COALESCE((SELECT MAX(sort_order) + 1 FROM partner_schools), 0))
       RETURNING id, school_name, logo_path, is_enabled, sort_order`,
      [school_name, logo_path, is_enabled]
    );
    return result.rows[0];
  },

  async update(id, fields) {
    const sets = [];
    const vals = [];
    let i = 1;
    if (fields.school_name !== undefined) { sets.push(`school_name = $${i++}`); vals.push(fields.school_name); }
    if (fields.logo_path   !== undefined) { sets.push(`logo_path = $${i++}`);   vals.push(fields.logo_path); }
    if (fields.is_enabled  !== undefined) { sets.push(`is_enabled = $${i++}`);  vals.push(fields.is_enabled); }
    if (!sets.length) return this.findById(id);
    sets.push(`updated_at = NOW()`);
    vals.push(id);
    const result = await db.query(
      `UPDATE partner_schools SET ${sets.join(', ')} WHERE id = $${i} RETURNING id, school_name, logo_path, is_enabled, sort_order`,
      vals
    );
    return result.rows[0] || null;
  },

  async deleteById(id) {
    await db.query(`DELETE FROM partner_schools WHERE id = $1`, [id]);
  },

  async reorder(orderedIds) {
    if (!Array.isArray(orderedIds) || !orderedIds.length) return;
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      for (let i = 0; i < orderedIds.length; i++) {
        await client.query(
          `UPDATE partner_schools SET sort_order = $1, updated_at = NOW() WHERE id = $2`,
          [i, orderedIds[i]]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },
};

module.exports = PartnerSchool;
