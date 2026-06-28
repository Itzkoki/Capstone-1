/* ══════════════════════════════════════════════════════════
   PSYGEN — Detail: report view, delete, edit redirect
   ══════════════════════════════════════════════════════════ */

function _signatoryLabel(r) {
  const s = r.status;
  if (s === 'Approved' || s === 'finalized') return 'Approved By';
  if (s === 'Review' || s === 'revision_requested') return 'Reviewed By';
  return 'Prepared By';
}

function _signatoryName(r) {
  const s = r.status;
  if (s === 'Approved' || s === 'finalized') return r.approved_by_name || '—';
  if (s === 'Review' || s === 'revision_requested') return r.reviewed_by_name || '—';
  if (s === 'Prepared' || s === 'revision_requested_qc') return r.prepared_by_name || '—';
  return '—';
}

// ── Report Detail ───────────────────────────────────────────
async function openReport(id) {
  showLoading();
  // Clear any report-concern banner injected by a previous concern view. The
  // concern action buttons live in #detailActions, which is fully rebuilt below,
  // so they clear themselves; only the standalone banner needs explicit removal.
  const _rcBanner = document.getElementById('rcConcernBanner');
  if (_rcBanner) _rcBanner.remove();
  try {
    const d = await api('/reports/'+id); currentReport = d.report; const r = d.report;
    document.getElementById('detailTitle').textContent = r.client_name;
    // A released report under an active client concern shows "Modification
    // Required" / "Modified Report Submitted" (takes precedence over the signature
    // label); otherwise the signature pipeline shows a friendlier status label.
    const modLabel = r.modification_status || '';
    const sigLabel = signatureStageLabel(r.signature_stage);
    const badgeLabel = modLabel || sigLabel;
    const statusBadge = badgeLabel
      ? `<span class="badge-status badge-warning"><span class="badge-dot"></span>${badgeLabel}</span>`
      : `<span class="badge-status badge-${r.status}"><span class="badge-dot"></span>${r.status}</span>`;
    document.getElementById('detailSubtitle').innerHTML = `${statusBadge} &nbsp; ${esc(r.template_name||'')} &nbsp; v${r.current_version}`;
    let btns = '';
    const isSup = USER.role === 'supervising_psychometrician';
    const isQC  = USER.role === 'qc_psychometrician';
    const isPsy = USER.role === 'psychologist';
    const isCD  = USER.role === 'clinical_director';
    const isOwner = r.psychologist_id === USER.id;
    const sigStage = r.signature_stage || null;

    // PDF available to all staff roles and the report owner
    if (isCD || isOwner || isSup || isQC || isPsy)
      btns += `<button class="btn btn-primary btn-sm" onclick="downloadPdf(${r.id})">${ICON.download} PDF</button> `;

    // ── Signature & Release workflow buttons (post-approval) ──────────
    // The "Save Signed PDF" action is the required signing step; submission is
    // blocked (at click-time, see the submit* handlers) until it has been saved
    // for the current stage. The "Sign" button is intentionally gone.
    if (sigStage === 'supervising' && isSup) {
      btns += `<button class="btn btn-primary btn-sm" onclick="pickSignedPdf(${r.id},'supervising')">${ICON.check} Save Signed PDF</button> `;
      btns += `<button class="btn btn-success btn-sm" onclick="submitToQc(${r.id})">${ICON.arrowUp} Submit to Quality Control Psychometrician</button> `;
    }
    if (sigStage === 'quality_control' && isQC) {
      btns += `<button class="btn btn-primary btn-sm" onclick="pickSignedPdf(${r.id},'quality_control')">${ICON.check} Save Signed PDF</button> `;
      btns += `<button class="btn btn-success btn-sm" onclick="markSigned(${r.id})">${ICON.arrowUp} Submit to Psychologist</button> `;
    }
    if (sigStage === 'psychologist' && (isPsy || isOwner)) {
      btns += `<button class="btn btn-primary btn-sm" onclick="pickSignedPdf(${r.id},'psychologist')">${ICON.check} Save Signed PDF</button> `;
      btns += `<button class="btn btn-success btn-sm" onclick="submitToDirector(${r.id})">${ICON.arrowUp} Submit to Clinical Director</button> `;
    }
    if (sigStage === 'ready_for_release' && isCD) {
      btns += `<button class="btn btn-success btn-sm" onclick="releaseReport(${r.id})">${ICON.check} Release Report</button> `;
    }

    // ── 3-Stage Workflow buttons ──────────────────────────────
    // SupPsy: edit while draft, then submit as Prepared
    if ((r.status==='draft'||r.status==='rejected') && (isSup || isOwner))
      btns += `<button class="btn btn-primary btn-sm" onclick="editRpt(${r.id})">${ICON.pencil} Edit</button> `;
    if (r.status==='draft' && isSup)
      btns += `<button class="btn btn-success btn-sm" onclick="workflowPrepare(${r.id})">${ICON.check} Submit to QC</button> `;

    // Psychologist SOLO flow: on their OWN draft they can Edit (above), Delete
    // (below), and Approve. Approving sends it straight into the signing stage.
    const isAuthor = String(r.psychologist_id) === String(USER.id);
    if ((r.status==='draft'||r.status==='rejected') && isPsy && isAuthor && !sigStage)
      btns += `<button class="btn btn-success btn-sm" onclick="psychologistApprove(${r.id})">${ICON.check} Approve</button> `;

    // SupPsy: edit & resubmit when revision was requested by QCP (revision_requested_qc)
    if (r.status==='revision_requested_qc' && isSup) {
      btns += `<button class="btn btn-warning btn-sm" onclick="editRpt(${r.id})">${ICON.pencil} Edit</button> `;
      btns += `<button class="btn btn-success btn-sm" onclick="workflowResubmit(${r.id})">${ICON.arrowUp} Resubmit to QC</button> `;
    }

    // QCP: review when status is Prepared — can approve to Psychologist or request revision from SupPsy
    if (r.status==='Prepared' && isQC) {
      btns += `<button class="btn btn-success btn-sm" onclick="workflowReview(${r.id})">${ICON.check} Submit to Psychologist</button> `;
      btns += `<button class="btn btn-warning btn-sm" onclick="workflowQcRevise(${r.id})">${ICON.undo} Request Revision</button> `;
    }
    if (r.status==='Prepared' && (isQC || isCD))
      btns += `<button class="btn btn-primary btn-sm" onclick="editRpt(${r.id})">${ICON.pencil} Review/Edit</button> `;

    // QCP: edit & submit back to Psychologist when Psychologist requested revision (revision_requested)
    if (r.status==='revision_requested' && isQC) {
      btns += `<button class="btn btn-warning btn-sm" onclick="editRpt(${r.id})">${ICON.pencil} Edit</button> `;
      btns += `<button class="btn btn-success btn-sm" onclick="workflowResubmit(${r.id})">${ICON.arrowUp} Submit to Psychologist</button> `;
    }

    // QCP: show badge when they've sent revision back to SupPsy and awaiting SupPsy's fix
    if (r.status==='revision_requested_qc' && isQC)
      btns += `<span class="badge-status badge-warning" style="font-size:11px;padding:4px 8px">Awaiting SupPsy Revision</span> `;

    // Psychologist: approve, directly edit, or request revision when status is Review
    if (r.status==='Review' && isPsy) {
      btns += `<button class="btn btn-success btn-sm" onclick="workflowApprove(${r.id})">${ICON.check} Approve</button> `;
      btns += `<button class="btn btn-primary btn-sm" onclick="editRpt(${r.id})">${ICON.pencil} Edit</button> `;
      btns += `<button class="btn btn-warning btn-sm" onclick="workflowRevise(${r.id})">${ICON.undo} Request Revision</button> `;
    }

    // Show revision notes to QCP when Psychologist requested revision
    if (r.status==='revision_requested' && isQC && r.revision_notes)
      btns += `<div class="alert-warning" style="margin-top:8px;padding:8px;border-radius:6px;background:#fff3cd;font-size:12px"><strong>Psychologist Revision Notes:</strong> ${esc(r.revision_notes)}</div>`;
    // Show revision notes to SupPsy when QCP requested revision
    if (r.status==='revision_requested_qc' && (isSup || isOwner) && r.qc_revision_notes)
      btns += `<div class="alert-warning" style="margin-top:8px;padding:8px;border-radius:6px;background:#fff3cd;font-size:12px"><strong>QC Revision Notes:</strong> ${esc(r.qc_revision_notes)}</div>`;

    // ── Legacy workflow (kept for backward compatibility) ────
    if (r.status==='submitted' && isCD)
      btns += `<button class="btn btn-success btn-sm" onclick="showApprovalModal(${r.id})">Review (Legacy)</button> `;
    if (r.status==='approved' && isCD)
      btns += `<button class="btn btn-primary btn-sm" onclick="finalizeRpt(${r.id})">${ICON.lock} Finalize</button> `;
    if (r.status==='finalized' && isCD)
      btns += `<button class="btn btn-primary btn-sm" onclick="editRpt(${r.id})">${ICON.pencil} Edit</button> `;

    // CD: lock/unlock — no longer offered once the report is Ready For Release
    // or Released (those stages are managed via release/archive, not locking).
    const isReleaseStage = sigStage === 'ready_for_release' || sigStage === 'released';
    if (isCD && !isReleaseStage)
      btns += r.is_locked
        ? `<button class="btn btn-ghost btn-sm" onclick="workflowLock(${r.id},false)">${ICON.unlock} Unlock</button> `
        : `<button class="btn btn-ghost btn-sm" onclick="workflowLock(${r.id},true)">${ICON.lock} Lock</button> `;

    // Ready-For-Release / Released reports are archived (not deleted) so they are
    // preserved rather than permanently removed. On earlier stages the Clinical
    // Director keeps the Delete/Trash flow, while the pipeline staff roles
    // (Supervising / QC / Psychologist) archive instead of deleting.
    if (isReleaseStage) {
      if (isCD)
        btns += `<button class="btn btn-warning btn-sm" onclick="archiveReport(${r.id})">${ICON.archive} Archive</button> `;
    } else if (isCD) {
      if (canDeleteReport(r))
        btns += `<button class="btn btn-danger btn-sm" onclick="deleteReport(${r.id})">${ICON.trash} Delete</button> `;
    } else if (canArchiveReport(r)) {
      btns += `<button class="btn btn-warning btn-sm" onclick="archiveReport(${r.id})">${ICON.archive} Archive</button> `;
    }
    document.getElementById('detailActions').innerHTML = btns;

    // During the signature workflow the Supervising / QC reviewers only see the
    // report content + signing actions — the Versions tab/history is hidden.
    const versionsTab = document.getElementById('detailTabVersions');
    if (versionsTab) {
      const hideVersions = !!sigStage && (isSup || isQC);
      versionsTab.style.display = hideVersions ? 'none' : '';
    }

    showDetailTab('info',d); showView('detail');

    // If this released report is under an active client concern, overlay the
    // concern banner + Edit / Upload Modified PDF / Submit to Clinical Director
    // actions for the authoring psychologist (reuses the concern flow).
    if (r.modification_status && typeof rcMaybeInjectForReport === 'function') {
      rcMaybeInjectForReport(r);
    }
  } catch(e) { toast(e.message,'error'); } hideLoading();
}

