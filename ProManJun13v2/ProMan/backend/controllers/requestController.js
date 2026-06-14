const db = require('../config/db');
const User = require('../models/User');
const ActivityLog = require('../models/ActivityLog');
const RequestAuditLog = require('../models/RequestAuditLog');
const notificationService = require('../services/notificationService');

const getClientIP = (req) =>
  (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || null;

const isStaff = (role) => role && role !== 'client';
const isDirector = (role) => role === 'clinical_director';

// Audit logging must never break the user's action — log failures are reported
// to the console but swallowed.
async function audit(userId, action, resourceId, req, details) {
  try {
    await ActivityLog.log(userId, action, 'client_request', resourceId, getClientIP(req), details);
  } catch (e) {
    console.error('Audit log failed (' + action + '):', e.message);
  }
}

// Dedicated per-ticket audit trail (separate table). Self-guarding in the model.
async function reqAudit(requestId, userId, action, remarks) {
  await RequestAuditLog.log(requestId, userId, action, remarks || null);
}

// Map the stored columns onto the Report-Requests display status the spec uses:
//   Under Review → Awaiting Payment → Payment Submitted → Payment Verified
//   → Resolved → Sent  (plus Rejected).
function reportRequestStatus(row) {
  if (row.status === 'rejected') return 'Rejected';
  if (row.sent_at) return 'Sent';
  if (row.report_released_at && (row.payment_status === 'verified' || !row.payment_required)) return 'Resolved';
  if (row.payment_required) {
    if (row.payment_status === 'verified') return 'Payment Verified';
    if (row.payment_status === 'under_review') return 'Payment Submitted';
    if (row.payment_status === 'awaiting_payment' || row.payment_status === 'rejected') return 'Awaiting Payment';
  }
  return 'Under Review';
}

const REQUEST_TYPE_LABELS = {
  additional_copies: 'Additional Copies of Report',
  report_concern: 'Concern About Report',
};

// ── Report Concerns ────────────────────────────────────────────────────────
// Lifecycle statuses for the "Report Concerns" console (spec §1).
const CONCERN_STATUSES = [
  'Pending Review', 'Under Investigation', 'Client Action Required',
  'Resolved', 'Rejected',
];
// Map a raw concern checkbox value (as stored by requests.html) onto the
// canonical concern-type label and a workflow "kind" used to decide whether a
// correction needs a new report version (spec §§4-10).
const CONCERN_KIND = {
  'misspelled name'                     : 'name',
  'wrong birthday/age'                  : 'dob',
  'wrong address'                       : 'address',
  'missing pages/documents'             : 'missing',
  'concern regarding findings/diagnosis': 'findings',
  'concern regarding recommendations'   : 'recommendations',
};

const ADDITIONAL_COPY_FEE = 1.00; // ₱ — clinic fee per additional-copy request
const MAX_FILE_LEN = 7 * 1024 * 1024;   // ~5MB binary as base64 (attachments/proof)
const MAX_REPORT_LEN = 28 * 1024 * 1024; // ~20MB as base64 — edited report PDFs
const ACCEPTED_MIMES = ['image/jpeg', 'image/png', 'application/pdf'];

// Concern display status: an explicit column drives the Report-Concerns table.
function concernStatus(row) {
  return row.concern_status || 'Pending Review';
}

const STATUS_LABELS = {
  submitted: 'Submitted', under_review: 'Under Review',
  resolved: 'Resolved', closed: 'Closed',
};

function validateDataUrl(dataUrl, maxLen = MAX_FILE_LEN) {
  if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return null;
  const m = dataUrl.match(/^data:([^;]+);base64,/);
  if (!m) return null;
  const mime = m[1].toLowerCase();
  if (!ACCEPTED_MIMES.includes(mime)) return null;
  if (dataUrl.length > maxLen) return null;
  return mime;
}

// Generate ticket like BPS-REQ-20260609-001 (daily sequence)
async function generateTicketNumber() {
  const today = new Date();
  const y = today.getFullYear(), mo = String(today.getMonth() + 1).padStart(2, '0'), d = String(today.getDate()).padStart(2, '0');
  const prefix = `BPS-REQ-${y}${mo}${d}-`;
  const r = await db.query(
    `SELECT ticket_number FROM client_requests WHERE ticket_number LIKE $1 ORDER BY ticket_number DESC LIMIT 1`,
    [prefix + '%']
  );
  let seq = 1;
  if (r.rowCount) {
    const last = parseInt(r.rows[0].ticket_number.slice(prefix.length), 10);
    if (!Number.isNaN(last)) seq = last + 1;
  }
  return prefix + String(seq).padStart(3, '0');
}

// Strip large blobs from list payloads
function publicRow(row, role) {
  const out = { ...row };
  delete out.attachment;
  delete out.payment_proof;
  delete out.report_file;
  out.has_attachment = !!row.attachment_name;
  out.has_payment_proof = !!row.payment_proof_name;
  out.has_report = !!row.report_filename;
  out.status_label = STATUS_LABELS[row.status] || row.status;
  // Report-Requests display status (Under Review … Sent / Rejected) + type label.
  out.report_request_status = reportRequestStatus(row);
  out.request_type_label = REQUEST_TYPE_LABELS[row.nature] || row.nature;
  out.has_receipt = !!row.receipt_number;
  // Report-Concerns display status (Pending Review … Resolved / Rejected).
  out.concern_status = concernStatus(row);
  out.is_concern = row.nature === 'report_concern';
  return out;
}

// ── POST /api/requests — client submits the form ──
const createRequest = async (req, res, next) => {
  try {
    if (isStaff(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Only clients can submit a request/concern.' });
    }
    const f = req.body || {};
    if (!f.nature || !['additional_copies', 'report_concern'].includes(f.nature)) {
      return res.status(400).json({ success: false, message: 'Please choose the nature of your request.' });
    }
    if (!f.familyName || !f.givenName) {
      return res.status(400).json({ success: false, message: 'Client family name and given name are required.' });
    }
    if (!f.description || !String(f.description).trim()) {
      return res.status(400).json({ success: false, message: 'Please provide a brief description of your concern.' });
    }

    let attachmentMime = null;
    if (f.attachment) {
      attachmentMime = validateDataUrl(f.attachment);
      if (!attachmentMime) {
        return res.status(400).json({ success: false, message: 'Attachment must be a JPG, PNG, or PDF under 5 MB.' });
      }
    }

    const isConcern = f.nature === 'report_concern';
    const ticket = await generateTicketNumber();
    const concerns = Array.isArray(f.concerns) ? f.concerns : [];

    // Number of copies — only meaningful for additional-copies requests.
    // Clamp to a sensible range (1–50); default 1. Concerns are always 1.
    let copies = 1;
    if (f.nature === 'additional_copies') {
      const n = parseInt(f.copies, 10);
      if (!Number.isNaN(n)) copies = Math.min(50, Math.max(1, n));
    }

    const result = await db.query(
      `INSERT INTO client_requests (
        ticket_number, client_id, client_family_name, client_given_name, client_mi,
        guardian_name, assessment_date, contact_number, center_branch,
        nature, concerns, concern_other, description,
        attachment, attachment_name, attachment_mime,
        concern_status, copies
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
      RETURNING *`,
      [
        ticket, req.user.id, f.familyName, f.givenName, f.mi || null,
        f.guardianName || null, f.assessmentDate || null, f.contactNumber || null, f.centerBranch || null,
        f.nature, JSON.stringify(concerns), f.concernOther || null, String(f.description).trim(),
        f.attachment || null, f.attachment ? (f.attachmentName || 'attachment').slice(0, 255) : null, attachmentMime,
        isConcern ? 'Pending Review' : null, copies,
      ]
    );
    const row = result.rows[0];

    await audit(req.user.id, 'SUBMIT_REQUEST', row.id, req, { ticket, nature: f.nature });
    await reqAudit(row.id, req.user.id, isConcern ? 'CONCERN_SUBMITTED' : 'REQUEST_SUBMITTED',
      `${REQUEST_TYPE_LABELS[f.nature] || f.nature} submitted (ticket ${ticket}).`);

    const user = await User.findById(req.user.id);
    const clientName = user ? user.full_name : 'A client';

    const copiesText = `${copies} cop${copies === 1 ? 'y' : 'ies'}`;
    try {
      await notificationService.notifyUser(
        req.user.id, 'ticket', 'Request Received',
        `Your ${f.nature === 'additional_copies' ? `request for ${copiesText} of your report` : 'report concern'} has been received. Your ticket number is ${ticket}. We'll notify you as it progresses.`,
        'requests.html'
      );
    } catch (_) {}
    try {
      await notificationService.notifyStaff(
        'ticket', isConcern ? 'New Report Concern Submitted' : 'New Client Request/Concern',
        isConcern
          ? `${clientName} submitted a report concern (ticket ${ticket}). A new report concern has been submitted.`
          : `${clientName} submitted a request for additional report copies — ${copiesText} (ticket ${ticket}).`,
        isConcern ? 'psych-reports.html#reportConcerns' : 'psych-reports.html#reportRequests'
      );
      await reqAudit(row.id, req.user.id,
        isConcern ? 'CONCERN_SUBMITTED' : 'STAFF_NOTIFIED',
        isConcern ? 'Staff notified of the new submission.' : `Staff notified — ${copiesText} requested.`);
    } catch (_) {}

    return res.status(201).json({ success: true, message: 'Request submitted.', data: publicRow(row) });
  } catch (error) { next(error); }
};

// ── GET /api/requests — list (clients: own; staff: all) ──
const getRequests = async (req, res, next) => {
  try {
    let rows;
    if (isStaff(req.user.role)) {
      const r = await db.query(
        `SELECT cr.*, u.full_name AS client_account_name, u.email AS client_email,
                s.full_name AS assigned_staff_name
         FROM client_requests cr
         JOIN users u ON u.id = cr.client_id
         LEFT JOIN users s ON s.id = cr.assigned_staff_id
         ORDER BY cr.created_at DESC`);
      rows = r.rows;
    } else {
      const r = await db.query(
        `SELECT cr.*, s.full_name AS assigned_staff_name
         FROM client_requests cr
         LEFT JOIN users s ON s.id = cr.assigned_staff_id
         WHERE cr.client_id = $1
         ORDER BY cr.created_at DESC`, [req.user.id]);
      rows = r.rows;
    }
    return res.json({ success: true, data: rows.map(r => publicRow(r, req.user.role)) });
  } catch (error) { next(error); }
};

// ── GET /api/requests/:id — single ticket with replies ──
const getRequest = async (req, res, next) => {
  try {
    const r = await db.query(
      `SELECT cr.*, u.full_name AS client_account_name, s.full_name AS assigned_staff_name
       FROM client_requests cr
       JOIN users u ON u.id = cr.client_id
       LEFT JOIN users s ON s.id = cr.assigned_staff_id
       WHERE cr.id = $1`, [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ success: false, message: 'Ticket not found.' });
    const row = r.rows[0];
    if (!isStaff(req.user.role) && row.client_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }
    const replies = await db.query(
      `SELECT rr.*, u.full_name, u.role FROM client_request_replies rr
       LEFT JOIN users u ON u.id = rr.user_id
       WHERE rr.request_id = $1 ORDER BY rr.created_at ASC`, [req.params.id]);
    const out = publicRow(row, req.user.role);
    out.replies = replies.rows;
    return res.json({ success: true, data: out });
  } catch (error) { next(error); }
};

// ── GET /api/requests/:id/file?type=attachment|proof|report — download blobs ──
const getRequestFile = async (req, res, next) => {
  try {
    const r = await db.query(`SELECT * FROM client_requests WHERE id = $1`, [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ success: false, message: 'Ticket not found.' });
    const row = r.rows[0];
    const staff = isStaff(req.user.role);
    if (!staff && row.client_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }
    const type = req.query.type;
    let dataUrl = null, name = null;
    if (type === 'attachment') { dataUrl = row.attachment; name = row.attachment_name; }
    else if (type === 'proof' && staff) { dataUrl = row.payment_proof; name = row.payment_proof_name; }
    else if (type === 'version') {
      // A specific stored report version. Staff can open any version; the client
      // may only open the latest released version (spec §13).
      const vid = req.query.versionId;
      const vq = vid
        ? await db.query(`SELECT * FROM client_request_report_versions WHERE id = $1 AND request_id = $2`, [vid, req.params.id])
        : await db.query(`SELECT * FROM client_request_report_versions WHERE request_id = $1 ORDER BY version_number DESC LIMIT 1`, [req.params.id]);
      if (!vq.rowCount) return res.status(404).json({ success: false, message: 'Version not found.' });
      const v = vq.rows[0];
      if (!staff) {
        // Clients only get the latest version, and only once released.
        const latest = await db.query(`SELECT MAX(version_number) AS mx FROM client_request_report_versions WHERE request_id = $1`, [req.params.id]);
        if (!row.report_released_at || v.version_number !== latest.rows[0].mx) {
          return res.status(403).json({ success: false, message: 'Only the latest released report version is available to you.' });
        }
      }
      dataUrl = v.file; name = v.filename;
    }
    else if (type === 'report') {
      // Report is delivered to the client only after the Clinical Director
      // clicks "Send" (sent_at set). Staff can always access it.
      if (!staff && !row.sent_at) {
        return res.status(403).json({ success: false, message: 'The report has not been sent to you yet.' });
      }
      dataUrl = row.report_file; name = row.report_filename;
    }
    if (!dataUrl) return res.status(404).json({ success: false, message: 'File not found.' });
    return res.json({ success: true, data: { name, dataUrl } });
  } catch (error) { next(error); }
};

// ── PUT /api/requests/:id/assign — admin assigns staff + deadline ──
const assignRequest = async (req, res, next) => {
  try {
    const { staffId, deadline } = req.body || {};
    const r = await db.query(
      `UPDATE client_requests SET assigned_staff_id = $1, deadline = $2, updated_at = NOW()
       WHERE id = $3 RETURNING *`,
      [staffId || null, deadline || null, req.params.id]);
    if (!r.rowCount) return res.status(404).json({ success: false, message: 'Ticket not found.' });
    const row = r.rows[0];
    await audit(req.user.id, 'ASSIGN_REQUEST', row.id, req, { ticket: row.ticket_number, staffId: staffId || null, deadline: deadline || null });
    if (staffId) {
      try {
        await notificationService.notifyUser(
          parseInt(staffId, 10), 'request', 'Request Assigned to You',
          `Ticket ${row.ticket_number} has been assigned to you${deadline ? ' (deadline ' + deadline + ')' : ''}.`,
          'psych-reports.html#reportRequests');
      } catch (_) {}
    }
    return res.json({ success: true, message: 'Assignment saved.', data: publicRow(row) });
  } catch (error) { next(error); }
};

// ── PUT /api/requests/:id/status — staff updates status / resolution ──
const updateRequestStatus = async (req, res, next) => {
  try {
    const { status, resolutionNote } = req.body || {};
    if (!['under_review', 'resolved', 'closed'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Status must be under_review, resolved, or closed.' });
    }
    const cur = await db.query(`SELECT * FROM client_requests WHERE id = $1`, [req.params.id]);
    if (!cur.rowCount) return res.status(404).json({ success: false, message: 'Ticket not found.' });
    const ticket = cur.rows[0];

    // Additional-copy requests must have a verified payment before processing/resolution.
    if (['resolved'].includes(status) && ticket.payment_required && ticket.payment_status !== 'verified') {
      return res.status(409).json({ success: false, message: 'Payment must be verified before resolving this request.' });
    }
    if (status === 'resolved' && !(resolutionNote && resolutionNote.trim()) && !ticket.resolution_note) {
      return res.status(400).json({ success: false, message: 'A resolution note is required to resolve a ticket.' });
    }

    const r = await db.query(
      `UPDATE client_requests
       SET status = $1, resolution_note = COALESCE($2, resolution_note), updated_at = NOW()
       WHERE id = $3 RETURNING *`,
      [status, resolutionNote && resolutionNote.trim() ? resolutionNote.trim() : null, req.params.id]);
    const row = r.rows[0];

    await audit(req.user.id, 'UPDATE_REQUEST_STATUS', row.id, req, { ticket: row.ticket_number, status });

    try {
      const msgs = {
        under_review: `Your ticket ${row.ticket_number} is now under review by our staff.`,
        resolved: `Your ticket ${row.ticket_number} has been resolved.${row.report_filename ? ' Your finalized report is now available in your Generated Reports section.' : ''}${row.resolution_note ? ' Resolution: ' + row.resolution_note : ''}`,
        closed: `Your ticket ${row.ticket_number} has been closed. Thank you.`,
      };
      await notificationService.notifyUser(row.client_id, 'ticket',
        `Ticket ${STATUS_LABELS[status]}`, msgs[status], 'requests.html');
    } catch (_) {}

    return res.json({ success: true, message: `Ticket marked ${STATUS_LABELS[status]}.`, data: publicRow(row) });
  } catch (error) { next(error); }
};

// ── PUT /api/requests/:id/payment-prompt — staff requests payment for copies ──
const promptPayment = async (req, res, next) => {
  try {
    const amount = Number((req.body || {}).amount) || ADDITIONAL_COPY_FEE;
    const cur = await db.query(`SELECT * FROM client_requests WHERE id = $1`, [req.params.id]);
    if (!cur.rowCount) return res.status(404).json({ success: false, message: 'Ticket not found.' });
    const reference = `${cur.rows[0].ticket_number}-PAY`;
    const r = await db.query(
      `UPDATE client_requests
       SET payment_required = TRUE, payment_amount = $1, payment_status = 'awaiting_payment',
           payment_reference = $2, status = 'under_review', updated_at = NOW()
       WHERE id = $3 RETURNING *`, [amount, reference, req.params.id]);
    const row = r.rows[0];
    await audit(req.user.id, 'REQUEST_PAYMENT_PROMPT', row.id, req, { ticket: row.ticket_number, amount });
    await reqAudit(row.id, req.user.id, 'PAYMENT_PROMPTED', `Client prompted for payment of \u20b1${amount.toFixed(2)}.`);
    try {
      await notificationService.notifyUser(row.client_id, 'ticket', 'Payment Required for Your Request',
        `Your request ${row.ticket_number} for additional report copies requires a fee of \u20b1${amount.toFixed(2)}. Open your ticket to scan the clinic QR and upload your proof of payment.`,
        'requests.html');
    } catch (_) {}
    return res.json({ success: true, message: 'Payment prompt sent to the client.', data: publicRow(row) });
  } catch (error) { next(error); }
};

// ── POST /api/requests/:id/payment-proof — client uploads proof ──
const uploadRequestPaymentProof = async (req, res, next) => {
  try {
    const { proof, filename } = req.body || {};
    const cur = await db.query(`SELECT * FROM client_requests WHERE id = $1`, [req.params.id]);
    if (!cur.rowCount) return res.status(404).json({ success: false, message: 'Ticket not found.' });
    const ticket = cur.rows[0];
    if (ticket.client_id !== req.user.id) return res.status(403).json({ success: false, message: 'Access denied.' });
    if (!ticket.payment_required || !['awaiting_payment', 'rejected'].includes(ticket.payment_status)) {
      return res.status(409).json({ success: false, message: 'This ticket is not awaiting payment.' });
    }
    const mime = validateDataUrl(proof);
    if (!mime) return res.status(400).json({ success: false, message: 'Proof must be a JPG, PNG, or PDF under 5 MB.' });

    const r = await db.query(
      `UPDATE client_requests
       SET payment_proof = $1, payment_proof_name = $2, payment_status = 'under_review', updated_at = NOW()
       WHERE id = $3 RETURNING *`,
      [proof, (filename || 'proof').slice(0, 255), req.params.id]);
    const row = r.rows[0];
    await audit(req.user.id, 'REQUEST_PAYMENT_PROOF', row.id, req, { ticket: row.ticket_number });
    await reqAudit(row.id, req.user.id, 'PAYMENT_SUBMITTED', 'Client submitted proof of payment for verification.');
    try {
      await notificationService.notifyStaff('ticket', 'Request Payment Proof Received',
        `Payment proof received for ticket ${row.ticket_number}. Please verify.`, 'psych-reports.html#reportRequests');
      // The spec routes payment verification to the Clinical Director.
      await notificationService.notifyRole('clinical_director', 'ticket', 'Proof of Payment Submitted',
        `A client has submitted proof of payment for verification (ticket ${row.ticket_number}).`,
        'psych-reports.html#reportRequests');
    } catch (_) {}
    return res.json({ success: true, message: 'Proof submitted — awaiting staff verification.', data: publicRow(row) });
  } catch (error) { next(error); }
};

// ── PUT /api/requests/:id/payment-verify — Clinical Director verifies/rejects payment ──
const verifyRequestPayment = async (req, res, next) => {
  try {
    const { action, note } = req.body || {};
    if (!isDirector(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Only a Clinical Director can verify payments.' });
    }
    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ success: false, message: "Action must be 'approve' or 'reject'." });
    }
    if (action === 'reject' && (!note || !String(note).trim())) {
      return res.status(400).json({ success: false, message: 'A reason is required to reject a payment.' });
    }
    const cur = await db.query(`SELECT * FROM client_requests WHERE id = $1`, [req.params.id]);
    if (!cur.rowCount) return res.status(404).json({ success: false, message: 'Ticket not found.' });
    if (cur.rows[0].payment_status !== 'under_review') {
      return res.status(409).json({ success: false, message: 'No payment is awaiting verification on this ticket.' });
    }

    let row;
    if (action === 'approve') {
      // Generate a receipt reference and store it on the ticket (the client's receipt).
      const receiptNumber = `${cur.rows[0].ticket_number}-RCPT`;
      const r = await db.query(
        `UPDATE client_requests
         SET payment_status = 'verified', payment_rejection_reason = NULL,
             receipt_number = $1, receipt_issued_at = NOW(), updated_at = NOW()
         WHERE id = $2 RETURNING *`, [receiptNumber, req.params.id]);
      row = r.rows[0];
      await audit(req.user.id, 'VERIFY_REQUEST_PAYMENT', row.id, req, { ticket: row.ticket_number, receipt: receiptNumber });
      await reqAudit(row.id, req.user.id, 'PAYMENT_APPROVED', `Payment verified. Receipt ${receiptNumber} issued.`);
      try {
        await notificationService.notifyUser(row.client_id, 'ticket', 'Payment Verified',
          `Your payment for ticket ${row.ticket_number} has been successfully verified. Your receipt (${receiptNumber}) is now available.`,
          'requests.html');
      } catch (_) {}
    } else {
      const reason = String(note).trim();
      const r = await db.query(
        `UPDATE client_requests
         SET payment_status = 'rejected', payment_rejection_reason = $1, updated_at = NOW()
         WHERE id = $2 RETURNING *`, [reason, req.params.id]);
      row = r.rows[0];
      await audit(req.user.id, 'REJECT_REQUEST_PAYMENT', row.id, req, { ticket: row.ticket_number, note: reason });
      await reqAudit(row.id, req.user.id, 'PAYMENT_REJECTED', `Proof of payment rejected. Reason: ${reason}`);
      try {
        // Link carries an action hint so the client UI can surface a
        // "Re-upload Proof of Payment" button and reopen the upload step.
        await notificationService.notifyUser(row.client_id, 'ticket', 'Proof of Payment Rejected',
          `Your proof of payment for ticket ${row.ticket_number} has been rejected. Reason: ${reason} Please re-upload your proof of payment.`,
          `requests.html?reupload=${row.id}`);
      } catch (_) {}
    }
    return res.json({ success: true, message: action === 'approve' ? 'Payment verified.' : 'Payment rejected.', data: publicRow(row) });
  } catch (error) { next(error); }
};

// ── POST /api/requests/:id/report — staff uploads finalized report (release) ──
const uploadRequestReport = async (req, res, next) => {
  try {
    const { file, filename } = req.body || {};
    const mime = validateDataUrl(file);
    if (!mime) return res.status(400).json({ success: false, message: 'Report must be a JPG, PNG, or PDF under 5 MB.' });
    const cur = await db.query(`SELECT * FROM client_requests WHERE id = $1`, [req.params.id]);
    if (!cur.rowCount) return res.status(404).json({ success: false, message: 'Ticket not found.' });
    const ticket = cur.rows[0];
    if (ticket.payment_required && ticket.payment_status !== 'verified') {
      return res.status(409).json({ success: false, message: 'Payment must be verified before releasing the report.' });
    }
    const r = await db.query(
      `UPDATE client_requests
       SET report_file = $1, report_filename = $2, report_mime = $3,
           report_released_at = NOW(), status = 'resolved', updated_at = NOW()
       WHERE id = $4 RETURNING *`,
      [file, (filename || 'report.pdf').slice(0, 255), mime, req.params.id]);
    const row = r.rows[0];
    await audit(req.user.id, 'RELEASE_REQUEST_REPORT', row.id, req, { ticket: row.ticket_number, filename: row.report_filename });
    await reqAudit(row.id, req.user.id, 'REPORT_GENERATED',
      `Report generated/attached (${row.report_filename}). Ticket resolved; ready to send.`);
    try {
      // Report is generated but NOT yet delivered — the client is notified only
      // when the Clinical Director clicks "Send". Notify the director it's ready.
      await notificationService.notifyRole('clinical_director', 'ticket', 'Report Ready to Send',
        `The report for ticket ${row.ticket_number} has been generated and the request is resolved. You can now send it to the client.`,
        'psych-reports.html#reportRequests');
    } catch (_) {}
    return res.json({ success: true, message: 'Report generated. The request is now resolved and ready to send.', data: publicRow(row) });
  } catch (error) { next(error); }
};

// ── POST /api/requests/:id/reply — client replies / flags for further review ──
const replyToRequest = async (req, res, next) => {
  try {
    const { message, flag } = req.body || {};
    if (!message || !String(message).trim()) {
      return res.status(400).json({ success: false, message: 'A message is required.' });
    }
    const cur = await db.query(`SELECT * FROM client_requests WHERE id = $1`, [req.params.id]);
    if (!cur.rowCount) return res.status(404).json({ success: false, message: 'Ticket not found.' });
    const ticket = cur.rows[0];
    const staff = isStaff(req.user.role);
    if (!staff && ticket.client_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }
    await db.query(
      `INSERT INTO client_request_replies (request_id, user_id, message) VALUES ($1,$2,$3)`,
      [req.params.id, req.user.id, String(message).trim()]);

    // A client flagging a resolved ticket reopens it for further review.
    if (!staff && flag && ['resolved', 'closed'].includes(ticket.status)) {
      await db.query(`UPDATE client_requests SET status = 'under_review', updated_at = NOW() WHERE id = $1`, [req.params.id]);
      try {
        await notificationService.notifyStaff('ticket', 'Ticket Flagged for Further Review',
          `Ticket ${ticket.ticket_number} was flagged by the client for further review.`, 'psych-reports.html#reportRequests');
      } catch (_) {}
    } else if (!staff) {
      try {
        await notificationService.notifyStaff('ticket', 'New Reply on Ticket',
          `New client reply on ticket ${ticket.ticket_number}.`, 'psych-reports.html#reportRequests');
      } catch (_) {}
    } else {
      try {
        await notificationService.notifyUser(ticket.client_id, 'ticket', 'New Reply on Your Ticket',
          `Staff replied on your ticket ${ticket.ticket_number}.`, 'requests.html');
      } catch (_) {}
    }
    await audit(req.user.id, 'REQUEST_REPLY', ticket.id, req, { ticket: ticket.ticket_number, flagged: !!flag });
    return res.json({ success: true, message: 'Reply sent.' });
  } catch (error) { next(error); }
};

// ── GET /api/requests/released-reports — client's Generated Reports entries ──
// Only reports that have been SENT appear in the client's Generated Reports.
const getReleasedReports = async (req, res, next) => {
  try {
    const r = await db.query(
      `SELECT id, ticket_number, nature, report_filename, report_mime, sent_at, report_released_at
       FROM client_requests
       WHERE client_id = $1 AND sent_at IS NOT NULL
       ORDER BY sent_at DESC`, [req.user.id]);
    const rows = r.rows.map(x => ({ ...x, request_type_label: REQUEST_TYPE_LABELS[x.nature] || x.nature }));
    return res.json({ success: true, data: rows });
  } catch (error) { next(error); }
};

// ── GET /api/requests/report-requests — Clinical Director "Report Requests" tab ──
// Returns every client request with the derived display status, for the Report
// Module table (Client Name, Reference Number, Request Type, Date Submitted, Status).
const listReportRequests = async (req, res, next) => {
  try {
    if (!isDirector(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Only a Clinical Director can view report requests.' });
    }
    const r = await db.query(
      `SELECT cr.*, u.full_name AS client_account_name, u.email AS client_email,
              s.full_name AS assigned_staff_name
       FROM client_requests cr
       JOIN users u ON u.id = cr.client_id
       LEFT JOIN users s ON s.id = cr.assigned_staff_id
       WHERE cr.nature = 'additional_copies'
       ORDER BY cr.created_at DESC`);
    const data = r.rows.map((row) => {
      const pub = publicRow(row, req.user.role);
      return {
        id: pub.id,
        ticket_number: pub.ticket_number,
        client_name: row.client_account_name ||
          [row.client_given_name, row.client_family_name].filter(Boolean).join(' '),
        client_email: row.client_email,
        request_type: pub.request_type_label,
        nature: row.nature,
        copies: row.copies || 1,
        date_submitted: row.created_at,
        status: pub.report_request_status,
        has_report: pub.has_report,
        has_payment_proof: pub.has_payment_proof,
        payment_status: row.payment_status,
        payment_amount: row.payment_amount,
      };
    });
    return res.json({ success: true, data });
  } catch (error) { next(error); }
};

// ── PUT /api/requests/:id/review — Clinical Director approves or rejects a request ──
const reviewRequest = async (req, res, next) => {
  try {
    if (!isDirector(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Only a Clinical Director can review requests.' });
    }
    const { action, reason, amount } = req.body || {};
    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ success: false, message: "Action must be 'approve' or 'reject'." });
    }
    const cur = await db.query(`SELECT * FROM client_requests WHERE id = $1`, [req.params.id]);
    if (!cur.rowCount) return res.status(404).json({ success: false, message: 'Ticket not found.' });
    const ticket = cur.rows[0];
    if (['resolved', 'closed', 'rejected'].includes(ticket.status) || ticket.sent_at) {
      return res.status(409).json({ success: false, message: 'This request has already been processed.' });
    }

    if (action === 'reject') {
      if (!reason || !String(reason).trim()) {
        return res.status(400).json({ success: false, message: 'A reason is required to reject a request.' });
      }
      const reasonTxt = String(reason).trim();
      const r = await db.query(
        `UPDATE client_requests
         SET status = 'rejected', rejection_reason = $1, updated_at = NOW()
         WHERE id = $2 RETURNING *`, [reasonTxt, req.params.id]);
      const row = r.rows[0];
      await audit(req.user.id, 'REJECT_REQUEST', row.id, req, { ticket: row.ticket_number, reason: reasonTxt });
      await reqAudit(row.id, req.user.id, 'REQUEST_REJECTED', `Request rejected. Reason: ${reasonTxt}`);
      try {
        await notificationService.notifyUser(row.client_id, 'ticket', 'Report Request Rejected',
          `Your report request (${row.ticket_number}) has been rejected. Reason: ${reasonTxt}`, `requests.html?resubmit=1`);
      } catch (_) {}
      return res.json({ success: true, message: 'Request rejected.', data: publicRow(row) });
    }

    // Approve → move to Awaiting Payment and reuse the existing payment workflow.
    const fee = Number(amount) || ADDITIONAL_COPY_FEE;
    const reference = `${ticket.ticket_number}-PAY`;
    const r = await db.query(
      `UPDATE client_requests
       SET status = 'under_review', approved_at = NOW(), approved_by = $1,
           payment_required = TRUE, payment_amount = $2, payment_status = 'awaiting_payment',
           payment_reference = $3, rejection_reason = NULL, updated_at = NOW()
       WHERE id = $4 RETURNING *`, [req.user.id, fee, reference, req.params.id]);
    const row = r.rows[0];
    await audit(req.user.id, 'APPROVE_REQUEST', row.id, req, { ticket: row.ticket_number, amount: fee });
    await reqAudit(row.id, req.user.id, 'REQUEST_APPROVED',
      `Request approved. Awaiting payment of \u20b1${fee.toFixed(2)} (ref ${reference}).`);
    await reqAudit(row.id, req.user.id, 'PAYMENT_PROMPTED', 'Client directed to the payment workflow.');
    try {
      await notificationService.notifyUser(row.client_id, 'ticket', 'Report Request Approved',
        `Your report request has been approved. Please proceed to payment of \u20b1${fee.toFixed(2)} for ticket ${row.ticket_number}.`,
        `request-payment.html?request=${row.id}`);
    } catch (_) {}
    return res.json({ success: true, message: 'Request approved. Client moved to payment.', data: publicRow(row) });
  } catch (error) { next(error); }
};

