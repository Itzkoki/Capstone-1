const Case = require('../models/Case');
const CaseNote = require('../models/CaseNote');
const ClinicalAssessment = require('../models/ClinicalAssessment');
const CaseAuditLog = require('../models/CaseAuditLog');
const notificationService = require('../services/notificationService');
const db = require('../config/db');

const getClientIP = (req) =>
  req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
  req.connection?.remoteAddress || req.ip || 'unknown';

const isStaff = (role) => role && role !== 'client';

// ─── GET /api/cases ────────────────────────────────────────────────
// Staff see all cases (filterable), clients see only their own.
const getCases = async (req, res, next) => {
  try {
    const { role, id: userId } = req.user;
    const { status, limit = 50, offset = 0 } = req.query;

    let cases;
    if (role === 'client') {
      cases = await Case.findByUserId(userId);
    } else {
      const filters = { status, limit: parseInt(limit), offset: parseInt(offset) };
      // Psychologists see only their assigned cases
      // Psychometritians + SupPsy + QCP + CD see all cases
      if (role === 'psychologist') {
        filters.psychologistId = userId;
      }
      cases = await Case.findAll(filters);
    }

    return res.json({ success: true, data: cases });
  } catch (error) { next(error); }
};

// ─── GET /api/cases/:caseId ────────────────────────────────────────
const getCaseById = async (req, res, next) => {
  try {
    const { role, id: userId } = req.user;
    const caseData = await Case.findById(req.params.caseId);

    if (!caseData) {
      return res.status(404).json({ success: false, message: 'Case not found.' });
    }

    // Clients can only view their own cases
    if (role === 'client' && caseData.user_id !== userId) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }

    // Fetch related records
    const [intakes, assessmentIntakes, appointments, payments, assessments, notes] = await Promise.all([
      db.query(
        // Resolve the reviewer (reviewed_by) to a display name — staff live in the
        // `staff` table, with a fallback to `users` — so the UI can show who
        // reviewed the intake and when, instead of a bare "Pending" status.
        `SELECT i.*,
                COALESCE(
                  (SELECT NULLIF(TRIM(CONCAT(s.first_name, ' ', s.last_name)), '') FROM staff s WHERE s.staff_id = i.reviewed_by),
                  (SELECT u.full_name FROM users u WHERE u.id = i.reviewed_by)
                ) AS reviewed_by_name
         FROM intake_forms i
         WHERE i.case_id = $1
            OR i.id IN (SELECT intake_form_id FROM appointments WHERE case_id = $1 AND intake_form_id IS NOT NULL)
         ORDER BY i.created_at DESC`,
        [caseData.case_id]
      ),
      db.query(
        `SELECT * FROM assessment_intake_forms
         WHERE case_id = $1
            OR id IN (SELECT assessment_form_id FROM appointments WHERE case_id = $1 AND assessment_form_id IS NOT NULL)
         ORDER BY created_at DESC`,
        [caseData.case_id]
      ),
      db.query(`SELECT * FROM appointments WHERE case_id = $1 ORDER BY created_at DESC`, [caseData.case_id]),
      db.query(`SELECT * FROM payments WHERE case_id = $1 ORDER BY created_at DESC`, [caseData.case_id]),
      ClinicalAssessment.findByCaseId(caseData.case_id),
      CaseNote.findByCaseId(caseData.case_id, { includeInternal: isStaff(role) }),
    ]);

    // Fetch reports linked to this case. Match by case_id, and also fall back to
    // any of this case's client's reports that were created without a case_id
    // stamp — so Psych Reports always reflect in Case Management.
    const reports = await db.query(
      `SELECT id, case_id, psychologist_id, client_name, status, current_version,
              report_code, is_locked, signature_stage, released_at, created_at, updated_at
       FROM psychological_reports
       WHERE deleted_at IS NULL
         AND (case_id = $1 OR (case_id IS NULL AND client_id = $2))
       ORDER BY created_at DESC`,
      [caseData.case_id, caseData.user_id]
    );

    return res.json({
      success: true,
      data: {
        ...caseData,
        intake_forms: intakes.rows,
        assessment_intake_forms: assessmentIntakes.rows,
        appointments: appointments.rows,
        payments: payments.rows,
        assessments,
        notes,
        reports: reports.rows,
      },
    });
  } catch (error) { next(error); }
};

