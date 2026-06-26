/* ══════════════════════════════════════════════════════════
   PSYGEN — Report Concerns
   New pipeline: client submits a concern about a released report →
   Clinical Director Approve/Reject → client payment → Supervising
   Psychometrician verifies → assigned Psychologist modifies the
   report + uploads a modified PDF → Clinical Director Release /
   Request Revision (looping). This console serves BOTH the CD
   (review/release) and the assigned Psychologist (modify/submit),
   keyed on USER.role + concern status.
   ══════════════════════════════════════════════════════════ */

let RC_DATA = [];
let rcCurrentId = null;
let rcCurrentRow = null;
let rcCurrentVersions = [];
// Where the concern actions are currently being driven from: 'modal' (the CD
// console) or 'report' (the psychologist working ON the original report page).
let rcContext = null;

const RC_STATUS_COLORS = {
  'Pending Review':                { bg:'#FEF3C7', fg:'#854D0E' },
  'Awaiting Payment':              { bg:'#FFEDD5', fg:'#9A3412' },
  'Payment Verification Pending':  { bg:'#DBEAFE', fg:'#1E40AF' },
  'Payment Verification Failed':   { bg:'#FEE2E2', fg:'#991B1B' },
  'Payment Verified':              { bg:'#E0E7FF', fg:'#3730A3' },
  'Modified Report Submitted':     { bg:'#CCFBF1', fg:'#115E59' },
  'Revision Required':             { bg:'#FFE4E6', fg:'#9F1239' },
  'Resolved':                      { bg:'#DCFCE7', fg:'#166534' },
  'Rejected':                      { bg:'#FEE2E2', fg:'#991B1B' },
};

function rcBadge(status) {
  const c = RC_STATUS_COLORS[status] || { bg:'#E5E7EB', fg:'#374151' };
  return `<span style="display:inline-block;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:600;background:${c.bg};color:${c.fg}">${esc(status)}</span>`;
}

// NOTE: USER is a top-level `let` in psych-reports-core.js — a global lexical
// binding, NOT a window property, so reference it directly (guarded), never
// window.USER (which is always undefined here).
function rcUser()  { return (typeof USER !== 'undefined') ? USER : null; }
function rcIsCD()  { const u = rcUser(); return !!u && u.role === 'clinical_director'; }
function rcIsPsy() { const u = rcUser(); return !!u && u.role === 'psychologist'; }

async function refreshReportConcernBadge() {
  try {
    const d = await api('/requests/report-concerns');
    const open = (d.data||[]).filter(r => !['Resolved','Rejected'].includes(r.status)).length;
    const b = document.getElementById('reportConcernBadge');
    if (b) b.textContent = open;
  } catch(e) { /* non-director or unavailable */ }
}

async function loadReportConcerns() {
  try {
    const d = await api('/requests/report-concerns');
    RC_DATA = d.data || [];
    renderReportConcerns();
    refreshReportConcernBadge();
  } catch(e) { toast(e.message||'Failed to load report concerns','error'); }
}

function renderReportConcerns() {
  const body = document.getElementById('reportConcernBody');
  const empty = document.getElementById('emptyReportConcerns');
  if (!body) return;
  const q = (document.getElementById('rcSearch')?.value||'').toLowerCase().trim();
  const sf = document.getElementById('rcStatusFilter')?.value||'';
  let rows = RC_DATA.slice();
  if (sf) rows = rows.filter(r => r.status === sf);
  if (q) rows = rows.filter(r =>
    (r.client_name||'').toLowerCase().includes(q) ||
    (r.ticket_number||'').toLowerCase().includes(q) ||
    (r.concern_type||'').toLowerCase().includes(q));

  if (!rows.length) { body.innerHTML=''; if(empty) empty.classList.remove('hidden'); return; }
  if (empty) empty.classList.add('hidden');

  body.innerHTML = rows.map(r => {
    const closed = ['Resolved','Rejected'].includes(r.status);
    const actionable = r.status === 'Pending Review' || r.status === 'Modified Report Submitted';
    let actions = (!closed && actionable)
      ? `<button class="btn btn-primary btn-sm" onclick="openRcReview(${r.id})">Review</button> `
      : `<button class="btn btn-outline btn-sm" onclick="openRcReview(${r.id})">View</button> `;
    actions += `<button class="btn btn-outline btn-sm" onclick="openRcVersions(${r.id})">View History</button>`;
    return `<tr>
      <td>${esc(r.client_name||'—')}</td>
      <td>${esc(r.ticket_number||'—')}</td>
      <td>${esc(r.concern_type||'Report Concern')}</td>
      <td>${rrFmtDate(r.date_submitted)}</td>
      <td>${rcBadge(r.status)}</td>
      <td class="col-actions">${actions}</td>
    </tr>`;
  }).join('');
}

