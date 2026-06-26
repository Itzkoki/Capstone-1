/* ══════════════════════════════════════════════════════════
   PSYGEN — Legacy Verifications (Clinical Director)
   Old clients requesting a copy / raising a concern about a report
   that predates the online system (or is paper-only). The CD verifies
   identity (mandatory photo ID), locates & digitizes the report, then
   it flows into the normal copy / concern pipeline. CD-only.
   ══════════════════════════════════════════════════════════ */

let LV_DATA = [];
let lvCurrentId = null;
let lvCurrentRow = null;
let _lvPsychologists = null;

const LV_STATUS_COLORS = {
  'Records Verification':          { bg:'#FEF3C7', fg:'#854D0E' },
  'Verified':                      { bg:'#E0E7FF', fg:'#3730A3' },
  'Awaiting Payment':              { bg:'#FFEDD5', fg:'#9A3412' },
  'Payment Verification Pending':  { bg:'#DBEAFE', fg:'#1E40AF' },
  'Payment Verification Failed':   { bg:'#FEE2E2', fg:'#991B1B' },
  'Payment Verified':              { bg:'#CCFBF1', fg:'#115E59' },
  'Modified Report Submitted':     { bg:'#CCFBF1', fg:'#115E59' },
  'Revision Required':             { bg:'#FFE4E6', fg:'#9F1239' },
  'Released':                      { bg:'#DCFCE7', fg:'#166534' },
  'Resolved':                      { bg:'#DCFCE7', fg:'#166534' },
  'Rejected':                      { bg:'#FEE2E2', fg:'#991B1B' },
};

function lvBadge(status) {
  const c = LV_STATUS_COLORS[status] || { bg:'#E5E7EB', fg:'#374151' };
  return `<span style="display:inline-block;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:600;background:${c.bg};color:${c.fg}">${esc(status)}</span>`;
}

// Live legacy lifecycle stage: the verification gate first, then (once verified)
// the normal copy/concern pipeline stage — all surfaced in this one console.
function lvDisplayStatus(r) {
  const ls = r.legacy_status || 'Records Verification';
  if (ls === 'Records Verification' || ls === 'Rejected') return ls;
  if (r.sent_at) return 'Released';
  if (r.nature === 'report_concern') return r.concern_status || 'Verified';
  return r.report_request_status || 'Verified';
}

function lvFmtDate(d) {
  if (!d) return '—';
  try { return new Date(d).toLocaleString('en-US', { year:'numeric', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }); }
  catch (_) { return '—'; }
}

function lvNatureLabel(n) {
  return n === 'report_concern' ? 'Concern' : 'Additional Copies';
}

async function refreshLegacyBadge() {
  try {
    const d = await api('/requests/legacy-verifications');
    const open = (d.data || []).filter(r => r.legacy_status === 'Records Verification').length;
    const b = document.getElementById('legacyBadge');
    if (b) b.textContent = open;
  } catch (_) { /* non-director or unavailable */ }
}

async function loadLegacyVerifications() {
  try {
    const d = await api('/requests/legacy-verifications');
    LV_DATA = d.data || [];
    renderLegacyTable();
    refreshLegacyBadge();
  } catch (e) { toast(e.message || 'Failed to load legacy requests', 'error'); }
}

function renderLegacyTable() {
  const body = document.getElementById('legacyBody');
  const empty = document.getElementById('emptyLegacy');
  if (!body) return;
  if (!LV_DATA.length) { body.innerHTML = ''; if (empty) empty.classList.remove('hidden'); return; }
  if (empty) empty.classList.add('hidden');
  body.innerHTML = LV_DATA.map(r => {
    const pending = r.legacy_status === 'Records Verification';
    // Needs a CD action: verify (pending) or release (payment verified, not sent).
    const actionable = pending || (r.payment_status === 'verified' && !r.sent_at);
    const action = actionable
      ? `<button class="btn btn-primary btn-sm" onclick="openLegacyReview(${r.id})">${pending ? 'Verify' : 'Review'}</button>`
      : `<button class="btn btn-outline btn-sm" onclick="openLegacyReview(${r.id})">View</button>`;
    return `<tr>
      <td><strong>${esc(r.client_name || '—')}</strong></td>
      <td>${esc(r.ticket_number || '—')}</td>
      <td>${esc(lvNatureLabel(r.nature))}</td>
      <td>${lvFmtDate(r.date_submitted)}</td>
      <td>${lvBadge(lvDisplayStatus(r))}</td>
      <td class="col-actions">${action}</td>
    </tr>`;
  }).join('');
}