// ─── POST /api/cases/:caseId/review ────────────────────────────────
// Phase 2: Approve or reject intake
const reviewIntake = async (req, res, next) => {
  try {
    const { caseId } = req.params;
    const { decision, reason } = req.body; // 'approve' or 'reject'
    const staffId = req.user.id;

    const caseData = await Case.findById(caseId);
    if (!caseData) return res.status(404).json({ success: false, message: 'Case not found.' });
    if (caseData.status !== 'Pending Intake Review') {
      return res.status(409).json({ success: false, message: `Case is not pending intake review (current: ${caseData.status}).` });
    }

    if (decision === 'approve') {
      // Update intake form review status
      await db.query(
        `UPDATE intake_forms SET review_status = 'Approved', reviewed_by = $1, reviewed_at = NOW() WHERE case_id = $2`,
        [staffId, caseId]
      );
      await db.query(
        `UPDATE assessment_intake_forms SET review_status = 'Approved', reviewed_by = $1, reviewed_at = NOW() WHERE case_id = $2`,
        [staffId, caseId]
      ).catch(() => {}); // May not have assessment_intake review_status columns yet

      await Case.updateStatus(caseId, 'Awaiting Initial Payment', { staffId, ipAddress: getClientIP(req) });

      // Find the linked appointment to include in the SupPsy notification link
      let apptLinkId = '';
      try {
        const apptRow = await db.query(
          `SELECT id FROM appointments WHERE case_id = $1 ORDER BY created_at DESC LIMIT 1`,
          [caseId]
        );
        if (apptRow.rows.length) apptLinkId = apptRow.rows[0].id;
      } catch (_) {}

      // Notify SupPsy to confirm/propose appointment schedule
      try {
        const clientName = caseData.full_name || 'A client';
        await notificationService.notifyRoles(
          ['supervising_psychometrician', 'clinical_director'], 'appointment',
          'Appointment Confirmation Needed',
          `${clientName}'s intake form (Case ${caseId}) has been approved. Please review their preferred appointment schedule and confirm or propose a new date.`,
          `case-dashboard.html?case=${encodeURIComponent(caseId)}`
        );
      } catch (_) {}

      // Notify client their intake was approved and they're awaiting schedule confirmation
      try {
        const isAssessmentCase = caseData.service_type === 'assessment';
        const approvedTitle = isAssessmentCase
          ? 'Assessment Form Approved — Awaiting Schedule Confirmation'
          : 'Counseling Form Approved — Awaiting Schedule Confirmation';
        const approvedMsg = isAssessmentCase
          ? `Your assessment form has been approved! The Supervising Psychometrician will review your preferred appointment schedule and reach out to confirm. You will be notified once your appointment is confirmed. Case ID: ${caseId}`
          : `Your counseling form has been approved! The Supervising Psychometrician will review your preferred appointment schedule and reach out to confirm. You will be notified once your appointment is confirmed. Case ID: ${caseId}`;
        await notificationService.notifyUser(
          caseData.user_id, 'intake', approvedTitle, approvedMsg, 'notifications.html'
        );
      } catch (_) {}

      return res.json({ success: true, message: 'Intake approved. Supervising Psychometrician notified to confirm appointment.' });

    } else if (decision === 'reject') {
      if (!reason) return res.status(400).json({ success: false, message: 'Rejection reason is required.' });

      await db.query(
        `UPDATE intake_forms SET review_status = 'Rejected', reviewed_by = $1, reviewed_at = NOW() WHERE case_id = $2`,
        [staffId, caseId]
      );

      // Create rejection note
      await CaseNote.create({
        caseId, authorStaffId: staffId, noteType: 'IntakeRejection',
        content: reason, isVisibleToClient: true,
      });

      await Case.updateStatus(caseId, 'Intake Rejected', { staffId, ipAddress: getClientIP(req) });

      // Notify client
      try {
        await notificationService.notifyUser(
          caseData.user_id, 'intake', 'Intake Requires Resubmission',
          `Your intake form could not be approved. Please review the comments and submit a new intake. Case ID: ${caseId}`,
          'intakeform.html'
        );
      } catch (_) {}

      return res.json({ success: true, message: 'Intake rejected.' });
    } else {
      return res.status(400).json({ success: false, message: 'Decision must be "approve" or "reject".' });
    }
  } catch (error) { next(error); }
};

