// scripts/count_testusers.cjs
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('data.sqlite');
db.get("SELECT COUNT(*) AS c FROM users WHERE username LIKE 'testuser%'", (err, row) => {
  if (err) { console.error('Error:', err.message); process.exit(1); }
  console.log('Testusers encontrados:', row.c);
  db.close();
});
