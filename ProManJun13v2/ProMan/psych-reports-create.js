/* ══════════════════════════════════════════════════════════
   PSYGEN — Create: wizard steps, templates, section editor
   ══════════════════════════════════════════════════════════ */

// ── Inline Validation Feedback ──────────────────────────────
function _showFieldError(fieldId, msg) {
  const el = document.getElementById(fieldId);
  const msgEl = document.getElementById('val-' + fieldId);
  if (el) el.classList.add('input-error');
  if (msgEl) { msgEl.textContent = msg; msgEl.classList.add('visible'); }
}
function _clearFieldErrors() {
  ['cObsNotes','cBehObs','cInterview'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.remove('input-error');
    const msgEl = document.getElementById('val-' + id);
    if (msgEl) { msgEl.textContent = ''; msgEl.classList.remove('visible'); }
  });
}

// ── Client-side assessment validation (mirrors server RuleEngine) ───────────
const _PE_KEYBOARD = ['qwerty','asdfgh','zxcvbn','qazwsx','123456','abcdef'];
const _PE_PLACEHOLDER = new Set(['test','testing','sample','tbd','na','none','ok','yes','no','placeholder','draft','pending','unknown','lorem','ipsum','asd','xxx','zzz','abc','null','undefined','todo']);
function _looksRealWord(w) {
  if (w.length < 2) return false;
  if (w.length <= 3) return /[aeiou]/.test(w);
  if (!/[aeiouy]/.test(w)) return false;
  if (/(.)\1\1/.test(w)) return false;
  if (/[^aeiouy]{5,}/.test(w)) return false;
  const vc = (w.match(/[aeiouy]/g) || []).length;
  const r = vc / w.length;
  return r >= 0.2 && r <= 0.8;
}
// Returns '' if valid, otherwise an error message.
function validateAssessmentText(raw) {
  const v = String(raw || '').trim();
  if (!v) return 'This field is required. Please provide clinical observations.';
  const lower = v.toLowerCase();
  const noSpaces = v.replace(/\s+/g, '');
  if (/^(.)\1{3,}$/.test(noSpaces)) return 'Entry appears to be repeated characters. Please write meaningful observations.';
  if (/^[^a-zA-Z0-9\s]+$/.test(v)) return 'Entry contains only symbols. Please provide descriptive text.';
  if (/^\d+$/.test(noSpaces)) return 'Entry contains only numbers. Please describe observations in sentences.';
  for (const kp of _PE_KEYBOARD) { if (lower.replace(/\s/g,'').includes(kp)) return 'Entry appears to contain a keyboard pattern. Please provide meaningful observations.'; }
  const stripped = lower.replace(/[^a-z0-9\s]/g,'').trim();
  if (_PE_PLACEHOLDER.has(stripped)) return 'Entry appears to be placeholder text. Please provide specific observations.';
  const words = v.split(/\s+/).filter(Boolean);
  if (words.length < 5) return 'Entry is too brief. Please provide at least 5 words describing clinical findings.';
  const alphaWords = words.map(w => w.toLowerCase().replace(/[^a-z]/g,'')).filter(w => w.length >= 2);
  if (alphaWords.length >= 3) {
    const real = alphaWords.filter(_looksRealWord);
    if (real.length / alphaWords.length < 0.5) return 'Entry does not appear to contain meaningful words. Please describe actual observations in readable sentences.';
    const uniq = new Set(alphaWords);
    if (alphaWords.length >= 4 && uniq.size <= 2 && real.length < alphaWords.length) return 'Entry appears to repeat the same token. Please provide a varied, meaningful description.';
  }
  return '';
}
// Validates the three observational fields; shows inline errors. Returns boolean.
function validateAssessmentInputsClient() {
  _clearFieldErrors();
  const fields = [
    ['cObsNotes', 'Observational Notes'],
    ['cBehObs', 'Behavioral Observations'],
    ['cInterview', 'Interview Findings'],
  ];
  let ok = true;
  fields.forEach(([id]) => {
    const el = document.getElementById(id);
    const msg = validateAssessmentText(el ? el.value : '');
    if (msg) { _showFieldError(id, msg); ok = false; }
  });
  return ok;
}

