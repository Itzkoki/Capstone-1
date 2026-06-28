const Payment = require('../models/Payment');
const Appointment = require('../models/Appointment');
const User = require('../models/User');
const ActivityLog = require('../models/ActivityLog');
const CaseAuditLog = require('../models/CaseAuditLog');
const RequestAuditLog = require('../models/RequestAuditLog');
const Case = require('../models/Case');
const notificationService = require('../services/notificationService');
const securityEvents = require('../services/securityEvents');

// Resolve the psychologist (staff_id) who should act on a report concern.
// Prefers the stamped client_requests.assigned_psychologist_id; falls back to the
// PSYCHOLOGIST who finalized the linked report (psychological_reports.approved_by,
// the author of record) — or its preparer (psychologist_id) for solo-authored
// reports — and backfills assigned_psychologist_id so future lookups are O(1).
// Returns null if none is available.
async function resolveConcernPsychologistId(db, cr) {
  if (cr && cr.assigned_psychologist_id != null) return cr.assigned_psychologist_id;
  if (!cr || cr.report_id == null) return null;
  try {
    const r = await db.query(`SELECT psychologist_id, approved_by FROM psychological_reports WHERE id = $1`, [cr.report_id]);
    const psyId = r.rows[0] && (r.rows[0].approved_by || r.rows[0].psychologist_id);
    if (psyId != null) {
      await db.query(`UPDATE client_requests SET assigned_psychologist_id = $1 WHERE id = $2`, [psyId, cr.id]).catch(() => {});
      return psyId;
    }
  } catch (e) {
    console.error('resolveConcernPsychologistId failed:', e.message);
  }
  return null;
}

/**
 * ── Clinic payment configuration ────────────────────────────────
 * The clinic uses a single static GCash / InstaPay QR. The amounts
 * below are what the client is instructed to enter when scanning.
 * Adjust these to match the clinic's actual service fee schedule.
 */
const PAYMENT_CONFIG = {
  totalFee: 2.00,           // full service fee
  fullAmount: 2.00,         // pay 100% online
  halfAmount: 1.00,         // pay 50% online, remainder in person
  method: 'GCash',
  // Static QR images served from the frontend root.
  qr: {
    full: 'qr-full-payment.jpg',
    half: 'qr-half-payment.jpg',
  },
  account: {
    name: 'JO*N YE*J B.',
    mobile: '0905 664 ••••',
  },
};

// Accepted proof formats and size guard (base64 data-URL length).
const ACCEPTED_PROOF_MIMES = ['image/jpeg', 'image/jpg', 'image/png', 'application/pdf'];
const MAX_PROOF_LEN = 7_000_000; // ~5 MB of binary content

const getClientIP = (req) =>
  req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
  req.connection?.remoteAddress || req.ip || 'unknown';

// Maps the client's "reason for referral" radio choice (assessment-intake.html)
// to the assessment_type slug the Supervising Psychometrician confirms with.
// Used as a fallback for older bookings whose appointment never recorded a type.
const REFERRAL_TO_ASSESSMENT_TYPE = {
  'neurodevelopmental assessment': 'neurodevelopmental',
  'clinical assessment': 'clinical',
  'pre-employment/neuropsychological': 'pre_employment',
};

/**
 * Build the human-readable service label for an assessment payment, mirroring
 * how counseling payments are labelled "Counseling". The confirmed assessment_type
 * is a slug (e.g. "neurodevelopmental", "pre_employment"); turn it into a
 * Title-Cased suffix → "Assessment — Neurodevelopmental". When the type is
 * missing (legacy bookings) we derive it from the intake form's referral reason,
 * and only fall back to a plain "Assessment" when neither is available.
 */
function formatAssessmentLabel(assessmentType, reasonForReferral) {
  let type = assessmentType || null;
  if (!type && reasonForReferral) {
    type = REFERRAL_TO_ASSESSMENT_TYPE[String(reasonForReferral).trim().toLowerCase()] || null;
  }
  if (!type) return 'Assessment';
  const pretty = String(type)
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
  return `Assessment — ${pretty}`;
}

/**
 * Mark the appointment's payment_status. Under the clinic's strict
 * no-cancellation policy, a failed/expired payment never cancels the
 * agreed appointment — the client may simply submit a new payment.
 */