// Open an uploaded blob (ID / attachment) in a properly-sized viewer window.
async function lvOpenFile(id, type) {
  try {
    const d = await api('/requests/' + id + '/file?type=' + type);
    const { name, dataUrl } = d.data || {};
    if (!dataUrl) { toast('File not found', 'error'); return; }
    const w = window.open('', '_blank');
    if (!w) { toast('Allow pop-ups to view the file.', 'error'); return; }
    const isImg = /^data:image\//.test(dataUrl);
    const inner = isImg
      ? `<img src="${dataUrl}" style="max-width:100%;height:auto;display:block;margin:0 auto">`
      : `<iframe src="${dataUrl}" style="border:0;position:fixed;inset:0;width:100%;height:100%"></iframe>`;
    w.document.write(`<!doctype html><title>${esc(name || 'file')}</title><body style="margin:0;background:#111">${inner}</body>`);
    w.document.close();
  } catch (e) { toast(e.message, 'error'); }
}

function lvField(label, valueHtml) {
  return `<div style="display:flex;gap:10px;padding:5px 0;font-size:13px;border-bottom:1px solid #f1f5f9">
    <div style="min-width:150px;color:#64748b;font-weight:600">${esc(label)}</div>
    <div style="color:#1f2937;flex:1">${valueHtml}</div></div>`;
}