// ── Review / detail modal (role + status aware) ─────────────
async function openRcReview(id) {
  showLoading();
  try {
    const d = await api('/requests/'+id);
    const r = d.data; rcCurrentId = id; rcCurrentRow = r; rcContext = 'modal';
    // Load any uploaded modified-report versions (used to gate Submit-to-CD).
    try { const v = await api('/requests/'+id+'/concern-versions'); rcCurrentVersions = v.data || []; }
    catch(_) { rcCurrentVersions = []; }
    const hasModified = rcCurrentVersions.length > 0;
    const status = r.concern_status || 'Pending Review';
    const fullName = [r.client_given_name, r.client_mi, r.client_family_name].filter(Boolean).join(' ');
    let concerns = '';
    try { const c = Array.isArray(r.concerns)?r.concerns:JSON.parse(r.concerns||'[]'); concerns = c.map(esc).join(', '); } catch(e){}

    document.getElementById('rcReviewTitle').textContent =
      (rcIsPsy() ? 'Report Concern — Modify Report' : 'Review Report Concern');

    let html = '';
    html += `<div style="font-weight:600;margin:2px 0 6px;color:#15306E">Client Information</div>`;
    html += rrField('Client Name', esc(fullName || r.client_account_name || ''));
    html += rrField('Reference Number', `<b>${esc(r.ticket_number)}</b>`);
    if (r.case_id)   html += rrField('Case ID', esc(r.case_id));
    if (r.report_id) html += rrField('Report', `${esc(r.report_code || ('#'+r.report_id))} (v${esc(String(r.report_version||1))})`);

    // ── Highlighted selected concern (spec: highlight in Overview) ──
    html += `<div style="margin:14px 0 6px;padding:12px 14px;border-radius:10px;border:1.5px solid #F59E0B;background:#FFFBEB">
      <div style="font-weight:700;color:#92400E;font-size:12px;text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px">Selected Concern</div>
      <div style="font-size:13px;color:#1f2937"><b>${esc(concerns || 'Report Concern')}</b>${r.concern_other?` · ${esc(r.concern_other)}`:''}</div>
      <div style="font-size:13px;color:#374151;margin-top:6px;white-space:pre-wrap">${esc(r.description||'')}</div>
    </div>`;

    html += rrField('Status', rcBadge(status));
    if (r.assigned_staff_name) html += rrField('Assigned Psychologist', esc(r.assigned_staff_name));
    html += rrField('Payment', esc((r.payment_status||'none').replace(/_/g,' ')));
    html += rrField('Attached File', r.has_attachment
      ? `<a href="#" onclick="rrOpenFile(${id},'attachment');return false">${esc(r.attachment_name||'View attachment')}</a>` : 'None');
    if (hasModified) {
      const latest = rcCurrentVersions[rcCurrentVersions.length-1];
      html += rrField('Modified PDF', `<a href="#" onclick="rcOpenVersion(${id},${latest.id});return false">${esc(latest.filename||('Version '+latest.version_number))}</a>`);
    }
    if (status === 'Revision Required' && r.concern_revision_note)
      html += rrField('Revision Note', `<span style="color:#9F1239">${esc(r.concern_revision_note)}</span>`);
    if (status === 'Rejected' && r.concern_rejection_reason)
      html += rrField('Rejection Reason', esc(r.concern_rejection_reason));
    document.getElementById('rcReviewBody').innerHTML = html;

    // Reset action panels.
    ['rcInfoWrap','rcResolveWrap','rcRejectWrap'].forEach(idp => { const el=document.getElementById(idp); if(el) el.style.display='none'; });
    if (document.getElementById('rcRejectReason')) document.getElementById('rcRejectReason').value='';
    if (document.getElementById('rcResolveNote'))  document.getElementById('rcResolveNote').value='';

    const act = document.getElementById('rcReviewActions');
    let btns = '';
    // The original released report (the usual report layout, opened read-only).
    // Only surfaced AFTER the Pending-Review decision — at Pending Review the CD
    // makes a clean Approve / Reject call and nothing else.
    const viewOriginalBtn = (r.report_id && typeof openReport === 'function')
      ? `<button class="btn btn-outline" onclick="closeModal('rcReviewModal');openReport(${r.report_id})">View Original Report</button>`
      : '';

    // ── Clinical Director actions ──
    if (rcIsCD()) {
      if (status === 'Pending Review') {
        // Pending Review → Approve or Reject only.
        btns += `<button class="btn btn-success" onclick="rcApprove(${id})">Approve Concern</button>`;
        btns += `<button class="btn btn-danger" onclick="rcToggle('rcRejectWrap')">Reject Concern</button>`;
      } else if (status === 'Modified Report Submitted') {
        btns += viewOriginalBtn;
        if (hasModified) btns += `<button class="btn btn-outline" onclick="rcOpenVersion(${id},${rcCurrentVersions[rcCurrentVersions.length-1].id})">View Modified PDF</button>`;
        btns += `<button class="btn btn-success" onclick="rcRelease(${id})">Release Report</button>`;
        btns += `<button class="btn btn-warning" onclick="rcToggleRevision()">Request Revision</button>`;
      }
    }

    // ── Report-author actions (whoever is the assigned author — incl. the CD when
    // they are the author of record, e.g. a digitized legacy report) ──
    const meModal = (rcUser() || {}).id;
    const isAuthorModal = r.assigned_psychologist_id != null &&
      String(r.assigned_psychologist_id) === String(meModal);
    if (isAuthorModal && ['Payment Verified','Revision Required','Modified Report Submitted'].includes(status)) {
      btns += viewOriginalBtn;
      btns += `<button class="btn btn-primary" onclick="rcEditReport(${id})">Edit Report</button>`;
      btns += `<button class="btn btn-outline" onclick="rcUploadModified(${id})">Upload Modified PDF</button>`;
      const submitLabel = status === 'Revision Required' ? 'Resubmit to Clinical Director' : 'Submit to Clinical Director';
      btns += `<button class="btn btn-success" onclick="rcSubmitModified(${id})">${submitLabel}</button>`;
    }

    btns += `<button class="btn btn-outline" onclick="closeModal('rcReviewModal')">Close</button>`;
    act.innerHTML = btns;
    openModal('rcReviewModal');
  } catch(e) { toast(e.message,'error'); }
  hideLoading();
}

