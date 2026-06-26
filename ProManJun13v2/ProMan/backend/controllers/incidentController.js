/**
 * incidentController — Audit Action Management (Clinical-Director only).
 * ─────────────────────────────────────────────────────────────────────────
 * Backs the "Action Center" page. The Clinical Director is the SOLE handler:
 * there is no assignment to staff — the CD acknowledges, investigates, records
 * module-specific response actions, escalates, and closes each incident.
 *
 * Workflow status:  open → acknowledged → investigating → resolved → closed
 *                   (+ escalated, reopened)
 *
 * Closing a CRITICAL incident requires documented resolution notes (CD sign-off
 * is recorded in `closure_approved_by`).
 */
const db = require('../config/db');
const sec = require('../services/securityEvents');
const incidentActions = require('../services/incidentActions');

const MAX_LIMIT = 100;
const STATUSES = ['open', 'acknowledged', 'investigating', 'resolved', 'closed', 'escalated', 'reopened'];

// Resolve a subject's display name from whichever table the id lives in.
const SUBJECT_NAME = `
  COALESCE(
    (SELECT COALESCE(u.full_name, u.email) FROM users u WHERE u.id = i.subject_user_id),
    (SELECT COALESCE(NULLIF(TRIM(COALESCE(st.first_name,'') || ' ' || COALESCE(st.last_name,'')),''), st.username)
       FROM staff st WHERE st.staff_id = i.subject_user_id)
  )`;

const INCIDENT_CODE = `('INC-' || (1000 + i.id))`;

function pageParams(q) {
  const page = Math.max(1, parseInt(q.page, 10) || 1);
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(q.limit, 10) || 10));
  return { page, limit, offset: (page - 1) * limit };
}

