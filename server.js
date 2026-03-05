const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// =====================
// Helpers
// =====================
function hashPassword(password) {
  return crypto.createHash("sha256").update(String(password)).digest("hex");
}

function generateToken() {
  return crypto.randomBytes(32).toString("hex");
}

const ROLE_ORDER = ["Kasir", "Gudang", "Finance", "Manager", "Owner"];
function hasAtLeastRole(userRole, requiredRole) {
  const a = ROLE_ORDER.indexOf(userRole);
  const b = ROLE_ORDER.indexOf(requiredRole);
  if (a === -1 || b === -1) return false;
  return a >= b;
}

// =====================
// Auth middleware (Bearer token -> sessions -> users -> roles)
// =====================
async function authRequired(req, res, next) {
  try {
    const auth = req.headers.authorization || "";
    const [type, token] = auth.split(" ");

    if (type !== "Bearer" || !token) {
      return res.status(401).json({ ok: false, error: "Missing Bearer token" });
    }

    const r = await pool.query(
      `
      SELECT s.token, s.user_id, s.expires_at,
             u.name, u.email, r.name as role
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      JOIN roles r ON r.id = u.role_id
      WHERE s.token = $1
      LIMIT 1
      `,
      [token]
    );

    if (r.rows.length === 0) {
      return res.status(401).json({ ok: false, error: "Invalid token" });
    }

    const sess = r.rows[0];

    if (sess.expires_at && new Date(sess.expires_at).getTime() < Date.now()) {
      return res.status(401).json({ ok: false, error: "Session expired" });
    }

    req.user = {
      id: sess.user_id,
      name: sess.name,
      email: sess.email,
      role: sess.role,
      token: sess.token,
    };

    next();
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}

function roleRequired(requiredRole) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ ok: false, error: "Unauthorized" });
    if (!hasAtLeastRole(req.user.role, requiredRole)) {
      return res.status(403).json({ ok: false, error: `Requires role ${requiredRole}` });
    }
    next();
  };
}

// =====================
// Audit + Notification helpers
// =====================
async function writeAudit({ userId, action, entity, entityId = null, details = null }) {
  await pool.query(
    `
    INSERT INTO audit_logs (user_id, action, entity, entity_id, created_at)
    VALUES ($1,$2,$3,$4,NOW())
    `,
    [userId, action, entity, entityId]
  );
  // details not stored in your current audit_logs schema (simple MVP).
  // If you want, we can upgrade audit_logs to include JSON details later (FULL FILE update).
}

async function writeNotif({ type, message }) {
  await pool.query(
    `
    INSERT INTO notifications (type, message, is_read, created_at)
    VALUES ($1,$2,FALSE,NOW())
    `,
    [type, message]
  );
}

// =====================
// Routes
// =====================

app.get("/", (req, res) => {
  res.json({
    ok: true,
    message: "StockFlow API Running",
    version: "WAREHOUSE_STOCK_V1",
    hasDatabaseUrl: Boolean(process.env.DATABASE_URL),
    time: new Date().toISOString(),
  });
});

