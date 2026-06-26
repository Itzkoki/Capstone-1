const Appointment = require('../models/Appointment');
const Notification = require('../models/Notification');
const notificationService = require('../services/notificationService');
const User = require('../models/User');
const { purgeAppointment, sweepUnpaidIntakes } = require('../services/intakeCleanup');

const isStaff = (role) => role && role !== 'client';

// ── GET /api/appointments — list ──
const getAppointments = async (req, res, next) => {
  try {
    const { status, limit = 50, offset = 0 } = req.query;
    // Provisional bookings that won't reach a verified payment are cleared out.
    await sweepUnpaidIntakes();
    let data;
    if (isStaff(req.user.role)) {
      data = await Appointment.findAll({ status, limit: parseInt(limit), offset: parseInt(offset) });
    } else {
      data = await Appointment.findByClient(req.user.id, { status, limit: parseInt(limit), offset: parseInt(offset) });
    }
    return res.json({ success: true, data });
  } catch (error) { next(error); }
};

// ── GET /api/appointments/counts — status counts ──
const getStatusCounts = async (req, res, next) => {
  try {
    const counts = await Appointment.countByStatus();
    return res.json({ success: true, data: counts });
  } catch (error) { next(error); }
};

// ── GET /api/appointments/:id — detail ──
const getAppointment = async (req, res, next) => {
  try {
    const appt = await Appointment.findById(req.params.id);
    if (!appt) return res.status(404).json({ success: false, message: 'Appointment not found.' });

    if (!isStaff(req.user.role) && String(appt.client_id) !== String(req.user.id)) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }

    return res.json({ success: true, data: appt });
  } catch (error) { next(error); }
};

// ── GET /api/appointments/:id/intake-preview — return the intake form data for this appointment ──
const getIntakePreview = async (req, res, next) => {
  try {
    const appt = await Appointment.findById(req.params.id);
    if (!appt) return res.status(404).json({ success: false, message: 'Appointment not found.' });
    if (!isStaff(req.user.role) && String(appt.client_id) !== String(req.user.id)) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }

    const db = require('../config/db');

    // Assessment form — stored in individual columns (no form_data JSON column)
    if (appt.assessment_form_id) {
      const r = await db.query(
        `SELECT * FROM assessment_intake_forms WHERE id = $1`,
        [appt.assessment_form_id]
      );
      if (r.rows.length) {
        const row = r.rows[0];
        const form_data = {
          formType: 'assessment',
          familyName: row.family_name,
          givenName: row.given_name,
          middleName: row.middle_name,
          nickname: row.nickname,
          birthdate: row.birthdate,
          age: row.age,
          sex: row.sex,
          contactNumber: row.contact_number,
          email: row.email,
          homeAddress: row.home_address,
          primaryLanguage: row.primary_language,
          reasonForReferral: row.reason_for_referral,
          assessedBefore: row.assessed_before,
          assessedBeforeDetails: row.assessed_before_details,
          existingDiagnoses: row.existing_diagnoses,
          existingDiagnosesDetails: row.existing_diagnoses_details,
          interventions: row.current_interventions,
          interventionOther: row.intervention_other,
          answeringFor: row.answering_for,
          prefSchedule: row.preferred_schedule,
          modality: row.session_modality,
        };
        return res.json({ success: true, form_type: 'assessment', id: row.id, form_data, created_at: row.created_at });
      }
    }

    // Counseling — promoted to intake_forms after payment, otherwise still in pending_intake_data
    if (appt.intake_form_id) {
      const r = await db.query(
        `SELECT id, form_data, created_at FROM intake_forms WHERE id = $1`,
        [appt.intake_form_id]
      );
      if (r.rows.length) {
        const row = r.rows[0];
        const fd = typeof row.form_data === 'string' ? JSON.parse(row.form_data) : row.form_data;
        return res.json({ success: true, form_type: 'counseling', id: row.id, form_data: fd, created_at: row.created_at });
      }
    }

    if (appt.pending_intake_data) {
      const fd = typeof appt.pending_intake_data === 'string'
        ? JSON.parse(appt.pending_intake_data)
        : appt.pending_intake_data;
      return res.json({ success: true, form_type: 'counseling', id: null, form_data: fd, created_at: appt.created_at });
    }

    return res.status(404).json({ success: false, message: 'No intake data found for this appointment.' });
  } catch (error) { next(error); }
};