// ─── POST /api/cases/:caseId/payment/verify ────────────────────────
// Phase 3: Supervising Psychometrician confirms payment received;
// advances case from Awaiting Initial Payment → Awaiting Appointment.
const verifyPayment = async (req, res, next) => {
  try {
    const { caseId } = req.params;
    const staffId = req.user.id;

    const caseData = await Case.findById(caseId);
    if (!caseData) return res.status(404).json({ success: false, message: 'Case not found.' });
    if (caseData.status !== 'Awaiting Initial Payment') {
      return res.status(409).json({ success: false, message: `Case is not awaiting payment (current: ${caseData.status}).` });
    }

    // Mark the most recent pending payment as verified
    await db.query(
      `UPDATE payments SET status = 'verified', verified_by = $1, updated_at = NOW()
       WHERE case_id = $2 AND status IN ('pending','submitted')`,
      [staffId, caseId]
    );

    await Case.updateStatus(caseId, 'Awaiting Appointment', { staffId, ipAddress: getClientIP(req) });

    // Notify client
    try {
      await notificationService.notifyUser(
        caseData.user_id, 'payment', 'Payment Verified',
        `Your payment for Case ID ${caseId} has been verified. Your assessment appointment will be scheduled shortly.`,
        'profile.html'
      );
    } catch (_) {}

    return res.json({ success: true, message: 'Payment verified. Case moved to Awaiting Appointment.' });
  } catch (error) { next(error); }
};

// ─── POST /api/cases/:caseId/schedule ──────────────────────────────
// Phase 4: Schedule appointment for a case
const scheduleAppointment = async (req, res, next) => {
  try {
    const { caseId } = req.params;
    const staffId = req.user.id;
    const { scheduledStart, scheduledEnd, appointmentType, meetingLink, notes } = req.body;

    const caseData = await Case.findById(caseId);
    if (!caseData) return res.status(404).json({ success: false, message: 'Case not found.' });
    if (caseData.status !== 'Awaiting Appointment') {
      return res.status(409).json({ success: false, message: `Case is not awaiting appointment (current: ${caseData.status}).` });
    }

    // An appointment can never be scheduled in the past (date OR time).
    if (!scheduledStart || isNaN(new Date(scheduledStart).getTime()) || new Date(scheduledStart) <= new Date()) {
      return res.status(400).json({ success: false, message: 'The appointment date and time must be in the future.' });
    }

    // Create appointment linked to case
    const result = await db.query(
      `INSERT INTO appointments (case_id, client_id, staff_id, preferred_datetime, approved_datetime, modality, staff_notes, status)
       VALUES ($1, $2, $3, $4, $4, $5, $6, 'confirmed')
       RETURNING *`,
      [caseId, caseData.user_id, caseData.assigned_psychologist_id, scheduledStart, appointmentType || 'Face-to-Face', notes || null]
    );

    await Case.updateStatus(caseId, 'Scheduled', { staffId, ipAddress: getClientIP(req) });

    // Notify client
    try {
      const typeLabel = appointmentType === 'Online' ? 'Online' : 'Face-to-Face';
      let msg = `Your assessment appointment has been confirmed.\nDate: ${new Date(scheduledStart).toLocaleString('en-PH')}\nType: ${typeLabel}`;
      if (appointmentType === 'Online' && meetingLink) msg += `\nMeeting Link: ${meetingLink}`;
      msg += `\nCase ID: ${caseId}`;
      await notificationService.notifyUser(caseData.user_id, 'appointment', 'Your Appointment Has Been Scheduled', msg, 'profile.html');
    } catch (_) {}

    // NOTE: the assigned Psychologist is notified centrally in Case.updateStatus
    // (fires for every path that moves a case to 'Scheduled'), so no per-controller
    // psychologist notification is needed here — that would double-notify them.

    return res.json({ success: true, message: 'Appointment scheduled. Case moved to Scheduled.', data: result.rows[0] });
  } catch (error) { next(error); }
};

