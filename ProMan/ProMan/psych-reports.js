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

// Allowed roles for this module
const ALLOWED_ROLES = ['psychologist', 'clinical_director'];

function headers() { return { 'Content-Type':'application/json','Authorization':'Bearer '+TOKEN }; }

async function api(path, opts={}) {
  const res = await fetch(API+path, { headers: headers(), ...opts });
  if (res.headers.get('content-type')?.includes('application/pdf')) return res;
  const data = await res.json();
  if (!res.ok) throw new Error(data.message||'Request failed');
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
  await loadDashboard();
});

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
  else if (name==='audit') loadAuditLogs();
  else if (name==='manageTpl') loadManageTemplates();
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
  if (!reports.length) { b.innerHTML=''; e.classList.remove('hidden'); return; }
  e.classList.add('hidden');
  b.innerHTML = reports.map(r=>`<tr class="report-row" onclick="openReport(${r.id})">
    <td><strong>${esc(r.client_name)}</strong></td>
    <td>${esc(r.template_name||r.template_type||'')}</td>
    <td><span class="badge-status badge-${r.status}"><span class="badge-dot"></span>${r.status}</span></td>
    <td>${fmtDate(r.created_at)}</td>
    <td><button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();openReport(${r.id})">View</button>
    <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();downloadPdf(${r.id})">PDF</button></td>
  </tr>`).join('');
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
  ['cTests', 'cObsNotes', 'cBehObs', 'cInterview'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });

  // Step 4: Test scores
  const scoresList = document.getElementById('scoresList');
  if (scoresList) scoresList.innerHTML = '';
  const emptyScores = document.getElementById('emptyScores');
  if (emptyScores) emptyScores.classList.remove('hidden');
  const addScoreForm = document.getElementById('addScoreForm');
  if (addScoreForm) addScoreForm.classList.add('hidden');
  ['sTestName', 'sRaw', 'sPercentile', 'sStandard', 'sNotes'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const sCat = document.getElementById('sCategory');
  if (sCat) sCat.value = '';
  const sRange = document.getElementById('sRange');
  if (sRange) sRange.value = '';

  // Step 5: Narrative results
  const narrativeResults = document.getElementById('narrativeResults');
  if (narrativeResults) { narrativeResults.innerHTML = ''; narrativeResults.classList.add('hidden'); }
  const btnToEdit = document.getElementById('btnToEdit');
  if (btnToEdit) btnToEdit.classList.add('hidden');

  // Step 6: Section editor
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
  if (n===6) loadSectionsEditor();
}

// ── Intake Client Integration ───────────────────────────────
async function loadIntakeClients() {
  try {
    const d = await api('/reports/intake-clients');
    intakeClients = d.clients || [];
    const sel = document.getElementById('cClientSelect');
    sel.innerHTML = '<option value="">— Select a client —</option>' +
      intakeClients.map((c,i) => `<option value="${i}">${esc(c.full_name || c.account_name || 'Unknown')} — ${esc(c.email || c.account_email || '')} (Intake #${c.intake_id})</option>`).join('');
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
    })}); currentReport = d.report; toast('Report created!'); nextCreateStep(3);
  } catch(e) { toast(e.message,'error'); } hideLoading();
}

async function saveAssessmentStep() {
  if (!currentReport) return; showLoading();
  try {
    const tests = document.getElementById('cTests').value.split(',').map(t=>t.trim()).filter(Boolean);
    await api('/reports/'+currentReport.id+'/assessment', { method:'POST', body:JSON.stringify({
      tests_administered: tests, observational_notes: document.getElementById('cObsNotes').value,
      behavioral_observations: document.getElementById('cBehObs').value, interview_findings: document.getElementById('cInterview').value
    })});
    // Auto-populate the assessment section if tests were entered
    if (tests.length) {
      // Find the assessment-related section key from this report's sections
      const reportData = await api('/reports/'+currentReport.id);
      const sections = reportData.sections || [];
      const assessmentSection = sections.find(s =>
        ['assessment_methods','assessment_battery','assessment_tests_methods','assessment_tools_procedure'].includes(s.section_key)
      );
      if (assessmentSection) {
        await api('/reports/'+currentReport.id+'/sections/'+assessmentSection.section_key, { method:'PUT', body:JSON.stringify({
          content: (assessmentSection.content ? assessmentSection.content + '\n\n' : '') +
            'The following assessment instruments were administered:\n\n'+tests.map((t,i)=>`${i+1}. ${t}`).join('\n')
        })});
      }
    }
    toast('Assessment data saved!'); nextCreateStep(4); renderScoresList();
  } catch(e) { toast(e.message,'error'); } hideLoading();
}

