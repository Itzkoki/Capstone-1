const Payment = require('../models/Payment');
const Appointment = require('../models/Appointment');
const User = require('../models/User');
const ActivityLog = require('../models/ActivityLog');
const notificationService = require('../services/notificationService');

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

    // Payment is only offered after a schedule has been mutually agreed.
    // Guard: the linked appointment must belong to the client and be in an
    // agreed state ('approved' or 'confirmed').
    if (appointmentId) {
      const appt = await Appointment.findById(appointmentId);
      if (!appt || appt.client_id !== clientId) {
        return res.status(404).json({ success: false, message: 'Appointment not found.' });
      }
      if (!['approved', 'confirmed'].includes(appt.status)) {
        return res.status(409).json({
          success: false,
          message: 'Payment becomes available only after your schedule has been confirmed.',
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
      serviceLabel,
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

    // Notify the client only. Staff are not alerted during the payment workflow.
    try {
      await notificationService.notifyUser(
        clientId, 'payment', 'Proof of Payment Received',
        `We received your proof of payment for reference ${updated.reference_number}. It is now under review by our team. You will be notified once it is verified.`,
        'profile.html'
      );
    } catch (_) { /* non-fatal */ }

    // NOTE: Staff are intentionally NOT notified here. The payment workflow
    // (proof submitted / awaiting verification) is not exposed to staff via
    // notifications — staff verify pending payments from the payments dashboard,
    // and only receive a "Payment Successful" confirmation once a payment is
    // actually verified (see verifyPayment).

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
      }

      await ActivityLog.log(adminId, 'VERIFY_PAYMENT', 'payment', updated.id,
        getClientIP(req), { reference: updated.reference_number, amount: updated.amount_due, note: note || null });

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
        await notificationService.notifyStaff(
          'payment', 'Payment Successful',
          `Payment ${updated.reference_number} (₱${Number(updated.amount_due).toFixed(2)}, ${updated.payment_option} payment) from ${clientName} has been completed and verified.`,
          'payments-admin.html',
          adminId // don't notify the staff member who performed the verification
        );
      } catch (_) { /* non-fatal */ }

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

    try {
      await notificationService.notifyUser(
        updated.client_id, 'payment', 'Payment Could Not Be Verified',
        `Your proof of payment for reference ${updated.reference_number} was not accepted.${note ? ' Reason: ' + note : ''} Your schedule is still held — please complete payment again and resend your proof of payment.`,
        `payment.html?appt=${updated.appointment_id}`
      );
    } catch (_) { /* non-fatal */ }

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
