const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { Pool } = require("pg");
const sgMail = require("@sendgrid/mail");

const app = express();

app.use(cors());
app.use(express.json());

/*
========================
DATABASE
========================
*/
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/*
========================
SENDGRID
========================
*/
if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

/*
========================
HELPERS
========================
*/
function generateCode(length = 8) {
  return crypto.randomBytes(length).toString("hex").slice(0, length).toUpperCase();
}

function generateToken() {
  return crypto.randomBytes(32).toString("hex");
}

function generateInviteCode() {
  return "STF-" + generateCode(6);
}

function generateResetCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function isValidPassword(password) {
  return typeof password === "string" && password.length >= 6;
}

async function sendEmail(to, subject, html) {
  if (!process.env.SENDGRID_API_KEY || !process.env.SENDGRID_FROM) {
    throw new Error("SendGrid belum dikonfigurasi");
  }

  await sgMail.send({
    to,
    from: process.env.SENDGRID_FROM,
    subject,
    html
  });
}

/*
========================
AUTH MIDDLEWARE
========================
*/
async function auth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.replace("Bearer ", "").trim()
      : null;

    if (!token) {
      return res.status(401).json({
        ok: false,
        error: "Token tidak ditemukan"
      });
    }

    const result = await pool.query(
      `
      SELECT
        s.id as session_id,
        s.token,
        s.expires_at,
        u.id as user_id,
        u.name,
        u.email,
        u.role,
        u.store_id,
        st.name as store_name
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      JOIN stores st ON st.id = u.store_id
      WHERE s.token = $1
      LIMIT 1
      `,
      [token]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        ok: false,
        error: "Session tidak valid"
      });
    }

    const session = result.rows[0];

    if (new Date(session.expires_at).getTime() < Date.now()) {
      return res.status(401).json({
        ok: false,
        error: "Session sudah expired"
      });
    }

    req.user = {
      id: session.user_id,
      name: session.name,
      email: session.email,
      role: session.role,
      store_id: session.store_id,
      store_name: session.store_name,
      token: session.token
    };

    next();
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
}

function ownerOnly(req, res, next) {
  if (!req.user || req.user.role !== "OWNER") {
    return res.status(403).json({
      ok: false,
      error: "Hanya OWNER yang boleh mengakses fitur ini"
    });
  }
  next();
}

/*
========================
ROOT
========================
*/
app.get("/", (req, res) => {
  res.json({
    ok: true,
    message: "StockFlow API Running"
  });
});