// ── GET /api/appointments/check-conflicts?datetime=... ──
const checkConflicts = async (req, res, next) => {
  try {
    const { datetime } = req.query;
    if (!datetime) return res.status(400).json({ success: false, message: 'datetime is required.' });

    const conflicts = await Appointment.checkConflict(datetime);
    return res.json({
      success: true,
      hasConflict: conflicts.length > 0,
      conflicts,
    });
  } catch (error) { next(error); }
};

// ── PUT /api/appointments/:id/approve — Supervising Psychometrician confirms appointment ──
// The SupPsy reviews the appointment, verifies the assessment type, and confirms.
// Neurodevelopmental assessments are automatically locked to Face-to-Face modality.
// Appointment status goes directly to 'confirmed', making payment available.
const approveSchedule = async (req, res, next) => {
  try {
    const appt = await Appointment.findById(req.params.id);
    if (!appt) return res.status(404).json({ success: false, message: 'Appointment not found.' });

    if (!['pending_review'].includes(appt.status)) {
      return res.status(400).json({ success: false, message: `Cannot confirm from status "${appt.status}".` });
    }

    const { assessment_type, modality } = req.body;

    // Counseling appointments have intake_form_id set (or pending_intake_data without assessment_form_id)
    const isCounseling = !!appt.intake_form_id || (!appt.assessment_form_id && !!appt.pending_intake_data);

    if (!isCounseling && !assessment_type) {
      return res.status(400).json({ success: false, message: 'assessment_type is required when confirming an assessment appointment.' });
    }

    // Counseling appointments have no assessment type — leave the column NULL
    const effectiveType = isCounseling ? null : assessment_type;
    const isNeuro = !isCounseling && assessment_type && assessment_type.toLowerCase() === 'neurodevelopmental';

    // Neurodevelopmental assessments must be Face-to-Face
    if (isNeuro && modality && modality.toLowerCase() !== 'face-to-face') {
      return res.status(400).json({
        success: false,
        message: 'Neurodevelopmental assessments must be conducted Face-to-Face. Online modality is not permitted.',
      });
    }

    // Check for conflicts
    const conflicts = await Appointment.checkConflict(appt.preferred_datetime, appt.id);
    if (conflicts.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'Schedule conflict detected. Another appointment is already booked within 1 hour of this time.',
        conflicts,
      });
    }

    const updated = await Appointment.approve(appt.id, req.user.id, effectiveType);

    const modalityNote = isNeuro
      ? ' This is a Neurodevelopmental assessment and will be conducted Face-to-Face.'
      : '';

    // Notify client — appointment is confirmed, proceed to payment
    try {
      await notificationService.notifyUser(
        appt.client_id, 'appointment',
        'Appointment Confirmed — Complete Payment',
        `Your appointment has been confirmed for ${new Date(updated.approved_datetime).toLocaleString('en-PH')}.${modalityNote} Please proceed to payment to reserve your slot.`,
        `payment.html?appt=${appt.id}`
      );
    } catch (e) { console.error('Confirm notification failed:', e.message); }

    // Notify other staff
    try {
      await notificationService.notifyRoles(
        ['psychometrician', 'clinical_director'],
        'appointment',
        'Appointment Confirmed',
        `Appointment #${appt.id} has been confirmed by the Supervising Psychometrician.${effectiveType ? ' Assessment type: ' + effectiveType : ''}`,
        `notifications.html?appt=${appt.id}`
      );
    } catch (e) {}
    // NOTE: the chosen Psychologist is notified of the scheduled appointment only
    // AFTER the Supervising Psychometrician verifies payment — see
    // paymentController.verifyPayment (approve path). Not here at confirmation.

    return res.json({ success: true, message: 'Appointment confirmed. Client may now proceed to payment.', data: updated });
  } catch (error) { next(error); }
};

