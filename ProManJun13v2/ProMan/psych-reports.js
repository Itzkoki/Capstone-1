/* ══════════════════════════════════════════════════════════
   PSYGEN — Psychological Report Module JavaScript
   Core application logic, API integration, and UI control
   ══════════════════════════════════════════════════════════ */

const API = 'http://localhost:5000/api';
// Use the same session storage keys as the existing BPSSession system
let TOKEN = sessionStorage.getItem('bps_token') || '';
let USER = null;
let currentReport = null;
let selectedTemplateId = null;
let allReports = [];
let allArchive = [];
let allTrash = [];
let allTemplates = [];
let editingTplId = null;
let intakeClients = [];
let selectedClient = null;

// SVG icon templates for template types (replacing emojis)
const TPL_ICONS = {
  neurodevelopmental: '<svg viewBox="0 0 24 24" width="24" height="24" fill="var(--primary)"><path d="M13 1.07V9h7c0-4.08-3.05-7.44-7-7.93zM4 15c0 4.42 3.58 8 8 8s8-3.58 8-8v-4H4v4zm7-13.93C7.05 1.56 4 4.92 4 9h7V1.07z"/></svg>',
  clinical: '<svg viewBox="0 0 24 24" width="24" height="24" fill="var(--primary)"><path d="M19 3H5c-1.1 0-1.99.9-1.99 2L3 19c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-1 11h-4v4h-4v-4H6v-4h4V6h4v4h4v4z"/></svg>',
  pre_employment: '<svg viewBox="0 0 24 24" width="24" height="24" fill="var(--primary)"><path d="M20 6h-4V4c0-1.11-.89-2-2-2h-4c-1.11 0-2 .89-2 2v2H4c-1.11 0-1.99.89-1.99 2L2 19c0 1.11.89 2 2 2h16c1.11 0 2-.89 2-2V8c0-1.11-.89-2-2-2zm-6 0h-4V4h4v2z"/></svg>',
  default: '<svg viewBox="0 0 24 24" width="24" height="24" fill="var(--primary)"><path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm4 18H6V4h7v5h5v11z"/></svg>'
};

// Allowed roles for this module. QC Psychometricians are admitted but are
// scoped to template management only (see applyRoleScope).
const ALLOWED_ROLES = ['psychologist', 'qc_psychometrician', 'clinical_director'];

function headers() { return { 'Content-Type':'application/json','Authorization':'Bearer '+TOKEN }; }

async function api(path, opts={}) {
  const res = await fetch(API+path, { headers: headers(), ...opts });
  if (res.headers.get('content-type')?.includes('application/pdf')) return res;
  const data = await res.json();
  if (!res.ok) { const e = new Error(data.message||'Request failed'); e.errors = data.errors || null; throw e; }
  return data;
}

// ── Init ────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // Redirect if no auth token
  if (!TOKEN) { window.location.href = 'login.html'; return; }

  // Try to get user from sessionStorage first (fast), then verify with API
  try {
    const storedUser = JSON.parse(sessionStorage.getItem('bps_user') || '{}');
    if (storedUser && storedUser.role) {
      USER = storedUser;
    }
  } catch(e) {}

  // If we don't have user data from session, decode from JWT
  if (!USER || !USER.role) {
    try {
      const payload = JSON.parse(atob(TOKEN.split('.')[1]));
      USER = { id: payload.id, role: payload.role, full_name: payload.full_name || payload.email || 'User' };
    } catch(e) { window.location.href = 'login.html'; return; }
  }

  // Role restriction: only psychologist and clinical_director
  if (!ALLOWED_ROLES.includes(USER.role)) {
    alert('Access denied. This module is restricted to Psychologists and Clinical Directors.');
    window.location.href = 'admin-dashboard.html';
    return;
  }

  // Try to fetch full profile from API (non-blocking)
  try {
    const d = await api('/profile');
    const profile = d.profile || d.user || d;
    if (profile.role) USER = { ...USER, ...profile };
  } catch(e) { console.warn('Profile fetch skipped:', e.message); }

  // Update UI
  document.getElementById('userName').textContent = USER.full_name||USER.email||'User';
  document.getElementById('userRole').textContent = (USER.role||'').replace(/_/g,' ');
  document.getElementById('userAvatar').textContent = (USER.full_name||'U')[0].toUpperCase();
  if (USER.role==='clinical_director') document.getElementById('directorNav').classList.remove('hidden');
  if (USER.role==='clinical_director') { try { await refreshReportRequestBadge(); } catch(e){} }
  if (USER.role==='clinical_director') { try { await refreshReportConcernBadge(); } catch(e){} }

  // QC Psychometrician is scoped to Manage Templates ONLY — no reports list.
  if (USER.role === 'qc_psychometrician') {
    applyQcTemplateScope();
    showView('manageTpl');
    return;
  }

  // Honour a deep-link hash (e.g. #create, #manageTpl) from the navbar/dashboard.
  var hash = (location.hash || '').replace('#','');
  if (hash && document.getElementById('view-' + hash)) { showView(hash); return; }

  await loadDashboard();
});

// Restrict the sidebar to the Manage Templates item for QC Psychometricians.
function applyQcTemplateScope() {
  var dn = document.getElementById('directorNav');
  if (dn) dn.classList.remove('hidden');
  document.querySelectorAll('.nav-item').forEach(function (n) {
    if (n.getAttribute('data-view') !== 'manageTpl') n.style.display = 'none';
  });
  var title = document.querySelector('#directorNav .nav-section-title');
  if (title) title.style.display = 'none';
}

// ── Views ───────────────────────────────────────────────────
function showView(name) {
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
  const v = document.getElementById('view-'+name);
  if (v) v.classList.add('active');
  const n = document.querySelector(`.nav-item[data-view="${name}"]`);
  if (n) n.classList.add('active');
  if (name==='dashboard') loadDashboard();
  else if (name==='create') loadTemplatesForCreate();
  else if (name==='templates') loadTemplatesView();
  else if (name==='reviews') loadPendingReviews();
  else if (name==='reportRequests') loadReportRequests();
  else if (name==='reportConcerns') loadReportConcerns();
  else if (name==='audit') loadAuditLogs();
  else if (name==='manageTpl') loadManageTemplates();
  else if (name==='trash') loadTrash();
  else if (name==='archive') loadArchive();
}

function toast(msg, type='success') {
  const t = document.getElementById('rptToast');
  t.textContent = msg; t.className = 'rpt-toast show '+type;
  setTimeout(()=>t.classList.remove('show'), 3000);
}
function showLoading() { document.getElementById('loadingOverlay').classList.add('active'); }
function hideLoading() { document.getElementById('loadingOverlay').classList.remove('active'); }

// ── Dashboard ───────────────────────────────────────────────
async function loadDashboard() {
  try {
    const d = await api('/reports');
    allReports = d.reports||[];
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
  b.innerHTML = reports.map(r=>`<tr class="report-row" onclick="openReport(${r.id})">
    <td class="col-check" onclick="event.stopPropagation()"><input type="checkbox" class="report-check" value="${r.id}" onchange="syncBulkBar()"></td>
    <td><strong>${esc(r.client_name)}</strong>${r.case_id ? ' <span style="font-size:10px;color:#667eea;font-weight:700;background:#eef1fa;padding:2px 6px;border-radius:6px;margin-left:6px">' + esc(r.case_id) + '</span>' : ''}</td>
    <td>${esc(r.template_name||r.template_type||'')}</td>
    <td><span class="badge-status badge-${r.status}"><span class="badge-dot"></span>${r.status}</span></td>
    <td>${fmtDate(r.created_at)}</td>
    <td class="col-actions"><button class="btn btn-ghost-primary btn-sm" onclick="event.stopPropagation();openReport(${r.id})">View</button>
    <button class="btn btn-ghost-primary btn-sm" onclick="event.stopPropagation();downloadPdf(${r.id})">PDF</button>
    ${canDeleteReport(r) ? `<button class="btn btn-ghost-danger btn-sm" onclick="event.stopPropagation();deleteReport(${r.id})">Delete</button>` : ''}</td>
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

// Refresh the selected count, the Select All checkbox state, and toggle the
// archive/delete icons (shown only when at least one report is selected).
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

async function bulkDeleteReports() {
  const ids = getSelectedReportIds();
  if (!ids.length) { toast('No reports selected','error'); return; }
  if (!confirm(`Move ${ids.length} selected report(s) to Trash?`)) return;
  showLoading();
  try {
    const d = await api('/reports/bulk/delete', { method:'POST', body:JSON.stringify({ ids }) });
    toast(d.message || 'Reports moved to Trash.');
    await loadDashboard();
  } catch(e) { toast(e.message,'error'); }
  hideLoading();
}

async function bulkArchiveReports() {
  const ids = getSelectedReportIds();
  if (!ids.length) { toast('No reports selected','error'); return; }
  if (!confirm(`Archive ${ids.length} selected report(s)?`)) return;
  showLoading();
  try {
    const d = await api('/reports/bulk/archive', { method:'POST', body:JSON.stringify({ ids }) });
    toast(d.message || 'Reports archived.');
    await loadDashboard();
  } catch(e) { toast(e.message,'error'); }
  hideLoading();
}

function filterReports() {
  const q = document.getElementById('reportSearch').value.toLowerCase();
  const s = document.getElementById('statusFilter').value;
  let f = allReports;
  if (q) f = f.filter(r=>(r.client_name||'').toLowerCase().includes(q));
  if (s) f = f.filter(r=>r.status===s);
  renderReportTable(f);
}

// ── Templates ───────────────────────────────────────────────
// Clear every Assessment Data field so input from a previous report/template
// is never carried over into the next one.
function clearAssessmentInputs() {
  ['cTests', 'cObsNotes', 'cBehObs', 'cInterview'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  // Reset pre-employment tests table so it rebuilds (with empty dates) next time.
  const peBody = document.querySelector('#preempTable tbody');
  if (peBody) { peBody.innerHTML = ''; delete peBody.dataset.built; }
}

function resetCreateForm() {
  // Reset state
  currentReport = null;
  selectedClient = null;
  selectedTemplateId = null;

  // Step 2: Client selection
  const clientSelect = document.getElementById('cClientSelect');
  if (clientSelect) clientSelect.value = '';
  const clientPreview = document.getElementById('clientInfoPreview');
  if (clientPreview) clientPreview.classList.add('hidden');
  const assessDate = document.getElementById('cAssessDate');
  if (assessDate) assessDate.value = '';

  // Step 3: Assessment data
  clearAssessmentInputs();

  // Step 4 (Generate): Narrative results
  const narrativeResults = document.getElementById('narrativeResults');
  if (narrativeResults) { narrativeResults.innerHTML = ''; narrativeResults.classList.add('hidden'); }
  const btnToEdit = document.getElementById('btnToEdit');
  if (btnToEdit) btnToEdit.classList.add('hidden');

  // Step 5: Section editor
  const sectionsEditor = document.getElementById('sectionsEditor');
  if (sectionsEditor) sectionsEditor.innerHTML = '';

  // Clear save timers
  Object.keys(saveTimers).forEach(k => { clearTimeout(saveTimers[k]); delete saveTimers[k]; });
}

async function loadTemplatesForCreate() {
  resetCreateForm();
  try {
    const d = await api('/report-templates'); allTemplates = d.templates||[];
    document.getElementById('btnTplNext').disabled = true;
    renderTemplateCards('templateGrid', true); nextCreateStep(1);
  } catch(e) { toast('Failed to load templates','error'); }
}

async function loadTemplatesView() {
  try { const d = await api('/report-templates'); allTemplates = d.templates||[]; renderTemplateCards('viewTemplateGrid', false); }
  catch(e) { toast('Failed to load templates','error'); }
}

function renderTemplateCards(cid, selectable) {
  const c = document.getElementById(cid);
  c.innerHTML = allTemplates.map(t=>{
    const secs = (t.sections_config||[]).slice(0,5);
    const iconSvg = TPL_ICONS[t.template_type] || TPL_ICONS.default;
    return `<div class="template-card${selectedTemplateId===t.id?' selected':''}" ${selectable?`onclick="selectTemplate(${t.id})"`:''}>
      <div class="tpl-icon">${iconSvg}</div>
      <h4>${esc(t.name)}</h4><p>${esc(t.description||'')}</p>
      <div class="section-tags">${secs.map(s=>`<span class="section-tag">${esc(s.title)}</span>`).join('')}</div></div>`;
  }).join('');
}

function selectTemplate(id) {
  // Switching template choice clears any assessment input already typed so it
  // is not carried over to a different template.
  if (selectedTemplateId !== id) clearAssessmentInputs();
  selectedTemplateId = id;
  renderTemplateCards('templateGrid', true);
  document.getElementById('btnTplNext').disabled = false;
}

// ── Wizard Steps ────────────────────────────────────────────
function nextCreateStep(n) {
  document.querySelectorAll('.create-step').forEach(s=>s.classList.add('hidden'));
  const step = document.getElementById('cstep-'+n);
  if (step) step.classList.remove('hidden');
  // Update circular stepper
  document.querySelectorAll('#createStepper .circle-step').forEach((s,i)=>{
    s.classList.remove('active','completed');
    if (i+1<n) s.classList.add('completed');
    if (i+1===n) s.classList.add('active');
  });
  // Load intake clients when reaching step 2
  if (n===2) loadIntakeClients();
  if (n===3) renderAssessmentStep();
  if (n===5) loadSectionsEditor();
}

// ── Intake Client Integration ───────────────────────────────
async function loadIntakeClients() {
  try {
    const d = await api('/reports/intake-clients');
    intakeClients = d.clients || [];
    const sel = document.getElementById('cClientSelect');
    sel.innerHTML = '<option value="">— Select a client —</option>' +
      intakeClients.map((c,i) => {
        const caseLabel = c.case_id || `Intake #${c.intake_id}`;
        const typeLabel = c.service_type === 'assessment' ? 'Assessment' : c.service_type === 'counseling' ? 'Counseling' : '';
        const tag = typeLabel ? `${caseLabel} · ${typeLabel}` : caseLabel;
        return `<option value="${i}">${esc(c.full_name || c.account_name || 'Unknown')} — ${esc(c.email || c.account_email || '')} (${esc(tag)})</option>`;
      }).join('');
  } catch(e) {
    console.error('Failed to load intake clients:', e);
    toast('Could not load clients from intake forms', 'error');
  }
}

