const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;
const SECRET = "stockflow-secret";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header) {
    return res.json({ ok: false, error: "no token" });
  }

  try {
    const token = header.split(" ")[1];
    const decoded = jwt.verify(token, SECRET);
    req.user = decoded;
    next();
  } catch {
    return res.json({ ok: false, error: "invalid token" });
  }
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "StockFlow Backend",
    status: "running"
  });
});

app.get("/reset-dev", async (req, res) => {
  try {
    await pool.query("DROP TABLE IF EXISTS stock_history CASCADE");
    await pool.query("DROP TABLE IF EXISTS products CASCADE");
    await pool.query("DROP TABLE IF EXISTS invites CASCADE");
    await pool.query("DROP TABLE IF EXISTS users CASCADE");
    await pool.query("DROP TABLE IF EXISTS stores CASCADE");

    res.json({ ok: true, message: "DEV RESET DONE" });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.get("/init-db", async (req, res) => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS stores(
        id SERIAL PRIMARY KEY,
        name TEXT
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS users(
        id SERIAL PRIMARY KEY,
        name TEXT,
        email TEXT UNIQUE,
        password TEXT,
        role TEXT,
        store_id INTEGER
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS invites(
        id SERIAL PRIMARY KEY,
        code TEXT,
        store_id INTEGER
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS products(
        id SERIAL PRIMARY KEY,
        name TEXT,
        stock INTEGER DEFAULT 0,
        price INTEGER DEFAULT 0,
        store_id INTEGER
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS stock_history(
        id SERIAL PRIMARY KEY,
        product_id INTEGER,
        qty INTEGER,
        type TEXT,
        total INTEGER,
        status TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        store_id INTEGER
      )
    `);

    res.json({ ok: true, message: "DATABASE TABLES CREATED" });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.post("/auth/register-owner", async (req, res) => {
  try {
    const { name, email, password, store_name } = req.body;
    const hash = await bcrypt.hash(password, 10);

    const store = await pool.query(
      `INSERT INTO stores(name) VALUES($1) RETURNING *`,
      [store_name || "StockFlow Store"]
    );

    const storeId = store.rows[0].id;

    await pool.query(
      `INSERT INTO users(name,email,password,role,store_id)
       VALUES($1,$2,$3,'OWNER',$4)`,
      [name, email, hash, storeId]
    );

    res.json({ ok: true, message: "OWNER REGISTERED" });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.post("/auth/register-staff", async (req, res) => {
  try {
    const { name, email, password, invite_code } = req.body;

    const invite = await pool.query(
      `SELECT * FROM invites WHERE code=$1`,
      [invite_code]
    );

    if (invite.rows.length === 0) {
      return res.json({ ok: false, error: "invalid invite code" });
    }

    const hash = await bcrypt.hash(password, 10);

    await pool.query(
      `INSERT INTO users(name,email,password,role,store_id)
       VALUES($1,$2,$3,'STAFF',$4)`,
      [name, email, hash, invite.rows[0].store_id]
    );

    res.json({ ok: true, message: "STAFF REGISTERED" });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.post("/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await pool.query(
      `SELECT * FROM users WHERE email=$1`,
      [email]
    );

    if (user.rows.length === 0) {
      return res.json({ ok: false, error: "user not found" });
    }

    const u = user.rows[0];
    const valid = await bcrypt.compare(password, u.password);

    if (!valid) {
      return res.json({ ok: false, error: "wrong password" });
    }

    const token = jwt.sign(
      {
        id: u.id,
        role: u.role,
        store_id: u.store_id
      },
      SECRET
    );

    res.json({
      ok: true,
      token,
      data: {
        id: u.id,
        name: u.name,
        email: u.email,
        role: u.role,
        store_id: u.store_id
      }
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.get("/auth/me", auth, async (req, res) => {
  try {
    const user = await pool.query(
      `SELECT * FROM users WHERE id=$1`,
      [req.user.id]
    );

    if (user.rows.length === 0) {
      return res.json({ ok: false, error: "user not found" });
    }

    res.json({ ok: true, data: user.rows[0] });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.post("/owner/invite-staff", auth, async (req, res) => {
  try {
    if (req.user.role !== "OWNER") {
      return res.json({ ok: false, error: "owner only" });
    }

    const code = Math.random().toString(36).substring(2, 8).toUpperCase();

    await pool.query(
      `INSERT INTO invites(code,store_id) VALUES($1,$2)`,
      [code, req.user.store_id]
    );

    res.json({
      ok: true,
      data: { code }
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.get("/owner/staff", auth, async (req, res) => {
  try {
    if (req.user.role !== "OWNER") {
      return res.json({ ok: false, error: "forbidden" });
    }

    const data = await pool.query(
      `SELECT id,name,email FROM users WHERE role='STAFF' AND store_id=$1 ORDER BY id DESC`,
      [req.user.store_id]
    );

    res.json({ ok: true, data: data.rows });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.delete("/owner/delete-staff/:id", auth, async (req, res) => {
  try {
    if (req.user.role !== "OWNER") {
      return res.json({ ok: false, error: "forbidden" });
    }

    await pool.query(
      `DELETE FROM users WHERE id=$1 AND role='STAFF' AND store_id=$2`,
      [req.params.id, req.user.store_id]
    );

    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.get("/products", auth, async (req, res) => {
  try {
    const products = await pool.query(
      `SELECT * FROM products WHERE store_id=$1 ORDER BY id DESC`,
      [req.user.store_id]
    );

    res.json({
      ok: true,
      data: products.rows
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.post("/product/add", auth, async (req, res) => {
  try {
    const { name, stock, price } = req.body;

    await pool.query(
      `INSERT INTO products(name,stock,price,store_id)
       VALUES($1,$2,$3,$4)`,
      [name, stock || 0, price || 0, req.user.store_id]
    );

    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.post("/product/update-price", auth, async (req, res) => {
  try {
    const { product_id, price } = req.body;

    await pool.query(
      `UPDATE products SET price=$1 WHERE id=$2 AND store_id=$3`,
      [price, product_id, req.user.store_id]
    );

    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.post("/stock/in", auth, async (req, res) => {
  try {
    const { product_id, qty } = req.body;

    await pool.query(
      `UPDATE products SET stock=stock+$1 WHERE id=$2 AND store_id=$3`,
      [qty, product_id, req.user.store_id]
    );

    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.post("/stock/damage", auth, async (req, res) => {
  try {
    const { product_id, qty } = req.body;

    const product = await pool.query(
      `SELECT * FROM products WHERE id=$1 AND store_id=$2`,
      [product_id, req.user.store_id]
    );

    if (product.rows.length === 0) {
      return res.json({ ok: false, error: "product not found" });
    }

    if (product.rows[0].stock < qty) {
      return res.json({ ok: false, error: "stock not enough" });
    }

    await pool.query(
      `UPDATE products SET stock=stock-$1 WHERE id=$2 AND store_id=$3`,
      [qty, product_id, req.user.store_id]
    );

    await pool.query(
      `INSERT INTO stock_history(product_id,qty,type,total,status,store_id)
       VALUES($1,$2,'DAMAGE',0,'RUSAK',$3)`,
      [product_id, qty, req.user.store_id]
    );

    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.post("/checkout", auth, async (req, res) => {
  try {
    const { items } = req.body;
    let total = 0;
    const finalItems = [];

    for (let i of items) {
      const p = await pool.query(
        `SELECT * FROM products WHERE id=$1 AND store_id=$2`,
        [i.product_id, req.user.store_id]
      );

      if (p.rows.length === 0) {
        return res.json({ ok: false, error: "product not found" });
      }

      if (p.rows[0].stock < i.qty) {
        return res.json({ ok: false, error: "stock not enough" });
      }

      await pool.query(
        `UPDATE products SET stock=stock-$1 WHERE id=$2 AND store_id=$3`,
        [i.qty, i.product_id, req.user.store_id]
      );

      const subtotal = p.rows[0].price * i.qty;
      total += subtotal;

      await pool.query(
        `INSERT INTO stock_history(product_id,qty,type,total,status,store_id)
         VALUES($1,$2,'OUT',$3,'DONE',$4)`,
        [p.rows[0].id, i.qty, subtotal, req.user.store_id]
      );

      finalItems.push({
        product_id: p.rows[0].id,
        name: p.rows[0].name,
        price: p.rows[0].price,
        qty: i.qty,
        subtotal
      });
    }

    res.json({
      ok: true,
      total,
      items: finalItems
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.get("/sales/report", auth, async (req, res) => {
  try {
    const sales = await pool.query(
      `
      SELECT
        p.name as product_name,
        h.qty,
        h.total,
        h.status,
        h.created_at,
        p.price
      FROM stock_history h
      JOIN products p ON h.product_id=p.id
      WHERE h.store_id=$1
      ORDER BY h.created_at DESC
      `,
      [req.user.store_id]
    );

    res.json({
      ok: true,
      data: sales.rows
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.get("/dashboard", auth, async (req, res) => {
  try {
    const balance = await pool.query(
      `SELECT COALESCE(SUM(total),0) AS total_balance FROM stock_history WHERE store_id=$1 AND status='DONE'`,
      [req.user.store_id]
    );

    const sold = await pool.query(
      `SELECT COALESCE(SUM(qty),0) AS sold_qty FROM stock_history WHERE store_id=$1 AND status='DONE'`,
      [req.user.store_id]
    );

    const low = await pool.query(
      `SELECT * FROM products WHERE store_id=$1 ORDER BY stock ASC LIMIT 1`,
      [req.user.store_id]
    );

    res.json({
      ok: true,
      balance: balance.rows[0].total_balance || 0,
      sold: sold.rows[0].sold_qty || 0,
      lowStock: low.rows.length,
      lowestItem: low.rows[0] || null
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.get("/tracker", auth, async (req, res) => {
  try {
    const tracker = await pool.query(
      `
      SELECT DATE(created_at) as day, SUM(total) as total
      FROM stock_history
      WHERE store_id=$1
      GROUP BY DATE(created_at)
      ORDER BY day DESC
      LIMIT 7
      `,
      [req.user.store_id]
    );

    res.json({
      ok: true,
      data: tracker.rows
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => {
  console.log("RUNNING", PORT);
});