// ── Test Scores ─────────────────────────────────────────────
function showAddScoreForm() { document.getElementById('addScoreForm').classList.remove('hidden'); }
function hideAddScoreForm() { document.getElementById('addScoreForm').classList.add('hidden'); }

async function addTestScore() {
  if (!currentReport) return;
  const tn = document.getElementById('sTestName').value.trim();
  const tc = document.getElementById('sCategory').value;
  if (!tn||!tc) { toast('Test name and category required','error'); return; }
  showLoading();
  try {
    await api('/reports/'+currentReport.id+'/scores', { method:'POST', body:JSON.stringify({
      test_name:tn, test_category:tc, raw_score:parseFloat(document.getElementById('sRaw').value)||null,
      percentile_score:parseFloat(document.getElementById('sPercentile').value)||null,
      standard_score:parseFloat(document.getElementById('sStandard').value)||null,
      descriptive_range:document.getElementById('sRange').value||null,
      interpretation_notes:document.getElementById('sNotes').value
    })}); toast('Score added!');
    ['sTestName','sRaw','sPercentile','sStandard','sNotes'].forEach(id=>document.getElementById(id).value='');
    document.getElementById('sCategory').value=''; document.getElementById('sRange').value='';
    hideAddScoreForm(); await renderScoresList();
  } catch(e) { toast(e.message,'error'); } hideLoading();
}

async function renderScoresList() {
  if (!currentReport) return;
  try {
    const d = await api('/reports/'+currentReport.id);
    const scores = d.testScores||[]; const c = document.getElementById('scoresList'); const e = document.getElementById('emptyScores');
    if (!scores.length) { c.innerHTML=''; e.classList.remove('hidden'); return; }
    e.classList.add('hidden');
    c.innerHTML = `<div style="display:grid;grid-template-columns:2fr 1fr 1fr 1fr 1fr auto;gap:12px;padding:8px 16px;font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;font-weight:600">
      <span>Test</span><span>Category</span><span>Raw</span><span>%ile</span><span>Std</span><span></span></div>`+
      scores.map(s=>`<div class="score-item"><span>${esc(s.test_name)}</span><span class="section-tag" style="width:fit-content">${esc(s.test_category||'')}</span>
        <span class="score-val">${s.raw_score??'-'}</span><span class="score-val">${s.percentile_score??'-'}</span>
        <span class="score-val">${s.standard_score??'-'}</span>
        <button class="btn btn-ghost btn-sm" onclick="deleteScore(${s.id})" style="color:var(--danger)">✕</button></div>`).join('');
  } catch(e) { console.error(e); }
}

async function deleteScore(id) {
  if (!currentReport) return;
  try { await api(`/reports/${currentReport.id}/scores/${id}`,{method:'DELETE'}); toast('Removed'); await renderScoresList(); }
  catch(e) { toast(e.message,'error'); }
}

// ── Narrative Generation ────────────────────────────────────
async function generateNarratives() {
  if (!currentReport) return; showLoading();
  try {
    const d = await api('/reports/'+currentReport.id+'/generate-narratives',{method:'POST'});
    const narrs = d.narratives||[]; const nr = document.getElementById('narrativeResults');
    nr.classList.remove('hidden');
    nr.innerHTML = `<h4 style="margin-bottom:16px;color:var(--text-heading)">Generated ${narrs.length} Narratives</h4>`+
      narrs.map(n=>`<div style="padding:12px;margin-bottom:8px;background:var(--bg-glass);border-radius:8px;border:1px solid var(--border)">
        <div style="font-size:11px;color:var(--accent-light);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px">${esc(n.section_key)} — ${esc(n.rule_id)}</div>
        <div style="font-size:13px;line-height:1.6;color:var(--text-secondary)">${esc(n.narrative_text).substring(0,300)}...</div></div>`).join('');
    document.getElementById('btnToEdit').classList.remove('hidden'); toast(`Generated ${narrs.length} narratives!`);
  } catch(e) { toast(e.message,'error'); } hideLoading();
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

    document.getElementById('sectionsEditor').innerHTML = sections.map(s=>`
      <div class="section-block"><div class="section-header"><h4>${esc(s.section_title)}</h4><span class="save-indicator" id="save-${s.section_key}">✓ Saved</span></div>
        <div class="section-body"><textarea class="section-textarea" data-key="${s.section_key}" oninput="autoSaveSection(this)">${esc(s.content||'')}</textarea></div></div>`).join('');
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
      btns += `<button class="btn btn-primary btn-sm" onclick="downloadPdf(${r.id})">📥 PDF</button> `;
    if (r.status==='submitted'&&USER.role==='clinical_director')
      btns += `<button class="btn btn-success btn-sm" onclick="showApprovalModal(${r.id})">Review</button> `;
    if (r.status==='approved'&&USER.role==='clinical_director')
      btns += `<button class="btn btn-primary btn-sm" onclick="finalizeRpt(${r.id})">🔒 Finalize</button> `;
    if ((r.status==='draft'||r.status==='rejected')&&r.psychologist_id===USER.id)
      btns += `<button class="btn btn-primary btn-sm" onclick="editRpt(${r.id})">✏️ Edit</button> `;
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
  else if (tab==='scores') { loadDetailScores(c); }
  else if (tab==='history') { loadDetailVersions(c); }
}

