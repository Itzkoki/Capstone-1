const db = require('../config/db');

/**
 * Case model — central clinical workflow entity.
 * Every clinical process revolves around a Case ID (CASE-YYYY-NNNNN).
 */
const Case = {
  /**
   * Generate the next Case ID in CASE-YYYY-NNNNN format.
   * Year-scoped, zero-padded sequence, never reused.
   */
  async generateCaseId() {
    const year = new Date().getFullYear();
    const prefix = `CASE-${year}-`;
    const result = await db.query(
      `SELECT case_id FROM cases WHERE case_id LIKE $1 ORDER BY case_id DESC LIMIT 1`,
      [prefix + '%']
    );
    let seq = 1;
    if (result.rows.length > 0) {
      const last = result.rows[0].case_id;
      seq = parseInt(last.split('-').pop(), 10) + 1;
    }
    return `${prefix}${String(seq).padStart(5, '0')}`;
  },

  /**
   * Create a new case.
   * Called atomically during intake submission.
   */
  async create({ userId, assignedPsychologistId, intakeDate, serviceType = 'counseling' }) {
    const caseId = await this.generateCaseId();

    // Check resubmission count from prior rejected cases
    const priorResult = await db.query(
      `SELECT resubmission_count FROM cases
       WHERE user_id = $1 AND status = 'Intake Rejected'
       ORDER BY created_at DESC LIMIT 1`,
      [userId]
    );
    const resubCount = priorResult.rows.length > 0
      ? priorResult.rows[0].resubmission_count + 1
      : 0;

    const result = await db.query(
      `INSERT INTO cases (case_id, user_id, assigned_psychologist_id, intake_date, status, resubmission_count, service_type)
       VALUES ($1, $2, $3, $4, 'Pending Intake Review', $5, $6)
       RETURNING *`,
      [caseId, userId, assignedPsychologistId || null, intakeDate || new Date(), resubCount, serviceType]
    );
    return result.rows[0];
  },

  /**
   * Find a case by its ID, with joined user and psychologist names.
   */
  async findById(caseId) {
    const result = await db.query(
      `SELECT c.*,
              u.full_name AS client_name,
              u.email AS client_email,
              u.user_code AS client_user_code,
              COALESCE(
                (SELECT CONCAT(s.first_name, ' ', s.last_name) FROM staff s WHERE s.staff_id = c.assigned_psychologist_id),
                'Unassigned'
              ) AS psychologist_name
       FROM cases c
       JOIN users u ON u.id = c.user_id
       WHERE c.case_id = $1 AND c.archived_at IS NULL`,
      [caseId]
    );
    return result.rows[0] || null;
  },

  /**
   * Find all cases for a given client.
   */
  async findByUserId(userId) {
    const result = await db.query(
      `SELECT c.*,
              COALESCE(
                (SELECT CONCAT(s.first_name, ' ', s.last_name) FROM staff s WHERE s.staff_id = c.assigned_psychologist_id),
                'Unassigned'
              ) AS psychologist_name
       FROM cases c
       WHERE c.user_id = $1
       ORDER BY c.created_at DESC`,
      [userId]
    );
    return result.rows;
  },

  /**
   * Find all cases, with optional filters.
   */
  async findAll({ status, psychologistId, userId, limit = 50, offset = 0 } = {}) {
    let query = `
      SELECT c.*,
             u.full_name AS client_name,
             u.email AS client_email,
             u.user_code AS client_user_code,
             COALESCE(
               (SELECT CONCAT(s.first_name, ' ', s.last_name) FROM staff s WHERE s.staff_id = c.assigned_psychologist_id),
               'Unassigned'
             ) AS psychologist_name
      FROM cases c
      JOIN users u ON u.id = c.user_id
      WHERE 1=1 AND c.archived_at IS NULL
    `;
    const params = [];
    let idx = 1;

    if (status) {
      query += ` AND c.status = $${idx++}`;
      params.push(status);
    }
    if (psychologistId) {
      query += ` AND c.assigned_psychologist_id = $${idx++}`;
      params.push(psychologistId);
    }
    if (userId) {
      query += ` AND c.user_id = $${idx++}`;
      params.push(userId);
    }

    query += ` ORDER BY c.created_at DESC LIMIT $${idx++} OFFSET $${idx++}`;
    params.push(limit, offset);

    const result = await db.query(query, params);
    return result.rows;
  },

  /**
   * Find all archived cases (archived_at IS NOT NULL), newest first.
   */
  async findAllArchived() {
    const result = await db.query(
      `SELECT c.*,
              u.full_name      AS client_name,
              u.email          AS client_email,
              u.user_code      AS client_user_code,
              COALESCE(
                (SELECT CONCAT(s.first_name, ' ', s.last_name) FROM staff s WHERE s.staff_id = c.assigned_psychologist_id),
                'Unassigned'
              ) AS psychologist_name
       FROM cases c
       JOIN users u ON u.id = c.user_id
       WHERE c.archived_at IS NOT NULL
       ORDER BY c.archived_at DESC`
    );
    return result.rows;
  },

  /**
   * Count cases with optional filters.
   */
  async count({ status, psychologistId, userId } = {}) {
    let query = `SELECT COUNT(*)::int AS count FROM cases WHERE 1=1`;
    const params = [];
    let idx = 1;
    if (status) { query += ` AND status = $${idx++}`; params.push(status); }
    if (psychologistId) { query += ` AND assigned_psychologist_id = $${idx++}`; params.push(psychologistId); }
    if (userId) { query += ` AND user_id = $${idx++}`; params.push(userId); }
    const result = await db.query(query, params);
    return result.rows[0].count;
  },

  /**
   * Valid status transitions. Each key is the current status, value is an
   * array of statuses it may transition to.
   */
  TRANSITIONS: {
    'Pending Intake Review':             ['Awaiting Initial Payment', 'Intake Rejected'],
    'Intake Rejected':                   [],  // terminal
    'Awaiting Initial Payment':          ['Awaiting Appointment', 'Scheduled'],  // Scheduled when appointment already confirmed before payment
    'Awaiting Appointment':              ['Scheduled'],
    'Scheduled':                         ['Assessment In Progress', 'Awaiting Appointment'],  // no-show reverts
    'Assessment In Progress':            ['Assessment Completed'],
    'Assessment Completed':              ['Report Drafting', 'Closed'],
    'Report Drafting':                   ['Awaiting Director Approval'],
    'Awaiting Director Approval':        ['Report Approved', 'Report Drafting'],  // reject loops back
    'Report Approved':                   ['Awaiting Report Request Approval', 'Ready for Release', 'Released'],
    'Awaiting Report Request Approval':  ['Awaiting Report Request Payment', 'Report Approved'],  // reject returns
    'Awaiting Report Request Payment':   ['Ready for Release'],  // stays on rejection
    'Ready for Release':                 ['Released'],
    'Released':                          ['Closed'],
    'Closed':                            [],  // terminal
  },

  /**
   * Update case status with transition validation and audit logging.
   */
  async updateStatus(caseId, newStatus, { staffId, userId, ipAddress } = {}) {
    const current = await this.findById(caseId);
    if (!current) throw new Error('Case not found');

    // Already at target — no-op, no error, no audit log needed.
    if (current.status === newStatus) return { ...current };

    const allowed = this.TRANSITIONS[current.status];
    if (!allowed || !allowed.includes(newStatus)) {
      throw new Error(`Invalid transition: ${current.status} → ${newStatus}`);
    }

    await db.query(
      `UPDATE cases SET status = $1, updated_at = NOW() WHERE case_id = $2`,
      [newStatus, caseId]
    );

    // Audit log
    const AuditLog = require('./CaseAuditLog');
    await AuditLog.log({
      tableName: 'cases',
      recordId: caseId,
      action: 'UPDATE',
      staffId: staffId || null,
      userId: userId || null,
      oldValue: { status: current.status },
      newValue: { status: newStatus },
      ipAddress,
    });

    // The moment a case becomes Scheduled, notify the assigned Psychologist
    // directly that a case has been assigned to them. "View Details" deep-links
    // to this exact case in Case Management. Centralised here so EVERY path that
    // schedules a case (appointment confirmation, payment verify, manual
    // transition, etc.) fires the notice exactly once.
    if (newStatus === 'Scheduled' && current.assigned_psychologist_id) {
      try {
        const notificationService = require('../services/notificationService');
        const clientName = current.client_name || 'a client';
        await notificationService.notifyUser(
          current.assigned_psychologist_id,
          'appointment',
          'New Case Assigned to You',
          `Case ${caseId} (${clientName}) has been assigned to you and is now scheduled. Click View Details to open it in Case Management.`,
          `case-dashboard.html?case=${encodeURIComponent(caseId)}`
        );
      } catch (e) { console.warn('Scheduled-case notification failed:', e.message); }
    }

    return { ...current, status: newStatus };
  },

  /**
   * Close a case (terminal state).
   */
  async close(caseId, staffId, ipAddress) {
    return this.updateStatus(caseId, 'Closed', { staffId, ipAddress });
  },

  /**
   * Reassign the psychologist on a case.
   */
  async reassignPsychologist(caseId, newPsychologistId, staffId, ipAddress) {
    const current = await this.findById(caseId);
    if (!current) throw new Error('Case not found');

    await db.query(
      `UPDATE cases SET assigned_psychologist_id = $1, updated_at = NOW() WHERE case_id = $2`,
      [newPsychologistId, caseId]
    );

    const AuditLog = require('./CaseAuditLog');
    await AuditLog.log({
      tableName: 'cases',
      recordId: caseId,
      action: 'UPDATE',
      staffId,
      oldValue: { assigned_psychologist_id: current.assigned_psychologist_id },
      newValue: { assigned_psychologist_id: newPsychologistId },
      ipAddress,
    });
  },

  /**
   * Check if a client has an active case (blocks new intake).
   * Active = any status other than 'Intake Rejected', 'Released', 'Closed'.
   */
  async hasActiveCase(userId) {
    const result = await db.query(
      `SELECT case_id FROM cases
       WHERE user_id = $1
         AND status NOT IN ('Intake Rejected', 'Released', 'Closed')
       LIMIT 1`,
      [userId]
    );
    return result.rows.length > 0 ? result.rows[0].case_id : null;
  },
};

module.exports = Case;
