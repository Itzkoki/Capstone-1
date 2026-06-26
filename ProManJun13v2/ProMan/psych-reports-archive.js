/* ══════════════════════════════════════════════════════════
   PSYGEN — Archive & Trash: bulk restore, permanent delete
   ══════════════════════════════════════════════════════════ */

// ── Archive ─────────────────────────────────────────────────
async function loadArchive() {
  try {
    const d = await api('/reports/archive');
    allArchive = d.reports || [];
    renderArchiveStats();
    renderArchiveTable(allArchive);
  } catch(e) { toast(e.message,'error'); }
}

function renderArchiveStats() {
  const s = document.getElementById('archiveStatsRow');
  if (!s) return;
  const c = { total:allArchive.length, draft:0, submitted:0, approved:0, rejected:0, finalized:0 };
  allArchive.forEach(r=>{ if(c[r.status]!==undefined) c[r.status]++; });
  s.innerHTML = `<div class="stat-card"><div class="stat-value">${c.total}</div><div class="stat-label">Total</div></div>
    <div class="stat-card"><div class="stat-value">${c.draft}</div><div class="stat-label">Drafts</div></div>
    <div class="stat-card"><div class="stat-value">${c.submitted}</div><div class="stat-label">Submitted</div></div>
    <div class="stat-card"><div class="stat-value">${c.approved}</div><div class="stat-label">Approved</div></div>
    <div class="stat-card"><div class="stat-value">${c.finalized}</div><div class="stat-label">Finalized</div></div>`;
}

function renderArchiveTable(reports) {
  const b = document.getElementById('archiveBody');
  const e = document.getElementById('emptyArchive');
  if (!reports.length) { b.innerHTML=''; e.classList.remove('hidden'); syncArchiveBulkBar(); return; }
  e.classList.add('hidden');
  b.innerHTML = reports.map(r=>`<tr>
    <td class="col-check"><input type="checkbox" class="archive-check" value="${r.id}" onchange="syncArchiveBulkBar()"></td>
    <td><strong>${esc(r.client_name)}</strong></td>
    <td>${esc(r.template_name||r.template_type||'')}</td>
    <td><span class="badge-status badge-${r.status}"><span class="badge-dot"></span>${r.status}</span></td>
    <td>${fmtDateTime(r.archived_at)}</td>
    <td class="col-actions"><button class="btn btn-ghost-primary btn-sm" onclick="unarchiveReport(${r.id})">Restore</button></td>
  </tr>`).join('');
  syncArchiveBulkBar();
}

function filterArchive() {
  const el = document.getElementById('archiveSearch');
  const q = (el ? el.value : '').toLowerCase();
  const sf = document.getElementById('archiveStatusFilter');
  const s = sf ? sf.value : '';
  let f = allArchive;
  if (q) f = f.filter(r=>(r.client_name||'').toLowerCase().includes(q));
  if (s) f = f.filter(r=>r.status===s);
  renderArchiveTable(f);
}

function getArchiveChecks() { return Array.from(document.querySelectorAll('.archive-check')); }
function getSelectedArchiveIds() { return getArchiveChecks().filter(c=>c.checked).map(c=>parseInt(c.value,10)); }
function toggleSelectAllArchive(src) {
  getArchiveChecks().forEach(c => { c.checked = src.checked; });
  syncArchiveBulkBar();
}
function syncArchiveBulkBar() {
  const checks = getArchiveChecks();
  const selected = checks.filter(c=>c.checked).length;
  const all = document.getElementById('selectAllArchive');
  if (all) all.checked = checks.length > 0 && selected === checks.length;
  const count = document.getElementById('archiveBulkCount');
  if (count) count.textContent = `${selected} selected`;
  const icons = document.getElementById('archiveBulkIcons');
  if (icons) icons.classList.toggle('hidden', selected === 0);
}

function bulkRestoreArchive() {
  const ids = getSelectedArchiveIds();
  if (!ids.length) { toast('No reports selected','error'); return; }
  prConfirm('Restore Reports', `Restore ${ids.length} selected report(s) to the dashboard?`, async () => {
    showLoading();
    try {
      for (const id of ids) await api('/reports/'+id+'/unarchive', { method:'POST' });
      toast(`${ids.length} report(s) restored to dashboard.`);
      await loadArchive();
    } catch(e) { toast(e.message,'error'); }
    hideLoading();
  });
}

async function unarchiveReport(id) {
  showLoading();
  try {
    await api('/reports/'+id+'/unarchive', { method:'POST' });
    toast('Report restored to dashboard.');
    await loadArchive();
  } catch(e) { toast(e.message,'error'); }
  hideLoading();
}

// ── Trash (Director) ────────────────────────────────────────
async function loadTrash() {
  try {
    const d = await api('/reports/trash');
    allTrash = d.reports || [];
    renderTrashStats();
    renderTrashTable(allTrash);
  } catch(e) { toast(e.message,'error'); }
}