function rcToggle(wrapId) {
  ['rcInfoWrap','rcResolveWrap','rcRejectWrap'].forEach(idp => {
    const el = document.getElementById(idp); if (el) el.style.display = (idp===wrapId) ? 'block' : 'none';
  });
  const act = document.getElementById('rcReviewActions');
  if (wrapId === 'rcRejectWrap') {
    act.innerHTML = `<button class="btn btn-danger" onclick="rcReject(${rcCurrentId})">Confirm Rejection</button>
      <button class="btn btn-outline" onclick="openRcReview(${rcCurrentId})">Back</button>`;
  }
}

// CD: reveal the revision-note panel (reuses the resolution-note textarea).
function rcToggleRevision() {
  ['rcInfoWrap','rcRejectWrap'].forEach(idp => { const el=document.getElementById(idp); if(el) el.style.display='none'; });
  const wrap = document.getElementById('rcResolveWrap');
  if (wrap) wrap.style.display = 'block';
  const label = document.getElementById('rcResolveLabel');
  if (label) label.innerHTML = 'Revision note for the psychologist <span style="color:#b42318">*</span>';
  const note = document.getElementById('rcResolveNote');
  if (note) note.placeholder = 'Describe what the psychologist must revise before release...';
  const act = document.getElementById('rcReviewActions');
  act.innerHTML = `<button class="btn btn-warning" onclick="rcRequestRevision(${rcCurrentId})">Send Revision Request</button>
    <button class="btn btn-outline" onclick="openRcReview(${rcCurrentId})">Back</button>`;
}

// ── CD: approve ──
async function rcApprove(id) {
  showLoading();
  try {
    await api('/requests/'+id+'/concern-review',{method:'PUT',body:JSON.stringify({action:'approve'})});
    toast('Concern approved — client notified to pay.');
    closeModal('rcReviewModal'); loadReportConcerns();
  } catch(e){ toast(e.message,'error'); } hideLoading();
}

// ── CD: reject ──
async function rcReject(id) {
  const reason = (document.getElementById('rcRejectReason').value||'').trim();
  if (!reason) { toast('A rejection reason is mandatory.','error'); return; }
  showLoading();
  try {
    await api('/requests/'+id+'/concern-review',{method:'PUT',body:JSON.stringify({action:'reject',reason})});
    toast('Concern rejected.');
    closeModal('rcReviewModal'); loadReportConcerns();
  } catch(e){ toast(e.message,'error'); } hideLoading();
}

// ── CD: release the modified report to the client ──
async function rcRelease(id) {
  showLoading();
  try {
    await api('/requests/'+id+'/concern-final',{method:'PUT',body:JSON.stringify({action:'release'})});
    toast('Modified report released to the client.');
    closeModal('rcReviewModal'); loadReportConcerns();
  } catch(e){ toast(e.message,'error'); } hideLoading();
}

