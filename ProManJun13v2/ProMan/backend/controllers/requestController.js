const {
  db, User, RequestAuditLog, notificationService,
  getClientIP, isStaff, isDirector,
  audit, reqAudit,
  REQUEST_TYPE_LABELS,
  ADDITIONAL_COPY_FEE, ACCEPTED_MIMES, MAX_REPORT_LEN,
  STATUS_LABELS,
  validateDataUrl, generateTicketNumber, publicRow,
  reportRequestStatus, PAYMENT_JOIN,
} = require('./requestShared');
const securityEvents = require('../services/securityEvents');
const Payment = require('../models/Payment');
const PsychologicalReport = require('../models/PsychologicalReport');
const ReportSignedPdf = require('../models/ReportSignedPdf');
const ReportTemplate = require('../models/ReportTemplate');

// Re-fetch a single request WITH its linked-payment join so publicRow can derive
// the payment fields (used after writes, since UPDATE ... RETURNING * lacks the
// joined pay_* aliases).
async function fetchRequest(id) {
  const r = await db.query(`SELECT cr.*, pay.* FROM client_requests cr ${PAYMENT_JOIN} WHERE cr.id = $1`, [id]);
  return r.rows[0] || null;
}

// Create (or reuse) the centralized report-request payment row backing a ticket.
// Report-request payments live in the `payments` table (module='report_request',
// RPM- reference) so they appear in the Payment Verification module and are
// verified by the Supervising Psychometrician — not in the Report Requests
// section. The inline client_requests.payment_* columns are kept only as a synced
// display mirror (deprecated). Returns the payment row (existing or new).
async function ensureRequestPayment(ticket, fee) {
  const existing = await Payment.findActiveByClientRequest(ticket.id);
  if (existing) return existing;
  const referenceNumber = await Payment.generateReferenceNumber('RPM');
  return Payment.create({
    referenceNumber,
    clientId: ticket.client_id,
    clientRequestId: ticket.id,
    module: 'report_request',
    serviceLabel: `Report request ${ticket.ticket_number}`,
    paymentOption: 'full',
    paymentMethod: 'GCash',
    amountDue: fee,
    totalFee: fee,
    outstandingBalance: 0,
    agreedNoCancellation: 1,
    expiresInMinutes: 525600, // ~1 year — request payments do not time out like booking holds
  });
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

    // ── Legacy / external report request ──────────────────────────────────
    // The client's report predates the online system (or is paper-only), so it
    // cannot be picked from "my released reports". A photo ID is MANDATORY — the
    // Clinical Director must verify identity before any old report is released.
    const isLegacy = !!f.isLegacy;
    let idDocumentMime = null;
    if (isLegacy) {
      if (!f.idDocument) {
        return res.status(400).json({ success: false, message: 'A photo of a valid ID is required to verify your identity for an older/physical report.' });
      }
      idDocumentMime = validateDataUrl(f.idDocument);
      if (!idDocumentMime) {
        return res.status(400).json({ success: false, message: 'The ID must be a JPG, PNG, or PDF under 5 MB.' });
      }
    }

    const isConcern = f.nature === 'report_concern';

    // ── Concern linkage (spec: every concern is linked to Client ID + Case ID) ──
    // The client picks one of their RELEASED reports; from it we derive the
    // source report, its case, and the PSYCHOLOGIST who finalized/approved it
    // (psychological_reports.approved_by) — that psychologist (not the staff
    // member who merely prepared it, psychologist_id) is the report's author of
    // record and is the one asked to modify the report once the concern is
    // approved + paid. Falls back to psychologist_id for solo-authored reports.
    let concernCaseId = null, concernReportId = null, concernPsychologistId = null;
    // Legacy requests have no in-system report to link yet — the CD digitizes and
    // links it during verification — so skip the released-report requirement.
    if (isConcern && !isLegacy) {
      if (!f.reportId) {
        return res.status(400).json({ success: false, message: 'Please select the released report your concern is about.' });
      }
      const rep = await db.query(
        `SELECT id, client_id, case_id, psychologist_id, approved_by, signature_stage
         FROM psychological_reports WHERE id = $1`, [f.reportId]);
      if (!rep.rowCount) {
        return res.status(404).json({ success: false, message: 'The selected report could not be found.' });
      }
      const report = rep.rows[0];
      if (String(report.client_id) !== String(req.user.id)) {
        return res.status(403).json({ success: false, message: 'You can only raise a concern about your own report.' });
      }
      if (report.signature_stage !== 'released') {
        return res.status(409).json({ success: false, message: 'Concerns can only be raised about a released report.' });
      }
      concernReportId = report.id;
      concernCaseId = report.case_id || null;
      concernPsychologistId = report.approved_by || report.psychologist_id || null;
    }

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
        concern_status, copies,
        case_id, report_id, assigned_psychologist_id,
        is_legacy, legacy_status, id_document, id_document_name, id_document_mime
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
      RETURNING *`,
      [
        ticket, req.user.id, f.familyName, f.givenName, f.mi || null,
        f.guardianName || null, f.assessmentDate || null, f.contactNumber || null, f.centerBranch || null,
        f.nature, JSON.stringify(concerns), f.concernOther || null, String(f.description).trim(),
        f.attachment || null, f.attachment ? (f.attachmentName || 'attachment').slice(0, 255) : null, attachmentMime,
        // Legacy requests gate on legacy_status (Records Verification) first, so a
        // legacy concern's concern_status stays NULL until the CD verifies it.
        (isConcern && !isLegacy) ? 'Pending Review' : null, copies,
        concernCaseId, concernReportId, concernPsychologistId,
        isLegacy, isLegacy ? 'Records Verification' : null,
        isLegacy ? f.idDocument : null,
        isLegacy ? (f.idDocumentName || 'id').slice(0, 255) : null,
        idDocumentMime,
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
        isLegacy
          ? `Your request about an older/physical report has been received (ticket ${ticket}). Our Clinical Director will verify your identity and locate your report, then notify you of the next step.`
          : `Your ${f.nature === 'additional_copies' ? `request for ${copiesText} of your report` : 'report concern'} has been received. Your ticket number is ${ticket}. We'll notify you as it progresses.`,
        'profile.html?section=requests'
      );
    } catch (_) {}
    try {
      if (isLegacy) {
        await notificationService.notifyRole(
          'clinical_director', 'ticket', 'Legacy Report Request — Verification Required',
          `${clientName} submitted a ${isConcern ? 'concern' : 'copy request'} about an older/physical report (ticket ${ticket}). Verify their identity and locate/digitize the report.`,
          `psych-reports.html?legacy=${row.id}`
        );
        await reqAudit(row.id, req.user.id, 'LEGACY_SUBMITTED', 'Legacy report request submitted — awaiting identity & records verification.');
      } else {
        await notificationService.notifyRole(
          'clinical_director',
          'ticket', isConcern ? 'New Report Concern Submitted' : 'New Client Request/Concern',
          isConcern
            ? `${clientName} submitted a report concern (ticket ${ticket}). A new report concern has been submitted.`
            : `${clientName} submitted a request for additional report copies — ${copiesText} (ticket ${ticket}).`,
          isConcern ? 'psych-reports.html#reportConcerns' : 'psych-reports.html#reportRequests'
        );
        await reqAudit(row.id, req.user.id,
          isConcern ? 'CONCERN_SUBMITTED' : 'STAFF_NOTIFIED',
          isConcern ? 'Staff notified of the new submission.' : `Staff notified — ${copiesText} requested.`);
      }
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
        `SELECT cr.*, pay.*, u.full_name AS client_account_name, u.email AS client_email,
                s.full_name AS assigned_staff_name
         FROM client_requests cr
         JOIN users u ON u.id = cr.client_id
         LEFT JOIN users s ON s.id = cr.assigned_staff_id
         ${PAYMENT_JOIN}
         ORDER BY cr.created_at DESC`);
      rows = r.rows;
    } else {
      const r = await db.query(
        `SELECT cr.*, pay.*, s.full_name AS assigned_staff_name
         FROM client_requests cr
         LEFT JOIN users s ON s.id = cr.assigned_staff_id
         ${PAYMENT_JOIN}
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
      `SELECT cr.*, pay.*, u.full_name AS client_account_name, s.full_name AS assigned_staff_name,
              pr.report_code AS report_code
       FROM client_requests cr
       JOIN users u ON u.id = cr.client_id
       LEFT JOIN users s ON s.id = cr.assigned_staff_id
       LEFT JOIN psychological_reports pr ON pr.id = cr.report_id
       ${PAYMENT_JOIN}
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
    else if (type === 'id_document' && staff) {
      // Photo ID uploaded for legacy identity verification — staff-only.
      dataUrl = row.id_document; name = row.id_document_name;
    }
    else if (type === 'proof' && staff) {
      // Proof of payment now lives on the linked payment row (Payment Verification module).
      const pp = await db.query(
        `SELECT proof_of_payment, proof_filename FROM payments
         WHERE client_request_id = $1 ORDER BY created_at DESC LIMIT 1`, [req.params.id]);
      if (pp.rowCount) { dataUrl = pp.rows[0].proof_of_payment; name = pp.rows[0].proof_filename; }
    }
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
        securityEvents.record({
          module: 'report_storage', eventType: 'unauthorized_report_access',
          userId: req.user.id, subjectKind: 'user', ip: getClientIP(req),
          details: `Client attempted to access report for request #${req.params.id} before it was released.`,
        });
        return res.status(403).json({ success: false, message: 'The report has not been sent to you yet.' });
      }
      // The report blob lives in the version table now (not on the request row).
      // Serve the latest version; the request row only holds the display name.
      const lv = await db.query(
        `SELECT file, filename FROM client_request_report_versions
         WHERE request_id = $1 ORDER BY version_number DESC LIMIT 1`, [req.params.id]);
      if (lv.rowCount) { dataUrl = lv.rows[0].file; name = row.report_filename || lv.rows[0].filename; }
    }
    if (!dataUrl) return res.status(404).json({ success: false, message: 'File not found.' });
    return res.json({ success: true, data: { name, dataUrl } });
  } catch (error) { next(error); }
};

