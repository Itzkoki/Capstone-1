require('dotenv').config();
const db = require('./config/db');
(async () => {
  const tables = ['report_versions', 'report_approvals', 'report_audit_logs', 'report_permissions',
                  'assessment_data', 'test_scores', 'generated_narratives'];
  for (const t of tables) {
    const r = await db.query(`SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position`, [t]);
    console.log(`\n=== ${t} (${r.rows.length} columns) ===`);
    r.rows.forEach(row => console.log(`  ${row.column_name} | ${row.data_type} | nullable: ${row.is_nullable}`));
    
    // Check FKs
    const fk = await db.query(`
      SELECT kcu.column_name, ccu.table_name AS ref_table, ccu.column_name AS ref_col
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
      JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
      WHERE tc.table_name = $1 AND tc.constraint_type = 'FOREIGN KEY'`, [t]);
    if (fk.rows.length) {
      console.log('  FKs:');
      fk.rows.forEach(row => console.log(`    ${row.column_name} -> ${row.ref_table}(${row.ref_col})`));
    }
  }
  process.exit();
})();
