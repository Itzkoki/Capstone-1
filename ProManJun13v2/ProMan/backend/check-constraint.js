const { Pool } = require('pg');
const p = new Pool({ host:'localhost', port:5432, user:'postgres', password:'123', database:'proman_db' });
async function run() {
  const r = await p.query("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'report_audit_logs_action_check'");
  console.log('Constraint:', r.rows[0]?.def);
  p.end();
}
run().catch(e => { console.error(e.message); p.end(); });