// ── CD: request a revision (note required) ──
async function rcRequestRevision(id) {
  const note = (document.getElementById('rcResolveNote').value||'').trim();
  if (!note) { toast('A revision note is required.','error'); return; }
  showLoading();
  try {
    await api('/requests/'+id+'/concern-final',{method:'PUT',body:JSON.stringify({action:'request_revision',note})});
    toast('Revision requested — psychologist notified.');
    closeModal('rcReviewModal'); loadReportConcerns();
  } catch(e){ toast(e.message,'error'); } hideLoading();
}

// ── Psychologist: upload a modified PDF directly (file picker) ──
function rcUploadModified(id) {
  let input = document.getElementById('rcModifiedPdfInput');
  if (!input) {
    input = document.createElement('input');
    input.type = 'file'; input.accept = 'application/pdf'; input.id = 'rcModifiedPdfInput'; input.style.display='none';
    document.body.appendChild(input);
  }
  input.onchange = async () => {
    const file = input.files && input.files[0]; input.value='';
    if (!file) return;
    if (file.type && file.type !== 'application/pdf') { toast('Please select a PDF file.','error'); return; }
    showLoading();
    try {
      const dataUrl = await new Promise((resolve,reject)=>{ const rd=new FileReader(); rd.onload=()=>resolve(rd.result); rd.onerror=reject; rd.readAsDataURL(file); });
      const r = await api('/requests/'+id+'/concern-version',{method:'POST',
        body:JSON.stringify({ file:dataUrl, filename:file.name, changeNote:'Modified PDF uploaded' })});
      toast('Modified PDF saved (version '+(r.data?.version_number||'')+'). You can now submit to the Clinical Director.');
      if (rcContext === 'report') rcRefreshConcernOnReport(); else openRcReview(id);
    } catch(e){ toast(e.message,'error'); }
    hideLoading();
  };
  input.click();
}

// ── Psychologist: submit the modified report to the CD ──
async function rcSubmitModified(id) {
  showLoading();
  try {
    // If the report was corrected in the main editor (no manual PDF upload),
    // snapshot the real report PDF as the modified version so the CD reviews and
    // releases exactly the corrected report.
    if (!(rcCurrentVersions && rcCurrentVersions.length) && rcCurrentRow && rcCurrentRow.report_id) {
      await rcSnapshotReportPdf(id, rcCurrentRow.report_id);
    }
    await api('/requests/'+id+'/concern-submit',{method:'POST'});
    toast('Modified report submitted to the Clinical Director.');
    if (rcContext === 'report') {
      // Psychologist is done — refresh the on-report concern UI to the new status.
      rcRefreshConcernOnReport();
    } else {
      closeModal('rcReviewModal'); if (rcIsCD()) loadReportConcerns();
    }
  } catch(e){ toast(e.message,'error'); } hideLoading();
}

// ── Psychologist: open the concern ON the original report ───────
// Per spec, clicking the notification's View Details takes the assigned
// psychologist to the report they created for the client, with the client's
// concern highlighted in the Overview and the modify/submit actions in place.
async function rcOpenConcernOnReport(concernId) {
  showLoading();
  try {
    const d = await api('/requests/'+concernId);
    rcCurrentRow = d.data; rcCurrentId = concernId;
    try { const v = await api('/requests/'+concernId+'/concern-versions'); rcCurrentVersions = v.data || []; }
    catch(_) { rcCurrentVersions = []; }
    // Always open the EXACT report the client selected in "Which released report
    // is this concern about?" — concern.report_id is stamped from that choice.
    const reportId = rcCurrentRow.report_id;
    if (!reportId || typeof openReport !== 'function') { hideLoading(); openRcReview(concernId); return; }

    // Guard: the viewer must be the psychologist who finalized the selected report.
    // assigned_psychologist_id is stamped from the report's approved_by when the
    // concern is created, so it is the fast pre-check (the authoritative check
    // below re-verifies against the loaded report's approved_by).
    const me = (rcUser() || {}).id;
    if (!rcIsCD() && rcCurrentRow.assigned_psychologist_id != null &&
        String(rcCurrentRow.assigned_psychologist_id) !== String(me)) {
      hideLoading();
      toast('This concern is about a report finalized by another psychologist.', 'error');
      return;
    }

    await openReport(reportId);   // renders the real report detail view

    // Authoritative authorship check once the report is loaded (skip for the CD,
    // who may view any report but does not modify it here). A report's concern is
    // handled by the PSYCHOLOGIST who finalized/approved it (approved_by, the
    // author of record), not the staff member who merely prepared it
    // (psychologist_id). Falls back to psychologist_id for solo-authored reports.
    const responsiblePsyId = (typeof currentReport !== 'undefined' && currentReport)
      ? (currentReport.approved_by || currentReport.psychologist_id) : null;
    if (!rcIsCD() && responsiblePsyId != null && String(responsiblePsyId) !== String(me)) {
      toast('You can only modify a report you finalized.', 'error');
      rcInjectConcernUI();        // show the concern (read-only) but no edit actions
      return;
    }
    rcInjectConcernUI();          // overlay the concern banner + actions
  } catch(e) { toast(e.message,'error'); }
  hideLoading();
}

