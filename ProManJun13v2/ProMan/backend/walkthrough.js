// End-to-end workflow walkthrough with notification + status assertions.
// Creates a fresh assessment case as a client and drives it to report generation.
const http = require('http');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
require('dotenv').config();
const SECRET = process.env.JWT_SECRET;
const pool = new Pool({ host:'localhost', port:5432, user:'postgres', password:'123', database:'proman_db' });

function req(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = { hostname:'localhost', port:5000, path, method, headers:{
      'Authorization':'Bearer '+token, 'Content-Type':'application/json',
      ...(data?{'Content-Length':Buffer.byteLength(data)}:{}) } };
    const r = http.request(opts, res => { let raw=''; res.on('data',d=>raw+=d);
      res.on('end',()=>{ try{resolve({status:res.statusCode,body:JSON.parse(raw)});}catch{resolve({status:res.statusCode,body:raw});} }); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
const log = (...a)=>console.log(...a);
const J = o => JSON.stringify(o);

let TOK = {};
async function tokens() {
  const staff = await pool.query("SELECT staff_id,role,email FROM staff WHERE staff_id IN (5,26,25,24,21)");
  const map = { 5:'psymet', 26:'sup', 25:'qc', 24:'psych', 21:'cd' };
  staff.rows.forEach(s => { TOK[map[s.staff_id]] = jwt.sign({id:s.staff_id,role:s.role,email:s.email,type:'staff'},SECRET,{expiresIn:'2h'}); });
  const cl = await pool.query("SELECT id,role,email FROM users WHERE id=39");
  const c = cl.rows[0];
  TOK.client = jwt.sign({id:c.id,role:c.role,email:c.email},SECRET,{expiresIn:'2h'});
  TOK.clientId = c.id;
}

async function maxNotifId(){ const r=await pool.query("SELECT COALESCE(MAX(id),0) m FROM notifications"); return r.rows[0].m; }
async function showNotifs(afterId, label){
  const r = await pool.query(`
    SELECT n.id,n.recipient_type,n.user_id,n.type,n.title,
      COALESCE(s.role, u.role, '?') AS role
    FROM notifications n
    LEFT JOIN staff s ON n.recipient_type='staff' AND s.staff_id=n.user_id
    LEFT JOIN users u ON n.recipient_type='user'  AND u.id=n.user_id
    WHERE n.id>$1 ORDER BY n.id`,[afterId]);
  log(`  NOTIFS (${label}): ${r.rows.length}`);
  r.rows.forEach(n=>log(`    → [${n.recipient_type}/${n.role}] "${n.title}"`));
  return r.rows;
}
async function caseStatus(caseId){ const r=await pool.query("SELECT status FROM cases WHERE case_id=$1",[caseId]); return r.rows[0]&&r.rows[0].status; }
async function reportRow(caseId){ const r=await pool.query("SELECT id,status,signature_stage,case_id FROM psychological_reports WHERE case_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1",[caseId]); return r.rows[0]; }

async function main(){
  await tokens();
  log('Tokens ready for:', Object.keys(TOK).filter(k=>k!=='clientId').join(', '));

  // ── STEP 1: Client submits assessment intake ──────────────────────
  let n0 = await maxNotifId();
  const future = new Date(Date.now()+3*86400000); future.setHours(10,0,0,0);
  const intakePayload = {
    familyName:'Walk', givenName:'Through', middleName:'Test', nickname:'WT',
    birthdate:'2010-01-01', age:16, sex:'Male', contactNumber:'09171234567',
    email:'walkthrough@test.com', homeAddress:'123 Test St', primaryLanguage:['English'],
    reasonForReferral:'Clinical Assessment',
    assessedBefore:'No', existingDiagnoses:'No', interventions:['None'], answeringFor:'Self',
    prefSchedule: future.toISOString(), modality:'Face-to-Face',
    counselorStaffId: 24, // assign psychologist Pan
    dataPrivacyConsent:true, codeOfEthicsConsent:true,
  };
  let r = await req('POST','/api/assessment-intake-forms',TOK.client,intakePayload);
  log('\n[1] Client submit assessment intake →', r.status, r.body.success? 'OK':J(r.body));
  if(!r.body.success){ log('ABORT'); return finish(); }
  const caseId = r.body.data.case_id; const apptId = r.body.data.appointment_id;
  log('  case_id:', caseId, '| appt:', apptId, '| status:', await caseStatus(caseId));
  await showNotifs(n0,'after intake');

  // ── STEP 2: Psychometrician approves intake ───────────────────────
  n0 = await maxNotifId();
  r = await req('POST',`/api/cases/${caseId}/review`,TOK.psymet,{decision:'approve'});
  log('\n[2] Psychometrician approve intake →', r.status, r.body.success?'OK':J(r.body));
  log('  status:', await caseStatus(caseId));
  await showNotifs(n0,'after intake approve');

  // ── STEP 3: SupPsy confirms appointment schedule ──────────────────
  n0 = await maxNotifId();
  r = await req('PUT',`/api/appointments/${apptId}/approve`,TOK.sup,{assessment_type:'clinical',modality:'Face-to-Face'});
  log('\n[3] SupPsy approve/confirm appointment →', r.status, r.body.success?'OK':J(r.body));
  log('  status:', await caseStatus(caseId));
  await showNotifs(n0,'after appt confirm');

  // ── STEP 4: Client creates payment + uploads proof ────────────────
  n0 = await maxNotifId();
  r = await req('POST','/api/payments',TOK.client,{ appointmentId:apptId, paymentOption:'full', agreed:true });
  log('\n[4] Client create payment →', r.status, r.body.success?'OK':J(r.body));
  const payId = (r.body.payment && r.body.payment.id) || (r.body.data && r.body.data.id);
  log('  payId:', payId);
  if(payId){
    const up = await req('POST',`/api/payments/${payId}/proof`,TOK.client,{ proof:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', filename:'proof.png' });
    log('  upload proof →', up.status, up.body.success?'OK':J(up.body));
  }
  await showNotifs(n0,'after payment submit');

  // ── STEP 5: SupPsy verifies payment ───────────────────────────────
  n0 = await maxNotifId();
  r = await req('PUT',`/api/payments/${payId}/verify`,TOK.sup,{ action:'approve' });
  log('\n[5] SupPsy verify payment →', r.status, r.body.success?'OK':J(r.body));
  log('  status:', await caseStatus(caseId));
  await showNotifs(n0,'after payment verify');

  // ── STEP 6: Psychologist starts assessment ────────────────────────
  n0 = await maxNotifId();
  r = await req('POST',`/api/cases/${caseId}/assessment/start`,TOK.psych,{});
  log('\n[6] Psychologist start assessment →', r.status, r.body.success?'OK':J(r.body));
  log('  status:', await caseStatus(caseId));
  await showNotifs(n0,'after start');

  // ── STEP 7: Psychologist completes assessment ─────────────────────
  n0 = await maxNotifId();
  r = await req('POST',`/api/cases/${caseId}/assessment/complete`,TOK.psych,{});
  log('\n[7] Psychologist complete assessment →', r.status, r.body.success?'OK':J(r.body));
  log('  status:', await caseStatus(caseId));
  await showNotifs(n0,'after complete');

  // ── STEP 8: SupPsy creates report (PsyGen) ────────────────────────
  n0 = await maxNotifId();
  const tpls = await req('GET','/api/report-templates',TOK.sup);
  const clinicalTpl = (tpls.body.templates||[]).find(t=>t.template_type==='clinical');
  log('\n[8] clinical template id:', clinicalTpl && clinicalTpl.id);
  if(!clinicalTpl){ log('  NO clinical template / templates unauthorized:', J(tpls.body).slice(0,120)); return finish(); }
  // fetch intake-clients to mimic UI client selection
  const ic = await req('GET','/api/reports/intake-clients',TOK.sup);
  const mine = (ic.body.clients||[]).find(c=>c.case_id===caseId);
  log('  intake-client for case present:', !!mine, mine?`(${mine.full_name})`:'');
  r = await req('POST','/api/reports',TOK.sup,{
    template_id: clinicalTpl.id,
    client_name: mine ? mine.full_name : 'Walk Through',
    client_age: mine? mine.age : 16, client_gender: mine? mine.gender : 'Male',
    date_of_assessment: new Date().toISOString().split('T')[0],
    client_id: mine? mine.user_id : TOK.clientId,
    case_id: caseId,
  });
  log('  create report →', r.status, r.body.success?('OK '+ (r.body.report&&r.body.report.report_code)) : J(r.body));
  const rep = await reportRow(caseId);
  log('  report row:', J(rep), '| case status:', await caseStatus(caseId));
  await showNotifs(n0,'after report create');
  const reportId = rep && rep.id;

  // ── STEP 9: Save assessment data ──────────────────────────────────
  if(reportId){
    r = await req('POST',`/api/reports/${reportId}/assessment`,TOK.sup,{
      tests_administered:[], observational_notes:'The client demonstrated cooperative behavior throughout the assessment session and engaged well.',
      behavioral_observations:'Client maintained good eye contact and responded appropriately to all questions asked.',
      interview_findings:'The interview revealed no significant concerns regarding mood, affect, or thought processes during evaluation.',
      additional_data:{},
    });
    log('\n[9] Save assessment data →', r.status, r.body.success?'OK':J(r.body));

    // ── STEP 10: Generate narratives ────────────────────────────────
    r = await req('POST',`/api/reports/${reportId}/generate-narratives`,TOK.sup,{});
    log('[10] Generate narratives →', r.status, r.body.success?('OK, sections='+(r.body.generated||[]).map(g=>g.key).join(',')):J(r.body));

    // ── STEP 10.5: Fill clinical Assessment Tests/Methods section ────
    const testsBlock = `[[TESTS_TABLE]]\nAssessment Tests and Methods||Date Administered\nWAIS-IV (Wechsler Adult Intelligence Scale)||${new Date().toISOString().split('T')[0]}\nBDI-II (Beck Depression Inventory)||${new Date().toISOString().split('T')[0]}\n[[/TESTS_TABLE]]`;
    r = await req('PUT',`/api/reports/${reportId}/sections/assessment_tests_methods`,TOK.sup,{ content: testsBlock });
    log('[10.5] Fill assessment_tests_methods →', r.status, r.body.success?'OK':J(r.body));
  }

  // ── STEP 11: workflow prepare → review → approve ──────────────────
  if(reportId){
    n0 = await maxNotifId();
    r = await req('POST',`/api/reports/${reportId}/workflow/prepare`,TOK.sup,{});
    log('\n[11] SupPsy prepare (→QC) →', r.status, r.body.success?'OK':J(r.body));
    log('  report:', J(await reportRow(caseId)), '| case:', await caseStatus(caseId));
    await showNotifs(n0,'after prepare');

    n0 = await maxNotifId();
    r = await req('POST',`/api/reports/${reportId}/workflow/review`,TOK.qc,{});
    log('[12] QC review (→Psych) →', r.status, r.body.success?'OK':J(r.body));
    log('  report:', J(await reportRow(caseId)), '| case:', await caseStatus(caseId));
    await showNotifs(n0,'after qc review');

    n0 = await maxNotifId();
    r = await req('POST',`/api/reports/${reportId}/workflow/approve`,TOK.psych,{});
    log('[13] Psych approve →', r.status, r.body.success?'OK':J(r.body));
    log('  report:', J(await reportRow(caseId)), '| case:', await caseStatus(caseId));
    await showNotifs(n0,'after approve');

    // ── STEP 14: SupPsy signs + submits to QC ───────────────────────
    const PDF = 'JVBERi0xLjQKJeLjz9MKMSAwIG9iago8PC9UeXBlL0NhdGFsb2c+PgplbmRvYmoKdHJhaWxlcgo8PC9Sb290IDEgMCBSPj4KJSVFT0Y=';
    n0 = await maxNotifId();
    r = await req('POST',`/api/reports/${reportId}/save-signed-pdf`,TOK.sup,{ pdf:PDF, signature_stage:'supervising' });
    log('\n[14] SupPsy save signed PDF →', r.status, r.body.success?'OK':J(r.body));
    r = await req('POST',`/api/reports/${reportId}/submit-to-qc`,TOK.sup,{});
    log('     SupPsy submit to QC →', r.status, r.body.success?'OK':J(r.body));
    log('  report:', J(await reportRow(caseId)), '| case:', await caseStatus(caseId));
    await showNotifs(n0,'after submit-to-qc');

    // ── STEP 15: QC signs + submits to Psychologist ─────────────────
    n0 = await maxNotifId();
    r = await req('POST',`/api/reports/${reportId}/save-signed-pdf`,TOK.qc,{ pdf:PDF, signature_stage:'quality_control' });
    log('[15] QC save signed PDF →', r.status, r.body.success?'OK':J(r.body));
    r = await req('POST',`/api/reports/${reportId}/mark-signed`,TOK.qc,{});
    log('     QC submit to Psychologist →', r.status, r.body.success?'OK':J(r.body));
    log('  report:', J(await reportRow(caseId)), '| case:', await caseStatus(caseId));
    await showNotifs(n0,'after mark-signed');

    // ── STEP 16: Psychologist signs + submits to Director ───────────
    n0 = await maxNotifId();
    r = await req('POST',`/api/reports/${reportId}/save-signed-pdf`,TOK.psych,{ pdf:PDF, signature_stage:'psychologist' });
    log('[16] Psych save signed PDF →', r.status, r.body.success?'OK':J(r.body));
    r = await req('POST',`/api/reports/${reportId}/submit-to-director`,TOK.psych,{});
    log('     Psych submit to Director →', r.status, r.body.success?'OK':J(r.body));
    log('  report:', J(await reportRow(caseId)), '| case:', await caseStatus(caseId));
    await showNotifs(n0,'after submit-to-director');

    // ── STEP 17: CD releases to client ──────────────────────────────
    n0 = await maxNotifId();
    r = await req('POST',`/api/reports/${reportId}/save-signed-pdf`,TOK.cd,{ pdf:PDF, signature_stage:'director' });
    log('[17] CD save signed PDF →', r.status, r.body.success?'OK':J(r.body));
    r = await req('POST',`/api/reports/${reportId}/release`,TOK.cd,{});
    log('     CD release →', r.status, r.body.success?'OK':J(r.body));
    log('  report:', J(await reportRow(caseId)), '| case:', await caseStatus(caseId));
    await showNotifs(n0,'after release');
  }

  log('\n=== WALKTHROUGH DONE ===  caseId='+caseId);
  finish();
}
function finish(){ pool.end(); }
main().catch(e=>{ console.error('FATAL',e); pool.end(); });