app.get("/db-test", async (req, res) => {
  try {
    const r = await pool.query("SELECT NOW()");
    res.json({ ok: true, time: r.rows[0] });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// =====================
// Init DB (FULL schema for your warehouse system)
// =====================
app.get("/init-db", async (req, res) => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS roles (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL
      );

      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name TEXT,
        email TEXT UNIQUE,
        password TEXT,
        role_id INTEGER REFERENCES roles(id),
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        expires_at TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS registration_codes (
        code TEXT PRIMARY KEY,
        role_id INTEGER REFERENCES roles(id),
        max_usage INTEGER DEFAULT 1,
        used_count INTEGER DEFAULT 0,
        expires_at TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        name TEXT,
        sku TEXT,
        stock INTEGER DEFAULT 0,
        price INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS stock_history (
        id SERIAL PRIMARY KEY,
        product_id INTEGER REFERENCES products(id),
        change_type TEXT,
        qty INTEGER,
        note TEXT,
        user_id INTEGER,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS transactions (
        id SERIAL PRIMARY KEY,
        total_amount INTEGER,
        status TEXT DEFAULT 'PENDING',
        created_by INTEGER,
        approved_by INTEGER,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS transaction_items (
        id SERIAL PRIMARY KEY,
        transaction_id INTEGER REFERENCES transactions(id),
        product_id INTEGER REFERENCES products(id),
        qty INTEGER,
        price INTEGER
      );

      CREATE TABLE IF NOT EXISTS ledger_month (
        id SERIAL PRIMARY KEY,
        month INTEGER,
        year INTEGER,
        is_closed BOOLEAN DEFAULT FALSE,
        opening_balance INTEGER DEFAULT 0,
        closing_balance INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS ledger_entry (
        id SERIAL PRIMARY KEY,
        ledger_id INTEGER REFERENCES ledger_month(id),
        type TEXT,
        amount INTEGER,
        description TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id SERIAL PRIMARY KEY,
        user_id INTEGER,
        action TEXT,
        entity TEXT,
        entity_id INTEGER,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS notifications (
        id SERIAL PRIMARY KEY,
        type TEXT,
        message TEXT,
        is_read BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`
      INSERT INTO roles(name) VALUES
      ('Kasir'),
      ('Gudang'),
      ('Finance'),
      ('Manager'),
      ('Owner')
      ON CONFLICT DO NOTHING
    `);

    // Seed default Owner if not exists
    const owner = await pool.query(`SELECT * FROM users WHERE email='owner@stockflow.local'`);
    if (owner.rows.length === 0) {
      const role = await pool.query(`SELECT id FROM roles WHERE name='Owner'`);
      await pool.query(
        `
        INSERT INTO users(name,email,password,role_id)
        VALUES($1,$2,$3,$4)
        `,
        ["Owner", "owner@stockflow.local", hashPassword("owner12345"), role.rows[0].id]
      );
      await writeNotif({
        type: "SYSTEM",
        message: "Akun Owner default dibuat: owner@stockflow.local (password: owner12345). Segera ganti password.",
      });
    }

    res.json({ ok: true, message: "FULL DATABASE INITIALIZED" });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// =====================
// Auth
// =====================
app.post("/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ ok: false, error: "email & password required" });

    const user = await pool.query(
      `
      SELECT u.*, r.name as role
      FROM users u
      JOIN roles r ON r.id=u.role_id
      WHERE u.email=$1
      `,
      [email]
    );

    if (user.rows.length === 0) return res.status(401).json({ ok: false, error: "user not found" });

    const u = user.rows[0];
    if (u.password !== hashPassword(password)) return res.status(401).json({ ok: false, error: "wrong password" });

    const token = generateToken();
    const expire = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    await pool.query(
      `
      INSERT INTO sessions(token,user_id,expires_at)
      VALUES($1,$2,$3)
      `,
      [token, u.id, expire]
    );

    await writeAudit({ userId: u.id, action: "LOGIN", entity: "auth", entityId: u.id });

    res.json({
      ok: true,
      token,
      user: {
        id: u.id,
        name: u.name,
        email: u.email,
        role: u.role,
      },
    });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.get("/me", authRequired, async (req, res) => {
  res.json({ ok: true, user: req.user });
});

// =====================
// Products (Warehouse)
// =====================

// List products (any logged-in user can view)
app.get("/products", authRequired, async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM products ORDER BY id DESC`);
    res.json({ ok: true, data: r.rows });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// Create product (Gudang+)
app.post("/products", authRequired, roleRequired("Gudang"), async (req, res) => {
  try {
    const { name, sku, stock, price } = req.body || {};
    if (!name) return res.status(400).json({ ok: false, error: "name required" });

    const r = await pool.query(
      `
      INSERT INTO products(name,sku,stock,price)
      VALUES($1,$2,$3,$4)
      RETURNING *
      `,
      [name, sku || null, Number(stock) || 0, Number(price) || 0]
    );

    await writeAudit({ userId: req.user.id, action: "CREATE", entity: "products", entityId: r.rows[0].id });
    await writeNotif({ type: "PRODUCT_CREATED", message: `Produk baru dibuat: ${r.rows[0].name}` });

    res.json({ ok: true, data: r.rows[0] });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// =====================
// Warehouse Stock Endpoint (IN / OUT / LOSS / ADJUST)
// =====================
// POST /products/:id/stock
// body: { changeType: "IN"|"OUT"|"LOSS"|"ADJUST", qty: number, note?: string }
app.post("/products/:id/stock", authRequired, roleRequired("Gudang"), async (req, res) => {
  try {
    const productId = Number(req.params.id);
    const { changeType, qty, note } = req.body || {};

    if (!Number.isFinite(productId)) return res.status(400).json({ ok: false, error: "invalid product id" });
    if (!changeType || !["IN", "OUT", "LOSS", "ADJUST"].includes(changeType)) {
      return res.status(400).json({ ok: false, error: "changeType must be IN|OUT|LOSS|ADJUST" });
    }

    const nQty = Number(qty);
    if (!Number.isFinite(nQty) || nQty === 0) {
      return res.status(400).json({ ok: false, error: "qty must be a non-zero number" });
    }

    // Normalize delta
    let delta = nQty;
    if (changeType === "IN") delta = Math.abs(nQty);
    if (changeType === "OUT" || changeType === "LOSS") delta = -Math.abs(nQty);
    // ADJUST: delta is as-is (can be + or -)

    // Lock product row for safe update
    const p = await pool.query(`SELECT * FROM products WHERE id=$1`, [productId]);
    if (p.rows.length === 0) return res.status(404).json({ ok: false, error: "product not found" });

    const currentStock = Number(p.rows[0].stock || 0);
    const newStock = currentStock + delta;

    // Optional rule: prevent negative stock
    if (newStock < 0) {
      return res.status(400).json({
        ok: false,
        error: `stock would become negative. current=${currentStock}, delta=${delta}`,
      });
    }

    const updated = await pool.query(
      `UPDATE products SET stock = $1 WHERE id=$2 RETURNING *`,
      [newStock, productId]
    );

    // Insert stock history (qty stored as signed delta)
    await pool.query(
      `
      INSERT INTO stock_history(product_id, change_type, qty, note, user_id, created_at)
      VALUES($1,$2,$3,$4,$5,NOW())
      `,
      [productId, changeType, delta, note || null, req.user.id]
    );

    await writeAudit({
      userId: req.user.id,
      action: "STOCK_CHANGE",
      entity: "products",
      entityId: productId,
    });

    await writeNotif({
      type: "STOCK_CHANGED",
      message: `Stok ${updated.rows[0].name} berubah (${changeType} ${delta}). Stok sekarang: ${updated.rows[0].stock}`,
    });

    if (Number(updated.rows[0].stock) === 0) {
      await writeNotif({
        type: "STOCK_EMPTY",
        message: `Stok habis: ${updated.rows[0].name}`,
      });
    }

    res.json({ ok: true, data: updated.rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// =====================
// Stock History (Warehouse view)
// GET /stock-history?q=indomie  (search by name/sku)
// =====================
app.get("/stock-history", authRequired, roleRequired("Gudang"), async (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    const limit = Math.min(Number(req.query.limit) || 200, 500);

    let sql = `
      SELECT sh.*, p.name as product_name, p.sku, u.name as user_name
      FROM stock_history sh
      JOIN products p ON p.id = sh.product_id
      LEFT JOIN users u ON u.id = sh.user_id
    `;
    const params = [];

    if (q) {
      params.push(`%${q}%`);
      sql += ` WHERE p.name ILIKE $1 OR p.sku ILIKE $1 `;
    }

    sql += ` ORDER BY sh.id DESC LIMIT ${limit}`;

    const r = await pool.query(sql, params);
    res.json({ ok: true, data: r.rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// =====================
// Notifications (basic)
// =====================
app.get("/notifications", authRequired, async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM notifications ORDER BY id DESC LIMIT 200`);
    res.json({ ok: true, data: r.rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/notifications/:id/read", authRequired, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "invalid id" });

    const r = await pool.query(`UPDATE notifications SET is_read=TRUE WHERE id=$1 RETURNING *`, [id]);
    if (r.rows.length === 0) return res.status(404).json({ ok: false, error: "not found" });

    res.json({ ok: true, data: r.rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// =====================
// Start
// =====================
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});