async function openLegacyReview(id) {
  showLoading();
  try {
    const d = await api('/requests/' + id);
    const r = d.data; lvCurrentId = id; lvCurrentRow = r;
    const pending = (r.legacy_status || 'Records Verification') === 'Records Verification';
    const isConcern = r.nature === 'report_concern';
    const fullName = [r.client_given_name, r.client_mi, r.client_family_name].filter(Boolean).join(' ') || r.client_account_name || '';
    let concerns = '';
    try { const c = Array.isArray(r.concerns) ? r.concerns : JSON.parse(r.concerns || '[]'); concerns = c.map(esc).join(', '); } catch (_) {}

    document.getElementById('lvReviewTitle').textContent =
      pending ? 'Verify Legacy Request' : 'Legacy Request';

    let html = '';
    html += `<div style="font-weight:600;margin:2px 0 6px;color:#15306E">Client-Provided Details</div>`;
    html += lvField('Name', esc(fullName || ''));
    html += lvField('Reference', `<b>${esc(r.ticket_number)}</b>`);
    html += lvField('Request', esc(lvNatureLabel(r.nature)) + (isConcern ? '' : ` (${esc(String(r.copies || 1))})`));
    if (r.guardian_name) html += lvField('Guardian', esc(r.guardian_name));
    if (r.assessment_date) html += lvField('Approx. Assessment Date', lvFmtDate(r.assessment_date));
    if (r.center_branch) html += lvField('Center / Branch', esc(r.center_branch));
    if (r.contact_number) html += lvField('Contact', esc(r.contact_number));
    html += lvField('Valid ID', r.has_id_document
      ? `<a href="#" onclick="lvOpenFile(${id},'id_document');return false">View uploaded ID</a>`
      : '<span style="color:#b42318">Not provided</span>');
    html += lvField('Report Scan', r.has_attachment
      ? `<a href="#" onclick="lvOpenFile(${id},'attachment');return false">View attached report</a>` : 'None');

    if (isConcern) {
      html += `<div style="margin:12px 0 6px;padding:11px 13px;border-radius:10px;border:1.5px solid #F59E0B;background:#FFFBEB">
        <div style="font-weight:700;color:#92400E;font-size:12px;text-transform:uppercase;letter-spacing:.04em;margin-bottom:5px">Concern</div>
        <div style="font-size:13px;color:#1f2937"><b>${esc(concerns || 'Report Concern')}</b>${r.concern_other ? ` · ${esc(r.concern_other)}` : ''}</div>
        <div style="font-size:13px;color:#374151;margin-top:5px;white-space:pre-wrap">${esc(r.description || '')}</div>
      </div>`;
    } else {
      html += lvField('Description', `<span style="white-space:pre-wrap">${esc(r.description || '')}</span>`);
    }
    html += lvField('Status', lvBadge(lvDisplayStatus(r)));
    if (r.legacy_status === 'Rejected' && r.rejection_reason)
      html += lvField('Rejection Reason', `<span style="color:#9F1239">${esc(r.rejection_reason)}</span>`);
    if (r.concern_status === 'Revision Required' && r.concern_revision_note)
      html += lvField('Revision Note', `<span style="color:#9F1239">${esc(r.concern_revision_note)}</span>`);

    const act = document.getElementById('lvReviewActions');

    if (pending) {
      // Verification + digitization form.
      html += `<div style="margin-top:14px;padding:12px 14px;border-radius:10px;background:#f8fafc;border:1px solid #e2e8f0">
        <div style="font-weight:700;color:#15306E;font-size:13px;margin-bottom:8px">Register &amp; Digitize the Report</div>
        <div style="font-size:12px;color:#64748b;margin-bottom:10px">Verify the client's identity against the ID, locate the physical report, then upload the official scanned/typed PDF. This creates the released report record and hands the request to the normal ${isConcern ? 'concern' : 'copy'} pipeline.</div>
        <div style="margin-bottom:10px">
          <label style="font-size:12px;font-weight:600;color:#334155;display:block;margin-bottom:4px">Digitized report PDF *</label>
          <input type="file" id="lvReportPdf" accept="application/pdf,image/jpeg,image/png" class="form-control" style="width:100%">
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <div style="flex:1;min-width:160px">
            <label style="font-size:12px;font-weight:600;color:#334155;display:block;margin-bottom:4px">Client name on report</label>
            <input type="text" id="lvClientName" class="form-control" style="width:100%" value="${esc(fullName || '')}">
          </div>
          <div style="width:140px">
            <label style="font-size:12px;font-weight:600;color:#334155;display:block;margin-bottom:4px">Fee (₱)</label>
            <input type="number" id="lvFee" class="form-control" style="width:100%" min="0" step="0.01" value="1.00">
          </div>
        </div>
        <div id="lvRejectWrap" style="display:none;margin-top:10px">
          <label style="font-size:12px;font-weight:600;color:#b42318;display:block;margin-bottom:4px">Reason for rejection *</label>
          <textarea id="lvRejectReason" class="form-control" style="width:100%;min-height:64px" placeholder="e.g. identity could not be verified / no record found"></textarea>
        </div>
      </div>`;
      document.getElementById('lvReviewBody').innerHTML = html;
      act.innerHTML =
        `<button class="btn btn-danger" onclick="lvToggleReject()">Reject</button>` +
        `<button class="btn btn-success" onclick="lvApprove(${id})">Approve &amp; Register</button>` +
        `<button class="btn btn-outline" onclick="closeModal('lvReviewModal')">Close</button>`;
    } else {
      // Verified — the whole legacy lifecycle is managed from here (no Report
      // Requests / Report Concerns involvement). Legacy requests (copy AND concern)
      // are delivered as the digitized report: the only action is Release Report
      // once payment is verified. The report is never modified in-app.
      if (r.report_id) html += lvField('Linked Report', `#${esc(String(r.report_id))}`);
      html += lvField('Payment', esc((r.payment_status || 'none').replace(/_/g, ' ')));
      document.getElementById('lvReviewBody').innerHTML = html;

      let btns = '';
      const paymentVerified = r.payment_status === 'verified';
      if (r.sent_at) {
        btns += `<span style="align-self:center;color:#166534;font-size:12.5px">Released to the client.</span>`;
      } else if (paymentVerified) {
        btns += `<button class="btn btn-success" onclick="lvReleaseCopy(${id},${r.report_id || 'null'})">Release Report</button>`;
      } else {
        btns += `<span style="align-self:center;color:#64748b;font-size:12.5px">Awaiting client payment / payment verification.</span>`;
      }
      btns += `<button class="btn btn-outline" onclick="closeModal('lvReviewModal')">Close</button>`;
      act.innerHTML = btns;
    }
    openModal('lvReviewModal');
  } catch (e) { toast(e.message, 'error'); }
  hideLoading();
}

