const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const pool = new Pool({ host:'localhost', port:5432, user:'postgres', password:'123', database:'proman_db' });
const SECRET = 'your_super_secret_jwt_key_change_this';

pool.query("SELECT staff_id, first_name, last_name, username, role, email FROM staff WHERE username IN ('jah','han','jan','jay') ORDER BY role")
.then(r => {
  r.rows.forEach(s => {
    const token = jwt.sign({ id: s.staff_id, role: s.role, email: s.email, isStaff: true }, SECRET, { expiresIn: '24h' });
    console.log(s.username + '|' + s.role + '|' + s.staff_id + '|' + token);
  });
  // Also get CD from users table
  return pool.query("SELECT id, full_name, email, role FROM users WHERE email = 'kikofeutech@gmail.com'");
}).then(r => {
  if (r && r.rows.length) {
    const u = r.rows[0];
    const token = jwt.sign({ id: u.id, role: u.role, email: u.email }, SECRET, { expiresIn: '24h' });
    console.log('cd_user|' + u.role + '|' + u.id + '|' + token);
  }
  // Check if CD is in staff table
  return pool.query("SELECT staff_id, first_name, last_name, username, role, email FROM staff WHERE email = 'kikofeutech@gmail.com'");
}).then(r => {
  if (r && r.rows.length) {
    const s = r.rows[0];
    const token = jwt.sign({ id: s.staff_id, role: s.role, email: s.email, isStaff: true }, SECRET, { expiresIn: '24h' });
    console.log('cd_staff|' + s.role + '|' + s.staff_id + '|' + token);
  }
  pool.end();
}).catch(e => { console.error('ERR:', e.message); pool.end(); });
