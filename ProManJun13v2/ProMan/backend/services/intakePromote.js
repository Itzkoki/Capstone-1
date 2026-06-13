const db = require('../config/db');

/**
 * Promote a booking's staged intake answers into the official intake_forms table.
 *
 * Per the clinic's rule, a client's intake form is ONLY stored in intake_forms
 * once staff have approved the schedule AND verified the payment. Until then the
 * answers live in appointments.pending_intake_data (a temporary review buffer).
 * This is called from payment verification; it is idempotent.
 *
 * Returns the intake_forms id (existing or newly created), or null.
 */
async function promoteIntakeForAppointment(appointmentId) {
  if (!appointmentId) return null;

  const apptRes = await db.query(
    `SELECT id, client_id, intake_form_id, pending_intake_data
     FROM appointments WHERE id = $1`,
    [appointmentId]
  );
  if (!apptRes.rowCount) return null;
  const appt = apptRes.rows[0];

  // Already promoted — nothing to do.
  if (appt.intake_form_id) return appt.intake_form_id;
  if (!appt.pending_intake_data) return null;

  const f = typeof appt.pending_intake_data === 'string'
    ? JSON.parse(appt.pending_intake_data)
    : appt.pending_intake_data;

  const result = await db.query(
    `INSERT INTO intake_forms (
      user_id, full_name, nickname, age, date_of_birth, gender, civil_status,
      address, cellphone, home_phone, email,
      concern_description, reason_for_counseling, since_when, how_long,
      therapy_before, medication_history,
      preferred_schedule, language_preference, session_modality, counselor_gender_pref,
      is_minor, guardian_name, guardian_contact, guardian_relation, minor_other_reason,
      emergency_name, emergency_address, emergency_contact, emergency_email, emergency_relation,
      data_privacy_consent
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7, $8,$9,$10,$11, $12,$13,$14,$15, $16,$17,
      $18,$19,$20,$21, $22,$23,$24,$25,$26, $27,$28,$29,$30,$31, $32
    ) RETURNING id`,
    [
      appt.client_id, f.fullName || null, f.nickName || null, f.age ? parseInt(f.age) : null, f.dob || null,
      f.gender || null, f.civilStatus || null, f.address || null, f.cellphone || null, f.homePhone || null,
      f.email || null, f.concernDesc || null, f.reasonCounseling || null, f.sinceWhen || null, f.howLong || null,
      f.therapyBefore || null, f.medicationHistory || null, f.prefSchedule || null, f.language || null,
      f.modality || null, f.counselorGender || null, f.isMinor || null, f.guardianName || null,
      f.guardianContact || null, f.guardianRelation || null, f.minorOtherReason || null, f.emerName || null,
      f.emerAddress || null, f.emerContact || null, f.emerEmail || null, f.emerRelation || null,
      f.dataPrivacyConsent === true || f.dataPrivacyConsent === 'true' || f.dataPrivacyConsent === 1,
    ]
  );
  const intakeId = result.rows[0].id;

  // Link the appointment to the now-official intake form and clear the buffer.
  await db.query(
    `UPDATE appointments SET intake_form_id = $1, pending_intake_data = NULL WHERE id = $2`,
    [intakeId, appointmentId]
  );
  return intakeId;
}

module.exports = { promoteIntakeForAppointment };