// ── PUT /api/requests/:id/assign — admin assigns staff + deadline ──
const assignRequest = async (req, res, next) => {
  try {
    const { staffId, deadline } = req.body || {};
    const upd = await db.query(
      `UPDATE client_requests SET assigned_staff_id = $1, deadline = $2, updated_at = NOW()
       WHERE id = $3 RETURNING id`,
      [staffId || null, deadline || null, req.params.id]);
    if (!upd.rowCount) return res.status(404).json({ success: false, message: 'Ticket not found.' });
    const row = await fetchRequest(req.params.id);
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

    // Additional-copy requests must have a verified payment before resolution.
    // Payment state comes from the linked payment row (inline columns dropped):
    // a payment that exists but isn't verified blocks resolution.
    if (status === 'resolved') {
      const pay = await Payment.findActiveByClientRequest(ticket.id);
      if (pay && pay.status !== 'verified') {
        return res.status(409).json({ success: false, message: 'Payment must be verified before resolving this request.' });
      }
    }
    if (status === 'resolved' && !(resolutionNote && resolutionNote.trim()) && !ticket.resolution_note) {
      return res.status(400).json({ success: false, message: 'A resolution note is required to resolve a ticket.' });
    }

    await db.query(
      `UPDATE client_requests
       SET status = $1, resolution_note = COALESCE($2, resolution_note), updated_at = NOW()
       WHERE id = $3`,
      [status, resolutionNote && resolutionNote.trim() ? resolutionNote.trim() : null, req.params.id]);
    const row = await fetchRequest(req.params.id);

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
    const payment = await ensureRequestPayment(cur.rows[0], amount);
    const reference = payment.reference_number;
    await db.query(
      `UPDATE client_requests SET status = 'under_review', updated_at = NOW() WHERE id = $1`,
      [req.params.id]);
    const row = await fetchRequest(req.params.id);
    await audit(req.user.id, 'REQUEST_PAYMENT_PROMPT', row.id, req, { ticket: row.ticket_number, amount });
    await reqAudit(row.id, req.user.id, 'PAYMENT_PROMPTED', `Client prompted for payment of ₱${amount.toFixed(2)}.`);
    try {
      await notificationService.notifyUser(row.client_id, 'ticket', 'Payment Required for Your Request',
        `Your request ${row.ticket_number} for additional report copies requires a fee of ₱${amount.toFixed(2)}. Open your ticket to scan the clinic QR and upload your proof of payment.`,
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

    // Payment state is derived from the linked payment row (the inline columns
    // were dropped). The payment must be awaiting proof (pending) or rejected
    // (re-upload after a rejection).
    const pay = await Payment.findActiveByClientRequest(ticket.id);
    if (!pay || !['pending', 'rejected'].includes(pay.status)) {
      return res.status(409).json({ success: false, message: 'This ticket is not awaiting payment.' });
    }
    const mime = validateDataUrl(proof);
    if (!mime) return res.status(400).json({ success: false, message: 'Proof must be a JPG, PNG, or PDF under 5 MB.' });

    // The proof of payment lives ONLY on the centralized payment row, where it
    // surfaces in the Payment Verification module for the Supervising
    // Psychometrician to review.
    await Payment.attachProof(pay.id, { dataUrl: proof, filename: (filename || 'proof').slice(0, 255), mime });
    // A report concern advances to "Payment Verification Pending" once proof is in
    // (spec §3). Additional-copies tickets keep their derived display status.
    if (ticket.nature === 'report_concern') {
      await db.query(
        `UPDATE client_requests SET concern_status = 'Payment Verification Pending', updated_at = NOW() WHERE id = $1`,
        [req.params.id]);
    }
    const row = await fetchRequest(req.params.id);

    await audit(req.user.id, 'REQUEST_PAYMENT_PROOF', row.id, req, { ticket: row.ticket_number });
    await reqAudit(row.id, req.user.id, 'PAYMENT_SUBMITTED', 'Client submitted proof of payment for verification.');
    try {
      // Verification now happens in the Payment Verification module (Supervising
      // Psychometrician), not the Report Requests section. Use the 'ticket' type
      // (report requests ARE tickets) so the notification is filed under the
      // Tickets category and its action navigates straight to the Payment
      // Verification module — NOT the 'payment' type, which is categorized as an
      // appointment and would open the appointment-payment modal instead.
      await notificationService.notifyRoles(['supervising_psychometrician', 'clinical_director'], 'ticket',
        'Report-Request Payment Awaiting Verification',
        `A client submitted proof of payment for report request ${row.ticket_number}${pay.reference_number ? ` (ref ${pay.reference_number})` : ''}. Verify it in the Payment Verification module.`,
        'payments-admin.html');
    } catch (_) {}
    return res.json({ success: true, message: 'Proof submitted — awaiting staff verification.', data: publicRow(row) });
  } catch (error) { next(error); }
};

// ── PUT /api/requests/:id/payment-verify — DEPRECATED / CLOSED ──
// Report-request payment verification was relocated to the Payment Verification
// module and is now performed exclusively by the Supervising Psychometrician
// (PUT /api/payments/:id/verify). This in-section endpoint is closed so
// verification cannot bypass that workflow.
const verifyRequestPayment = async (req, res) => {
  return res.status(410).json({
    success: false,
    message: 'Payment verification has moved to the Payment Verification module (handled by the Supervising Psychometrician).',
  });
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
    // Payment-verified gate derived from the linked payment row (inline columns dropped).
    const payGate = await Payment.findActiveByClientRequest(ticket.id);
    if (payGate && payGate.status !== 'verified') {
      return res.status(409).json({ success: false, message: 'Payment must be verified before releasing the report.' });
    }
    const fname = (filename || 'report.pdf').slice(0, 255);
    // Store the PDF in the append-only version table — NOT as base64 on the
    // request row. client_requests keeps only lightweight metadata pointers.
    const vq = await db.query(
      `SELECT COALESCE(MAX(version_number),0)+1 AS n FROM client_request_report_versions WHERE request_id = $1`,
      [req.params.id]);
    const vnum = Number(vq.rows[0].n);
    await db.query(
      `INSERT INTO client_request_report_versions (request_id, version_number, file, filename, mime, change_note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [req.params.id, vnum, file, fname, mime, 'Report released', req.user.id]);
    await db.query(
      `UPDATE client_requests
       SET report_filename = $1, report_mime = $2, report_version = $3,
           report_released_at = NOW(), status = 'resolved', updated_at = NOW()
       WHERE id = $4`,
      [fname, mime, vnum, req.params.id]);
    const row = await fetchRequest(req.params.id);
    await audit(req.user.id, 'RELEASE_REQUEST_REPORT', row.id, req, { ticket: row.ticket_number, filename: row.report_filename });
    await reqAudit(row.id, req.user.id, 'REPORT_GENERATED',
      `Report generated/attached (${row.report_filename}). Ticket resolved; ready to send.`);
    try {
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
        await notificationService.notifyRole('clinical_director', 'ticket', 'Ticket Flagged for Further Review',
          `Ticket ${ticket.ticket_number} was flagged by the client for further review.`, 'psych-reports.html#reportRequests');
      } catch (_) {}
    } else if (!staff) {
      try {
        await notificationService.notifyRole('clinical_director', 'ticket', 'New Reply on Ticket',
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
      `SELECT cr.*, pay.*, u.full_name AS client_account_name, u.email AS client_email,
              s.full_name AS assigned_staff_name
       FROM client_requests cr
       JOIN users u ON u.id = cr.client_id
       LEFT JOIN users s ON s.id = cr.assigned_staff_id
       ${PAYMENT_JOIN}
       WHERE cr.nature = 'additional_copies' AND cr.is_legacy IS NOT TRUE
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
        payment_status: pub.payment_status,
        payment_amount: pub.payment_amount,
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
      await db.query(
        `UPDATE client_requests
         SET status = 'rejected', rejection_reason = $1, updated_at = NOW()
         WHERE id = $2`, [reasonTxt, req.params.id]);
      const row = await fetchRequest(req.params.id);
      await audit(req.user.id, 'REJECT_REQUEST', row.id, req, { ticket: row.ticket_number, reason: reasonTxt });
      await reqAudit(row.id, req.user.id, 'REQUEST_REJECTED', `Request rejected. Reason: ${reasonTxt}`);
      try {
        await notificationService.notifyUser(row.client_id, 'ticket', 'Report Request Rejected',
          `Your report request (${row.ticket_number}) has been rejected. Reason: ${reasonTxt}`, `requests.html?resubmit=1`);
      } catch (_) {}
      return res.json({ success: true, message: 'Request rejected.', data: publicRow(row) });
    }

    // Approve → create the centralized report-request payment (it now lives in
    // the payments table / Payment Verification module, RPM- reference, verified
    // by the Supervising Psychometrician) and move the request to Awaiting Payment.
    const fee = Number(amount) || ADDITIONAL_COPY_FEE;
    const payment = await ensureRequestPayment(ticket, fee);
    const reference = payment.reference_number;
    // Payment state lives entirely on the payments row created above; the request
    // only records the approval + lifecycle status.
    await db.query(
      `UPDATE client_requests
       SET status = 'under_review', approved_at = NOW(), approved_by = $1,
           rejection_reason = NULL, updated_at = NOW()
       WHERE id = $2`, [req.user.id, req.params.id]);
    const row = await fetchRequest(req.params.id);
    await audit(req.user.id, 'APPROVE_REQUEST', row.id, req, { ticket: row.ticket_number, amount: fee });
    await reqAudit(row.id, req.user.id, 'REQUEST_APPROVED',
      `Request approved. Awaiting payment of ₱${fee.toFixed(2)} (ref ${reference}).`);
    await reqAudit(row.id, req.user.id, 'PAYMENT_PROMPTED', 'Client directed to the payment workflow.');
    try {
      await notificationService.notifyUser(row.client_id, 'ticket', 'Report Request Approved',
        `Your report request has been approved. Please proceed to payment of ₱${fee.toFixed(2)} for ticket ${row.ticket_number}.`,
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
    const ticket = await fetchRequest(req.params.id);
    if (!ticket) return res.status(404).json({ success: false, message: 'Ticket not found.' });

    // Must be in Payment Verified or Resolved state to send.
    const displayStatus = reportRequestStatus(ticket);
    if (!['Payment Verified', 'Resolved'].includes(displayStatus)) {
      return res.status(409).json({ success: false, message: 'Payment must be verified before sending a report.' });
    }

    const { file, filename } = req.body || {};

    // If a report file is provided in this request, save it first (as a version).
    if (file) {
      const mime = validateDataUrl(file);
      if (!mime) return res.status(400).json({ success: false, message: 'Report must be a JPG, PNG, or PDF under 5 MB.' });
      const fname = (filename || 'report.pdf').slice(0, 255);
      const vq = await db.query(
        `SELECT COALESCE(MAX(version_number),0)+1 AS n FROM client_request_report_versions WHERE request_id = $1`,
        [req.params.id]);
      const vnum = Number(vq.rows[0].n);
      await db.query(
        `INSERT INTO client_request_report_versions (request_id, version_number, file, filename, mime, change_note, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [req.params.id, vnum, file, fname, mime, 'Report uploaded for sending', req.user.id]);
      await db.query(
        `UPDATE client_requests
         SET report_filename = $1, report_mime = $2, report_version = $3,
             report_released_at = NOW(), status = 'resolved', updated_at = NOW()
         WHERE id = $4`,
        [fname, mime, vnum, req.params.id]);
      await reqAudit(req.params.id, req.user.id, 'REPORT_GENERATED', `Report uploaded by CD (${fname}).`);
    } else {
      // No new file — there must be a stored report version to send.
      const anyVer = await db.query(`SELECT 1 FROM client_request_report_versions WHERE request_id = $1 LIMIT 1`, [req.params.id]);
      if (!anyVer.rowCount) {
        return res.status(409).json({ success: false, message: 'Please upload the report file before sending.' });
      }
    }

    // Mark the request as sent. Ensure report_released_at is set (the "no new
    // file" path — e.g. a pre-seeded legacy copy — otherwise the client can't
    // download the version).
    await db.query(
      `UPDATE client_requests SET sent_at = NOW(), sent_by = $1,
              report_released_at = COALESCE(report_released_at, NOW()), updated_at = NOW()
       WHERE id = $2`, [req.user.id, req.params.id]);
    const row = await fetchRequest(req.params.id);
    // Clear the "Legacy Report" flag on the linked report once the copy is released.
    if (row.report_id) {
      await db.query(
        `UPDATE psychological_reports SET modification_status = NULL, active_concern_id = NULL, updated_at = NOW()
         WHERE id = $1 AND modification_status = 'Legacy Report'`, [row.report_id]).catch(() => {});
    }
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

// ── GET /api/requests/legacy-verifications — CD queue of legacy requests ──
// Old-client requests (copy or concern) about a report not in the system that
// need identity + records verification before entering the normal pipeline.
const listLegacyVerifications = async (req, res, next) => {
  try {
    if (!isDirector(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Only a Clinical Director can verify legacy requests.' });
    }
    const r = await db.query(
      `SELECT cr.*, pay.*, u.full_name AS client_account_name, u.email AS client_email,
              (SELECT COUNT(*) FROM client_request_report_versions v WHERE v.request_id = cr.id) AS version_count
       FROM client_requests cr
       JOIN users u ON u.id = cr.client_id
       ${PAYMENT_JOIN}
       WHERE cr.is_legacy = TRUE
       ORDER BY (cr.legacy_status = 'Records Verification') DESC, cr.created_at DESC`);
    const data = r.rows.map((row) => {
      const pub = publicRow(row, req.user.role);
      const isConcern = row.nature === 'report_concern';
      return {
        id: pub.id,
        ticket_number: pub.ticket_number,
        nature: row.nature,
        request_type_label: pub.request_type_label,
        client_name: row.client_account_name ||
          [row.client_given_name, row.client_mi, row.client_family_name].filter(Boolean).join(' '),
        client_email: row.client_email,
        guardian_name: row.guardian_name || null,
        assessment_date: row.assessment_date || null,
        center_branch: row.center_branch || null,
        contact_number: row.contact_number || null,
        copies: row.copies || 1,
        concerns: (() => { try { return Array.isArray(row.concerns) ? row.concerns : JSON.parse(row.concerns || '[]'); } catch (_) { return []; } })(),
        concern_other: row.concern_other || null,
        description: row.description || '',
        legacy_status: row.legacy_status || 'Records Verification',
        // Live pipeline status (after verification) so the CD manages the whole
        // legacy lifecycle from this one console.
        concern_status: isConcern ? pub.concern_status : null,
        report_request_status: isConcern ? null : pub.report_request_status,
        payment_status: pub.payment_status,
        report_id: row.report_id || null,
        has_report: pub.has_report,
        sent_at: row.sent_at || null,
        version_count: Number(row.version_count) || 0,
        concern_revision_note: row.concern_revision_note || null,
        has_id_document: pub.has_id_document,
        has_attachment: pub.has_attachment,
        date_submitted: row.created_at,
      };
    });
    return res.json({ success: true, data });
  } catch (error) { next(error); }
};

// ── PUT /api/requests/:id/legacy-verify — CD verifies identity + digitizes ──
// action 'approve': verify identity, register/link the (digitized) report, then
// hand off to the normal pipeline (concern → Awaiting Payment; copy → Awaiting
// Payment with the digitized PDF seeded for delivery).
// action 'reject': identity/records could not be verified.
const legacyVerify = async (req, res, next) => {
  try {
    if (!isDirector(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Only a Clinical Director can verify legacy requests.' });
    }
    const { action } = req.body || {};
    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ success: false, message: "Action must be 'approve' or 'reject'." });
    }
    const cur = await db.query(`SELECT * FROM client_requests WHERE id = $1`, [req.params.id]);
    if (!cur.rowCount) return res.status(404).json({ success: false, message: 'Ticket not found.' });
    const ticket = cur.rows[0];
    if (!ticket.is_legacy) {
      return res.status(400).json({ success: false, message: 'This is not a legacy report request.' });
    }
    if (ticket.legacy_status !== 'Records Verification') {
      return res.status(409).json({ success: false, message: 'This legacy request has already been verified.' });
    }
    const isConcern = ticket.nature === 'report_concern';

    // ── Reject ──
    if (action === 'reject') {
      const reason = String(req.body.reason || '').trim();
      if (!reason) return res.status(400).json({ success: false, message: 'A reason is required to reject a legacy request.' });
      await db.query(
        `UPDATE client_requests
         SET legacy_status = 'Rejected', status = 'rejected', rejection_reason = $1,
             concern_status = CASE WHEN nature = 'report_concern' THEN 'Rejected' ELSE concern_status END,
             updated_at = NOW()
         WHERE id = $2`, [reason, req.params.id]);
      await audit(req.user.id, 'LEGACY_REJECTED', req.params.id, req, { ticket: ticket.ticket_number, reason });
      await reqAudit(req.params.id, req.user.id, 'LEGACY_REJECTED', `Legacy request rejected. Reason: ${reason}`);
      try {
        await notificationService.notifyUser(ticket.client_id, 'ticket', 'Legacy Report Request — Not Verified',
          `We could not verify your request about an older report (ticket ${ticket.ticket_number}). Reason: ${reason} Please contact the clinic or visit in person to verify your identity.`,
          'profile.html?section=requests');
      } catch (_) {}
      return res.json({ success: true, message: 'Legacy request rejected.' });
    }

    // ── Approve: register/link the report ──
    const { reportPdf, reportFilename, psychologistId, existingReportId, clientName, assessmentDate, amount } = req.body || {};
    let reportId = null;

    if (existingReportId) {
      // The report is already in the system — link to it (de-duplication path).
      const rq = await db.query(
        `SELECT id, client_id, signature_stage FROM psychological_reports WHERE id = $1`, [parseInt(existingReportId, 10)]);
      if (!rq.rowCount) return res.status(404).json({ success: false, message: 'The selected existing report was not found.' });
      reportId = rq.rows[0].id;
    } else {
      // Create a new legacy report from the digitized official PDF.
      if (!reportPdf) {
        return res.status(400).json({ success: false, message: 'Upload the digitized report PDF (or pick an existing report).' });
      }
      const mime = validateDataUrl(reportPdf, MAX_REPORT_LEN);
      if (!mime) return res.status(400).json({ success: false, message: 'The report must be a JPG, PNG, or PDF under 20 MB.' });

      const tpl = await db.query(`SELECT id FROM report_templates ORDER BY id ASC LIMIT 1`);
      if (!tpl.rowCount) return res.status(400).json({ success: false, message: 'No report template is available to register a legacy report.' });
      const templateId = tpl.rows[0].id;
      const assignedPsych = psychologistId ? parseInt(psychologistId, 10) : req.user.id;
      const fullClientName = clientName ||
        [ticket.client_given_name, ticket.client_mi, ticket.client_family_name].filter(Boolean).join(' ') || 'Client';

      const report = await PsychologicalReport.create({
        template_id: templateId, psychologist_id: assignedPsych, client_id: ticket.client_id,
        client_name: fullClientName, client_age: null, client_gender: null,
        date_of_assessment: assessmentDate || ticket.assessment_date || null, case_id: null,
      });
      reportId = report.id;
      const legCode = (report.report_code || '').replace(/^BPS-RPT-/, 'LEG-') || report.report_code;
      await db.query(
        `UPDATE psychological_reports
         SET signature_stage = 'released', status = 'finalized', is_locked = TRUE, is_legacy = TRUE,
             approved_by = $1, prepared_by = $1, reviewed_by = $1, report_code = $2, updated_at = NOW()
         WHERE id = $3`, [assignedPsych, legCode, reportId]);
      try {
        const template = await ReportTemplate.findById(templateId);
        if (template && Array.isArray(template.sections_config) && template.sections_config.length) {
          await PsychologicalReport.createSections(reportId, template.sections_config);
        }
      } catch (_) { /* sections are non-fatal — the digitized PDF is the content */ }
      // Store the digitized PDF as the report's authoritative (released) PDF.
      await ReportSignedPdf.save(reportId, { pdfBase64: reportPdf, signatureStage: 'released', signedBy: req.user.id });
    }

    // The psychologist of record handles any concern about this report.
    const rprow = await db.query(`SELECT approved_by, psychologist_id, case_id FROM psychological_reports WHERE id = $1`, [reportId]);
    const approvedBy = rprow.rows[0].approved_by || rprow.rows[0].psychologist_id;
    const fee = Number(amount) || ADDITIONAL_COPY_FEE;

    await audit(req.user.id, 'LEGACY_VERIFIED', req.params.id, req, { ticket: ticket.ticket_number, report_id: reportId });
    await reqAudit(req.params.id, req.user.id, 'LEGACY_VERIFIED',
      `Identity verified and report registered (report #${reportId}). Linked to the request.`);

    // Link the report and move to Awaiting Payment. Legacy requests — copy AND
    // concern alike — are delivered as the digitized report (no in-report
    // modification), so we seed the deliverable version now; after payment the CD
    // simply Releases it from the Legacy Verifications console.
    await db.query(
      `UPDATE client_requests
       SET legacy_status = 'Verified', report_id = $1, assigned_psychologist_id = $2,
           case_id = $3,
           concern_status = CASE WHEN nature = 'report_concern' THEN 'Awaiting Payment' ELSE concern_status END,
           status = 'under_review', approved_at = NOW(), approved_by = $4, updated_at = NOW()
       WHERE id = $5`,
      [reportId, approvedBy, rprow.rows[0].case_id || null, req.user.id, req.params.id]);

    let deliverPdf = reportPdf || null, deliverMime = null;
    if (!deliverPdf) {
      const latest = await ReportSignedPdf.getLatest(reportId);
      if (latest && latest.pdf_base64) deliverPdf = latest.pdf_base64;
    }
    if (deliverPdf) {
      deliverMime = validateDataUrl(deliverPdf, MAX_REPORT_LEN) || 'application/pdf';
      const vq = await db.query(`SELECT COALESCE(MAX(version_number),0)+1 AS n FROM client_request_report_versions WHERE request_id = $1`, [req.params.id]);
      const vnum = Number(vq.rows[0].n);
      const vname = (reportFilename || 'report.pdf').slice(0, 255);
      await db.query(
        `INSERT INTO client_request_report_versions (request_id, version_number, file, filename, mime, change_note, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [req.params.id, vnum, deliverPdf, vname, deliverMime, 'Digitized legacy report', req.user.id]);
      await db.query(`UPDATE client_requests SET report_filename = $1, report_mime = $2, report_version = $3 WHERE id = $4`,
        [vname, deliverMime, vnum, req.params.id]);
    }
    await ensureRequestPayment(ticket, fee);
    try {
      await notificationService.notifyUser(ticket.client_id, 'ticket', 'Request Verified — Payment Required',
        `Your ${isConcern ? 'concern about your report' : 'request for a copy of your report'} (ticket ${ticket.ticket_number}) has been verified. Please proceed to payment of ₱${fee.toFixed(2)}.`,
        `request-payment.html?request=${ticket.id}`);
    } catch (_) {}
    return res.json({ success: true, message: 'Identity verified, report registered, client moved to payment.' });
  } catch (error) { next(error); }
};

module.exports = {
  createRequest, getRequests, getRequest, getRequestFile,
  assignRequest, updateRequestStatus,
  promptPayment, uploadRequestPaymentProof, verifyRequestPayment,
  uploadRequestReport, replyToRequest, getReleasedReports,
  listReportRequests, reviewRequest, sendReport, getRequestAudit,
  listLegacyVerifications, legacyVerify,
  ADDITIONAL_COPY_FEE,
};