function clearAssessmentInputs() {
  ['cObsNotes', 'cBehObs', 'cInterview'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  _clearFieldErrors();
  const peBody = document.querySelector('#preempTable tbody');
  if (peBody) { peBody.innerHTML = ''; delete peBody.dataset.built; }
}

function resetCreateForm() {
  currentReport = null;
  selectedClient = null;
  selectedTemplateId = null;

  const clientSelect = document.getElementById('cClientSelect');
  if (clientSelect) clientSelect.value = '';
  const clientPreview = document.getElementById('clientInfoPreview');
  if (clientPreview) clientPreview.classList.add('hidden');
  const assessDate = document.getElementById('cAssessDate');
  if (assessDate) assessDate.value = '';

  clearAssessmentInputs();

  const narrativeResults = document.getElementById('narrativeResults');
  if (narrativeResults) { narrativeResults.innerHTML = ''; narrativeResults.classList.add('hidden'); }
  const btnToEdit = document.getElementById('btnToEdit');
  if (btnToEdit) btnToEdit.classList.add('hidden');

  const sectionsEditor = document.getElementById('sectionsEditor');
  if (sectionsEditor) sectionsEditor.innerHTML = '';

  Object.keys(saveTimers).forEach(k => { clearTimeout(saveTimers[k]); delete saveTimers[k]; });
}

async function loadTemplatesForCreate() {
  resetCreateForm();
  try {
    const d = await api('/report-templates'); allTemplates = d.templates||[];
    document.getElementById('btnTplNext').disabled = true;
    renderTemplateCards('templateGrid', true);
    // Auto-select the template that matches the case's assessment type.
    const lockedType = window._caseLockedTemplateType;
    if (lockedType) {
      const match = allTemplates.find(t => t.template_type === lockedType);
      if (match) selectTemplate(match.id);
    }
    nextCreateStep(1);
  } catch(e) { toast('Failed to load templates','error'); }
}

async function loadTemplatesView() {
  try { const d = await api('/report-templates'); allTemplates = d.templates||[]; renderTemplateCards('viewTemplateGrid', false); }
  catch(e) { toast('Failed to load templates','error'); }
}

function renderTemplateCards(cid, selectable) {
  const c = document.getElementById(cid);
  const lockedType = window._caseLockedTemplateType;
  c.innerHTML = allTemplates.map(t=>{
    const secs = (t.sections_config||[]).slice(0,5);
    const iconSvg = TPL_ICONS[t.template_type] || TPL_ICONS.default;
    const isLocked = selectable && lockedType && t.template_type !== lockedType;
    const clickAttr = selectable && !isLocked ? `onclick="selectTemplate(${t.id})"` : '';
    return `<div class="template-card${selectedTemplateId===t.id?' selected':''}${isLocked?' tpl-locked':''}" ${clickAttr}>
      <div class="tpl-icon">${iconSvg}</div>
      <h4>${esc(t.name)}</h4><p>${esc(t.description||'')}</p>
      ${isLocked ? '<p class="tpl-locked-note">Not applicable for this case</p>' : ''}
      <div class="section-tags">${secs.map(s=>`<span class="section-tag">${esc(s.title)}</span>`).join('')}</div></div>`;
  }).join('');
}

function selectTemplate(id) {
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
  document.querySelectorAll('#createStepper .circle-step').forEach((s,i)=>{
    s.classList.remove('active','completed');
    if (i+1<n) s.classList.add('completed');
    if (i+1===n) s.classList.add('active');
  });
  if (n===2) {
    mountAssessmentCalendar();
    loadIntakeClients();
  }
  if (n===3) { renderAssessmentStep(); }
  if (n===5) {
    loadSectionsEditor();
    // Label the final action per role: psychologists save a draft (solo flow),
    // supervising psychometricians submit to QC, everyone else submits for review.
    var role = USER && USER.role;
    var lbl = (role === 'psychologist') ? 'Save'
            : (role === 'clinical_director') ? 'Save'
            : (role === 'supervising_psychometrician') ? 'Submit to QC'
            : 'Submit for Review';
    var lblTop = document.getElementById('submitBtnLabel');
    var lblBot = document.getElementById('submitBtnLabelBottom');
    if (lblTop) lblTop.textContent = lbl;
    if (lblBot) lblBot.textContent = lbl;
  }
}

// ── Date of Assessment calendar (system calendar layout) ────
// Uses the shared BPSCalendar widget restricted to today-or-earlier so a
// future assessment date can never be chosen.
let assessCal = null;
function mountAssessmentCalendar() {
  const container = document.getElementById('cAssessCal');
  if (!container || typeof BPSCalendar === 'undefined') return;
  if (assessCal) return; // already mounted
  assessCal = BPSCalendar.mount('#cAssessCal', {
    showTime: false,
    minDate: new Date(2000, 0, 1),   // allow past dates
    maxDate: new Date(),             // no future dates
    startDate: new Date(),           // open on the current month
    onChange: (iso) => {
      const hidden = document.getElementById('cAssessDate');
      if (hidden) hidden.value = iso || '';
      const err = document.getElementById('err-cAssessDate');
      if (err) err.style.display = 'none';
    },
  });
}

// ── Intake Client Integration ───────────────────────────────
async function loadIntakeClients() {
  try {
    const d = await api('/reports/intake-clients');
    // Report generation applies to Assessments only — counseling forms are excluded.
    intakeClients = (d.clients || []).filter(c => c.form_type === 'assessment');
    const sel = document.getElementById('cClientSelect');
    if (!intakeClients.length) {
      sel.innerHTML = '<option value="">— No assessment clients available —</option>';
      return;
    }
    sel.innerHTML = '<option value="">— Select a client —</option>' +
      intakeClients.map((c,i) => {
        const caseLabel = c.case_id || `Intake #${c.intake_id}`;
        const tag = `${caseLabel} · Assessment`;
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

  // Validate Date of Assessment — required and never in the future.
  const assessDate = document.getElementById('cAssessDate').value;
  const errEl = document.getElementById('err-cAssessDate');
  if (!assessDate) {
    if (errEl) { errEl.textContent = 'Please select the Date of Assessment.'; errEl.style.display = 'block'; }
    toast('Please select the Date of Assessment.', 'error');
    return;
  }
  const today = new Date(); today.setHours(0,0,0,0);
  const picked = new Date(assessDate); picked.setHours(0,0,0,0);
  if (picked > today) {
    if (errEl) { errEl.textContent = 'The Date of Assessment cannot be in the future.'; errEl.style.display = 'block'; }
    toast('The Date of Assessment cannot be in the future.', 'error');
    return;
  }

  showLoading();
  try {
    const payload = {
      template_id: selectedTemplateId,
      client_name: selectedClient.full_name || selectedClient.account_name,
      client_age: selectedClient.age || null,
      client_gender: selectedClient.gender || null,
      date_of_assessment: document.getElementById('cAssessDate').value || null,
      // Bind the report to the client (and their case) so it reflects in Case
      // Management and can be released to the exact client later.
      client_id: selectedClient.user_id || null,
      case_id: window._pendingCaseId || selectedClient.case_id || null,
    };
    const d = await api('/reports', { method:'POST', body:JSON.stringify(payload)});
    // The report object may be null if psychologist_id points to staff table — fall back to section data
    currentReport = d.report || (d.sections && d.sections.length ? { id: d.sections[0].report_id } : null);
    clearAssessmentInputs();
    toast('Report created!'); nextCreateStep(3);
  } catch(e) { toast(e.message,'error'); } hideLoading();
}

async function saveAssessmentStep() {
  if (!currentReport) return;
  // Client-side validation first — block invalid/empty assessment data.
  if (!validateAssessmentInputsClient()) {
    toast('Please correct the highlighted assessment fields before continuing.', 'error');
    return;
  }
  showLoading();
  try {
    const type = currentTemplateType();

    if (type === 'pre_employment') {
      const peTests = collectPreempTests();
      // Date Administered is required for every pre-employment test.
      const missingDate = peTests.find(t => t.name && (!t.date || t.date === '—'));
      if (missingDate) {
        hideLoading();
        toast(`Please select a Date Administered for "${missingDate.name}".`, 'error');
        return;
      }
      await api('/reports/'+currentReport.id+'/assessment', { method:'POST', body:JSON.stringify({
        tests_administered: [],
        observational_notes: document.getElementById('cObsNotes').value,
        behavioral_observations: document.getElementById('cBehObs').value,
        interview_findings: document.getElementById('cInterview').value,
        additional_data: { preemp_tests: peTests }
      })});

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
      await api('/reports/'+currentReport.id+'/assessment', { method:'POST', body:JSON.stringify({
        tests_administered: [],
        observational_notes: document.getElementById('cObsNotes').value,
        behavioral_observations: document.getElementById('cBehObs').value,
        interview_findings: document.getElementById('cInterview').value,
        additional_data: {}
      })});
    }
    toast('Assessment data saved!'); nextCreateStep(4);
  } catch(e) {
    // Surface server-side validation errors inline on the relevant fields
    if (e.errors && Array.isArray(e.errors)) {
      const fieldMap = {
        'Observational Notes':     'cObsNotes',
        'Behavioral Observations': 'cBehObs',
        'Interview Findings':      'cInterview',
      };
      let shown = false;
      e.errors.forEach(msg => {
        for (const [label, fid] of Object.entries(fieldMap)) {
          if (msg.startsWith(label + ':')) {
            _showFieldError(fid, msg.slice(label.length + 1).trim());
            shown = true;
          }
        }
      });
      if (!shown) toast(e.errors.join(' | '), 'error');
      else toast('Please correct the highlighted fields before continuing.', 'error');
    } else {
      toast(e.message || 'Failed to save assessment data.', 'error');
    }
  }
  hideLoading();
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
  if (!currentReport) return;
  // Server-side validation (generate-narratives) is the authoritative guard that
  // blocks generation when stored assessment data is missing or invalid.
  showLoading();
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
    if (e.errors && Array.isArray(e.errors) && e.errors.length) {
      // Show inline field errors if they map to known field labels
      const fieldMap = {
        'Observational Notes':     'cObsNotes',
        'Behavioral Observations': 'cBehObs',
        'Interview Findings':      'cInterview',
      };
      let shown = false;
      e.errors.forEach(msg => {
        for (const [label, fid] of Object.entries(fieldMap)) {
          if (msg.startsWith(label + ':')) {
            _showFieldError(fid, msg.slice(label.length + 1).trim());
            shown = true;
          }
        }
      });
      toast((shown ? 'Input validation failed. ' : '') + 'Please review: ' + e.errors[0], 'error');
    } else {
      toast(e.message || 'Failed to generate narratives.', 'error');
    }
  }
  hideLoading();
}

// ── Section Editor ──────────────────────────────────────────
async function loadSectionsEditor() {
  if (!currentReport) return;
  try {
    const d = await api('/reports/'+currentReport.id);
    const sections = d.sections||[];

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

      try {
        await api('/reports/'+currentReport.id+'/sections/identifying_information', {
          method:'PUT', body:JSON.stringify({ content: idContent })
        });
        idSection.content = idContent;
      } catch(e) { console.warn('Auto-fill identifying info failed:', e); }
    }

    const filteredSections = sections.filter(s => s.section_key !== 'prepared_approved_by');
    document.getElementById('sectionsEditor').innerHTML = filteredSections.map(s => {
      // Tabular sections: the Neurodevelopmental "Assessment Battery" and the
      // Clinical-only "Assessment Tests/Methods" both render as an editable table.
      if (TABLE_SECTION_KEYS.has(s.section_key)) return renderBatterySectionBlock(s);
      return `<div class="section-block" id="sblock-${s.section_key}" data-title="${esc(s.section_title)}">
        <div class="section-header"><h4>${esc(s.section_title)}</h4><span class="save-indicator" id="save-${s.section_key}">${ICON.check} Saved</span></div>
        <div class="section-body"><textarea class="section-textarea" data-key="${s.section_key}" oninput="autoSaveSection(this)">${esc(s.content||'')}</textarea></div></div>`;
    }).join('');
    renderCompletenessPanel(getLiveSections());
  } catch(e) { console.error(e); }
}

// ── Assessment Battery Section (Step 5) ─────────────────────
// The same editable-table component backs two report sections:
//   • 'assessment_battery'       — Neurodevelopmental report (existing)
//   • 'assessment_tests_methods' — Clinical report (added; clinical-only)
// A given report only ever contains ONE of these, so the table body keeps a
// single id and the key is resolved from the rendered block's data-key.
const TABLE_SECTION_KEYS = new Set(['assessment_battery', 'assessment_tests_methods']);

// Returns the section-key of the tabular section currently in the editor, or ''.
function _activeTableSectionKey() {
  const block = document.querySelector('#sectionsEditor .table-section');
  return block ? (block.dataset.key || '') : '';
}

let _editBattRowIdx = 0;

function _readableToIso(readable) {
  if (!readable || readable === '—') return '';
  const d = new Date(readable);
  return isNaN(d.getTime()) ? '' : d.toISOString().split('T')[0];
}

function _battRowHtml(idx, name, dateDisplay) {
  const uid = 'ebatt-' + idx;
  const dateIso = _readableToIso(dateDisplay);
  return `<tr>
    <td><input type="text" class="form-control" style="width:100%" placeholder="e.g. Clinical Interview"
         value="${esc(name||'')}" oninput="saveBatterySection()"></td>
    <td>
      <div class="date-field" style="position:relative">
        <input type="text" class="form-control date-input" id="${uid}" readonly placeholder="Select date"
               value="${esc(dateDisplay && dateDisplay !== '—' ? dateDisplay : '')}"
               data-val-id="${uid}-val" data-after-pick="saveBatterySection" onclick="openCalendar(this)"
               style="padding-right:32px;cursor:pointer">
        <input type="hidden" id="${uid}-val" value="${esc(dateIso)}">
        <svg style="position:absolute;right:9px;top:50%;transform:translateY(-50%);pointer-events:none;color:var(--text-secondary)" viewBox="0 0 24 24" width="15" height="15" fill="currentColor">
          <path d="M20 3h-1V1h-2v2H7V1H5v2H4C2.9 3 2 3.9 2 5v16c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 18H4V8h16v13z"/>
        </svg>
      </div>
    </td>
    <td style="text-align:center"><button type="button" class="battery-remove-btn"
        onclick="this.closest('tr').remove();saveBatterySection()" title="Remove row">&times;</button></td>
  </tr>`;
}

function renderBatterySectionBlock(s) {
  const key = s.section_key;
  const rows = [];
  const m = (s.content || '').match(/\[\[TESTS_TABLE\]\]([\s\S]*?)\[\[\/TESTS_TABLE\]\]/);
  if (m) {
    m[1].split('\n').map(l=>l.trim()).filter(Boolean).slice(1).forEach(line => {
      const parts = line.split('||');
      const name = (parts[0]||'').trim();
      const date = (parts[1]||'').trim();
      if (name) rows.push({ name, date });
    });
  }
  _editBattRowIdx = 0;
  const rowsHtml = rows.map(r => _battRowHtml(_editBattRowIdx++, r.name, r.date)).join('');
  // Canonicalize data-content to the parsed table form so completeness/save state
  // reflect the actual rows (legacy free-text content collapses to an empty table).
  const dataContent = rows.length
    ? `[[TESTS_TABLE]]\nAssessment Tests and Methods||Date Administered\n${rows.map(r=>`${r.name}||${r.date||'—'}`).join('\n')}\n[[/TESTS_TABLE]]`
    : '';
  return `<div class="section-block table-section" id="sblock-${key}" data-key="${key}" data-title="${esc(s.section_title)}" data-content="${esc(dataContent)}">
    <div class="section-header">
      <h4>${esc(s.section_title)}</h4>
      <div style="display:flex;align-items:center;gap:10px">
        <span class="save-indicator" id="save-${key}">${ICON.check} Saved</span>
        <button type="button" class="btn btn-sm btn-outline" onclick="addEditBatteryRow()">+ Add Assessment</button>
      </div>
    </div>
    <div class="section-body" style="padding:0">
      <table class="preemp-table" style="margin:0">
        <thead><tr>
          <th>Assessment Tests and Methods</th>
          <th style="width:230px">Date Administered</th>
          <th style="width:44px"></th>
        </tr></thead>
        <tbody id="editBatteryBody">${rowsHtml}</tbody>
      </table>
      <div class="table-section-error" id="val-${key}"></div>
    </div>
  </div>`;
}

function addEditBatteryRow() {
  const tbody = document.getElementById('editBatteryBody');
  if (!tbody) return;
  const tr = document.createElement('tr');
  tr.innerHTML = _battRowHtml(_editBattRowIdx++, '', '');
  tbody.appendChild(tr);
}

function collectEditBatteryRows() {
  return Array.from(document.querySelectorAll('#editBatteryBody tr')).map(tr => {
    const nameInput = tr.querySelector('td:first-child input');
    const displayInput = tr.querySelector('.date-input');
    const name = nameInput ? nameInput.value.trim() : '';
    const date = displayInput ? displayInput.value.trim() : '';
    return { name, date };
  }).filter(r => r.name);
}

let _battSaveTimer = null;
function saveBatterySection() {
  // Live feedback for duplicate/empty rows (clinical-only rule; no-op otherwise).
  validateTableSectionClient({ silent: true });
  if (_battSaveTimer) clearTimeout(_battSaveTimer);
  _battSaveTimer = setTimeout(async () => {
    if (!currentReport) return;
    const key = _activeTableSectionKey();
    if (!key) return;
    const rows = collectEditBatteryRows();
    const content = rows.length
      ? `[[TESTS_TABLE]]\nAssessment Tests and Methods||Date Administered\n${rows.map(r=>`${r.name}||${r.date||'—'}`).join('\n')}\n[[/TESTS_TABLE]]`
      : '';
    const block = document.getElementById('sblock-'+key);
    if (block) block.dataset.content = content;
    try {
      await api('/reports/'+currentReport.id+'/sections/'+key, {
        method:'PUT', body:JSON.stringify({ content })
      });
      const ind = document.getElementById('save-'+key);
      if (ind) { ind.classList.add('show'); setTimeout(()=>ind.classList.remove('show'), 2000); }
    } catch(e) {
      // Surface backend table-validation errors (duplicates / empty names) inline.
      if (e && Array.isArray(e.errors) && e.errors.length) {
        _showTableSectionError(key, e.errors.join(' '));
      }
      console.error('Battery save error:', e);
    }
    renderCompletenessPanel(getLiveSections());
  }, 800);
}

function getLiveSections() {
  const sections = Array.from(document.querySelectorAll('.section-textarea')).map(t => {
    const block = t.closest('.section-block');
    return {
      section_key: t.dataset.key,
      section_title: block ? (block.dataset.title || t.dataset.key) : t.dataset.key,
      content: t.value
    };
  });
  const battBlock = document.querySelector('#sectionsEditor .table-section');
  if (battBlock) {
    sections.push({
      section_key: battBlock.dataset.key || 'assessment_battery',
      section_title: battBlock.dataset.title || 'Assessment Battery',
      content: battBlock.dataset.content || ''
    });
  }
  return sections;
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
      renderCompletenessPanel(getLiveSections());
    } catch(e) { console.error('Autosave error:',e); }
  }, 1500);
}

