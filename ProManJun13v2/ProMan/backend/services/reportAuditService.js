const db = require('../config/db');

const ReportAuditService = {
  /**
   * Log a report-related action.
   * @param {Object} opts
   * @param {number|null} opts.reportId
   * @param {number} opts.userId
   * @param {string} opts.action
   * @param {string} opts.details
   * @param {Object} opts.req - Express request (for IP/UA)
   */
  async log({ reportId, userId, action, details, req }) {
    const ip = req ? (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '') : '';
    const ua = req ? (req.headers['user-agent'] || '') : '';
    try {
      await db.query(
        `INSERT INTO report_audit_logs (report_id, user_id, action, details, ip_address, user_agent)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [reportId, userId, action, details, ip, ua]
      );
    } catch (e) {
      console.warn('ReportAudit.log skipped:', action, e.message);
    }
  },

  /**
   * Get audit logs with optional filters.
   */
  async getLogs({ reportId, userId, action, limit = 100, offset = 0 } = {}) {
    let q = `SELECT ral.*, u.full_name AS user_name
             FROM report_audit_logs ral
             LEFT JOIN users u ON ral.user_id = u.id`;
    const params = [];
    const conds = [];
    let idx = 1;
    if (reportId) { conds.push(`ral.report_id = $${idx++}`); params.push(reportId); }
    if (userId) { conds.push(`ral.user_id = $${idx++}`); params.push(userId); }
    if (action) { conds.push(`ral.action = $${idx++}`); params.push(action); }
    if (conds.length) q += ` WHERE ` + conds.join(' AND ');
    q += ` ORDER BY ral.created_at DESC LIMIT $${idx++} OFFSET $${idx++}`;
    params.push(limit, offset);
    const r = await db.query(q, params);
    return r.rows;
  },
};

module.exports = ReportAuditService;
