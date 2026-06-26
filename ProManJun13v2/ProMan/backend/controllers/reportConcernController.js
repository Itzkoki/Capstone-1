const {
  db, notificationService,
  isStaff, isDirector,
  audit, reqAudit,
  CONCERN_KIND, MAX_REPORT_LEN,
  concernStatus,
  validateDataUrl, publicRow,
} = require('./requestShared');
const Payment = require('../models/Payment');

// Clinic fee charged to process a report concern (₱). The Clinical Director may
// override the amount on approval.
const CONCERN_FEE = 1.00;

// Friendly, de-duplicated list of the concern types on a ticket.
function concernTypeLabel(row) {
  let list = [];
  try { list = Array.isArray(row.concerns) ? row.concerns : JSON.parse(row.concerns || '[]'); } catch (_) {}
  if (row.concern_other) list = list.concat(['Other']);
  if (!list.length) return 'Report Concern';
  return list.join(', ');
}

// Resolve the psychologist (staff_id) to notify/route for a concern. Prefers the
// stamped assigned_psychologist_id; falls back to the PSYCHOLOGIST who finalized
// the linked report (approved_by, the author of record) — or its preparer
// (psychologist_id) for solo-authored reports — and backfills it so concerns
// created before the column was populated still route.
async function resolveConcernPsychologistId(ticket) {
  if (ticket && ticket.assigned_psychologist_id != null) return ticket.assigned_psychologist_id;
  if (!ticket || ticket.report_id == null) return null;
  try {
    const r = await db.query(`SELECT psychologist_id, approved_by FROM psychological_reports WHERE id = $1`, [ticket.report_id]);
    const psyId = r.rows[0] && (r.rows[0].approved_by || r.rows[0].psychologist_id);
    if (psyId != null) {
      await db.query(`UPDATE client_requests SET assigned_psychologist_id = $1 WHERE id = $2`, [psyId, ticket.id]).catch(() => {});
      return psyId;
    }
  } catch (e) { console.error('resolveConcernPsychologistId failed:', e.message); }
  return null;
}

// Is the caller the AUTHOR of the report this concern is about? Authors are staff
// (psychological_reports.psychologist_id = staff.staff_id, stamped onto the
// concern as assigned_psychologist_id) and may hold any clinical authoring role
// (psychologist OR supervising/qc psychometrician) — the report's creator is who
// handles its concern, not a fixed 'psychologist' role.
function isReportAuthor(req, ticket) {
  return ticket.assigned_psychologist_id != null &&
    String(ticket.assigned_psychologist_id) === String(req.user.id);
}

// Create (or reuse) the centralized concern payment row. Concern payments live in
// the `payments` table (module='report_request', RPM- reference) so they surface
// in the Payment Verification module and are verified by the Supervising
// Psychometrician — identical plumbing to the additional-copies fee.
async function ensureConcernPayment(ticket, fee) {
  const existing = await Payment.findActiveByClientRequest(ticket.id);
  if (existing) return existing;
  const referenceNumber = await Payment.generateReferenceNumber('RPM');
  return Payment.create({
    referenceNumber,
    clientId: ticket.client_id,
    clientRequestId: ticket.id,
    module: 'report_request',
    serviceLabel: `Report concern ${ticket.ticket_number}`,
    paymentOption: 'full',
    paymentMethod: 'GCash',
    amountDue: fee,
    totalFee: fee,
    outstandingBalance: 0,
    agreedNoCancellation: 1,
    expiresInMinutes: 525600, // ~1 year — concern payments do not time out
  });
}

