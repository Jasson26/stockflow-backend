const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Create pool only if DATABASE_URL exists
let pool = null;
if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    message: "StockFlow API Running",
    hasDatabaseUrl: Boolean(process.env.DATABASE_URL),
  });
});

app.get("/db-test", async (req, res) => {
  try {
    if (!pool) {
      return res.status(500).json({
        ok: false,
        error: "DATABASE_URL is missing in backend service variables",
      });
    }
    const r = await pool.query("SELECT NOW() as now");
    res.json({ ok: true, rows: r.rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Initialize DB schema (create tables)
app.get("/init-db", async (req, res) => {
  try {
    if (!pool) {
      return res.status(500).json({
        ok: false,
        error: "DATABASE_URL is missing in backend service variables",
      });
    }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        sku TEXT,
        stock INTEGER NOT NULL DEFAULT 0,
        price INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    res.json({ ok: true, message: "Database initialized (products table)" });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Get products
app.get("/products", async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ ok: false, error: "DB not configured" });
    const r = await pool.query("SELECT * FROM products ORDER BY id DESC");
    res.json({ ok: true, data: r.rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Add product
app.post("/products", async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ ok: false, error: "DB not configured" });

    const { name, sku = null, stock = 0, price = 0 } = req.body || {};
    if (!name || typeof name !== "string") {
      return res.status(400).json({ ok: false, error: "name is required" });
    }

    const r = await pool.query(
      "INSERT INTO products (name, sku, stock, price) VALUES ($1,$2,$3,$4) RETURNING *",
      [name, sku, Number(stock) || 0, Number(price) || 0]
    );

    res.json({ ok: true, data: r.rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Update stock delta (add/subtract)
app.put("/products/:id/stock", async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ ok: false, error: "DB not configured" });

    const id = Number(req.params.id);
    const { qty } = req.body || {};
    const delta = Number(qty);

    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "Invalid product id" });
    if (!Number.isFinite(delta)) return res.status(400).json({ ok: false, error: "qty must be a number" });

    const r = await pool.query(
      "UPDATE products SET stock = stock + $1 WHERE id = $2 RETURNING *",
      [delta, id]
    );

    if (r.rows.length === 0) return res.status(404).json({ ok: false, error: "Product not found" });
    res.json({ ok: true, data: r.rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});