const { Pool } = require('pg');
const p = new Pool({ host:'localhost', port:5432, user:'postgres', password:'123', database:'proman_db' });
async function run() {
  const r = await p.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name='cases' ORDER BY ordinal_position");
  console.log('=== cases table ===');
  r.rows.forEach(c => console.log('  ' + c.column_name + ': ' + c.data_type));

  const r2 = await p.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name='intake_forms' ORDER BY ordinal_position");
  console.log('\n=== intake_forms table ===');
  r2.rows.forEach(c => console.log('  ' + c.column_name + ': ' + c.data_type));

  const r3 = await p.query("SELECT count(*) as cnt FROM intake_forms");
  console.log('\n  intake_forms count: ' + r3.rows[0].cnt);

  const r4 = await p.query("SELECT count(*) as cnt FROM cases");
  console.log('  cases count: ' + r4.rows[0].cnt);

  p.end();
}
run().catch(e => { console.error(e.message); p.end(); });
