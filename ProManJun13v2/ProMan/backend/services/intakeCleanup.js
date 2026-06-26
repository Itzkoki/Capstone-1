const db = require('../config/db');

/**
 * Intake persistence rule (Option A):
 * A client's intake form is only meant to PERSIST in the database once the
 * booking has been completed AND paid. The intake + appointment are stored at
 * submission so staff can review/approve them, but any booking that does not
 * reach a verified payment is treated as provisional and removed here.
 *
 * A booking is purged when it has NO verified / in-progress payment AND it is
 * either declined/cancelled, or its scheduled time has passed while still unpaid.
 * Bookings that are paid (verified) or have a payment in progress
 * (pending / under_review) are never touched.
 *
 * Foreign keys for intake_form_id / appointment_id are ON DELETE SET NULL, so
 * these deletes never violate referential integrity.
 */

// Remove a single unpaid booking (its non-verified payments, the appointment,
// and the intake form). No-op if a verified payment exists.
async function purgeAppointment(appointmentId) {
  if (!appointmentId) return false;
  const verified = await db.query(
    `SELECT 1 FROM payments WHERE appointment_id = $1 AND status = 'verified' LIMIT 1`,
    [appointmentId]
  );
  if (verified.rowCount) return false; // paid — keep it

  const appt = await db.query(`SELECT intake_form_id FROM appointments WHERE id = $1`, [appointmentId]);
  if (!appt.rowCount) return false;
  const intakeId = appt.rows[0].intake_form_id;

  await db.query(`DELETE FROM payments WHERE appointment_id = $1 AND status <> 'verified'`, [appointmentId]);
  await db.query(`DELETE FROM appointments WHERE id = $1`, [appointmentId]);
  if (intakeId) {
    // Only drop the intake form if no other appointment still references it.
    await db.query(
      `DELETE FROM intake_forms WHERE id = $1
         AND NOT EXISTS (SELECT 1 FROM appointments WHERE intake_form_id = $1)`,
      [intakeId]
    );
  }
  return true;
}

// Sweep all dead/unpaid bookings.
async function sweepUnpaidIntakes() {
  try {
    const { rows } = await db.query(`
      SELECT a.id AS appt_id
      FROM appointments a
      WHERE a.payment_status IS DISTINCT FROM 'paid_verified'
        AND a.status NOT IN ('confirmed')
        AND NOT EXISTS (
          SELECT 1 FROM payments p
          WHERE p.appointment_id = a.id
            AND p.status IN ('verified', 'under_review', 'pending')
        )
        AND (
          a.status IN ('declined', 'cancelled')
          OR COALESCE(a.approved_datetime, a.proposed_datetime, a.preferred_datetime)
               < NOW() - INTERVAL '6 hours'
        )
    `);
    let removed = 0;
    for (const r of rows) {
      if (await purgeAppointment(r.appt_id)) removed++;
    }
    return removed;
  } catch (err) {
    console.error('sweepUnpaidIntakes failed:', err.message);
    return 0;
  }
}

module.exports = { purgeAppointment, sweepUnpaidIntakes };
