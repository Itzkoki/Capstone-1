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

// LEFT JOIN LATERAL exposing the latest report-request payment for a
// client_requests row aliased `cr`. Payment state now lives in the centralized
// `payments` table (the inline client_requests.payment_*/receipt_* columns were
// dropped); these pay_* aliases are what publicRow / reportRequestStatus read.
// Lightweight fields only — never the proof blob — so it's safe in list queries.
const PAYMENT_JOIN = `
  LEFT JOIN LATERAL (
    SELECT p.status           AS pay_status,
           p.total_fee        AS pay_amount,
           p.reference_number AS pay_reference,
           p.rejection_reason AS pay_rejection,
           p.proof_filename   AS pay_proof_name,
           p.verified_at      AS pay_verified_at
    FROM payments p
    WHERE p.client_request_id = cr.id
    ORDER BY p.created_at DESC
    LIMIT 1
  ) pay ON TRUE`;

// Map the linked payment's status onto the Report-Requests display status:
//   Under Review → Awaiting Payment → Payment Submitted → Payment Verified
//   → Resolved → Sent  (plus Rejected). A payment row existing ⇒ payment required.
function reportRequestStatus(row) {
  if (row.status === 'rejected') return 'Rejected';
  if (row.sent_at) return 'Sent';
  const payStatus = row.pay_status || null;
  const paymentRequired = !!payStatus;
  if (row.report_released_at && (payStatus === 'verified' || !paymentRequired)) return 'Resolved';
  if (paymentRequired) {
    if (payStatus === 'verified') return 'Payment Verified';
    if (payStatus === 'under_review') return 'Payment Submitted';
    if (payStatus === 'pending' || payStatus === 'rejected' || payStatus === 'expired') return 'Awaiting Payment';
  }
  return 'Under Review';
}

const REQUEST_TYPE_LABELS = {
  additional_copies: 'Additional Copies of Report',
  report_concern: 'Concern About Report',
};

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

// Generate the report-request reference number, e.g. REQ-20260624-0001 (daily
// sequence). NOTE: existing tickets keep their legacy BPS-REQ-… numbers — those
// are already issued to clients and must not change retroactively; only NEW
// requests use the REQ- format. The daily-sequence lookup is prefix-scoped so a
// fresh prefix simply starts its own sequence at 0001.
async function generateTicketNumber() {
  const today = new Date();
  const y = today.getFullYear(), mo = String(today.getMonth() + 1).padStart(2, '0'), d = String(today.getDate()).padStart(2, '0');
  const prefix = `REQ-${y}${mo}${d}-`;
  const r = await db.query(
    `SELECT ticket_number FROM client_requests WHERE ticket_number LIKE $1 ORDER BY ticket_number DESC LIMIT 1`,
    [prefix + '%']
  );
  let seq = 1;
  if (r.rowCount) {
    const last = parseInt(r.rows[0].ticket_number.slice(prefix.length), 10);
    if (!Number.isNaN(last)) seq = last + 1;
  }
  return prefix + String(seq).padStart(4, '0');
}

// Strip large blobs from list payloads and derive the payment fields from the
// linked payments row (the inline payment_*/receipt_* columns were dropped). The
// OUTPUT shape is kept identical to before so the client/staff frontends that
// read payment_status / payment_amount / payment_reference / receipt_number /
// has_payment_proof / has_receipt need no changes.
function publicRow(row, role) {
  const out = { ...row };
  delete out.attachment;
  delete out.report_file;       // column dropped; defensive
  delete out.payment_proof;     // column dropped; defensive
  delete out.id_document;       // heavy base64 ID upload — fetched via /file?type=id_document

  // Compute the display status BEFORE we strip the pay_* internals.
  out.report_request_status = reportRequestStatus(row);

  const payStatus = row.pay_status || null;
  // Map the payments-table vocabulary back onto the legacy inline vocabulary the
  // frontend already understands.
  const STATUS_MAP = {
    pending: 'awaiting_payment', under_review: 'under_review',
    verified: 'verified', rejected: 'rejected', expired: 'awaiting_payment',
  };
  out.payment_required = !!payStatus;
  out.payment_status = payStatus ? (STATUS_MAP[payStatus] || payStatus) : 'none';
  out.payment_amount = (row.pay_amount != null) ? Number(row.pay_amount) : null;
  out.payment_reference = row.pay_reference || null;
  out.payment_rejection_reason = row.pay_rejection || null;
  out.receipt_number = (payStatus === 'verified' && row.pay_reference) ? `${row.pay_reference}-RCPT` : null;
  out.receipt_issued_at = row.pay_verified_at || null;
  out.has_payment_proof = !!row.pay_proof_name;
  out.has_receipt = payStatus === 'verified';

  // Drop the raw join internals from the payload.
  delete out.pay_status; delete out.pay_amount; delete out.pay_reference;
  delete out.pay_rejection; delete out.pay_proof_name; delete out.pay_verified_at;

  out.has_attachment = !!row.attachment_name;
  out.has_id_document = !!row.id_document_name;
  out.has_report = !!row.report_filename;
  out.status_label = STATUS_LABELS[row.status] || row.status;
  out.request_type_label = REQUEST_TYPE_LABELS[row.nature] || row.nature;
  out.concern_status = concernStatus(row);
  out.is_concern = row.nature === 'report_concern';
  return out;
}

module.exports = {
  db, User, RequestAuditLog, notificationService,
  getClientIP, isStaff, isDirector,
  audit, reqAudit,
  reportRequestStatus, PAYMENT_JOIN, REQUEST_TYPE_LABELS,
  CONCERN_STATUSES, CONCERN_KIND,
  ADDITIONAL_COPY_FEE, MAX_FILE_LEN, MAX_REPORT_LEN, ACCEPTED_MIMES,
  concernStatus, STATUS_LABELS,
  validateDataUrl, generateTicketNumber, publicRow,
};