function onClientSelect() {
  const sel = document.getElementById('cClientSelect');
  const idx = sel.value;
  const preview = document.getElementById('clientInfoPreview');
  if (idx === '' || idx === null) {
    selectedClient = null;
    preview.classList.add('hidden');
    return;
  }
  selectedClient = intakeClients[parseInt(idx)];
  document.getElementById('previewName').textContent = selectedClient.full_name || selectedClient.account_name || '—';
  document.getElementById('previewAge').textContent = selectedClient.age || '—';
  document.getElementById('previewGender').textContent = selectedClient.gender || '—';
  document.getElementById('previewEmail').textContent = selectedClient.email || selectedClient.account_email || '—';
  preview.classList.remove('hidden');
}

async function createReportFromForm() {
  if (!selectedClient) { toast('Please select a client from the intake forms','error'); return; }
  if (!selectedTemplateId) { toast('Select a template first','error'); return; }
  showLoading();
  try {
    const d = await api('/reports', { method:'POST', body:JSON.stringify({
      template_id: selectedTemplateId,
      client_name: selectedClient.full_name || selectedClient.account_name,
      client_age: selectedClient.age || null,
      client_gender: selectedClient.gender || null,
      date_of_assessment: document.getElementById('cAssessDate').value || null
    })}); currentReport = d.report;
    // A brand-new report starts with a clean Assessment Data step so no input
    // from a previously created report/template carries over.
    clearAssessmentInputs();
    toast('Report created!'); nextCreateStep(3);
  } catch(e) { toast(e.message,'error'); } hideLoading();
}

async function saveAssessmentStep() {
  if (!currentReport) return; showLoading();
  try {
    const type = currentTemplateType();

    if (type === 'pre_employment') {
      // Fixed test list with administered dates → structured table.
      const peTests = collectPreempTests();
      await api('/reports/'+currentReport.id+'/assessment', { method:'POST', body:JSON.stringify({
        tests_administered: [],   // kept empty so the dynamic tools table doesn't duplicate
        observational_notes: document.getElementById('cObsNotes').value,
        behavioral_observations: document.getElementById('cBehObs').value,
        interview_findings: document.getElementById('cInterview').value,
        additional_data: { preemp_tests: peTests }
      })});

      // Write a TESTS_TABLE block into the Assessment Tools/Procedure section.
      const rows = peTests.map(t => `${t.name}||${t.date || '—'}`).join('\n');
      const tableBlock = `[[TESTS_TABLE]]\nTest Administered||Date Administered\n${rows}\n[[/TESTS_TABLE]]`;
      const reportData = await api('/reports/'+currentReport.id);
      const section = (reportData.sections||[]).find(s => s.section_key === 'assessment_tools_procedure');
      if (section) {
        await api('/reports/'+currentReport.id+'/sections/assessment_tools_procedure', {
          method:'PUT', body:JSON.stringify({ content: tableBlock })
        });
      }
    } else {
      // Neurodevelopmental / clinical: observation-based, like the other reports.
      // No assessment-measure scoring is collected — narratives are generated
      // from the tests administered and the observational/behavioral/interview notes.
      const tests = document.getElementById('cTests').value.split(',').map(t=>t.trim()).filter(Boolean);

      await api('/reports/'+currentReport.id+'/assessment', { method:'POST', body:JSON.stringify({
        tests_administered: tests,
        observational_notes: document.getElementById('cObsNotes').value,
        behavioral_observations: document.getElementById('cBehObs').value,
        interview_findings: document.getElementById('cInterview').value,
        additional_data: {}
      })});
    }
    toast('Assessment data saved!'); nextCreateStep(4);
  } catch(e) { toast(e.message,'error'); } hideLoading();
}



