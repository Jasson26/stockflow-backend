const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;
const JWT_SECRET = process.env.JWT_SECRET || 'stockflow-secret';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is missing');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL error:', err);
});

async function query(sql, params = []) {
  return pool.query(sql, params);
}

function signToken(user) {
  return jwt.sign(
    {
      id: user.id,
      role: user.role,
      store_id: user.store_id
    },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
}

function auth(req, res, next) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const token = header.slice(7);
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ ok: false, error: 'Invalid token' });
  }
}

function ownerOnly(req, res, next) {
  if (req.user.role !== 'OWNER') {
    return res.status(403).json({ ok: false, error: 'Owner only' });
  }
  next();
}

function makeInviteCode() {
  return 'STF-' + Math.random().toString(36).slice(2, 8).toUpperCase();
}

app.get('/', async (_req, res) => {
  try {
    await query('SELECT 1');
    res.json({ ok: true, message: 'StockFlow API Running' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/reset-dev', async (_req, res) => {
  try {
    await query('DROP TABLE IF EXISTS stock_history CASCADE');
    await query('DROP TABLE IF EXISTS products CASCADE');
    await query('DROP TABLE IF EXISTS staff_invites CASCADE');
    await query('DROP TABLE IF EXISTS users CASCADE');
    await query('DROP TABLE IF EXISTS stores CASCADE');
    res.json({ ok: true, message: 'DEV RESET DONE' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/init-db', async (_req, res) => {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS stores (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('OWNER', 'STAFF')),
        store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS staff_invites (
        id SERIAL PRIMARY KEY,
        code TEXT UNIQUE NOT NULL,
        store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
        used BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        category TEXT DEFAULT '',
        price_buy INTEGER DEFAULT 0,
        price_sell INTEGER DEFAULT 0,
        stock INTEGER DEFAULT 0,
        min_stock INTEGER DEFAULT 0,
        barcode TEXT DEFAULT '',
        store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS stock_history (
        id SERIAL PRIMARY KEY,
        product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
        qty INTEGER NOT NULL,
        type TEXT NOT NULL,
        total INTEGER DEFAULT 0,
        status TEXT NOT NULL,
        staff_name TEXT DEFAULT '',
        store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    res.json({ ok: true, message: 'DATABASE TABLES CREATED' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/auth/register-owner', async (req, res) => {
  try {
    const { name, email, password, store_name } = req.body;
    if (!name || !email || !password || !store_name) {
      return res.status(400).json({ ok: false, error: 'All fields are required' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const store = await query('INSERT INTO stores(name) VALUES($1) RETURNING *', [store_name.trim()]);
    const storeId = store.rows[0].id;

    const user = await query(
      'INSERT INTO users(name,email,password,role,store_id) VALUES($1,$2,$3,$4,$5) RETURNING id,name,email,role,store_id',
      [name.trim(), email.trim().toLowerCase(), passwordHash, 'OWNER', storeId]
    );

    const token = signToken(user.rows[0]);
    res.json({ ok: true, token, data: user.rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/auth/register-staff', async (req, res) => {
  try {
    const { name, email, password, invite_code } = req.body;
    if (!name || !email || !password || !invite_code) {
      return res.status(400).json({ ok: false, error: 'All fields are required' });
    }

    const invite = await query('SELECT * FROM staff_invites WHERE code=$1 AND used=false', [invite_code.trim().toUpperCase()]);
    if (invite.rows.length === 0) {
      return res.status(400).json({ ok: false, error: 'Invalid invite code' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const storeId = invite.rows[0].store_id;

    const user = await query(
      'INSERT INTO users(name,email,password,role,store_id) VALUES($1,$2,$3,$4,$5) RETURNING id,name,email,role,store_id',
      [name.trim(), email.trim().toLowerCase(), passwordHash, 'STAFF', storeId]
    );

    await query('UPDATE staff_invites SET used=true WHERE id=$1', [invite.rows[0].id]);

    const token = signToken(user.rows[0]);
    res.json({ ok: true, token, data: user.rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ ok: false, error: 'Email and password are required' });
    }

    const result = await query('SELECT id,name,email,password,role,store_id FROM users WHERE email=$1 LIMIT 1', [email.trim().toLowerCase()]);
    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'User not found' });
    }

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.status(401).json({ ok: false, error: 'Wrong password' });
    }

    const token = signToken(user);
    res.json({
      ok: true,
      token,
      data: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        store_id: user.store_id
      }
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/auth/me', auth, async (req, res) => {
  try {
    const result = await query(
      `SELECT u.id,u.name,u.email,u.role,u.store_id,s.name AS store_name
       FROM users u
       JOIN stores s ON s.id = u.store_id
       WHERE u.id=$1 LIMIT 1`,
      [req.user.id]
    );

    res.json({ ok: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/auth/logout', auth, async (_req, res) => {
  res.json({ ok: true, message: 'LOGOUT SUCCESS' });
});

app.post('/owner/invite-staff', auth, ownerOnly, async (req, res) => {
  try {
    const code = makeInviteCode();
    const invite = await query(
      'INSERT INTO staff_invites(code,store_id) VALUES($1,$2) RETURNING *',
      [code, req.user.store_id]
    );
    res.json({ ok: true, data: invite.rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/owner/staff', auth, ownerOnly, async (req, res) => {
  try {
    const result = await query(
      `SELECT id,name,email,role,created_at
       FROM users
       WHERE store_id=$1 AND role='STAFF'
       ORDER BY id DESC`,
      [req.user.store_id]
    );
    res.json({ ok: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/products/add', auth, ownerOnly, async (req, res) => {
  try {
    const { name, category = '', price_buy = 0, price_sell = 0, stock = 0, min_stock = 0, barcode = '' } = req.body;
    if (!name) {
      return res.status(400).json({ ok: false, error: 'Product name is required' });
    }

    const result = await query(
      `INSERT INTO products(name,category,price_buy,price_sell,stock,min_stock,barcode,store_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [name.trim(), category, Number(price_buy), Number(price_sell), Number(stock), Number(min_stock), barcode, req.user.store_id]
    );

    res.json({ ok: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/products', auth, async (req, res) => {
  try {
    const result = await query('SELECT * FROM products WHERE store_id=$1 ORDER BY id DESC', [req.user.store_id]);
    res.json({ ok: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/stock/in', auth, async (req, res) => {
  try {
    const { id, qty } = req.body;
    if (!id || !qty) {
      return res.status(400).json({ ok: false, error: 'Product id and qty are required' });
    }

    const product = await query('SELECT * FROM products WHERE id=$1 AND store_id=$2 LIMIT 1', [id, req.user.store_id]);
    if (product.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Product not found' });
    }

    await query('UPDATE products SET stock = stock + $1 WHERE id=$2', [Number(qty), id]);
    await query(
      `INSERT INTO stock_history(product_id,qty,type,total,status,staff_name,store_id)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [id, Number(qty), 'IN', 0, 'IN', req.user.role === 'OWNER' ? 'OWNER' : 'STAFF', req.user.store_id]
    );

    res.json({ ok: true, message: 'Stock added' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/stock/out', auth, async (req, res) => {
  try {
    const { id, qty } = req.body;
    if (!id || !qty) {
      return res.status(400).json({ ok: false, error: 'Product id and qty are required' });
    }

    const productResult = await query('SELECT * FROM products WHERE id=$1 AND store_id=$2 LIMIT 1', [id, req.user.store_id]);
    if (productResult.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Product not found' });
    }

    const product = productResult.rows[0];
    if (Number(product.stock) < Number(qty)) {
      return res.status(400).json({ ok: false, error: 'Stock not enough' });
    }

    const total = Number(product.price_sell) * Number(qty);

    await query('UPDATE products SET stock = stock - $1 WHERE id=$2', [Number(qty), id]);
    await query(
      `INSERT INTO stock_history(product_id,qty,type,total,status,staff_name,store_id)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [id, Number(qty), 'OUT', total, 'DONE', req.user.role === 'OWNER' ? 'OWNER' : 'STAFF', req.user.store_id]
    );

    res.json({ ok: true, message: 'Sold' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/stock/damage', auth, async (req, res) => {
  try {
    const { id, qty } = req.body;
    if (!id || !qty) {
      return res.status(400).json({ ok: false, error: 'Product id and qty are required' });
    }

    const productResult = await query('SELECT * FROM products WHERE id=$1 AND store_id=$2 LIMIT 1', [id, req.user.store_id]);
    if (productResult.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Product not found' });
    }

    const product = productResult.rows[0];
    if (Number(product.stock) < Number(qty)) {
      return res.status(400).json({ ok: false, error: 'Stock not enough' });
    }

    await query('UPDATE products SET stock = stock - $1 WHERE id=$2', [Number(qty), id]);
    await query(
      `INSERT INTO stock_history(product_id,qty,type,total,status,staff_name,store_id)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [id, Number(qty), 'DAMAGE', 0, 'RUSAK', req.user.role === 'OWNER' ? 'OWNER' : 'STAFF', req.user.store_id]
    );

    res.json({ ok: true, message: 'Damage recorded' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/sales/report', auth, async (req, res) => {
  try {
    const result = await query(
      `SELECT p.name AS product_name,h.qty,h.total,h.status,h.created_at
       FROM stock_history h
       JOIN products p ON h.product_id = p.id
       WHERE h.store_id=$1 AND h.type IN ('OUT','DAMAGE')
       ORDER BY h.created_at DESC`,
      [req.user.store_id]
    );
    res.json({ ok: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/dashboard', auth, async (req, res) => {
  try {
    const balanceResult = await query(
      `SELECT COALESCE(SUM(total),0) AS balance
       FROM stock_history
       WHERE store_id=$1 AND status='DONE'`,
      [req.user.store_id]
    );

    const soldResult = await query(
      `SELECT COALESCE(SUM(qty),0) AS sold
       FROM stock_history
       WHERE store_id=$1 AND status='DONE'`,
      [req.user.store_id]
    );

    const lowStockCount = await query(
      `SELECT COUNT(*)::int AS total
       FROM products
       WHERE store_id=$1 AND stock <= min_stock`,
      [req.user.store_id]
    );

    const lowestItem = await query(
      `SELECT *
       FROM products
       WHERE store_id=$1
       ORDER BY stock ASC, id DESC
       LIMIT 1`,
      [req.user.store_id]
    );

    res.json({
      ok: true,
      balance: Number(balanceResult.rows[0].balance),
      sold: Number(soldResult.rows[0].sold),
      lowStock: Number(lowStockCount.rows[0].total),
      lowestItem: lowestItem.rows[0] || null
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/tracker', auth, async (req, res) => {
  try {
    const result = await query(
      `SELECT DATE(created_at) AS day, COALESCE(SUM(total),0) AS total
       FROM stock_history
       WHERE store_id=$1 AND status='DONE'
       GROUP BY DATE(created_at)
       ORDER BY day DESC
       LIMIT 7`,
      [req.user.store_id]
    );
    res.json({ ok: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log('Server running on', PORT);
});