async function loadDetailSections(c) {
  try { const d = await api('/reports/'+currentReport.id); c.innerHTML = (d.sections||[]).map(s=>`<div class="card" style="margin-bottom:12px">
    <h4 style="color:var(--accent-light);margin-bottom:8px;font-size:14px">${esc(s.section_title)}</h4>
    <div style="font-size:13px;line-height:1.7;color:var(--text-secondary);white-space:pre-wrap">${esc(s.content||'(empty)')}</div></div>`).join('');
  } catch(e) { c.innerHTML='<p>Error</p>'; }
}

async function loadDetailScores(c) {
  try { const d = await api('/reports/'+currentReport.id); const sc = d.testScores||[];
    if (!sc.length) { c.innerHTML='<div class="empty-state"><h4>No scores</h4></div>'; return; }
    c.innerHTML = `<div class="card"><table class="report-table"><thead><tr><th>Test</th><th>Category</th><th>Raw</th><th>%ile</th><th>Standard</th><th>Range</th></tr></thead><tbody>`+
      sc.map(s=>`<tr><td>${esc(s.test_name)}</td><td>${esc(s.test_category||'')}</td><td>${s.raw_score??'-'}</td><td>${s.percentile_score??'-'}</td><td>${s.standard_score??'-'}</td><td>${esc(s.descriptive_range||'-')}</td></tr>`).join('')+`</tbody></table></div>`;
  } catch(e) { c.innerHTML='<p>Error</p>'; }
}

async function loadDetailVersions(c) {
  try { const d = await api('/reports/'+currentReport.id+'/versions'); const v = d.versions||[];
    if (!v.length) { c.innerHTML='<div class="empty-state"><h4>No versions</h4></div>'; return; }
    c.innerHTML = `<div class="version-timeline">`+v.map(x=>`<div class="version-item"><div class="v-num">v${x.version_number}</div>
      <div class="v-meta">${esc(x.editor_name||'')} — ${fmtDate(x.created_at)}</div>
      <div class="v-changes">${esc(x.change_summary||'')}</div>
      <button class="btn btn-ghost btn-sm" style="margin-top:8px" onclick="restoreVersion(${currentReport.id},${x.id})">Restore</button></div>`).join('')+`</div>`;
  } catch(e) { c.innerHTML='<p>Error</p>'; }
}

function editRpt(id) {
  api('/reports/'+id).then(d=>{ currentReport=d.report; selectedTemplateId=currentReport.template_id; showView('create'); nextCreateStep(6); });
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
  const modal = document.getElementById('esignDrawModal');
  modal.classList.add('active');
  switchEsignTab('draw');
  initSignatureCanvas();
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
      // DocuSeal flow — show embedded signing
      document.getElementById('pdfPreviewContainer').classList.add('hidden');
      const esignContainer = document.getElementById('esignContainer');
      esignContainer.classList.remove('hidden');
      const esignFrame = document.getElementById('esignFrame');
      esignFrame.src = d.signing_url;
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

async function finalizeRpt(id) {
  if (!confirm('Finalize? Report will be locked.')) return; showLoading();
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
      <td>${fmtDate(l.created_at)}</td><td>${esc(l.user_name||'System')}</td>
      <td><span class="audit-action ${l.action}">${l.action}</span></td>
      <td>${esc(l.details||'')}</td><td style="font-size:11px">${esc(l.ip_address||'')}</td></tr>`).join('');
  } catch(e) { toast('Error','error'); }
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
      v.map(x=>`<div class="version-item"><div class="v-num">v${x.version_number}</div>
        <div class="v-meta">${esc(x.editor_name||'')} — ${fmtDate(x.created_at)}</div>
        <div class="v-changes">${esc(x.change_summary||'')}</div>
        <button class="btn btn-ghost btn-sm" style="margin-top:8px" onclick="restoreVersion(${currentReport.id},${x.id})">Restore</button></div>`).join('')
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
