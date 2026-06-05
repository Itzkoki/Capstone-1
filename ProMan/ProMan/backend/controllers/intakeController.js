const db = require('../config/db');
const User = require('../models/User');
const Appointment = require('../models/Appointment');
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

    // Save intake form to database — map frontend fields to DB columns
    const result = await db.query(
      `INSERT INTO intake_forms (
        user_id, full_name, nickname, age, date_of_birth, gender, civil_status,
        address, cellphone, home_phone, email,
        concern_description, reason_for_counseling, since_when, how_long,
        therapy_before, medication_history,
        preferred_schedule, language_preference, session_modality, counselor_gender_pref,
        is_minor, guardian_name, guardian_contact, guardian_relation, minor_other_reason,
        emergency_name, emergency_address, emergency_contact, emergency_email, emergency_relation,
        status
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9, $10, $11,
        $12, $13, $14, $15,
        $16, $17,
        $18, $19, $20, $21,
        $22, $23, $24, $25, $26,
        $27, $28, $29, $30, $31,
        'pending'
      ) RETURNING id, status, created_at`,
      [
        userId,
        f.fullName || null,
        f.nickName || null,
        f.age ? parseInt(f.age) : null,
        f.dob || null,
        f.gender || null,
        f.civilStatus || null,
        f.address || null,
        f.cellphone || null,
        f.homePhone || null,
        f.email || null,
        f.concernDesc || null,
        f.reasonCounseling || null,
        f.sinceWhen || null,
        f.howLong || null,
        f.therapyBefore || null,
        f.medicationHistory || null,
        f.prefSchedule || null,
        f.language || null,
        f.modality || null,
        f.counselorGender || null,
        f.isMinor || null,
        f.guardianName || null,
        f.guardianContact || null,
        f.guardianRelation || null,
        f.minorOtherReason || null,
        f.emerName || null,
        f.emerAddress || null,
        f.emerContact || null,
        f.emerEmail || null,
        f.emerRelation || null,
      ]
    );

    const intake = result.rows[0];

    // ── Auto-create Appointment ──────────────────────
    let appointment = null;
    if (f.prefSchedule) {
      try {
        // Validate daily limit (max 5 per day)
        const schedDate = f.prefSchedule.split('T')[0];
        const MAX_PER_DAY = 5;
        const dayCount = await Appointment.countByDate(schedDate);
        if (dayCount >= MAX_PER_DAY) {
          return res.status(409).json({
            success: false,
            message: `This date is fully booked (${MAX_PER_DAY}/${MAX_PER_DAY} clients per day). Please choose another date.`,
          });
        }

        // Validate time slot not already taken
        const bookedSlots = await Appointment.getBookedSlots(schedDate);
        const schedDt = new Date(f.prefSchedule);
        const timeStr = `${String(schedDt.getHours()).padStart(2, '0')}:${String(schedDt.getMinutes()).padStart(2, '0')}`;
        if (bookedSlots.includes(timeStr)) {
          return res.status(409).json({
            success: false,
            message: 'This appointment time is already taken. Please choose another available time.',
          });
        }

        appointment = await Appointment.create({
          intakeFormId: intake.id,
          clientId: userId,
          preferredDatetime: f.prefSchedule,
          modality: f.modality || null,
        });
      } catch (err) {
        // If it's a validation error we already sent, don't catch it
        if (err.status) throw err;
        console.error('Failed to create appointment from intake:', err.message);
      }
    }

    // ── Role-Based Notifications ──────────────────────

    // 1. Notify the client (submitter)
    try {
      await notificationService.notifyUser(
        userId,
        'intake',
        'Intake Form Submitted',
        'Your intake form has been submitted successfully. Our team will review it and contact you shortly.',
        'profile.html'
      );
    } catch (err) {
      console.error('Failed to send client intake notification:', err.message);
    }

    // 2. Notify all staff members (action required)
    try {
      await notificationService.notifyStaff(
        'intake',
        'New Client Intake Form',
        `${userName} has submitted an intake form and is awaiting review.${f.prefSchedule ? ' Preferred schedule: ' + new Date(f.prefSchedule).toLocaleString('en-PH') : ''}`,
        'intake-submissions.html'
      );
    } catch (err) {
      console.error('Failed to send staff intake notifications:', err.message);
    }

    return res.status(201).json({
      success: true,
      message: 'Intake form submitted successfully.',
      data: {
        id: intake.id,
        status: intake.status,
        created_at: intake.created_at,
        appointment: appointment || null,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Build a form_data-like object from the flat DB row columns
 * so the frontend intake-submissions.html can render it consistently.
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
  };
}

/**
 * GET /api/intake-forms
 * Get intake forms — clients see only their own, staff see all.
 */
const getIntakeForms = async (req, res, next) => {
  try {
    const { role, id: userId } = req.user;
    const { limit = 20, offset = 0, status } = req.query;

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
               ${status ? 'WHERE i.status = $1' : ''}
               ORDER BY i.created_at DESC
               LIMIT $${status ? 2 : 1} OFFSET $${status ? 3 : 2}`;
      params = status
        ? [status, parseInt(limit), parseInt(offset)]
        : [parseInt(limit), parseInt(offset)];
    }

    const result = await db.query(query, params);

    // Build form_data from the flat columns for all rows
    const data = result.rows.map(row => {
      return {
        id: row.id,
        user_id: row.user_id,
        status: row.status,
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
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }

    // Build response with form_data for frontend compatibility
    const form = {
      id: row.id,
      user_id: row.user_id,
      status: row.status,
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
 * PUT /api/intake-forms/:id/status
 * Staff-only: update intake form status (pending → reviewed → approved).
 * Triggers a notification to the client.
 */
const updateIntakeStatus = async (req, res, next) => {
  try {
    const { status } = req.body;
    const validStatuses = ['pending', 'reviewed', 'approved', 'rejected'];

    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `Status must be one of: ${validStatuses.join(', ')}`,
      });
    }

    const result = await db.query(
      `UPDATE intake_forms SET status = $1
       WHERE id = $2
       RETURNING id, user_id, status, created_at`,
      [status, req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Intake form not found.' });
    }

    const form = result.rows[0];

    // Notify the client about the status update
    const statusMessages = {
      reviewed: 'Your intake form is being reviewed by our team.',
      approved: 'Your intake form has been approved! We will contact you to schedule your appointment.',
      rejected: 'Your intake form needs additional information. Please check your profile for details.',
      pending: 'Your intake form status has been updated.',
    };

    try {
      await notificationService.notifyUser(
        form.user_id,
        'intake',
        'Intake Form Update',
        statusMessages[status],
        'profile.html'
      );
    } catch (err) {
      console.error('Failed to send intake status notification:', err.message);
    }

    return res.status(200).json({ success: true, data: form });
  } catch (error) {
    next(error);
  }
};

module.exports = { submitIntakeForm, getIntakeForms, getIntakeForm, updateIntakeStatus };
