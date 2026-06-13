const db = require('../config/db');

/**
 * Dedicated audit trail for client requests / report requests.
 * Append-only: every action on a ticket is recorded with the responsible
 * user, a timestamp, and optional free-text remarks (e.g. a rejection reason).
 *
 * Action vocabulary (kept stable so the trail is filterable):
 *   REQUEST_SUBMITTED, STAFF_NOTIFIED, REQUEST_APPROVED, REQUEST_REJECTED,
 *   PAYMENT_PROMPTED, PAYMENT_SUBMITTED, PAYMENT_APPROVED, PAYMENT_REJECTED,
 *   REPORT_GENERATED, REPORT_SENT, STATUS_CHANGED, REPLY, FLAGGED
 */
const RequestAuditLog = {
  /**
   * Record an action. Never throws — audit logging must not break the
   * user's action; failures are logged to the console and swallowed.
   */
  async log(requestId, userId, action, remarks = null) {
    try {
      const result = await db.query(
        `INSERT INTO client_request_audit_logs (request_id, user_id, action, remarks)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [requestId, userId || null, action, remarks || null]
      );
      return result.rows[0];
    } catch (e) {
      console.error('RequestAuditLog.log failed (' + action + '):', e.message);
      return null;
    }
  },

  /**
   * Full chronological trail for one ticket, with the responsible user's name/role.
   */
  async forRequest(requestId) {
    const result = await db.query(
      `SELECT al.id, al.request_id, al.user_id, al.action, al.remarks, al.created_at,
              u.full_name AS user_name, u.role AS user_role
       FROM client_request_audit_logs al
       LEFT JOIN users u ON u.id = al.user_id
       WHERE al.request_id = $1
       ORDER BY al.created_at ASC, al.id ASC`,
      [requestId]
    );
    return result.rows;
  },
};

module.exports = RequestAuditLog;
