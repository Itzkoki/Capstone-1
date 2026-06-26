/* ══════════════════════════════════════════════════════════
   PSYGEN — Dashboard: report list, stats, bulk actions
   ══════════════════════════════════════════════════════════ */

// ── Dashboard ───────────────────────────────────────────────
async function loadDashboard() {
  try {
    const d = await api('/reports');
    allReports = d.reports||[];
    // Latest reports first — sort by creation time (newest at the top).
    allReports.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    renderStats(); renderReportTable(allReports);
    if (USER.role==='clinical_director') {
      try { const p = await api('/reports/pending-reviews'); document.getElementById('pendingBadge').textContent = (p.reports||[]).length; } catch(e){}
    }
  } catch(e) { console.error('Dashboard error:', e); }
}

function renderStats() {
  const s = document.getElementById('statsRow');
  const c = { total:allReports.length, draft:0, submitted:0, approved:0, rejected:0, finalized:0 };
  allReports.forEach(r=>{ if(c[r.status]!==undefined) c[r.status]++; });
  s.innerHTML = `<div class="stat-card"><div class="stat-value">${c.total}</div><div class="stat-label">Total</div></div>
    <div class="stat-card"><div class="stat-value">${c.draft}</div><div class="stat-label">Drafts</div></div>
    <div class="stat-card"><div class="stat-value">${c.submitted}</div><div class="stat-label">Submitted</div></div>
    <div class="stat-card"><div class="stat-value">${c.approved}</div><div class="stat-label">Approved</div></div>
    <div class="stat-card"><div class="stat-value">${c.finalized}</div><div class="stat-label">Finalized</div></div>`;
}

function renderReportTable(reports) {
  const b = document.getElementById('reportBody');
  const e = document.getElementById('emptyReports');
  if (!reports.length) { b.innerHTML=''; e.classList.remove('hidden'); syncBulkBar(); return; }
  e.classList.add('hidden');
  // During the signature workflow, Supervising / QC reviewers get a "View"-only
  // row (no PDF / Delete) and the friendlier "Signature Required" status label.
  const inSignFlow = (r) => !!r.signature_stage && (USER.role === 'supervising_psychometrician' || USER.role === 'qc_psychometrician');
  const statusCell = (r) => {
    // A released report under an active client concern shows its modification
    // status first (takes precedence over the signature label).
    const mod = r.modification_status || '';
    const sig = (typeof signatureStageLabel === 'function') ? signatureStageLabel(r.signature_stage) : '';
    const label = mod || sig;
    return label
      ? `<span class="badge-status badge-warning"><span class="badge-dot"></span>${label}</span>`
      : `<span class="badge-status badge-${r.status}"><span class="badge-dot"></span>${r.status}</span>`;
  };
  b.innerHTML = reports.map(r=>`<tr class="report-row" onclick="openReport(${r.id})">
    <td class="col-check" onclick="event.stopPropagation()"><input type="checkbox" class="report-check" value="${r.id}" onchange="syncBulkBar()"></td>
    <td><strong>${esc(r.client_name)}</strong>${r.case_id ? ' <span style="font-size:10px;color:#667eea;font-weight:700;background:#eef1fa;padding:2px 6px;border-radius:6px;margin-left:6px">' + esc(r.case_id) + '</span>' : ''}</td>
    <td>${esc(r.template_name||r.template_type||'')}</td>
    <td>${statusCell(r)}</td>
    <td>${fmtDateTime(r.created_at)}</td>
    <td>${fmtDateTime(r.updated_at)}</td>
    <td class="col-actions"><button class="btn btn-ghost-primary btn-sm" onclick="event.stopPropagation();openReport(${r.id})">View</button>
    ${inSignFlow(r) ? '' : `<button class="btn btn-ghost-primary btn-sm" onclick="event.stopPropagation();downloadPdf(${r.id})">PDF</button>
    ${canDeleteReport(r) ? `<button class="btn btn-ghost-danger btn-sm" onclick="event.stopPropagation();deleteReport(${r.id})">Delete</button>` : ''}`}</td>
  </tr>`).join('');
  syncBulkBar();
}

// ── Bulk selection / actions ────────────────────────────────
function getReportChecks() { return Array.from(document.querySelectorAll('.report-check')); }
function getSelectedReportIds() { return getReportChecks().filter(c=>c.checked).map(c=>parseInt(c.value,10)); }

function toggleSelectAll(src) {
  const checked = src.checked;
  getReportChecks().forEach(c => { c.checked = checked; });
  const el = document.getElementById('selectAllReports'); if (el) el.checked = checked;
  updateBulkBar();
}

function syncBulkBar() {
  const checks = getReportChecks();
  const selected = checks.filter(c=>c.checked).length;
  const allChecked = checks.length > 0 && selected === checks.length;
  const el = document.getElementById('selectAllReports'); if (el) el.checked = allChecked;
  updateBulkBar();
}
function updateBulkBar() {
  const n = getSelectedReportIds().length;
  const count = document.getElementById('bulkCount');
  if (count) count.textContent = `${n} selected`;
  const icons = document.getElementById('bulkIcons');
  if (icons) icons.classList.toggle('hidden', n === 0);
}

function bulkDeleteReports() {
  const ids = getSelectedReportIds();
  if (!ids.length) { toast('No reports selected','error'); return; }
  prConfirm('Delete Reports', `Move ${ids.length} selected report(s) to Trash?`, async () => {
    showLoading();
    try {
      const d = await api('/reports/bulk/delete', { method:'POST', body:JSON.stringify({ ids }) });
      toast(d.message || 'Reports moved to Trash.');
      await loadDashboard();
    } catch(e) { toast(e.message,'error'); }
    hideLoading();
  });
}

function bulkArchiveReports() {
  const ids = getSelectedReportIds();
  if (!ids.length) { toast('No reports selected','error'); return; }
  prConfirm('Archive Reports', `Archive ${ids.length} selected report(s)?`, async () => {
    showLoading();
    try {
      const d = await api('/reports/bulk/archive', { method:'POST', body:JSON.stringify({ ids }) });
      toast(d.message || 'Reports archived.');
      await loadDashboard();
    } catch(e) { toast(e.message,'error'); }
    hideLoading();
  });
}

function filterReports() {
  const q = document.getElementById('reportSearch').value.toLowerCase();
  const s = document.getElementById('statusFilter').value;
  let f = allReports;
  if (q) f = f.filter(r=>(r.client_name||'').toLowerCase().includes(q));
  if (s) {
    // Signature-pipeline statuses are derived from signature_stage, not status.
    if (s === 'mod:required') {
      f = f.filter(r => !!r.modification_status);
    } else if (s === 'sig:required') {
      f = f.filter(r => ['supervising','quality_control','psychologist'].includes(r.signature_stage));
    } else if (s === 'sig:ready_for_release') {
      f = f.filter(r => r.signature_stage === 'ready_for_release');
    } else if (s === 'sig:released') {
      f = f.filter(r => r.signature_stage === 'released');
    } else {
      f = f.filter(r => r.status === s);
    }
  }
  renderReportTable(f);
}