// ── Narrative Generation ────────────────────────────────────
function renderFindingsTable(content) {
  const m = String(content).match(/\[\[FINDINGS_TABLE\]\]\s*([\s\S]*?)\s*\[\[\/FINDINGS_TABLE\]\]/);
  if (!m) return `<div style="font-size:13px;line-height:1.7;color:var(--text-secondary);white-space:pre-wrap">${esc(content)}</div>`;
  const lines = m[1].split('\n').map(l=>l.trim()).filter(Boolean);
  const headers = lines[0].split('||');
  const rows = lines.slice(1).map(l=>l.split('||'));
  return `<table class="findings-table">
    <thead><tr>${headers.map(h=>`<th>${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(r=>`<tr>${r.map((c,i)=>`<td${i===0?' class="fnd-name"':''}>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody>
  </table>`;
}

async function generateNarratives() {
  if (!currentReport) return; showLoading();
  try {
    const d = await api('/reports/'+currentReport.id+'/generate-narratives',{method:'POST'});
    const gen = d.generated || [];
    const nr = document.getElementById('narrativeResults');
    nr.classList.remove('hidden');

    const block = (title, inner) => `
      <div class="gen-section">
        <div class="gen-section__title">${esc(title)}</div>
        <div class="gen-section__body">${inner}</div>
      </div>`;

    const tr = gen.find(s=>s.key==='test_results');
    const fn = gen.find(s=>s.key==='findings');
    const rc = gen.find(s=>s.key==='recommendations');

    let html = `<h4 style="margin-bottom:16px;color:var(--text-heading)">Generated Narrative (run #${d.generationIndex||1})</h4>`;
    if (tr) html += block('Test Results and Interpretation', `<div style="font-size:13px;line-height:1.7;color:var(--text-secondary);white-space:pre-wrap">${esc(tr.content)}</div>`);
    if (fn) html += block('Findings', renderFindingsTable(fn.content));
    if (rc) html += block('Recommendations', `<div style="font-size:13px;line-height:1.7;color:var(--text-secondary);white-space:pre-wrap">${esc(rc.content)}</div>`);
    nr.innerHTML = html;

    document.getElementById('btnToEdit').classList.remove('hidden');
    toast('Narrative generated!');
  } catch(e) {
    if (e.errors && e.errors.length) {
      toast('Validation failed: ' + e.errors.join(' '), 'error');
    } else {
      toast(e.message,'error');
    }
  } hideLoading();
}

// ── Section Editor ──────────────────────────────────────────
async function loadSectionsEditor() {
  if (!currentReport) return;
  try {
    const d = await api('/reports/'+currentReport.id);
    const sections = d.sections||[];

    // Auto-fill Identifying Information if empty
    const idSection = sections.find(s => s.section_key === 'identifying_information');
    if (idSection && !idSection.content) {
      const name = currentReport.client_name || 'N/A';
      const age = currentReport.client_age ? `${currentReport.client_age} years old` : 'N/A';
      const gender = currentReport.client_gender || 'N/A';
      const dob = selectedClient && selectedClient.date_of_birth
        ? new Date(selectedClient.date_of_birth).toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' })
        : 'N/A';
      const address = selectedClient && selectedClient.address ? selectedClient.address : 'N/A';
      const dateOfReport = new Date().toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' });
      const assessDate = currentReport.date_of_assessment
        ? new Date(currentReport.date_of_assessment).toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' })
        : dateOfReport;

      const idContent = `Name: ${name}\nAge: ${age}\nDate of Birth: ${dob}\nSex: ${gender}\nResidential Address: ${address}\nDate of Report: ${dateOfReport}\nDate of Assessment: ${assessDate}`;

      // Save to backend
      try {
        await api('/reports/'+currentReport.id+'/sections/identifying_information', {
          method:'PUT', body:JSON.stringify({ content: idContent })
        });
        idSection.content = idContent;
      } catch(e) { console.warn('Auto-fill identifying info failed:', e); }
    }

    document.getElementById('sectionsEditor').innerHTML = sections
      .filter(s => s.section_key !== 'prepared_approved_by')
      .map(s => `<div class="section-block"><div class="section-header"><h4>${esc(s.section_title)}</h4><span class="save-indicator" id="save-${s.section_key}">${ICON.check} Saved</span></div>
        <div class="section-body"><textarea class="section-textarea" data-key="${s.section_key}" oninput="autoSaveSection(this)">${esc(s.content||'')}</textarea></div></div>`)
      .join('');
  } catch(e) { console.error(e); }
}

let saveTimers = {};
function autoSaveSection(el) {
  const key = el.dataset.key;
  if (saveTimers[key]) clearTimeout(saveTimers[key]);
  saveTimers[key] = setTimeout(async()=>{
    try {
      await api('/reports/'+currentReport.id+'/sections/'+key, {method:'PUT', body:JSON.stringify({content:el.value})});
      const ind = document.getElementById('save-'+key);
      if (ind) { ind.classList.add('show'); setTimeout(()=>ind.classList.remove('show'),2000); }
    } catch(e) { console.error('Autosave error:',e); }
  }, 1500);
}

// ── Submit ──────────────────────────────────────────────────
async function submitReport() {
  if (!currentReport) return;
  if (!confirm('Submit this report for review?')) return;
  showLoading();
  try { await api('/reports/'+currentReport.id+'/submit',{method:'POST'}); toast('Report submitted!'); showView('dashboard'); }
  catch(e) { toast(e.message,'error'); } hideLoading();
}

// ── Report Detail ───────────────────────────────────────────
async function openReport(id) {
  showLoading();
  try {
    const d = await api('/reports/'+id); currentReport = d.report; const r = d.report;
    document.getElementById('detailTitle').textContent = r.client_name;
    document.getElementById('detailSubtitle').innerHTML = `<span class="badge-status badge-${r.status}"><span class="badge-dot"></span>${r.status}</span> &nbsp; ${esc(r.template_name||'')} &nbsp; v${r.current_version}`;
    let btns = '';
    // PDF available for all statuses
    if (USER.role==='clinical_director'||r.psychologist_id===USER.id)
      btns += `<button class="btn btn-primary btn-sm" onclick="downloadPdf(${r.id})">${ICON.download} PDF</button> `;
    if (r.status==='submitted'&&USER.role==='clinical_director')
      btns += `<button class="btn btn-success btn-sm" onclick="showApprovalModal(${r.id})">Review</button> `;
    if (r.status==='approved'&&USER.role==='clinical_director')
      btns += `<button class="btn btn-primary btn-sm" onclick="finalizeRpt(${r.id})">${ICON.lock} Finalize</button> `;
    if ((r.status==='draft'||r.status==='rejected')&&r.psychologist_id===USER.id)
      btns += `<button class="btn btn-primary btn-sm" onclick="editRpt(${r.id})">${ICON.pencil} Edit</button> `;
    // Finalized reports can be re-opened for editing, but only by the Clinical
    // Director. Once viewable/finalized, the Director gets the same three
    // options as a draft: PDF, Edit, and Delete.
    if (r.status==='finalized'&&USER.role==='clinical_director')
      btns += `<button class="btn btn-primary btn-sm" onclick="editRpt(${r.id})">${ICON.pencil} Edit</button> `;
    if (canDeleteReport(r))
      btns += `<button class="btn btn-danger btn-sm" onclick="deleteReport(${r.id})">${ICON.trash} Delete</button> `;
    document.getElementById('detailActions').innerHTML = btns;
    showDetailTab('info',d); showView('detail');
  } catch(e) { toast(e.message,'error'); } hideLoading();
}

function showDetailTab(tab) {
  document.querySelectorAll('#view-detail .tab').forEach(t=>t.classList.remove('active'));
  document.querySelector(`#view-detail .tab[onclick*="${tab}"]`)?.classList.add('active');
  const c = document.getElementById('detailContent'); const r = currentReport;
  if (tab==='info') {
    c.innerHTML = `<div class="card"><div class="form-row"><div class="form-group"><label>Client</label><p>${esc(r.client_name)}</p></div>
      <div class="form-group"><label>Age</label><p>${r.client_age||'N/A'}</p></div></div>
      <div class="form-row"><div class="form-group"><label>Gender</label><p>${esc(r.client_gender||'N/A')}</p></div>
      <div class="form-group"><label>Date</label><p>${fmtDate(r.date_of_assessment)}</p></div></div>
      <div class="form-row"><div class="form-group"><label>Template</label><p>${esc(r.template_name||'')}</p></div>
      <div class="form-group"><label>Psychologist</label><p>${esc(r.psychologist_name||'')}</p></div></div></div>`;
  } else if (tab==='sections') { loadDetailSections(c); }
  else if (tab==='history') { loadDetailVersions(c); }
}

async function loadDetailSections(c) {
  try { const d = await api('/reports/'+currentReport.id); c.innerHTML = (d.sections||[]).map(s=>`<div class="card" style="margin-bottom:12px">
    <h4 style="color:var(--accent-light);margin-bottom:8px;font-size:14px">${esc(s.section_title)}</h4>
    <div style="font-size:13px;line-height:1.7;color:var(--text-secondary);white-space:pre-wrap">${esc(s.content||'(empty)')}</div></div>`).join('');
  } catch(e) { c.innerHTML='<p>Error</p>'; }
}

async function loadDetailVersions(c) {
  try { const d = await api('/reports/'+currentReport.id+'/versions'); const v = d.versions||[];
    if (!v.length) { c.innerHTML='<div class="empty-state"><h4>No versions</h4></div>'; return; }
    c.innerHTML = `<div class="version-timeline">`+v.map(x=>{
      const titles = Array.isArray(x.modified_section_titles) && x.modified_section_titles.length
        ? x.modified_section_titles : [];
      const sectionTag = titles.length
        ? `<span class="v-sections-tag">Modified: ${esc(titles.join(', '))}</span>` : '';
      return `<div class="version-item">
        <div class="v-num">v${x.version_number} ${sectionTag}</div>
        <div class="v-meta">${esc(x.editor_name||'')} — ${fmtDate(x.created_at)}</div>
        <button class="btn btn-ghost btn-sm" style="margin-top:8px" onclick="restoreVersion(${currentReport.id},${x.id})">Restore</button></div>`;
    }).join('')+`</div>`;
  } catch(e) { c.innerHTML='<p>Error</p>'; }
}

// ── Delete Report ───────────────────────────────────────────
// Only the clinical director or the report's creator may delete a report.
function canDeleteReport(r) {
  return !!(USER && (USER.role === 'clinical_director' || (r && r.psychologist_id === USER.id)));
}

async function deleteReport(id) {
  if (!confirm('Move this report to Trash? It can be restored later by the Clinical Director.')) return;
  showLoading();
  try {
    await api('/reports/' + id, { method: 'DELETE' });
    toast('Report moved to Trash.');
    currentReport = null;
    showView('dashboard');
  } catch (e) {
    toast(e.message, 'error');
  }
  hideLoading();
}

async function editRpt(id) {
  showLoading();
  try {
    const d = await api('/reports/' + id);
    currentReport = d.report;
    selectedTemplateId = currentReport.template_id;

    // Reports may be edited while in draft or rejected status; finalized reports
    // remain editable, but only by the Clinical Director.
    const canEditFinalized = currentReport.status === 'finalized' && USER.role === 'clinical_director';
    if (currentReport.status !== 'draft' && currentReport.status !== 'rejected' && !canEditFinalized) {
      toast('Only draft or rejected reports can be edited.', 'error');
      hideLoading();
      return;
    }

    // Make sure templates are loaded (needed for template-type detection) WITHOUT
    // resetting the create form.
    if (!allTemplates.length) {
      try { const t = await api('/report-templates'); allTemplates = t.templates || []; } catch (e) {}
    }

    // Activate the Create view directly. We must NOT call showView('create'),
    // because that runs loadTemplatesForCreate() → resetCreateForm(), which wipes
    // currentReport and jumps back to the template-selection step (the bug where
    // Edit just redirected to the templates).
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    const cv = document.getElementById('view-create');
    if (cv) cv.classList.add('active');

    nextCreateStep(5); // straight to the section editor (loads sections)
  } catch (e) {
    toast(e.message, 'error');
  }
  hideLoading();
}

// ── PDF Preview & E-Signature ───────────────────────────────
let currentPdfBlob = null;
let currentPdfUrl = null;
let currentPdfReportId = null;

async function downloadPdf(id) {
  showLoading();
  try {
    const res = await fetch(API+'/reports/'+id+'/pdf',{headers:{'Authorization':'Bearer '+TOKEN}});
    if (!res.ok) throw new Error('Failed to generate PDF');
    currentPdfBlob = await res.blob();
    currentPdfUrl = URL.createObjectURL(currentPdfBlob);
    currentPdfReportId = id;

    // Show preview modal
    const modal = document.getElementById('pdfPreviewModal');
    const iframe = document.getElementById('pdfPreviewFrame');
    iframe.src = currentPdfUrl;
    modal.classList.add('active');
  } catch(e) { toast(e.message,'error'); } hideLoading();
}

function closePdfPreview() {
  const modal = document.getElementById('pdfPreviewModal');
  modal.classList.remove('active');
  const iframe = document.getElementById('pdfPreviewFrame');
  iframe.src = '';
  // Hide e-sign frame if visible
  document.getElementById('esignContainer').classList.add('hidden');
  document.getElementById('pdfPreviewContainer').classList.remove('hidden');
  if (typeof clearDocusealForm === 'function') clearDocusealForm();
}

function doDownloadPdf() {
  if (!currentPdfUrl) return;
  const a = document.createElement('a');
  a.href = currentPdfUrl;
  a.download = `PsychReport_${currentPdfReportId}.pdf`;
  a.click();
  toast('PDF downloaded!');
}

// ── E-Signature Draw/Upload Modal ───────────────────────────
let signatureCanvas = null;
let signatureCtx = null;
let isDrawing = false;
let signatureStrokes = [];
let currentStroke = [];
let signaturePenColor = '#1a2e1a';
let signaturePenSize = 2;
let uploadedSignatureData = null;
let esignActiveTab = 'draw';

function openEsignModal() {
  if (!currentPdfReportId) return;
  // New flow: open the DocuSeal form builder so the signature can be placed,
  // dragged and resized on the document, then signed.
  launchEsignBuilder();
}

// ── DocuSeal Form Builder flow ──────────────────────────────
let esignTemplateId = null;

async function launchEsignBuilder() {
  showLoading();
  try {
    const res = await fetch(API + '/reports/' + currentPdfReportId + '/esign/builder', {
      method: 'POST',
      headers: headers(),
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.message || 'Failed to open signature builder');

    esignTemplateId = d.template_id;

    // Show the e-sign panel and mount the builder
    document.getElementById('pdfPreviewContainer').classList.add('hidden');
    document.getElementById('esignContainer').classList.remove('hidden');
    setEsignLabel('Drag the Signature field where you want it, then click Save');
    mountDocusealBuilder(d.builder_token);
    toast('Place your signature field on the document, then Save.');
  } catch (e) {
    toast(e.message || 'Failed to open signature builder', 'error');
  }
  hideLoading();
}

function setEsignLabel(text) {
  const el = document.getElementById('esignLabel');
  if (el) el.textContent = text;
}

function mountDocusealBuilder(token) {
  const mount = document.getElementById('esignFrame');
  if (!mount) return;
  mount.innerHTML = '';

  const builder = document.createElement('docuseal-builder');
  builder.id = 'docusealBuilder';
  builder.setAttribute('data-token', token);
  // Single signer role so the placed signature maps to the signing step.
  builder.setAttribute('data-roles', 'Signer');
  // Only offer the signature tool to keep it focused (optional).
  builder.setAttribute('data-only-defined-fields', 'false');
  builder.style.display = 'block';
  builder.style.width = '100%';
  builder.style.minHeight = '70vh';

  // When the user saves the placed field(s), move on to signing.
  const goSign = () => proceedToSigning();
  builder.addEventListener('save', goSign);
  builder.addEventListener('send', goSign);

  mount.appendChild(builder);
}

// Step 2: create a submission from the just-built template and show the
// signing form so the user signs in the field they positioned.
async function proceedToSigning() {
  if (!esignTemplateId) return;
  showLoading();
  try {
    const res = await fetch(API + '/reports/' + currentPdfReportId + '/esign/submission', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ template_id: esignTemplateId }),
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.message || 'Failed to start signing');

    if (d.signing_url) {
      setEsignLabel('Sign the document below');
      mountDocusealForm(d.signing_url);
      toast('Now sign the document.');
    } else {
      throw new Error('No signing URL returned');
    }
  } catch (e) {
    toast(e.message || 'Failed to start signing', 'error');
  }
  hideLoading();
}

function closeEsignModal() {
  document.getElementById('esignDrawModal').classList.remove('active');
}

function switchEsignTab(tab) {
  esignActiveTab = tab;
  document.getElementById('esignTabDraw').classList.toggle('active', tab === 'draw');
  document.getElementById('esignTabUpload').classList.toggle('active', tab === 'upload');
  document.getElementById('esignPanelDraw').classList.toggle('hidden', tab !== 'draw');
  document.getElementById('esignPanelUpload').classList.toggle('hidden', tab !== 'upload');
  if (tab === 'draw') initSignatureCanvas();
  if (tab === 'upload') initUploadZone();
}

// ── Canvas Drawing ──────────────────────────────────────────
function initSignatureCanvas() {
  signatureCanvas = document.getElementById('esignCanvas');
  signatureCtx = signatureCanvas.getContext('2d');

  // Set canvas internal resolution to match display size
  const rect = signatureCanvas.getBoundingClientRect();
  signatureCanvas.width = rect.width * 2;
  signatureCanvas.height = rect.height * 2;
  signatureCtx.scale(2, 2);

  redrawCanvas();

  // Remove old listeners by cloning
  const newCanvas = signatureCanvas.cloneNode(true);
  signatureCanvas.parentNode.replaceChild(newCanvas, signatureCanvas);
  signatureCanvas = newCanvas;
  signatureCtx = signatureCanvas.getContext('2d');
  const r2 = signatureCanvas.getBoundingClientRect();
  signatureCanvas.width = r2.width * 2;
  signatureCanvas.height = r2.height * 2;
  signatureCtx.scale(2, 2);
  redrawCanvas();

  // Mouse events
  signatureCanvas.addEventListener('mousedown', startDraw);
  signatureCanvas.addEventListener('mousemove', draw);
  signatureCanvas.addEventListener('mouseup', endDraw);
  signatureCanvas.addEventListener('mouseleave', endDraw);

  // Touch events
  signatureCanvas.addEventListener('touchstart', (e) => { e.preventDefault(); startDraw(e.touches[0]); }, { passive: false });
  signatureCanvas.addEventListener('touchmove', (e) => { e.preventDefault(); draw(e.touches[0]); }, { passive: false });
  signatureCanvas.addEventListener('touchend', (e) => { e.preventDefault(); endDraw(); }, { passive: false });
}

function getCanvasPos(e) {
  const rect = signatureCanvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left),
    y: (e.clientY - rect.top)
  };
}