// ─── POST /api/cases/:caseId/assessment/start ──────────────────────
// Phase 5: Start assessment
const startAssessment = async (req, res, next) => {
  try {
    const { caseId } = req.params;
    const staffId = req.user.id;

    const caseData = await Case.findById(caseId);
    if (!caseData) return res.status(404).json({ success: false, message: 'Case not found.' });
    if (caseData.status !== 'Scheduled') {
      return res.status(409).json({ success: false, message: `Case is not in Scheduled status (current: ${caseData.status}).` });
    }

    // Guard against duplicates — abort if an assessment row already exists for this case.
    const existing = await ClinicalAssessment.findByCaseId(caseId);
    if (existing.length > 0) {
      return res.status(409).json({ success: false, message: 'An assessment record already exists for this case.' });
    }

    const assessment = await ClinicalAssessment.create({ caseId, psychologistId: staffId });

    // Mark the appointment as completed
    await db.query(
      `UPDATE appointments SET status = 'confirmed', updated_at = NOW() WHERE case_id = $1 AND status = 'confirmed'`,
      [caseId]
    );

    await Case.updateStatus(caseId, 'Assessment In Progress', { staffId, ipAddress: getClientIP(req) });

    // Advance the intake form's review status so it tracks the workflow
    // (Pending → Assessment in Progress) and is persisted for display.
    await db.query(
      `UPDATE intake_forms SET review_status = 'Assessment in Progress' WHERE case_id = $1`,
      [caseId]
    ).catch(() => {});
    await db.query(
      `UPDATE assessment_intake_forms SET review_status = 'Assessment in Progress' WHERE case_id = $1`,
      [caseId]
    ).catch(() => {}); // assessment_intake_forms may not have review_status yet

    // Read-only notification to the client that their assessment has started.
    // Passing a null link keeps it informational (no action button).
    try {
      await notificationService.notifyUser(
        caseData.user_id, 'appointment',
        'Your Assessment Has Started',
        `Your scheduled assessment for Case ID ${caseId} has now started. Please follow your clinician's instructions.`,
        null
      );
    } catch (_) {}

    return res.json({ success: true, message: 'Assessment started.', data: assessment });
  } catch (error) { next(error); }
};

