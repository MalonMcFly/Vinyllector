import express from 'express';
import path from 'path';
import url from 'url';
import dotenv from 'dotenv';
import morgan from 'morgan';
import session from 'express-session';
import cookieParser from 'cookie-parser';
import methodOverride from 'method-override';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { stringify } from 'csv-stringify';

dotenv.config();
const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3000;

// --- DB ---
const db = await open({
  filename: path.join(__dirname, 'data.sqlite'),
  driver: sqlite3.Database
});

async function bootstrap() {
  await db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS productos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo TEXT UNIQUE NOT NULL,
      nombre TEXT NOT NULL,
      precio INTEGER NOT NULL DEFAULT 0,
      stock INTEGER NOT NULL DEFAULT 0,
      categoria TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ventas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      producto_id INTEGER NOT NULL,
      cantidad INTEGER NOT NULL,
      total INTEGER NOT NULL,
      fecha TEXT NOT NULL,
      folio TEXT NOT NULL UNIQUE,
      FOREIGN KEY (producto_id) REFERENCES productos(id)
    );
  `);

  // seed admin
  const adminUser = process.env.ADMIN_USER || 'admin';
  const adminPass = process.env.ADMIN_PASS || '1234';
  await db.run(`INSERT OR IGNORE INTO users (username, password) VALUES (?,?)`, [adminUser, adminPass]);

  // seed productos iniciales
  const count = (await db.get(`SELECT COUNT(*) as c FROM productos`)).c;
  if (count === 0) {
    const items = [
      ['V-001','Vinilo — Pink Floyd - The Dark Side of the Moon',19990,15,'vinilos'],
      ['V-002','Vinilo — The Beatles - Abbey Road',18990,12,'vinilos'],
      ['T-100','Tornamesa Audio-Technica AT-LP60X',149990,6,'tornamesas'],
      ['A-210','Cepillo limpiador de vinilos',6990,30,'accesorios'],
      ['C-300','Combo: Tornamesa + Vinilo sorpresa',169990,5,'combos']
    ];
    for (const it of items) {
      await db.run(`INSERT INTO productos (codigo,nombre,precio,stock,categoria) VALUES (?,?,?,?,?)`, it);
    }
  }
}
await bootstrap();

// --- MIDDLEWARE ---
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());
app.use(methodOverride('_method'));
app.use(morgan('dev'));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'devsecret',
  resave: false,
  saveUninitialized: false,
}));

app.use((req,res,next)=>{
  const cart = Array.isArray(req.session?.cart) ? req.session.cart : [];
  const cartCount = cart.reduce((a,b)=> a + (b.cantidad || 0), 0);

  res.locals.auth = !!req.session.user;
  res.locals.user = req.session.user;
  res.locals.year = new Date().getFullYear();
  res.locals.cartCount = cartCount;
  next();
});


function requireAuth(req,res,next){
  if (!req.session.user) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  next();
}

// --- RUTAS PÚBLICAS ---
app.get('/', async (req,res)=>{
  const prdCount = (await db.get('SELECT COUNT(*) c FROM productos')).c;
  const ventasMes = await db.get(`
    SELECT COALESCE(SUM(total),0) s
    FROM ventas
    WHERE strftime('%m', fecha)=strftime('%m','now') AND strftime('%Y', fecha)=strftime('%Y','now')
  `);
  const acts = await db.all(`
    SELECT v.id, v.folio, p.nombre, v.fecha
    FROM ventas v JOIN productos p ON p.id=v.producto_id
    ORDER BY v.id DESC LIMIT 8
  `);
  // productos para el carril
  const destacados = await db.all(`SELECT * FROM productos ORDER BY id DESC LIMIT 12`);

  res.render('home', { prdCount, ventasMes: ventasMes.s, acts, destacados });
});

app.get('/tienda', async (req,res)=>{
  const productos = await db.all('SELECT * FROM productos ORDER BY categoria, nombre');
  res.render('tienda', { categoria: 'todos', productos });
});

app.get('/tienda/:cat', async (req,res)=>{
  const productos = await db.all('SELECT * FROM productos WHERE categoria=? ORDER BY nombre', [req.params.cat]);
  res.render('tienda', { categoria: req.params.cat, productos });
});

app.get('/sobre', (req,res)=> res.render('sobre'));
app.get('/blog', (req,res)=> res.render('blog'));

// --- CARRITO ---
app.use((req,res,next)=>{
  if (!req.session.cart) req.session.cart = []; // inicializar carrito
  next();
});

app.post('/cart/add', async (req,res)=>{
  const { producto_id, cantidad } = req.body;
  const p = await db.get('SELECT * FROM productos WHERE id=?', [producto_id]);
  const qty = Math.max(1, parseInt(cantidad||'1'));
  if (!p) return res.redirect('/tienda');

  const existing = req.session.cart.find(it => it.id === p.id);
  if (existing) existing.cantidad += qty;
  else req.session.cart.push({ id: p.id, cantidad: qty });

  res.redirect('/cart');
});

app.get('/cart', async (req,res)=>{
  if (!req.session.cart.length) return res.render('cart', { items: [], total: 0, msg:null });

  const ids = req.session.cart.map(it => it.id);
  const placeholders = ids.map(()=>'?').join(',');
  const productos = await db.all(`SELECT * FROM productos WHERE id IN (${placeholders})`, ids);

  const items = req.session.cart.map(it => {
    const p = productos.find(px => px.id === it.id);
    return { ...p, cantidad: it.cantidad };
  });

  const total = items.reduce((a,b)=> a + (b.precio * b.cantidad), 0);
  res.render('cart', { items, total, msg:null });
});

app.post('/cart/clear', (req,res)=>{ req.session.cart = []; res.redirect('/cart'); });

app.post('/cart/checkout', async (req,res)=>{
  const cart = req.session.cart || [];
  if (!cart.length) return res.redirect('/cart');

  const ids = cart.map(it => it.id);
  const placeholders = ids.map(()=>'?').join(',');
  const productos = await db.all(`SELECT * FROM productos WHERE id IN (${placeholders})`, ids);

  // validar stock
  for (const it of cart) {
    const p = productos.find(px => px.id === it.id);
    if (!p || p.stock < it.cantidad) {
      return res.render('cart', { 
        items: productos.map(px => ({ ...px, cantidad: cart.find(c=>c.id===px.id)?.cantidad || 0 })),
        total: productos.reduce((a,b)=> a + (b.precio * (cart.find(c=>c.id===b.id)?.cantidad || 0)), 0),
        msg: `Stock insuficiente para: ${p ? p.nombre : ('ID '+it.id)}`
      });
    }
  }

  // ejecutar compra
  try {
    await db.exec('BEGIN');
    for (const it of cart) {
      const p = productos.find(px => px.id === it.id);
      const total = p.precio * it.cantidad;
      const folio = Math.random().toString(36).slice(2,10).toUpperCase();
      const fecha = new Date().toISOString();
      await db.run('UPDATE productos SET stock=stock-? WHERE id=?', [it.cantidad, it.id]);
      await db.run('INSERT INTO ventas (producto_id,cantidad,total,fecha,folio) VALUES (?,?,?,?,?)',
        [it.id, it.cantidad, total, fecha, folio]);
    }
    await db.exec('COMMIT');
    req.session.cart = [];
    res.render('cart', { items: [], total: 0, msg:'Compra realizada con éxito 🎉' });
  } catch (e) {
    await db.exec('ROLLBACK');
    res.render('cart', { items: [], total: 0, msg:'Ocurrió un error al procesar la compra' });
  }
});


// --- AUTH ---
app.get('/login', (req,res)=> res.render('login', { next: req.query.next || '/' }));

app.post('/login', async (req,res)=>{
  const username = (req.body.username || '').trim().toLowerCase();
  const password = (req.body.password || '').trim();

  if (!username || !password) {
    return res.render('login', { error: 'Ingresa usuario y contraseña', next: req.body.next || '/' });
  }

  const row = await db.get(
    'SELECT id, username FROM users WHERE LOWER(username)=? AND password=?',
    [username, password]
  );

  if(!row){
    return res.render('login', { error:'Credenciales inválidas', next: req.body.next || '/' });
  }

  req.session.user = { id: row.id, username: row.username };
  res.redirect(req.body.next || '/admin');
});

app.post('/logout', (req,res)=> req.session.destroy(()=> res.redirect('/')));

// --- REGISTRO DE USUARIOS ---
app.get('/register', (req,res)=> res.render('register'));

app.post('/register', async (req,res)=>{
  const { username, password } = req.body;
  if (!username || !password) {
    return res.render('register', { error: 'Completa usuario y contraseña' });
  }

  try {
    await db.run(`INSERT INTO users (username, password) VALUES (?,?)`, [username, password]);
    const row = await db.get(`SELECT * FROM users WHERE username=?`, [username]);
    // iniciar sesión automáticamente
    req.session.user = { id: row.id, username: row.username };
    res.redirect('/');
  } catch (e) {
    res.render('register', { error: 'Usuario ya existe o inválido' });
  }
});


// --- ADMIN ---
app.get('/admin', requireAuth, async (req,res)=>{
  const prdCount = (await db.get('SELECT COUNT(*) c FROM productos')).c;
  const ventasMes = await db.get(`SELECT COALESCE(SUM(total),0) s FROM ventas WHERE strftime('%m', fecha)=strftime('%m','now') AND strftime('%Y', fecha)=strftime('%Y','now')`);
  const acts = await db.all(`SELECT v.id, v.folio, p.nombre, v.fecha FROM ventas v JOIN productos p ON p.id=v.producto_id ORDER BY v.id DESC LIMIT 8`);
  res.render('admin/dashboard', { prdCount, ventasMes: ventasMes.s, acts });
});

// CRUD productos
app.get('/admin/productos', requireAuth, async (req,res)=>{
  const q = req.query.q || '';
  const productos = await db.all(`SELECT * FROM productos WHERE codigo LIKE ? OR nombre LIKE ? ORDER BY id DESC`, [`%${q}%`,`%${q}%`]);
  res.render('admin/productos_list', { productos, q });
});
app.get('/admin/productos/new', requireAuth, (req,res)=> res.render('admin/productos_form', { item:null }));
app.post('/admin/productos', requireAuth, async (req,res)=>{
  const { codigo, nombre, precio, stock, categoria } = req.body;
  try { await db.run(`INSERT INTO productos (codigo,nombre,precio,stock,categoria) VALUES (?,?,?,?,?)`, [codigo, nombre, parseInt(precio), parseInt(stock), categoria]); res.redirect('/admin/productos'); }
  catch(e){ res.render('admin/productos_form', { item:null, error:'Error: '+e.message }); }
});
app.get('/admin/productos/:id/edit', requireAuth, async (req,res)=>{ const item = await db.get('SELECT * FROM productos WHERE id=?',[req.params.id]); if(!item) return res.redirect('/admin/productos'); res.render('admin/productos_form', { item }); });
app.post('/admin/productos/:id', requireAuth, async (req,res)=>{
  const { codigo, nombre, precio, stock, categoria } = req.body;
  try { await db.run(`UPDATE productos SET codigo=?, nombre=?, precio=?, stock=?, categoria=? WHERE id=?`, [codigo, nombre, parseInt(precio), parseInt(stock), categoria, req.params.id]); res.redirect('/admin/productos'); }
  catch(e){ const item = await db.get('SELECT * FROM productos WHERE id=?',[req.params.id]); res.render('admin/productos_form', { item, error:'Error: '+e.message }); }
});
app.post('/admin/productos/:id/delete', requireAuth, async (req,res)=>{ try{ await db.run('DELETE FROM productos WHERE id=?',[req.params.id]); }catch{} res.redirect('/admin/productos'); });

// Procesos (ventas)
app.get('/admin/procesos', requireAuth, async (req,res)=>{
  const productos = await db.all('SELECT * FROM productos ORDER BY nombre');
  const ventas = await db.all(`SELECT v.*, p.nombre as producto_nombre FROM ventas v JOIN productos p ON p.id=v.producto_id ORDER BY v.id DESC LIMIT 10`);
  res.render('admin/procesos', { productos, ventas, msg:null });
});
app.post('/admin/procesos', requireAuth, async (req,res)=>{
  const { producto_id, cantidad } = req.body;
  const p = await db.get('SELECT * FROM productos WHERE id=?', [producto_id]);
  const qty = Math.max(1, parseInt(cantidad||'1'));
  if (!p || p.stock < qty) {
    const productos = await db.all('SELECT * FROM productos ORDER BY nombre');
    const ventas = await db.all(`SELECT v.*, p.nombre as producto_nombre FROM ventas v JOIN productos p ON p.id=v.producto_id ORDER BY v.id DESC LIMIT 10`);
    return res.render('admin/procesos', { productos, ventas, msg:'Stock insuficiente o producto no existe' });
  }
  const total = p.precio * qty;
  const folio = Math.random().toString(36).slice(2,10).toUpperCase();
  const fecha = new Date().toISOString();
  await db.run('UPDATE productos SET stock=stock-? WHERE id=?', [qty, producto_id]);
  await db.run('INSERT INTO ventas (producto_id,cantidad,total,fecha,folio) VALUES (?,?,?,?,?)', [producto_id, qty, total, fecha, folio]);
  res.redirect('/admin/procesos');
});

// Reportes
app.get('/admin/reportes', requireAuth, async (req,res)=>{
  const { desde, hasta } = req.query;
  const where=[]; const params=[];
  if (desde){ where.push("date(fecha) >= date(?)"); params.push(desde); }
  if (hasta){ where.push("date(fecha) <= date(?)"); params.push(hasta); }
  const ventas = await db.all(`
    SELECT v.*, p.nombre as producto_nombre, p.precio as precio_unit
    FROM ventas v JOIN productos p ON p.id=v.producto_id
    ${where.length? 'WHERE '+where.join(' AND '):''}
    ORDER BY v.fecha DESC`, params);
  const total = ventas.reduce((a,b)=>a+b.total,0);
  res.render('admin/reportes', { ventas, total, desde, hasta });
});
app.get('/admin/reportes.csv', requireAuth, async (req,res)=>{
  const ventas = await db.all(`SELECT v.*, p.nombre as producto_nombre, p.precio as precio_unit FROM ventas v JOIN productos p ON p.id=v.producto_id ORDER BY v.fecha DESC`);
  res.setHeader('Content-Type','text/csv; charset=utf-8');
  res.setHeader('Content-Disposition','attachment; filename=reporte_ventas.csv');
  const s = stringify({ header:true, columns:['Fecha','Producto','Cantidad','Precio','Total','Folio'] });
  s.pipe(res);
  ventas.forEach(v => s.write([new Date(v.fecha).toLocaleString('es-CL'), v.producto_nombre, v.cantidad, v.precio_unit, v.total, v.folio]));
  s.end();
});

// 404
app.use((req,res)=> res.status(404).render('404'));

app.listen(PORT, ()=> console.log('✅ VinylHub en http://localhost:' + PORT));
