const { Pool } = require('pg');
const pool = new Pool({ host:'localhost', port:5432, user:'postgres', password:'123', database:'proman_db' });

async function run() {
  const users = await pool.query("SELECT id, full_name, email, role, user_code FROM users ORDER BY id DESC LIMIT 5");
  console.log('=== USERS (clients) ===');
  users.rows.forEach(u => console.log('  id:' + u.id + ' | ' + u.full_name + ' | ' + u.email + ' | role:' + u.role + ' | code:' + u.user_code));

  const staff = await pool.query("SELECT staff_id, first_name, last_name, username, role FROM staff ORDER BY staff_id");
  console.log('\n=== STAFF ===');
  staff.rows.forEach(s => console.log('  id:' + s.staff_id + ' | ' + s.first_name + ' ' + s.last_name + ' | ' + s.username + ' | ' + s.role));

  const cases = await pool.query("SELECT case_id, status, client_name, assigned_psychologist_id FROM cases ORDER BY created_at DESC LIMIT 5");
  console.log('\n=== CASES (last 5) ===');
  cases.rows.length ? cases.rows.forEach(c => console.log('  ' + c.case_id + ' | ' + c.status + ' | ' + c.client_name + ' | psych_id:' + c.assigned_psychologist_id)) : console.log('  (none)');

  const intakes = await pool.query("SELECT id, status, full_name, preferred_psychologist_id FROM intake_forms ORDER BY id DESC LIMIT 5");
  console.log('\n=== INTAKE FORMS (last 5) ===');
  intakes.rows.length ? intakes.rows.forEach(i => console.log('  id:' + i.id + ' | ' + i.status + ' | ' + i.full_name + ' | pref_psych:' + i.preferred_psychologist_id)) : console.log('  (none)');

  const rpts = await pool.query("SELECT id, report_code, status, client_name, case_id FROM psychological_reports ORDER BY id DESC LIMIT 5");
  console.log('\n=== REPORTS (last 5) ===');
  rpts.rows.length ? rpts.rows.forEach(r => console.log('  id:' + r.id + ' | ' + r.report_code + ' | ' + r.status + ' | ' + r.client_name + ' | case:' + r.case_id)) : console.log('  (none)');

  const tpls = await pool.query("SELECT id, name, template_type FROM report_templates LIMIT 5");
  console.log('\n=== TEMPLATES ===');
  tpls.rows.length ? tpls.rows.forEach(t => console.log('  id:' + t.id + ' | ' + t.name + ' | ' + t.template_type)) : console.log('  (none)');

  pool.end();
}
run().catch(e => { console.error(e.message); pool.end(); });
