const db = require('../config/db');

const Appointment = {
  /**
   * Create appointment from intake form submission.
   */
  async create({ intakeFormId, assessmentFormId, clientId, preferredDatetime, modality, pendingIntakeData }) {
    const result = await db.query(
      `INSERT INTO appointments (intake_form_id, assessment_form_id, client_id, preferred_datetime, modality, pending_intake_data)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [intakeFormId || null, assessmentFormId || null, clientId, preferredDatetime, modality || null,
       pendingIntakeData ? JSON.stringify(pendingIntakeData) : null]
    );
    return result.rows[0];
  },

  async findById(id) {
    const result = await db.query(
      `SELECT a.*,
              c.full_name AS client_name,  c.email AS client_email,
              s.full_name AS staff_name,   s.email AS staff_email
       FROM appointments a
       LEFT JOIN users c ON c.id = a.client_id
       LEFT JOIN users s ON s.id = a.staff_id
       WHERE a.id = $1`,
      [id]
    );
    return result.rows[0] || null;
  },

  async findByIntakeFormId(intakeFormId) {
    const result = await db.query(
      `SELECT * FROM appointments WHERE intake_form_id = $1`,
      [intakeFormId]
    );
    return result.rows[0] || null;
  },

  /**
   * List appointments for a client.
   */
  async findByClient(clientId, { status, limit = 20, offset = 0 } = {}) {
    let q = `SELECT a.*, s.full_name AS staff_name
             FROM appointments a
             LEFT JOIN users s ON s.id = a.staff_id
             WHERE a.client_id = $1`;
    const params = [clientId];
    let idx = 2;
    if (status) { q += ` AND a.status = $${idx++}`; params.push(status); }
    q += ` ORDER BY a.created_at DESC LIMIT $${idx++} OFFSET $${idx++}`;
    params.push(limit, offset);
    const result = await db.query(q, params);
    return result.rows;
  },

  /**
   * List all appointments (staff).
   */
  async findAll({ status, limit = 50, offset = 0 } = {}) {
    let q = `SELECT a.*,
                    c.full_name AS client_name, c.email AS client_email,
                    s.full_name AS staff_name
             FROM appointments a
             LEFT JOIN users c ON c.id = a.client_id
             LEFT JOIN users s ON s.id = a.staff_id
             WHERE 1=1`;
    const params = [];
    let idx = 1;
    if (status) { q += ` AND a.status = $${idx++}`; params.push(status); }
    q += ` ORDER BY a.created_at DESC LIMIT $${idx++} OFFSET $${idx++}`;
    params.push(limit, offset);
    const result = await db.query(q, params);
    return result.rows;
  },

  /**
   * Check for conflicting appointments at a given datetime (±1 hour window).
   * Returns array of conflicting appointments.
   */
  async checkConflict(datetime, excludeId = null) {
    let q = `SELECT a.*, c.full_name AS client_name, s.full_name AS staff_name
             FROM appointments a
             LEFT JOIN users c ON c.id = a.client_id
             LEFT JOIN users s ON s.id = a.staff_id
             WHERE a.status IN ('approved', 'confirmed')
               AND ABS(EXTRACT(EPOCH FROM (a.approved_datetime - $1::timestamp))) < 3600`;
    const params = [datetime];
    let idx = 2;
    if (excludeId) {
      q += ` AND a.id != $${idx++}`;
      params.push(excludeId);
    }
    const result = await db.query(q, params);
    return result.rows;
  },

  /**
   * Staff approves the preferred datetime.
   */
  async approve(id, staffId) {
    const appt = await this.findById(id);
    if (!appt) return null;
    const result = await db.query(
      `UPDATE appointments
       SET status = 'approved',
           approved_datetime = preferred_datetime,
           staff_id = $1,
           updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [staffId, id]
    );
    return result.rows[0] || null;
  },

  /**
   * Staff proposes a new schedule.
   */
  async proposeReschedule(id, staffId, proposedDatetime, staffNotes) {
    const result = await db.query(
      `UPDATE appointments
       SET status = 'reschedule_proposed',
           proposed_datetime = $1,
           staff_id = $2,
           staff_notes = $3,
           updated_at = NOW()
       WHERE id = $4
       RETURNING *`,
      [proposedDatetime, staffId, staffNotes || null, id]
    );
    return result.rows[0] || null;
  },

  /**
   * Client confirms the proposed/approved schedule.
   */
  async clientConfirm(id) {
    const appt = await this.findById(id);
    if (!appt) return null;
    // Use proposed_datetime if exists, otherwise approved_datetime
    const finalDt = appt.proposed_datetime || appt.approved_datetime;
    const result = await db.query(
      `UPDATE appointments
       SET status = 'confirmed',
           approved_datetime = $1,
           updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [finalDt, id]
    );
    return result.rows[0] || null;
  },

  /**
   * Client declines.
   */
  async clientDecline(id, notes) {
    const result = await db.query(
      `UPDATE appointments
       SET status = 'declined',
           client_response_notes = $1,
           updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [notes || null, id]
    );
    return result.rows[0] || null;
  },

  /**
   * Client requests a schedule change with a new proposed datetime.
   */
  async clientRequestChange(id, newDatetime, notes) {
    const result = await db.query(
      `UPDATE appointments
       SET status = 'pending_review',
           preferred_datetime = $1,
           proposed_datetime = NULL,
           approved_datetime = NULL,
           client_response_notes = $2,
           updated_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [newDatetime, notes || null, id]
    );
    return result.rows[0] || null;
  },

  /**
   * Count appointments occupying a specific date.
   *
   * A slot is only considered taken once the client has SUCCESSFULLY PAID
   * (payment_status = 'paid_verified'). Unpaid appointments — even confirmed
   * ones still awaiting payment — do not reserve the slot.
   */
  async countByDate(dateStr) {
    const result = await db.query(
      `SELECT COUNT(*)::int AS count
       FROM appointments
       WHERE status NOT IN ('declined', 'cancelled')
         AND payment_status = 'paid_verified'
         AND (
           DATE(preferred_datetime) = $1::date
           OR DATE(approved_datetime) = $1::date
           OR DATE(proposed_datetime) = $1::date
         )`,
      [dateStr]
    );
    return result.rows[0].count;
  },

  /**
   * Get booked time slots (HH:MM) for a specific date.
   * Returns array of time strings like ['09:00', '10:00', '13:00'].
   *
   * Only slots belonging to a successfully paid (paid_verified) appointment
   * are returned, so a slot is freed for everyone until someone pays for it.
   */
  async getBookedSlots(dateStr) {
    const result = await db.query(
      `SELECT
         COALESCE(approved_datetime, proposed_datetime, preferred_datetime) AS booked_dt
       FROM appointments
       WHERE status NOT IN ('declined', 'cancelled')
         AND payment_status = 'paid_verified'
         AND (
           DATE(preferred_datetime) = $1::date
           OR DATE(approved_datetime) = $1::date
           OR DATE(proposed_datetime) = $1::date
         )`,
      [dateStr]
    );
    return result.rows.map(r => {
      const d = new Date(r.booked_dt);
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    });
  },

  /**
   * Cancel an appointment — frees the slot for other clients.
   */
  async cancel(id) {
    const result = await db.query(
      `UPDATE appointments
       SET status = 'cancelled',
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id]
    );
    return result.rows[0] || null;
  },

  /**
   * Edit an appointment's preferred datetime (client reschedule).
   * Resets status to pending_review for staff re-approval.
   */
  async editSchedule(id, newDatetime) {
    const result = await db.query(
      `UPDATE appointments
       SET preferred_datetime = $1,
           approved_datetime = NULL,
           proposed_datetime = NULL,
           status = 'pending_review',
           updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [newDatetime, id]
    );
    return result.rows[0] || null;
  },

  /**
   * Count by status.
   */
  async countByStatus() {
    const result = await db.query(
      `SELECT status, COUNT(*)::int AS count FROM appointments GROUP BY status`
    );
    const counts = {};
    result.rows.forEach(r => { counts[r.status] = r.count; });
    return counts;
  },
};

module.exports = Appointment;
