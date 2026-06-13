const db = require('../config/db');

/**
 * TeamMember model — backs the "Meet the Team" manager.
 * Supports add / edit / delete, photo paths (stored as on-disk file locations),
 * visibility toggling and drag-free reordering.
 */
const TeamMember = {
  /** Public list: only visible members, ordered. */
  async findVisible() {
    const result = await db.query(
      `SELECT id, name, role, bio, photo_thumbnail, photo_full, sort_order
       FROM team_members
       WHERE is_visible = TRUE
       ORDER BY sort_order ASC, id ASC`
    );
    return result.rows;
  },

  /** Admin list: everyone, ordered. */
  async findAll() {
    const result = await db.query(
      `SELECT id, name, role, bio, photo_thumbnail, photo_full, sort_order, is_visible, created_at, updated_at
       FROM team_members
       ORDER BY sort_order ASC, id ASC`
    );
    return result.rows;
  },

  async findById(id) {
    const result = await db.query(
      `SELECT * FROM team_members WHERE id = $1`,
      [id]
    );
    return result.rows[0] || null;
  },

  async create({ name, role, bio, photo_thumbnail, photo_full, is_visible }) {
    // New members go to the bottom of the list.
    const max = await db.query('SELECT COALESCE(MAX(sort_order), -1) AS m FROM team_members');
    const nextOrder = parseInt(max.rows[0].m, 10) + 1;

    const result = await db.query(
      `INSERT INTO team_members (name, role, bio, photo_thumbnail, photo_full, sort_order, is_visible)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [name, role || null, bio || null, photo_thumbnail || null, photo_full || null, nextOrder, is_visible !== false]
    );
    return result.rows[0];
  },

  async update(id, fields) {
    const allowed = ['name', 'role', 'bio', 'photo_thumbnail', 'photo_full', 'is_visible'];
    const sets = [];
    const params = [];
    let idx = 1;

    for (const [key, value] of Object.entries(fields)) {
      if (allowed.includes(key) && value !== undefined) {
        sets.push(`${key} = $${idx++}`);
        params.push(value);
      }
    }
    if (sets.length === 0) return this.findById(id);

    sets.push('updated_at = NOW()');
    params.push(id);

    const result = await db.query(
      `UPDATE team_members SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
      params
    );
    return result.rows[0] || null;
  },

  async deleteById(id) {
    await db.query('DELETE FROM team_members WHERE id = $1', [id]);
  },

  /** Persist a new ordering given an array of member ids. */
  async reorder(orderedIds) {
    if (!Array.isArray(orderedIds) || orderedIds.length === 0) return;
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      for (let i = 0; i < orderedIds.length; i++) {
        await client.query(
          `UPDATE team_members SET sort_order = $1, updated_at = NOW() WHERE id = $2`,
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

module.exports = TeamMember;
