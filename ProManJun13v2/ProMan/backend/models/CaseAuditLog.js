const db = require('../config/db');

/**
 * CaseAuditLog model — append-only state change log for the case-centered
 * architecture. Records every state change across all case-related tables.
 * Never deleted or updated. Separate from the legacy profile AuditLog.
 */
const CaseAuditLog = {
  async log({ tableName, recordId, action, staffId, userId, oldValue, newValue, ipAddress }) {
    try {
      await db.query(
        `INSERT INTO audit_log (table_name, record_id, action, changed_by_staff_id, changed_by_user_id, old_value, new_value, ip_address)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          tableName,
          String(recordId),
          action,
          staffId || null,
          userId || null,
          oldValue ? JSON.stringify(oldValue) : null,
          newValue ? JSON.stringify(newValue) : null,
          ipAddress || null,
        ]
      );
    } catch (err) {
      // Audit logging must never break the caller's operation
      console.error('CaseAuditLog.log failed:', err.message);
    }
  },

  async findByRecord(tableName, recordId) {
    const result = await db.query(
      `SELECT * FROM audit_log
       WHERE table_name = $1 AND record_id = $2
       ORDER BY changed_at DESC`,
      [tableName, String(recordId)]
    );
    return result.rows;
  },

  /**
   * Get all audit entries related to a case across all tables.
   */
  async findByCaseId(caseId) {
    const result = await db.query(
      `SELECT * FROM audit_log
       WHERE record_id = $1
          OR record_id IN (
            SELECT CAST(id AS TEXT) FROM intake_forms WHERE case_id = $1
            UNION ALL SELECT CAST(id AS TEXT) FROM appointments WHERE case_id = $1
            UNION ALL SELECT CAST(id AS TEXT) FROM payments WHERE case_id = $1
            UNION ALL SELECT CAST(id AS TEXT) FROM psychological_reports WHERE case_id = $1
            UNION ALL SELECT CAST(assessment_id AS TEXT) FROM assessments WHERE case_id = $1
          )
       ORDER BY changed_at DESC`,
      [caseId]
    );
    return result.rows;
  },
};

module.exports = CaseAuditLog;