function renderTrashStats() {
  const s = document.getElementById('trashStatsRow');
  if (!s) return;
  const c = { total:allTrash.length, draft:0, submitted:0, approved:0, rejected:0, finalized:0 };
  allTrash.forEach(r=>{ if(c[r.status]!==undefined) c[r.status]++; });
  s.innerHTML = `<div class="stat-card"><div class="stat-value">${c.total}</div><div class="stat-label">Total</div></div>
    <div class="stat-card"><div class="stat-value">${c.draft}</div><div class="stat-label">Drafts</div></div>
    <div class="stat-card"><div class="stat-value">${c.submitted}</div><div class="stat-label">Submitted</div></div>
    <div class="stat-card"><div class="stat-value">${c.approved}</div><div class="stat-label">Approved</div></div>
    <div class="stat-card"><div class="stat-value">${c.finalized}</div><div class="stat-label">Finalized</div></div>`;
}

function renderTrashTable(reports) {
  const b = document.getElementById('trashBody');
  const e = document.getElementById('emptyTrash');
  if (!reports.length) { b.innerHTML=''; e.classList.remove('hidden'); syncTrashBulkBar(); return; }
  e.classList.add('hidden');
  b.innerHTML = reports.map(r=>`<tr>
    <td class="col-check"><input type="checkbox" class="trash-check" value="${r.id}" onchange="syncTrashBulkBar()"></td>
    <td><strong>${esc(r.client_name)}</strong></td>
    <td>${esc(r.template_name||r.template_type||'')}</td>
    <td><span class="badge-status badge-${r.status}"><span class="badge-dot"></span>${r.status}</span></td>
    <td>${fmtDateTime(r.deleted_at)}</td>
    <td class="col-actions"><button class="btn btn-ghost-primary btn-sm" onclick="restoreReport(${r.id})">Restore</button>
    <button class="btn btn-ghost-danger btn-sm" onclick="permanentDeleteReport(${r.id})">Delete</button></td>
  </tr>`).join('');
  syncTrashBulkBar();
}

function filterTrash() {
  const el = document.getElementById('trashSearch');
  const q = (el ? el.value : '').toLowerCase();
  const sf = document.getElementById('trashStatusFilter');
  const s = sf ? sf.value : '';
  let f = allTrash;
  if (q) f = f.filter(r=>(r.client_name||'').toLowerCase().includes(q));
  if (s) f = f.filter(r=>r.status===s);
  renderTrashTable(f);
}

function getTrashChecks() { return Array.from(document.querySelectorAll('.trash-check')); }
function getSelectedTrashIds() { return getTrashChecks().filter(c=>c.checked).map(c=>parseInt(c.value,10)); }
function toggleSelectAllTrash(src) {
  getTrashChecks().forEach(c => { c.checked = src.checked; });
  syncTrashBulkBar();
}
function syncTrashBulkBar() {
  const checks = getTrashChecks();
  const selected = checks.filter(c=>c.checked).length;
  const all = document.getElementById('selectAllTrash');
  if (all) all.checked = checks.length > 0 && selected === checks.length;
  const count = document.getElementById('trashBulkCount');
  if (count) count.textContent = `${selected} selected`;
  const icons = document.getElementById('trashBulkIcons');
  if (icons) icons.classList.toggle('hidden', selected === 0);
}

function bulkRestoreTrash() {
  const ids = getSelectedTrashIds();
  if (!ids.length) { toast('No reports selected','error'); return; }
  prConfirm('Restore Reports', `Restore ${ids.length} selected report(s)?`, async () => {
    showLoading();
    try {
      for (const id of ids) await api('/reports/'+id+'/restore', { method:'POST' });
      toast(`${ids.length} report(s) restored.`);
      await loadTrash();
    } catch(e) { toast(e.message,'error'); }
    hideLoading();
  });
}

function bulkPermanentDeleteTrash() {
  const ids = getSelectedTrashIds();
  if (!ids.length) { toast('No reports selected','error'); return; }
  prConfirm('Permanently Delete', `Permanently delete ${ids.length} selected report(s)? This cannot be undone.`, async () => {
    showLoading();
    try {
      for (const id of ids) await api('/reports/'+id+'/permanent', { method:'DELETE' });
      toast(`${ids.length} report(s) permanently deleted.`);
      await loadTrash();
    } catch(e) { toast(e.message,'error'); }
    hideLoading();
  }, true);
}

async function restoreReport(id) {
  showLoading();
  try {
    await api('/reports/'+id+'/restore', { method:'POST' });
    toast('Report restored.');
    await loadTrash();
  } catch(e) { toast(e.message,'error'); }
  hideLoading();
}

function permanentDeleteReport(id) {
  prConfirm('Permanently Delete', 'Permanently delete this report? This cannot be undone.', async () => {
    showLoading();
    try {
      await api('/reports/'+id+'/permanent', { method:'DELETE' });
      toast('Report permanently deleted.');
      await loadTrash();
    } catch(e) { toast(e.message,'error'); }
    hideLoading();
  }, true);
}