// ── Signature & Release workflow ─────────────────────────────
function signatureStageLabel(stage) {
  switch (stage) {
    case 'supervising':       return 'Signature Required';
    case 'quality_control':   return 'Signature Required';
    case 'psychologist':      return 'Signature Required';
    case 'ready_for_release': return 'Ready For Release';
    case 'released':          return 'Released';
    default:                  return '';
  }
}

// Let the reviewer pick their signed PDF file and persist it. Uploading a
// signed PDF matches the API payload (a signed PDF file) and guarantees the
// saved signatures survive refresh, stage changes, and release.
function pickSignedPdf(id, stage) {
  let input = document.getElementById('signedPdfInput');
  if (!input) {
    input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/pdf';
    input.id = 'signedPdfInput';
    input.style.display = 'none';
    document.body.appendChild(input);
  }
  input.onchange = async () => {
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;
    if (file.type && file.type !== 'application/pdf') { toast('Please select a PDF file.', 'error'); return; }
    showLoading();
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      await api('/reports/' + id + '/save-signed-pdf', {
        method: 'POST',
        body: JSON.stringify({ pdf: dataUrl, signature_stage: stage }),
      });
      toast('Signed PDF saved.');
      await openReport(id);
    } catch (e) { toast(e.message, 'error'); }
    hideLoading();
  };
  input.click();
}

