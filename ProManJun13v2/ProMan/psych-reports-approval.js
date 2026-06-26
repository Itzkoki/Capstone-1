/* ══════════════════════════════════════════════════════════
   PSYGEN — Approval: review, finalize, pending reviews,
            audit logs
   ══════════════════════════════════════════════════════════ */

// ── Approval ────────────────────────────────────────────────
let approvalReportId = null;
function showApprovalModal(id) { approvalReportId=id; document.getElementById('approvalComments').value=''; openModal('approvalModal'); }

async function handleApproval(action) {
  if (!approvalReportId) return; showLoading();
  try {
    await api(`/reports/${approvalReportId}/${action}`,{method:'POST',body:JSON.stringify({comments:document.getElementById('approvalComments').value})});
    toast(`Report ${action==='approve'?'approved':'rejected'}!`); closeModal('approvalModal'); loadDashboard();
  } catch(e) { toast(e.message,'error'); } hideLoading();
}

let _finalizeRptId = null;
function finalizeRpt(id) {
  _finalizeRptId = id;
  openModal('finalizeModal');
}
async function _doFinalizeRpt() {
  closeModal('finalizeModal');
  if (!_finalizeRptId) return;
  const id = _finalizeRptId; _finalizeRptId = null;
  showLoading();
  try { await api('/reports/'+id+'/finalize',{method:'POST'}); toast('Finalized!'); openReport(id); }
  catch(e) { toast(e.message,'error'); } hideLoading();
}

// ── Pending Reviews ─────────────────────────────────────────
async function loadPendingReviews() {
  try {
    const d = await api('/reports/pending-reviews'); const rpts = d.reports||[];
    const c = document.getElementById('reviewsList'); const e = document.getElementById('emptyReviews');
    if (!rpts.length) { c.innerHTML=''; e.classList.remove('hidden'); return; }
    e.classList.add('hidden');
    c.innerHTML = rpts.map(r=>`<div class="card" style="margin-bottom:12px;cursor:pointer" onclick="openReport(${r.id})">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div><h4 style="color:var(--text-heading)">${esc(r.client_name)}</h4>
          <p style="font-size:12px;color:var(--text-muted)">${esc(r.template_name||'')} — by ${esc(r.psychologist_name||'')}</p></div>
        <button class="btn btn-success btn-sm" onclick="event.stopPropagation();showApprovalModal(${r.id})">Review</button>
      </div></div>`).join('');
  } catch(e) { toast('Error','error'); }
}

// ── Audit Logs ──────────────────────────────────────────────
async function loadAuditLogs() {
  try {
    const d = await api('/reports/audit-logs?limit=200');
    document.getElementById('auditBody').innerHTML = (d.logs||[]).map(l=>`<tr>
      <td>${fmtDateTime(l.created_at)}</td><td>${esc(l.user_name||'System')}</td>
      <td><span class="audit-action ${l.action}">${l.action}</span></td>
      <td>${esc(l.details||'')}</td><td style="font-size:11px">${esc(l.ip_address||'')}</td></tr>`).join('');
  } catch(e) { toast('Error','error'); }
}