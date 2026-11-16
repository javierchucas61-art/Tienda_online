require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const nodemailer = require('nodemailer');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'cambiar-clave';

// 🟢 NUEVO: Ruta dinámica para guardar datos (Local o en la Nube)
const DATA_DIR = process.env.DATA_DIR || __dirname;
const UPLOADS = path.join(DATA_DIR, 'uploads');

if (!fs.existsSync(UPLOADS)) fs.mkdirSync(UPLOADS, { recursive: true });

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS));

// ---------- CONFIGURACIÓN DE CORREO (BREVO) ----------
const transporter = nodemailer.createTransport({
  host: "smtp-relay.brevo.com",
  port: 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// ---------- DB ----------
// 🟢 CAMBIO: Usa DATA_DIR en lugar de __dirname
const db = new Database(path.join(DATA_DIR, 'store.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS categories (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, slug TEXT NOT NULL UNIQUE);
  CREATE TABLE IF NOT EXISTS products (id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT, price REAL NOT NULL, stock INTEGER NOT NULL DEFAULT 0, category TEXT, image TEXT, active INTEGER DEFAULT 1);
  CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE NOT NULL, status TEXT NOT NULL DEFAULT 'pending', method TEXT NOT NULL, titular TEXT, total REAL NOT NULL, customer_name TEXT NOT NULL, customer_phone TEXT NOT NULL, customer_email TEXT, customer_address TEXT NOT NULL, customer_ref TEXT, customer_note TEXT, proof_path TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS order_items (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL, product_id INTEGER NOT NULL, name TEXT NOT NULL, price REAL NOT NULL, quantity INTEGER NOT NULL);
`);

try { db.prepare('ALTER TABLE orders ADD COLUMN customer_email TEXT').run(); } catch (e) {}

if (db.prepare('SELECT COUNT(*) c FROM categories').get().c === 0) {
  const ins = db.prepare('INSERT INTO categories (name, slug) VALUES (?,?)');
  ins.run('Electrónicos', 'electronicos');
  ins.run('Cuidado Personal', 'cuidado-personal');
  ins.run('Accesorios', 'accesorios');
  ins.run('Otros', 'otros');
}

if (db.prepare('SELECT COUNT(*) c FROM products').get().c === 0) {
  const ins = db.prepare('INSERT INTO products (id,name,description,price,stock,category,image) VALUES (?,?,?,?,?,?,?)');
  ins.run(1,'Audifonos 1HORA','Audífonos inalámbricos deportivos/diarios.',20.00,5,'electronicos','mejor.jpg');
  ins.run(2,'AXE Excite','Desodorante en spray de larga duración.',20.00,1,'cuidado-personal','AXE-N.jpg');
}

io.on('connection', (socket) => {
  socket.on('unirseAlPedido', (codigoPedido) => {
    socket.join(codigoPedido);
    console.log('🟢 Cliente conectado en tiempo real al pedido:', codigoPedido);
  });
});

function generateCode() {
  const d = new Date();
  const base = 'JA-' + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0') + '-';
  for (let i = 0; i < 30; i++) {
    const c = base + Math.floor(100 + Math.random() * 900);
    if (!db.prepare('SELECT 1 FROM orders WHERE code=?').get(c)) return c;
  }
  throw new Error('No se pudo generar código');
}

async function sendEmailNotification(order, newStatus) {
  if (!order.customer_email || !process.env.EMAIL_USER) return;

  const statusText = {
    confirmed: '✅ Pago Confirmado',
    shipped: '🛵 Tu pedido está en camino',
    delivered: '📦 Pedido Entregado',
    rejected: '❌ Pedido Rechazado'
  }[newStatus] || 'Actualización de Pedido';

  const color = newStatus === 'rejected' ? '#d32f2f' : '#2e7d32';
  const mensaje = newStatus === 'confirmed' ? 'Hemos verificado tu pago correctamente. Ya estamos preparando tu pedido.' :
                  newStatus === 'shipped' ? 'Tu pedido ya salió de nuestras manos y está en camino a tu domicilio.' :
                  newStatus === 'delivered' ? '¡Tu pedido ha sido entregado! Esperamos que lo disfrutes.' :
                  'Hubo un problema con la verificación de tu pago. Por favor, contáctanos.';

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #eee; border-radius: 10px; overflow: hidden;">
      <div style="background: #4f3625; padding: 20px; text-align: center; color: white;">
        <h1 style="margin: 0; font-size: 24px;">Motupe Delivery</h1>
      </div>
      <div style="padding: 30px; background: #fcf6f0;">
        <h2 style="color: ${color}; margin-top: 0;">${statusText}</h2>
        <p style="color: #555; font-size: 16px;">Hola <b>${order.customer_name}</b>,</p>
        <p style="color: #555; font-size: 16px;">${mensaje}</p>
        
        <div style="background: white; padding: 15px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #b48b6f;">
          <p style="margin: 0; color: #777;">Código de Pedido:</p>
          <h3 style="margin: 5px 0 0 0; color: #4f3625; font-size: 20px;">${order.code}</h3>
          <p style="margin: 5px 0 0 0; color: #777;">Total: <b>S/ ${order.total.toFixed(2)}</b></p>
        </div>

        <p style="color: #555; font-size: 14px;">Si tienes alguna duda, puedes responder a este correo o escribirnos al WhatsApp.</p>
      </div>
      <div style="background: #ede3d9; padding: 15px; text-align: center; color: #777; font-size: 12px;">
        © ${new Date().getFullYear()} Motupe Delivery. Todos los derechos reservados.
      </div>
    </div>
  `;

  try {
    await transporter.sendMail({
      from: `"Motupe Delivery" <javierchucas61@gmail.com>`,
      to: order.customer_email,
      subject: `${statusText} - Pedido ${order.code}`,
      html: html
    });
    console.log(`📧 Correo enviado a ${order.customer_email} sobre el estado: ${newStatus}`);
  } catch (error) {
    console.error('❌ Error al enviar correo:', error.message);
  }
}

app.get('/api/products', (req, res) => {
  res.json(db.prepare('SELECT id,name,description,price,stock,category,image FROM products WHERE active=1').all());
});

app.get('/api/categories', (req, res) => {
  res.json(db.prepare('SELECT * FROM categories').all());
});

app.post('/api/orders/quote', (req, res) => {
  const { items } = req.body || {};
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'Carrito vacío' });
  try {
    let subtotal = 0;
    for (const it of items) {
      const p = db.prepare('SELECT * FROM products WHERE id=? AND active=1').get(it.id);
      if (!p) throw new Error('Producto no encontrado: ' + it.id);
      const qty = parseInt(it.quantity, 10);
      if (!Number.isInteger(qty) || qty <= 0) throw new Error('Cantidad inválida');
      if (qty > p.stock) throw new Error(`Stock insuficiente: ${p.name}`);
      subtotal += p.price * qty;
    }
    const code = generateCode();
    const cents = (parseInt(code.slice(-1)) % 9 + 1) / 100;
    const total = Math.round((subtotal + cents) * 100) / 100;
    res.json({ code, cents, subtotal: Math.round(subtotal * 100) / 100, total });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/orders', (req, res) => {
  const { items, customer = {}, method, titular = '', proof = null, code: clientCode = null } = req.body || {};
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'Carrito vacío' });
  if (!customer.name || customer.name.trim().length < 3) return res.status(400).json({ error: 'Nombre inválido' });
  if (!/^9\d{8}$/.test(customer.phone || '')) return res.status(400).json({ error: 'Celular inválido' });
  if (!customer.address || customer.address.trim().length < 6) return res.status(400).json({ error: 'Dirección inválida' });
  if (!['Yape', 'Plin'].includes(method)) return res.status(400).json({ error: 'Método inválido' });

  try {
    const result = db.transaction(() => {
      const lines = [];
      let subtotal = 0;
      for (const it of items) {
        const p = db.prepare('SELECT * FROM products WHERE id=? AND active=1').get(it.id);
        if (!p) throw new Error('Producto no encontrado');
        const qty = parseInt(it.quantity, 10);
        if (qty > p.stock) throw new Error(`Stock insuficiente: ${p.name}`);
        subtotal += p.price * qty;
        lines.push({ id: p.id, name: p.name, price: p.price, quantity: qty });
      }
      let code = clientCode;
      if (!code || db.prepare('SELECT 1 FROM orders WHERE code=?').get(code)) code = generateCode();
      const cents = (parseInt(code.slice(-1)) % 9 + 1) / 100;
      const total = Math.round((subtotal + cents) * 100) / 100;
      const now = Date.now();

      const info = db.prepare(`INSERT INTO orders (code,status,method,titular,total,customer_name,customer_phone,customer_email,customer_address,customer_ref,customer_note,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        code, 'pending', method, titular, total, customer.name.trim(), customer.phone, customer.email || '', customer.address.trim(), customer.ref || '', customer.note || '', now, now
      );
      const orderId = info.lastInsertRowid;
      const insItem = db.prepare('INSERT INTO order_items (order_id,product_id,name,price,quantity) VALUES (?,?,?,?,?)');
      const dec = db.prepare('UPDATE products SET stock = stock - ? WHERE id=? AND stock >= ?');
      for (const l of lines) {
        insItem.run(orderId, l.id, l.name, l.price, l.quantity);
        if (dec.run(l.quantity, l.id, l.quantity).changes !== 1) throw new Error('Conflicto de stock');
      }

      let proofPath = null;
      if (proof && typeof proof === 'string' && proof.startsWith('data:image/')) {
        const m = proof.match(/^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/i);
        if (m) {
          const buf = Buffer.from(m[2], 'base64');
          const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
          const filename = 'proof_' + code + '.' + ext;
          fs.writeFileSync(path.join(UPLOADS, filename), buf);
          proofPath = '/uploads/' + filename;
          db.prepare('UPDATE orders SET proof_path=? WHERE id=?').run(proofPath, orderId);
        }
      }
      return { id: orderId, code, total, items: lines };
    })();
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/orders/:code', (req, res) => {
  const o = db.prepare('SELECT code,status,total,created_at,method FROM orders WHERE code=?').get(req.params.code);
  if (!o) return res.status(404).json({ error: 'Pedido no encontrado' });
  res.json(o);
});

const tokens = new Map();
function auth(req, res, next) {
  const t = (req.headers.authorization || '').replace(/^Bearer\s+/, '');
  const exp = tokens.get(t);
  if (!exp || exp < Date.now()) return res.status(401).json({ error: 'No autorizado' });
  next();
}

app.post('/api/admin/login', (req, res) => {
  if ((req.body || {}).password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Clave incorrecta' });
  const token = crypto.randomBytes(24).toString('hex');
  tokens.set(token, Date.now() + 1000 * 60 * 60 * 8);
  res.json({ token });
});

app.get('/api/admin/orders', auth, (req, res) => {
  const orders = db.prepare('SELECT * FROM orders ORDER BY created_at DESC').all();
  const items = db.prepare('SELECT product_id id,name,price,quantity FROM order_items WHERE order_id=?');
  res.json(orders.map(o => ({ ...o, items: items.all(o.id) })));
});

app.patch('/api/admin/orders/:code', auth, (req, res) => {
  const { status } = req.body || {};
  if (!['pending', 'confirmed', 'shipped', 'delivered', 'rejected'].includes(status)) return res.status(400).json({ error: 'Estado inválido' });
  
  try {
    let updatedOrder = null;
    db.transaction(() => {
      const o = db.prepare('SELECT * FROM orders WHERE code=?').get(req.params.code);
      if (!o) throw new Error('Pedido no existe');
      
      if (status === 'rejected' && o.status !== 'rejected') {
        const inc = db.prepare('UPDATE products SET stock = stock + ? WHERE id=?');
        for (const it of db.prepare('SELECT product_id,quantity FROM order_items WHERE order_id=?').all(o.id)) inc.run(it.quantity, it.product_id);
      }
      if (status !== 'rejected' && o.status === 'rejected') {
        const dec = db.prepare('UPDATE products SET stock = stock - ? WHERE id=? AND stock >= ?');
        for (const it of db.prepare('SELECT product_id,quantity FROM order_items WHERE order_id=?').all(o.id)) {
          if (dec.run(it.quantity, it.product_id, it.quantity).changes !== 1) throw new Error('Stock insuficiente');
        }
      }
      
      db.prepare('UPDATE orders SET status=?, updated_at=? WHERE id=?').run(status, Date.now(), o.id);
      updatedOrder = { ...o, status: status };
      
      io.to(req.params.code).emit('estadoCambiado', { status: status });
    })();
    res.json({ ok: true });

    if (updatedOrder) {
      sendEmailNotification(updatedOrder, status);
    }

  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/admin/categories', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM categories ORDER BY name ASC').all());
});

app.post('/api/admin/categories', auth, (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Nombre requerido' });
  const slug = name.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  try {
    const info = db.prepare('INSERT INTO categories (name, slug) VALUES (?,?)').run(name, slug);
    res.json({ id: info.lastInsertRowid, name, slug });
  } catch (e) { res.status(400).json({ error: 'Esa categoría ya existe' }); }
});

app.delete('/api/admin/categories/:id', auth, (req, res) => {
  db.prepare('DELETE FROM categories WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/admin/products', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM products ORDER BY id DESC').all());
});

app.post('/api/admin/products', auth, (req, res) => {
  const { name, description, price, stock, category, image } = req.body;
  if (!name || !price || stock === undefined) return res.status(400).json({ error: 'Faltan datos obligatorios' });
  
  let imagePath = 'default.png';
  if (image && image.startsWith('data:image/')) {
    const m = image.match(/^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/i);
    if (m) {
      const buf = Buffer.from(m[2], 'base64');
      const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
      const filename = 'prod_' + Date.now() + '.' + ext;
      fs.writeFileSync(path.join(UPLOADS, filename), buf);
      imagePath = '/uploads/' + filename;
    }
  }
  const info = db.prepare('INSERT INTO products (name,description,price,stock,category,image) VALUES (?,?,?,?,?,?)')
    .run(name, description || '', price, stock, category || 'otros', imagePath);
  res.json({ id: info.lastInsertRowid, ok: true });
});

app.put('/api/admin/products/:id', auth, (req, res) => {
  const { name, description, price, stock, category, image } = req.body;
  const p = db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'No existe' });

  let imagePath = p.image;
  if (image && image.startsWith('data:image/')) {
    const m = image.match(/^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/i);
    if (m) {
      const buf = Buffer.from(m[2], 'base64');
      const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
      const filename = 'prod_' + Date.now() + '.' + ext;
      fs.writeFileSync(path.join(UPLOADS, filename), buf);
      imagePath = '/uploads/' + filename;
    }
  }
  db.prepare('UPDATE products SET name=?, description=?, price=?, stock=?, category=?, image=? WHERE id=?')
    .run(name || p.name, description || p.description, price || p.price, stock !== undefined ? stock : p.stock, category || p.category, imagePath, p.id);
  res.json({ ok: true });
});

app.delete('/api/admin/products/:id', auth, (req, res) => {
  db.prepare('DELETE FROM products WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

server.listen(PORT, () => console.log('Tienda en http://localhost:' + PORT));