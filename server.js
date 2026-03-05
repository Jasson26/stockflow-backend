/**
 * StockFlow Pro Backend (MVP Online)
 * - Node.js + Express
 * - PostgreSQL (Railway)
 *
 * Features:
 * - Auth (email/password) + simple token session
 * - Roles (Kasir, Gudang, Finance, Manager, Owner)
 * - Products + Stock updates + Stock history
 * - Transactions with approval flow
 * - Monthly ledger + close period
 * - Notifications
 * - Audit logs
 * - Reports (basic profit & cashflow)
 */

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;

if (!process.env.DATABASE_URL) {
  console.log("WARNING: DATABASE_URL missing. Set it in Railway backend service variables.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// -------------------------
// Helpers: time, hashing, tokens
// -------------------------
function nowISO() {
  return new Date().toISOString();
}

function sha256(input) {
  return crypto.createHash("sha256").update(String(input)).digest("hex");
}

// Very simple session token (MVP).
// For production you’d typically use JWT + refresh tokens.
function randomToken() {
  return crypto.randomBytes(32).toString("hex");
}

// -------------------------
// Auth middleware (token-based)
// -------------------------
async function authRequired(req, res, next) {
  try {
    const auth = req.headers.authorization || "";
    const parts = auth.split(" ");
    if (parts.length !== 2 || parts[0] !== "Bearer") {
      return res.status(401).json({ ok: false, error: "Missing Bearer token" });
    }
    const token = parts[1];

    const r = await pool.query(
      `
      SELECT s.token, s.expires_at, u.id as user_id, u.name, u.email, r.name as role
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      JOIN roles r ON r.id = u.role_id
      WHERE s.token = $1
      `,
      [token]
    );

    if (r.rows.length === 0) {
      return res.status(401).json({ ok: false, error: "Invalid token" });
    }

    const session = r.rows[0];
    if (new Date(session.expires_at).getTime() < Date.now()) {
      return res.status(401).json({ ok: false, error: "Session expired" });
    }

    req.user = {
      id: session.user_id,
      name: session.name,
      email: session.email,
      role: session.role,
      token,
    };

    next();
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}

// RBAC
const ROLE_ORDER = ["Kasir", "Gudang", "Finance", "Manager", "Owner"];
function hasAtLeastRole(userRole, requiredRole) {
  const a = ROLE_ORDER.indexOf(userRole);
  const b = ROLE_ORDER.indexOf(requiredRole);
  if (a === -1 || b === -1) return false;
  return a >= b;
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

// -------------------------
// Audit + Notifications + Stock History
// -------------------------
async function auditLog({ userId, action, entity, entityId = null, details = null }) {
  await pool.query(
    `
    INSERT INTO audit_logs (user_id, action, entity, entity_id, details, created_at)
    VALUES ($1, $2, $3, $4, $5, NOW())
    `,
    [userId, action, entity, entityId, details ? JSON.stringify(details) : null]
  );
}

async function notify({ type, message }) {
  await pool.query(
    `
    INSERT INTO notifications (type, message, is_read, created_at)
    VALUES ($1, $2, FALSE, NOW())
    `,
    [type, message]
  );
}

async function stockHistory({ productId, changeType, qty, note, userId }) {
  await pool.query(
    `
    INSERT INTO stock_history (product_id, change_type, qty, note, user_id, created_at)
    VALUES ($1, $2, $3, $4, $5, NOW())
    `,
    [productId, changeType, qty, note || null, userId]
  );
}

// -------------------------
// Ledger helpers
// -------------------------
function getMonthYear(d = new Date()) {
  return { month: d.getMonth() + 1, year: d.getFullYear() };
}

async function getOrCreateLedgerMonth(month, year) {
  // Create if not exists, opening balance from previous month closing
  const existing = await pool.query(
    `SELECT * FROM ledger_month WHERE month = $1 AND year = $2 LIMIT 1`,
    [month, year]
  );
  if (existing.rows.length > 0) return existing.rows[0];

  // previous month
  const prevDate = new Date(year, month - 2, 1); // month-2 because JS month is 0-based
  const prev = getMonthYear(prevDate);

  const prevLedger = await pool.query(
    `SELECT * FROM ledger_month WHERE month = $1 AND year = $2 LIMIT 1`,
    [prev.month, prev.year]
  );

  const openingBalance = prevLedger.rows.length > 0 ? Number(prevLedger.rows[0].closing_balance || 0) : 0;

  const created = await pool.query(
    `
    INSERT INTO ledger_month (month, year, is_closed, opening_balance, closing_balance, created_at)
    VALUES ($1, $2, FALSE, $3, $3, NOW())
    RETURNING *
    `,
    [month, year, openingBalance]
  );

  await notify({
    type: "LEDGER_NEW_PERIOD",
    message: `Periode pembukuan baru dibuat: ${month}/${year} (Saldo awal: ${openingBalance})`,
  });

  return created.rows[0];
}

async function ensureLedgerNotClosed(month, year) {
  const r = await pool.query(`SELECT * FROM ledger_month WHERE month=$1 AND year=$2 LIMIT 1`, [month, year]);
  if (r.rows.length === 0) return { ok: true, ledger: null };
  if (r.rows[0].is_closed) return { ok: false, error: "Ledger period is closed (read-only)", ledger: r.rows[0] };
  return { ok: true, ledger: r.rows[0] };
}

async function addLedgerEntry({ month, year, type, amount, description, userId }) {
  // Ensure ledger exists and open
  const ledger = await getOrCreateLedgerMonth(month, year);
  if (ledger.is_closed) throw new Error("Ledger is closed");

  const amt = Number(amount) || 0;

  await pool.query(
    `
    INSERT INTO ledger_entry (ledger_id, type, amount, description, created_by, created_at)
    VALUES ($1, $2, $3, $4, $5, NOW())
    `,
    [ledger.id, type, amt, description || null, userId]
  );

  // Update closing balance (simple: cash-in increases, cash-out decreases)
  // You can adjust this logic later.
  let delta = 0;
  if (type === "CASH_IN" || type === "REVENUE") delta = amt;
  if (type === "CASH_OUT" || type === "EXPENSE" || type === "COGS") delta = -amt;

  await pool.query(
    `UPDATE ledger_month SET closing_balance = closing_balance + $1 WHERE id = $2`,
    [delta, ledger.id]
  );

  return ledger.id;
}

// -------------------------
// Root + DB test
// -------------------------
app.get("/", async (req, res) => {
  res.json({
    ok: true,
    message: "StockFlow API Running",
    time: nowISO(),
    hasDatabaseUrl: Boolean(process.env.DATABASE_URL),
  });
});

app.get("/db-test", async (req, res) => {
  try {
    const r = await pool.query("SELECT NOW() as now");
    res.json({ ok: true, rows: r.rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// -------------------------
// INIT DB (tables + seed roles + seed owner)
// -------------------------
app.get("/init-db", async (req, res) => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS roles (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL
      );

      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role_id INTEGER NOT NULL REFERENCES roles(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS registration_codes (
        code TEXT PRIMARY KEY,
        role_id INTEGER NOT NULL REFERENCES roles(id),
        max_usage INTEGER NOT NULL DEFAULT 1,
        used_count INTEGER NOT NULL DEFAULT 0,
        expires_at TIMESTAMPTZ NOT NULL,
        created_by INTEGER REFERENCES users(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        sku TEXT,
        stock INTEGER NOT NULL DEFAULT 0,
        price INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS stock_history (
        id SERIAL PRIMARY KEY,
        product_id INTEGER NOT NULL REFERENCES products(id),
        change_type TEXT NOT NULL,
        qty INTEGER NOT NULL,
        note TEXT,
        user_id INTEGER NOT NULL REFERENCES users(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS transactions (
        id SERIAL PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'PENDING',  -- PENDING / APPROVED / REJECTED
        total_amount INTEGER NOT NULL DEFAULT 0,
        created_by INTEGER NOT NULL REFERENCES users(id),
        approved_by INTEGER REFERENCES users(id),
        approved_at TIMESTAMPTZ,
        rejected_by INTEGER REFERENCES users(id),
        rejected_at TIMESTAMPTZ,
        note TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS transaction_items (
        id SERIAL PRIMARY KEY,
        transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
        product_id INTEGER NOT NULL REFERENCES products(id),
        qty INTEGER NOT NULL,
        price INTEGER NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS ledger_month (
        id SERIAL PRIMARY KEY,
        month INTEGER NOT NULL,
        year INTEGER NOT NULL,
        is_closed BOOLEAN NOT NULL DEFAULT FALSE,
        opening_balance INTEGER NOT NULL DEFAULT 0,
        closing_balance INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(month, year)
      );

      CREATE TABLE IF NOT EXISTS ledger_entry (
        id SERIAL PRIMARY KEY,
        ledger_id INTEGER NOT NULL REFERENCES ledger_month(id) ON DELETE CASCADE,
        type TEXT NOT NULL,  -- CASH_IN, CASH_OUT, REVENUE, EXPENSE, COGS, ADJUSTMENT
        amount INTEGER NOT NULL,
        description TEXT,
        created_by INTEGER NOT NULL REFERENCES users(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS notifications (
        id SERIAL PRIMARY KEY,
        type TEXT NOT NULL,
        message TEXT NOT NULL,
        is_read BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        action TEXT NOT NULL,
        entity TEXT NOT NULL,
        entity_id INTEGER,
        details JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // Seed roles
    const rolesToSeed = ["Kasir", "Gudang", "Finance", "Manager", "Owner"];
    for (const roleName of rolesToSeed) {
      await pool.query(`INSERT INTO roles (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`, [roleName]);
    }

    // Seed Owner user if not exists (DEFAULT CREDENTIALS - CHANGE AFTER FIRST LOGIN!)
    // You can change these defaults later. For now this makes onboarding easy.
    const ownerEmail = process.env.SEED_OWNER_EMAIL || "owner@stockflow.local";
    const ownerPass = process.env.SEED_OWNER_PASSWORD || "owner12345";
    const ownerName = process.env.SEED_OWNER_NAME || "Owner";

    const ownerRole = await pool.query(`SELECT id FROM roles WHERE name='Owner' LIMIT 1`);
    const ownerRoleId = ownerRole.rows[0].id;

    const existingOwner = await pool.query(`SELECT id FROM users WHERE email=$1 LIMIT 1`, [ownerEmail]);
    if (existingOwner.rows.length === 0) {
      await pool.query(
        `
        INSERT INTO users (name, email, password_hash, role_id)
        VALUES ($1,$2,$3,$4)
        `,
        [ownerName, ownerEmail, sha256(ownerPass), ownerRoleId]
      );
      await notify({
        type: "SYSTEM",
        message: `Akun Owner default dibuat. Email: ${ownerEmail} (Silakan ganti password setelah login)`,
      });
    }

    res.json({
      ok: true,
      message: "Database initialized + roles seeded + owner seeded (if missing).",
      seedOwnerEmail: ownerEmail,
      seedOwnerPassword: ownerPass, // show for convenience; change after login!
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// -------------------------
// AUTH endpoints
// -------------------------

// Login -> creates session token
app.post("/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ ok: false, error: "email & password required" });

    const r = await pool.query(
      `
      SELECT u.id, u.name, u.email, u.password_hash, ro.name as role
      FROM users u
      JOIN roles ro ON ro.id = u.role_id
      WHERE u.email = $1
      `,
      [email]
    );

    if (r.rows.length === 0) return res.status(401).json({ ok: false, error: "Invalid credentials" });

    const user = r.rows[0];
    if (user.password_hash !== sha256(password)) {
      return res.status(401).json({ ok: false, error: "Invalid credentials" });
    }

    const token = randomToken();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    await pool.query(
      `INSERT INTO sessions (token, user_id, expires_at) VALUES ($1,$2,$3)`,
      [token, user.id, expiresAt.toISOString()]
    );

    await auditLog({ userId: user.id, action: "LOGIN", entity: "auth", entityId: user.id });

    res.json({
      ok: true,
      token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
      expiresAt: expiresAt.toISOString(),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Logout -> delete session
app.post("/auth/logout", authRequired, async (req, res) => {
  try {
    await pool.query(`DELETE FROM sessions WHERE token = $1`, [req.user.token]);
    await auditLog({ userId: req.user.id, action: "LOGOUT", entity: "auth", entityId: req.user.id });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Owner generates registration code
app.post("/auth/registration-codes", authRequired, roleRequired("Owner"), async (req, res) => {
  try {
    const { roleName, maxUsage = 1, expiresInDays = 7 } = req.body || {};
    if (!roleName) return res.status(400).json({ ok: false, error: "roleName required" });

    const role = await pool.query(`SELECT id FROM roles WHERE name=$1 LIMIT 1`, [roleName]);
    if (role.rows.length === 0) return res.status(400).json({ ok: false, error: "Invalid roleName" });

    const code = crypto.randomBytes(6).toString("hex").toUpperCase(); // 12 chars
    const expiresAt = new Date(Date.now() + Number(expiresInDays) * 24 * 60 * 60 * 1000);

    await pool.query(
      `
      INSERT INTO registration_codes (code, role_id, max_usage, used_count, expires_at, created_by)
      VALUES ($1,$2,$3,0,$4,$5)
      `,
      [code, role.rows[0].id, Number(maxUsage) || 1, expiresAt.toISOString(), req.user.id]
    );

    await auditLog({
      userId: req.user.id,
      action: "CREATE_REG_CODE",
      entity: "registration_codes",
      entityId: null,
      details: { code, roleName, maxUsage, expiresAt: expiresAt.toISOString() },
    });

    res.json({ ok: true, code, roleName, maxUsage: Number(maxUsage) || 1, expiresAt: expiresAt.toISOString() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Register employee using registration code (creates user)
app.post("/auth/register", async (req, res) => {
  try {
    const { name, email, password, registrationCode } = req.body || {};
    if (!name || !email || !password || !registrationCode) {
      return res.status(400).json({ ok: false, error: "name, email, password, registrationCode required" });
    }

    const codeRow = await pool.query(
      `
      SELECT rc.*, ro.name as role_name
      FROM registration_codes rc
      JOIN roles ro ON ro.id = rc.role_id
      WHERE rc.code = $1
      `,
      [registrationCode]
    );
    if (codeRow.rows.length === 0) return res.status(400).json({ ok: false, error: "Invalid registration code" });

    const rc = codeRow.rows[0];
    if (new Date(rc.expires_at).getTime() < Date.now()) {
      return res.status(400).json({ ok: false, error: "Registration code expired" });
    }
    if (Number(rc.used_count) >= Number(rc.max_usage)) {
      return res.status(400).json({ ok: false, error: "Registration code usage limit reached" });
    }

    // create user
    const created = await pool.query(
      `
      INSERT INTO users (name, email, password_hash, role_id)
      VALUES ($1,$2,$3,$4)
      RETURNING id, name, email
      `,
      [name, email, sha256(password), rc.role_id]
    );

    // increment usage
    await pool.query(
      `UPDATE registration_codes SET used_count = used_count + 1 WHERE code=$1`,
      [registrationCode]
    );

    const userId = created.rows[0].id;

    await auditLog({
      userId: rc.created_by || userId,
      action: "REGISTER_USER",
      entity: "users",
      entityId: userId,
      details: { email, role: rc.role_name },
    });

    res.json({ ok: true, user: created.rows[0], role: rc.role_name });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// -------------------------
// Products
// -------------------------
app.get("/products", authRequired, async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM products ORDER BY id DESC`);
    res.json({ ok: true, data: r.rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/products", authRequired, roleRequired("Gudang"), async (req, res) => {
  try {
    const { name, sku = null, stock = 0, price = 0 } = req.body || {};
    if (!name) return res.status(400).json({ ok: false, error: "name required" });

    const r = await pool.query(
      `INSERT INTO products (name, sku, stock, price) VALUES ($1,$2,$3,$4) RETURNING *`,
      [name, sku, Number(stock) || 0, Number(price) || 0]
    );

    await auditLog({ userId: req.user.id, action: "CREATE", entity: "products", entityId: r.rows[0].id, details: r.rows[0] });

    res.json({ ok: true, data: r.rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// update product basic fields
app.put("/products/:id", authRequired, roleRequired("Gudang"), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { name, sku, price } = req.body || {};
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "Invalid product id" });

    const r = await pool.query(
      `UPDATE products SET name = COALESCE($1,name), sku = COALESCE($2,sku), price = COALESCE($3,price)
       WHERE id=$4 RETURNING *`,
      [name ?? null, sku ?? null, Number.isFinite(Number(price)) ? Number(price) : null, id]
    );

    if (r.rows.length === 0) return res.status(404).json({ ok: false, error: "Not found" });

    await auditLog({ userId: req.user.id, action: "UPDATE", entity: "products", entityId: id, details: r.rows[0] });

    res.json({ ok: true, data: r.rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// stock adjustment (in/out/loss/adjust)
app.post("/products/:id/stock", authRequired, async (req, res) => {
  try {
    const productId = Number(req.params.id);
    if (!Number.isFinite(productId)) return res.status(400).json({ ok: false, error: "Invalid product id" });

    const { changeType, qty, note = "" } = req.body || {};
    const delta = Number(qty);

    if (!changeType || !["IN", "OUT", "LOSS", "ADJUST"].includes(changeType)) {
      return res.status(400).json({ ok: false, error: "changeType must be IN|OUT|LOSS|ADJUST" });
    }
    if (!Number.isFinite(delta) || delta === 0) return res.status(400).json({ ok: false, error: "qty must be a non-zero number" });

    // permissions
    // Kasir: usually not allowed to manual stock changes
    // Gudang+ can do stock ops
    if (!hasAtLeastRole(req.user.role, "Gudang")) {
      return res.status(403).json({ ok: false, error: "Requires role Gudang or higher" });
    }

    // if OUT/LOSS, delta should subtract stock; normalize
    let stockDelta = delta;
    if (changeType === "OUT" || changeType === "LOSS") stockDelta = -Math.abs(delta);
    if (changeType === "IN") stockDelta = Math.abs(delta);

    // Update stock
    const r = await pool.query(
      `UPDATE products SET stock = stock + $1 WHERE id=$2 RETURNING *`,
      [stockDelta, productId]
    );
    if (r.rows.length === 0) return res.status(404).json({ ok: false, error: "Product not found" });

    const product = r.rows[0];

    await stockHistory({
      productId,
      changeType,
      qty: stockDelta,
      note,
      userId: req.user.id,
    });

    await auditLog({
      userId: req.user.id,
      action: "STOCK_CHANGE",
      entity: "products",
      entityId: productId,
      details: { changeType, stockDelta, note, newStock: product.stock },
    });

    await notify({
      type: "STOCK_CHANGED",
      message: `Stok berubah: ${product.name} (${changeType} ${stockDelta}). Stok sekarang: ${product.stock}`,
    });

    if (Number(product.stock) <= 0) {
      await notify({ type: "STOCK_EMPTY", message: `Stok habis: ${product.name}` });
    }

    res.json({ ok: true, data: product });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// -------------------------
// Stock history (read)
// -------------------------
app.get("/stock-history", authRequired, roleRequired("Gudang"), async (req, res) => {
  try {
    const { q } = req.query; // optional product name search
    let sql = `
      SELECT sh.*, p.name as product_name, p.sku, u.name as user_name
      FROM stock_history sh
      JOIN products p ON p.id = sh.product_id
      JOIN users u ON u.id = sh.user_id
    `;
    const params = [];
    if (q) {
      params.push(`%${q}%`);
      sql += ` WHERE p.name ILIKE $1 OR p.sku ILIKE $1 `;
    }
    sql += ` ORDER BY sh.id DESC LIMIT 500`;

    const r = await pool.query(sql, params);
    res.json({ ok: true, data: r.rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// -------------------------
// Transactions
// - Create PENDING transaction with items
// - Approve/Reject by role
// - On APPROVE: deduct stock + write stock_history + ledger entry + notifications + audit
// -------------------------

// Create transaction (Kasir+)
app.post("/transactions", authRequired, roleRequired("Kasir"), async (req, res) => {
  const client = await pool.connect();
  try {
    const { items = [], note = "" } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ ok: false, error: "items required" });
    }

    // Determine current month/year for ledger association later
    const { month, year } = getMonthYear(new Date());

    await client.query("BEGIN");

    // Verify products and compute total
    let total = 0;
    for (const it of items) {
      const pid = Number(it.productId);
      const qty = Number(it.qty);
      if (!Number.isFinite(pid) || !Number.isFinite(qty) || qty <= 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ ok: false, error: "Each item must have productId and qty > 0" });
      }

      const pr = await client.query(`SELECT id, name, stock, price FROM products WHERE id=$1`, [pid]);
      if (pr.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ ok: false, error: `Product not found: ${pid}` });
      }

      const price = Number(it.price ?? pr.rows[0].price ?? 0);
      total += price * qty;
    }

    // Insert transaction
    const tx = await client.query(
      `
      INSERT INTO transactions (status, total_amount, created_by, note)
      VALUES ('PENDING', $1, $2, $3)
      RETURNING *
      `,
      [total, req.user.id, note]
    );

    const txId = tx.rows[0].id;

    // Insert items
    for (const it of items) {
      const pid = Number(it.productId);
      const qty = Number(it.qty);
      // Use provided price or product price
      const pr = await client.query(`SELECT price FROM products WHERE id=$1`, [pid]);
      const price = Number(it.price ?? pr.rows[0].price ?? 0);

      await client.query(
        `
        INSERT INTO transaction_items (transaction_id, product_id, qty, price)
        VALUES ($1,$2,$3,$4)
        `,
        [txId, pid, qty, price]
      );
    }

    await client.query("COMMIT");

    await auditLog({
      userId: req.user.id,
      action: "CREATE",
      entity: "transactions",
      entityId: txId,
      details: { total, note, status: "PENDING", month, year },
    });

    await notify({
      type: "TX_PENDING",
      message: `Transaksi baru dibuat (PENDING) oleh ${req.user.name}. ID: ${txId}, Total: ${total}`,
    });

    res.json({ ok: true, data: tx.rows[0] });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ ok: false, error: err.message });
  } finally {
    client.release();
  }
});

// List transactions
app.get("/transactions", authRequired, roleRequired("Kasir"), async (req, res) => {
  try {
    const r = await pool.query(
      `
      SELECT t.*, u.name as created_by_name
      FROM transactions t
      JOIN users u ON u.id = t.created_by
      ORDER BY t.id DESC
      LIMIT 200
      `
    );
    res.json({ ok: true, data: r.rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Transaction detail (with items)
app.get("/transactions/:id", authRequired, roleRequired("Kasir"), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "Invalid transaction id" });

    const tx = await pool.query(`SELECT * FROM transactions WHERE id=$1`, [id]);
    if (tx.rows.length === 0) return res.status(404).json({ ok: false, error: "Not found" });

    const items = await pool.query(
      `
      SELECT ti.*, p.name as product_name, p.sku
      FROM transaction_items ti
      JOIN products p ON p.id = ti.product_id
      WHERE ti.transaction_id = $1
      ORDER BY ti.id ASC
      `,
      [id]
    );

    res.json({ ok: true, data: { ...tx.rows[0], items: items.rows } });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Approve transaction (Finance/Manager/Owner)
// On approve: deduct stock + stock history + ledger entries + audit + notifications
app.post("/transactions/:id/approve", authRequired, roleRequired("Finance"), async (req, res) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "Invalid transaction id" });

    const { note = "" } = req.body || {};

    await client.query("BEGIN");

    const tx = await client.query(`SELECT * FROM transactions WHERE id=$1 FOR UPDATE`, [id]);
    if (tx.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "Not found" });
    }
    if (tx.rows[0].status !== "PENDING") {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "Only PENDING transactions can be approved" });
    }

    const items = await client.query(`SELECT * FROM transaction_items WHERE transaction_id=$1`, [id]);

    // Check ledger is open for current month
    const { month, year } = getMonthYear(new Date());
    const ledger = await getOrCreateLedgerMonth(month, year);
    if (ledger.is_closed) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "Current ledger is closed, cannot approve transaction" });
    }

    // Deduct stock for each item
    for (const it of items.rows) {
      const product = await client.query(`SELECT * FROM products WHERE id=$1 FOR UPDATE`, [it.product_id]);
      if (product.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ ok: false, error: `Product missing: ${it.product_id}` });
      }

      const currentStock = Number(product.rows[0].stock);
      const qty = Number(it.qty);

      if (currentStock - qty < 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ ok: false, error: `Stock not enough for ${product.rows[0].name}` });
      }

      const updated = await client.query(
        `UPDATE products SET stock = stock - $1 WHERE id=$2 RETURNING *`,
        [qty, it.product_id]
      );

      // stock history + notifications
      await client.query(
        `
        INSERT INTO stock_history (product_id, change_type, qty, note, user_id, created_at)
        VALUES ($1, 'OUT', $2, $3, $4, NOW())
        `,
        [it.product_id, -qty, `TX APPROVE #${id} ${note}`.trim(), req.user.id]
      );

      await client.query(
        `
        INSERT INTO notifications (type, message, is_read, created_at)
        VALUES ($1, $2, FALSE, NOW())
        `,
        ["STOCK_CHANGED", `Transaksi #${id} mengurangi stok ${updated.rows[0].name} (-${qty}). Sisa: ${updated.rows[0].stock}`]
      );

      if (Number(updated.rows[0].stock) <= 0) {
        await client.query(
          `
          INSERT INTO notifications (type, message, is_read, created_at)
          VALUES ($1, $2, FALSE, NOW())
          `,
          ["STOCK_EMPTY", `Stok habis: ${updated.rows[0].name}`]
        );
      }
    }

    // Ledger entry: treat transaction as REVENUE (cash-in)
    await client.query(
      `
      INSERT INTO ledger_entry (ledger_id, type, amount, description, created_by, created_at)
      VALUES ($1, 'REVENUE', $2, $3, $4, NOW())
      `,
      [ledger.id, Number(tx.rows[0].total_amount), `Revenue dari transaksi #${id}`, req.user.id]
    );

    // Update ledger closing balance
    await client.query(
      `UPDATE ledger_month SET closing_balance = closing_balance + $1 WHERE id=$2`,
      [Number(tx.rows[0].total_amount), ledger.id]
    );

    // Update tx status
    const updatedTx = await client.query(
      `
      UPDATE transactions
      SET status='APPROVED', approved_by=$1, approved_at=NOW(), note=COALESCE(note,'') || $2
      WHERE id=$3
      RETURNING *
      `,
      [req.user.id, note ? `\nAPPROVE NOTE: ${note}` : "", id]
    );

    await client.query("COMMIT");

    await auditLog({
      userId: req.user.id,
      action: "APPROVE",
      entity: "transactions",
      entityId: id,
      details: { note, total: updatedTx.rows[0].total_amount, month, year },
    });

    await notify({
      type: "TX_APPROVED",
      message: `Transaksi #${id} APPROVED oleh ${req.user.name}. Total: ${updatedTx.rows[0].total_amount}`,
    });

    res.json({ ok: true, data: updatedTx.rows[0] });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ ok: false, error: err.message });
  } finally {
    client.release();
  }
});

// Reject transaction (Finance/Manager/Owner)
app.post("/transactions/:id/reject", authRequired, roleRequired("Finance"), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { note = "" } = req.body || {};
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "Invalid transaction id" });

    const r = await pool.query(`SELECT * FROM transactions WHERE id=$1`, [id]);
    if (r.rows.length === 0) return res.status(404).json({ ok: false, error: "Not found" });
    if (r.rows[0].status !== "PENDING") return res.status(400).json({ ok: false, error: "Only PENDING can be rejected" });

    const updated = await pool.query(
      `
      UPDATE transactions
      SET status='REJECTED', rejected_by=$1, rejected_at=NOW(), note=COALESCE(note,'') || $2
      WHERE id=$3
      RETURNING *
      `,
      [req.user.id, note ? `\nREJECT NOTE: ${note}` : "", id]
    );

    await auditLog({ userId: req.user.id, action: "REJECT", entity: "transactions", entityId: id, details: { note } });
    await notify({ type: "TX_REJECTED", message: `Transaksi #${id} REJECTED oleh ${req.user.name}.` });

    res.json({ ok: true, data: updated.rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// -------------------------
// Ledger endpoints
// -------------------------
app.get("/ledger/current", authRequired, roleRequired("Finance"), async (req, res) => {
  try {
    const { month, year } = getMonthYear(new Date());
    const ledger = await getOrCreateLedgerMonth(month, year);

    const entries = await pool.query(
      `
      SELECT le.*, u.name as created_by_name
      FROM ledger_entry le
      JOIN users u ON u.id = le.created_by
      WHERE le.ledger_id = $1
      ORDER BY le.id DESC
      LIMIT 500
      `,
      [ledger.id]
    );

    res.json({ ok: true, ledger, entries: entries.rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Close ledger (Manager/Owner)
app.post("/ledger/close", authRequired, roleRequired("Manager"), async (req, res) => {
  try {
    const { month, year } = getMonthYear(new Date());
    const ledger = await getOrCreateLedgerMonth(month, year);

    if (ledger.is_closed) return res.status(400).json({ ok: false, error: "Already closed" });

    const updated = await pool.query(
      `UPDATE ledger_month SET is_closed = TRUE WHERE id=$1 RETURNING *`,
      [ledger.id]
    );

    await auditLog({ userId: req.user.id, action: "CLOSE_PERIOD", entity: "ledger_month", entityId: ledger.id, details: { month, year } });
    await notify({ type: "LEDGER_CLOSED", message: `Periode ${month}/${year} ditutup oleh ${req.user.name}` });

    res.json({ ok: true, ledger: updated.rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// -------------------------
// Notifications
// -------------------------
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
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "Invalid id" });
    const r = await pool.query(`UPDATE notifications SET is_read=TRUE WHERE id=$1 RETURNING *`, [id]);
    if (r.rows.length === 0) return res.status(404).json({ ok: false, error: "Not found" });
    res.json({ ok: true, data: r.rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// -------------------------
// Audit logs (Manager/Owner)
/// -------------------------
app.get("/audit-logs", authRequired, roleRequired("Manager"), async (req, res) => {
  try {
    const r = await pool.query(
      `
      SELECT al.*, u.name as user_name
      FROM audit_logs al
      JOIN users u ON u.id = al.user_id
      ORDER BY al.id DESC
      LIMIT 500
      `
    );
    res.json({ ok: true, data: r.rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// -------------------------
// Reports (basic)
// -------------------------
app.get("/reports/profit", authRequired, roleRequired("Finance"), async (req, res) => {
  try {
    // Profit = sum(REVENUE) - sum(COGS/EXPENSE) in current month ledger
    const { month, year } = getMonthYear(new Date());
    const ledger = await getOrCreateLedgerMonth(month, year);

    const sums = await pool.query(
      `
      SELECT
        COALESCE(SUM(CASE WHEN type='REVENUE' THEN amount ELSE 0 END),0) as revenue,
        COALESCE(SUM(CASE WHEN type IN ('COGS','EXPENSE') THEN amount ELSE 0 END),0) as cost
      FROM ledger_entry
      WHERE ledger_id=$1
      `,
      [ledger.id]
    );

    const revenue = Number(sums.rows[0].revenue || 0);
    const cost = Number(sums.rows[0].cost || 0);
    const profit = revenue - cost;

    res.json({ ok: true, period: { month, year }, revenue, cost, profit });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/reports/cashflow", authRequired, roleRequired("Finance"), async (req, res) => {
  try {
    // Cash In = sum(REVENUE/CASH_IN), Cash Out = sum(EXPENSE/COGS/CASH_OUT)
    const { month, year } = getMonthYear(new Date());
    const ledger = await getOrCreateLedgerMonth(month, year);

    const sums = await pool.query(
      `
      SELECT
        COALESCE(SUM(CASE WHEN type IN ('REVENUE','CASH_IN') THEN amount ELSE 0 END),0) as cash_in,
        COALESCE(SUM(CASE WHEN type IN ('EXPENSE','COGS','CASH_OUT') THEN amount ELSE 0 END),0) as cash_out
      FROM ledger_entry
      WHERE ledger_id=$1
      `,
      [ledger.id]
    );

    const cashIn = Number(sums.rows[0].cash_in || 0);
    const cashOut = Number(sums.rows[0].cash_out || 0);

    res.json({ ok: true, period: { month, year }, cashIn, cashOut, net: cashIn - cashOut });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// -------------------------
// Start server
// -------------------------
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});