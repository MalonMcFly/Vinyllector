// scripts/check-users.cjs  (Sustituye el archivo existente)
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

try {
  console.log('--- CHECK-DB START ---');
  console.log('Node version:', process.version);
  console.log('Working dir:', process.cwd());

  const dbPath = path.join(process.cwd(), 'data.sqlite');
  console.log('Comprobando existencia de DB en:', dbPath);
  if (!fs.existsSync(dbPath)) {
    console.error('ERROR: data.sqlite NO existe en la carpeta actual.');
    console.log('Archivos en la carpeta:');
    console.log(fs.readdirSync(process.cwd()).join(', '));
    process.exit(1);
  }
  const stats = fs.statSync(dbPath);
  console.log(`DB encontrada. Tamaño: ${stats.size} bytes. Última modificación: ${stats.mtime}`);

  const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
    if (err) {
      console.error('ERROR abriendo DB:', err.message);
      process.exit(1);
    }
    console.log('DB abierta correctamente.');
  });

  db.serialize(() => {
    // 1) listar tablas
    db.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';", (err, tables) => {
      if (err) {
        console.error('Error listando tablas:', err.message);
        db.close();
        process.exit(1);
      }
      console.log('Tablas detectadas:', tables.map(t => t.name).join(', '));

      const probable = tables.map(t => t.name).find(n => /user|usuario|account|cuenta/i.test(n)) || tables[0];
      console.log('Tabla probable para usuarios:', probable);

      // 2) esquema de la tabla elegida (si existe)
      db.all(`PRAGMA table_info(${probable});`, (err2, cols) => {
        if (err2) {
          console.error(`Error obteniendo PRAGMA para ${probable}:`, err2.message);
          db.close();
          process.exit(1);
        }
        console.log(`Columnas en ${probable}:`, cols.map(c => c.name).join(', '));

        // 3) intentar listar filas (si la tabla parece tener columna username)
        const usernameCol = cols.map(c => c.name).find(n => /username|user|login|nombre|name|usuario/i.test(n));
        const passwordCol = cols.map(c => c.name).find(n => /password|pass|pwd|contrasena|clave/i.test(n));
        if (!usernameCol) {
          console.warn('No detecté una columna obvia de username en', probable);
        } else {
          const pwdSelect = passwordCol ? `, ${passwordCol}` : '';
          const sql = `SELECT ${usernameCol}${pwdSelect} FROM ${probable} LIMIT 200;`;
          db.all(sql, (err3, rows) => {
            if (err3) {
              console.error('Error consultando filas:', err3.message);
            } else {
              console.log(`Filas (max 200) en ${probable}:`);
              console.table(rows);
            }
            console.log('--- CHECK-DB END ---');
            db.close();
          });
        }
      });
    });
  });

} catch (e) {
  console.error('ERROR en script:', e && e.stack ? e.stack : e);
  process.exit(1);
}