// ── Report Completeness Checker ─────────────────────────────
// Validation is template-driven: only sections actually loaded for this report
// are checked. Signature/cert sections are never user-filled and always skipped.

const COMPLETENESS_SKIP_KEYS = new Set([
  'prepared_approved_by',
  'mental_health_certificate',
]);

function _sectionHasContent(section) {
  const content = (section.content || '').trim();
  if (!content) return false;
  const m = content.match(/\[\[[A-Z_]+_TABLE\]\]([\s\S]*?)\[\[\/[A-Z_]+_TABLE\]\]/);
  if (m) {
    const dataLines = m[1].split('\n').map(l=>l.trim()).filter(Boolean);
    return dataLines.length >= 2; // header row + at least 1 data row
  }
  return true;
}

function validateCompleteness(sections) {
  const missing = [];
  for (const s of sections) {
    if (COMPLETENESS_SKIP_KEYS.has(s.section_key)) continue;
    if (!_sectionHasContent(s)) {
      missing.push({ label: s.section_title || s.section_key, key: s.section_key });
    }
  }
  return { missing, allComplete: missing.length === 0 };
}

function renderCompletenessPanel(sections) {
  const panel = document.getElementById('completenessPanel');
  if (!panel) return;

  const { missing, allComplete } = validateCompleteness(sections);

  const submitTop = document.getElementById('btnSubmitTopBar');
  const submitBot = document.getElementById('btnSubmitBottom');

  if (allComplete) {
    panel.style.display = 'block';
    panel.innerHTML = `<div class="completeness-success">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" style="flex-shrink:0"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
      <div><div style="font-weight:600">All required sections for this assessment have been completed.</div>
      <div style="font-size:12px;opacity:.85;margin-top:2px">Report is ready for generation.</div></div></div>`;
    if (submitTop) { submitTop.disabled = false; submitTop.removeAttribute('title'); }
    if (submitBot) { submitBot.disabled = false; submitBot.removeAttribute('title'); }
    document.querySelectorAll('.section-block.section-missing').forEach(b => b.classList.remove('section-missing'));
  } else {
    panel.style.display = 'block';
    panel.innerHTML = `<div class="completeness-warning">
      <div class="completeness-warning__title">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="#d97706"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>
        Missing Required Information
      </div>
      <ul class="completeness-warning__list">
        ${missing.map(m=>`<li><span class="completeness-item" onclick="scrollToSection('${m.key}')"><span class="completeness-checkbox"></span>${m.label}</span></li>`).join('')}
      </ul>
      <div style="font-size:12px;color:var(--text-secondary);margin-top:10px">Please complete all required sections before submitting the report.</div>
    </div>`;
    if (submitTop) { submitTop.disabled = true; submitTop.title = 'Complete all required sections first'; }
    if (submitBot) { submitBot.disabled = true; submitBot.title = 'Complete all required sections first'; }
    document.querySelectorAll('.section-block').forEach(b => b.classList.remove('section-missing'));
    missing.forEach(m => {
      const block = document.getElementById('sblock-'+m.key);
      if (block) block.classList.add('section-missing');
    });
  }
}

