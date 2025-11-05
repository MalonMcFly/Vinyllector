// scripts/jmeter.users.cjs
// Uso: node scripts/jmeter.users.cjs [ruta_csv]
// Ej: node scripts/jmeter.users.cjs scripts/jmeter-users.csv

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const csvPath = process.argv[2] || path.join('scripts','jmeter-users.csv');
const dbPath = path.join(process.cwd(), 'data.sqlite');

if (!fs.existsSync(csvPath)) {
  console.error('CSV no encontrado:', csvPath);
  process.exit(1);
}
if (!fs.existsSync(dbPath)) {
  console.error('DB no encontrada:', dbPath);
  process.exit(1);
}

// lee CSV y extrae usernames,passwords
const lines = fs.readFileSync(csvPath, 'utf8')
  .split(/\r?\n/)
  .map(l => l.trim())
  .filter(Boolean);

const pairs = lines.map(line => {
  const parts = line.split(',').map(p => p.trim());
  return { username: parts[0] || '', password: parts[1] || '' };
}).filter(p => p.username);

const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE, (err) => {
  if (err) {
    console.error('Error abriendo DB:', err.message);
    process.exit(1);
  }
});

(async function main() {
  try {
    // 1) detectar tablas
    const tbls = await new Promise((res, rej) =>
      db.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';", (e,r) => e?rej(e):res(r))
    );
    const names = tbls.map(t => t.name);
    const table = names.find(n => /user|usuario|account|cuenta/i.test(n)) || names[0];
    if (!table) throw new Error('No encontré tabla de usuarios. Tablas: ' + names.join(', '));
    console.log('Usando tabla:', table);

    // 2) detectar columnas username/password
    const cols = await new Promise((res, rej) =>
      db.all(`PRAGMA table_info(${table});`, (e,r) => e?rej(e):res(r))
    );
    const colNames = cols.map(c => c.name);
    const usernameCol = colNames.find(n => /^(username|user|login|nombre|name|usuario)$/i.test(n));
    const passwordCol = colNames.find(n => /^(password|pass|pwd|contrasena|clave)$/i.test(n));
    const roleCol = colNames.find(n => /^(role|rol|tipo|type)$/i.test(n));

    if (!usernameCol || !passwordCol) throw new Error(`No detecté columnas username/password en ${table}. Columnas: ${colNames.join(', ')}`);
    console.log('Columnas detectadas -> username:', usernameCol, ', password:', passwordCol, roleCol ? (', role: '+roleCol) : '');

    // 3) detectar si DB usa bcrypt (mira algunos registros)
    const sample = await new Promise((res, rej) => db.all(
      `SELECT ${passwordCol} AS pwd FROM ${table} WHERE ${passwordCol} IS NOT NULL LIMIT 10;`,
      (e,r) => e?rej(e):res(r)
    ));
    const bcryptRegex = /^\$2[aby]\$.{56}$/;
    const hasBcrypt = sample.some(r => bcryptRegex.test(String(r.pwd || '')));
    console.log('Detected bcrypt in DB (approx):', hasBcrypt);

    // carga bcryptjs (no requiere compilación)
    const bcrypt = require('bcryptjs');
    const SALT_ROUNDS = 10;

    // 4) preparar statement
    const existsStmt = `SELECT COUNT(1) AS c FROM ${table} WHERE ${usernameCol} = ?`;
    const insertCols = [usernameCol, passwordCol];
    if (roleCol) insertCols.push(roleCol);
    const placeholders = insertCols.map(_ => '?').join(',');
    const insertSql = `INSERT INTO ${table} (${insertCols.join(',')}) VALUES (${placeholders})`;

    let inserted = 0, skippedBad = 0, already = 0;

    await new Promise((resolve, reject) => {
      db.serialize(() => {
        db.run('BEGIN TRANSACTION');
        const checkStmt = db.prepare(existsStmt);
        const insertStmt = db.prepare(insertSql);

        for (const p of pairs) {
          const u = p.username;
          const pwd = p.password;

          // SALTAR usuarios "malos" (contienen 'malo' o 'bad')
          if (/malo|bad/i.test(u)) {
            skippedBad++;
            continue;
          }

          // comprobar existencia
          checkStmt.get(u, (err, row) => {
            if (err) {
              console.error('Error check exist:', err.message);
              return;
            }
            const exists = row && row.c > 0;
            if (exists) {
              already++;
              // nada más
            } else {
              // preparar password (hash si DB usa bcrypt)
              (async () => {
                try {
                  const passwordToStore = hasBcrypt ? await bcrypt.hash(pwd || '1234', SALT_ROUNDS) : (pwd || '1234');
                  const params = [u, passwordToStore];
                  if (roleCol) params.push('client');
                  insertStmt.run(params, function(err2) {
                    if (err2) {
                      console.error('Error insert:', err2.message, 'user:', u);
                    } else {
                      inserted++;
                    }
                  });
                } catch (e) {
                  console.error('Hash error:', e && e.message);
                }
              })();
            }
          });
        } // end for

        // finalize after slight delay to allow async hashes to finish
        // we'll poll for completion: wait until all callbacks likely finished
        setTimeout(() => {
          insertStmt.finalize(err => {
            if (err) console.error('Error finalizing insertStmt:', err.message);
            checkStmt.finalize();
            db.run('COMMIT', (err2) => {
              if (err2) return reject(err2);
              resolve();
            });
          });
        }, 800); // 0.8s should be enough for small batches; adjust si tu CSV es enorme
      });
    });

    console.log('Resultado: insertados=', inserted, ', yaExistian=', already, ', saltados_malos=', skippedBad);
    console.log('Si ves menos insertados de los esperados, revisa constraints o el tamaño del timeout en el script.');
    db.close();
  } catch (err) {
    console.error('Error script:', err && err.message ? err.message : err);
    db.close();
    process.exit(1);
  }
})();
