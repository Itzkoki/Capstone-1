/* ══════════════════════════════════════════════════════════
   PSYGEN — Report Requests (Clinical Director)
   Review → approve/reject, verify payment, and send report.
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
    html += rrField('Amount', r.payment_amount!=null?('₱'+Number(r.payment_amount).toFixed(2)):'—');
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