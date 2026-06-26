const { Pool } = require('pg');
const p = new Pool({ host:'localhost', port:5432, user:'postgres', password:'123', database:'proman_db' });
async function run() {
  const r = await p.query(`
    SELECT c.case_id, c.status, c.user_id, c.assigned_psychologist_id,
           u.full_name AS client_name, u.user_code,
           i.full_name AS intake_name, i.review_status AS intake_review_status
    FROM cases c
    LEFT JOIN users u ON u.id = c.user_id
    LEFT JOIN intake_forms i ON i.case_id = c.case_id
    ORDER BY c.created_at DESC
  `);
  console.log('=== ALL CASES ===');
  r.rows.forEach(c => console.log(`  ${c.case_id} | ${c.status} | client: ${c.client_name} (${c.user_code}) | intake: ${c.intake_name} | review: ${c.intake_review_status} | psych_id: ${c.assigned_psychologist_id}`));

  // Check intake forms without cases
  const r2 = await p.query(`SELECT id, full_name, review_status, case_id, preferred_schedule, created_at FROM intake_forms ORDER BY id DESC LIMIT 5`);
  console.log('\n=== RECENT INTAKE FORMS ===');
  r2.rows.forEach(i => console.log(`  id:${i.id} | ${i.full_name} | status:${i.review_status} | case_id:${i.case_id}`));

  // Check preferred_psychologist_id column
  const r3 = await p.query(`SELECT column_name FROM information_schema.columns WHERE table_name='intake_forms' AND column_name LIKE '%psych%'`);
  console.log('\n=== intake_forms psych columns ===');
  r3.rows.forEach(c => console.log('  ' + c.column_name));

  p.end();
}
run().catch(e => { console.error(e.message); p.end(); });
