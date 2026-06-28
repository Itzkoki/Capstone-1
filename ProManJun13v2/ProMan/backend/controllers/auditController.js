/**
 * auditController — Clinical-Director Audit Trail & Audit Logs.
 * ─────────────────────────────────────────────────────────────────────────
 *  • Audit LOGS  → security & user activity (login, profile change, captcha,
 *                  failed logins, lockouts, restricted-access attempts …).
 *                  Sources: activity_logs + login_attempts + security_audit_log.
 *  • Audit TRAIL → business-process / record history (intake, appointment,
 *                  payment verification, report generation, privacy actions).
 *                  Sources: client_request_audit_logs + report_audit_logs +
 *                  audit_log (case state changes) + data_deletion_log.
 *
 * Each source is normalized to a common shape via UNION ALL, filtered and
 * paginated in SQL, then the visible page is enriched in JS with device
 * (User-Agent → "Chrome 124 / Windows 11") and location (GeoLite2 IP lookup).
 */
const db = require('../config/db');
const geo = require('../services/geoService');
const ua = require('../services/uaParser');

const MAX_LIMIT = 100;

// Staff live in a separate `staff` table (clients live in `users`). Resolve a
// staff member's display name / role via a correlated subquery so we never risk
// row multiplication from a second LEFT JOIN.
const STAFF_NAME_SUBQ = `(SELECT COALESCE(NULLIF(TRIM(COALESCE(st.first_name,'') || ' ' || COALESCE(st.last_name,'')),''), st.username)
                            FROM staff st WHERE st.staff_id = x.user_id)`;
const STAFF_ROLE_SUBQ = `(SELECT st.role FROM staff st WHERE st.staff_id = x.user_id)`;
const STAFF_CODE_SUBQ = `(SELECT st.staff_code FROM staff st WHERE st.staff_id = x.user_id)`;

// ── Shared SQL fragments ───────────────────────────────────────────────────

// Audit LOGS unified feed (newest first handled by caller).
const LOGS_UNION = `
  SELECT al.created_at AS ts, al.user_id, al.role, al.action AS raw_action,
         al.resource_type, COALESCE(al.status,'Success') AS status,
         al.ip_address AS ip, al.user_agent, al.fingerprint, al.details::text AS details, 'activity' AS source
    FROM activity_logs al
  UNION ALL
  SELECT la.created_at, NULL::int, NULL,
         CASE la.attempt_type
              WHEN 'failed_login' THEN 'Failed Login Attempt'
              WHEN 'lockout'      THEN 'Account Locked'
              WHEN 'unlock'       THEN 'Account Unlocked'
              ELSE la.attempt_type END,
         'auth',
         CASE la.attempt_type WHEN 'unlock' THEN 'Success' ELSE 'Failed' END,
         la.ip_address, NULL, NULL, la.email, 'login'
    FROM login_attempts la
  UNION ALL
  SELECT s.created_at, s.user_id, NULL, s.event_type,
         COALESCE(s.context,'security'),
         CASE WHEN s.event_type ILIKE '%fail%' OR s.event_type ILIKE '%denied%'
              THEN 'Failed' ELSE 'Success' END,
         s.ip_address, NULL, NULL,
         COALESCE(s.reason, s.action), 'security'
    FROM security_audit_log s
`;

