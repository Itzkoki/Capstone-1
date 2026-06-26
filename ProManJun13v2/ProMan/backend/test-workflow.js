// ProMan Workflow Test Script
// Tests the full workflow: Intake → Payment → Assessment → Report → Release

const http = require('http');

const BASE = 'http://localhost:5000';
const TOKENS = {
  jah:  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6MTEsInJvbGUiOiJwc3ljaG9tZXRyaWNpYW4iLCJlbWFpbCI6InNhbGFtYW5rZXJvdzAwMUBnbWFpbC5jb20iLCJpc1N0YWZmIjp0cnVlLCJpYXQiOjE3ODE3MzAzNDgsImV4cCI6MTc4MTgxNjc0OH0._iAuALuHM2O5LzsBl_IwEhbaB0EixbQVG5D_0Nf0a0k',
  han:  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6MTAsInJvbGUiOiJxY19wc3ljaG9tZXRyaWNpYW4iLCJlbWFpbCI6InJvYmJpZXJhaW5lZmVycmVyQGdtYWlsLmNvbSIsImlzU3RhZmYiOnRydWUsImlhdCI6MTc4MTczMDM0OCwiZXhwIjoxNzgxODE2NzQ4fQ.mn3kzAfOH3nTqnTiWj9KHQkKYclC6A27PgOkhvnJnDM',
  jan:  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6OSwicm9sZSI6InBzeWNob2xvZ2lzdCIsImVtYWlsIjoicm93YmlyZXluQGdtYWlsLmNvbSIsImlzU3RhZmYiOnRydWUsImlhdCI6MTc4MTczMDM0OCwiZXhwIjoxNzgxODE2NzQ4fQ.U2A6SmG7mYzhwCM8iQ-JPPXV_lMBO_lAJh92V26Y-oU',
  jay:  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6OCwicm9sZSI6InN1cGVydmlzaW5nX3BzeWNob21ldHJpY2lhbiIsImVtYWlsIjoibWlkb3NoaW50YXJvdTI4QGdtYWlsLmNvbSIsImlzU3RhZmYiOnRydWUsImlhdCI6MTc4MTczMDM0OCwiZXhwIjoxNzgxODE2NzQ4fQ.6Lk1cT9zpKoK2y1sRrQ4UGLmMymp6Cs1eAkB9EHu45w',
  cd:   'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6MjEsInJvbGUiOiJjbGluaWNhbF9kaXJlY3RvciIsImVtYWlsIjoia2lrb2ZldXRlY2hAZ21haWwuY29tIiwiaWF0IjoxNzgxNzMwMzQ4LCJleHAiOjE3ODE4MTY3NDh9.5Fw-kMtuuFJLQgLcXDt_MMJGRfj849hWFqr5ZhrGDjo',
};

