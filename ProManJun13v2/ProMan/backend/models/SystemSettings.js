const db = require('../config/db');

const SystemSettings = {
  async get(key) {
    const result = await db.query(
      'SELECT key, value, updated_at FROM system_settings WHERE key = $1',
      [key]
    );
    return result.rows[0] || null;
  },

  async set(key, value, updatedBy) {
    const result = await db.query(
      `INSERT INTO system_settings (key, value, updated_by, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (key) DO UPDATE SET
         value = EXCLUDED.value,
         updated_by = EXCLUDED.updated_by,
         updated_at = NOW()
       RETURNING *`,
      [key, value, updatedBy]
    );
    return result.rows[0];
  },

  async getAll() {
    const result = await db.query(
      'SELECT key, value, updated_at FROM system_settings ORDER BY key'
    );
    return result.rows;
  },
};

module.exports = SystemSettings;