// True only once a signed PDF has been saved for the report's current stage.
// Submission to the next stage is blocked until then (the backend enforces this
// too) — the buttons stay enabled, but clicking before signing shows a prompt.
function requireSignedPdf() {
  if (currentReport && currentReport.has_stage_signed_pdf) return true;
  toast('Please save the signed PDF first by clicking "Save Signed PDF".', 'error');
  return false;
}

function submitToQc(id) {
  if (!requireSignedPdf()) return;
  prConfirm('Submit to Quality Control', 'Submit this signed report to the Quality Control Psychometrician? Your signature will be locked.', async () => {
    showLoading();
    try {
      await api('/reports/' + id + '/submit-to-qc', { method: 'POST' });
      toast('Submitted to Quality Control Psychometrician.');
      await openReport(id);
    } catch (e) { toast(e.message, 'error'); }
    hideLoading();
  });
}

function markSigned(id) {
  if (!requireSignedPdf()) return;
  prConfirm('Submit to Psychologist', 'Submit this signed report to the Psychologist for their signature? Your signature will be locked.', async () => {
    showLoading();
    try {
      await api('/reports/' + id + '/mark-signed', { method: 'POST' });
      toast('Submitted to the Psychologist for signing.');
      await openReport(id);
    } catch (e) { toast(e.message, 'error'); }
    hideLoading();
  });
}

