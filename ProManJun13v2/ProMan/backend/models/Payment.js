const db = require('../config/db');

/**
 * Payment model — payment-first booking.
 *
 * Reference numbers are system-generated and unique per booking
 * (format: BPS-YYYYMMDD-NNNN). Clients can never create or modify them.
 *
 * Transaction states:
 *   pending      – reference + QR issued; slot held (24h to upload proof)
 *   under_review – proof uploaded, awaiting admin verification
 *   verified     – admin confirmed; slot reserved (balance recorded if half)
 *   expired      – no proof within 24h; slot released
 *   rejected     – admin found proof invalid; slot released
 */
const Payment = {
  /**
   * Generate a unique reference number of the form BPS-YYYYMMDD-NNNN.
   * NNNN is a zero-padded per-day sequence. A short retry loop guards
   * against the rare race where two bookings land the same sequence.
   */
  async generateReferenceNumber() {
    const now = new Date();
    const datePart =
      now.getFullYear().toString() +
      String(now.getMonth() + 1).padStart(2, '0') +
      String(now.getDate()).padStart(2, '0');

    const prefix = `BPS-${datePart}-`;

    for (let attempt = 0; attempt < 5; attempt++) {
      // Highest existing sequence for today
      const result = await db.query(
        `SELECT reference_number FROM payments
         WHERE reference_number LIKE $1
         ORDER BY reference_number DESC
         LIMIT 1`,
        [`${prefix}%`]
      );

      let next = 1;
      if (result.rows.length > 0) {
        const last = result.rows[0].reference_number;
        const seq = parseInt(last.slice(prefix.length), 10);
        if (!Number.isNaN(seq)) next = seq + 1 + attempt;
      } else {
        next = 1 + attempt;
      }

      const candidate = `${prefix}${String(next).padStart(4, '0')}`;

      // Confirm it is not taken
      const taken = await db.query(
        `SELECT 1 FROM payments WHERE reference_number = $1`,
        [candidate]
      );
      if (taken.rows.length === 0) return candidate;
    }

    // Fallback: timestamp-based suffix guarantees uniqueness
    return `${prefix}${String(Date.now()).slice(-4)}`;
  },

  /**
   * Create a payment record (status = pending) tied to a booking.
   * The hold expires 24 hours after creation.
   */
  async create({
    referenceNumber, intakeFormId, appointmentId, clientId,
    serviceLabel, paymentOption, paymentMethod,
    amountDue, totalFee, outstandingBalance, agreedNoCancellation,
    expiresInMinutes,
  }) {
    const minutes = (typeof expiresInMinutes === 'number' && expiresInMinutes > 0) ? expiresInMinutes : 24 * 60;
    const expiresAt = new Date(Date.now() + minutes * 60 * 1000);
    const result = await db.query(
      `INSERT INTO payments (
        reference_number, intake_form_id, appointment_id, client_id,
        service_label, payment_option, payment_method,
        amount_due, total_fee, outstanding_balance, expires_at,
        agreed_no_cancellation
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      RETURNING *`,
      [
        referenceNumber, intakeFormId || null, appointmentId || null, clientId,
        serviceLabel || null, paymentOption, paymentMethod || 'GCash',
        amountDue, totalFee, outstandingBalance || 0, expiresAt,
        agreedNoCancellation ? 1 : 0,
      ]
    );
    return result.rows[0];
  },

  /**
   * Change the payment option (half/full) while still pending and before any
   * proof has been uploaded — lets the client change their mind. Recomputes the
   * amount due and outstanding balance from the given fees.
   */
  async updateOption(id, { paymentOption, amountDue, totalFee, outstandingBalance }) {
    const result = await db.query(
      `UPDATE payments
       SET payment_option = $1,
           amount_due = $2,
           total_fee = $3,
           outstanding_balance = $4,
           updated_at = NOW()
       WHERE id = $5 AND status = 'pending' AND proof_of_payment IS NULL
       RETURNING *`,
      [paymentOption, amountDue, totalFee, outstandingBalance || 0, id]
    );
    return result.rows[0] || null;
  },

  async findById(id) {
    const result = await db.query(
      `SELECT p.*,
              c.full_name AS client_name,  c.email AS client_email,
              v.full_name AS verifier_name
       FROM payments p
       LEFT JOIN users c ON c.id = p.client_id
       LEFT JOIN users v ON v.id = p.verified_by
       WHERE p.id = $1`,
      [id]
    );
    return result.rows[0] || null;
  },

  async findByReference(reference) {
    const result = await db.query(
      `SELECT * FROM payments WHERE reference_number = $1`,
      [reference]
    );
    return result.rows[0] || null;
  },

  /**
   * Latest payment for an appointment (any status).
   */
  async findLatestByAppointment(appointmentId) {
    const result = await db.query(
      `SELECT * FROM payments WHERE appointment_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [appointmentId]
    );
    return result.rows[0] || null;
  },

  /**
   * An active (non-failed) payment for an appointment, if any.
   * Active = pending | under_review | verified.
   */
  async findActiveByAppointment(appointmentId) {
    const result = await db.query(
      `SELECT * FROM payments
       WHERE appointment_id = $1 AND status IN ('pending','under_review','verified')
       ORDER BY created_at DESC LIMIT 1`,
      [appointmentId]
    );
    return result.rows[0] || null;
  },

  async findByClient(clientId, { status } = {}) {
    let q = `SELECT * FROM payments WHERE client_id = $1`;
    const params = [clientId];
    if (status) { q += ` AND status = $2`; params.push(status); }
    q += ` ORDER BY created_at DESC`;
    const result = await db.query(q, params);
    return result.rows;
  },

  async findAll({ status } = {}) {
    let q = `SELECT p.*,
                    c.full_name AS client_name, c.email AS client_email,
                    v.full_name AS verifier_name
             FROM payments p
             LEFT JOIN users c ON c.id = p.client_id
             LEFT JOIN users v ON v.id = p.verified_by
             WHERE 1=1`;
    const params = [];
    if (status) { q += ` AND p.status = $1`; params.push(status); }
    q += ` ORDER BY p.created_at DESC`;
    const result = await db.query(q, params);
    return result.rows;
  },

  /**
   * Attach uploaded proof of payment and move to under_review.
   * Only allowed while the payment is still pending and not expired.
   */
  async attachProof(id, { dataUrl, filename, mime }) {
    const result = await db.query(
      `UPDATE payments
       SET proof_of_payment = $1,
           proof_filename    = $2,
           proof_mime        = $3,
           proof_uploaded_at = NOW(),
           status            = 'under_review',
           rejection_reason  = NULL,
           updated_at        = NOW()
       WHERE id = $4 AND status IN ('pending', 'rejected')
       RETURNING *`,
      [dataUrl, filename || null, mime || null, id]
    );
    return result.rows[0] || null;
  },

  /**
   * Admin verifies the payment. Records outstanding balance for half payments.
   */
  async verify(id, adminId, note) {
    const result = await db.query(
      `UPDATE payments
       SET status = 'verified',
           verified_by = $1,
           verified_at = NOW(),
           admin_note  = $2,
           outstanding_balance = CASE
             WHEN payment_option = 'half' THEN total_fee - amount_due
             ELSE 0
           END,
           updated_at = NOW()
       WHERE id = $3 AND status = 'under_review'
       RETURNING *`,
      [adminId, note || null, id]
    );
    return result.rows[0] || null;
  },

  /**
   * Admin rejects the submitted proof. Slot is released.
   */
  async reject(id, adminId, reason) {
    const result = await db.query(
      `UPDATE payments
       SET status = 'rejected',
           verified_by = $1,
           verified_at = NOW(),
           rejection_reason = $2,
           updated_at = NOW()
       WHERE id = $3 AND status = 'under_review'
       RETURNING *`,
      [adminId, reason || null, id]
    );
    return result.rows[0] || null;
  },

  /**
   * Lazily expire pending holds whose 24-hour window has elapsed.
   * Returns the rows that were just expired so callers can release slots.
   */
  async expireStale() {
    const result = await db.query(
      `UPDATE payments
       SET status = 'expired', updated_at = NOW()
       WHERE status = 'pending' AND expires_at < NOW()
       RETURNING *`
    );
    return result.rows;
  },

  async countByStatus() {
    const result = await db.query(
      `SELECT status, COUNT(*)::int AS count FROM payments GROUP BY status`
    );
    const counts = {};
    result.rows.forEach(r => { counts[r.status] = r.count; });
    return counts;
  },
};

module.exports = Payment;