function scrollToSection(sectionKey) {
  const block = document.getElementById('sblock-'+sectionKey);
  if (!block) return;
  block.scrollIntoView({ behavior:'smooth', block:'start' });
  block.classList.add('section-highlight');
  setTimeout(() => block.classList.remove('section-highlight'), 2000);
}

// ── Clinical "Assessment Tests/Methods" table validation ────
// Mirrors the Assessment Battery UX but enforces, for the CLINICAL report only:
//   • at least one assessment test/method entry,
//   • every row must have a non-empty test/method name,
//   • no duplicate test/method entries.
// Date Administered is validated separately by validateBatteryDatesClient().
// For any other table section (e.g. Neurodevelopmental battery) this is a no-op
// so other report templates remain unchanged.
function _showTableSectionError(key, msg) {
  const el = document.getElementById('val-' + key);
  if (el) { el.textContent = msg; el.classList.add('visible'); }
}
function _clearTableSectionError(key) {
  const el = document.getElementById('val-' + key);
  if (el) { el.textContent = ''; el.classList.remove('visible'); }
}
function validateTableSectionClient(opts) {
  opts = opts || {};
  const block = document.querySelector('#sectionsEditor .table-section');
  if (!block || block.dataset.key !== 'assessment_tests_methods') return true; // clinical-only rule
  const key = block.dataset.key;
  const tbody = document.getElementById('editBatteryBody');
  const rows = Array.from(tbody ? tbody.querySelectorAll('tr') : []);

  rows.forEach(tr => {
    const n = tr.querySelector('td:first-child input');
    if (n) n.classList.remove('input-error');
  });
  _clearTableSectionError(key);

  let ok = true;
  let msg = '';
  const seen = new Map();          // lowercased name → first input element
  let namedCount = 0;

  rows.forEach(tr => {
    const nameInput = tr.querySelector('td:first-child input');
    const dateInput = tr.querySelector('.date-input');
    const name = nameInput ? nameInput.value.trim() : '';
    const date = dateInput ? dateInput.value.trim() : '';
    if (!name) {
      // A fully empty row is ignored; a dated row missing its name is an error.
      if (date) { ok = false; msg = msg || 'Each assessment row must have a test/method name.'; if (nameInput) nameInput.classList.add('input-error'); }
      return;
    }
    namedCount++;
    const dk = name.toLowerCase();
    if (seen.has(dk)) {
      ok = false; msg = msg || 'Duplicate assessment tests/methods are not allowed.';
      if (nameInput) nameInput.classList.add('input-error');
      const first = seen.get(dk); if (first) first.classList.add('input-error');
    } else {
      seen.set(dk, nameInput);
    }
  });

  if (namedCount === 0) { ok = false; msg = msg || 'Add at least one assessment test/method before continuing.'; }

  if (!ok && !opts.silent) _showTableSectionError(key, msg);
  else if (ok) _clearTableSectionError(key);
  return ok;
}