/*
========================
INIT DATABASE
========================
*/
app.get("/init-db", async (req, res) => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS stores(
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS users(
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        role TEXT NOT NULL,
        store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS sessions(
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token TEXT UNIQUE NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS staff_invites(
        id SERIAL PRIMARY KEY,
        store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
        email TEXT NOT NULL,
        code TEXT UNIQUE NOT NULL,
        used BOOLEAN DEFAULT FALSE,
        expires_at TIMESTAMP NOT NULL,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS products(
        id SERIAL PRIMARY KEY,
        store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        category TEXT,
        price_buy INTEGER DEFAULT 0,
        price_sell INTEGER DEFAULT 0,
        stock INTEGER DEFAULT 0,
        min_stock INTEGER DEFAULT 10,
        barcode TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS sales(
        id SERIAL PRIMARY KEY,
        store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
        product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
        product_name TEXT,
        qty INTEGER,
        total INTEGER,
        status TEXT,
        staff TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS password_resets(
        id SERIAL PRIMARY KEY,
        email TEXT NOT NULL,
        code TEXT NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        used BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    res.json({
      ok: true,
      message: "DATABASE TABLES CREATED"
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

/*
========================
DEV RESET
========================
*/
app.get("/reset-dev", async (req, res) => {
  try {
    await pool.query(`DELETE FROM sessions`);
    await pool.query(`DELETE FROM staff_invites`);
    await pool.query(`DELETE FROM password_resets`);
    await pool.query(`DELETE FROM sales`);
    await pool.query(`DELETE FROM products`);
    await pool.query(`DELETE FROM users`);
    await pool.query(`DELETE FROM stores`);

    res.json({
      ok: true,
      message: "DEV DATA RESET"
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

/*
========================
REGISTER OWNER
body:
{
  "name":"Jasson",
  "email":"owner@stockflow.com",
  "password":"123456",
  "store_name":"Warung Jasson"
}
========================
*/
app.post("/auth/register-owner", async (req, res) => {
  try {
    const { name, email, password, store_name } = req.body;

    if (!name || !email || !password || !store_name) {
      return res.status(400).json({
        ok: false,
        error: "Nama, email, password, dan nama toko wajib diisi"
      });
    }

    if (!isValidPassword(password)) {
      return res.status(400).json({
        ok: false,
        error: "Password minimal 6 karakter"
      });
    }

    const normalizedEmail = email.toLowerCase().trim();

    const existingUser = await pool.query(
      `SELECT id FROM users WHERE email = $1 LIMIT 1`,
      [normalizedEmail]
    );

    if (existingUser.rows.length > 0) {
      return res.status(400).json({
        ok: false,
        error: "Email sudah terdaftar"
      });
    }

    const storeResult = await pool.query(
      `
      INSERT INTO stores(name)
      VALUES($1)
      RETURNING *
      `,
      [store_name]
    );

    const store = storeResult.rows[0];

    const userResult = await pool.query(
      `
      INSERT INTO users(name,email,password,role,store_id)
      VALUES($1,$2,$3,'OWNER',$4)
      RETURNING id,name,email,role,store_id
      `,
      [name, normalizedEmail, password, store.id]
    );

    res.json({
      ok: true,
      message: "OWNER REGISTER SUCCESS",
      data: {
        ...userResult.rows[0],
        store_name: store.name
      }
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

/*
========================
REGISTER STAFF
body:
{
  "name":"Andi",
  "email":"andi@mail.com",
  "password":"123456",
  "invite_code":"STF-92KD8X"
}
========================
*/
app.post("/auth/register-staff", async (req, res) => {
  try {
    const { name, email, password, invite_code } = req.body;

    if (!name || !email || !password || !invite_code) {
      return res.status(400).json({
        ok: false,
        error: "Nama, email, password, dan invite code wajib diisi"
      });
    }

    if (!isValidPassword(password)) {
      return res.status(400).json({
        ok: false,
        error: "Password minimal 6 karakter"
      });
    }

    const normalizedEmail = email.toLowerCase().trim();

    const existingUser = await pool.query(
      `SELECT id FROM users WHERE email = $1 LIMIT 1`,
      [normalizedEmail]
    );

    if (existingUser.rows.length > 0) {
      return res.status(400).json({
        ok: false,
        error: "Email sudah terdaftar"
      });
    }

    const inviteResult = await pool.query(
      `
      SELECT *
      FROM staff_invites
      WHERE code = $1
        AND email = $2
        AND used = FALSE
      ORDER BY id DESC
      LIMIT 1
      `,
      [invite_code.trim().toUpperCase(), normalizedEmail]
    );

    if (inviteResult.rows.length === 0) {
      return res.status(400).json({
        ok: false,
        error: "Invite code tidak valid"
      });
    }

    const invite = inviteResult.rows[0];

    if (new Date(invite.expires_at).getTime() < Date.now()) {
      return res.status(400).json({
        ok: false,
        error: "Invite code sudah kedaluwarsa"
      });
    }

    const userResult = await pool.query(
      `
      INSERT INTO users(name,email,password,role,store_id)
      VALUES($1,$2,$3,'STAFF',$4)
      RETURNING id,name,email,role,store_id
      `,
      [name, normalizedEmail, password, invite.store_id]
    );

    await pool.query(
      `
      UPDATE staff_invites
      SET used = TRUE
      WHERE id = $1
      `,
      [invite.id]
    );

    const storeResult = await pool.query(
      `SELECT id, name FROM stores WHERE id = $1 LIMIT 1`,
      [invite.store_id]
    );

    res.json({
      ok: true,
      message: "STAFF REGISTER SUCCESS",
      data: {
        ...userResult.rows[0],
        store_name: storeResult.rows[0].name
      }
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

/*
========================
LOGIN
returns token for persistent login
========================
*/
app.post("/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        ok: false,
        error: "Email dan password wajib diisi"
      });
    }

    const result = await pool.query(
      `
      SELECT
        u.id,
        u.name,
        u.email,
        u.role,
        u.store_id,
        st.name as store_name
      FROM users u
      JOIN stores st ON st.id = u.store_id
      WHERE u.email = $1 AND u.password = $2
      LIMIT 1
      `,
      [email.toLowerCase().trim(), password]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        ok: false,
        error: "Email atau password salah"
      });
    }

    const user = result.rows[0];
    const token = generateToken();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 hari

    await pool.query(
      `
      INSERT INTO sessions(user_id, token, expires_at)
      VALUES($1,$2,$3)
      `,
      [user.id, token, expiresAt]
    );

    res.json({
      ok: true,
      message: "LOGIN SUCCESS",
      token,
      data: user
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

/*
========================
ME
for auto-login check
========================
*/
app.get("/auth/me", auth, async (req, res) => {
  res.json({
    ok: true,
    data: req.user
  });
});

/*
========================
LOGOUT
========================
*/
app.post("/auth/logout", auth, async (req, res) => {
  try {
    await pool.query(
      `DELETE FROM sessions WHERE token = $1`,
      [req.user.token]
    );

    res.json({
      ok: true,
      message: "LOGOUT SUCCESS"
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

/*
========================
FORGOT PASSWORD
========================
*/
app.post("/auth/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        ok: false,
        error: "Email wajib diisi"
      });
    }

    const normalizedEmail = email.toLowerCase().trim();

    const user = await pool.query(
      `
      SELECT * FROM users
      WHERE email = $1
      LIMIT 1
      `,
      [normalizedEmail]
    );

    if (user.rows.length === 0) {
      return res.status(404).json({
        ok: false,
        error: "Email tidak ditemukan"
      });
    }

    const code = generateResetCode();
    const expire = new Date(Date.now() + 10 * 60 * 1000);

    await pool.query(
      `
      INSERT INTO password_resets(email,code,expires_at)
      VALUES($1,$2,$3)
      `,
      [normalizedEmail, code, expire]
    );

    await sendEmail(
      normalizedEmail,
      "StockFlow Reset Password",
      `
      <h2>StockFlow Reset Password</h2>
      <p>Kode reset password kamu:</p>
      <h1>${code}</h1>
      <p>Kode berlaku 10 menit</p>
      `
    );

    res.json({
      ok: true,
      message: "Reset code sent"
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

/*
========================
RESET PASSWORD
========================
*/
app.post("/auth/reset-password", async (req, res) => {
  try {
    const { email, code, newPassword } = req.body;

    if (!email || !code || !newPassword) {
      return res.status(400).json({
        ok: false,
        error: "Email, code, dan password baru wajib diisi"
      });
    }

    if (!isValidPassword(newPassword)) {
      return res.status(400).json({
        ok: false,
        error: "Password minimal 6 karakter"
      });
    }

    const reset = await pool.query(
      `
      SELECT *
      FROM password_resets
      WHERE email = $1
        AND code = $2
        AND used = FALSE
      ORDER BY id DESC
      LIMIT 1
      `,
      [email.toLowerCase().trim(), code]
    );

    if (reset.rows.length === 0) {
      return res.status(400).json({
        ok: false,
        error: "Invalid code"
      });
    }

    if (new Date(reset.rows[0].expires_at).getTime() < Date.now()) {
      return res.status(400).json({
        ok: false,
        error: "Code sudah kedaluwarsa"
      });
    }

    await pool.query(
      `
      UPDATE users
      SET password = $1
      WHERE email = $2
      `,
      [newPassword, email.toLowerCase().trim()]
    );

    await pool.query(
      `
      UPDATE password_resets
      SET used = TRUE
      WHERE id = $1
      `,
      [reset.rows[0].id]
    );

    res.json({
      ok: true,
      message: "Password updated"
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

/*
========================
OWNER INVITE STAFF
body:
{
  "email":"staff@mail.com"
}
========================
*/
app.post("/owner/invite-staff", auth, ownerOnly, async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        ok: false,
        error: "Email staff wajib diisi"
      });
    }

    const normalizedEmail = email.toLowerCase().trim();

    const existingUser = await pool.query(
      `SELECT id FROM users WHERE email = $1 LIMIT 1`,
      [normalizedEmail]
    );

    if (existingUser.rows.length > 0) {
      return res.status(400).json({
        ok: false,
        error: "Email sudah terdaftar sebagai user"
      });
    }

    const code = generateInviteCode();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 jam

    const inviteResult = await pool.query(
      `
      INSERT INTO staff_invites(store_id, email, code, used, expires_at, created_by)
      VALUES($1,$2,$3,FALSE,$4,$5)
      RETURNING *
      `,
      [req.user.store_id, normalizedEmail, code, expiresAt, req.user.id]
    );

    await sendEmail(
      normalizedEmail,
      "StockFlow Staff Invite",
      `
      <h2>Undangan Staff StockFlow</h2>
      <p>Kamu diundang menjadi staff untuk toko <b>${req.user.store_name}</b>.</p>
      <p>Gunakan kode berikut saat register:</p>
      <h1>${code}</h1>
      <p>Kode ini hanya bisa dipakai sekali dan berlaku 24 jam.</p>
      `
    );

    res.json({
      ok: true,
      message: "Invite code sent",
      data: inviteResult.rows[0]
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

/*
========================
OWNER LIST STAFF
========================
*/
app.get("/owner/staff", auth, ownerOnly, async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT id, name, email, role, created_at
      FROM users
      WHERE store_id = $1 AND role = 'STAFF'
      ORDER BY id DESC
      `,
      [req.user.store_id]
    );

    res.json({
      ok: true,
      data: result.rows
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

/*
========================
ADD PRODUCT
owner only
========================
*/
app.post("/products/add", auth, ownerOnly, async (req, res) => {
  try {
    const {
      name,
      category,
      price_buy,
      price_sell,
      stock,
      min_stock,
      barcode
    } = req.body;

    const result = await pool.query(
      `
      INSERT INTO products(store_id,name,category,price_buy,price_sell,stock,min_stock,barcode)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING *
      `,
      [
        req.user.store_id,
        name,
        category,
        price_buy || 0,
        price_sell || 0,
        stock || 0,
        min_stock || 10,
        barcode || null
      ]
    );

    res.json({
      ok: true,
      data: result.rows[0]
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

/*
========================
GET PRODUCTS
owner + staff
========================
*/
app.get("/products", auth, async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT *
      FROM products
      WHERE store_id = $1
      ORDER BY id DESC
      `,
      [req.user.store_id]
    );

    res.json({
      ok: true,
      data: result.rows
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

/*
========================
BARCODE LOOKUP
========================
*/
app.post("/products/barcode", auth, async (req, res) => {
  try {
    const { barcode } = req.body;

    const result = await pool.query(
      `
      SELECT *
      FROM products
      WHERE store_id = $1 AND barcode = $2
      LIMIT 1
      `,
      [req.user.store_id, barcode]
    );

    if (result.rows.length === 0) {
      return res.json({
        ok: false,
        message: "PRODUCT_NOT_FOUND"
      });
    }

    res.json({
      ok: true,
      data: result.rows[0]
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

/*
========================
STOCK IN
owner + staff
========================
*/
app.post("/stock/in", auth, async (req, res) => {
  try {
    const { id, qty } = req.body;

    const product = await pool.query(
      `
      SELECT *
      FROM products
      WHERE id = $1 AND store_id = $2
      LIMIT 1
      `,
      [id, req.user.store_id]
    );

    if (product.rows.length === 0) {
      return res.status(404).json({
        ok: false,
        error: "Produk tidak ditemukan"
      });
    }

    const result = await pool.query(
      `
      UPDATE products
      SET stock = stock + $1
      WHERE id = $2 AND store_id = $3
      RETURNING *
      `,
      [qty, id, req.user.store_id]
    );

    res.json({
      ok: true,
      data: result.rows[0]
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

/*
========================
STOCK OUT
owner + staff
========================
*/
app.post("/stock/out", auth, async (req, res) => {
  try {
    const { id, qty } = req.body;

    const product = await pool.query(
      `
      SELECT *
      FROM products
      WHERE id = $1 AND store_id = $2
      LIMIT 1
      `,
      [id, req.user.store_id]
    );

    if (product.rows.length === 0) {
      return res.status(404).json({
        ok: false,
        error: "Produk tidak ditemukan"
      });
    }

    const item = product.rows[0];

    if (Number(item.stock) < Number(qty)) {
      return res.status(400).json({
        ok: false,
        error: "Stok tidak cukup"
      });
    }

    const total = Number(item.price_sell) * Number(qty);

    await pool.query(
      `
      UPDATE products
      SET stock = stock - $1
      WHERE id = $2 AND store_id = $3
      `,
      [qty, id, req.user.store_id]
    );

    await pool.query(
      `
      INSERT INTO sales(store_id,product_id,product_name,qty,total,status,staff)
      VALUES($1,$2,$3,$4,$5,'DONE',$6)
      `,
      [req.user.store_id, id, item.name, qty, total, req.user.name]
    );

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

/*
========================
STOCK DAMAGE
owner + staff
========================
*/
app.post("/stock/damage", auth, async (req, res) => {
  try {
    const { id, qty } = req.body;

    const product = await pool.query(
      `
      SELECT *
      FROM products
      WHERE id = $1 AND store_id = $2
      LIMIT 1
      `,
      [id, req.user.store_id]
    );

    if (product.rows.length === 0) {
      return res.status(404).json({
        ok: false,
        error: "Produk tidak ditemukan"
      });
    }

    const item = product.rows[0];

    if (Number(item.stock) < Number(qty)) {
      return res.status(400).json({
        ok: false,
        error: "Stok tidak cukup"
      });
    }

    await pool.query(
      `
      UPDATE products
      SET stock = stock - $1
      WHERE id = $2 AND store_id = $3
      `,
      [qty, id, req.user.store_id]
    );

    await pool.query(
      `
      INSERT INTO sales(store_id,product_id,product_name,qty,total,status,staff)
      VALUES($1,$2,$3,$4,0,'RUSAK',$5)
      `,
      [req.user.store_id, id, item.name, qty, req.user.name]
    );

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

/*
========================
SALES REPORT
owner only
========================
*/
app.get("/sales/report", auth, ownerOnly, async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT *
      FROM sales
      WHERE store_id = $1
      ORDER BY id DESC
      `,
      [req.user.store_id]
    );

    res.json({
      ok: true,
      data: result.rows
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

/*
========================
DASHBOARD
owner + staff
staff tetap bisa lihat ringkasan dasar
========================
*/
app.get("/dashboard", auth, async (req, res) => {
  try {
    const balance = await pool.query(
      `
      SELECT COALESCE(SUM(total),0) as balance
      FROM sales
      WHERE store_id = $1 AND status = 'DONE'
      `,
      [req.user.store_id]
    );

    const sold = await pool.query(
      `
      SELECT COALESCE(SUM(qty),0) as sold
      FROM sales
      WHERE store_id = $1 AND status = 'DONE'
      `,
      [req.user.store_id]
    );

    const low = await pool.query(
      `
      SELECT COUNT(*) FROM products
      WHERE store_id = $1 AND stock <= min_stock
      `,
      [req.user.store_id]
    );

    const lowestItem = await pool.query(
      `
      SELECT name, stock
      FROM products
      WHERE store_id = $1
      ORDER BY stock ASC, id DESC
      LIMIT 1
      `,
      [req.user.store_id]
    );

    res.json({
      ok: true,
      balance: Number(balance.rows[0].balance),
      sold: Number(sold.rows[0].sold),
      lowStock: Number(low.rows[0].count),
      lowestItem: lowestItem.rows[0] || null
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

/*
========================
TRACKER
owner only
========================
*/
app.get("/tracker", auth, ownerOnly, async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT DATE(created_at) as day, SUM(total) as total
      FROM sales
      WHERE store_id = $1 AND status = 'DONE'
      GROUP BY day
      ORDER BY day DESC
      LIMIT 7
      `,
      [req.user.store_id]
    );

    res.json({
      ok: true,
      data: result.rows
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

/*
========================
SERVER
========================
*/
const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});