// ─── POST /api/cases/:caseId/assessment/complete ───────────────────
// Phase 5: Complete assessment
const completeAssessment = async (req, res, next) => {
  try {
    const { caseId } = req.params;
    const staffId = req.user.id;
    const { remarks } = req.body;

    const caseData = await Case.findById(caseId);
    if (!caseData) return res.status(404).json({ success: false, message: 'Case not found.' });
    if (caseData.status !== 'Assessment In Progress') {
      return res.status(409).json({ success: false, message: `Case is not in Assessment In Progress (current: ${caseData.status}).` });
    }

    // Find the active assessment — if already completed (e.g. previous attempt
    // crashed mid-flight), skip re-completing and proceed with the status update
    const assessments = await ClinicalAssessment.findByCaseId(caseId);
    const active = assessments.find(a => !a.completed_at);
    const hasAny = assessments.length > 0;
    if (!active && !hasAny) return res.status(404).json({ success: false, message: 'No assessment found for this case.' });

    if (active) {
      await ClinicalAssessment.complete(active.assessment_id);
      if (remarks) await ClinicalAssessment.addRemarks(active.assessment_id, remarks);
    }

    // Release the booked slot so it becomes available for new appointments
    await db.query(
      `UPDATE appointments SET status = 'completed', updated_at = NOW() WHERE case_id = $1 AND status = 'confirmed'`,
      [caseId]
    );

    // Counseling cases have no report — step through Assessment Completed then close
    if (caseData.service_type === 'counseling') {
      await Case.updateStatus(caseId, 'Assessment Completed', { staffId, ipAddress: getClientIP(req) });
      await Case.close(caseId, staffId, getClientIP(req));

      // Reflect completion on the intake form's review status (→ Closed) so it is
      // persisted and shown correctly in Case Management.
      await db.query(
        `UPDATE intake_forms SET review_status = 'Closed' WHERE case_id = $1`,
        [caseId]
      ).catch(() => {});

      try {
        await notificationService.notifyRoles(
          ['clinical_director'], 'report',
          'Counseling Session Completed',
          `The counseling session for Case ID ${caseId} has been completed and the case is now closed.`,
          'case-dashboard.html'
        );
      } catch (_) {}

      // Notify the client their session is complete (read-only / informational).
      try {
        await notificationService.notifyUser(
          caseData.user_id, 'appointment',
          'Your Counseling Session Is Complete',
          `Your counseling session for Case ID ${caseId} has been completed. Thank you for visiting Barcarse Psychological Services.`,
          null
        );
      } catch (_) {}

      return res.json({ success: true, message: 'Session completed. Case closed.' });
    }

    await Case.updateStatus(caseId, 'Assessment Completed', { staffId, ipAddress: getClientIP(req) });

    // Notify the Supervising Psychometrician — they are the next actor and must
    // create the report in PsyGen for this completed assessment. Without this the
    // SupPsy has no prompt that a case is ready for report generation.
    try {
      await notificationService.notifyRoles(
        ['supervising_psychometrician'], 'report',
        'Assessment Completed — Create Report',
        `The assessment for Case ID ${caseId} is complete and ready for report generation. Open the case and click "Create Report in PsyGen".`,
        'case-dashboard.html'
      );
    } catch (_) {}

    // Notify Clinical Director (oversight / FYI)
    try {
      await notificationService.notifyRoles(
        ['clinical_director'], 'report',
        'Assessment Completed',
        `The assessment for Case ID ${caseId} has been completed by the assigned psychologist.`,
        'case-dashboard.html'
      );
    } catch (_) {}

    // Notify the client their assessment is complete (read-only / informational).
    try {
      await notificationService.notifyUser(
        caseData.user_id, 'appointment',
        'Your Assessment Is Complete',
        `Your assessment for Case ID ${caseId} has been completed. Your report will be prepared and you will be notified once it is ready.`,
        null
      );
    } catch (_) {}

    return res.json({ success: true, message: 'Assessment completed. Case moved to Assessment Completed.' });
  } catch (error) { next(error); }
};

// ─── POST /api/cases/:caseId/report/submit ─────────────────────────
// Phase 6: Submit report for director approval
const submitReportForApproval = async (req, res, next) => {
  try {
    const { caseId } = req.params;
    const { reportId } = req.body;
    const staffId = req.user.id;

    const caseData = await Case.findById(caseId);
    if (!caseData) return res.status(404).json({ success: false, message: 'Case not found.' });

    // Allow submission from Assessment Completed or Report Drafting
    if (!['Assessment Completed', 'Report Drafting'].includes(caseData.status)) {
      return res.status(409).json({ success: false, message: `Case cannot accept report submission (current: ${caseData.status}).` });
    }

    // Update report status
    if (reportId) {
      await db.query(
        `UPDATE psychological_reports SET status = 'submitted', updated_at = NOW() WHERE id = $1`,
        [reportId]
      );
    }

    // If coming from Assessment Completed, transition through Report Drafting first
    if (caseData.status === 'Assessment Completed') {
      await Case.updateStatus(caseId, 'Report Drafting', { staffId, ipAddress: getClientIP(req) });
    }
    await Case.updateStatus(caseId, 'Awaiting Director Approval', { staffId, ipAddress: getClientIP(req) });

    // Notify Clinical Director
    try {
      await notificationService.notifyRoles(
        ['clinical_director'], 'report',
        'Report Awaiting Your Approval',
        `A report has been submitted for review.\nCase ID: ${caseId}`,
        'case-dashboard.html'
      );
    } catch (_) {}

    return res.json({ success: true, message: 'Report submitted for director approval.' });
  } catch (error) { next(error); }
};

