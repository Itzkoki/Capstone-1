const db = require('../config/db');

/**
 * ClinicalAssessment model — tracks assessment start/completion per case.
 * Named ClinicalAssessment to avoid conflict with the existing assessment_intake_forms.
 */
const ClinicalAssessment = {
  async create({ caseId, psychologistId }) {
    const result = await db.query(
      `INSERT INTO assessments (case_id, psychologist_id, started_at)
       VALUES ($1, $2, NOW())
       RETURNING *`,
      [caseId, psychologistId]
    );
    return result.rows[0];
  },

  async complete(assessmentId) {
    const result = await db.query(
      `UPDATE assessments SET completed_at = NOW() WHERE assessment_id = $1 RETURNING *`,
      [assessmentId]
    );
    return result.rows[0] || null;
  },

  async addRemarks(assessmentId, remarks) {
    const result = await db.query(
      `UPDATE assessments SET remarks = $1 WHERE assessment_id = $2 RETURNING *`,
      [remarks, assessmentId]
    );
    return result.rows[0] || null;
  },

  async findByCaseId(caseId) {
    const result = await db.query(
      `SELECT a.*,
              COALESCE(
                (SELECT CONCAT(s.first_name, ' ', s.last_name) FROM staff s WHERE s.staff_id = a.psychologist_id),
                'Unknown'
              ) AS psychologist_name
       FROM assessments a
       WHERE a.case_id = $1
       ORDER BY a.started_at DESC`,
      [caseId]
    );
    return result.rows;
  },

  async findById(assessmentId) {
    const result = await db.query(
      `SELECT * FROM assessments WHERE assessment_id = $1`,
      [assessmentId]
    );
    return result.rows[0] || null;
  },
};

module.exports = ClinicalAssessment;