// Audit TRAIL unified feed.
const TRAIL_UNION = `
  SELECT cra.created_at AS ts,
         CASE WHEN cra.action ILIKE 'PAYMENT%' THEN 'Payment Verification'
              WHEN cra.action ILIKE 'REPORT%' OR cra.action ILIKE 'CONCERN%'
                   OR cra.action ILIKE '%INFO%' OR cra.action ILIKE 'INVESTIGATION%'
                   THEN 'Report Generation'
              ELSE 'Client Intake & Appointment' END AS module,
         cra.action, 'REQ-' || cra.request_id AS record_id,
         cra.user_id, NULL::text AS old_value, NULL::text AS new_value,
         cra.remarks, 'request' AS source
    FROM client_request_audit_logs cra
  UNION ALL
  SELECT ral.created_at, 'Report Generation', ral.action,
         CASE WHEN ral.report_id IS NULL THEN NULL ELSE 'RPT-' || ral.report_id END,
         ral.user_id, NULL, NULL, ral.details, 'report'
    FROM report_audit_logs ral
  UNION ALL
  SELECT a.changed_at,
         CASE WHEN a.table_name IN ('intake_forms','appointments','cases') THEN 'Client Intake & Appointment'
              WHEN a.table_name = 'payments' THEN 'Payment Verification'
              WHEN a.table_name IN ('psychological_reports','assessments') THEN 'Report Generation'
              ELSE a.table_name END,
         a.action,
         -- For payments, show the human-readable reference number (e.g.
         -- BPS-20260628-0003) instead of the internal payment id.
         CASE WHEN a.table_name = 'payments'
              THEN COALESCE((SELECT p.reference_number FROM payments p WHERE p.id::text = a.record_id), a.record_id)
              ELSE a.record_id END,
         COALESCE(a.changed_by_user_id, a.changed_by_staff_id),
         a.old_value::text, a.new_value::text, NULL, 'case'
    FROM audit_log a
  UNION ALL
  SELECT d.created_at, 'Privacy Controls',
         CASE WHEN d.reason = 'user_request' THEN 'Account Deletion Completed'
              ELSE 'Data Deleted (Admin)' END,
         'DEL-' || d.id, COALESCE(d.user_id, d.deleted_by), NULL,
         (d.item_count || ' item(s)'), d.reason, 'privacy'
    FROM data_deletion_log d
`;

// ── Helpers ────────────────────────────────────────────────────────────────

function pageParams(q) {
  const page = Math.max(1, parseInt(q.page, 10) || 1);
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(q.limit, 10) || 10));
  return { page, limit, offset: (page - 1) * limit };
}

function dateRange(conds, params, q, col = 'ts') {
  if (q.startDate) { params.push(q.startDate); conds.push(`x.${col} >= $${params.length}`); }
  if (q.endDate)   { params.push(q.endDate + ' 23:59:59'); conds.push(`x.${col} <= $${params.length}`); }
}

function fmtUser(row) {
  // Prefer the human-readable code (USR-2026-0005 / PSY-2026-0001) over the raw DB id.
  const code = row.user_code || row.staff_code || null;
  if (row.user_name) return code ? `${row.user_name} (${code})` : `${row.user_name} (#${row.user_id})`;
  if (code) return code;
  if (row.user_id) return `User #${row.user_id}`;
  return 'Unknown';
}