function csvCell(v) {
  if (v == null) return '';
  const s = String(v).replace(/"/g, '""');
  return /[",\n]/.test(s) ? `"${s}"` : s;
}

function moduleLabel(key) {
  return sec.moduleDef(key).label || key;
}

function shapeRow(r) {
  return {
    id: r.id,
    incident_code: r.incident_code,
    timestamp: r.created_at,
    updated_at: r.updated_at,
    module: r.module,
    module_label: moduleLabel(r.module),
    event_type: r.event_type,
    title: r.title,
    severity: r.severity,
    status: r.status,
    subject: r.subject_name ? `${r.subject_name}${r.subject_user_id ? ` (#${r.subject_user_id})` : ''}` : (r.subject_user_id ? `User #${r.subject_user_id}` : '—'),
    ip_address: sec.normalizeIp(r.ip_address) || '—',
  };
}

// ── GET /api/audit/incidents ─────────────────────────────────────────────────
async function listIncidents(req, res, next) {
  try {
    const q = req.query;
    const { page, limit, offset } = pageParams(q);
    const params = [];
    const conds = ['1=1'];

    if (q.severity && q.severity !== 'all') { params.push(q.severity); conds.push(`i.severity = $${params.length}`); }
    if (q.status && q.status !== 'all')     { params.push(q.status);   conds.push(`i.status = $${params.length}`); }
    if (q.module && q.module !== 'all')     { params.push(q.module);   conds.push(`i.module = $${params.length}`); }
    if (q.startDate) { params.push(q.startDate);              conds.push(`i.created_at >= $${params.length}`); }
    if (q.endDate)   { params.push(q.endDate + ' 23:59:59');  conds.push(`i.created_at <= $${params.length}`); }
    if (q.q) {
      params.push(`%${q.q}%`);
      const k = params.length;
      conds.push(`(i.title ILIKE $${k} OR i.event_type ILIKE $${k} OR i.ip_address ILIKE $${k}
                   OR ${INCIDENT_CODE} ILIKE $${k} OR COALESCE(${SUBJECT_NAME},'') ILIKE $${k})`);
    }

    const where = `WHERE ${conds.join(' AND ')}`;
    const countRes = await db.query(`SELECT COUNT(*)::int AS total FROM security_incidents i ${where}`, params);
    const total = countRes.rows[0].total;

    const dataParams = params.slice();
    dataParams.push(limit, offset);
    const rows = (await db.query(
      `SELECT i.*, ${INCIDENT_CODE} AS incident_code, ${SUBJECT_NAME} AS subject_name
         FROM security_incidents i ${where}
        ORDER BY
          CASE i.severity WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC,
          i.created_at DESC
        LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
      dataParams
    )).rows;

    res.json({
      success: true,
      data: rows.map(shapeRow),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) { next(err); }
}

// ── GET /api/audit/incidents/stats ───────────────────────────────────────────
async function incidentStats(_req, res, next) {
  try {
    const r = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE status NOT IN ('resolved','closed'))::int AS open,
        COUNT(*) FILTER (WHERE severity = 'critical' AND status NOT IN ('resolved','closed'))::int AS critical,
        COUNT(*) FILTER (WHERE severity = 'high' AND status NOT IN ('resolved','closed'))::int AS high,
        COUNT(*)::int AS total
      FROM security_incidents`);
    res.json({ success: true, stats: r.rows[0] });
  } catch (err) { next(err); }
}

// ── GET /api/audit/incidents/catalog ─────────────────────────────────────────
function getCatalog(_req, res) {
  res.json({ success: true, modules: sec.catalogForClient() });
}

// ── GET /api/audit/incidents/:id ─────────────────────────────────────────────
async function getIncident(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    const r = await db.query(
      `SELECT i.*, ${INCIDENT_CODE} AS incident_code, ${SUBJECT_NAME} AS subject_name
         FROM security_incidents i WHERE i.id = $1`, [id]);
    if (!r.rows.length) return res.status(404).json({ success: false, message: 'Incident not found.' });
    const inc = r.rows[0];

    const tl = (await db.query(
      `SELECT a.*, COALESCE(
                (SELECT COALESCE(u.full_name, u.email) FROM users u WHERE u.id = a.actor_id),
                (SELECT COALESCE(NULLIF(TRIM(COALESCE(st.first_name,'') || ' ' || COALESCE(st.last_name,'')),''), st.username)
                   FROM staff st WHERE st.staff_id = a.actor_id),
                'System') AS actor_name
         FROM security_incident_actions a WHERE a.incident_id = $1 ORDER BY a.created_at ASC, a.id ASC`,
      [id]
    )).rows;

    const mod = sec.moduleDef(inc.module);
    res.json({
      success: true,
      incident: {
        ...shapeRow(inc),
        recommended_action: inc.recommended_action,
        escalation_path: inc.escalation_path,
        resolution_procedure: inc.resolution_procedure,
        resolution_notes: inc.resolution_notes,
        actions: mod.actions,                 // module-specific action buttons
        timeline: tl.map(t => ({
          actor: t.actor_name,
          action_type: t.action_type,
          label: t.label,
          from_value: t.from_value,
          to_value: t.to_value,
          note: t.note,
          timestamp: t.created_at,
        })),
      },
    });
  } catch (err) { next(err); }
}

// Shared: load an incident or 404.
async function loadOr404(id, res) {
  const r = await db.query(`SELECT * FROM security_incidents WHERE id = $1`, [parseInt(id, 10)]);
  if (!r.rows.length) { res.status(404).json({ success: false, message: 'Incident not found.' }); return null; }
  return r.rows[0];
}

async function addTimeline(incidentId, actorId, actionType, { label = null, from = null, to = null, note = null } = {}) {
  await db.query(
    `INSERT INTO security_incident_actions (incident_id, actor_id, action_type, label, from_value, to_value, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [incidentId, actorId, actionType, label, from, to, note]
  );
}

// ── PATCH /api/audit/incidents/:id/status ────────────────────────────────────
async function updateStatus(req, res, next) {
  try {
    const inc = await loadOr404(req.params.id, res);
    if (!inc) return;
    const status = String(req.body.status || '').trim();
    if (!STATUSES.includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status.' });
    }
    // Closing is handled by its own endpoint (enforces resolution notes).
    if (status === 'closed') {
      return res.status(400).json({ success: false, message: 'Use the close endpoint to close an incident.' });
    }
    await db.query(`UPDATE security_incidents SET status = $1, updated_at = NOW() WHERE id = $2`, [status, inc.id]);
    await addTimeline(inc.id, req.user.id, 'status_change', { from: inc.status, to: status, note: req.body.note || null });
    res.json({ success: true });
  } catch (err) { next(err); }
}

// ── POST /api/audit/incidents/:id/action ─────────────────────────────────────
// Executes (or documents) a module-specific response action and records it to
// the incident timeline. Executable actions (lock/suspend/force reset) perform
// the real operation against the subject account; documented actions are logged.
async function recordAction(req, res, next) {
  try {
    const inc = await loadOr404(req.params.id, res);
    if (!inc) return;
    const actionKey = String(req.body.actionKey || '').trim();
    const def = sec.resolveAction(inc.module, actionKey);
    if (!def) return res.status(400).json({ success: false, message: 'Action not available for this module.' });

    let outcome = { executed: false, message: '' };
    if (def.tier === 'executable') {
      outcome = await incidentActions.execute({ actionKey, incident: inc });
    }

    const userNote = (req.body.note || '').trim();
    const note = [userNote, outcome.message].filter(Boolean).join(' — ') || null;
    await addTimeline(inc.id, req.user.id, 'action', {
      label: outcome.executed ? `${def.label} ✓ executed` : def.label,
      note,
    });

    // Taking a response action moves an untouched incident into "investigating".
    if (inc.status === 'open' || inc.status === 'acknowledged') {
      await db.query(`UPDATE security_incidents SET status = 'investigating', updated_at = NOW() WHERE id = $1`, [inc.id]);
    } else {
      await db.query(`UPDATE security_incidents SET updated_at = NOW() WHERE id = $1`, [inc.id]);
    }
    res.json({ success: true, executed: outcome.executed, message: outcome.message });
  } catch (err) { next(err); }
}

// ── POST /api/audit/incidents/:id/note ───────────────────────────────────────
async function addNote(req, res, next) {
  try {
    const inc = await loadOr404(req.params.id, res);
    if (!inc) return;
    const note = String(req.body.note || '').trim();
    if (!note) return res.status(400).json({ success: false, message: 'Note is required.' });
    await addTimeline(inc.id, req.user.id, 'note', { note });
    await db.query(`UPDATE security_incidents SET updated_at = NOW() WHERE id = $1`, [inc.id]);
    res.json({ success: true });
  } catch (err) { next(err); }
}

// ── POST /api/audit/incidents/:id/escalate ───────────────────────────────────
async function escalate(req, res, next) {
  try {
    const inc = await loadOr404(req.params.id, res);
    if (!inc) return;
    const next_ = sec.bumpSeverity(inc.severity);
    await db.query(
      `UPDATE security_incidents SET severity = $1, status = 'escalated', updated_at = NOW() WHERE id = $2`,
      [next_, inc.id]
    );
    await addTimeline(inc.id, req.user.id, 'escalate', { from: inc.severity, to: next_, note: req.body.note || null });
    res.json({ success: true, severity: next_ });
  } catch (err) { next(err); }
}

// ── POST /api/audit/incidents/:id/close ──────────────────────────────────────
async function closeIncident(req, res, next) {
  try {
    const inc = await loadOr404(req.params.id, res);
    if (!inc) return;
    const notes = String(req.body.resolution_notes || '').trim();
    if (inc.severity === 'critical' && !notes) {
      return res.status(400).json({ success: false, message: 'Critical incidents require documented resolution notes before closure.' });
    }
    await db.query(
      `UPDATE security_incidents
          SET status = 'closed', resolution_notes = COALESCE(NULLIF($1,''), resolution_notes),
              closure_approved_by = $2, updated_at = NOW()
        WHERE id = $3`,
      [notes, req.user.id, inc.id]
    );
    await addTimeline(inc.id, req.user.id, 'close', { from: inc.status, to: 'closed', note: notes || 'Closed.' });
    res.json({ success: true });
  } catch (err) { next(err); }
}

// ── POST /api/audit/incidents/:id/reopen ─────────────────────────────────────
async function reopen(req, res, next) {
  try {
    const inc = await loadOr404(req.params.id, res);
    if (!inc) return;
    await db.query(`UPDATE security_incidents SET status = 'reopened', updated_at = NOW() WHERE id = $1`, [inc.id]);
    await addTimeline(inc.id, req.user.id, 'status_change', { from: inc.status, to: 'reopened', note: req.body.note || null });
    res.json({ success: true });
  } catch (err) { next(err); }
}

// ── GET /api/audit/incidents/export (CSV) ────────────────────────────────────
async function exportIncidents(req, res, next) {
  try {
    req.query.page = 1; req.query.limit = MAX_LIMIT;
    const payload = await new Promise((resolve, reject) => {
      listIncidents(req, { json: resolve }, reject).catch(reject);
    });
    const header = ['Incident', 'Timestamp', 'Module', 'Event Type', 'Title', 'Severity', 'Status', 'Subject', 'Source IP'];
    const lines = [header.join(',')];
    for (const r of payload.data) {
      lines.push([r.incident_code, r.timestamp, r.module_label, r.event_type, r.title, r.severity, r.status, r.subject, r.ip_address].map(csvCell).join(','));
    }
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="action-center-${stamp}.csv"`);
    res.send(lines.join('\n'));
  } catch (err) { next(err); }
}

module.exports = {
  listIncidents, incidentStats, getCatalog, getIncident,
  updateStatus, recordAction, addNote, escalate, closeIncident, reopen, exportIncidents,
};