// Inject (or refresh) the highlighted concern banner + the psychologist action
// buttons onto the currently-open report detail view.
function rcInjectConcernUI() {
  const row = rcCurrentRow || {};
  const status = row.concern_status || '';
  const content = document.getElementById('detailContent');
  if (!content) return;
  rcContext = 'report';

  // ── Highlighted concern banner (persists across the detail tabs) ──
  let banner = document.getElementById('rcConcernBanner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'rcConcernBanner';
    content.parentNode.insertBefore(banner, content);
  }
  let concerns = '';
  try { const c = Array.isArray(row.concerns)?row.concerns:JSON.parse(row.concerns||'[]'); concerns = c.map(esc).join(', '); } catch(e){}
  const revisionHtml = (status === 'Revision Required' && row.concern_revision_note)
    ? `<div style="margin-top:8px;padding:8px 10px;border-radius:6px;background:#FFE4E6;color:#9F1239;font-size:13px"><b>Revision requested:</b> ${esc(row.concern_revision_note)}</div>` : '';
  const reportCode = (typeof currentReport !== 'undefined' && currentReport && currentReport.report_code)
    || row.report_code || '';
  banner.innerHTML = `<div style="margin:0 0 14px;padding:14px 16px;border-radius:10px;border:1.5px solid #F59E0B;background:#FFFBEB">
    <div style="font-weight:700;color:#92400E;font-size:12px;text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px">Client Concern — ${esc(row.ticket_number||'')} · ${esc(status)}</div>
    ${reportCode?`<div style="font-size:12px;color:#92400E;margin-bottom:6px">Report ${esc(reportCode)}</div>`:''}
    <div style="font-size:13.5px;color:#1f2937"><b>${esc(concerns||'Report Concern')}</b>${row.concern_other?` · ${esc(row.concern_other)}`:''}</div>
    <div style="font-size:13px;color:#374151;margin-top:6px;white-space:pre-wrap">${esc(row.description||'')}</div>
    ${revisionHtml}
  </div>`;

  // ── Concern action buttons (appended into the report's action bar) ──
  const act = document.getElementById('detailActions');
  if (act) {
    const prior = document.getElementById('rcConcernActions');
    if (prior) prior.remove();
    // Only the PSYCHOLOGIST who finalized/approved this report (approved_by, the
    // author of record) may modify/submit it — not the staff member who merely
    // prepared it (psychologist_id). Falls back to psychologist_id for
    // solo-authored reports.
    const me = (rcUser() || {}).id;
    const responsiblePsyId = (typeof currentReport !== 'undefined' && currentReport)
      ? (currentReport.approved_by || currentReport.psychologist_id) : null;
    const isAuthor = responsiblePsyId != null && String(responsiblePsyId) === String(me);
    const editable = isAuthor &&
      ['Payment Verified','Revision Required','Modified Report Submitted'].includes(status);
    if (editable) {
      const submitLabel = status === 'Revision Required' ? 'Resubmit to Clinical Director' : 'Submit to Clinical Director';
      const span = document.createElement('span');
      span.id = 'rcConcernActions';
      span.innerHTML =
        `<button class="btn btn-primary btn-sm" onclick="rcEditReport(${rcCurrentId})">Edit Report</button> ` +
        `<button class="btn btn-outline btn-sm" onclick="rcUploadModified(${rcCurrentId})">Upload Modified PDF</button> ` +
        `<button class="btn btn-success btn-sm" onclick="rcSubmitModified(${rcCurrentId})">${submitLabel}</button>`;
      act.appendChild(span);
    }
  }
}

// Called by openReport when a report carries modification_status. Loads the
// report's active concern and overlays the concern banner + modify/submit actions
// — so the authoring psychologist can act from the report module directly (no
// notification needed). CD / non-authors get the badge only (they act via the
// Report Concerns console), so we skip the injection for them.
async function rcMaybeInjectForReport(r) {
  if (!r || !r.active_concern_id) return;
  // Only concern modifications get the concern overlay; 'Legacy Report' (a paid
  // legacy copy awaiting release) is handled by the report detail's Release action.
  if (!['Modification Required', 'Modified Report Submitted'].includes(r.modification_status)) return;
  const me = (rcUser() || {}).id;
  // The author of record acts here — usually the approving psychologist, but for a
  // digitized legacy report that's the CD. Authorship is the gate (approved_by), so
  // we no longer exclude the CD.
  const responsiblePsyId = r.approved_by || r.psychologist_id;
  if (responsiblePsyId == null || String(responsiblePsyId) !== String(me)) return;
  // Reuse an already-loaded concern (e.g. the notification deep-link) for the same
  // report; otherwise fetch the active concern + its versions.
  if (!(rcCurrentRow && String(rcCurrentRow.report_id) === String(r.id))) {
    try { const d = await api('/requests/' + r.active_concern_id); rcCurrentRow = d.data; rcCurrentId = r.active_concern_id; }
    catch (_) { return; }
    try { const v = await api('/requests/' + r.active_concern_id + '/concern-versions'); rcCurrentVersions = v.data || []; }
    catch (_) { rcCurrentVersions = []; }
  }
  rcContext = 'report';
  rcInjectConcernUI();
}