function lvToggleReject() {
  const wrap = document.getElementById('lvRejectWrap');
  if (!wrap) return;
  const showing = wrap.style.display !== 'none';
  if (!showing) {
    wrap.style.display = 'block';
    document.getElementById('lvReviewActions').innerHTML =
      `<button class="btn btn-danger" onclick="lvReject(${lvCurrentId})">Confirm Rejection</button>` +
      `<button class="btn btn-outline" onclick="openLegacyReview(${lvCurrentId})">Back</button>`;
  }
}

function lvReadFile(input) {
  return new Promise((resolve, reject) => {
    const f = input && input.files && input.files[0];
    if (!f) { resolve(null); return; }
    const rd = new FileReader();
    rd.onload = () => resolve({ dataUrl: rd.result, name: f.name, type: f.type, size: f.size });
    rd.onerror = reject;
    rd.readAsDataURL(f);
  });
}

async function lvApprove(id) {
  const fileInput = document.getElementById('lvReportPdf');
  const file = await lvReadFile(fileInput);
  if (!file) { toast('Upload the digitized report PDF first.', 'error'); return; }
  if (!['application/pdf', 'image/jpeg', 'image/png'].includes(file.type)) { toast('Report must be a PDF, JPG, or PNG.', 'error'); return; }
  if (file.size > 20 * 1024 * 1024) { toast('Report file must be under 20 MB.', 'error'); return; }
  const clientName = (document.getElementById('lvClientName') || {}).value || '';
  const amount = (document.getElementById('lvFee') || {}).value || '';
  showLoading();
  try {
    await api('/requests/' + id + '/legacy-verify', {
      method: 'PUT',
      body: JSON.stringify({
        action: 'approve',
        reportPdf: file.dataUrl, reportFilename: file.name,
        clientName: clientName || null,
        amount: amount || null,
      }),
    });
    toast('Verified & registered. The client has been notified to proceed to payment.');
    closeModal('lvReviewModal');
    loadLegacyVerifications();
  } catch (e) { toast(e.message, 'error'); }
  hideLoading();
}

async function lvReject(id) {
  const reason = ((document.getElementById('lvRejectReason') || {}).value || '').trim();
  if (!reason) { toast('A rejection reason is required.', 'error'); return; }
  showLoading();
  try {
    await api('/requests/' + id + '/legacy-verify', { method: 'PUT', body: JSON.stringify({ action: 'reject', reason }) });
    toast('Legacy request rejected — client notified.');
    closeModal('lvReviewModal');
    loadLegacyVerifications();
  } catch (e) { toast(e.message, 'error'); }
  hideLoading();
}

// Release the digitized legacy report to the client (delivers the seeded version
// via the normal send endpoint). Used for both copies and concerns.
async function lvReleaseCopy(requestId, reportId) {
  showLoading();
  try {
    await api('/requests/' + requestId + '/send', { method: 'POST' });
    toast('Report released to the client.');
    closeModal('lvReviewModal');
    loadLegacyVerifications();
  } catch (e) { toast(e.message, 'error'); }
  hideLoading();
}

// Deep-link: psych-reports.html?legacy=<id> from the CD notification.
function lvInitDeepLink() {
  try {
    const lid = new URLSearchParams(location.search).get('legacy');
    if (!lid) return;
    const open = () => {
      if (typeof USER !== 'undefined' && USER && USER.role === 'clinical_director') {
        if (typeof showView === 'function') showView('legacyVerifications');
        openLegacyReview(parseInt(lid, 10));
      }
    };
    if (typeof USER !== 'undefined' && USER) open(); else setTimeout(lvInitDeepLink, 400);
  } catch (_) {}
}
window.addEventListener('load', () => { setTimeout(lvInitDeepLink, 700); setTimeout(refreshLegacyBadge, 900); });
