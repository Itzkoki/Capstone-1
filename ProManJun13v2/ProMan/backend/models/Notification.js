const db = require('../config/db');

const Notification = {
  async create(userId, type, title, message, link = null, caseId = null) {
    try {
      const result = await db.query(
        `INSERT INTO notifications (user_id, type, title, message, link, case_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [userId, type, title, message, link, caseId]
      );
      return result.rows[0];
    } catch (err) {
      console.error(`❌ Notification.create FAILED — type="${type}" user=${userId}:`, err.message);
      return null;
    }
  },

  async findByUserId(userId, limit = 20, offset = 0) {
    const result = await db.query(
      `SELECT id, type, title, message, is_read, link, created_at
       FROM notifications
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );
    return result.rows;
  },

  async getUnreadCount(userId) {
    const result = await db.query(
      `SELECT COUNT(*) AS count FROM notifications
       WHERE user_id = $1 AND is_read = FALSE`,
      [userId]
    );
    return parseInt(result.rows[0].count, 10);
  },

  async markAsRead(id, userId) {
    const result = await db.query(
      `UPDATE notifications SET is_read = TRUE
       WHERE id = $1 AND user_id = $2
       RETURNING *`,
      [id, userId]
    );
    return result.rows[0] || null;
  },

  async markAsUnread(id, userId) {
    const result = await db.query(
      `UPDATE notifications SET is_read = FALSE
       WHERE id = $1 AND user_id = $2
       RETURNING *`,
      [id, userId]
    );
    return result.rows[0] || null;
  },

  async markAllAsRead(userId) {
    await db.query(
      `UPDATE notifications SET is_read = TRUE
       WHERE user_id = $1 AND is_read = FALSE`,
      [userId]
    );
  },

  async deleteById(id, userId) {
    await db.query(
      `DELETE FROM notifications WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );
  },

  /**
   * Delete all notifications of a given type for a user.
   * Used for auto-cleanup after a user acts on a notification (e.g. appointment response).
   */
  async deleteByTypeForUser(userId, type) {
    await db.query(
      `DELETE FROM notifications WHERE user_id = $1 AND type = $2`,
      [userId, type]
    );
  },

  /**
   * Delete notifications matching a type and containing specific text in the title.
   */
  async deleteByTypeAndTitle(userId, type, titlePattern) {
    await db.query(
      `DELETE FROM notifications WHERE user_id = $1 AND type = $2 AND title ILIKE $3`,
      [userId, type, `%${titlePattern}%`]
    );
  },
};

module.exports = Notification;