// Psychologist solo flow: approve their own authored draft → enters signing stage.
function psychologistApprove(id) {
  prConfirm('Approve Report', 'Approve this report? You will then be able to Sign it, save the signed PDF, and submit it to the Clinical Director.', async () => {
    showLoading();
    try {
      await api('/reports/' + id + '/workflow/psychologist-approve', { method: 'POST' });
      toast('Report approved. You can now sign and submit it.');
      await openReport(id);
    } catch (e) { toast(e.message, 'error'); }
    hideLoading();
  });
}

// Open the e-signature tool for a report (Sign button). Reuses the shared
// DocuSeal/draw signature flow keyed on currentPdfReportId.
function signReport(id) {
  currentPdfReportId = id;
  if (typeof openEsignModal === 'function') openEsignModal();
  else toast('Signature tool is unavailable.', 'error');
}

function submitToDirector(id) {
  if (!requireSignedPdf()) return;
  prConfirm('Submit to Clinical Director', 'Submit this signed report to the Clinical Director? The report will become Ready For Release and your signature will be locked.', async () => {
    showLoading();
    try {
      await api('/reports/' + id + '/submit-to-director', { method: 'POST' });
      toast('Submitted to the Clinical Director — Ready For Release.');
      await openReport(id);
    } catch (e) { toast(e.message, 'error'); }
    hideLoading();
  });
}

