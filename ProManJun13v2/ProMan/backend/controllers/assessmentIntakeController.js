const db = require('../config/db');
const User = require('../models/User');
const Appointment = require('../models/Appointment');
const Case = require('../models/Case');
const notificationService = require('../services/notificationService');

/**
 * POST /api/assessment-intake-forms
 *
 * Submit an Assessment intake form. The answers are staged on the appointment
 * (pending_intake_data) for staff review and are NOT written to
 * assessment_intake_forms until payment is verified — mirroring the Counseling
 * flow. On payment verification, services/intakePromote → promoteAssessment
 * persists the row and links it to the case (assessment_form_id). This ensures
 * an unpaid submission never creates a permanent assessment record.
 */
const submitAssessmentIntake = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const user = await User.findById(userId);
    const userName = user ? user.full_name : 'A client';
    const f = req.body || {};

    if (!f || Object.keys(f).length === 0) {
      return res.status(400).json({ success: false, message: 'Assessment intake form data is required.' });
    }

    // Tag the staged data so payment-verification promotion routes it to the
    // assessment table rather than the counseling intake_forms table.
    f.formType = 'assessment';
    f.serviceType = 'Assessment';

    // ── Date of Birth / Age validation (min age: 2 years) ──
    if (f.birthdate) {
      const dobDate = new Date(f.birthdate);
      const today = new Date();
      let computedAge = today.getFullYear() - dobDate.getFullYear();
      const mDiff = today.getMonth() - dobDate.getMonth();
      if (mDiff < 0 || (mDiff === 0 && today.getDate() < dobDate.getDate())) computedAge--;
      if (computedAge < 2) {
        return res.status(400).json({ success: false, message: 'Client must be at least 2 years old to submit an assessment form.' });
      }
    }
    if (f.age && parseInt(f.age) < 2) {
      return res.status(400).json({ success: false, message: 'Client must be at least 2 years old to submit an assessment form.' });
    }

    // A preferred schedule is required.
    if (!f.prefSchedule) {
      return res.status(400).json({ success: false, message: 'A preferred appointment schedule is required.' });
    }

    // Reject schedules in the past (date OR time). Authoritative server-side
    // guard so a stale/forged client cannot book a slot that has already passed.
    if (isNaN(new Date(f.prefSchedule).getTime()) || new Date(f.prefSchedule) <= new Date()) {
      return res.status(400).json({
        success: false,
        message: 'The selected appointment date and time has already passed. Please choose a future schedule.',
      });
    }

    // Validate daily limit (max 5 per day) and that the slot is free.
    const schedDate = f.prefSchedule.split('T')[0];
    const MAX_PER_DAY = 5;
    const dayCount = await Appointment.countByDate(schedDate);
    if (dayCount >= MAX_PER_DAY) {
      return res.status(409).json({
        success: false,
        message: `This date is fully booked (${MAX_PER_DAY}/${MAX_PER_DAY} clients per day). Please choose another date.`,
      });
    }
    const bookedSlots = await Appointment.getBookedSlots(schedDate);
    const schedDt = new Date(f.prefSchedule);
    const timeStr = `${String(schedDt.getHours()).padStart(2, '0')}:${String(schedDt.getMinutes()).padStart(2, '0')}`;
    if (bookedSlots.includes(timeStr)) {
      return res.status(409).json({ success: false, message: 'This appointment time is already taken. Please choose another available time.' });
    }

    // The assessment answers are held on the appointment (pending_intake_data)
    // for staff review. They are only written to assessment_intake_forms once
    // payment is verified (services/intakePromote → promoteAssessment), so an
    // unpaid submission never creates a permanent DB record.
    const appointment = await Appointment.create({
      intakeFormId: null,
      assessmentFormId: null,
      clientId: userId,
      preferredDatetime: f.prefSchedule,
      modality: f.modality || null,
      pendingIntakeData: f,
    });

    // ── Create a Case for this assessment intake ──
    let assignedStaffId = null;
    if (f.counselorStaffId) {
      assignedStaffId = parseInt(f.counselorStaffId, 10) || null;
    } else if (f.counselorStaff) {
      const staffLookup = await db.query(
        `SELECT staff_id FROM staff WHERE CONCAT(first_name, ' ', last_name) = $1 AND is_active = TRUE LIMIT 1`,
        [f.counselorStaff]
      );
      if (staffLookup.rows.length > 0) assignedStaffId = staffLookup.rows[0].staff_id;
    }

    const newCase = await Case.create({
      userId,
      assignedPsychologistId: assignedStaffId,
      intakeDate: new Date(),
      serviceType: 'assessment',
    });

    // Link the appointment to the case
    await db.query(`UPDATE appointments SET case_id = $1 WHERE id = $2`, [newCase.case_id, appointment.id]);

    // ── Role-based notifications (identical to counseling) ──
    try {
      await notificationService.notifyUser(
        userId, 'intake', 'Assessment Form & Appointment Submitted',
        'Your assessment intake form and preferred appointment schedule have been submitted for review. We’ll notify you once a staff member approves your schedule — payment will be requested only after that.',
        `profile.html?appt_id=${appointment.id}`
      );
    } catch (err) { console.error('Failed to send client assessment notification:', err.message); }

    try {
      await notificationService.notifyRoles(
        ['psychometrician', 'clinical_director'],
        'intake', 'New Client Assessment Form',
        `${userName} has submitted an assessment intake form and is awaiting review.${f.prefSchedule ? ' Preferred schedule: ' + new Date(f.prefSchedule).toLocaleString('en-PH') : ''}`,
        'case-dashboard.html'
      );
    } catch (err) { console.error('Failed to send staff assessment notifications:', err.message); }

    return res.status(201).json({
      success: true,
      message: 'Assessment intake form submitted for review.',
      data: { case_id: newCase.case_id, appointment_id: appointment.id, created_at: appointment.created_at, appointment },
    });
  } catch (error) {
    next(error);
  }
};