// ─── POST /api/cases/:caseId/report/approve ────────────────────────
// Phase 7: Director approves report
const approveReport = async (req, res, next) => {
  try {
    const { caseId } = req.params;
    const { reportId } = req.body;
    const staffId = req.user.id;

    const caseData = await Case.findById(caseId);
    if (!caseData) return res.status(404).json({ success: false, message: 'Case not found.' });
    if (caseData.status !== 'Awaiting Director Approval') {
      return res.status(409).json({ success: false, message: `Case is not awaiting director approval (current: ${caseData.status}).` });
    }

    if (reportId) {
      await db.query(
        `UPDATE psychological_reports SET status = 'approved', updated_at = NOW() WHERE id = $1`,
        [reportId]
      );
    }

    await Case.updateStatus(caseId, 'Report Approved', { staffId, ipAddress: getClientIP(req) });

    // Notify assigned psychologist
    try {
      await notificationService.notifyUser(
        caseData.assigned_psychologist_id, 'report',
        'Report Approved',
        `The report for Case ID ${caseId} has been approved by the Clinical Director. The case is now ready for client report requests.`,
        'case-dashboard.html'
      );
    } catch (_) {}

    return res.json({ success: true, message: 'Report approved.' });
  } catch (error) { next(error); }
};

// ─── POST /api/cases/:caseId/report/reject ─────────────────────────
// Phase 7: Director returns report for revision
const rejectReport = async (req, res, next) => {
  try {
    const { caseId } = req.params;
    const { reportId, revisionNotes } = req.body;
    const staffId = req.user.id;

    const caseData = await Case.findById(caseId);
    if (!caseData) return res.status(404).json({ success: false, message: 'Case not found.' });
    if (caseData.status !== 'Awaiting Director Approval') {
      return res.status(409).json({ success: false, message: `Case is not awaiting director approval (current: ${caseData.status}).` });
    }

    if (!revisionNotes) return res.status(400).json({ success: false, message: 'Revision notes are required.' });

    if (reportId) {
      await db.query(
        `UPDATE psychological_reports SET status = 'draft', revision_notes = $1, updated_at = NOW() WHERE id = $2`,
        [revisionNotes, reportId]
      );
    }

    await CaseNote.create({
      caseId, authorStaffId: staffId, noteType: 'ReportRevision',
      content: revisionNotes, isVisibleToClient: false,
    });

    await Case.updateStatus(caseId, 'Report Drafting', { staffId, ipAddress: getClientIP(req) });

    // Notify psychologist
    try {
      await notificationService.notifyUser(
        caseData.assigned_psychologist_id, 'report',
        'Report Returned for Revision',
        `The Clinical Director has requested revisions to the report for Case ID ${caseId}. Please review the revision notes and resubmit.`,
        'case-dashboard.html'
      );
    } catch (_) {}

    return res.json({ success: true, message: 'Report returned for revision.' });
  } catch (error) { next(error); }
};

// ─── POST /api/cases/:caseId/report/release ────────────────────────
// Phase 11: Release report to client
const releaseReport = async (req, res, next) => {
  try {
    const { caseId } = req.params;
    const { reportId } = req.body;
    const staffId = req.user.id;

    const caseData = await Case.findById(caseId);
    if (!caseData) return res.status(404).json({ success: false, message: 'Case not found.' });
    if (caseData.status !== 'Ready for Release' && caseData.status !== 'Report Approved') {
      return res.status(409).json({ success: false, message: `Case is not ready for release (current: ${caseData.status}).` });
    }

    // Atomically update report, case, and request. Mark the report released and
    // bind it to THIS case's client so the client can view it in their profile.
    if (reportId) {
      await db.query(
        `UPDATE psychological_reports
         SET status = 'finalized', signature_stage = 'released',
             client_id = COALESCE(client_id, $2),
             released_by = $3, released_at = NOW(), is_locked = TRUE, updated_at = NOW()
         WHERE id = $1`,
        [reportId, caseData.user_id, staffId]
      );
    }

    await Case.updateStatus(caseId, 'Released', { staffId, ipAddress: getClientIP(req) });

    // Notify the exact client this case belongs to. "View Report" opens the
    // signed PDF directly when we know the report; otherwise their reports list.
    try {
      await notificationService.notifyUser(
        caseData.user_id, 'report',
        'Your Psychological Report Has Been Released',
        `Your assessment report for Case ID ${caseId} has been released. Click View Report to open it.`,
        reportId ? `client-report:${reportId}` : 'profile.html?section=reports'
      );
    } catch (_) {}

    return res.json({ success: true, message: 'Report released to client.' });
  } catch (error) { next(error); }
};