// ── POST /api/requests/:id/send — Clinical Director attaches + delivers the report ──
// Accepts an optional { file, filename } body. If provided the report is saved
// before marking it sent (covering the "Payment Verified → Send" path where the
// report hasn't been uploaded yet). If omitted the stored report_file is used
// (the "Resolved → Send" path). Either way the request is sent in one step.
const sendReport = async (req, res, next) => {
  try {
    if (!isDirector(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Only a Clinical Director can send reports.' });
    }
    const cur = await db.query(`SELECT * FROM client_requests WHERE id = $1`, [req.params.id]);
    if (!cur.rowCount) return res.status(404).json({ success: false, message: 'Ticket not found.' });
    const ticket = cur.rows[0];

    // Must be in Payment Verified or Resolved state to send.
    const displayStatus = reportRequestStatus(ticket);
    if (!['Payment Verified', 'Resolved'].includes(displayStatus)) {
      return res.status(409).json({ success: false, message: 'Payment must be verified before sending a report.' });
    }

    const { file, filename } = req.body || {};

    // If a report file is provided in this request, save it first.
    if (file) {
      const mime = validateDataUrl(file);
      if (!mime) return res.status(400).json({ success: false, message: 'Report must be a JPG, PNG, or PDF under 5 MB.' });
      await db.query(
        `UPDATE client_requests
         SET report_file = $1, report_filename = $2, report_mime = $3,
             report_released_at = NOW(), status = 'resolved', updated_at = NOW()
         WHERE id = $4`,
        [file, (filename || 'report.pdf').slice(0, 255), mime, req.params.id]);
      await reqAudit(req.params.id, req.user.id, 'REPORT_GENERATED', `Report uploaded by CD (${filename || 'report.pdf'}).`);
    } else if (!ticket.report_file) {
      // No stored file and no uploaded file — cannot send.
      return res.status(409).json({ success: false, message: 'Please upload the report file before sending.' });
    }

    // Mark the request as sent.
    const r = await db.query(
      `UPDATE client_requests SET sent_at = NOW(), sent_by = $1, updated_at = NOW()
       WHERE id = $2 RETURNING *`, [req.user.id, req.params.id]);
    const row = r.rows[0];
    await audit(req.user.id, 'SEND_REQUEST_REPORT', row.id, req, { ticket: row.ticket_number });
    await reqAudit(row.id, req.user.id, 'REPORT_SENT', `Report delivered to the client's Generated Reports.`);
    try {
      await notificationService.notifyUser(row.client_id, 'ticket', 'Your Requested Report Is Available',
        `Your requested report (ticket ${row.ticket_number}) is now available. Click here to view your report.`,
        `profile.html?section=requests`);
    } catch (_) {}
    return res.json({ success: true, message: 'Report sent to the client.', data: publicRow(row) });
  } catch (error) { next(error); }
};

// ── GET /api/requests/:id/audit — full audit trail for one ticket ──
const getRequestAudit = async (req, res, next) => {
  try {
    const cur = await db.query(`SELECT client_id FROM client_requests WHERE id = $1`, [req.params.id]);
    if (!cur.rowCount) return res.status(404).json({ success: false, message: 'Ticket not found.' });
    // Staff (and the owning client) may view the trail.
    if (!isStaff(req.user.role) && cur.rows[0].client_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }
    const trail = await RequestAuditLog.forRequest(req.params.id);
    return res.json({ success: true, data: trail });
  } catch (error) { next(error); }
};

// ════════════════════════════════════════════════════════════════════════
// REPORT CONCERNS — Clinical Director console (spec: Report Concerns module)
// Mirrors the Report-Requests logic but for nature='report_concern'. Concerns
// never require payment; instead the Director investigates, may request more
// information, edits/replaces the report PDF (creating a new version), and then
// resolves or rejects the concern. Every report change creates a new version.
// ════════════════════════════════════════════════════════════════════════

// Friendly, de-duplicated list of the concern types on a ticket.
function concernTypeLabel(row) {
  let list = [];
  try { list = Array.isArray(row.concerns) ? row.concerns : JSON.parse(row.concerns || '[]'); } catch (_) {}
  if (row.concern_other) list = list.concat(['Other']);
  if (!list.length) return 'Report Concern';
  return list.join(', ');
}

// Does this concern's resolution require generating a new report version?
// (Misspelled name, wrong DOB/age, wrong address, missing pages, or an explicit
// "revise" decision on findings/recommendations.) Maintain/keep decisions and
// pure "Other" resolutions only require a resolution note.
function concernRequiresVersion(row, decision) {
  if (decision === 'maintain' || decision === 'keep') return false;
  if (decision === 'revise' || decision === 'update') return true;
  let list = [];
  try { list = Array.isArray(row.concerns) ? row.concerns : JSON.parse(row.concerns || '[]'); } catch (_) {}
  const kinds = list.map(v => CONCERN_KIND[String(v).toLowerCase()]).filter(Boolean);
  return kinds.some(k => ['name', 'dob', 'address', 'missing'].includes(k));
}

// ── GET /api/requests/report-concerns — Clinical Director "Report Concerns" tab ──
const listReportConcerns = async (req, res, next) => {
  try {
    if (!isDirector(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Only a Clinical Director can view report concerns.' });
    }
    const r = await db.query(
      `SELECT cr.*, u.full_name AS client_account_name, u.email AS client_email,
              s.full_name AS assigned_staff_name,
              (SELECT COUNT(*) FROM client_request_report_versions v WHERE v.request_id = cr.id) AS version_count
       FROM client_requests cr
       JOIN users u ON u.id = cr.client_id
       LEFT JOIN users s ON s.id = cr.assigned_staff_id
       WHERE cr.nature = 'report_concern'
       ORDER BY cr.created_at DESC`);
    const data = r.rows.map((row) => {
      const pub = publicRow(row, req.user.role);
      return {
        id: pub.id,
        ticket_number: pub.ticket_number,
        client_name: row.client_account_name ||
          [row.client_given_name, row.client_family_name].filter(Boolean).join(' '),
        client_email: row.client_email,
        concern_type: concernTypeLabel(row),
        date_submitted: row.created_at,
        status: pub.concern_status,
        report_version: row.report_version || 1,
        version_count: Number(row.version_count) || 0,
        has_report: pub.has_report,
        has_attachment: pub.has_attachment,
      };
    });
    return res.json({ success: true, data });
  } catch (error) { next(error); }
};

// ── POST /api/requests/:id/concern-version — Director saves an edited report ──
// Stores the (edited) PDF as the next report version. Used by the in-browser
// PDF editor and by direct uploads. Returns the new version metadata.
const saveConcernVersion = async (req, res, next) => {
  try {
    if (!isDirector(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Only a Clinical Director can edit reports.' });
    }
    const { file, filename, changeNote } = req.body || {};
    const mime = validateDataUrl(file, MAX_REPORT_LEN);
    if (!mime) return res.status(400).json({ success: false, message: 'Report must be a JPG, PNG, or PDF under 20 MB.' });

    const cur = await db.query(`SELECT * FROM client_requests WHERE id = $1`, [req.params.id]);
    if (!cur.rowCount) return res.status(404).json({ success: false, message: 'Ticket not found.' });
    const ticket = cur.rows[0];
    if (ticket.nature !== 'report_concern') {
      return res.status(400).json({ success: false, message: 'This ticket is not a report concern.' });
    }

    const maxq = await db.query(`SELECT COALESCE(MAX(version_number),0) AS mx FROM client_request_report_versions WHERE request_id = $1`, [req.params.id]);
    const nextVersion = Number(maxq.rows[0].mx) + 1;
    const vname = (filename || `report_v${nextVersion}.pdf`).slice(0, 255);

    const vr = await db.query(
      `INSERT INTO client_request_report_versions (request_id, version_number, file, filename, mime, change_note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, version_number, filename, change_note, created_at`,
      [req.params.id, nextVersion, file, vname, mime, (changeNote || 'Report updated').slice(0, 500), req.user.id]);

    // Keep report_version + report_file (latest) in sync, but do NOT release to
    // the client yet — release happens on Resolve.
    await db.query(
      `UPDATE client_requests
       SET report_version = $1, report_file = $2, report_filename = $3, report_mime = $4, updated_at = NOW()
       WHERE id = $5`,
      [nextVersion, file, vname, mime, req.params.id]);

    await audit(req.user.id, 'CONCERN_REPORT_EDITED', req.params.id, req, { ticket: ticket.ticket_number, version: nextVersion });
    await reqAudit(req.params.id, req.user.id, 'REPORT_UPDATED',
      `Report edited — version ${nextVersion} created${changeNote ? ' (' + changeNote + ')' : ''}.`);

    return res.json({ success: true, message: `Report version ${nextVersion} saved.`, data: vr.rows[0] });
  } catch (error) { next(error); }
};

// ── GET /api/requests/:id/concern-versions — version history (spec §13) ──
const getConcernVersions = async (req, res, next) => {
  try {
    const cur = await db.query(`SELECT client_id, report_released_at FROM client_requests WHERE id = $1`, [req.params.id]);
    if (!cur.rowCount) return res.status(404).json({ success: false, message: 'Ticket not found.' });
    const staff = isStaff(req.user.role);
    if (!staff && cur.rows[0].client_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }
    const r = await db.query(
      `SELECT v.id, v.version_number, v.filename, v.change_note, v.created_at, u.full_name AS created_by_name
       FROM client_request_report_versions v
       LEFT JOIN users u ON u.id = v.created_by
       WHERE v.request_id = $1 ORDER BY v.version_number ASC`, [req.params.id]);
    let rows = r.rows;
    // Clients can only see the latest released version (spec §13).
    if (!staff) {
      if (!cur.rows[0].report_released_at || !rows.length) rows = [];
      else rows = [rows[rows.length - 1]];
    }
    return res.json({ success: true, data: rows });
  } catch (error) { next(error); }
};

// ── PUT /api/requests/:id/concern-review — Director acts on a concern ──
// action: 'investigate' | 'request_info' | 'resolve' | 'reject'
const reviewConcern = async (req, res, next) => {
  try {
    if (!isDirector(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Only a Clinical Director can review report concerns.' });
    }
    const { action, info, reason, resolutionNote, decision } = req.body || {};
    if (!['investigate', 'request_info', 'resolve', 'reject'].includes(action)) {
      return res.status(400).json({ success: false, message: 'Invalid concern action.' });
    }
    const cur = await db.query(`SELECT * FROM client_requests WHERE id = $1`, [req.params.id]);
    if (!cur.rowCount) return res.status(404).json({ success: false, message: 'Ticket not found.' });
    const ticket = cur.rows[0];
    if (ticket.nature !== 'report_concern') {
      return res.status(400).json({ success: false, message: 'This ticket is not a report concern.' });
    }
    if (['Resolved', 'Rejected'].includes(concernStatus(ticket))) {
      return res.status(409).json({ success: false, message: 'This concern has already been closed.' });
    }

    // ── Mark Under Investigation ──
    if (action === 'investigate') {
      const r = await db.query(
        `UPDATE client_requests SET concern_status = 'Under Investigation', status = 'under_review', updated_at = NOW()
         WHERE id = $1 RETURNING *`, [req.params.id]);
      await audit(req.user.id, 'CONCERN_INVESTIGATE', req.params.id, req, { ticket: ticket.ticket_number });
      await reqAudit(req.params.id, req.user.id, 'INVESTIGATION_STARTED', 'Concern marked under investigation.');
      try {
        await notificationService.notifyUser(ticket.client_id, 'ticket', 'Concern Under Investigation',
          `Your report concern (${ticket.ticket_number}) is now under investigation by the Clinical Director.`, 'profile.html?section=requests');
      } catch (_) {}
      return res.json({ success: true, message: 'Concern marked under investigation.', data: publicRow(r.rows[0]) });
    }

    // ── Request Additional Information (spec §11) ──
    if (action === 'request_info') {
      if (!info || !String(info).trim()) {
        return res.status(400).json({ success: false, message: 'Please specify the information being requested.' });
      }
      const note = String(info).trim();
      const r = await db.query(
        `UPDATE client_requests SET concern_status = 'Client Action Required', concern_info_request = $1,
                status = 'under_review', updated_at = NOW()
         WHERE id = $2 RETURNING *`, [note, req.params.id]);
      await audit(req.user.id, 'CONCERN_REQUEST_INFO', req.params.id, req, { ticket: ticket.ticket_number });
      await reqAudit(req.params.id, req.user.id, 'ADDITIONAL_INFO_REQUESTED', `Requested additional information: ${note}`);
      try {
        await notificationService.notifyUser(ticket.client_id, 'ticket', 'Additional Information Required',
          `Additional information is required to process your concern (${ticket.ticket_number}). ${note}`,
          `profile.html?section=requests&concernInfo=${req.params.id}`);
      } catch (_) {}
      return res.json({ success: true, message: 'Additional information requested from the client.', data: publicRow(r.rows[0]) });
    }

    // ── Reject Concern (spec §12) ──
    if (action === 'reject') {
      if (!reason || !String(reason).trim()) {
        return res.status(400).json({ success: false, message: 'A rejection reason is mandatory.' });
      }
      const reasonTxt = String(reason).trim();
      const r = await db.query(
        `UPDATE client_requests SET concern_status = 'Rejected', concern_rejection_reason = $1,
                status = 'rejected', updated_at = NOW()
         WHERE id = $2 RETURNING *`, [reasonTxt, req.params.id]);
      await audit(req.user.id, 'CONCERN_REJECTED', req.params.id, req, { ticket: ticket.ticket_number, reason: reasonTxt });
      await reqAudit(req.params.id, req.user.id, 'CONCERN_REJECTED', `Concern rejected. Reason: ${reasonTxt}`);
      try {
        await notificationService.notifyUser(ticket.client_id, 'ticket', 'Report Concern Rejected',
          `Your report concern (${ticket.ticket_number}) has been reviewed and rejected. Reason: ${reasonTxt}`,
          'profile.html?section=requests');
      } catch (_) {}
      return res.json({ success: true, message: 'Concern rejected.', data: publicRow(r.rows[0]) });
    }

    // ── Resolve Concern (spec §§4-10) ──
    // A correction-type concern (or an explicit "revise" decision) must have a
    // new report version. A "maintain/keep" decision (or any resolution with no
    // report change) requires a mandatory resolution / review note.
    const needsVersion = concernRequiresVersion(ticket, decision);
    const verq = await db.query(`SELECT COUNT(*) AS n FROM client_request_report_versions WHERE request_id = $1`, [req.params.id]);
    const hasVersion = Number(verq.rows[0].n) > 0;

    if (needsVersion && !hasVersion) {
      return res.status(409).json({ success: false, message: 'Please edit and save a corrected report version before resolving this concern.' });
    }
    const noteTxt = (resolutionNote || '').trim();
    if (!needsVersion && !noteTxt) {
      return res.status(400).json({ success: false, message: 'A resolution / review note is required when no report change is made.' });
    }

    // Build the client-facing resolution message per concern kind.
    let resolvedMsg = 'Your report concern has been resolved. Please review the updated report.';
    let list = [];
    try { list = Array.isArray(ticket.concerns) ? ticket.concerns : JSON.parse(ticket.concerns || '[]'); } catch (_) {}
    const kinds = list.map(v => CONCERN_KIND[String(v).toLowerCase()]).filter(Boolean);
    if (decision === 'maintain' || decision === 'keep') {
      resolvedMsg = kinds.includes('recommendations')
        ? 'Your concern has been reviewed. The recommendations remain unchanged after clinical evaluation.'
        : 'Your concern has been reviewed. The findings and diagnosis remain unchanged.';
      if (noteTxt) resolvedMsg += ` Clinical Director's note: ${noteTxt}`;
    } else if (kinds.includes('name')) {
      resolvedMsg = 'Your concern regarding the misspelled name has been resolved. A corrected report is now available.';
    } else if (kinds.includes('dob')) {
      resolvedMsg = 'Your concern regarding the incorrect birthday/age has been resolved.';
    } else if (kinds.includes('address')) {
      resolvedMsg = 'Your report has been updated with the correct address.';
    } else if (kinds.includes('missing')) {
      resolvedMsg = 'The missing pages/documents have been added and are now available.';
    } else if (kinds.includes('findings')) {
      resolvedMsg = 'Your concern regarding the findings/diagnosis has been reviewed and the report has been updated.';
    } else if (kinds.includes('recommendations')) {
      resolvedMsg = 'Your recommendations have been updated. Please review the revised report.';
    }

    // Release the latest version to the client when one exists (reuses the
    // existing client report-download path: report_file + report_released_at +
    // sent_at make it appear in the client's tickets / Generated Reports).
    if (hasVersion) {
      const latest = await db.query(`SELECT * FROM client_request_report_versions WHERE request_id = $1 ORDER BY version_number DESC LIMIT 1`, [req.params.id]);
      const v = latest.rows[0];
      await db.query(
        `UPDATE client_requests
         SET concern_status = 'Resolved', status = 'resolved',
             concern_resolution_note = $1, concern_review_note = $2,
             report_file = $3, report_filename = $4, report_mime = $5, report_version = $6,
             report_released_at = NOW(), sent_at = NOW(), sent_by = $7, updated_at = NOW()
         WHERE id = $8`,
        [noteTxt || null, (decision === 'maintain' || decision === 'keep') ? noteTxt : null,
         v.file, v.filename, v.mime, v.version_number, req.user.id, req.params.id]);
    } else {
      await db.query(
        `UPDATE client_requests
         SET concern_status = 'Resolved', status = 'resolved',
             concern_resolution_note = $1, concern_review_note = $2, updated_at = NOW()
         WHERE id = $3`,
        [noteTxt || null, noteTxt || null, req.params.id]);
    }

    await audit(req.user.id, 'CONCERN_RESOLVED', req.params.id, req, { ticket: ticket.ticket_number, decision: decision || 'revise' });
    await reqAudit(req.params.id, req.user.id, 'CONCERN_RESOLVED',
      `Concern resolved${decision ? ' (' + decision + ')' : ''}.${noteTxt ? ' Note: ' + noteTxt : ''}`);
    try {
      await notificationService.notifyUser(ticket.client_id, 'ticket', 'Report Concern Resolved', resolvedMsg,
        'profile.html?section=requests');
    } catch (_) {}

    const fin = await db.query(`SELECT * FROM client_requests WHERE id = $1`, [req.params.id]);
    return res.json({ success: true, message: 'Concern resolved.', data: publicRow(fin.rows[0]) });
  } catch (error) { next(error); }
};

// ── POST /api/requests/:id/concern-info — client submits requested info ──
const submitConcernInfo = async (req, res, next) => {
  try {
    const { message, attachment, attachmentName } = req.body || {};
    const cur = await db.query(`SELECT * FROM client_requests WHERE id = $1`, [req.params.id]);
    if (!cur.rowCount) return res.status(404).json({ success: false, message: 'Ticket not found.' });
    const ticket = cur.rows[0];
    if (ticket.client_id !== req.user.id) return res.status(403).json({ success: false, message: 'Access denied.' });
    if (concernStatus(ticket) !== 'Client Action Required') {
      return res.status(409).json({ success: false, message: 'No additional information is being requested on this concern.' });
    }
    if ((!message || !String(message).trim()) && !attachment) {
      return res.status(400).json({ success: false, message: 'Please provide a remark or attach a file.' });
    }
    let updates = { attachment: null, name: null, mime: null };
    if (attachment) {
      const mime = validateDataUrl(attachment);
      if (!mime) return res.status(400).json({ success: false, message: 'Attachment must be a JPG, PNG, or PDF under 5 MB.' });
      updates = { attachment, name: (attachmentName || 'additional').slice(0, 255), mime };
    }
    // Record the client's remark as a reply, store the newly uploaded file (if
    // any) as the ticket attachment, and return the concern to "Under Investigation".
    if (message && String(message).trim()) {
      await db.query(`INSERT INTO client_request_replies (request_id, user_id, message) VALUES ($1,$2,$3)`,
        [req.params.id, req.user.id, String(message).trim()]);
    }
    if (updates.attachment) {
      await db.query(
        `UPDATE client_requests SET attachment = $1, attachment_name = $2, attachment_mime = $3 WHERE id = $4`,
        [updates.attachment, updates.name, updates.mime, req.params.id]);
    }
    const r = await db.query(
      `UPDATE client_requests SET concern_status = 'Under Investigation', updated_at = NOW()
       WHERE id = $1 RETURNING *`, [req.params.id]);
    await audit(req.user.id, 'CONCERN_INFO_SUBMITTED', req.params.id, req, { ticket: ticket.ticket_number });
    await reqAudit(req.params.id, req.user.id, 'ADDITIONAL_INFO_SUBMITTED',
      `Client submitted additional information${message ? ': ' + String(message).trim() : '.'}`);
    try {
      await notificationService.notifyRole('clinical_director', 'ticket', 'Additional Information Received',
        `The client submitted additional information for concern ${ticket.ticket_number}.`, 'psych-reports.html#reportConcerns');
    } catch (_) {}
    return res.json({ success: true, message: 'Additional information submitted.', data: publicRow(r.rows[0]) });
  } catch (error) { next(error); }
};

module.exports = {
  createRequest, getRequests, getRequest, getRequestFile,
  assignRequest, updateRequestStatus,
  promptPayment, uploadRequestPaymentProof, verifyRequestPayment,
  uploadRequestReport, replyToRequest, getReleasedReports,
  listReportRequests, reviewRequest, sendReport, getRequestAudit,
  listReportConcerns, reviewConcern, saveConcernVersion, getConcernVersions, submitConcernInfo,
  ADDITIONAL_COPY_FEE,
};