// ── Readability helpers ─────────────────────────────────────────────────────
// Turn a snake_case / camelCase key into "Title Case" (e.g. content_type → Content Type).
function titleCase(key) {
  return String(key)
    .replace(/[_\-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// Map the raw action verbs stored in the log tables to business-friendly labels
// so the audit trail reads in the same language as the staff UI buttons
// (e.g. report_audit_logs stores "reviewed"/"qc_revision_requested", not "Approve").
const ACTION_LABELS = {
  // Report-generation workflow (report_audit_logs.action)
  created: 'Report Created',
  viewed: 'Viewed',
  edited: 'Edited',
  submitted: 'Submitted for Review',
  approved: 'Approved',
  rejected: 'Rejected',
  finalized: 'Finalized',
  downloaded: 'Viewed PDF',
  version_restored: 'Version Restored',
  prepared: 'Marked as Prepared',
  reviewed: 'QC Approved',
  revision_requested: 'Revision Requested (Psychologist)',
  qc_revision_requested: 'Resubmission Requested (QC)',
  resubmitted: 'Resubmitted',
  locked: 'Locked',
  unlocked: 'Unlocked',
  signed_pdf_saved: 'Signed PDF Saved',
  submitted_to_qc: 'Submitted to QC',
  submitted_to_psychologist: 'Submitted to Psychologist',
  submitted_to_director: 'Submitted to Director',
  released: 'Released',
  archived: 'Archived',
  unarchived: 'Unarchived',
  restored: 'Restored',
  deleted: 'Deleted',
};
// Known codes get their friendly label; anything else falls back to Title Case
// (handles already-readable strings like "Failed Login Attempt" unchanged).
function humanizeAction(action) {
  if (!action) return '—';
  const key = String(action).trim().toLowerCase();
  return ACTION_LABELS[key] || titleCase(action);
}

// Technical fields that mean nothing to clinical staff — never shown.
const NOISE_KEYS = new Set([
  'path', 'method', 'statuscode', 'status_code', 'token', 'captcha_clearance',
  'connectiontoken', 'connection_token', 'otp', 'dataurl', 'data_url',
  'content_ids', 'actionkey', 'action_key', 'id', 'ids', 'hash', 'signature',
]);

// Sensitive client PII — must NOT appear in the audit log (privacy/data-protection).
// The audit log records that an action happened, not the clinical contents.
// Matching is done on a normalized key (lowercased, separators stripped) so it
// catches snake_case AND camelCase alike (full_name / fullName → "fullname").
const SENSITIVE_EXACT = new Set([
  'name', 'fullname', 'givenname', 'middlename', 'familyname', 'firstname',
  'lastname', 'nickname', 'emername', 'contactname', 'guardianname', 'parentname',
  'dob', 'dateofbirth', 'birthdate', 'birthday', 'age', 'sex', 'gender',
  'counselorgender', 'civilstatus', 'language', 'modality', 'sincewhen', 'howlong',
  'prefschedule', 'relation', 'therapybefore', 'reasoncounseling', 'reasonforcounseling',
]);
const SENSITIVE_SUBSTR = [
  'consent', 'emer', 'medication', 'concern', 'birth',
  'address', 'phone', 'email', 'diagnosis', 'symptom', 'therapy',
];
function normKey(key) { return String(key).toLowerCase().replace(/[^a-z0-9]/g, ''); }
function isSensitive(key) {
  const k = normKey(key);
  if (SENSITIVE_EXACT.has(k)) return true;
  return SENSITIVE_SUBSTR.some((p) => k.includes(p));
}

// Final safety cap so no single Details cell becomes a wall of text.
function clip(s, max = 220) {
  if (!s) return '';
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
}

function prettyVal(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.length ? `${v.length} item(s)` : '';
  if (typeof v === 'object') {
    const parts = flattenReadable(v);
    return parts.join('; ');
  }
  let s = String(v);
  if (/^data:/i.test(s) || /^[A-Za-z0-9+/]{120,}={0,2}$/.test(s)) return '[file]'; // data URL / base64 blob
  if (s.length > 80) s = s.slice(0, 79).trimEnd() + '…'; // keep single fields short
  return s;
}

// Flatten an object into ["Label: value", …], skipping technical noise.
function flattenReadable(obj) {
  const out = [];
  for (const [k, v] of Object.entries(obj || {})) {
    const key = String(k).toLowerCase();
    if (NOISE_KEYS.has(key)) continue;
    if (k === 'body' && v && typeof v === 'object') { out.push(...flattenReadable(v)); continue; }
    if (isSensitive(key)) continue; // never expose client PII in the audit log
    const val = prettyVal(v);
    if (val === '' || val == null) continue;
    out.push(`${titleCase(k)}: ${val}`);
  }
  return out;
}

/**
 * Turn raw stored details/JSON into a clean sentence for non-technical staff.
 * Plain strings pass through; JSON objects are flattened with noise removed.
 */
function humanizeDetails(text) {
  if (!text) return '';
  let parsed;
  try { parsed = JSON.parse(text); } catch (_) { return clip(String(text)); }
  if (parsed == null) return '';
  if (typeof parsed !== 'object') return clip(String(parsed));
  const parts = flattenReadable(parsed);
  if (!parts.length) return '';
  // Show a few safe fields; collapse the rest into a "(+N more)" count so big
  // forms (e.g. intake) don't dump dozens of fields into one cell.
  const MAX = 4;
  let shown = parts.slice(0, MAX).join('; ');
  if (parts.length > MAX) shown += ` (+${parts.length - MAX} more)`;
  return clip(shown);
}

/**
 * Turn a stored Previous/New value (e.g. {"status":"Scheduled"}) into readable
 * "Status: Scheduled" text, free of braces/quotes.
 */
function humanizeValue(text) {
  if (text == null || text === '') return '—';
  let parsed;
  try { parsed = JSON.parse(text); } catch (_) { return String(text); }
  if (parsed == null) return '—';
  if (typeof parsed !== 'object') return String(parsed);
  const parts = flattenReadable(parsed);
  return parts.length ? parts.join('; ') : '—';
}

function csvCell(v) {
  if (v == null) return '';
  const s = String(v).replace(/"/g, '""');
  return /[",\n]/.test(s) ? `"${s}"` : s;
}

// ── GET /api/audit/logs ─────────────────────────────────────────────────────
async function getAuditLogs(req, res, next) {
  try {
    const q = req.query;
    const { page, limit, offset } = pageParams(q);
    const params = [];
    const conds = ['1=1'];

    if (q.status && q.status !== 'all') { params.push(q.status); conds.push(`x.status = $${params.length}`); }
    if (q.role && q.role !== 'all')     { params.push(q.role);   conds.push(`COALESCE(x.role, u.role) = $${params.length}`); }
    if (q.action && q.action !== 'all') { params.push(`%${q.action}%`); conds.push(`x.raw_action ILIKE $${params.length}`); }
    if (q.q) {
      params.push(`%${q.q}%`);
      const i = params.length;
      conds.push(`(x.raw_action ILIKE $${i} OR x.ip ILIKE $${i} OR x.details ILIKE $${i}
                   OR COALESCE(u.full_name, u.email, '') ILIKE $${i})`);
    }
    dateRange(conds, params, q);

    const base = `
      FROM ( ${LOGS_UNION} ) x
      LEFT JOIN users u ON u.id = x.user_id
      WHERE ${conds.join(' AND ')}`;

    const countRes = await db.query(`SELECT COUNT(*)::int AS total ${base}`, params);
    const total = countRes.rows[0].total;

    const dataParams = params.slice();
    dataParams.push(limit, offset);
    const rows = (await db.query(
      `SELECT x.*, COALESCE(u.full_name, u.email, ${STAFF_NAME_SUBQ}) AS user_name,
              COALESCE(u.role, ${STAFF_ROLE_SUBQ}) AS user_role,
              u.user_code AS user_code, ${STAFF_CODE_SUBQ} AS staff_code ${base}
       ORDER BY x.ts DESC LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
      dataParams
    )).rows;

    const locs = await geo.locateMany(rows.map(r => r.ip));
    const data = rows.map(r => {
      let device = r.user_agent ? ua.describe(r.user_agent) : '—';
      // Append a short FingerprintJS device ID when present (stable per device).
      if (r.fingerprint) device = `${device === '—' ? 'Unknown device' : device} · ID ${String(r.fingerprint).slice(0, 8)}`;
      const geoInfo = locs.get(r.ip) || { ip: r.ip, location: '' };
      return {
        timestamp: r.ts,
        user: fmtUser(r),
        role: r.role || r.user_role || '—',
        action: humanizeAction(r.raw_action),
        status: r.status,
        ip_address: geoInfo.ip || r.ip || '—',
        location: geoInfo.location || '',
        device,
        fingerprint: r.fingerprint || null,
        details: humanizeDetails(r.details),
        source: r.source,
      };
    });

    res.json({ success: true, data, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) { next(err); }
}

// ── GET /api/audit/trail ────────────────────────────────────────────────────
async function getAuditTrail(req, res, next) {
  try {
    const q = req.query;
    const { page, limit, offset } = pageParams(q);
    const params = [];
    const conds = ['1=1'];

    if (q.module && q.module !== 'all') { params.push(q.module); conds.push(`x.module = $${params.length}`); }
    if (q.action && q.action !== 'all') { params.push(`%${q.action}%`); conds.push(`x.action ILIKE $${params.length}`); }
    if (q.q) {
      params.push(`%${q.q}%`);
      const i = params.length;
      conds.push(`(x.action ILIKE $${i} OR x.record_id ILIKE $${i} OR COALESCE(x.remarks,'') ILIKE $${i}
                   OR COALESCE(u.full_name, u.email, '') ILIKE $${i})`);
    }
    dateRange(conds, params, q);

    const base = `
      FROM ( ${TRAIL_UNION} ) x
      LEFT JOIN users u ON u.id = x.user_id
      WHERE ${conds.join(' AND ')}`;

    const countRes = await db.query(`SELECT COUNT(*)::int AS total ${base}`, params);
    const total = countRes.rows[0].total;

    const dataParams = params.slice();
    dataParams.push(limit, offset);
    const rows = (await db.query(
      `SELECT x.*, COALESCE(u.full_name, u.email, ${STAFF_NAME_SUBQ}) AS user_name,
              u.user_code AS user_code, ${STAFF_CODE_SUBQ} AS staff_code ${base}
       ORDER BY x.ts DESC LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
      dataParams
    )).rows;

    const data = rows.map(r => ({
      timestamp: r.ts,
      module: r.module,
      action: humanizeAction(r.action),
      record_id: r.record_id || '—',
      user: fmtUser(r),
      previous_value: humanizeValue(r.old_value),
      new_value: humanizeValue(r.new_value),
      remarks: r.remarks || '—',
      source: r.source,
    }));

    res.json({ success: true, data, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) { next(err); }
}

// ── GET /api/audit/logs/export & /api/audit/trail/export (CSV) ───────────────
async function exportAuditLogs(req, res, next) {
  try {
    req.query.page = 1; req.query.limit = MAX_LIMIT;
    const payload = await collect(getAuditLogs, req);
    const header = ['Timestamp', 'User', 'Role', 'Action', 'Status', 'IP Address', 'Location', 'Device', 'Details'];
    const lines = [header.join(',')];
    for (const r of payload.data) {
      lines.push([r.timestamp, r.user, r.role, r.action, r.status, r.ip_address, r.location, r.device, r.details].map(csvCell).join(','));
    }
    sendCsv(res, 'audit-logs', lines.join('\n'));
  } catch (err) { next(err); }
}

async function exportAuditTrail(req, res, next) {
  try {
    req.query.page = 1; req.query.limit = MAX_LIMIT;
    const payload = await collect(getAuditTrail, req);
    const header = ['Timestamp', 'Module', 'Action', 'Affected Record ID', 'User', 'Previous Value', 'New Value', 'Reason/Remarks'];
    const lines = [header.join(',')];
    for (const r of payload.data) {
      lines.push([r.timestamp, r.module, r.action, r.record_id, r.user, r.previous_value, r.new_value, r.remarks].map(csvCell).join(','));
    }
    sendCsv(res, 'audit-trail', lines.join('\n'));
  } catch (err) { next(err); }
}

// Run a controller fn and capture its res.json payload (for export reuse).
function collect(fn, req) {
  return new Promise((resolve, reject) => {
    const res = { json: resolve };
    fn(req, res, reject).catch(reject);
  });
}

function sendCsv(res, name, body) {
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}-${stamp}.csv"`);
  res.send(body);
}

// ── POST /api/audit/event ───────────────────────────────────────────────────
// Lets the front-end record a client-side security event (Logout / Session
// Terminated) that has no dedicated server endpoint. Any authenticated user.
const ALLOWED_EVENTS = new Set(['Logout', 'Session Terminated']);
async function recordEvent(req, res, next) {
  try {
    const action = String(req.body.action || '').trim();
    if (!ALLOWED_EVENTS.has(action)) {
      return res.status(400).json({ success: false, message: 'Unsupported event.' });
    }
    const ip = (req.headers['x-forwarded-for']?.split(',')[0]?.trim()) || req.ip || null;
    const ActivityLog = require('../models/ActivityLog');
    await ActivityLog.log(req.user.id, action, 'auth', null, ip,
      { path: req.originalUrl },
      { role: req.user.role, status: 'Success', userAgent: req.headers['user-agent'], fingerprint: req.headers['x-device-fp'] || null });
    res.json({ success: true });
  } catch (err) { next(err); }
}

module.exports = {
  getAuditLogs, getAuditTrail, exportAuditLogs, exportAuditTrail, recordEvent,
};
