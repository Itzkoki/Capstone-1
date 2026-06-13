// Quick script to test the intake forms API and check the database table
const { Pool } = require('pg');
const pool = new Pool({
  host: 'localhost',
  port: 5432,
  user: 'postgres',
  password: '123',
  database: 'proman_db',
});

(async () => {
  try {
    // 1. Check table columns
    const cols = await pool.query(
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'intake_forms' ORDER BY ordinal_position`
    );
    console.log('=== INTAKE_FORMS COLUMNS ===');
    cols.rows.forEach(c => console.log(`  ${c.column_name} (${c.data_type})`));

    // 2. Check row count
    const count = await pool.query('SELECT COUNT(*) as cnt FROM intake_forms');
    console.log('\n=== ROW COUNT:', count.rows[0].cnt, '===');

    // 3. Check if 'full_name' column exists
    const hasFullName = cols.rows.some(c => c.column_name === 'full_name');
    console.log('\nHas full_name column:', hasFullName);
    
    // 4. Check if 'form_data' column exists
    const hasFormData = cols.rows.some(c => c.column_name === 'form_data');
    console.log('Has form_data column:', hasFormData);

    // 5. If rows exist, show a sample
    if (parseInt(count.rows[0].cnt) > 0) {
      const sample = await pool.query('SELECT id, user_id, full_name FROM intake_forms LIMIT 3');
      console.log('\n=== SAMPLE ROWS ===');
      sample.rows.forEach(r => console.log(r));
    }

    // 6. Check users table for the login user
    const userCheck = await pool.query("SELECT id, email, full_name, role FROM users WHERE email = 'vantoasp@gmail.com'");
    console.log('\n=== USER INFO ===');
    console.log(userCheck.rows[0] || 'NOT FOUND');

  } catch (e) {
    console.error('ERROR:', e.message);
  } finally {
    await pool.end();
  }
})();