// Refresh the version list + re-render the on-report concern UI (after a save).
async function rcRefreshConcernOnReport() {
  try { const v = await api('/requests/'+rcCurrentId+'/concern-versions'); rcCurrentVersions = v.data || []; } catch(_) {}
  try { const d = await api('/requests/'+rcCurrentId); rcCurrentRow = d.data; } catch(_) {}
  rcInjectConcernUI();
}

// ── Deep-link: opening psych-reports.html?concern=<id> from a notification ──
function rcInitConcernDeepLink() {
  try {
    const cid = new URLSearchParams(location.search).get('concern');
    if (!cid) return;
    const open = () => {
      if (rcIsCD()) {
        // Clinical Director → the Report Concerns console + review modal.
        if (typeof showView === 'function') showView('reportConcerns');
        if (typeof loadReportConcerns === 'function') loadReportConcerns();
        openRcReview(parseInt(cid, 10));
      } else {
        // The report's author (any clinical role) → straight to the report they
        // created for the client. rcOpenConcernOnReport enforces authorship.
        rcOpenConcernOnReport(parseInt(cid, 10));
      }
    };
    if (rcUser()) open(); else setTimeout(rcInitConcernDeepLink, 400);
  } catch(_) {}
}
window.addEventListener('load', () => setTimeout(rcInitConcernDeepLink, 600));

// ── Version history ─────────────────────────────────────────
async function openRcVersions(id) {
  rcCurrentId = id;
  document.getElementById('rcVersionBody').innerHTML = 'Loading…';
  openModal('rcVersionModal');
  try {
    const d = await api('/requests/'+id+'/concern-versions');
    const rows = d.data || [];
    if (!rows.length) {
      document.getElementById('rcVersionBody').innerHTML =
        '<div style="color:#64748b;padding:12px">No report versions yet. Use "Edit Report" in the review modal to create one.</div>';
      return;
    }
    document.getElementById('rcVersionBody').innerHTML = rows.map(v => `
      <div style="border-left:3px solid #1E3A8A;padding:8px 12px;margin-bottom:10px;background:#f8fafc;border-radius:6px">
        <div style="display:flex;justify-content:space-between;gap:8px;align-items:center">
          <b>Version ${esc(String(v.version_number))}</b>
          <a href="#" onclick="rcOpenVersion(${id},${v.id});return false">Open PDF</a>
        </div>
        <div style="font-size:12.5px;color:#475569;margin-top:3px">${esc(v.change_note||'')}</div>
        <div style="font-size:11.5px;color:#94a3b8;margin-top:3px">${esc(v.created_by_name||'—')} · ${rrFmtDate(v.created_at)}</div>
      </div>`).join('');
  } catch(e) {
    document.getElementById('rcVersionBody').innerHTML = '<div style="color:#b42318;padding:12px">'+esc(e.message)+'</div>';
  }
}

async function rcOpenVersion(id, versionId) {
  try {
    const d = await api('/requests/'+id+'/file?type=version&versionId='+versionId);
    const { name, dataUrl } = d.data || {};
    if (!dataUrl) { toast('Version not found','error'); return; }
    const w = window.open();
    if (w) w.document.write(`<title>${esc(name||'report')}</title><iframe src="${dataUrl}" style="border:0;position:fixed;inset:0;width:100%;height:100%"></iframe>`);
  } catch(e){ toast(e.message,'error'); }
}

/* ══════════════════════════════════════════════════════════
   IN-BROWSER PDF EDITOR (Clinical Director edits the report)
   ══════════════════════════════════════════════════════════ */
let pdfEd = {
  id: null, srcBytes: null, pdfDoc: null,
  tool: 'text', edits: [], scale: 1.5, pageViewports: [],
};