function req(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: 'localhost', port: 5000, path, method,
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      }
    };
    const r = http.request(opts, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function pass(msg) { console.log('  ✓ ' + msg); }
function fail(msg, detail) { console.log('  ✗ ' + msg); if (detail) console.log('    ' + JSON.stringify(detail).substring(0, 200)); }
function step(n, msg) { console.log('\n[Step ' + n + '] ' + msg); }

async function run() {
  console.log('=== ProMan Workflow Test ===\n');

  // ── 0. Check what clients exist ───────────────────────────────────────
  step(0, 'Check existing clients and cases');
  const clients = await req('GET', '/api/intake/clients', TOKENS.jah);
  if (clients.body.success) {
    pass('Got clients list. Count: ' + (clients.body.clients || []).length);
    if ((clients.body.clients || []).length > 0) {
      console.log('  First client:', JSON.stringify(clients.body.clients[0]).substring(0, 150));
    }
  } else {
    fail('Could not get clients', clients.body);
  }

  const cases = await req('GET', '/api/cases', TOKENS.jah);
  if (cases.body.success) {
    pass('Got cases list. Count: ' + (cases.body.cases || []).length);
    (cases.body.cases || []).slice(0, 3).forEach(c => {
      console.log('  Case: ' + c.case_id + ' | Status: ' + c.status + ' | Client: ' + (c.client_name || c.client_user_code));
    });
  } else {
    fail('Could not get cases', cases.body);
  }

  // ── 1. Find a case to test with ───────────────────────────────────────
  const allCases = cases.body.cases || [];

  // Try to find a case at each stage to test that specific step
  const pendingCase = allCases.find(c => c.status === 'Pending Intake Review');
  const awaitingPayment = allCases.find(c => c.status === 'Awaiting Initial Payment');
  const awaitingAppt = allCases.find(c => c.status === 'Awaiting Appointment');
  const scheduled = allCases.find(c => c.status === 'Scheduled');
  const inProgress = allCases.find(c => c.status === 'Assessment In Progress');
  const assessDone = allCases.find(c => c.status === 'Assessment Completed');
  const reportDraft = allCases.find(c => c.status === 'Report Drafting');
  const awaitingApproval = allCases.find(c => c.status === 'Awaiting Director Approval');

  console.log('\n  Cases by stage:');
  console.log('  Pending Intake Review:    ' + (pendingCase ? pendingCase.case_id : 'none'));
  console.log('  Awaiting Initial Payment: ' + (awaitingPayment ? awaitingPayment.case_id : 'none'));
  console.log('  Awaiting Appointment:     ' + (awaitingAppt ? awaitingAppt.case_id : 'none'));
  console.log('  Scheduled:                ' + (scheduled ? scheduled.case_id : 'none'));
  console.log('  Assessment In Progress:   ' + (inProgress ? inProgress.case_id : 'none'));
  console.log('  Assessment Completed:     ' + (assessDone ? assessDone.case_id : 'none'));
  console.log('  Report Drafting:          ' + (reportDraft ? reportDraft.case_id : 'none'));
  console.log('  Awaiting Approval:        ' + (awaitingApproval ? awaitingApproval.case_id : 'none'));

  // ── 2. Test each workflow action on the relevant case ──────────────────
  if (pendingCase) {
    step('3', 'Intake Review — jah (Psychometrician) approves: ' + pendingCase.case_id);
    const r = await req('POST', '/api/cases/' + pendingCase.case_id + '/review', TOKENS.jah, { action: 'approve' });
    r.body.success ? pass('Intake approved → ' + (r.body.case?.status || '')) : fail('Intake approve failed', r.body);
  }

  if (awaitingPayment) {
    step('6', 'Verify Payment — jay (Sup.Psy) verifies: ' + awaitingPayment.case_id);
    const r = await req('POST', '/api/cases/' + awaitingPayment.case_id + '/payment/verify', TOKENS.jay, {});
    r.body.success ? pass('Payment verified → ' + (r.body.case?.status || '')) : fail('Payment verify failed', r.body);
  }

  if (awaitingAppt) {
    step('4/5', 'Schedule Appointment — jay (Sup.Psy) schedules: ' + awaitingAppt.case_id);
    const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];
    const r = await req('POST', '/api/cases/' + awaitingAppt.case_id + '/schedule', TOKENS.jay, { appointment_date: tomorrow + 'T09:00:00' });
    r.body.success ? pass('Scheduled → ' + (r.body.case?.status || '')) : fail('Schedule failed', r.body);
  }

  if (scheduled) {
    step('7a', 'Start Assessment — jan (Psychologist) starts: ' + scheduled.case_id);
    const r = await req('POST', '/api/cases/' + scheduled.case_id + '/assessment/start', TOKENS.jan, {});
    r.body.success ? pass('Assessment started → ' + (r.body.case?.status || '')) : fail('Start assessment failed', r.body);
  }

  if (inProgress) {
    step('7b', 'Complete Assessment — jan (Psychologist) completes: ' + inProgress.case_id);
    const r = await req('POST', '/api/cases/' + inProgress.case_id + '/assessment/complete', TOKENS.jan, {});
    r.body.success ? pass('Assessment completed → ' + (r.body.case?.status || '')) : fail('Complete assessment failed', r.body);
  }

  // ── 3. Test reports workflow ───────────────────────────────────────────
  if (assessDone || reportDraft) {
    const c = assessDone || reportDraft;
    const detail = await req('GET', '/api/cases/' + c.case_id, TOKENS.jay);
    const reports = detail.body.case?.reports || [];

    if (reports.length === 0 && assessDone) {
      step('8', 'Create Report in PsyGen — jay (Sup.Psy) creates report for: ' + c.case_id);
      // Check if a template exists first
      const tpls = await req('GET', '/api/report-templates', TOKENS.jay);
      const templates = tpls.body.templates || [];
      if (templates.length > 0) {
        const rpt = await req('POST', '/api/reports', TOKENS.jay, {
          template_id: templates[0].id,
          client_name: detail.body.case?.client_name || 'Test Client',
          client_age: 25, client_gender: 'Male',
          date_of_assessment: new Date().toISOString().split('T')[0],
          case_id: c.case_id
        });
        rpt.body.success ? pass('Report created: ' + rpt.body.report?.report_code) : fail('Create report failed', rpt.body);
        if (rpt.body.success) {
          const rptId = rpt.body.report.id;
          step('8b', 'Sup.Psy submits as Prepared (workflow/prepare)');
          const prep = await req('POST', '/api/reports/' + rptId + '/workflow/prepare', TOKENS.jay, {});
          prep.body.success ? pass('Report → Prepared. Case should be Report Drafting') : fail('workflowPrepare failed', prep.body);
        }
      } else {
        fail('No templates found — cannot create report');
      }
    } else if (reports.length > 0) {
      const rptId = reports[0].id;
      const rptStatus = reports[0].status;
      console.log('\n  Existing report ID: ' + rptId + ' | Status: ' + rptStatus);

      if (rptStatus === 'draft') {
        step('8b', 'jay submits as Prepared (workflow/prepare)');
        const r = await req('POST', '/api/reports/' + rptId + '/workflow/prepare', TOKENS.jay, {});
        r.body.success ? pass('→ Prepared') : fail('workflowPrepare failed', r.body);
      }
      if (rptStatus === 'Prepared') {
        step('9', 'han (QCP) submits for psychologist review (workflow/review)');
        const r = await req('POST', '/api/reports/' + rptId + '/workflow/review', TOKENS.han, {});
        r.body.success ? pass('→ Review. Case should be Awaiting Director Approval') : fail('workflowReview failed', r.body);
      }
      if (rptStatus === 'Review') {
        step('10', 'jan (Psychologist) approves report (workflow/approve)');
        const r = await req('POST', '/api/reports/' + rptId + '/workflow/approve', TOKENS.jan, {});
        r.body.success ? pass('→ Approved. Case should be Report Approved') : fail('workflowApprove failed', r.body);
      }
    }
  }

  if (awaitingApproval) {
    const detail = await req('GET', '/api/cases/' + awaitingApproval.case_id, TOKENS.jan);
    const reports = detail.body.case?.reports || [];
    if (reports.length > 0) {
      step('10', 'jan (Psychologist) approves: ' + awaitingApproval.case_id);
      const r = await req('POST', '/api/reports/' + reports[0].id + '/workflow/approve', TOKENS.jan, {});
      r.body.success ? pass('Report approved → Case: Report Approved') : fail('workflowApprove failed', r.body);
    }
  }

  // ── 4. Test RBAC guards ────────────────────────────────────────────────
  step('RBAC', 'Test that wrong roles are blocked');
  if (pendingCase || awaitingPayment) {
    const testCaseId = (pendingCase || awaitingPayment).case_id;
    // QCP trying to verify payment should fail
    const r = await req('POST', '/api/cases/' + testCaseId + '/payment/verify', TOKENS.han, {});
    !r.body.success || r.status === 403
      ? pass('QCP correctly blocked from payment/verify')
      : fail('QCP should NOT be allowed to verify payment!', r.body);
  }

  console.log('\n=== Test complete ===\n');
}

run().catch(e => console.error('Fatal:', e));
