/* ══════════════════════════════════════════════════════════
   PSYGEN — Templates & Versions: manage templates, version
            history modal, restore version
   ══════════════════════════════════════════════════════════ */

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

function delTpl(id) {
  prConfirm('Delete Template', 'Delete this template? This cannot be undone.', async () => {
    try { await api('/report-templates/'+id,{method:'DELETE'}); toast('Deleted'); loadManageTemplates(); }
    catch(e) { toast(e.message,'error'); }
  }, true);
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

function restoreVersion(rid,vid) {
  prConfirm('Restore Version', 'Restore this version? The current content will be replaced.', async () => {
    showLoading();
    try { await api(`/reports/${rid}/versions/${vid}/restore`,{method:'POST'}); toast('Restored!'); closeModal('versionModal'); loadSectionsEditor(); }
    catch(e) { toast(e.message,'error'); } hideLoading();
  });
}