const db = require('../config/db');
const User = require('../models/User');
const Appointment = require('../models/Appointment');
const Payment = require('../models/Payment');
const Notification = require('../models/Notification');
const Case = require('../models/Case');
const securityEvents = require('../services/securityEvents');
const { PAYMENT_CONFIG } = require('./paymentController');
const { sweepUnpaidIntakes } = require('../services/intakeCleanup');
const notificationService = require('../services/notificationService');

/**
 * POST /api/intake-forms
 * Save intake form data and trigger role-based notifications.
 *
 * Maps the camelCase frontend fields to the snake_case DB columns
 * in the existing intake_forms table.
 */
const submitIntakeForm = async (req, res, next) => {
  try {
    const userId = req.user.id;

    // Fetch user name from DB (not available in JWT payload)
    const user = await User.findById(userId);
    const userName = user ? user.full_name : 'A client';
    const f = req.body;

    if (!f || Object.keys(f).length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Intake form data is required.',
      });
    }

    // ── Date of Birth / Age Validation (min age: 5 years) ──
    if (f.dob) {
      const dobDate = new Date(f.dob);
      const today = new Date();
      let computedAge = today.getFullYear() - dobDate.getFullYear();
      const mDiff = today.getMonth() - dobDate.getMonth();
      if (mDiff < 0 || (mDiff === 0 && today.getDate() < dobDate.getDate())) {
        computedAge--;
      }
      if (computedAge < 5) {
        return res.status(400).json({
          success: false,
          message: 'Client must be at least 5 years old to submit an intake form.',
        });
      }
    }

    if (f.age && parseInt(f.age) < 5) {
      return res.status(400).json({
        success: false,
        message: 'Client must be at least 5 years old to submit an intake form.',
      });
    }

    // A preferred schedule is required: the intake answers are staged on the
    // appointment and only promoted into intake_forms after staff verify payment.
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
      return res.status(409).json({
        success: false,
        message: 'This appointment time is already taken. Please choose another available time.',
      });
    }

    // Intake answers are held on the appointment (pending_intake_data) for staff
    // review. They are only written to intake_forms once payment is verified.
    const appointment = await Appointment.create({
      intakeFormId: null,
      clientId: userId,
      preferredDatetime: f.prefSchedule,
      modality: f.modality || null,
      pendingIntakeData: f,
    });

    // ── Create a Case for this intake ──
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
      serviceType: 'counseling',
    });

    // Link the appointment to the case
    await db.query(`UPDATE appointments SET case_id = $1 WHERE id = $2`, [newCase.case_id, appointment.id]);

    // ── Role-Based Notifications ──────────────────────

    // 1. Notify the client (submitter)
    try {
      await notificationService.notifyUser(
        userId,
        'intake',
        'Counseling Form & Appointment Submitted',
        'Your counseling form and preferred appointment schedule have been submitted for review. We’ll notify you once a staff member approves your schedule — payment will be requested only after that.',
        `profile.html?appt_id=${appointment.id}`
      );
    } catch (err) {
      console.error('Failed to send client intake notification:', err.message);
    }

    // 2. Notify all staff members (action required)
    try {
      await notificationService.notifyRoles(
        ['psychometrician', 'clinical_director'],
        'intake',
        'New Client Intake Form',
        `${userName} has submitted an intake form and is awaiting review.${f.prefSchedule ? ' Preferred schedule: ' + new Date(f.prefSchedule).toLocaleString('en-PH') : ''}`,
        'case-dashboard.html'
      );
    } catch (err) {
      console.error('Failed to send staff intake notifications:', err.message);
    }

    return res.status(201).json({
      success: true,
      message: 'Intake form submitted for review.',
      data: {
        appointment_id: appointment.id,
        created_at: appointment.created_at,
        appointment,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/intake-forms/checkout
 *
 * Combined intake + payment submission. The intake form is NOT persisted until
 * the client reaches payment: this single endpoint validates the intake, then
 * stores the intake form, creates the appointment, and creates the payment
 * record together. If the client never commits to payment, nothing is stored —
 * they simply redo the intake form. The payment hold is short (7 minutes).
 *
 * Body: { ...intakeFields, paymentOption: 'half'|'full', agreed: 1 }
 */
const EXPRESS_PAYMENT_MINUTES = 7;

const checkoutIntake = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const user = await User.findById(userId);
    const userName = user ? user.full_name : 'A client';
    const f = req.body || {};

    const paymentOption = f.paymentOption;
    if (!paymentOption || !['half', 'full'].includes(paymentOption)) {
      return res.status(400).json({ success: false, message: "Payment option must be either 'half' or 'full'." });
    }
    const agreed = (f.agreed === true || f.agreed === 1 || f.agreed === '1') ? 1 : 0;
    if (agreed !== 1) {
      return res.status(400).json({ success: false, message: 'You must accept the no-refund and no-cancellation policy before proceeding to payment.' });
    }
    if (!f.prefSchedule) {
      return res.status(400).json({ success: false, message: 'A preferred schedule is required to book and pay.' });
    }

    // Reject schedules in the past (date OR time) before taking payment.
    if (isNaN(new Date(f.prefSchedule).getTime()) || new Date(f.prefSchedule) <= new Date()) {
      return res.status(400).json({
        success: false,
        message: 'The selected appointment date and time has already passed. Please choose a future schedule.',
      });
    }

    // ── Age validation (min 5 years) ──
    if (f.dob) {
      const dobDate = new Date(f.dob);
      const today = new Date();
      let computedAge = today.getFullYear() - dobDate.getFullYear();
      const mDiff = today.getMonth() - dobDate.getMonth();
      if (mDiff < 0 || (mDiff === 0 && today.getDate() < dobDate.getDate())) computedAge--;
      if (computedAge < 5) {
        return res.status(400).json({ success: false, message: 'Client must be at least 5 years old to submit an intake form.' });
      }
    }
    if (f.age && parseInt(f.age) < 5) {
      return res.status(400).json({ success: false, message: 'Client must be at least 5 years old to submit an intake form.' });
    }

    // ── Slot availability (only paid_verified slots are reserved) ──
    const schedDate = f.prefSchedule.split('T')[0];
    const MAX_PER_DAY = 5;
    const dayCount = await Appointment.countByDate(schedDate);
    if (dayCount >= MAX_PER_DAY) {
      return res.status(409).json({ success: false, message: `This date is fully booked (${MAX_PER_DAY}/${MAX_PER_DAY} clients per day). Please choose another date.` });
    }
    const bookedSlots = await Appointment.getBookedSlots(schedDate);
    const schedDt = new Date(f.prefSchedule);
    const timeStr = `${String(schedDt.getHours()).padStart(2, '0')}:${String(schedDt.getMinutes()).padStart(2, '0')}`;
    if (bookedSlots.includes(timeStr)) {
      return res.status(409).json({ success: false, message: 'This appointment time is already taken. Please choose another available time.' });
    }

    // ── 1) Persist the intake form (now that the client is committing to pay) ──
    const result = await db.query(
      `INSERT INTO intake_forms (
        user_id, full_name, nickname, age, date_of_birth, gender, civil_status,
        address, cellphone, home_phone, email,
        concern_description, reason_for_counseling, since_when, how_long,
        therapy_before, medication_history,
        preferred_schedule, language_preference, session_modality, counselor_gender_pref,
        is_minor, guardian_name, guardian_contact, guardian_relation, minor_other_reason,
        emergency_name, emergency_address, emergency_contact, emergency_email, emergency_relation,
        data_privacy_consent, code_of_ethics_consent
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7, $8,$9,$10,$11, $12,$13,$14,$15, $16,$17,
        $18,$19,$20,$21, $22,$23,$24,$25,$26, $27,$28,$29,$30,$31, $32, $33
      ) RETURNING id, created_at`,
      [
        userId, (f.fullName || [f.givenName, f.middleName, f.familyName].filter(Boolean).join(' ') || null), f.nickName || null, f.age ? parseInt(f.age) : null, f.dob || null,
        f.gender || null, f.civilStatus || null, f.address || null, f.cellphone || null, f.homePhone || null,
        f.email || null, f.concernDesc || null, f.reasonCounseling || null, f.sinceWhen || null, f.howLong || null,
        f.therapyBefore || null, f.medicationHistory || null, f.prefSchedule || null, f.language || null,
        f.modality || null, f.counselorGender || null, f.isMinor || null, f.guardianName || null,
        f.guardianContact || null, f.guardianRelation || null, f.minorOtherReason || null, f.emerName || null,
        f.emerAddress || null, f.emerContact || null, f.emerEmail || null, f.emerRelation || null,
        f.dataPrivacyConsent === true || f.dataPrivacyConsent === 'true' || f.dataPrivacyConsent === 1,
        f.codeOfEthicsConsent === true || f.codeOfEthicsConsent === 'true' || f.codeOfEthicsConsent === 1,
      ]
    );
    const intake = result.rows[0];

    // ── 1b) Create a Case for this intake ──
    // Resolve staff_id from the counselorStaff value (may be name or staff_id)
    let assignedStaffId = null;
    if (f.counselorStaffId) {
      assignedStaffId = parseInt(f.counselorStaffId, 10) || null;
    } else if (f.counselorStaff) {
      // Legacy: staff was submitted by name; look up the staff_id
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
      serviceType: 'counseling',
    });

    // Link the intake form to the case
    await db.query(`UPDATE intake_forms SET case_id = $1 WHERE id = $2`, [newCase.case_id, intake.id]);

    // ── 2) Create the appointment ──
    const appointment = await Appointment.create({
      intakeFormId: intake.id,
      clientId: userId,
      preferredDatetime: f.prefSchedule,
      modality: f.modality || null,
    });

    // Link the appointment to the case
    await db.query(`UPDATE appointments SET case_id = $1 WHERE id = $2`, [newCase.case_id, appointment.id]);

    // ── 3) Create the payment (7-minute hold, agreement recorded) ──
    const amountDue = paymentOption === 'full' ? PAYMENT_CONFIG.fullAmount : PAYMENT_CONFIG.halfAmount;
    const outstandingBalance = paymentOption === 'half' ? +(PAYMENT_CONFIG.totalFee - amountDue).toFixed(2) : 0;
    const referenceNumber = await Payment.generateReferenceNumber();
    const payment = await Payment.create({
      referenceNumber,
      intakeFormId: intake.id,
      appointmentId: appointment.id,
      clientId: userId,
      serviceLabel: f.modality || null,
      paymentOption,
      paymentMethod: PAYMENT_CONFIG.method,
      amountDue,
      totalFee: PAYMENT_CONFIG.totalFee,
      outstandingBalance,
      agreedNoCancellation: 1,
      expiresInMinutes: EXPRESS_PAYMENT_MINUTES,
    });

    // Notifications (intake now exists)
    try {
      await notificationService.notifyUser(userId, 'intake', 'Intake Form Submitted',
        'Your intake form has been submitted. Complete your payment to reserve your slot.', 'profile.html');
    } catch (_) {}
    try {
      await notificationService.notifyRoles(['psychometrician', 'clinical_director'], 'intake', 'New Client Intake Form',
        `${userName} has submitted an intake form and is awaiting review.${f.prefSchedule ? ' Preferred schedule: ' + new Date(f.prefSchedule).toLocaleString('en-PH') : ''}`,
        'case-dashboard.html');
    } catch (_) {}

    // Link the payment to the case
    await db.query(`UPDATE payments SET case_id = $1 WHERE id = $2`, [newCase.case_id, payment.id]);

    const qrImage = paymentOption === 'full' ? PAYMENT_CONFIG.qr.full : PAYMENT_CONFIG.qr.half;
    return res.status(201).json({
      success: true,
      message: 'Intake saved. Please complete your payment within 7 minutes.',
      data: {
        case_id: newCase.case_id,
        intake_form_id: intake.id,
        appointment_id: appointment.id,
        payment: {
          id: payment.id,
          reference_number: payment.reference_number,
          payment_option: payment.payment_option,
          amount_due: Number(payment.amount_due),
          total_fee: Number(payment.total_fee),
          outstanding_balance: Number(payment.outstanding_balance),
          status: payment.status,
          expires_at: payment.expires_at,
          qr_image: qrImage,
          account: PAYMENT_CONFIG.account,
        },
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Build a form_data-like object from the flat DB row columns.
 */
function rowToFormData(row) {
  return {
    fullName: row.full_name,
    nickName: row.nickname,
    age: row.age,
    dob: row.date_of_birth,
    gender: row.gender,
    civilStatus: row.civil_status,
    address: row.address,
    cellphone: row.cellphone,
    homePhone: row.home_phone,
    email: row.email,
    concernDesc: row.concern_description,
    reasonCounseling: row.reason_for_counseling,
    sinceWhen: row.since_when,
    howLong: row.how_long,
    therapyBefore: row.therapy_before,
    medicationHistory: row.medication_history,
    prefSchedule: row.preferred_schedule,
    language: row.language_preference,
    modality: row.session_modality,
    counselorGender: row.counselor_gender_pref,
    isMinor: row.is_minor,
    guardianName: row.guardian_name,
    guardianContact: row.guardian_contact,
    guardianRelation: row.guardian_relation,
    minorOtherReason: row.minor_other_reason,
    emerName: row.emergency_name,
    emerAddress: row.emergency_address,
    emerContact: row.emergency_contact,
    emerEmail: row.emergency_email,
    emerRelation: row.emergency_relation,
    dataPrivacyConsent: row.data_privacy_consent,
    codeOfEthicsConsent: row.code_of_ethics_consent,
  };
}

/**
 * GET /api/intake-forms
 * Get intake forms — clients see only their own, staff see all.
 */
const getIntakeForms = async (req, res, next) => {
  try {
    const { role, id: userId } = req.user;
    const { limit = 20, offset = 0 } = req.query;

    // Keep only completed+paid intakes around: drop provisional bookings that
    // will not reach a verified payment before listing.
    await sweepUnpaidIntakes();

    let query, params;

    if (role === 'client') {
      // Clients can only see their own submissions — include all columns
      query = `SELECT i.*, u.full_name AS client_name, u.email AS client_email
               FROM intake_forms i
               JOIN users u ON u.id = i.user_id
               WHERE i.user_id = $1
               ORDER BY i.created_at DESC LIMIT $2 OFFSET $3`;
      params = [userId, parseInt(limit), parseInt(offset)];
    } else {
      // Staff can see all intake forms with all columns
      query = `SELECT i.*, u.full_name AS client_name, u.email AS client_email
               FROM intake_forms i
               JOIN users u ON u.id = i.user_id
               ORDER BY i.created_at DESC
               LIMIT $1 OFFSET $2`;
      params = [parseInt(limit), parseInt(offset)];
    }

    const result = await db.query(query, params);

    // Build form_data from the flat columns for all rows
    const data = result.rows.map(row => {
      return {
        id: row.id,
        user_id: row.user_id,
        created_at: row.created_at,
        client_name: row.client_name || row.full_name,
        client_email: row.client_email || row.email,
        form_data: rowToFormData(row),
      };
    });

    return res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/intake-forms/:id
 * Get a single intake form by ID (staff see full data, clients see their own).
 */
const getIntakeForm = async (req, res, next) => {
  try {
    const { role, id: userId } = req.user;
    const formId = req.params.id;

    const result = await db.query(
      `SELECT i.*, u.full_name AS client_name, u.email AS client_email
       FROM intake_forms i
       JOIN users u ON u.id = i.user_id
       WHERE i.id = $1`,
      [formId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Intake form not found.' });
    }

    const row = result.rows[0];

    // Clients can only view their own
    if (role === 'client' && row.user_id !== userId) {
      securityEvents.record({
        module: 'intake_scheduling', eventType: 'unauthorized_intake_access',
        userId, subjectKind: 'user', ip: req.ip,
        details: `Client #${userId} attempted to view intake form #${row.id} belonging to another client.`,
      });
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }

    // Build response with form_data for frontend compatibility
    const form = {
      id: row.id,
      user_id: row.user_id,
      created_at: row.created_at,
      client_name: row.client_name || row.full_name,
      client_email: row.client_email || row.email,
      form_data: rowToFormData(row),
    };

    return res.status(200).json({ success: true, data: form });
  } catch (error) {
    next(error);
  }
};

/**
 * DELETE /api/intake-forms/checkout/:paymentId
 *
 * Roll back an express checkout that was not completed (e.g. the 7-minute
 * payment window expired before proof was uploaded). Removes the payment, the
 * appointment, and the intake form so nothing remains stored for an unpaid
 * checkout. Only works while the payment is still pending with no proof.
 */
const abandonCheckout = async (req, res, next) => {
  try {
    const payment = await Payment.findById(req.params.paymentId);
    if (!payment || payment.client_id !== req.user.id) {
      return res.json({ success: true }); // nothing to roll back / not the owner
    }
    if (payment.status !== 'pending' || payment.proof_of_payment) {
      return res.status(409).json({ success: false, message: 'This payment is already in progress and cannot be discarded.' });
    }
    await db.query(`DELETE FROM payments WHERE id = $1`, [payment.id]);
    if (payment.appointment_id) {
      await db.query(`DELETE FROM appointments WHERE id = $1 AND client_id = $2`, [payment.appointment_id, req.user.id]);
    }
    if (payment.intake_form_id) {
      await db.query(`DELETE FROM intake_forms WHERE id = $1 AND user_id = $2`, [payment.intake_form_id, req.user.id]);
    }
    return res.json({ success: true });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/intake-forms/notify-payment
 *
 * Called when the client finishes the intake form. The intake is NOT stored yet
 * — it is held in the browser. This simply drops a "Complete Your Payment"
 * notification so the client starts the payment procedure FROM the notification.
 * Clicking it opens payment.html?flow=intake, where the held intake is checked
 * out together with the payment.
 */
const notifyPaymentPending = async (req, res, next) => {
  try {
    const userId = req.user.id;
    try { await Notification.deleteByTypeAndTitle(userId, 'payment', 'Complete Your Payment'); } catch (_) {}
    await notificationService.notifyUser(
      userId, 'payment', 'Complete Your Payment',
      'Your intake form is ready. Open this notification to choose Half or Full payment and complete your booking. Your booking is only saved once payment is completed.',
      'payment.html?flow=intake'
    );
    return res.json({ success: true });
  } catch (error) { next(error); }
};

module.exports = { submitIntakeForm, checkoutIntake, abandonCheckout, notifyPaymentPending, getIntakeForms, getIntakeForm };
