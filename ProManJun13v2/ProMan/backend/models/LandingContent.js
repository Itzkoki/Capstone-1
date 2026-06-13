const db = require('../config/db');

/**
 * LandingContent model
 * ─────────────────────────────────────────────────────────────
 * Backs the Clinical Director "Website Management" feature.
 *
 *  • landing_sections  → order + visibility of each landing-page section
 *  • landing_content   → editable text/structured content per section
 */
const LandingContent = {
  // ── Sections (order + visibility) ───────────────────────────
  async getSections() {
    const result = await db.query(
      `SELECT id, section_key, display_name, sort_order, is_visible
       FROM landing_sections
       ORDER BY sort_order ASC, id ASC`
    );
    return result.rows;
  },

  /**
   * Persist a new ordering. `order` is an array of section_keys in the
   * desired top-to-bottom order. sort_order is reassigned from the index.
   */
  async reorderSections(orderedKeys) {
    if (!Array.isArray(orderedKeys) || orderedKeys.length === 0) return;
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      for (let i = 0; i < orderedKeys.length; i++) {
        await client.query(
          `UPDATE landing_sections
           SET sort_order = $1, updated_at = NOW()
           WHERE section_key = $2`,
          [i, orderedKeys[i]]
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

  async setVisibility(sectionKey, isVisible) {
    const result = await db.query(
      `UPDATE landing_sections
       SET is_visible = $1, updated_at = NOW()
       WHERE section_key = $2
       RETURNING id, section_key, display_name, sort_order, is_visible`,
      [isVisible, sectionKey]
    );
    return result.rows[0] || null;
  },

  // ── Content blobs ───────────────────────────────────────────
  async getAllContent() {
    const result = await db.query(
      `SELECT section_key, content FROM landing_content`
    );
    const map = {};
    for (const row of result.rows) map[row.section_key] = row.content;
    return map;
  },

  async getContent(sectionKey) {
    const result = await db.query(
      `SELECT section_key, content, updated_at
       FROM landing_content WHERE section_key = $1`,
      [sectionKey]
    );
    return result.rows[0] || null;
  },

  /**
   * Upsert the content blob for a section. Stored as JSONB.
   */
  async saveContent(sectionKey, content, updatedBy) {
    const result = await db.query(
      `INSERT INTO landing_content (section_key, content, updated_by, updated_at)
       VALUES ($1, $2::jsonb, $3, NOW())
       ON CONFLICT (section_key)
       DO UPDATE SET content = $2::jsonb, updated_by = $3, updated_at = NOW()
       RETURNING section_key, content, updated_at`,
      [sectionKey, JSON.stringify(content), updatedBy || null]
    );
    return result.rows[0];
  },
};

module.exports = LandingContent;