// ── Edit Report (concern correction) ────────────────────────────
// Opens the MAIN report editor (the report-generation wizard) on the ACTUAL
// report linked to the concern, so the psychologist corrects the real report
// sections (auto-saved) using the full editor + real-PDF preview — not a
// simplified copy. Receives the CONCERN id and resolves the report from it.
async function rcEditReport(concernId) {
  rcCurrentId = concernId;
  if (!rcCurrentRow || rcCurrentRow.id !== concernId) {
    try { const d = await api('/requests/' + concernId); rcCurrentRow = d.data; } catch (e) {}
  }
  const reportId = rcCurrentRow && rcCurrentRow.report_id;
  if (!reportId || typeof editRpt !== 'function') { toast('The linked report could not be opened.', 'error'); return; }
  // Leave the review modal (if open) and hand off to the main editor.
  if (typeof closeModal === 'function') closeModal('rcReviewModal');
  editRpt(reportId);
}

// "Check PDF" — preview the REAL report PDF (the pdfGenerator output the report
// module produces), not a simplified corrected copy.
function rcCheckReportPdf(concernId) {
  const reportId = rcCurrentRow && rcCurrentRow.report_id;
  if (!reportId) { toast('The linked report could not be found.', 'error'); return; }
  if (typeof _executePdfGenerate === 'function') _executePdfGenerate(reportId, false, {});
  else if (typeof downloadPdf === 'function') downloadPdf(reportId);
}

// Snapshot the report's REAL PDF (pdfGenerator) and store it as the concern's
// modified-report version, so the CD reviews/releases exactly the corrected
// report. Used when submitting after editing the report in place.
async function rcSnapshotReportPdf(concernId, reportId) {
  const res = await fetch(API + '/reports/' + reportId + '/pdf', { headers: { 'Authorization': 'Bearer ' + TOKEN } });
  if (!res.ok) throw new Error('Could not generate the report PDF.');
  const blob = await res.blob();
  const dataUrl = await new Promise((resolve, reject) => {
    const rd = new FileReader(); rd.onload = () => resolve(rd.result); rd.onerror = reject; rd.readAsDataURL(blob);
  });
  return api('/requests/' + concernId + '/concern-version', {
    method: 'POST',
    body: JSON.stringify({ file: dataUrl, filename: 'report_modified.pdf', changeNote: 'Modified report (edited in the report editor).' }),
  });
}

// (Legacy pdf.js annotation editor — retained but no longer used by concerns.)
async function rcEditReportPdfLegacy(id) {
  rcCurrentId = id;
  pdfEd = { id, srcBytes: null, pdfDoc: null, tool: 'text', edits: [], scale: 1.5, pageViewports: [] };
  document.getElementById('pdfEditorTitle').textContent = 'Edit Report — ' + (rcCurrentRow?.ticket_number || ('#'+id));
  document.getElementById('pdfEditorPages').innerHTML = '';
  document.getElementById('pdfEditorHint').style.display = 'block';
  pdfEditorSetTool('text');
  document.getElementById('pdfEditorModal').classList.add('active');
  try {
    const d = await api('/requests/'+id+'/file?type=version');
    if (d && d.data && d.data.dataUrl) {
      const bytes = dataUrlToBytes(d.data.dataUrl);
      await pdfEditorRender(bytes);
    }
  } catch(e) { /* no version yet */ }
}

function pdfEditorClose() {
  document.getElementById('pdfEditorModal').classList.remove('active');
  document.getElementById('pdfEditorPages').innerHTML = '';
  pdfEd.srcBytes = null; pdfEd.edits = [];
}

function pdfEditorSetTool(tool) {
  pdfEd.tool = tool;
  const t = document.getElementById('pdfToolText');
  const w = document.getElementById('pdfToolWhite');
  if (t) t.style.outline = tool==='text' ? '2px solid #fff' : 'none';
  if (w) w.style.outline = tool==='whiteout' ? '2px solid #fff' : 'none';
}

function dataUrlToBytes(dataUrl) {
  const b64 = dataUrl.split(',')[1];
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i=0;i<bin.length;i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

async function pdfEditorLoadFile(ev) {
  const file = ev.target.files && ev.target.files[0];
  if (!file) return;
  if (file.type !== 'application/pdf') { toast('Please choose a PDF file.','error'); return; }
  const buf = await file.arrayBuffer();
  await pdfEditorRender(new Uint8Array(buf));
}

async function pdfEditorRender(bytes) {
  if (!window.pdfjsLib) { toast('PDF engine still loading — try again.','error'); return; }
  showLoading();
  try {
    pdfEd.srcBytes = bytes;
    pdfEd.edits = [];
    pdfEd.pageViewports = [];
    document.getElementById('pdfEditorHint').style.display = 'none';
    const pagesEl = document.getElementById('pdfEditorPages');
    pagesEl.innerHTML = '';
    const loadingTask = window.pdfjsLib.getDocument({ data: bytes.slice() });
    const pdf = await loadingTask.promise;
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const viewport = page.getViewport({ scale: pdfEd.scale });
      pdfEd.pageViewports[p-1] = viewport;
      const wrap = document.createElement('div');
      wrap.className = 'pdfed-page';
      wrap.style.cssText = `position:relative;margin:0 auto 18px;width:${viewport.width}px;height:${viewport.height}px;background:#fff;box-shadow:0 2px 12px rgba(0,0,0,.4)`;
      wrap.dataset.page = p;
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width; canvas.height = viewport.height;
      canvas.style.cssText = 'position:absolute;inset:0';
      wrap.appendChild(canvas);
      const overlay = document.createElement('div');
      overlay.className = 'pdfed-overlay';
      overlay.style.cssText = 'position:absolute;inset:0;cursor:crosshair';
      overlay.addEventListener('click', (e) => pdfEditorClickPage(e, p, wrap));
      wrap.appendChild(overlay);
      pagesEl.appendChild(wrap);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    }
    toast('PDF loaded — add text or white-out, then Save Version.');
  } catch(e) { toast('Could not render PDF: '+e.message,'error'); }
  hideLoading();
}