// ── GET /api/requests/report-concerns — Clinical Director "Report Concerns" tab ──
const listReportConcerns = async (req, res, next) => {
  try {
    if (!isDirector(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Only a Clinical Director can view report concerns.' });
    }
    const r = await db.query(
      `SELECT cr.*, u.full_name AS client_account_name, u.email AS client_email,
              NULLIF(TRIM(CONCAT(ps.first_name, ' ', ps.last_name)), '') AS assigned_psychologist_name,
              pr.report_code AS report_code,
              (SELECT COUNT(*) FROM client_request_report_versions v WHERE v.request_id = cr.id) AS version_count
       FROM client_requests cr
       JOIN users u ON u.id = cr.client_id
       LEFT JOIN staff ps ON ps.staff_id = cr.assigned_psychologist_id
       LEFT JOIN psychological_reports pr ON pr.id = cr.report_id
       WHERE cr.nature = 'report_concern' AND cr.is_legacy IS NOT TRUE
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
        case_id: row.case_id || null,
        report_id: row.report_id || null,
        report_code: row.report_code || null,
        assigned_psychologist_name: row.assigned_psychologist_name || null,
        report_version: row.report_version || 1,
        version_count: Number(row.version_count) || 0,
        has_modified_report: (Number(row.version_count) || 0) > 0,
        has_attachment: pub.has_attachment,
        payment_status: pub.payment_status,
      };
    });
    return res.json({ success: true, data });
  } catch (error) { next(error); }
};

// ── POST /api/requests/:id/concern-version — assigned psychologist (or CD) saves
// the modified report PDF as the next version. Used by the in-browser section
// editor and by direct "Upload Modified PDF". Returns the new version metadata. ──
const saveConcernVersion = async (req, res, next) => {
  try {
    const cur = await db.query(`SELECT * FROM client_requests WHERE id = $1`, [req.params.id]);
    if (!cur.rowCount) return res.status(404).json({ success: false, message: 'Ticket not found.' });
    const ticket = cur.rows[0];
    if (ticket.nature !== 'report_concern') {
      return res.status(400).json({ success: false, message: 'This ticket is not a report concern.' });
    }
    // Only the assigned psychologist or the Clinical Director may attach a
    // modified report. The psychologist may only do so once payment is verified.
    if (!isDirector(req.user.role) && !isReportAuthor(req, ticket)) {
      return res.status(403).json({ success: false, message: 'Only the assigned Psychologist can modify this report.' });
    }
    if (isReportAuthor(req, ticket) &&
        !['Payment Verified', 'Modified Report Submitted', 'Revision Required'].includes(concernStatus(ticket))) {
      return res.status(409).json({ success: false, message: 'You can modify the report only after the concern payment is verified.' });
    }

    const { file, filename, changeNote } = req.body || {};
    const mime = validateDataUrl(file, MAX_REPORT_LEN);
    if (!mime) return res.status(400).json({ success: false, message: 'Report must be a JPG, PNG, or PDF under 20 MB.' });

    const maxq = await db.query(`SELECT COALESCE(MAX(version_number),0) AS mx FROM client_request_report_versions WHERE request_id = $1`, [req.params.id]);
    const nextVersion = Number(maxq.rows[0].mx) + 1;
    const vname = (filename || `report_v${nextVersion}.pdf`).slice(0, 255);

    const vr = await db.query(
      `INSERT INTO client_request_report_versions (request_id, version_number, file, filename, mime, change_note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, version_number, filename, change_note, created_at`,
      [req.params.id, nextVersion, file, vname, mime, (changeNote || 'Modified report uploaded').slice(0, 500), req.user.id]);

    // Keep the lightweight metadata pointers in sync (the blob lives in the
    // version row). Do NOT release to the client yet — release happens when the
    // Clinical Director clicks Release Report.
    await db.query(
      `UPDATE client_requests
       SET report_version = $1, report_filename = $2, report_mime = $3, updated_at = NOW()
       WHERE id = $4`,
      [nextVersion, vname, mime, req.params.id]);

    await audit(req.user.id, 'CONCERN_REPORT_MODIFIED', req.params.id, req, { ticket: ticket.ticket_number, version: nextVersion });
    await reqAudit(req.params.id, req.user.id, 'REPORT_MODIFIED',
      `Modified report — version ${nextVersion} uploaded${changeNote ? ' (' + changeNote + ')' : ''}.`);

    return res.json({ success: true, message: `Modified report (version ${nextVersion}) saved.`, data: vr.rows[0] });
  } catch (error) { next(error); }
};

// ── GET /api/requests/:id/concern-versions — version history ──
const getConcernVersions = async (req, res, next) => {
  try {
    const cur = await db.query(`SELECT client_id, report_released_at FROM client_requests WHERE id = $1`, [req.params.id]);
    if (!cur.rowCount) return res.status(404).json({ success: false, message: 'Ticket not found.' });
    const staff = isStaff(req.user.role);
    if (!staff && cur.rows[0].client_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }
    const r = await db.query(
      `SELECT v.id, v.version_number, v.filename, v.change_note, v.created_at,
              COALESCE(u.full_name, NULLIF(TRIM(CONCAT(s.first_name, ' ', s.last_name)), '')) AS created_by_name
       FROM client_request_report_versions v
       LEFT JOIN users u ON u.id = v.created_by
       LEFT JOIN staff s ON s.staff_id = v.created_by
       WHERE v.request_id = $1 ORDER BY v.version_number ASC`, [req.params.id]);
    let rows = r.rows;
    // Clients can only see the latest released version.
    if (!staff) {
      if (!cur.rows[0].report_released_at || !rows.length) rows = [];
      else rows = [rows[rows.length - 1]];
    }
    return res.json({ success: true, data: rows });
  } catch (error) { next(error); }
};

// ── PUT /api/requests/:id/concern-review — Clinical Director reviews a concern ──
// action: 'approve' (→ Awaiting Payment) | 'reject' (→ Rejected). (Spec §2.)
const reviewConcern = async (req, res, next) => {
  try {
    if (!isDirector(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Only a Clinical Director can review report concerns.' });
    }
    const { action, reason, amount } = req.body || {};
    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ success: false, message: "Concern action must be 'approve' or 'reject'." });
    }
    const cur = await db.query(`SELECT * FROM client_requests WHERE id = $1`, [req.params.id]);
    if (!cur.rowCount) return res.status(404).json({ success: false, message: 'Ticket not found.' });
    const ticket = cur.rows[0];
    if (ticket.nature !== 'report_concern') {
      return res.status(400).json({ success: false, message: 'This ticket is not a report concern.' });
    }
    if (concernStatus(ticket) !== 'Pending Review') {
      return res.status(409).json({ success: false, message: 'This concern has already been reviewed.' });
    }

    // ── Reject (spec §2 → Concern Rejected) ──
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
          `Your report concern (${ticket.ticket_number}) was reviewed and found invalid. Reason: ${reasonTxt} You may submit a new concern.`,
          'requests.html');
      } catch (_) {}
      return res.json({ success: true, message: 'Concern rejected.', data: publicRow(r.rows[0]) });
    }

    // ── Approve (spec §2 → Awaiting Payment) ──
    const fee = Number(amount) || CONCERN_FEE;
    const payment = await ensureConcernPayment(ticket, fee);
    const r = await db.query(
      `UPDATE client_requests
       SET concern_status = 'Awaiting Payment', status = 'under_review',
           approved_at = NOW(), approved_by = $1, concern_rejection_reason = NULL, updated_at = NOW()
       WHERE id = $2 RETURNING *`, [req.user.id, req.params.id]);
    await audit(req.user.id, 'CONCERN_APPROVED', req.params.id, req, { ticket: ticket.ticket_number, amount: fee });
    await reqAudit(req.params.id, req.user.id, 'CONCERN_APPROVED',
      `Concern approved. Awaiting payment of ₱${fee.toFixed(2)} (ref ${payment.reference_number}).`);
    try {
      await notificationService.notifyUser(ticket.client_id, 'ticket', 'Report Concern Approved — Payment Required',
        `Your report concern (${ticket.ticket_number}) has been approved. Please proceed to payment of ₱${fee.toFixed(2)}.`,
        `request-payment.html?request=${ticket.id}`);
    } catch (_) {}
    return res.json({ success: true, message: 'Concern approved. Client moved to payment.', data: publicRow(r.rows[0]) });
  } catch (error) { next(error); }
};

// ── POST /api/requests/:id/concern-submit — assigned psychologist submits the
// modified report to the Clinical Director (spec §5). A modified PDF version must
// already exist. ──
const submitModifiedReport = async (req, res, next) => {
  try {
    const cur = await db.query(`SELECT * FROM client_requests WHERE id = $1`, [req.params.id]);
    if (!cur.rowCount) return res.status(404).json({ success: false, message: 'Ticket not found.' });
    const ticket = cur.rows[0];
    if (ticket.nature !== 'report_concern') {
      return res.status(400).json({ success: false, message: 'This ticket is not a report concern.' });
    }
    if (!isDirector(req.user.role) && !isReportAuthor(req, ticket)) {
      return res.status(403).json({ success: false, message: 'Only the assigned Psychologist can submit this report.' });
    }
    if (!['Payment Verified', 'Revision Required', 'Modified Report Submitted'].includes(concernStatus(ticket))) {
      return res.status(409).json({ success: false, message: 'This concern is not ready for report submission.' });
    }
    // A modified PDF must have been uploaded first (spec validation rule).
    const verq = await db.query(`SELECT COUNT(*) AS n FROM client_request_report_versions WHERE request_id = $1`, [req.params.id]);
    if (Number(verq.rows[0].n) === 0) {
      return res.status(409).json({ success: false, message: 'Please upload the modified PDF before submitting to the Clinical Director.' });
    }

    const r = await db.query(
      `UPDATE client_requests SET concern_status = 'Modified Report Submitted', status = 'under_review', updated_at = NOW()
       WHERE id = $1 RETURNING *`, [req.params.id]);
    // Reflect the submission on the report itself (report module badge).
    if (ticket.report_id) {
      await db.query(
        `UPDATE psychological_reports SET modification_status = 'Modified Report Submitted', updated_at = NOW() WHERE id = $1`,
        [ticket.report_id]).catch(() => {});
    }
    await audit(req.user.id, 'CONCERN_REPORT_SUBMITTED', req.params.id, req, { ticket: ticket.ticket_number });
    await reqAudit(req.params.id, req.user.id, 'MODIFIED_REPORT_SUBMITTED', 'Modified report submitted to the Clinical Director.');
    try {
      // Deep-link straight to the concern review so the CD's "View Details" opens
      // the original concern + modified report details + uploaded PDF + actions.
      await notificationService.notifyRole('clinical_director', 'ticket', 'Requested Concern Modified',
        `The modified report for concern ${ticket.ticket_number} has been submitted for your final review.`,
        `psych-reports.html?concern=${ticket.id}`);
    } catch (_) {}
    return res.json({ success: true, message: 'Modified report submitted to the Clinical Director.', data: publicRow(r.rows[0]) });
  } catch (error) { next(error); }
};

// ── PUT /api/requests/:id/concern-final — Clinical Director final review ──
// action: 'release' (spec §7) | 'request_revision' (spec §8). ──
const finalReviewConcern = async (req, res, next) => {
  try {
    if (!isDirector(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Only a Clinical Director can release or request revisions.' });
    }
    const { action, note } = req.body || {};
    if (!['release', 'request_revision'].includes(action)) {
      return res.status(400).json({ success: false, message: "Action must be 'release' or 'request_revision'." });
    }
    const cur = await db.query(`SELECT * FROM client_requests WHERE id = $1`, [req.params.id]);
    if (!cur.rowCount) return res.status(404).json({ success: false, message: 'Ticket not found.' });
    const ticket = cur.rows[0];
    if (ticket.nature !== 'report_concern') {
      return res.status(400).json({ success: false, message: 'This ticket is not a report concern.' });
    }
    if (concernStatus(ticket) !== 'Modified Report Submitted') {
      return res.status(409).json({ success: false, message: 'There is no submitted modified report to act on.' });
    }

    // ── Request Revision (spec §8 → Revision Required) ──
    if (action === 'request_revision') {
      if (!note || !String(note).trim()) {
        return res.status(400).json({ success: false, message: 'A revision note is required.' });
      }
      const noteTxt = String(note).trim();
      const r = await db.query(
        `UPDATE client_requests SET concern_status = 'Revision Required', concern_revision_note = $1, updated_at = NOW()
         WHERE id = $2 RETURNING *`, [noteTxt, req.params.id]);
      // Send the report back to "Modification Required" for the psychologist.
      if (ticket.report_id) {
        await db.query(
          `UPDATE psychological_reports SET modification_status = 'Modification Required', updated_at = NOW() WHERE id = $1`,
          [ticket.report_id]).catch(() => {});
      }
      await audit(req.user.id, 'CONCERN_REVISION_REQUESTED', req.params.id, req, { ticket: ticket.ticket_number });
      await reqAudit(req.params.id, req.user.id, 'REVISION_REQUESTED', `Revision requested. Note: ${noteTxt}`);
      const psyId = await resolveConcernPsychologistId(ticket);
      if (psyId) {
        try {
          await notificationService.notifyUser(psyId, 'ticket', 'Revision Required',
            `The Clinical Director requested a revision on concern ${ticket.ticket_number}. Note: ${noteTxt}`,
            `psych-reports.html?concern=${ticket.id}`);
        } catch (_) {}
      }
      return res.json({ success: true, message: 'Revision requested from the psychologist.', data: publicRow(r.rows[0]) });
    }

    // ── Release Report (spec §7 → Request Concern Completed) ──
    const latest = await db.query(
      `SELECT * FROM client_request_report_versions WHERE request_id = $1 ORDER BY version_number DESC LIMIT 1`, [req.params.id]);
    if (!latest.rowCount) {
      return res.status(409).json({ success: false, message: 'No modified report is available to release.' });
    }
    const v = latest.rows[0];
    const r = await db.query(
      `UPDATE client_requests
       SET concern_status = 'Resolved', status = 'resolved',
           report_filename = $1, report_mime = $2, report_version = $3,
           report_released_at = NOW(), sent_at = NOW(), sent_by = $4, updated_at = NOW()
       WHERE id = $5 RETURNING *`,
      [v.filename, v.mime, v.version_number, req.user.id, req.params.id]);
    // Clear the report's modification flag — it is released again, no longer
    // needing changes.
    if (ticket.report_id) {
      await db.query(
        `UPDATE psychological_reports SET modification_status = NULL, active_concern_id = NULL, updated_at = NOW() WHERE id = $1`,
        [ticket.report_id]).catch(() => {});
    }
    await audit(req.user.id, 'CONCERN_RELEASED', req.params.id, req, { ticket: ticket.ticket_number, version: v.version_number });
    await reqAudit(req.params.id, req.user.id, 'CONCERN_RELEASED', `Modified report released to the client (version ${v.version_number}).`);
    try {
      await notificationService.notifyUser(ticket.client_id, 'ticket', 'Request Concern Finished',
        `Your report concern (${ticket.ticket_number}) is complete. Your updated report is now available — click View Report to open it.`,
        'profile.html?section=requests');
    } catch (_) {}
    return res.json({ success: true, message: 'Modified report released to the client.', data: publicRow(r.rows[0]) });
  } catch (error) { next(error); }
};

module.exports = {
  listReportConcerns, saveConcernVersion, getConcernVersions,
  reviewConcern, submitModifiedReport, finalReviewConcern,
};