// ─── POST /api/cases/:caseId/close ─────────────────────────────────
// Phase 12: Close case
const closeCase = async (req, res, next) => {
  try {
    const { caseId } = req.params;
    const staffId = req.user.id;

    const caseData = await Case.findById(caseId);
    if (!caseData) return res.status(404).json({ success: false, message: 'Case not found.' });
    if (caseData.status !== 'Released') {
      return res.status(409).json({ success: false, message: `Case is not in Released status (current: ${caseData.status}).` });
    }

    await Case.close(caseId, staffId, getClientIP(req));

    return res.json({ success: true, message: 'Case closed.' });
  } catch (error) { next(error); }
};

// ─── POST /api/cases/:caseId/notes ─────────────────────────────────
const addNote = async (req, res, next) => {
  try {
    const { caseId } = req.params;
    const { noteType, content, isVisibleToClient } = req.body;
    const { role, id: userId } = req.user;

    if (!content) return res.status(400).json({ success: false, message: 'Note content is required.' });

    const note = await CaseNote.create({
      caseId,
      authorStaffId: isStaff(role) ? userId : null,
      authorUserId: role === 'client' ? userId : null,
      noteType: noteType || 'General',
      content,
      isVisibleToClient: isVisibleToClient !== false,
    });

    return res.json({ success: true, data: note });
  } catch (error) { next(error); }
};

// ─── GET /api/cases/:caseId/notes ──────────────────────────────────
const getNotes = async (req, res, next) => {
  try {
    const { role } = req.user;
    const notes = await CaseNote.findByCaseId(req.params.caseId, { includeInternal: isStaff(role) });
    return res.json({ success: true, data: notes });
  } catch (error) { next(error); }
};

// ─── GET /api/cases/:caseId/audit ──────────────────────────────────
const getAuditTrail = async (req, res, next) => {
  try {
    const audit = await CaseAuditLog.findByCaseId(req.params.caseId);
    return res.json({ success: true, data: audit });
  } catch (error) { next(error); }
};

// ─── POST /api/cases/:caseId/reassign ──────────────────────────────
const reassignPsychologist = async (req, res, next) => {
  try {
    const { caseId } = req.params;
    const { psychologistId } = req.body;
    const staffId = req.user.id;

    if (!psychologistId) return res.status(400).json({ success: false, message: 'Psychologist ID is required.' });

    await Case.reassignPsychologist(caseId, psychologistId, staffId, getClientIP(req));

    return res.json({ success: true, message: 'Psychologist reassigned.' });
  } catch (error) { next(error); }
};

// ─── POST /api/cases/:caseId/no-show ───────────────────────────────
// Handle no-show: close the case (and its review status).
const handleNoShow = async (req, res, next) => {
  try {
    const { caseId } = req.params;
    const staffId = req.user.id;

    const caseData = await Case.findById(caseId);
    if (!caseData) return res.status(404).json({ success: false, message: 'Case not found.' });
    if (caseData.status !== 'Scheduled') {
      return res.status(409).json({ success: false, message: `Case is not in Scheduled status.` });
    }

    // Mark appointment as no-show
    await db.query(
      `UPDATE appointments SET status = 'cancelled', staff_notes = 'No Show', updated_at = NOW()
       WHERE case_id = $1 AND status = 'confirmed'`,
      [caseId]
    );

    // A no-show closes the case; the intake form's review status is closed too.
    await Case.close(caseId, staffId, getClientIP(req));
    await db.query(
      `UPDATE intake_forms SET review_status = 'Closed' WHERE case_id = $1`,
      [caseId]
    ).catch(() => {});
    await db.query(
      `UPDATE assessment_intake_forms SET review_status = 'Closed' WHERE case_id = $1`,
      [caseId]
    ).catch(() => {}); // assessment_intake_forms may not have review_status yet

    // Notify client
    try {
      await notificationService.notifyUser(
        caseData.user_id, 'appointment',
        'Missed Appointment — Case Closed',
        `You missed your scheduled appointment for Case ID ${caseId}. The case has been closed. Please contact the clinic if you wish to book again.`,
        null
      );
    } catch (_) {}

    return res.json({ success: true, message: 'No-show recorded. Case closed.' });
  } catch (error) { next(error); }
};

