// scripts/keep-admin.js
// Uso: node scripts/keep-admin.js [ruta/a/data.sqlite] [adminUsername] [adminPassword]
// Ejemplo: node scripts/keep-admin.js data.sqlite admin 1234

const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const { promisify } = require('util');

const DB_ARG = process.argv[2] || path.join(__dirname, '..', 'data.sqlite');
const ADMIN_USER = process.argv[3] || 'admin';
const ADMIN_PASS = process.argv[4] || '1234';
const SALT_ROUNDS = 10;

let bcrypt;
try {
  bcrypt = require('bcrypt'); // intenta bcrypt nativo
} catch (e) {
  // si falla (compilación en entornos windows), usa bcryptjs (pure JS)
  bcrypt = require('bcryptjs');
  // bcryptjs API es compatible en este uso
}

if (!fs.existsSync(DB_ARG)) {
  console.error(`No se encontró DB en: ${DB_ARG}`);
  process.exit(1);
}

const db = new sqlite3.Database(DB_ARG, sqlite3.OPEN_READWRITE, (err) => {
  if (err) {
    console.error('Error abriendo DB:', err.message);
    process.exit(1);
  }
});

const dbAll = promisify(db.all.bind(db));
const dbGet = promisify(db.get.bind(db));
function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

(async () => {
  try {
    // 1) Encontrar tablas (evitar sqlite_*)
    const tbls = await dbAll("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';");
    const names = tbls.map(t => t.name);
    // intenta encontrar tabla relacionada con usuarios
    let table = names.find(n => /user|usuario|account|cuenta/i.test(n)) || 'users';
    if (!names.includes(table)) {
      console.warn('No se encontró tabla obvia de usuarios. Tablas detectadas:', names.join(', '));
      console.warn(`Intentaré usar: "${table}". Si falla, revisa manualmente con: sqlite3 ${DB_ARG} ".tables"`);
    } else {
      console.log('Tabla seleccionada para revisar/usar:', table);
    }

    // 2) Obtener columnas de la tabla
    const cols = await dbAll(`PRAGMA table_info(${table});`);
    if (!cols || cols.length === 0) {
      throw new Error(`No se obtuvo esquema para la tabla "${table}". Revisa nombre de la tabla.`);
    }
    const colNames = cols.map(c => c.name);
    console.log('Columnas encontradas en', table, ':', colNames.join(', '));

    // 3) Detectar columnas de username y password (nombres comunes)
    const usernameCol = colNames.find(n => /^(username|user|login|nombre|name|usuario)$/i.test(n));
    const passwordCol = colNames.find(n => /^(password|pass|pwd|contrasena|contrasenha|clave)$/i.test(n));
    const roleCol = colNames.find(n => /^(role|rol|tipo|type)$/i.test(n));

    if (!usernameCol || !passwordCol) {
      throw new Error(`No pude detectar columnas username/password en "${table}". Columnas: ${colNames.join(', ')}`);
    }

    // 4) Detectar si la DB ya almacena hashes bcrypt (mira algunos valores)
    const samplePasswords = await dbAll(`SELECT ${passwordCol} FROM ${table} WHERE ${passwordCol} IS NOT NULL LIMIT 10;`);
    const bcryptRegex = /^\$2[aby]\$.{56}$/; // patrón típico bcrypt
    const hasBcrypt = samplePasswords.some(r => bcryptRegex.test(String(r[passwordCol] || '')));
    console.log('Detectado uso de bcrypt (aprox):', hasBcrypt);

    // 5) Borrar todos los usuarios excepto admin (según usernameCol)
    const deleteRes = await dbRun(`DELETE FROM ${table} WHERE ${usernameCol} <> ?;`, [ADMIN_USER]);
    console.log(`Borradas filas (usuarios distintos de "${ADMIN_USER}"): ${deleteRes.changes}`);

    // 6) Asegurar existencia del admin
    let adminRow = await dbGet(`SELECT * FROM ${table} WHERE ${usernameCol} = ?;`, [ADMIN_USER]);
    if (!adminRow) {
      // Insert minimal: username + password (+ role si existe)
      let colsInsert = [usernameCol, passwordCol];
      let placeholders = ['?', '?'];
      let values = [ADMIN_USER];
      // generaremos password (hash si es necesario)
      let passwordValue;
      if (hasBcrypt) {
        passwordValue = await bcrypt.hash(ADMIN_PASS, SALT_ROUNDS);
      } else {
        passwordValue = ADMIN_PASS;
      }
      values.push(passwordValue);

      if (roleCol) {
        colsInsert.push(roleCol);
        placeholders.push('?');
        values.push('admin');
      }

      const sql = `INSERT INTO ${table} (${colsInsert.join(',')}) VALUES (${placeholders.join(',')});`;
      await dbRun(sql, values);
      console.log(`Admin insertado con username="${ADMIN_USER}".`);
    } else {
      // Actualizar contraseña de admin
      let passwordValue;
      if (hasBcrypt) {
        passwordValue = await bcrypt.hash(ADMIN_PASS, SALT_ROUNDS);
      } else {
        passwordValue = ADMIN_PASS;
      }
      await dbRun(`UPDATE ${table} SET ${passwordCol} = ? WHERE ${usernameCol} = ?;`, [passwordValue, ADMIN_USER]);
      console.log(`Contraseña de "${ADMIN_USER}" actualizada.`);
    }

    // 7) Report final
    const remaining = await dbAll(`SELECT ${usernameCol}${roleCol ? ','+roleCol : ''} FROM ${table};`);
    console.log('Usuarios finales en la tabla:');
    console.table(remaining);

    console.log('\nHecho. Recuerda mantener backup de data.sqlite.bak hasta verificar que todo funciona con JMeter.');
    db.close();
  } catch (err) {
    console.error('Error en script:', err.message);
    db.close();
    process.exit(1);
  }
})();
