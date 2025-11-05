// scripts/remove_header_user.cjs
// Borra el usuario que se insertó por la cabecera: username
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('data.sqlite');

db.run("DELETE FROM users WHERE username = 'username'", function(err) {
  if (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
  console.log('Deleted rows:', this.changes);
  db.close();
});