function startDraw(e) {
  isDrawing = true;
  currentStroke = [];
  const pos = getCanvasPos(e);
  currentStroke.push({ ...pos, color: signaturePenColor, size: signaturePenSize });
  signatureCtx.beginPath();
  signatureCtx.moveTo(pos.x, pos.y);
  signatureCtx.strokeStyle = signaturePenColor;
  signatureCtx.lineWidth = signaturePenSize;
  signatureCtx.lineCap = 'round';
  signatureCtx.lineJoin = 'round';
}

function draw(e) {
  if (!isDrawing) return;
  const pos = getCanvasPos(e);
  currentStroke.push({ ...pos, color: signaturePenColor, size: signaturePenSize });
  signatureCtx.lineTo(pos.x, pos.y);
  signatureCtx.stroke();
}

function endDraw() {
  if (!isDrawing) return;
  isDrawing = false;
  if (currentStroke.length > 0) {
    signatureStrokes.push([...currentStroke]);
  }
  currentStroke = [];
}

function redrawCanvas() {
  if (!signatureCtx) return;
  const rect = signatureCanvas.getBoundingClientRect();
  signatureCtx.clearRect(0, 0, rect.width, rect.height);

  // Draw guide line
  signatureCtx.save();
  signatureCtx.strokeStyle = '#c5ecd8';
  signatureCtx.lineWidth = 1;
  signatureCtx.setLineDash([4, 4]);
  signatureCtx.beginPath();
  signatureCtx.moveTo(40, rect.height - 50);
  signatureCtx.lineTo(rect.width - 40, rect.height - 50);
  signatureCtx.stroke();
  signatureCtx.setLineDash([]);
  signatureCtx.restore();

  // Redraw strokes
  for (const stroke of signatureStrokes) {
    if (stroke.length < 2) continue;
    signatureCtx.beginPath();
    signatureCtx.moveTo(stroke[0].x, stroke[0].y);
    signatureCtx.strokeStyle = stroke[0].color;
    signatureCtx.lineWidth = stroke[0].size;
    signatureCtx.lineCap = 'round';
    signatureCtx.lineJoin = 'round';
    for (let i = 1; i < stroke.length; i++) {
      signatureCtx.lineTo(stroke[i].x, stroke[i].y);
    }
    signatureCtx.stroke();
  }
}

function clearSignatureCanvas() {
  signatureStrokes = [];
  currentStroke = [];
  redrawCanvas();
}

function undoSignatureStroke() {
  if (signatureStrokes.length === 0) return;
  signatureStrokes.pop();
  redrawCanvas();
}

function setSignatureColor(color, btn) {
  signaturePenColor = color;
  document.querySelectorAll('.esign-color-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
}

function setSignaturePenSize(size) {
  signaturePenSize = parseInt(size);
}

// ── Upload Handling ─────────────────────────────────────────
function initUploadZone() {
  const zone = document.getElementById('esignUploadZone');

  // Drag-and-drop events (use attribute to avoid duplicating)
  if (zone.dataset.initDrag) return;
  zone.dataset.initDrag = '1';

  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) processUploadedFile(file);
  });
}

function handleEsignUpload(e) {
  const file = e.target.files[0];
  if (file) processUploadedFile(file);
  e.target.value = ''; // Reset for re-upload
}

function processUploadedFile(file) {
  if (!file.type.startsWith('image/')) {
    toast('Please upload an image file (PNG, JPG, or SVG)', 'error');
    return;
  }
  if (file.size > 2 * 1024 * 1024) {
    toast('File too large. Maximum size is 2MB.', 'error');
    return;
  }

  const reader = new FileReader();
  reader.onload = (e) => {
    uploadedSignatureData = e.target.result;
    document.getElementById('esignUploadImg').src = uploadedSignatureData;
    document.getElementById('esignUploadZone').classList.add('hidden');
    document.getElementById('esignUploadPreview').classList.remove('hidden');
  };
  reader.readAsDataURL(file);
}

function removeEsignUpload() {
  uploadedSignatureData = null;
  document.getElementById('esignUploadImg').src = '';
  document.getElementById('esignUploadPreview').classList.add('hidden');
  document.getElementById('esignUploadZone').classList.remove('hidden');
}

// ── Apply Signature ─────────────────────────────────────────
async function applySignature() {
  let signatureDataUrl = null;

  if (esignActiveTab === 'draw') {
    // Check if canvas has content
    if (signatureStrokes.length === 0) {
      toast('Please draw your signature first', 'error');
      return;
    }
    signatureDataUrl = signatureCanvas.toDataURL('image/png');
  } else {
    if (!uploadedSignatureData) {
      toast('Please upload a signature image first', 'error');
      return;
    }
    signatureDataUrl = uploadedSignatureData;
  }

  closeEsignModal();
  showLoading();

  try {
    // Send signature to backend to embed in PDF
    const res = await fetch(API + '/reports/' + currentPdfReportId + '/esign', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ signature_image: signatureDataUrl })
    });

    const d = await res.json();
    if (!res.ok) throw new Error(d.message || 'Failed to apply signature');

    if (d.signing_url) {
      // DocuSeal flow — mount the official embedded signing web component.
      // A plain <iframe src> is blocked by DocuSeal's frame headers
      // ("refused to connect"); the <docuseal-form> component is required.
      document.getElementById('pdfPreviewContainer').classList.add('hidden');
      const esignContainer = document.getElementById('esignContainer');
      esignContainer.classList.remove('hidden');
      mountDocusealForm(d.signing_url);
      toast('E-signature form loaded! Sign the document below.');
    } else {
      // Signature was embedded — refresh the PDF preview
      toast('Signature applied successfully!');
      // Re-download and show updated PDF
      try {
        const pdfRes = await fetch(API + '/reports/' + currentPdfReportId + '/pdf', {
          headers: { 'Authorization': 'Bearer ' + TOKEN }
        });
        if (pdfRes.ok) {
          currentPdfBlob = await pdfRes.blob();
          if (currentPdfUrl) URL.revokeObjectURL(currentPdfUrl);
          currentPdfUrl = URL.createObjectURL(currentPdfBlob);
          document.getElementById('pdfPreviewFrame').src = currentPdfUrl;
        }
      } catch (refreshErr) {
        console.warn('PDF refresh failed:', refreshErr);
      }
    }
  } catch (e) {
    toast(e.message || 'Failed to apply signature', 'error');
  }

  hideLoading();

  // Reset state
  signatureStrokes = [];
  currentStroke = [];
  uploadedSignatureData = null;
}

function backToPdfPreview() {
  document.getElementById('esignContainer').classList.add('hidden');
  document.getElementById('pdfPreviewContainer').classList.remove('hidden');
  clearDocusealForm();
}

// ── DocuSeal embedded signing form ──────────────────────────
// Mounts DocuSeal's <docuseal-form> web component (loaded via
// cdn.docuseal.com/js/form.js in psych-reports.html). data-src accepts the
// submitter signing URL (.../s/{slug}) returned by the API as signing_url.
function mountDocusealForm(signingUrl) {
  const mount = document.getElementById('esignFrame');
  if (!mount) return;
  mount.innerHTML = '';

  const form = document.createElement('docuseal-form');
  form.id = 'docusealForm';
  form.setAttribute('data-src', signingUrl);
  form.style.display = 'block';
  form.style.width = '100%';

  // Fired by DocuSeal when the document is fully signed.
  form.addEventListener('completed', async () => {
    toast('Document signed successfully!');
    // Optionally pull the freshly signed copy back into the preview.
    try {
      const pdfRes = await fetch(API + '/reports/' + currentPdfReportId + '/pdf', {
        headers: { 'Authorization': 'Bearer ' + TOKEN }
      });
      if (pdfRes.ok) {
        currentPdfBlob = await pdfRes.blob();
        if (currentPdfUrl) URL.revokeObjectURL(currentPdfUrl);
        currentPdfUrl = URL.createObjectURL(currentPdfBlob);
        document.getElementById('pdfPreviewFrame').src = currentPdfUrl;
      }
    } catch (_) { /* non-fatal */ }
  });

  mount.appendChild(form);
}

function clearDocusealForm() {
  const mount = document.getElementById('esignFrame');
  if (mount) mount.innerHTML = '';
}

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