function pdfEditorClickPage(e, pageNum, wrap) {
  const rect = wrap.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  if (pdfEd.tool === 'text') {
    prPrompt('Add Text', 'Enter text to add', (txt) => {
      if (!txt) return;
      const el = document.createElement('div');
      el.className = 'pdfed-textnote';
      el.contentEditable = 'true';
      el.textContent = txt;
      el.style.cssText = `position:absolute;left:${x}px;top:${y}px;font:14px/1.2 Arial;color:#111;background:transparent;min-width:20px;padding:1px 2px;border:1px dashed #1E3A8A`;
      wrap.appendChild(el);
      pdfEd.edits.push({ type:'text', page:pageNum, x, y, el });
    });
  } else {
    const el = document.createElement('div');
    el.className = 'pdfed-whiteout';
    el.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:120px;height:22px;background:#fff;border:1px solid #cbd5e1;resize:both;overflow:hidden`;
    wrap.appendChild(el);
    pdfEd.edits.push({ type:'whiteout', page:pageNum, x, y, el });
  }
}

function pdfEditorUndo() {
  const last = pdfEd.edits.pop();
  if (last && last.el && last.el.parentNode) last.el.parentNode.removeChild(last.el);
}

function pdfEditorSave() {
  if (!pdfEd.srcBytes) { toast('Open a PDF first.','error'); return; }
  if (!window.PDFLib) { toast('PDF writer still loading — try again.','error'); return; }
  prPrompt('Save Version', 'Describe what changed in this version', async (note) => {
    if (!note) return;
    showLoading();
    try {
      const { PDFDocument, rgb, StandardFonts } = window.PDFLib;
      const doc = await PDFDocument.load(pdfEd.srcBytes.slice());
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const pages = doc.getPages();
      pdfEd.edits.forEach(ed => {
        const page = pages[ed.page-1];
        if (!page) return;
        const vp = pdfEd.pageViewports[ed.page-1];
        const scaleX = page.getWidth() / vp.width;
        const scaleY = page.getHeight() / vp.height;
        if (ed.type === 'text') {
          const text = ed.el.textContent || '';
          const left = parseFloat(ed.el.style.left) || ed.x;
          const top = parseFloat(ed.el.style.top) || ed.y;
          const size = 14 * scaleY;
          page.drawText(text, {
            x: left * scaleX,
            y: page.getHeight() - (top * scaleY) - size,
            size, font, color: rgb(0.07,0.07,0.07),
          });
        } else {
          const left = parseFloat(ed.el.style.left) || ed.x;
          const top = parseFloat(ed.el.style.top) || ed.y;
          const w = (ed.el.offsetWidth||120) * scaleX;
          const h = (ed.el.offsetHeight||22) * scaleY;
          page.drawRectangle({
            x: left * scaleX,
            y: page.getHeight() - (top * scaleY) - h,
            width: w, height: h, color: rgb(1,1,1),
          });
        }
      });
      const out = await doc.save();
      let bin = '';
      const chunk = 0x8000;
      for (let i=0;i<out.length;i+=chunk) bin += String.fromCharCode.apply(null, out.subarray(i, i+chunk));
      const dataUrl = 'data:application/pdf;base64,' + btoa(bin);
      const r = await api('/requests/'+pdfEd.id+'/concern-version',{method:'POST',
        body:JSON.stringify({ file:dataUrl, filename:'report_corrected.pdf', changeNote:note })});
      toast('Saved as report version '+(r.data?.version_number||'')+'.');
      pdfEditorClose();
      if (rcCurrentId) openRcReview(rcCurrentId);
      loadReportConcerns();
    } catch(e) { toast('Could not save: '+e.message,'error'); }
    hideLoading();
  }, 'Corrected report');
}