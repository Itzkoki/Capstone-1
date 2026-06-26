/* ══════════════════════════════════════════════════════════
   PSYGEN — Core: globals, API helper, auth init, navigation
   ══════════════════════════════════════════════════════════ */

const API = 'http://localhost:5000/api';
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

const TPL_ICONS = {
  neurodevelopmental: '<svg viewBox="0 0 24 24" width="24" height="24" fill="var(--primary)"><path d="M13 1.07V9h7c0-4.08-3.05-7.44-7-7.93zM4 15c0 4.42 3.58 8 8 8s8-3.58 8-8v-4H4v4zm7-13.93C7.05 1.56 4 4.92 4 9h7V1.07z"/></svg>',
  clinical: '<svg viewBox="0 0 24 24" width="24" height="24" fill="var(--primary)"><path d="M19 3H5c-1.1 0-1.99.9-1.99 2L3 19c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-1 11h-4v4h-4v-4H6v-4h4V6h4v4h4v4z"/></svg>',
  pre_employment: '<svg viewBox="0 0 24 24" width="24" height="24" fill="var(--primary)"><path d="M20 6h-4V4c0-1.11-.89-2-2-2h-4c-1.11 0-2 .89-2 2v2H4c-1.11 0-1.99.89-1.99 2L2 19c0 1.11.89 2 2 2h16c1.11 0 2-.89 2-2V8c0-1.11-.89-2-2-2zm-6 0h-4V4h4v2z"/></svg>',
  default: '<svg viewBox="0 0 24 24" width="24" height="24" fill="var(--primary)"><path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm4 18H6V4h7v5h5v11z"/></svg>'
};

// Psychometricians are intentionally excluded — they have NO access to the Report Module.
const ALLOWED_ROLES = ['supervising_psychometrician', 'qc_psychometrician', 'psychologist', 'clinical_director'];

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
  if (!TOKEN) { window.location.href = 'login.html'; return; }

  try {
    const storedUser = JSON.parse(sessionStorage.getItem('bps_user') || '{}');
    if (storedUser && storedUser.role) USER = storedUser;
  } catch(e) {}

  if (!USER || !USER.role) {
    try {
      const payload = JSON.parse(atob(TOKEN.split('.')[1]));
      USER = { id: payload.id, role: payload.role, full_name: payload.full_name || payload.email || 'User' };
    } catch(e) { window.location.href = 'login.html'; return; }
  }

  if (!ALLOWED_ROLES.includes(USER.role)) {
    toast('Access denied. Insufficient permissions.', 'error');
    setTimeout(() => { window.location.href = 'admin-dashboard.html'; }, 1500);
    return;
  }

  try {
    const d = await api('/profile');
    const profile = d.profile || d.user || d;
    if (profile.role) USER = { ...USER, ...profile };
  } catch(e) { console.warn('Profile fetch skipped:', e.message); }

  document.getElementById('userName').textContent = USER.full_name||USER.email||'User';
  document.getElementById('userRole').textContent = (USER.role||'').replace(/_/g,' ');
  document.getElementById('userAvatar').innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z"/></svg>';
  if (USER.role==='clinical_director') document.getElementById('directorNav').classList.remove('hidden');
  if (USER.role==='clinical_director') { try { await refreshReportRequestBadge(); } catch(e){} }
  if (USER.role==='clinical_director') { try { await refreshReportConcernBadge(); } catch(e){} }
  // QC Psychometricians (and base psychometricians) may not create reports —
  // hide the "New Report" entry points entirely.
  if (USER.role==='psychometrician' || USER.role==='qc_psychometrician') {
    const n = document.getElementById('nav-new-report');
    const b = document.getElementById('btn-new-report');
    if (n) n.style.display = 'none';
    if (b) b.style.display = 'none';
  }

  var hash = (location.hash || '').replace('#','');
  if (hash && document.getElementById('view-' + hash)) { showView(hash); return; }

  var params = new URLSearchParams(location.search);

  // Clear URL params immediately so refreshing always returns to My Reports dashboard.
  if (location.search) history.replaceState({}, '', location.pathname);

  // If a specific report is requested via ?reportId=N, open it directly.
  var reportId = params.get('reportId');
  if (reportId && reportId !== 'null' && reportId !== 'undefined') {
    await openReport(parseInt(reportId, 10)); return;
  }

  // If ?create=1 is passed (from case-dashboard "Create Report" button):
  // check if the case already has a draft/Prepared report — if so open it, otherwise start the create wizard.
  if (params.get('create') === '1') {
    var caseIdParam = params.get('caseId') || null;
    window._caseLockedTemplateType = null; // reset on every create entry
    if (caseIdParam) {
      window._pendingCaseId = caseIdParam;
      try {
        var caseData = await api('/cases/' + encodeURIComponent(caseIdParam));
        var caseDetail = caseData.data || caseData;
        // Open any active report for this case (draft, Prepared, Review, or Approved)
        var existingDraft = (caseDetail.reports || []).find(function(r) {
          return ['draft','Prepared','Review','Approved'].indexOf(r.status) !== -1;
        });
        if (existingDraft) { await openReport(existingDraft.id); return; }

        // Determine which report template type the client's assessment maps to,
        // so the create wizard can lock the selection to the correct type.
        var aif = caseDetail.assessment_intake_forms && caseDetail.assessment_intake_forms[0];
        var referral = (aif && aif.reason_for_referral) || '';
        var REFERRAL_TYPE_MAP = {
          'neurodevelopmental assessment': 'neurodevelopmental',
          'clinical assessment':           'clinical',
          'pre-employment/neuropsychological': 'pre_employment',
        };
        var lockedType = REFERRAL_TYPE_MAP[referral.toLowerCase()] || '';
        window._caseLockedTemplateType = lockedType || null;
      } catch(e) { /* ignore — proceed to create */ }
    }
    await loadTemplatesForCreate();
    return;
  }

  // No URL params — show My Reports dashboard.
  showView('dashboard');
});


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
  // Report creation is not permitted for QC / base psychometricians.
  if (name === 'create' && (USER.role === 'qc_psychometrician' || USER.role === 'psychometrician')) {
    toast('You do not have permission to create reports.', 'error');
    name = 'dashboard';
  }
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
  const v = document.getElementById('view-'+name);
  if (v) v.classList.add('active');
  const n = document.querySelector(`.nav-item[data-view="${name}"]`);
  if (n) n.classList.add('active');
  if (name==='dashboard') loadDashboard();
  else if (name==='create') loadTemplatesForCreate();
  else if (name==='reviews') loadPendingReviews();
  else if (name==='reportRequests') loadReportRequests();
  else if (name==='reportConcerns') loadReportConcerns();
  else if (name==='legacyVerifications') loadLegacyVerifications();
  else if (name==='audit') loadAuditLogs();
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