// ── PUT /api/appointments/:id/propose-reschedule — staff proposes new time ──
const proposeReschedule = async (req, res, next) => {
  try {
    const { proposed_datetime, staff_notes } = req.body;
    if (!proposed_datetime) {
      return res.status(400).json({ success: false, message: 'proposed_datetime is required.' });
    }
    if (!staff_notes || !staff_notes.trim()) {
      return res.status(400).json({ success: false, message: 'A reason for the schedule change is required.' });
    }

    const proposedDt = new Date(proposed_datetime);
    if (proposedDt <= new Date()) {
      return res.status(400).json({ success: false, message: 'Proposed datetime must be in the future.' });
    }

    const appt = await Appointment.findById(req.params.id);
    if (!appt) return res.status(404).json({ success: false, message: 'Appointment not found.' });

    // Check daily limit on the proposed date
    const dateStr = proposed_datetime.split('T')[0] || new Date(proposed_datetime).toISOString().split('T')[0];
    const count = await Appointment.countByDate(dateStr);
    if (count >= MAX_PER_DAY) {
      return res.status(409).json({
        success: false,
        message: `This date is fully booked (${MAX_PER_DAY}/${MAX_PER_DAY} clients). Please choose another date.`,
      });
    }

    // Check if the proposed time slot is already booked
    const bookedSlots = await Appointment.getBookedSlots(dateStr);
    const proposedHour = `${String(proposedDt.getHours()).padStart(2, '0')}:${String(proposedDt.getMinutes()).padStart(2, '0')}`;
    if (bookedSlots.includes(proposedHour)) {
      return res.status(409).json({
        success: false,
        message: 'This time slot is already booked. Please choose another available time.',
      });
    }

    // Check for conflicts on the proposed datetime
    const conflicts = await Appointment.checkConflict(proposed_datetime, appt.id);
    if (conflicts.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'The proposed schedule conflicts with an existing appointment.',
        conflicts,
      });
    }

    const updated = await Appointment.proposeReschedule(appt.id, req.user.id, proposed_datetime, staff_notes);

    // Notify client
    try {
      const staffUser = await User.findById(req.user.id);
      const staffName = staffUser ? staffUser.full_name : 'Staff';
      await notificationService.notifyUser(
        appt.client_id, 'appointment',
        'New Schedule Proposed',
        `${staffName} has proposed a new schedule for your appointment: ${new Date(proposed_datetime).toLocaleString('en-PH')}. ${staff_notes ? 'Note: ' + staff_notes : ''} Please confirm or request a different time.`,
        `notifications.html?appt=${appt.id}`
      );
    } catch (e) { console.error('Reschedule notification failed:', e.message); }

    return res.json({ success: true, message: 'Reschedule proposed.', data: updated });
  } catch (error) { next(error); }
};