async function bulkRestoreArchive() {
  const ids = getSelectedArchiveIds();
  if (!ids.length) { toast('No reports selected','error'); return; }
  if (!confirm(`Restore ${ids.length} selected report(s) to the dashboard?`)) return;
  showLoading();
  try {
    for (const id of ids) await api('/reports/'+id+'/unarchive', { method:'POST' });
    toast(`${ids.length} report(s) restored to dashboard.`);
    await loadArchive();
  } catch(e) { toast(e.message,'error'); }
  hideLoading();
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

async function bulkRestoreTrash() {
  const ids = getSelectedTrashIds();
  if (!ids.length) { toast('No reports selected','error'); return; }
  if (!confirm(`Restore ${ids.length} selected report(s)?`)) return;
  showLoading();
  try {
    for (const id of ids) await api('/reports/'+id+'/restore', { method:'POST' });
    toast(`${ids.length} report(s) restored.`);
    await loadTrash();
  } catch(e) { toast(e.message,'error'); }
  hideLoading();
}

async function bulkPermanentDeleteTrash() {
  const ids = getSelectedTrashIds();
  if (!ids.length) { toast('No reports selected','error'); return; }
  if (!confirm(`Permanently delete ${ids.length} selected report(s)? This removes them from the database and cannot be undone.`)) return;
  showLoading();
  try {
    for (const id of ids) await api('/reports/'+id+'/permanent', { method:'DELETE' });
    toast(`${ids.length} report(s) permanently deleted.`);
    await loadTrash();
  } catch(e) { toast(e.message,'error'); }
  hideLoading();
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

async function permanentDeleteReport(id) {
  if (!confirm('Permanently delete this report? This removes it from the database and cannot be undone.')) return;
  showLoading();
  try {
    await api('/reports/'+id+'/permanent', { method:'DELETE' });
    toast('Report permanently deleted.');
    await loadTrash();
  } catch(e) { toast(e.message,'error'); }
  hideLoading();
}

// ── Template Management ─────────────────────────────────────
async function loadManageTemplates() {
  try {
    const d = await api('/report-templates'); allTemplates = d.templates||[];
    document.getElementById('manageTplList').innerHTML = allTemplates.map(t=>`<div class="card" style="margin-bottom:12px">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div><h4 style="color:var(--text-heading)">${esc(t.name)}</h4><p style="font-size:12px;color:var(--text-muted)">${esc(t.template_type)} — ${(t.sections_config||[]).length} sections</p></div>
        <div style="display:flex;gap:8px"><button class="btn btn-outline btn-sm" onclick="editTpl(${t.id})">Edit</button>
          <button class="btn btn-danger btn-sm" onclick="delTpl(${t.id})">Delete</button></div></div></div>`).join('');
  } catch(e) { toast('Error','error'); }
}

function showTplModal(tpl) {
  editingTplId = tpl?tpl.id:null;
  document.getElementById('tplModalTitle').textContent = tpl?'Edit Template':'New Template';
  document.getElementById('tplName').value = tpl?.name||'';
  document.getElementById('tplDesc').value = tpl?.description||'';
  document.getElementById('tplType').value = tpl?.template_type||'neurodevelopmental';
  document.getElementById('tplSections').value = JSON.stringify(tpl?.sections_config||[
    {key:'identifying_information',title:'Identifying Information',required:true},
    {key:'reason_for_referral',title:'Reason for Referral',required:true},
    {key:'test_results',title:'Test Results and Interpretation',required:true},
    {key:'summary',title:'Summary of Findings',required:true},
    {key:'recommendations',title:'Recommendations',required:true},
    {key:'prepared_by',title:'Prepared By',required:true}
  ], null, 2);
  openModal('tplModal');
}

async function editTpl(id) {
  try { const d = await api('/report-templates/'+id); showTplModal(d.template); } catch(e) { toast(e.message,'error'); }
}

async function saveTemplate() {
  const name = document.getElementById('tplName').value.trim();
  let sections; try { sections = JSON.parse(document.getElementById('tplSections').value); } catch(e) { toast('Invalid JSON','error'); return; }
  if (!name) { toast('Name required','error'); return; }
  showLoading();
  try {
    const body = {name,description:document.getElementById('tplDesc').value,template_type:document.getElementById('tplType').value,sections_config:sections};
    if (editingTplId) await api('/report-templates/'+editingTplId,{method:'PUT',body:JSON.stringify(body)});
    else await api('/report-templates',{method:'POST',body:JSON.stringify(body)});
    toast(editingTplId?'Updated!':'Created!'); closeModal('tplModal'); loadManageTemplates();
  } catch(e) { toast(e.message,'error'); } hideLoading();
}

async function delTpl(id) {
  if (!confirm('Delete?')) return;
  try { await api('/report-templates/'+id,{method:'DELETE'}); toast('Deleted'); loadManageTemplates(); }
  catch(e) { toast(e.message,'error'); }
}

// ── Version Modal ───────────────────────────────────────────
async function showVersionModal() {
  if (!currentReport) return;
  try {
    const d = await api('/reports/'+currentReport.id+'/versions'); const v = d.versions||[];
    document.getElementById('versionTimeline').innerHTML = v.length?
      v.map(x=>{
        const titles = Array.isArray(x.modified_section_titles) && x.modified_section_titles.length
          ? x.modified_section_titles : [];
        const sectionTag = titles.length
          ? `<span class="v-sections-tag">Modified: ${esc(titles.join(', '))}</span>` : '';
        return `<div class="version-item">
          <div class="v-num">v${x.version_number} ${sectionTag}</div>
          <div class="v-meta">${esc(x.editor_name||'')} — ${fmtDate(x.created_at)}</div>
          <button class="btn btn-ghost btn-sm" style="margin-top:8px" onclick="restoreVersion(${currentReport.id},${x.id})">Restore</button></div>`;
      }).join('')
      :'<p style="color:var(--text-muted)">No versions yet.</p>';
    openModal('versionModal');
  } catch(e) { toast(e.message,'error'); }
}

async function restoreVersion(rid,vid) {
  if (!confirm('Restore this version?')) return; showLoading();
  try { await api(`/reports/${rid}/versions/${vid}/restore`,{method:'POST'}); toast('Restored!'); closeModal('versionModal'); loadSectionsEditor(); }
  catch(e) { toast(e.message,'error'); } hideLoading();
}

// ── Modal Helpers ───────────────────────────────────────────
function openModal(id) { document.getElementById(id).classList.add('active'); }
function closeModal(id) { document.getElementById(id).classList.remove('active'); }
document.addEventListener('click', e=>{ if(e.target.classList.contains('modal-overlay')) e.target.classList.remove('active'); });

// ── Utilities ───────────────────────────────────────────────
function esc(s) { if(!s)return''; const d=document.createElement('div'); d.textContent=String(s); return d.innerHTML; }
function fmtDate(d) { if(!d)return'N/A'; return new Date(d).toLocaleDateString('en-US',{year:'numeric',month:'short',day:'numeric'}); }
// Date + 24-hour time, e.g. "Jun 7, 2026 14:30" — used for audit log timestamps.
function fmtDateTime(d) {
  if(!d) return 'N/A';
  const dt = new Date(d);
  const date = dt.toLocaleDateString('en-US',{year:'numeric',month:'short',day:'numeric'});
  const time = dt.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',hour12:false});
  return `${date} ${time}`;
}

/* ══════════════════════════════════════════════════════════
   ASSESSMENT DATA STEP — measures, pre-employment tests, dates
   ══════════════════════════════════════════════════════════ */

const PREEMP_TESTS = [
  'MAS Mental Ability Test',
  'Purdue Non-Language Test',
  'Differential Aptitude Test - Fifth Edition',
  'BarOn EQ Inventory: Short Version',
  'Masaklaw na Panukat ng Loob',
  'Basic Personality Inventory',
  'House-Tree-Person Test',
  'Sacks Sentence Completion Test',
  'Mental Status Exam',
];

function currentTemplateType() {
  const t = allTemplates.find(t => t.id === selectedTemplateId);
  return t ? t.template_type : null;
}

// Render the Assessment Data step according to the selected template type.
function renderAssessmentStep() {
  const type = currentTemplateType();
  const isPreEmp = type === 'pre_employment';

  const preemp = document.getElementById('preempBlock');
  if (preemp) preemp.classList.toggle('hidden', !isPreEmp);

  // The free-text "Tests Administered" field is for neuro/clinical only;
  // Pre-Employment uses its own fixed test list with administered dates.
  const testsAdmin = document.getElementById('testsAdminBlock');
  if (testsAdmin) testsAdmin.style.display = isPreEmp ? 'none' : '';

  // Observational Notes / Behavioral Observations / Interview Findings stay
  // visible for ALL templates — they are the basis for the generated narrative.
  // (Neurodevelopmental reports are observation-based: no measure scoring.)

  if (isPreEmp) {
    const tbody = document.querySelector('#preempTable tbody');
    if (tbody && !tbody.dataset.built) {
      tbody.innerHTML = PREEMP_TESTS.map((name, i) => `
        <tr>
          <td>${esc(name)}</td>
          <td>
            <div class="date-field" data-idx="${i}">
              <input type="text" class="form-control date-input" id="pe-date-${i}" readonly placeholder="Select date" onclick="openCalendar(this)">
              <input type="hidden" id="pe-dateval-${i}">
            </div>
          </td>
        </tr>`).join('');
      tbody.dataset.built = '1';
    }
  }
}

/* ── Shared calendar popover (intake-form style) ── */
const _cal = { date: new Date(), target: null, valTarget: null };

function openCalendar(inputEl) {
  _cal.target = inputEl;
  const idx = inputEl.id.replace('pe-date-', '');
  _cal.valTarget = document.getElementById('pe-dateval-' + idx);
  // Anchor popover near the input
  const pop = document.getElementById('calPop');
  const r = inputEl.getBoundingClientRect();
  pop.style.top = (window.scrollY + r.bottom + 6) + 'px';
  pop.style.left = (window.scrollX + r.left) + 'px';
  const existing = _cal.valTarget && _cal.valTarget.value ? new Date(_cal.valTarget.value) : new Date();
  _cal.date = new Date(existing.getFullYear(), existing.getMonth(), 1);
  renderCalendar();
  pop.classList.add('show');
  setTimeout(() => document.addEventListener('click', _calOutside), 0);
}

function _calOutside(e) {
  const pop = document.getElementById('calPop');
  if (!pop.contains(e.target) && e.target !== _cal.target) closeCalendar();
}

function closeCalendar() {
  document.getElementById('calPop').classList.remove('show');
  document.removeEventListener('click', _calOutside);
}

function renderCalendar() {
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const y = _cal.date.getFullYear(), m = _cal.date.getMonth();
  document.getElementById('calTitle').textContent = `${months[m]} ${y}`;
  const first = new Date(y, m, 1).getDay();
  const days = new Date(y, m + 1, 0).getDate();
  let html = '';
  for (let i = 0; i < first; i++) html += '<span class="cal-pop__day cal-pop__day--empty"></span>';
  for (let d = 1; d <= days; d++) {
    html += `<span class="cal-pop__day" onclick="pickDate(${y},${m},${d})">${d}</span>`;
  }
  document.getElementById('calGrid').innerHTML = html;
}

function pickDate(y, m, d) {
  const dt = new Date(y, m, d);
  const readable = dt.toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' });
  const iso = `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  if (_cal.target) _cal.target.value = readable;
  if (_cal.valTarget) _cal.valTarget.value = iso;
  closeCalendar();
}

// Wire calendar nav once DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  const prev = document.getElementById('calPrev');
  const next = document.getElementById('calNext');
  if (prev) prev.addEventListener('click', (e) => { e.stopPropagation(); _cal.date.setMonth(_cal.date.getMonth() - 1); renderCalendar(); });
  if (next) next.addEventListener('click', (e) => { e.stopPropagation(); _cal.date.setMonth(_cal.date.getMonth() + 1); renderCalendar(); });
});

// Collect pre-employment tests + dates from the table.
function collectPreempTests() {
  return PREEMP_TESTS.map((name, i) => {
    const dispEl = document.getElementById('pe-date-' + i);
    return { name, date: dispEl ? dispEl.value.trim() : '' };
  });
}

/* ══════════════════════════════════════════════════════════
   Report Requests (Clinical Director)
   Review → approve/reject, verify payment, and send the report.
   ══════════════════════════════════════════════════════════ */
let RR_DATA = [];
let rrCurrentId = null;

const RR_STATUS_COLORS = {
  'Under Review':      { bg:'#FEF3C7', fg:'#854D0E' },
  'Awaiting Payment':  { bg:'#E0E7FF', fg:'#3730A3' },
  'Payment Submitted': { bg:'#DBEAFE', fg:'#1E40AF' },
  'Payment Verified':  { bg:'#D1FAE5', fg:'#065F46' },
  'Resolved':          { bg:'#DCFCE7', fg:'#166534' },
  'Sent':              { bg:'#E0F2FE', fg:'#075985' },
  'Rejected':          { bg:'#FEE2E2', fg:'#991B1B' },
};
function rrBadge(status) {
  const c = RR_STATUS_COLORS[status] || { bg:'#E5E7EB', fg:'#374151' };
  return `<span style="display:inline-block;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:600;background:${c.bg};color:${c.fg}">${esc(status)}</span>`;
}
function rrFmtDate(d) {
  if (!d) return '—';
  try { return new Date(d).toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'}); }
  catch(e){ return esc(String(d)); }
}

async function refreshReportRequestBadge() {
  try {
    const d = await api('/requests/report-requests');
    const open = (d.data||[]).filter(r => !['Sent','Rejected'].includes(r.status)).length;
    const b = document.getElementById('reportReqBadge');
    if (b) b.textContent = open;
  } catch(e) { /* non-director or unavailable */ }
}

async function loadReportRequests() {
  try {
    const d = await api('/requests/report-requests');
    RR_DATA = d.data || [];
    renderReportRequests();
    refreshReportRequestBadge();
  } catch(e) { toast(e.message||'Failed to load report requests','error'); }
}

function renderReportRequests() {
  const body = document.getElementById('reportReqBody');
  const empty = document.getElementById('emptyReportReqs');
  if (!body) return;
  const q = (document.getElementById('rrSearch')?.value||'').toLowerCase().trim();
  const sf = document.getElementById('rrStatusFilter')?.value||'';
  let rows = RR_DATA.slice();
  if (sf) rows = rows.filter(r => r.status === sf);
  if (q) rows = rows.filter(r =>
    (r.client_name||'').toLowerCase().includes(q) ||
    (r.ticket_number||'').toLowerCase().includes(q));

  if (!rows.length) { body.innerHTML=''; if(empty) empty.classList.remove('hidden'); return; }
  if (empty) empty.classList.add('hidden');

  body.innerHTML = rows.map(r => {
    let actions = '';
    if (r.status === 'Under Review')
      actions += `<button class="btn btn-primary btn-sm" onclick="openRrReview(${r.id})">Review</button> `;
    else if (r.status === 'Payment Submitted')
      // Payment verification was relocated to the Payment Verification module
      // (handled by the Supervising Psychometrician). This section no longer
      // verifies payments — link out instead of opening the in-section modal.
      actions += `<a class="btn btn-outline btn-sm" href="payments-admin.html" title="Report-request payments are verified by the Supervising Psychometrician in the Payment Verification module">Verify in Payment Verification</a> `;
    else if (r.status === 'Payment Verified' || r.status === 'Resolved')
      actions += `<button class="btn btn-success btn-sm" onclick="rrSend(${r.id})">Send</button> `;
    else if (r.status === 'Sent')
      actions += `<button class="btn btn-outline btn-sm" onclick="openRrReview(${r.id})">View</button> `;
    else
      actions += `<button class="btn btn-outline btn-sm" onclick="openRrReview(${r.id})">View</button> `;
    return `<tr>
      <td>${esc(r.client_name||'—')}</td>
      <td>${esc(r.ticket_number||'—')}</td>
      <td>${esc(r.request_type||'—')}</td>
      <td>${rrFmtDate(r.date_submitted)}</td>
      <td>${rrBadge(r.status)}</td>
      <td class="col-actions">${actions}</td>
    </tr>`;
  }).join('');
}

// Build a labelled read-only field row.
function rrField(label, value) {
  return `<div style="display:flex;gap:10px;padding:7px 0;border-bottom:1px solid #eef1f6">
    <div style="min-width:160px;color:#64748b;font-size:13px">${esc(label)}</div>
    <div style="flex:1;font-size:13.5px;color:#1f2937">${value||'—'}</div></div>`;
}

async function openRrReview(id) {
  showLoading();
  try {
    const d = await api('/requests/'+id);
    const r = d.data; rrCurrentId = id;
    const fullName = [r.client_given_name, r.client_mi, r.client_family_name].filter(Boolean).join(' ');
    let concerns = '';
    try { const c = Array.isArray(r.concerns)?r.concerns:JSON.parse(r.concerns||'[]'); concerns = c.map(esc).join(', '); } catch(e){}
    let html = '';
    html += rrField('Reference Number', `<b>${esc(r.ticket_number)}</b>`);
    html += rrField('Status', rrBadge(r.report_request_status));
    html += rrField('Request Type', esc(r.request_type_label||r.nature));
    html += rrField('Client (account)', esc(r.client_account_name||''));
    html += rrField('Client Name (on form)', esc(fullName));
    html += rrField('Parent / Guardian', esc(r.guardian_name));
    html += rrField('Date of Assessment', r.assessment_date?rrFmtDate(r.assessment_date):'—');
    html += rrField('Contact Number', esc(r.contact_number));
    html += rrField('Center & Branch', esc(r.center_branch));
    if (concerns) html += rrField('Concerns', esc(concerns));
    if (r.concern_other) html += rrField('Other Concern', esc(r.concern_other));
    html += rrField('Brief Description', esc(r.description));
    html += rrField('Attached File', r.has_attachment
      ? `<a href="#" onclick="rrOpenFile(${id},'attachment');return false">${esc(r.attachment_name||'View attachment')}</a>` : 'None');
    if (r.report_request_status === 'Rejected' && r.rejection_reason)
      html += rrField('Rejection Reason', esc(r.rejection_reason));
    document.getElementById('rrReviewBody').innerHTML = html;

    // Actions: approve/reject only while Under Review.
    const wrap = document.getElementById('rrRejectReasonWrap');
    wrap.style.display = 'none';
    document.getElementById('rrRejectReason').value = '';
    const act = document.getElementById('rrReviewActions');
    if (r.report_request_status === 'Under Review') {
      act.innerHTML =
        `<button class="btn btn-success" onclick="rrApproveRequest(${id})">Approve</button>
         <button class="btn btn-danger" onclick="rrToggleReject()">Reject</button>
         <button class="btn btn-outline" onclick="closeModal('rrReviewModal')">Cancel</button>`;
    } else {
      act.innerHTML = `<button class="btn btn-outline" onclick="closeModal('rrReviewModal')">Close</button>`;
    }
    openModal('rrReviewModal');
  } catch(e) { toast(e.message,'error'); }
  hideLoading();
}

function rrToggleReject() {
  const wrap = document.getElementById('rrRejectReasonWrap');
  const showing = wrap.style.display !== 'none';
  if (!showing) {
    wrap.style.display = 'block';
    document.getElementById('rrReviewActions').innerHTML =
      `<button class="btn btn-danger" onclick="rrRejectRequest(${rrCurrentId})">Confirm Rejection</button>
       <button class="btn btn-outline" onclick="closeModal('rrReviewModal')">Cancel</button>`;
  }
}

async function rrApproveRequest(id) {
  showLoading();
  try {
    await api('/requests/'+id+'/review',{method:'PUT',body:JSON.stringify({action:'approve'})});
    toast('Request approved — client moved to payment.');
    closeModal('rrReviewModal'); loadReportRequests();
  } catch(e){ toast(e.message,'error'); } hideLoading();
}

async function rrRejectRequest(id) {
  const reason = (document.getElementById('rrRejectReason').value||'').trim();
  if (!reason) { toast('A reason is required to reject.','error'); return; }
  showLoading();
  try {
    await api('/requests/'+id+'/review',{method:'PUT',body:JSON.stringify({action:'reject',reason})});
    toast('Request rejected.');
    closeModal('rrReviewModal'); loadReportRequests();
  } catch(e){ toast(e.message,'error'); } hideLoading();
}

async function openRrPayment(id) {
  showLoading();
  try {
    const d = await api('/requests/'+id);
    const r = d.data; rrCurrentId = id;
    const fullName = [r.client_given_name, r.client_mi, r.client_family_name].filter(Boolean).join(' ');
    let html = '';
    html += `<div style="font-weight:600;margin:4px 0 6px;color:#15306E">Client Information</div>`;
    html += rrField('Client (account)', esc(r.client_account_name||''));
    html += rrField('Client Name', esc(fullName));
    html += rrField('Contact Number', esc(r.contact_number));
    html += `<div style="font-weight:600;margin:14px 0 6px;color:#15306E">Request Information</div>`;
    html += rrField('Reference Number', `<b>${esc(r.ticket_number)}</b>`);
    html += rrField('Request Type', esc(r.request_type_label||r.nature));
    html += `<div style="font-weight:600;margin:14px 0 6px;color:#15306E">Payment Details</div>`;
    html += rrField('Amount', r.payment_amount!=null?('\u20b1'+Number(r.payment_amount).toFixed(2)):'—');
    html += rrField('Reference', esc(r.payment_reference));
    html += rrField('Payment Status', esc(r.payment_status));
    html += `<div style="font-weight:600;margin:14px 0 6px;color:#15306E">Uploaded Proof of Payment</div>`;
    html += `<div id="rrProofWrap" style="padding:6px 0">Loading proof…</div>`;
    document.getElementById('rrPaymentBody').innerHTML = html;

    const wrap = document.getElementById('rrPayRejectReasonWrap');
    wrap.style.display = 'none';
    document.getElementById('rrPayRejectReason').value = '';
    document.getElementById('rrPaymentActions').innerHTML =
      `<button class="btn btn-success" onclick="rrApprovePayment(${id})">Approve Payment</button>
       <button class="btn btn-danger" onclick="rrTogglePayReject()">Reject Payment</button>
       <button class="btn btn-outline" onclick="closeModal('rrPaymentModal')">Cancel</button>`;
    openModal('rrPaymentModal');
    // Load proof async
    rrLoadProof(id);
  } catch(e) { toast(e.message,'error'); }
  hideLoading();
}

async function rrLoadProof(id) {
  const el = document.getElementById('rrProofWrap');
  try {
    const d = await api('/requests/'+id+'/file?type=proof');
    const { name, dataUrl } = d.data || {};
    if (!dataUrl) { el.textContent = 'No proof uploaded.'; return; }
    if (dataUrl.startsWith('data:image')) {
      el.innerHTML = `<img src="${dataUrl}" alt="proof" style="max-width:100%;border:1px solid #e2e8f0;border-radius:8px"/>
        <div style="margin-top:6px"><a href="${dataUrl}" download="${esc(name||'proof')}">Download</a></div>`;
    } else {
      el.innerHTML = `<a href="${dataUrl}" target="_blank" download="${esc(name||'proof')}">Open ${esc(name||'proof of payment')}</a>`;
    }
  } catch(e) { el.textContent = 'Could not load proof: '+e.message; }
}

function rrTogglePayReject() {
  const wrap = document.getElementById('rrPayRejectReasonWrap');
  if (wrap.style.display === 'none') {
    wrap.style.display = 'block';
    document.getElementById('rrPaymentActions').innerHTML =
      `<button class="btn btn-danger" onclick="rrRejectPayment(${rrCurrentId})">Confirm Rejection</button>
       <button class="btn btn-outline" onclick="closeModal('rrPaymentModal')">Cancel</button>`;
  }
}

async function rrApprovePayment(id) {
  showLoading();
  try {
    await api('/requests/'+id+'/payment-verify',{method:'PUT',body:JSON.stringify({action:'approve'})});
    toast('Payment verified — receipt issued to client.');
    closeModal('rrPaymentModal'); loadReportRequests();
  } catch(e){ toast(e.message,'error'); } hideLoading();
}

async function rrRejectPayment(id) {
  const note = (document.getElementById('rrPayRejectReason').value||'').trim();
  if (!note) { toast('A reason is required to reject a payment.','error'); return; }
  showLoading();
  try {
    await api('/requests/'+id+'/payment-verify',{method:'PUT',body:JSON.stringify({action:'reject',note})});
    toast('Payment rejected — client asked to re-upload.');
    closeModal('rrPaymentModal'); loadReportRequests();
  } catch(e){ toast(e.message,'error'); } hideLoading();
}

async function rrSend(id) {
  window.location.href = 'request-send.html?id=' + id;
}

async function rrOpenFile(id, type) {
  try {
    const d = await api('/requests/'+id+'/file?type='+type);
    const { name, dataUrl } = d.data || {};
    if (!dataUrl) { toast('File not found','error'); return; }
    const w = window.open();
    if (w) w.document.write(`<title>${esc(name||'file')}</title><iframe src="${dataUrl}" style="border:0;width:100%;height:100%"></iframe>`);
  } catch(e){ toast(e.message,'error'); }
}

/* ══════════════════════════════════════════════════════════
   REPORT CONCERNS — Clinical Director console
   Mirrors the Report-Requests logic for nature='report_concern':
   investigate → request info → resolve (revise/maintain) / reject,
   with an in-browser PDF editor and full report versioning.
   ══════════════════════════════════════════════════════════ */
let RC_DATA = [];
let rcCurrentId = null;
let rcCurrentRow = null;

const RC_STATUS_COLORS = {
  'Pending Review':         { bg:'#FEF3C7', fg:'#854D0E' },
  'Under Investigation':    { bg:'#DBEAFE', fg:'#1E40AF' },
  'Client Action Required': { bg:'#FFE4E6', fg:'#9F1239' },
  'Resolved':               { bg:'#DCFCE7', fg:'#166534' },
  'Rejected':               { bg:'#FEE2E2', fg:'#991B1B' },
};
function rcBadge(status) {
  const c = RC_STATUS_COLORS[status] || { bg:'#E5E7EB', fg:'#374151' };
  return `<span style="display:inline-block;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:600;background:${c.bg};color:${c.fg}">${esc(status)}</span>`;
}

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
    let actions = closed
      ? `<button class="btn btn-outline btn-sm" onclick="openRcReview(${r.id})">View</button> `
      : `<button class="btn btn-primary btn-sm" onclick="openRcReview(${r.id})">Review</button> `;
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

// ── Review modal ────────────────────────────────────────────
async function openRcReview(id) {
  showLoading();
  try {
    const d = await api('/requests/'+id);
    const r = d.data; rcCurrentId = id; rcCurrentRow = r;
    const fullName = [r.client_given_name, r.client_mi, r.client_family_name].filter(Boolean).join(' ');
    let concerns = '';
    try { const c = Array.isArray(r.concerns)?r.concerns:JSON.parse(r.concerns||'[]'); concerns = c.map(esc).join(', '); } catch(e){}

    let html = '';
    html += `<div style="font-weight:600;margin:2px 0 6px;color:#15306E">Client Information</div>`;
    html += rrField('Client Name', esc(fullName || r.client_account_name || ''));
    html += rrField('Reference Number', `<b>${esc(r.ticket_number)}</b>`);
    html += rrField('Report Date', r.assessment_date?rrFmtDate(r.assessment_date):'—');
    html += rrField('Report Version', esc(String(r.report_version||1)));
    html += `<div style="font-weight:600;margin:14px 0 6px;color:#15306E">Concern Information</div>`;
    html += rrField('Status', rcBadge(r.concern_status));
    html += rrField('Concern Type', esc(concerns || 'Report Concern'));
    if (r.concern_other) html += rrField('Other Concern', esc(r.concern_other));
    html += rrField('Description', esc(r.description));
    html += rrField('Attached File', r.has_attachment
      ? `<a href="#" onclick="rrOpenFile(${id},'attachment');return false">${esc(r.attachment_name||'View attachment')}</a>` : 'None');
    if (r.concern_info_request)
      html += rrField('Info Requested', esc(r.concern_info_request));
    if (r.concern_status === 'Resolved') {
      if (r.concern_resolution_note) html += rrField('Resolution Note', esc(r.concern_resolution_note));
      if (r.concern_review_note && !r.concern_resolution_note) html += rrField('Review Note', esc(r.concern_review_note));
    }
    if (r.concern_status === 'Rejected' && r.concern_rejection_reason)
      html += rrField('Rejection Reason', esc(r.concern_rejection_reason));
    document.getElementById('rcReviewBody').innerHTML = html;

    // Reset panels.
    ['rcInfoWrap','rcResolveWrap','rcRejectWrap'].forEach(idp => document.getElementById(idp).style.display='none');
    document.getElementById('rcInfoText').value='';
    document.getElementById('rcResolveNote').value='';
    document.getElementById('rcRejectReason').value='';

    const act = document.getElementById('rcReviewActions');
    if (['Resolved','Rejected'].includes(r.concern_status)) {
      act.innerHTML = `<button class="btn btn-outline" onclick="closeModal('rcReviewModal')">Close</button>`;
    } else {
      let btns = '';
      if (r.concern_status === 'Pending Review')
        btns += `<button class="btn btn-primary" onclick="rcInvestigate(${id})">Mark Under Investigation</button>`;
      btns += `<button class="btn btn-outline" onclick="rcEditReport(${id})">Edit Report</button>`;
      btns += `<button class="btn btn-outline" onclick="rcToggle('rcInfoWrap')">Request Additional Information</button>`;
      btns += `<button class="btn btn-success" onclick="rcShowResolve()">Resolve Concern</button>`;
      btns += `<button class="btn btn-danger" onclick="rcToggle('rcRejectWrap')">Reject Concern</button>`;
      btns += `<button class="btn btn-outline" onclick="closeModal('rcReviewModal')">Cancel</button>`;
      act.innerHTML = btns;
    }
    openModal('rcReviewModal');
  } catch(e) { toast(e.message,'error'); }
  hideLoading();
}

function rcToggle(wrapId) {
  ['rcInfoWrap','rcResolveWrap','rcRejectWrap'].forEach(idp => {
    document.getElementById(idp).style.display = (idp===wrapId) ? 'block' : 'none';
  });
  const act = document.getElementById('rcReviewActions');
  if (wrapId === 'rcInfoWrap') {
    act.innerHTML = `<button class="btn btn-primary" onclick="rcRequestInfo(${rcCurrentId})">Send Request</button>
      <button class="btn btn-outline" onclick="openRcReview(${rcCurrentId})">Back</button>`;
  } else if (wrapId === 'rcRejectWrap') {
    act.innerHTML = `<button class="btn btn-danger" onclick="rcReject(${rcCurrentId})">Confirm Rejection</button>
      <button class="btn btn-outline" onclick="openRcReview(${rcCurrentId})">Back</button>`;
  }
}

// Resolve: offer Revise (needs an edited version) vs Maintain (needs a note),
// based on the concern type. Findings/recommendations concerns expose both.
let rcResolveNoteRequired = true;
function rcShowResolve() {
  const r = rcCurrentRow || {};
  let list = [];
  try { list = Array.isArray(r.concerns)?r.concerns:JSON.parse(r.concerns||'[]'); } catch(e){}
  const low = list.map(s => String(s).toLowerCase());
  const hasFindings = low.some(s => s.includes('findings') || s.includes('diagnosis'));
  const hasRecs = low.some(s => s.includes('recommendation'));
  const hasCorrection = low.some(s =>
    s.includes('misspelled') || s.includes('birthday') || s.includes('age') ||
    s.includes('address') || s.includes('missing'));
  const wrap = document.getElementById('rcResolveWrap');
  wrap.style.display = 'block';
  document.getElementById('rcInfoWrap').style.display='none';
  document.getElementById('rcRejectWrap').style.display='none';
  const label = document.getElementById('rcResolveLabel');
  const act = document.getElementById('rcReviewActions');

  if (hasFindings || hasRecs) {
    // Two clinical options (spec §§8-9): revise (new version) or maintain (note).
    rcResolveNoteRequired = false; // only required for the "maintain" path
    label.innerHTML = 'Review note (required when keeping the report unchanged)';
    act.innerHTML =
      `<button class="btn btn-success" onclick="rcResolve(${rcCurrentId},'revise')">Resolve with Revised Report</button>
       <button class="btn btn-primary" onclick="rcResolve(${rcCurrentId},'maintain')">Resolve & Maintain (with note)</button>
       <button class="btn btn-outline" onclick="openRcReview(${rcCurrentId})">Back</button>`;
  } else if (hasCorrection) {
    // Correction concerns (spec §§4-7): a corrected report version IS the
    // resolution; the note is optional context.
    rcResolveNoteRequired = false;
    label.innerHTML = 'Resolution note (optional)';
    act.innerHTML =
      `<button class="btn btn-success" onclick="rcResolve(${rcCurrentId},'revise')">Confirm Resolution</button>
       <button class="btn btn-outline" onclick="openRcReview(${rcCurrentId})">Back</button>`;
  } else {
    // "Other" concerns (spec §10): resolution note is mandatory.
    rcResolveNoteRequired = true;
    label.innerHTML = 'Resolution note <span style="color:#b42318">*</span>';
    act.innerHTML =
      `<button class="btn btn-success" onclick="rcResolve(${rcCurrentId},'')">Confirm Resolution</button>
       <button class="btn btn-outline" onclick="openRcReview(${rcCurrentId})">Back</button>`;
  }
}

async function rcInvestigate(id) {
  showLoading();
  try {
    await api('/requests/'+id+'/concern-review',{method:'PUT',body:JSON.stringify({action:'investigate'})});
    toast('Concern marked under investigation.');
    closeModal('rcReviewModal'); loadReportConcerns();
  } catch(e){ toast(e.message,'error'); } hideLoading();
}

async function rcRequestInfo(id) {
  const info = (document.getElementById('rcInfoText').value||'').trim();
  if (!info) { toast('Please specify the information being requested.','error'); return; }
  showLoading();
  try {
    await api('/requests/'+id+'/concern-review',{method:'PUT',body:JSON.stringify({action:'request_info',info})});
    toast('Additional information requested from the client.');
    closeModal('rcReviewModal'); loadReportConcerns();
  } catch(e){ toast(e.message,'error'); } hideLoading();
}

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

async function rcResolve(id, decision) {
  const note = (document.getElementById('rcResolveNote').value||'').trim();
  // A note is mandatory for "maintain" decisions and for "Other"-only concerns.
  if ((decision === 'maintain' || rcResolveNoteRequired) && !note) {
    toast('A resolution / review note is required.','error'); return;
  }
  showLoading();
  try {
    await api('/requests/'+id+'/concern-review',{method:'PUT',
      body:JSON.stringify({action:'resolve',decision:decision||undefined,resolutionNote:note})});
    toast('Concern resolved — client notified.');
    closeModal('rcReviewModal'); loadReportConcerns();
  } catch(e){ toast(e.message,'error'); } hideLoading();
}

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
        '<div style="color:#64748b;padding:12px">No report versions yet. Use “Edit Report” in the review modal to create one.</div>';
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
   Renders pages with pdf.js, lets the director drop text and
   white-out boxes, then exports a flattened PDF with pdf-lib
   and saves it as a NEW report version.
   ══════════════════════════════════════════════════════════ */
let pdfEd = {
  id: null, srcBytes: null, pdfDoc: null,
  tool: 'text', edits: [], scale: 1.5, pageViewports: [],
};

// ── Edit Report (concern) — "Edit Report Sections" style editor ──────────────
// Opens a pop-up mirroring the staff "Edit Report Sections" editor, but shows
// only the Identifying Information section. The Director edits it, can "Check
// PDF" to preview, and "Save Version" to store a corrected report version —
// which then enables Resolve Concern → Resolve with Revised Report.

// Standard report sections shown in the concern edit modal (comprehensive set
// covering all three template types). The Director fills/edits what is relevant.
const RC_DEFAULT_SECTIONS = [
  { key: 'identifying_information',   title: 'Identifying Information' },
  { key: 'reason_for_referral',       title: 'Reason for Referral' },
  { key: 'background_history',        title: 'Background / History' },
  { key: 'behavioral_observations',   title: 'Behavioral Observations and Mental Status Exam' },
  { key: 'assessment_tools',          title: 'Assessment Tools / Procedures' },
  { key: 'results_interpretation',    title: 'Results and Interpretation' },
  { key: 'findings_formulation',      title: 'Findings / Summary Formulation' },
  { key: 'recommendations',           title: 'Recommendations' },
  { key: 'prepared_approved_by',      title: 'Prepared By and Approved By' },
];

// Stores the Director's edits across sections for the current concern: key → text.
const rcSectionCache = {};   // concernId -> { sectionKey: text, … }

function rcIdentPrefill(row) {
  const fullName = [row.client_given_name, row.client_mi, row.client_family_name]
    .filter(Boolean).join(' ').trim() || row.client_account_name || 'N/A';
  const today = new Date().toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' });
  const assess = row.assessment_date
    ? new Date(row.assessment_date).toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' })
    : today;
  const branch = row.center_branch || 'N/A';
  const guardian = row.guardian_name ? `\nGuardian: ${row.guardian_name}` : '';
  return [
    `Name: ${fullName}`,
    `Age: N/A`,
    `Date of Birth: N/A`,
    `Sex: N/A`,
    `Residential Address: N/A`,
    `Center / Branch: ${branch}`,
    `Date of Report: ${today}`,
    `Date of Assessment: ${assess}`,
  ].join('\n') + guardian;
}

async function rcEditReport(id) {
  rcCurrentId = id;
  if (!rcCurrentRow || rcCurrentRow.id !== id) {
    try { const d = await api('/requests/'+id); rcCurrentRow = d.data; } catch(e){}
  }
  const row = rcCurrentRow || { id };
  document.getElementById('rcEditTitle').textContent =
    'Edit Report Sections — ' + (row.ticket_number || ('#'+id));

  // Restore any previous edits for this concern, or seed Identifying Information.
  const saved = rcSectionCache[id] || {};
  const container = document.getElementById('rcSectionsContainer');
  container.innerHTML = RC_DEFAULT_SECTIONS.filter(sec => sec.key !== 'prepared_approved_by').map(sec => {
    let content = saved[sec.key] !== undefined
      ? saved[sec.key]
      : (sec.key === 'identifying_information' ? rcIdentPrefill(row) : '');
    const escaped = content.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    return `<div class="section-block" style="margin-bottom:12px;">
      <div class="section-header"><h4>${sec.title}</h4></div>
      <div class="section-body">
        <textarea class="section-textarea" data-rc-key="${sec.key}" rows="5" style="min-height:100px">${escaped}</textarea>
      </div>
    </div>`;
  }).join('');

  document.getElementById('rcEditModal').classList.add('active');
}

function rcCloseEdit() {
  document.getElementById('rcEditModal').classList.remove('active');
}

// Collect all section values from the edit modal and cache them.
function rcCollectSections() {
  const out = {};
  document.querySelectorAll('#rcSectionsContainer [data-rc-key]').forEach(ta => {
    out[ta.dataset.rcKey] = ta.value;
  });
  if (rcCurrentId) rcSectionCache[rcCurrentId] = out;
  return out;
}

// Build a corrected-report PDF from all report sections.
async function rcBuildSectionsPdf(sections, row) {
  const { PDFDocument, rgb, StandardFonts } = window.PDFLib;
  const doc = await PDFDocument.create();
  let page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const margin = 60;
  const lineH = 16;
  const bodySize = 10;
  const maxW = 612 - margin * 2;
  let y = 792 - margin;

  function ensurePage(needed) {
    if (y < margin + needed) {
      page = doc.addPage([612, 792]);
      y = 792 - margin;
    }
  }

  // Header
  page.drawText('PSYCHOLOGICAL ASSESSMENT REPORT', { x: margin, y, size: 15, font: bold, color: rgb(0.08,0.18,0.42) });
  y -= 20;
  page.drawText('Corrected Copy', { x: margin, y, size: 9, font, color: rgb(0.45,0.45,0.5) });
  y -= 8;
  page.drawLine({ start:{x:margin,y}, end:{x:612-margin,y}, thickness:1, color:rgb(0.8,0.82,0.88) });
  y -= 20;

  // Word-wrap helper (simple greedy)
  function wrapText(text, f, size, maxPx) {
    const words = String(text || '').split(' ');
    const lines = [];
    let cur = '';
    for (const w of words) {
      const test = cur ? cur + ' ' + w : w;
      if (f.widthOfTextAtSize(test, size) <= maxPx) {
        cur = test;
      } else {
        if (cur) lines.push(cur);
        cur = w;
      }
    }
    if (cur) lines.push(cur);
    return lines;
  }

  for (const sec of RC_DEFAULT_SECTIONS) {
    const content = (sections[sec.key] || '').trim();
    if (!content && sec.key !== 'identifying_information') continue;

    ensurePage(40);
    page.drawText(sec.title.toUpperCase(), { x: margin, y, size: 10, font: bold, color: rgb(0.08,0.18,0.42) });
    y -= 6;
    page.drawLine({ start:{x:margin,y}, end:{x:margin+maxW*0.5,y}, thickness:0.5, color:rgb(0.75,0.78,0.88) });
    y -= 14;

    // Split by newlines, then word-wrap each line
    const rawLines = content.split('\n');
    for (const raw of rawLines) {
      if (!raw.trim()) { y -= lineH * 0.5; continue; }
      const wrapped = wrapText(raw, font, bodySize, maxW);
      for (const wl of wrapped) {
        ensurePage(lineH + 4);
        const colon = wl.indexOf(':');
        if (sec.key === 'identifying_information' && colon > -1) {
          const lbl = wl.slice(0, colon + 1);
          const val = wl.slice(colon + 1);
          page.drawText(lbl, { x: margin, y, size: bodySize, font: bold, color: rgb(0.2,0.2,0.25) });
          const lw = bold.widthOfTextAtSize(lbl, bodySize);
          if (val.trim()) page.drawText(val, { x: margin + lw + 4, y, size: bodySize, font, color: rgb(0.12,0.12,0.15) });
        } else {
          page.drawText(wl, { x: margin, y, size: bodySize, font, color: rgb(0.12,0.12,0.15) });
        }
        y -= lineH;
      }
    }
    y -= 12;
  }

  // Footer
  const footerY = margin - 18;
  doc.getPages().forEach(pg => {
    pg.drawText(
      `Reference: ${row.ticket_number || ''}   ·   Generated ${new Date().toLocaleString()}`,
      { x: margin, y: footerY, size: 7, font, color: rgb(0.55,0.55,0.6) }
    );
  });

  return await doc.save();
}

async function rcBuildIdentDataUrl() {
  if (!window.PDFLib) { toast('PDF engine still loading — try again.','error'); return null; }
  const sections = rcCollectSections();
  const bytes = await rcBuildSectionsPdf(sections, rcCurrentRow || { id: rcCurrentId });
  let bin = ''; const chunk = 0x8000;
  for (let i=0;i<bytes.length;i+=chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i+chunk));
  return 'data:application/pdf;base64,' + btoa(bin);
}

// "Check PDF" — preview the corrected report as it will look.
async function rcCheckPdf() {
  showLoading();
  try {
    const dataUrl = await rcBuildIdentDataUrl();
    if (!dataUrl) { hideLoading(); return; }
    const w = window.open();
    if (w) w.document.write(`<title>Corrected Report Preview</title><iframe src="${dataUrl}" style="border:0;position:fixed;inset:0;width:100%;height:100%"></iframe>`);
    else toast('Allow pop-ups to preview the PDF.','error');
  } catch(e) { toast('Could not build preview: '+e.message,'error'); }
  hideLoading();
}

// "Save Version" — store the corrected report as a new version, enabling
// Resolve Concern → Resolve with Revised Report.
async function rcSaveVersionFromSections() {
  showLoading();
  try {
    const dataUrl = await rcBuildIdentDataUrl();
    if (!dataUrl) { hideLoading(); return; }
    const editedSections = Object.entries(rcSectionCache[rcCurrentId]||{})
      .filter(([,v])=>v.trim()).map(([k])=>k.replace(/_/g,' ')).join(', ') || 'report sections';
    const r = await api('/requests/'+rcCurrentId+'/concern-version',{method:'POST',
      body:JSON.stringify({ file:dataUrl, filename:'report_corrected.pdf', changeNote:`Corrected: ${editedSections}` })});
    toast('Saved as report version '+(r.data?.version_number||'')+'. You can now Resolve with Revised Report.');
    rcCloseEdit();
    loadReportConcerns();
    // Re-open the review modal so the Director can resolve immediately.
    if (rcCurrentId) openRcReview(rcCurrentId);
  } catch(e) { toast('Could not save: '+e.message,'error'); }
  hideLoading();
}

// (Legacy pdf.js annotation editor retained below but no longer used by concerns.)
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
    const txt = prompt('Enter text to add:');
    if (!txt) return;
    const el = document.createElement('div');
    el.className = 'pdfed-textnote';
    el.contentEditable = 'true';
    el.textContent = txt;
    el.style.cssText = `position:absolute;left:${x}px;top:${y}px;font:14px/1.2 Arial;color:#111;background:transparent;min-width:20px;padding:1px 2px;border:1px dashed #1E3A8A`;
    wrap.appendChild(el);
    pdfEd.edits.push({ type:'text', page:pageNum, x, y, el });
  } else {
    // White-out: drag-free fixed box the director can resize via handles.
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

async function pdfEditorSave() {
  if (!pdfEd.srcBytes) { toast('Open a PDF first.','error'); return; }
  if (!window.PDFLib) { toast('PDF writer still loading — try again.','error'); return; }
  const note = prompt('Describe what changed in this version:', 'Corrected report');
  if (note === null) return;
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
    // Re-open the review modal so the director can now Resolve.
    if (rcCurrentId) openRcReview(rcCurrentId);
    loadReportConcerns();
  } catch(e) { toast('Could not save: '+e.message,'error'); }
  hideLoading();
}