/** Build a form_data-like object from the flat DB row for frontend rendering. */
function rowToFormData(row) {
  return {
    formType: 'assessment',
    serviceType: 'Assessment',
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
    dataPrivacyConsent: row.data_privacy_consent,
    codeOfEthicsConsent: row.code_of_ethics_consent,
  };
}

/** GET /api/assessment-intake-forms — clients see own, staff see all. */
const getAssessmentIntakeForms = async (req, res, next) => {
  try {
    const { role, id: userId } = req.user;
    const { limit = 20, offset = 0 } = req.query;

    let query, params;
    if (role === 'client') {
      query = `SELECT a.*, u.full_name AS client_name, u.email AS client_email
               FROM assessment_intake_forms a
               JOIN users u ON u.id = a.user_id
               WHERE a.user_id = $1
               ORDER BY a.created_at DESC LIMIT $2 OFFSET $3`;
      params = [userId, parseInt(limit), parseInt(offset)];
    } else {
      query = `SELECT a.*, u.full_name AS client_name, u.email AS client_email
               FROM assessment_intake_forms a
               JOIN users u ON u.id = a.user_id
               ORDER BY a.created_at DESC LIMIT $1 OFFSET $2`;
      params = [parseInt(limit), parseInt(offset)];
    }

    const result = await db.query(query, params);
    const data = result.rows.map(row => ({
      id: row.id,
      user_id: row.user_id,
      created_at: row.created_at,
      client_name: row.client_name,
      client_email: row.client_email || row.email,
      form_data: rowToFormData(row),
    }));

    return res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/** GET /api/assessment-intake-forms/:id */
const getAssessmentIntakeForm = async (req, res, next) => {
  try {
    const { role, id: userId } = req.user;
    const result = await db.query(
      `SELECT a.*, u.full_name AS client_name, u.email AS client_email
       FROM assessment_intake_forms a
       JOIN users u ON u.id = a.user_id
       WHERE a.id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Assessment intake form not found.' });
    }
    const row = result.rows[0];
    if (role === 'client' && row.user_id !== userId) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }
    return res.status(200).json({
      success: true,
      data: {
        id: row.id,
        user_id: row.user_id,
        created_at: row.created_at,
        client_name: row.client_name,
        client_email: row.client_email || row.email,
        form_data: rowToFormData(row),
      },
    });
  } catch (error) {
    next(error);
  }
};

module.exports = { submitAssessmentIntake, getAssessmentIntakeForms, getAssessmentIntakeForm };