// Date Administered is REQUIRED for every assessment in the battery (step 5).
// Returns true when valid; otherwise highlights the offending rows.
function validateBatteryDatesClient() {
  const rows = Array.from(document.querySelectorAll('#editBatteryBody tr'));
  if (!rows.length) return true; // template has no battery table
  let ok = true;
  rows.forEach(tr => {
    const nameInput = tr.querySelector('td:first-child input');
    const dateInput = tr.querySelector('.date-input');
    const name = nameInput ? nameInput.value.trim() : '';
    const date = dateInput ? dateInput.value.trim() : '';
    if (name && !date) {
      ok = false;
      if (dateInput) dateInput.classList.add('input-error');
    } else if (dateInput) {
      dateInput.classList.remove('input-error');
    }
  });
  return ok;
}

// ── Submit ──────────────────────────────────────────────────
// Routes to the correct workflow stage based on who is submitting and current status.
async function submitReport() {
  if (!currentReport) return;
  // Clinical report only: enforce ≥1 entry, required names, and no duplicates in
  // the Assessment Tests/Methods table before submitting.
  if (!validateTableSectionClient()) {
    const block = document.querySelector('#sectionsEditor .table-section');
    if (block) scrollToSection(block.dataset.key);
    toast('Please correct the Assessment Tests/Methods table before continuing.', 'error');
    return;
  }
  // A valid Date Administered must be chosen for each assessment before submitting.
  if (!validateBatteryDatesClient()) {
    toast('Please select a Date Administered for every assessment in the battery.', 'error');
    return;
  }
  var role = USER && USER.role;
  var status = currentReport.status;
  // Concern correction of a released report: sections are already auto-saved.
  // Just return to the report detail, where "Submit to Clinical Director" lives.
  if (currentReport.modification_status) {
    toast('Report changes saved.');
    await openReport(currentReport.id);
    return;
  }
  if (role === 'qc_psychometrician' && status === 'Prepared') {
    workflowReview(currentReport.id);
  } else if (role === 'qc_psychometrician' && status === 'revision_requested') {
    // QCP finished edits after Psychologist requested revision — resubmit to Psychologist
    workflowResubmit(currentReport.id);
  } else if (role === 'supervising_psychometrician' && status === 'revision_requested_qc') {
    // SupPsy finished edits after QCP requested revision — resubmit to QCP
    workflowResubmit(currentReport.id);
  } else if (role === 'psychologist') {
    // Psychologist SOLO flow: "Save" keeps the report as a draft. They re-open it
    // from the detail view to Edit / Delete / Approve (no Submit-to-QC pipeline).
    toast('Report saved as draft.');
    await openReport(currentReport.id);
  } else if (role === 'clinical_director') {
    // Clinical Director SOLO flow: "Save" keeps the report as a draft. They re-open
    // it from the detail view to Edit / Approve / Sign / Release — no QC, Supervising
    // or Psychologist hand-off. (Must precede the generic draft → Submit-to-QC branch.)
    toast('Report saved as draft.');
    await openReport(currentReport.id);
  } else if (role === 'supervising_psychometrician' || status === 'draft') {
    workflowPrepare(currentReport.id);
  } else if (role === 'psychologist' && status === 'Review') {
    // Sections are already auto-saved. Return to the report detail view so the
    // psychologist can use the Approve button there — don't auto-approve here.
    toast('Changes saved.');
    await openReport(currentReport.id);
  } else {
    toast('You cannot submit a report in its current state.', 'error');
  }
}