async function setApptPaymentStatus(appointmentId, paymentStatus) {
  if (!appointmentId) return;
  try {
    const db = require('../config/db');
    await db.query(
      `UPDATE appointments SET payment_status = $1 WHERE id = $2`,
      [paymentStatus, appointmentId]
    );
  } catch (err) {
    console.error('Failed to update payment_status for appointment', appointmentId, err.message);
  }
}

/**
 * Expire stale pending holds. The agreed appointment is kept intact; only
 * the lapsed payment is expired so the client can start a new one.
 */
async function sweepExpired() {
  try {
    const expired = await Payment.expireStale();
    for (const p of expired) {
      await setApptPaymentStatus(p.appointment_id, 'expired');
      try {
        await notificationService.notifyUser(
          p.client_id, 'payment', 'Payment Window Expired',
          `Your payment window for reference ${p.reference_number} expired because no proof of payment was received within 24 hours. Your confirmed schedule is still held — please open your appointment and submit a new payment.`,
          'profile.html'
        );
      } catch (_) { /* non-fatal */ }
    }
  } catch (err) {
    console.error('sweepExpired failed:', err.message);
  }
}

/**
 * POST /api/payments
 * Create a payment record for a booking. The server is the sole authority
 * for the reference number and the amount due (never trusts client input).
 * Body: { intakeFormId, appointmentId, paymentOption: 'half'|'full', serviceLabel }
 */
