const { Pool } = require('pg');
const p = new Pool({ host:'localhost', port:5432, user:'postgres', password:'123', database:'proman_db' });
async function run() {
  // Drop old constraint and recreate with new workflow actions added
  await p.query('ALTER TABLE report_audit_logs DROP CONSTRAINT report_audit_logs_action_check');
  await p.query(`ALTER TABLE report_audit_logs ADD CONSTRAINT report_audit_logs_action_check CHECK (action IN (
    'created','edited','submitted','approved','rejected','viewed','downloaded',
    'version_restored','finalized','deleted','restored','archived','unarchived',
    'template_created','template_updated','template_deleted',
    'prepared','reviewed','revision_requested','locked','unlocked'
  ))`);
  console.log('Constraint updated successfully.');
  p.end();
}
run().catch(e => { console.error(e.message); p.end(); });
