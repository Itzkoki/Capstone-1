const db = require('../config/db');

const ReportTemplate = {
  async findAll(activeOnly = true) {
    let q = `SELECT * FROM report_templates`;
    if (activeOnly) q += ` WHERE is_active = TRUE`;
    q += ` ORDER BY created_at DESC`;
    const r = await db.query(q);
    return r.rows;
  },

  async findById(id) {
    const r = await db.query(`SELECT * FROM report_templates WHERE id = $1`, [id]);
    return r.rows[0] || null;
  },

  async create({ name, description, template_type, sections_config, created_by }) {
    const r = await db.query(
      `INSERT INTO report_templates (name, description, template_type, sections_config, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [name, description, template_type, JSON.stringify(sections_config), created_by]
    );
    return r.rows[0];
  },

  async update(id, { name, description, template_type, sections_config, is_active }) {
    const r = await db.query(
      `UPDATE report_templates
       SET name = COALESCE($1, name),
           description = COALESCE($2, description),
           template_type = COALESCE($3, template_type),
           sections_config = COALESCE($4, sections_config),
           is_active = COALESCE($5, is_active),
           updated_at = NOW()
       WHERE id = $6 RETURNING *`,
      [name, description, template_type, sections_config ? JSON.stringify(sections_config) : null, is_active, id]
    );
    return r.rows[0] || null;
  },

  async delete(id) {
    await db.query(`DELETE FROM report_templates WHERE id = $1`, [id]);
  },
};

module.exports = ReportTemplate;