// ─── DELETE /api/cases/:caseId/permanent ─────────────────────────
// Clinical Director only. Hard-deletes an archived case and all CASCADE children.
const permanentDeleteCase = async (req, res, next) => {
  try {
    const { caseId } = req.params;
    const exists = await db.query(
      `SELECT case_id FROM cases WHERE case_id = $1 AND archived_at IS NOT NULL`,
      [caseId]
    );
    if (exists.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Archived case not found.' });
    }
    await db.query(`DELETE FROM cases WHERE case_id = $1`, [caseId]);
    return res.json({ success: true, message: `Case ${caseId} permanently deleted.` });
  } catch (error) { next(error); }
};

// ─── DELETE /api/cases/permanent/bulk ────────────────────────────
// Clinical Director only. Hard-deletes multiple archived cases.
const permanentDeleteCases = async (req, res, next) => {
  try {
    const { caseIds } = req.body;
    if (!Array.isArray(caseIds) || caseIds.length === 0) {
      return res.status(400).json({ success: false, message: 'No case IDs provided.' });
    }
    const result = await db.query(
      `DELETE FROM cases WHERE case_id = ANY($1::varchar[]) AND archived_at IS NOT NULL RETURNING case_id`,
      [caseIds]
    );
    return res.json({ success: true, deleted: result.rows.map(r => r.case_id) });
  } catch (error) { next(error); }
};

// ─── GET /api/cases/archived ──────────────────────────────────────
// Clinical Director only. Returns all soft-archived cases.
const getArchivedCases = async (req, res, next) => {
  try {
    const cases = await Case.findAllArchived();
    return res.json({ success: true, data: cases });
  } catch (error) { next(error); }
};

// ─── POST /api/cases/:caseId/restore ──────────────────────────────
// Clinical Director only. Unarchives a case by clearing archived_at.
const restoreCase = async (req, res, next) => {
  try {
    const { caseId } = req.params;
    const exists = await db.query(
      `SELECT case_id FROM cases WHERE case_id = $1 AND archived_at IS NOT NULL`,
      [caseId]
    );
    if (exists.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Archived case not found.' });
    }
    await db.query(
      `UPDATE cases SET archived_at = NULL, updated_at = NOW() WHERE case_id = $1`,
      [caseId]
    );
    return res.json({ success: true, message: `Case ${caseId} restored.` });
  } catch (error) { next(error); }
};

// ─── DELETE /api/cases/:caseId ────────────────────────────────────
// Clinical Director only. Soft-archives a case by setting archived_at.
// The row and all child data are preserved; the case simply disappears
// from all list and detail queries (which filter archived_at IS NULL).
const deleteCase = async (req, res, next) => {
  try {
    const { caseId } = req.params;

    const exists = await db.query(
      `SELECT case_id FROM cases WHERE case_id = $1 AND archived_at IS NULL`,
      [caseId]
    );
    if (exists.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Case not found.' });
    }

    await db.query(
      `UPDATE cases SET archived_at = NOW(), updated_at = NOW() WHERE case_id = $1`,
      [caseId]
    );

    return res.json({ success: true, message: `Case ${caseId} archived.` });
  } catch (error) { next(error); }
};

module.exports = {
  getCases, getCaseById, reviewIntake, verifyPayment, scheduleAppointment,
  startAssessment, completeAssessment,
  submitReportForApproval, approveReport, rejectReport, releaseReport,
  closeCase, addNote, getNotes, getAuditTrail,
  reassignPsychologist, handleNoShow, deleteCase,
  getArchivedCases, restoreCase,
  permanentDeleteCase, permanentDeleteCases,
};