function releaseReport(id) {
  prConfirm('Release Report', 'Release the final signed report to the client? This cannot be undone.', async () => {
    showLoading();
    try {
      await api('/reports/' + id + '/release', { method: 'POST' });
      toast('Report released to the client.');
      await openReport(id);
    } catch (e) { toast(e.message, 'error'); }
    hideLoading();
  });
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
      <div class="form-group"><label>${_signatoryLabel(r)}</label><p>${esc(_signatoryName(r))}</p></div></div></div>`;
  } else if (tab==='sections') { loadDetailSections(c); }
  else if (tab==='history') { loadDetailVersions(c); }
}

// Renders a section's stored content for the read-only detail view. Any
// [[..._TABLE]] block (e.g. the clinical Assessment Tests/Methods table or the
// neurodevelopmental Assessment Battery) is shown as a real table rather than
// raw markup; plain sections fall back to pre-wrapped text.
function _detailSectionBody(content) {
  const txt = String(content || '');
  const m = txt.match(/\[\[([A-Z_]+_TABLE)\]\]\s*([\s\S]*?)\s*\[\[\/\1\]\]/);
  if (!m) {
    return `<div style="font-size:13px;line-height:1.7;color:var(--text-secondary);white-space:pre-wrap">${esc(content||'(empty)')}</div>`;
  }
  const lines = m[2].split('\n').map(l=>l.trim()).filter(Boolean);
  if (!lines.length) return `<div style="font-size:13px;color:var(--text-secondary)">(empty)</div>`;
  const headers = lines[0].split('||').map(x=>x.trim());
  const rows = lines.slice(1).map(l=>l.split('||').map(x=>x.trim()));
  const before = txt.slice(0, m.index).trim();
  const after  = txt.slice(m.index + m[0].length).trim();
  const wrap = (t) => t ? `<div style="font-size:13px;line-height:1.7;color:var(--text-secondary);white-space:pre-wrap;margin:6px 0">${esc(t)}</div>` : '';
  return `${wrap(before)}<table class="preemp-table" style="margin:4px 0">
    <thead><tr>${headers.map(h=>`<th>${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(r=>`<tr>${r.map(cv=>`<td>${esc(cv)}</td>`).join('')}</tr>`).join('')}</tbody>
  </table>${wrap(after)}`;
}

async function loadDetailSections(c) {
  try {
    const d = await api('/reports/'+currentReport.id);
    const r = d.report || currentReport;
    const sections = (d.sections||[]).filter(s => s.section_key !== 'prepared_approved_by');
    const prepName = r.prepared_by_name || '—';
    const revName  = r.reviewed_by_name  || '—';
    const appName  = r.approved_by_name  || '—';
    const sigBlock = `<div class="card" style="margin-bottom:12px">
      <h4 style="color:var(--accent-light);margin-bottom:12px;font-size:14px">Signatories</h4>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:14px;">
        <div style="border:1px solid #e2e8f0;border-radius:8px;padding:10px 12px;background:#f8fafc;">
          <div style="font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px;">Prepared By</div>
          <div style="font-size:13px;font-weight:600;color:#1e293b;">${esc(prepName)}</div>
          <div style="font-size:10px;color:#94a3b8;margin-top:3px;">Supervising Psychometrician</div>
        </div>
        <div style="border:1px solid #e2e8f0;border-radius:8px;padding:10px 12px;background:#f8fafc;">
          <div style="font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px;">Reviewed By</div>
          <div style="font-size:13px;font-weight:600;color:#1e293b;">${esc(revName)}</div>
          <div style="font-size:10px;color:#94a3b8;margin-top:3px;">Quality Control Psychometrician</div>
        </div>
        <div style="border:1px solid #e2e8f0;border-radius:8px;padding:10px 12px;background:#f8fafc;">
          <div style="font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px;">Approved By</div>
          <div style="font-size:13px;font-weight:600;color:#1e293b;">${esc(appName)}</div>
          <div style="font-size:10px;color:#94a3b8;margin-top:3px;">Psychologist</div>
        </div>
      </div>
    </div>`;
    c.innerHTML = sections.map(s=>`<div class="card" style="margin-bottom:12px">
      <h4 style="color:var(--accent-light);margin-bottom:8px;font-size:14px">${esc(s.section_title)}</h4>
      ${_detailSectionBody(s.content)}</div>`).join('') + sigBlock;
  } catch(e) { c.innerHTML='<p>Error</p>'; }
}

async function loadDetailVersions(c) {
  try { const d = await api('/reports/'+currentReport.id+'/versions'); const v = d.versions||[];
    if (!v.length) { c.innerHTML='<div class="empty-state"><h4>No versions</h4></div>'; return; }
    c.innerHTML = `<div class="version-timeline">`+v.map(x=>{
      const who = esc(x.editor_name || 'Unknown');
      const titles = (x.modified_section_titles && x.modified_section_titles.length)
        ? x.modified_section_titles.join(', ')
        : (x.change_summary || 'the report').replace(/^Updated section:\s*/i, '');
      // Label + complete 24-hour timestamp, e.g. "Van modified Findings — Jun 22, 2026 10:00"
      const label = `${who} modified ${esc(titles)}`;
      return `<div class="version-item"><div class="v-num">v${x.version_number}</div>
      <div class="v-meta">${label} — ${fmtDateTime(x.created_at)}</div>
      <div class="v-changes">${esc(x.change_summary||'')}</div>
      <button class="btn btn-ghost btn-sm" style="margin-top:8px" onclick="restoreVersion(${currentReport.id},${x.id})">Restore</button></div>`;
    }).join('')+`</div>`;
  } catch(e) { c.innerHTML='<p>Error</p>'; }
}

// ── Delete Report ───────────────────────────────────────────
function canDeleteReport(r) {
  if (!USER) return false;
  // The Clinical Director can always delete (manages Trash).
  if (USER.role === 'clinical_director') return true;
  // Quality Control Psychometricians may never delete reports.
  if (USER.role === 'qc_psychometrician') return false;
  // Supervising Psychometrician / Psychologist may delete ONLY their own report,
  // and NOT once it is Approved or in any Signature Required stage.
  const lockedFromDelete = !!(r && (r.status === 'Approved' || r.signature_stage));
  if (lockedFromDelete) return false;
  return !!(r && r.psychologist_id === USER.id);
}

// Archive (instead of delete) a Ready-For-Release / Released report. Archived
// reports are preserved and can be restored from the Archive view.
function archiveReport(id) {
  prConfirm('Archive Report', 'Archive this report? It will be moved to the Archive and can be restored later.', async () => {
    showLoading();
    try {
      await api('/reports/' + id + '/archive', { method: 'POST' });
      toast('Report archived.');
      currentReport = null;
      showView('dashboard');
    } catch (e) {
      toast(e.message, 'error');
    }
    hideLoading();
  });
}

// Which pipeline staff (non-CD) may archive a report from the detail view. They
// archive instead of deleting; the action is reversible from the Archive view.
// Supervising Psychometrician / Psychologist may archive their own reports; the
// Quality Control Psychometrician may archive reports in their review queue.
function canArchiveReport(r) {
  if (!USER || !r) return false;
  const role = USER.role;
  if (role === 'qc_psychometrician') return true;
  if (role === 'supervising_psychometrician' || role === 'psychologist')
    return String(r.psychologist_id) === String(USER.id);
  return false;
}

function deleteReport(id) {
  prConfirm('Delete Report', 'Move this report to Trash? It can be restored later by the Clinical Director.', async () => {
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
  });
}

// ── 3-Stage Workflow Handlers ───────────────────────────────

async function workflowPrepare(id) {
  prConfirm('Submit to QC', 'Mark this report as Prepared and send it to the QC Psychometrician for review?', async () => {
    showLoading();
    try {
      await api('/reports/' + id + '/workflow/prepare', { method: 'POST' });
      toast('Report submitted to QC.');
      await openReport(id);
    } catch (e) { toast(e.message, 'error'); }
    hideLoading();
  });
}

async function workflowReview(id) {
  prConfirm('Submit to Psychologist', 'Confirm QC review is complete and send this report to the Psychologist for final approval?', async () => {
    showLoading();
    try {
      await api('/reports/' + id + '/workflow/review', { method: 'POST' });
      toast('Report sent to Psychologist for approval.');
      await openReport(id);
    } catch (e) { toast(e.message, 'error'); }
    hideLoading();
  });
}

async function workflowApprove(id) {
  prConfirm('Approve Report', 'Approve this report? The case will be marked as Report Approved and ready for release.', async () => {
    showLoading();
    try {
      await api('/reports/' + id + '/workflow/approve', { method: 'POST', body: JSON.stringify({ comments: '' }) });
      toast('Report approved.');
      await openReport(id);
    } catch (e) { toast(e.message, 'error'); }
    hideLoading();
  });
}

function workflowRevise(id) {
  prPrompt('Request Revision', 'Describe what needs to be corrected (required):', async (comments) => {
    if (!comments || !comments.trim()) { toast('Revision notes are required.', 'error'); return; }
    showLoading();
    try {
      await api('/reports/' + id + '/workflow/revise', { method: 'POST', body: JSON.stringify({ comments }) });
      toast('Revision requested. The QC Psychometrician has been notified.');
      await openReport(id);
    } catch (e) { toast(e.message, 'error'); }
    hideLoading();
  });
}

function workflowQcRevise(id) {
  prPrompt('QC Revision Request', 'Describe what needs to be corrected (required):', async (comments) => {
    if (!comments || !comments.trim()) { toast('Revision notes are required.', 'error'); return; }
    showLoading();
    try {
      await api('/reports/' + id + '/workflow/qc-revise', { method: 'POST', body: JSON.stringify({ comments }) });
      toast('QC revision requested. The Supervising Psychometrician has been notified.');
      await openReport(id);
    } catch (e) { toast(e.message, 'error'); }
    hideLoading();
  });
}

async function workflowResubmit(id) {
  prConfirm('Resubmit Report', 'Resubmit the revised report for review?', async () => {
    showLoading();
    try {
      await api('/reports/' + id + '/workflow/resubmit', { method: 'POST' });
      toast('Report resubmitted for review.');
      await openReport(id);
    } catch (e) { toast(e.message, 'error'); }
    hideLoading();
  });
}

async function workflowLock(id, lock) {
  showLoading();
  try {
    await api('/reports/' + id + '/workflow/lock', { method: 'POST', body: JSON.stringify({ lock }) });
    toast(lock ? 'Report locked.' : 'Report unlocked.');
    await openReport(id);
  } catch (e) { toast(e.message, 'error'); }
  hideLoading();
}

async function editRpt(id) {
  showLoading();
  try {
    const d = await api('/reports/' + id);
    currentReport = d.report;
    selectedTemplateId = currentReport.template_id;

    const canEditFinalized   = currentReport.status === 'finalized' && USER.role === 'clinical_director';
    const canEditPrepared    = currentReport.status === 'Prepared'  && (USER.role === 'qc_psychometrician' || USER.role === 'clinical_director');
    const canEditDraft       = currentReport.status === 'draft' || currentReport.status === 'rejected';
    const canEditQcRevision  = currentReport.status === 'revision_requested' && USER.role === 'qc_psychometrician';
    const canEditSupRevision = currentReport.status === 'revision_requested_qc' && USER.role === 'supervising_psychometrician';
    const canEditReview      = currentReport.status === 'Review' && USER.role === 'psychologist';
    // Released report under an active client concern: the approving psychologist
    // (author of record) or the CD may correct it in the main editor.
    const canEditModification = !!currentReport.modification_status &&
      (String(currentReport.approved_by) === String(USER.id) || USER.role === 'clinical_director');
    if (!canEditDraft && !canEditFinalized && !canEditPrepared && !canEditQcRevision && !canEditSupRevision && !canEditReview && !canEditModification) {
      toast('You cannot edit a report at this stage.', 'error');
      hideLoading();
      return;
    }

    if (!allTemplates.length) {
      try { const t = await api('/report-templates'); allTemplates = t.templates || []; } catch (e) {}
    }

    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    const cv = document.getElementById('view-create');
    if (cv) cv.classList.add('active');

    nextCreateStep(5);

    // Update submit button label to match who is submitting and what the next step is
    var role = USER && USER.role;
    var label = 'Submit for Review';
    if (role === 'qc_psychometrician' && currentReport.status === 'Prepared') {
      label = 'Submit to Psychologist';
    } else if (role === 'qc_psychometrician' && currentReport.status === 'revision_requested') {
      label = 'Submit to Psychologist';
    } else if (role === 'supervising_psychometrician' && currentReport.status === 'draft') {
      label = 'Submit to QC';
    } else if (role === 'supervising_psychometrician' && currentReport.status === 'revision_requested_qc') {
      label = 'Resubmit to QC';
    } else if (role === 'psychologist' && currentReport.status === 'Review') {
      label = 'Save Changes';
    }
    if (canEditModification) {
      // Concern correction: sections autosave; this just returns to the report
      // where "Submit to Clinical Director" lives.
      label = 'Save & Return to Report';
    }
    var lblTop = document.getElementById('submitBtnLabel');
    var lblBot = document.getElementById('submitBtnLabelBottom');
    if (lblTop) lblTop.textContent = label;
    if (lblBot) lblBot.textContent = label;
  } catch (e) {
    toast(e.message, 'error');
  }
  hideLoading();
}