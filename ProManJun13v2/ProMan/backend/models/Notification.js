const db = require('../config/db');

// Notifications are addressed to an id from EITHER the `users` (clients) or the
// `staff` table. Those id spaces overlap, so every query is scoped by BOTH the
// id AND `recipient_type` ('user' | 'staff'); without the discriminator a client
// and a staff member sharing the same integer id would see each other's alerts.
const RECIPIENT_TYPES = ['user', 'staff'];
const normalizeType = (t) => (RECIPIENT_TYPES.includes(t) ? t : 'user');

const Notification = {
  async create(userId, type, title, message, link = null, recipientType = 'user', caseId = null) {
    try {
      const result = await db.query(
        `INSERT INTO notifications (user_id, recipient_type, type, title, message, link, case_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [userId, normalizeType(recipientType), type, title, message, link, caseId]
      );
      return result.rows[0];
    } catch (err) {
      console.error(`❌ Notification.create FAILED — type="${type}" user=${userId}:`, err.message);
      return null;
    }
  },

  async findByUserId(userId, recipientType = 'user', limit = 20, offset = 0) {
    const result = await db.query(
      `SELECT id, type, title, message, is_read, link, created_at
       FROM notifications
       WHERE user_id = $1 AND recipient_type = $2
       ORDER BY created_at DESC
       LIMIT $3 OFFSET $4`,
      [userId, normalizeType(recipientType), limit, offset]
    );
    return result.rows;
  },

  async getUnreadCount(userId, recipientType = 'user') {
    const result = await db.query(
      `SELECT COUNT(*) AS count FROM notifications
       WHERE user_id = $1 AND recipient_type = $2 AND is_read = FALSE`,
      [userId, normalizeType(recipientType)]
    );
    return parseInt(result.rows[0].count, 10);
  },

  async markAsRead(id, userId, recipientType = 'user') {
    const result = await db.query(
      `UPDATE notifications SET is_read = TRUE
       WHERE id = $1 AND user_id = $2 AND recipient_type = $3
       RETURNING *`,
      [id, userId, normalizeType(recipientType)]
    );
    return result.rows[0] || null;
  },

  async markAsUnread(id, userId, recipientType = 'user') {
    const result = await db.query(
      `UPDATE notifications SET is_read = FALSE
       WHERE id = $1 AND user_id = $2 AND recipient_type = $3
       RETURNING *`,
      [id, userId, normalizeType(recipientType)]
    );
    return result.rows[0] || null;
  },

  async markAllAsRead(userId, recipientType = 'user') {
    await db.query(
      `UPDATE notifications SET is_read = TRUE
       WHERE user_id = $1 AND recipient_type = $2 AND is_read = FALSE`,
      [userId, normalizeType(recipientType)]
    );
  },

  async deleteById(id, userId, recipientType = 'user') {
    await db.query(
      `DELETE FROM notifications WHERE id = $1 AND user_id = $2 AND recipient_type = $3`,
      [id, userId, normalizeType(recipientType)]
    );
  },

  /**
   * Delete all notifications of a given type for a user.
   * Used for auto-cleanup after a user acts on a notification (e.g. appointment response).
   */
  async deleteByTypeForUser(userId, type, recipientType = 'user') {
    await db.query(
      `DELETE FROM notifications WHERE user_id = $1 AND type = $2 AND recipient_type = $3`,
      [userId, type, normalizeType(recipientType)]
    );
  },

  /**
   * Delete notifications matching a type and containing specific text in the title.
   */
  async deleteByTypeAndTitle(userId, type, titlePattern, recipientType = 'user') {
    await db.query(
      `DELETE FROM notifications WHERE user_id = $1 AND type = $2 AND title ILIKE $3 AND recipient_type = $4`,
      [userId, type, `%${titlePattern}%`, normalizeType(recipientType)]
    );
  },
};

module.exports = Notification;