const createPayment = async (req, res, next) => {
  try {
    const clientId = req.user.id;
    const { intakeFormId, appointmentId, paymentOption, serviceLabel, agreed } = req.body;

    if (!paymentOption || !['half', 'full'].includes(paymentOption)) {
      return res.status(400).json({
        success: false,
        message: "Payment option must be either 'half' or 'full'.",
      });
    }

    // The client must accept the no-refund / no-cancellation policy (and that
    // the schedule can no longer be changed once paid) before any payment is
    // created. We store this acknowledgement on the payment record.
    const agreedNoCancellation = (agreed === true || agreed === 1 || agreed === '1') ? 1 : 0;
    if (agreedNoCancellation !== 1) {
      return res.status(400).json({
        success: false,
        message: 'You must accept the no-refund and no-cancellation policy before proceeding to payment.',
      });
    }

    // Service label shown on the payment verification page. We derive it
    // server-side from the appointment so assessment bookings get a label
    // (e.g. "Assessment — Neurodevelopmental") just like counseling and
    // report-request payments do — never trusting any client-supplied value.
    let effectiveServiceLabel = serviceLabel || null;

    // Payment is only offered after a schedule has been mutually agreed.
    // Guard: the linked appointment must belong to the client and be in an
    // agreed state ('approved' or 'confirmed').
    if (appointmentId) {
      const appt = await Appointment.findById(appointmentId);
      if (!appt || appt.client_id !== clientId) {
        return res.status(404).json({ success: false, message: 'Appointment not found.' });
      }
      if (appt.status !== 'confirmed') {
        return res.status(409).json({
          success: false,
          message: 'Payment becomes available only after the Supervising Psychometrician has confirmed your appointment.',
        });
      }
      // Prevent duplicate active payments for the same booking.
      const active = await Payment.findActiveByAppointment(appointmentId);
      if (active) {
        return res.status(409).json({
          success: false,
          message: `A ${active.status === 'verified' ? 'verified' : 'pending'} payment already exists for this appointment.`,
          data: { id: active.id, status: active.status, reference_number: active.reference_number },
        });
      }

      // Assessment appointments are distinguished by a promoted/pending
      // assessment form or a confirmed assessment type; everything else on the
      // appointment flow is counseling.
      const isAssessment = !!appt.assessment_form_id || !!appt.assessment_type;
      if (isAssessment) {
        // Prefer the confirmed type; if it's missing, fall back to the intake
        // form's referral reason so the label still reflects the real service.
        let reasonForReferral = null;
        if (!appt.assessment_type && appt.assessment_form_id) {
          try {
            const db = require('../config/db');
            const r = await db.query(
              `SELECT reason_for_referral FROM assessment_intake_forms WHERE id = $1`,
              [appt.assessment_form_id]
            );
            reasonForReferral = r.rows[0]?.reason_for_referral || null;
          } catch (_) { /* non-fatal — falls back to plain "Assessment" */ }
        }
        effectiveServiceLabel = formatAssessmentLabel(appt.assessment_type, reasonForReferral);
      } else {
        effectiveServiceLabel = 'Counseling';
      }
    }

    const amountDue = paymentOption === 'full'
      ? PAYMENT_CONFIG.fullAmount
      : PAYMENT_CONFIG.halfAmount;
    const outstandingBalance = paymentOption === 'half'
      ? +(PAYMENT_CONFIG.totalFee - amountDue).toFixed(2)
      : 0;

    const referenceNumber = await Payment.generateReferenceNumber();

    const payment = await Payment.create({
      referenceNumber,
      intakeFormId,
      appointmentId,
      clientId,
      serviceLabel: effectiveServiceLabel,
      paymentOption,
      paymentMethod: PAYMENT_CONFIG.method,
      amountDue,
      totalFee: PAYMENT_CONFIG.totalFee,
      outstandingBalance,
      agreedNoCancellation,
      expiresInMinutes: 7,
    });

    // Track that this appointment now has a payment in progress. NOTE: this
    // does NOT reserve the time slot — slots are only reserved once the payment
    // is verified (see Appointment.getBookedSlots / countByDate, which count
    // only paid_verified appointments).
    if (appointmentId) {
      try {
        const db = require('../config/db');
        await db.query(
          `UPDATE appointments SET payment_status = 'pending' WHERE id = $1`,
          [appointmentId]
        );
      } catch (_) { /* non-fatal */ }
    }

    const qrImage = paymentOption === 'full'
      ? PAYMENT_CONFIG.qr.full
      : PAYMENT_CONFIG.qr.half;

    return res.status(201).json({
      success: true,
      message: 'Payment reference generated. Please complete payment within 24 hours.',
      data: {
        id: payment.id,
        reference_number: payment.reference_number,
        payment_option: payment.payment_option,
        payment_method: payment.payment_method,
        amount_due: Number(payment.amount_due),
        total_fee: Number(payment.total_fee),
        outstanding_balance: Number(payment.outstanding_balance),
        status: payment.status,
        expires_at: payment.expires_at,
        qr_image: qrImage,
        account: PAYMENT_CONFIG.account,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/payments/:id/proof
 * Client uploads proof of payment (base64 data-URL). Moves to under_review.
 * Body: { proof: dataUrl, filename }
 */
const uploadProof = async (req, res, next) => {
  try {
    const clientId = req.user.id;
    const paymentId = req.params.id;
    const { proof, filename } = req.body;

    const payment = await Payment.findById(paymentId);
    if (!payment) {
      return res.status(404).json({ success: false, message: 'Payment record not found.' });
    }
    if (payment.client_id !== clientId) {
      securityEvents.record({
        module: 'payments', eventType: 'payment_tamper',
        userId: clientId, subjectKind: 'user', ip: req.ip,
        details: `Client #${clientId} attempted to upload proof to payment #${paymentId} owned by another client.`,
      });
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }
    // Allow a fresh proof either while pending, or after a rejection (resend a
    // clearer screenshot). Rejected re-submissions are not subject to the
    // payment window — the client already paid, they're just resending proof.
    const isResubmit = payment.status === 'rejected';
    if (!isResubmit) {
      if (payment.status === 'expired' || new Date(payment.expires_at) < new Date()) {
        return res.status(409).json({
          success: false,
          message: 'This payment window has expired. Please restart the booking process.',
        });
      }
      if (payment.status !== 'pending') {
        return res.status(409).json({
          success: false,
          message: `Proof can only be uploaded while the payment is pending (current status: ${payment.status}).`,
        });
      }
    }

    // ── Validate the uploaded proof file ──
    if (!proof || typeof proof !== 'string' || !proof.startsWith('data:')) {
      return res.status(400).json({ success: false, message: 'A valid proof of payment file is required.' });
    }
    const mimeMatch = proof.match(/^data:([^;]+);base64,/);
    if (!mimeMatch) {
      return res.status(400).json({ success: false, message: 'Proof must be a base64-encoded file.' });
    }
    const mime = mimeMatch[1].toLowerCase();
    if (!ACCEPTED_PROOF_MIMES.includes(mime)) {
      return res.status(400).json({
        success: false,
        message: 'Unsupported file type. Please upload a JPG, PNG, or PDF.',
      });
    }
    if (proof.length > MAX_PROOF_LEN) {
      return res.status(400).json({
        success: false,
        message: 'File is too large. Please upload a file under 5 MB.',
      });
    }

    const updated = await Payment.attachProof(paymentId, {
      dataUrl: proof,
      filename: typeof filename === 'string' ? filename.slice(0, 255) : null,
      mime,
    });
    if (!updated) {
      return res.status(409).json({ success: false, message: 'Could not record proof of payment. Please try again.' });
    }

    // Record the submission on the Audit TRAIL ("Payment Verification" module)
    // so the full payment lifecycle is captured. Ticket/report submissions are
    // logged via requestController; here we cover appointment payments to avoid
    // double-logging the request-linked ones.
    if (!updated.client_request_id) {
      await CaseAuditLog.log({
        tableName: 'payments',
        recordId: updated.id,
        action: 'PAYMENT_SUBMITTED',
        userId: clientId,
        oldValue: { status: 'pending' },
        newValue: { status: 'under_review', reference: updated.reference_number },
        ipAddress: getClientIP(req),
      });
    }

    // Notify the client of receipt…
    try {
      await notificationService.notifyUser(
        clientId, 'payment', 'Proof of Payment Received',
        `We received your proof of payment for reference ${updated.reference_number}. It is now under review by our team. You will be notified once it is verified.`,
        'profile.html'
      );
    } catch (_) { /* non-fatal */ }

    // …and notify the payment-verification owners (Supervising Psychometrician)
    // plus the Clinical Director that a payment is now awaiting verification.
    // The payments table has no case_id column, so resolve it via the linked
    // appointment so "Verify Payment" deep-links to the matching case.
    try {
      const db = require('../config/db');
      let caseId = updated.case_id || null;
      if (!caseId && updated.appointment_id) {
        const apptRow = await db.query(
          `SELECT case_id FROM appointments WHERE id = $1`,
          [updated.appointment_id]
        );
        caseId = apptRow.rows[0] && apptRow.rows[0].case_id;
      }
      await notificationService.notifyRoles(
        ['supervising_psychometrician', 'clinical_director'],
        'payment', 'Payment Awaiting Verification',
        `A client has submitted a proof of payment (ref ${updated.reference_number}). Click Verify Payment to review it in case management.`,
        caseId
          ? `case-dashboard.html?case=${encodeURIComponent(caseId)}`
          : `payments-admin.html?paymentId=${updated.id}`
      );
    } catch (_) { /* non-fatal */ }

    return res.status(200).json({
      success: true,
      message: 'Proof of payment submitted. Your payment is now under review.',
      data: { id: updated.id, status: updated.status, reference_number: updated.reference_number },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/payments
 * Clients see their own; staff see all. Lazily sweeps expired holds first.
 */
const getPayments = async (req, res, next) => {
  try {
    await sweepExpired();
    const { role, id: userId } = req.user;
    const { status } = req.query;

    const rows = role === 'client'
      ? await Payment.findByClient(userId, { status })
      : await Payment.findAll({ status });

    // Clients should not receive the (potentially large) proof blob in the list.
    const data = rows.map(r => {
      const out = { ...r };
      if (role === 'client') delete out.proof_of_payment;
      return out;
    });

    return res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/payments/counts  (staff)
 */
const getPaymentCounts = async (req, res, next) => {
  try {
    await sweepExpired();
    const counts = await Payment.countByStatus();
    return res.status(200).json({ success: true, data: counts });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/payments/:id
 * Full record including proof. Clients limited to their own.
 */
const getPayment = async (req, res, next) => {
  try {
    const { role, id: userId } = req.user;
    const payment = await Payment.findById(req.params.id);
    if (!payment) {
      return res.status(404).json({ success: false, message: 'Payment record not found.' });
    }
    if (role === 'client' && payment.client_id !== userId) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }
    return res.status(200).json({ success: true, data: payment });
  } catch (error) {
    next(error);
  }
};

/**
 * PUT /api/payments/:id/verify  (staff only)
 * Body: { action: 'approve'|'reject', note }
 * Approve  → status verified, slot reserved, balance recorded for half payments.
 * Reject   → status rejected, slot released, client notified with reason.
 */
const verifyPayment = async (req, res, next) => {
  try {
    const adminId = req.user.id;
    const { action, note } = req.body;

    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ success: false, message: "Action must be 'approve' or 'reject'." });
    }

    const payment = await Payment.findById(req.params.id);
    if (!payment) {
      return res.status(404).json({ success: false, message: 'Payment record not found.' });
    }
    if (payment.status !== 'under_review') {
      return res.status(409).json({
        success: false,
        message: `Only payments under review can be verified (current status: ${payment.status}).`,
      });
    }

    // Report-request payments are verified EXCLUSIVELY by the Supervising
    // Psychometrician (the verification was relocated out of the Report Requests
    // section into this Payment Verification module — the Clinical Director no
    // longer verifies them).
    if (payment.module === 'report_request' && req.user.role !== 'supervising_psychometrician') {
      return res.status(403).json({
        success: false,
        message: 'Only the Supervising Psychometrician can verify report-request payments.',
      });
    }

    const db = require('../config/db');

    if (action === 'approve') {
      const updated = await Payment.verify(req.params.id, adminId, note);
      if (!updated) {
        return res.status(409).json({ success: false, message: 'Could not verify payment. Please refresh and try again.' });
      }

      // Reserve the slot
      if (updated.appointment_id) {
        await db.query(
          `UPDATE appointments SET payment_status = 'paid_verified' WHERE id = $1`,
          [updated.appointment_id]
        );

        // Payment verified → NOW store the client's intake form in intake_forms
        // (promoted from the appointment's staging buffer). This is the only
        // point at which the intake form is persisted.
        try {
          const { promoteIntakeForAppointment } = require('../services/intakePromote');
          await promoteIntakeForAppointment(updated.appointment_id);
        } catch (e) {
          console.error('Intake promotion on verify failed:', e.message);
        }
        // NOTE: the assigned Psychologist is notified centrally in
        // Case.updateStatus when the case transitions to 'Scheduled' (below).
      }

      await ActivityLog.log(adminId, 'VERIFY_PAYMENT', 'payment', updated.id,
        getClientIP(req), { reference: updated.reference_number, amount: updated.amount_due, note: note || null });

      // Record on the Audit TRAIL ("Payment Verification" module) so the
      // Clinical Director's audit trail shows who verified the payment. The
      // verifier (SupPsy or CD) is a staff-table account → changed_by_staff_id.
      await CaseAuditLog.log({
        tableName: 'payments',
        recordId: updated.id,
        action: 'PAYMENT_VERIFIED',
        staffId: adminId,
        oldValue: { status: 'under_review' },
        newValue: { status: 'verified', reference: updated.reference_number },
        ipAddress: getClientIP(req),
      });

      // Notify client + staff for APPOINTMENT payments only. Report-request and
      // report-concern payments have no appointment slot, so the "Slot Confirmed"
      // / "Payment Successful" appointment messages don't apply — those flows send
      // their own client notification in the report_request branch below.
      if (updated.appointment_id) {
        // Notify client — include outstanding balance reminder for half payments
        let msg = `Your payment (reference ${updated.reference_number}) has been verified and your appointment slot is now reserved.`;
        if (updated.payment_option === 'half' && Number(updated.outstanding_balance) > 0) {
          msg += ` A remaining balance of ₱${Number(updated.outstanding_balance).toFixed(2)} is to be paid in person at the clinic on the day of your appointment.`;
        }
        try {
          await notificationService.notifyUser(updated.client_id, 'payment', 'Payment Verified — Slot Confirmed', msg, `receipt.html?payment=${updated.id}`);
        } catch (_) { /* non-fatal */ }

        // Staff receive ONLY this confirmation event — never the in-progress
        // payment workflow. It announces a successfully completed payment and links
        // to the read-only payments dashboard (not the client payment page).
        try {
          const client = await User.findById(updated.client_id);
          const clientName = client ? client.full_name : 'A client';
          await notificationService.notifyRoles(
            ['supervising_psychometrician', 'clinical_director'],
            'payment', 'Payment Successful',
            `Payment ${updated.reference_number} (₱${Number(updated.amount_due).toFixed(2)}, ${updated.payment_option} payment) from ${clientName} has been completed and verified.`,
            'payments-admin.html'
          );
        } catch (_) { /* non-fatal */ }
      }

      // ── Case status transition after payment verified ──
      // payments table has no case_id — look it up via appointment_id.
      if (updated.appointment_id) {
        try {
          const apptRow = await db.query(
            `SELECT case_id FROM appointments WHERE id = $1`,
            [updated.appointment_id]
          );
          const caseId = apptRow.rows[0] && apptRow.rows[0].case_id;
          if (caseId) {
            const caseData = await Case.findById(caseId);
            if (caseData && caseData.status === 'Awaiting Initial Payment') {
              // New flow: appointment confirmed BEFORE payment → jump to Scheduled.
              // Old flow fallback: go to Awaiting Appointment if no confirmed appointment yet.
              const confirmedAppt = await db.query(
                `SELECT id FROM appointments WHERE case_id = $1 AND status = 'confirmed' LIMIT 1`,
                [caseId]
              );
              const nextStatus = confirmedAppt.rows.length > 0 ? 'Scheduled' : 'Awaiting Appointment';
              await Case.updateStatus(caseId, nextStatus, {
                staffId: adminId,
                ipAddress: getClientIP(req),
              });
            }
          }
        } catch (e) {
          console.error('Case transition on payment verify failed:', e.message);
        }
      }

      // ── Report-request payment → mirror the verified status back onto the
      // ticket (issue a receipt) and log it on the ticket's own audit trail. No
      // appointment/slot/case logic applies (those branches above are guarded by
      // appointment_id, which is null for report-request payments).
      if (updated.module === 'report_request' && updated.client_request_id) {
        // Payment state lives on the payment row (just set to 'verified'); the
        // request derives its status from it — no client_requests columns to write.
        const receiptNumber = `${updated.reference_number}-RCPT`;
        try {
          await RequestAuditLog.log(updated.client_request_id, adminId, 'PAYMENT_APPROVED',
            `Payment verified in the Payment Verification module. Receipt ${receiptNumber} issued (ref ${updated.reference_number}).`);
        } catch (_) { /* non-fatal */ }

        // ── Report-CONCERN payment verified (spec §4 success) ──
        // Advance the concern to "Payment Verified" and notify the assigned
        // Psychologist to review the concern + modify the report.
        const creq = await db.query(
          `SELECT id, nature, ticket_number, report_id, assigned_psychologist_id, concern_status, is_legacy
           FROM client_requests WHERE id = $1`, [updated.client_request_id]);
        const cr = creq.rows[0];

        // ── Legacy request (copy OR concern) payment verified ──
        // Legacy requests are NOT modified in the report module — the digitized
        // report is delivered as-is. So skip the concern-modify flow entirely and
        // simply flag the request "Payment Verified" + tell the CD to release it
        // from the Legacy Verifications console.
        if (cr && cr.is_legacy) {
          if (cr.nature === 'report_concern') {
            await db.query(`UPDATE client_requests SET concern_status = 'Payment Verified', updated_at = NOW() WHERE id = $1`, [cr.id]);
          }
          try {
            await RequestAuditLog.log(cr.id, adminId, 'LEGACY_PAYMENT_VERIFIED',
              `Legacy ${cr.nature === 'report_concern' ? 'concern' : 'copy'} payment verified (ref ${updated.reference_number}). Ready to release.`);
          } catch (_) { /* non-fatal */ }
          try {
            await notificationService.notifyUser(updated.client_id, 'ticket', 'Payment Verified',
              `Your payment for ${cr.ticket_number} has been verified. Your report will be released to you shortly.`,
              'profile.html?section=requests');
          } catch (_) { /* non-fatal */ }
          try {
            await notificationService.notifyRole('clinical_director', 'ticket', 'Legacy Report — Ready to Release',
              `Payment for legacy request ${cr.ticket_number} is verified. Open Legacy Verifications and release the report to the client.`,
              `psych-reports.html?legacy=${cr.id}`);
          } catch (_) { /* non-fatal */ }
          return res.status(200).json({ success: true, message: 'Legacy payment verified.', data: updated });
        }

        if (cr && cr.nature === 'report_concern') {
          await db.query(
            `UPDATE client_requests SET concern_status = 'Payment Verified', updated_at = NOW() WHERE id = $1`,
            [cr.id]);
          // Flag the released report as needing modification so it surfaces with a
          // "Modification Required" status (+ Edit / Upload / Submit actions) in the
          // authoring psychologist's report module.
          if (cr.report_id) {
            await db.query(
              `UPDATE psychological_reports SET modification_status = 'Modification Required', active_concern_id = $1, updated_at = NOW() WHERE id = $2`,
              [cr.id, cr.report_id]).catch(() => {});
          }
          try {
            await RequestAuditLog.log(cr.id, adminId, 'CONCERN_PAYMENT_VERIFIED',
              `Concern payment verified (ref ${updated.reference_number}). Assigned psychologist notified.`);
          } catch (_) { /* non-fatal */ }
          try {
            await notificationService.notifyUser(updated.client_id, 'ticket', 'Payment Successful',
              `Your payment for report concern ${cr.ticket_number} has been verified. Our psychologist will now review and update your report.`,
              'profile.html?section=requests');
          } catch (_) { /* non-fatal */ }
          // Resolve the psychologist to notify: prefer the stamped
          // assigned_psychologist_id; fall back to the linked report's author
          // (and backfill it) so the notification fires even for concerns created
          // before assigned_psychologist_id was populated.
          const psyId = await resolveConcernPsychologistId(db, cr);
          if (psyId) {
            try {
              await notificationService.notifyUser(psyId, 'ticket', 'Report Concern — Action Required',
                `A client concern (${cr.ticket_number}) about a report you authored has been approved and paid. Review the concern and modify the report.`,
                `psych-reports.html?concern=${cr.id}`);
            } catch (_) { /* non-fatal */ }
          } else {
            console.error(`Concern ${cr.ticket_number}: no assigned psychologist could be resolved — psychologist not notified.`);
          }
          return res.status(200).json({ success: true, message: 'Concern payment verified.', data: updated });
        }

        try {
          await notificationService.notifyUser(updated.client_id, 'ticket', 'Payment Verified',
            `Your payment for your report request (ref ${updated.reference_number}) has been verified. Your receipt is now available.`,
            'profile.html?section=requests');
        } catch (_) { /* non-fatal */ }
        return res.status(200).json({ success: true, message: 'Report-request payment verified.', data: updated });
      }

      return res.status(200).json({ success: true, message: 'Payment verified and slot reserved.', data: updated });
    }

    // ── Reject ──
    const updated = await Payment.reject(req.params.id, adminId, note);
    if (!updated) {
      return res.status(409).json({ success: false, message: 'Could not reject payment. Please refresh and try again.' });
    }

    await setApptPaymentStatus(updated.appointment_id, 'rejected');

    await ActivityLog.log(adminId, 'REJECT_PAYMENT', 'payment', updated.id,
      getClientIP(req), { reference: updated.reference_number, reason: note || null });

    // Record on the Audit TRAIL ("Payment Verification" module) so a rejected
    // verification is also visible on the Clinical Director's audit trail.
    await CaseAuditLog.log({
      tableName: 'payments',
      recordId: updated.id,
      action: 'PAYMENT_REJECTED',
      staffId: adminId,
      oldValue: { status: 'under_review' },
      newValue: { status: 'rejected', reference: updated.reference_number },
      ipAddress: getClientIP(req),
    });

    // Report-request payment → mirror the rejection back onto the ticket + log it
    // on the ticket's audit trail; otherwise use the appointment-payment message.
    if (updated.module === 'report_request' && updated.client_request_id) {
      // Rejection state lives on the payment row (just set to 'rejected'); the
      // request derives its status from it — nothing to write on client_requests.
      try {
        await RequestAuditLog.log(updated.client_request_id, adminId, 'PAYMENT_REJECTED',
          `Proof of payment rejected in the Payment Verification module (ref ${updated.reference_number}).${note ? ' Reason: ' + note : ''}`);
      } catch (_) { /* non-fatal */ }

      // ── Report-CONCERN payment failed (spec §4 failure) ──
      const creq = await db.query(
        `SELECT id, nature, ticket_number FROM client_requests WHERE id = $1`, [updated.client_request_id]);
      const cr = creq.rows[0];
      if (cr && cr.nature === 'report_concern') {
        await db.query(
          `UPDATE client_requests SET concern_status = 'Payment Verification Failed', updated_at = NOW() WHERE id = $1`,
          [cr.id]);
        try {
          await notificationService.notifyUser(
            updated.client_id, 'ticket', 'Payment Verification Failed',
            `Your payment for report concern ${cr.ticket_number} could not be verified.${note ? ' Reason: ' + note : ''} Please re-upload your proof of payment.`,
            `request-payment.html?request=${cr.id}`
          );
        } catch (_) { /* non-fatal */ }
        return res.status(200).json({ success: true, message: 'Payment rejected. The client may submit a new payment.', data: updated });
      }

      try {
        await notificationService.notifyUser(
          updated.client_id, 'ticket', 'Proof of Payment Rejected',
          `Your proof of payment for your report request (ref ${updated.reference_number}) was not accepted.${note ? ' Reason: ' + note : ''} Please re-upload your proof of payment.`,
          `requests.html?reupload=${updated.client_request_id}`
        );
      } catch (_) { /* non-fatal */ }
    } else {
      try {
        await notificationService.notifyUser(
          updated.client_id, 'payment', 'Payment Could Not Be Verified',
          `Your proof of payment for reference ${updated.reference_number} was not accepted.${note ? ' Reason: ' + note : ''} Your schedule is still held — please complete payment again and resend your proof of payment.`,
          `payment.html?appt=${updated.appointment_id}`
        );
      } catch (_) { /* non-fatal */ }
    }

    return res.status(200).json({ success: true, message: 'Payment rejected. The client may submit a new payment.', data: updated });
  } catch (error) {
    next(error);
  }
};

/**
 * PUT /api/payments/:id/option
 * Client changes their mind between half/full while the payment is still pending
 * and no proof has been uploaded yet. Recomputes the amount server-side.
 * Body: { paymentOption: 'half'|'full' }
 */
const updatePaymentOption = async (req, res, next) => {
  try {
    const clientId = req.user.id;
    const { paymentOption } = req.body;
    if (!paymentOption || !['half', 'full'].includes(paymentOption)) {
      return res.status(400).json({ success: false, message: "Payment option must be either 'half' or 'full'." });
    }

    const payment = await Payment.findById(req.params.id);
    if (!payment) {
      return res.status(404).json({ success: false, message: 'Payment record not found.' });
    }
    if (payment.client_id !== clientId) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }
    if (payment.status !== 'pending' || payment.proof_of_payment) {
      return res.status(409).json({
        success: false,
        message: 'The payment option can only be changed before you upload your proof of payment.',
      });
    }

    const amountDue = paymentOption === 'full' ? PAYMENT_CONFIG.fullAmount : PAYMENT_CONFIG.halfAmount;
    const outstandingBalance = paymentOption === 'half' ? +(PAYMENT_CONFIG.totalFee - amountDue).toFixed(2) : 0;

    const updated = await Payment.updateOption(req.params.id, {
      paymentOption, amountDue, totalFee: PAYMENT_CONFIG.totalFee, outstandingBalance,
    });
    if (!updated) {
      return res.status(409).json({ success: false, message: 'Could not change the payment option. Please refresh and try again.' });
    }

    const qrImage = paymentOption === 'full' ? PAYMENT_CONFIG.qr.full : PAYMENT_CONFIG.qr.half;
    return res.status(200).json({
      success: true,
      message: 'Payment option updated.',
      data: {
        id: updated.id,
        reference_number: updated.reference_number,
        payment_option: updated.payment_option,
        amount_due: Number(updated.amount_due),
        total_fee: Number(updated.total_fee),
        outstanding_balance: Number(updated.outstanding_balance),
        status: updated.status,
        expires_at: updated.expires_at,
        qr_image: qrImage,
        account: PAYMENT_CONFIG.account,
      },
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createPayment, uploadProof, getPayments, getPayment, getPaymentCounts, verifyPayment,
  updatePaymentOption,
  PAYMENT_CONFIG,
};