// ── PUT /api/appointments/:id/confirm — client confirms ──
const clientConfirm = async (req, res, next) => {
  try {
    const appt = await Appointment.findById(req.params.id);
    if (!appt) return res.status(404).json({ success: false, message: 'Appointment not found.' });

    if (appt.client_id !== req.user.id && !isStaff(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }

    if (!['reschedule_proposed'].includes(appt.status)) {
      return res.status(400).json({ success: false, message: `Cannot confirm from status "${appt.status}". The Supervising Psychometrician must confirm the appointment first.` });
    }

    const updated = await Appointment.clientConfirm(appt.id);

    // Notify SupPsy that the client confirmed the proposed schedule
    try {
      const clientUser = await User.findById(appt.client_id);
      const clientName = clientUser ? clientUser.full_name : 'Client';
      await notificationService.notifyRoles(
        ['supervising_psychometrician', 'clinical_director'],
        'appointment',
        'Client Confirmed Appointment Schedule',
        `${clientName} has confirmed their appointment for ${new Date(updated.approved_datetime).toLocaleString('en-PH')}.`,
        'case-dashboard.html'
      );
    } catch (e) {}

    // Auto-delete the schedule proposal notifications for this client
    try {
      await Notification.deleteByTypeAndTitle(appt.client_id, 'appointment', 'Schedule Proposed');
      await Notification.deleteByTypeAndTitle(appt.client_id, 'appointment', 'Appointment Approved');
    } catch (e) { console.error('Auto-delete notification failed:', e.message); }

    // Prompt the client to proceed to payment
    try {
      await notificationService.notifyUser(
        appt.client_id, 'appointment', 'Schedule Confirmed — Complete Payment',
        'Your appointment schedule is confirmed! Please proceed to payment to reserve your slot.',
        `payment.html?appt=${appt.id}`
      );
    } catch (e) { /* non-fatal */ }

    return res.json({ success: true, message: 'Appointment confirmed.', data: updated });
  } catch (error) { next(error); }
};

// ── PUT /api/appointments/:id/decline — client declines ──
const clientDecline = async (req, res, next) => {
  try {
    const { notes } = req.body;
    const appt = await Appointment.findById(req.params.id);
    if (!appt) return res.status(404).json({ success: false, message: 'Appointment not found.' });

    if (appt.client_id !== req.user.id && !isStaff(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }

    const updated = await Appointment.clientDecline(appt.id, notes);

    // Notify staff
    try {
      const clientUser = await User.findById(appt.client_id);
      const clientName = clientUser ? clientUser.full_name : 'Client';
      await notificationService.notifyRoles(
        ['psychometrician', 'clinical_director'],
        'appointment',
        'Appointment Declined',
        `${clientName} has declined their appointment.${notes ? ' Reason: ' + notes : ''}`,
        `notifications.html?appt=${appt.id}`
      );
    } catch (e) {}

    // Auto-delete the schedule proposal notifications for this client
    try {
      await Notification.deleteByTypeAndTitle(appt.client_id, 'appointment', 'Schedule Proposed');
      await Notification.deleteByTypeAndTitle(appt.client_id, 'appointment', 'Appointment Approved');
    } catch (e) { console.error('Auto-delete notification failed:', e.message); }

    // A declined booking will not proceed to payment, so the provisional intake
    // form + appointment are removed (only paid bookings persist). Skipped if a
    // verified payment somehow exists.
    try { await purgeAppointment(appt.id); } catch (e) { console.error('Purge after decline failed:', e.message); }

    return res.json({ success: true, message: 'Appointment declined.', data: updated });
  } catch (error) { next(error); }
};

// ── PUT /api/appointments/:id/request-change — client proposes new time ──
const clientRequestChange = async (req, res, next) => {
  try {
    const { new_datetime, notes } = req.body;
    if (!new_datetime) {
      return res.status(400).json({ success: false, message: 'new_datetime is required.' });
    }
    if (!notes || !notes.trim()) {
      return res.status(400).json({ success: false, message: 'A reason for the schedule change is required.' });
    }

    const newDt = new Date(new_datetime);
    if (newDt <= new Date()) {
      return res.status(400).json({ success: false, message: 'New datetime must be in the future.' });
    }

    const appt = await Appointment.findById(req.params.id);
    if (!appt) return res.status(404).json({ success: false, message: 'Appointment not found.' });

    if (appt.client_id !== req.user.id && !isStaff(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }

    const updated = await Appointment.clientRequestChange(appt.id, new_datetime, notes);

    // Notify SupPsy of the client's counter-proposal with their reason
    try {
      const clientUser = await User.findById(appt.client_id);
      const clientName = clientUser ? clientUser.full_name : 'Client';
      await notificationService.notifyRoles(
        ['supervising_psychometrician', 'clinical_director'],
        'appointment',
        'Client Proposed a New Schedule',
        `${clientName} has proposed a new appointment schedule: ${new Date(new_datetime).toLocaleString('en-PH')}. Reason: "${notes}" Please review and confirm or propose an alternative.`,
        'case-dashboard.html'
      );
    } catch (e) {}

    // Auto-delete the schedule proposal notifications for this client
    try {
      await Notification.deleteByTypeAndTitle(appt.client_id, 'appointment', 'Schedule Proposed');
    } catch (e) { console.error('Auto-delete notification failed:', e.message); }

    return res.json({ success: true, message: 'Schedule change requested. Staff will review.', data: updated });
  } catch (error) { next(error); }
};

// ── GET /api/appointments/availability?date=YYYY-MM-DD ──
const MAX_PER_DAY = 5;

const getAvailability = async (req, res, next) => {
  try {
    const { date } = req.query;
    if (!date) return res.status(400).json({ success: false, message: 'date query parameter is required (YYYY-MM-DD).' });

    const count = await Appointment.countByDate(date);
    const bookedSlots = await Appointment.getBookedSlots(date);

    return res.json({
      success: true,
      data: {
        date,
        count,
        maxPerDay: MAX_PER_DAY,
        bookedSlots,
        isFull: count >= MAX_PER_DAY,
        remaining: Math.max(0, MAX_PER_DAY - count),
      },
    });
  } catch (error) { next(error); }
};

// ── PUT /api/appointments/:id/cancel ──
const cancelAppointment = async (req, res, next) => {
  try {
    const appt = await Appointment.findById(req.params.id);
    if (!appt) return res.status(404).json({ success: false, message: 'Appointment not found.' });

    // Only the appointment owner or staff can cancel
    if (!isStaff(req.user.role) && String(appt.client_id) !== String(req.user.id)) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }

    // Cannot cancel already cancelled or declined appointments
    if (['cancelled', 'declined'].includes(appt.status)) {
      return res.status(400).json({ success: false, message: `Appointment is already ${appt.status}.` });
    }

    const updated = await Appointment.cancel(appt.id);

    // Notify the other party
    try {
      if (isStaff(req.user.role)) {
        // Staff cancelled — notify client
        await notificationService.notifyUser(
          appt.client_id, 'appointment',
          'Appointment Cancelled',
          'Your appointment has been cancelled by staff. Please submit a new intake form to reschedule.',
          `notifications.html?appt=${appt.id}`
        );
      } else {
        // Client cancelled — notify staff
        const clientUser = await User.findById(appt.client_id);
        const clientName = clientUser ? clientUser.full_name : 'Client';
        await notificationService.notifyRoles(
          ['psychometrician', 'clinical_director'],
          'appointment',
          'Appointment Cancelled',
          `${clientName} has cancelled their appointment #${appt.id}. The time slot is now available.`,
          `notifications.html?appt=${appt.id}`
        );
      }
    } catch (e) { console.error('Cancel notification failed:', e.message); }

    return res.json({ success: true, message: 'Appointment cancelled. The time slot is now available for others.', data: updated });
  } catch (error) { next(error); }
};

// ── PUT /api/appointments/:id/edit ──
const editAppointment = async (req, res, next) => {
  try {
    const { new_datetime, modality } = req.body;
    if (!new_datetime) {
      return res.status(400).json({ success: false, message: 'new_datetime is required.' });
    }

    const newDt = new Date(new_datetime);
    if (newDt <= new Date()) {
      return res.status(400).json({ success: false, message: 'New datetime must be in the future.' });
    }

    const appt = await Appointment.findById(req.params.id);
    if (!appt) return res.status(404).json({ success: false, message: 'Appointment not found.' });

    // Only the appointment owner or staff can edit
    if (!isStaff(req.user.role) && String(appt.client_id) !== String(req.user.id)) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }

    // Can edit while negotiating or after confirming, as long as not yet paid.
    // A verified payment (or a closed appointment) locks the schedule.
    if (['cancelled', 'declined'].includes(appt.status) || appt.payment_status === 'paid_verified') {
      return res.status(400).json({ success: false, message: `Cannot edit this appointment (status "${appt.status}"${appt.payment_status === 'paid_verified' ? ', already paid' : ''}).` });
    }

    // Neurodevelopmental assessments cannot be changed to Online modality
    if (Appointment.isNeurodevelopmental(appt) && modality && modality.toLowerCase() !== 'face-to-face') {
      return res.status(400).json({
        success: false,
        message: 'Neurodevelopmental assessments must remain Face-to-Face. Online modality is not permitted.',
      });
    }

    // Check daily limit on the new date
    const dateStr = new_datetime.split('T')[0];
    const count = await Appointment.countByDate(dateStr);
    if (count >= MAX_PER_DAY) {
      return res.status(409).json({
        success: false,
        message: `This date is fully booked (${MAX_PER_DAY}/${MAX_PER_DAY} clients). Please choose another date.`,
      });
    }

    // Check time slot conflict
    const bookedSlots = await Appointment.getBookedSlots(dateStr);
    const timeStr = `${String(newDt.getHours()).padStart(2, '0')}:${String(newDt.getMinutes()).padStart(2, '0')}`;
    if (bookedSlots.includes(timeStr)) {
      return res.status(409).json({
        success: false,
        message: 'This appointment time is already taken. Please choose another available time.',
      });
    }

    const updated = await Appointment.editSchedule(appt.id, new_datetime);

    // Notify staff about the edit
    try {
      const clientUser = await User.findById(appt.client_id);
      const clientName = clientUser ? clientUser.full_name : 'Client';
      await notificationService.notifyRoles(
        ['psychometrician', 'clinical_director'],
        'appointment',
        'Appointment Rescheduled',
        `${clientName} has rescheduled their appointment #${appt.id} to ${new Date(new_datetime).toLocaleString('en-PH')}. Please review.`,
        `notifications.html?appt=${appt.id}`
      );
    } catch (e) { console.error('Edit notification failed:', e.message); }

    // Notify the client
    try {
      await notificationService.notifyUser(
        appt.client_id, 'appointment',
        'Appointment Updated',
        `Your appointment has been rescheduled to ${new Date(new_datetime).toLocaleString('en-PH')}. It is now pending staff review.`,
        `notifications.html?appt=${appt.id}`
      );
    } catch (e) { console.error('Edit client notification failed:', e.message); }

    return res.json({ success: true, message: 'Appointment updated. Staff will review the new schedule.', data: updated });
  } catch (error) { next(error); }
};

module.exports = {
  getAppointments, getStatusCounts, getAppointment,
  checkConflicts, approveSchedule, proposeReschedule,
  clientConfirm, clientDecline, clientRequestChange,
  getAvailability, cancelAppointment, editAppointment,
  getIntakePreview,
};
