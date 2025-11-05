// scripts/show_users.cjs
// Muestra id, username y password de la tabla users
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('data.sqlite', sqlite3.OPEN_READONLY, err => {
  if (err) {
    console.error('Error abriendo DB:', err.message);
    process.exit(1);
  }
});

db.all('SELECT id, username, password FROM users ORDER BY id', (err, rows) => {
  if (err) {
    console.error('Error consultando users:', err.message);
    process.exit(1);
  }
  console.table(rows);
  db.close();
});

