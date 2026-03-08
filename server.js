const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();

app.use(cors());
app.use(express.json());

/*
================================
DATABASE CONNECTION
================================
*/
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

/*
================================
HELPERS
================================
*/
function formatDateTime(date = new Date()) {
  return date.toISOString();
}

function getWeekdayLabel(dateString) {
  const date = new Date(dateString);
  const day = date.getDay();
  // Minggu, Senin, Selasa, Rabu, Kamis, Jumat, Sabtu
  const labels = ["M", "S", "S", "R", "K", "J", "S"];
  return labels[day];
}

async function ensureTrackerNotification(title, description) {
  await pool.query(
    `
    INSERT INTO tracker_notifications (title, description, created_at)
    VALUES ($1, $2, CURRENT_TIMESTAMP)
    `,
    [title, description]
  );
}

async function getUserCount() {
  const result = await pool.query(`SELECT COUNT(*)::int AS total FROM users`);
  return result.rows[0].total;
}

/*
================================
ROOT TEST
================================
*/
app.get("/", async (req, res) => {
  try {
    res.json({
      ok: true,
      message: "StockFlow API Running",
      hasDatabaseUrl: !!process.env.DATABASE_URL
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

/*
================================
INIT DATABASE
================================
*/
app.get("/init-db", async (req, res) => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        role TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        product_id TEXT,
        name TEXT NOT NULL,
        category TEXT,
        price_buy INTEGER DEFAULT 0,
        price_sell INTEGER DEFAULT 0,
        stock INTEGER DEFAULT 0,
        min_stock INTEGER DEFAULT 10,
        barcode TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS sales (
        id SERIAL PRIMARY KEY,
        product_id INTEGER,
        product_name TEXT,
        qty INTEGER,
        total INTEGER,
        status TEXT,
        staff TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS tracker_notifications (
        id SERIAL PRIMARY KEY,
        title TEXT,
        description TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
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
================================
AUTH - REGISTER
User pertama = OWNER
User berikutnya = STAFF
================================
*/
app.post("/auth/register", async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({
        ok: false,
        error: "name, email, password wajib diisi"
      });
    }

    const totalUsers = await getUserCount();
    const role = totalUsers === 0 ? "OWNER" : "STAFF";

    const result = await pool.query(
      `
      INSERT INTO users (name, email, password, role)
      VALUES ($1, $2, $3, $4)
      RETURNING id, name, email, role, created_at
      `,
      [name, email, password, role]
    );

    if (role === "OWNER") {
      await ensureTrackerNotification(
        "Owner Account Created",
        `${name} terdaftar sebagai OWNER pertama`
      );
    }

    res.json({
      ok: true,
      message: "REGISTER SUCCESS",
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
================================
AUTH - LOGIN
================================
*/
app.post("/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        ok: false,
        error: "email dan password wajib diisi"
      });
    }

    const result = await pool.query(
      `
      SELECT id, name, email, role
      FROM users
      WHERE email = $1 AND password = $2
      `,
      [email, password]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        ok: false,
        error: "Email atau password salah"
      });
    }

    res.json({
      ok: true,
      message: "LOGIN SUCCESS",
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
================================
ACCOUNT INFO
================================
*/
app.get("/account/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `
      SELECT id, name, email, role, created_at
      FROM users
      WHERE id = $1
      `,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        ok: false,
        error: "User tidak ditemukan"
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
================================
PRODUCTS - CREATE
================================
*/
app.post("/products/add", async (req, res) => {
  try {
    const {
      product_id,
      name,
      category,
      price_buy,
      price_sell,
      stock,
      min_stock,
      barcode
    } = req.body;

    if (!name) {
      return res.status(400).json({
        ok: false,
        error: "Nama produk wajib diisi"
      });
    }

    const result = await pool.query(
      `
      INSERT INTO products (
        product_id, name, category, price_buy, price_sell, stock, min_stock, barcode
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING *
      `,
      [
        product_id || null,
        name,
        category || null,
        Number(price_buy) || 0,
        Number(price_sell) || 0,
        Number(stock) || 0,
        Number(min_stock) || 10,
        barcode || null
      ]
    );

    res.json({
      ok: true,
      message: "PRODUCT ADDED",
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
================================
PRODUCTS - GET ALL
================================
*/
app.get("/products", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT *
      FROM products
      ORDER BY created_at DESC, id DESC
    `);

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
================================
PRODUCTS - GET BY BARCODE
================================
*/
app.get("/products/barcode/:barcode", async (req, res) => {
  try {
    const { barcode } = req.params;

    const result = await pool.query(
      `
      SELECT *
      FROM products
      WHERE barcode = $1
      LIMIT 1
      `,
      [barcode]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        ok: false,
        error: "Produk dengan barcode tersebut tidak ditemukan"
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
================================
PRODUCTS - UPDATE BASIC
================================
*/
app.put("/products/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const {
      product_id,
      name,
      category,
      price_buy,
      price_sell,
      min_stock,
      barcode
    } = req.body;

    const result = await pool.query(
      `
      UPDATE products
      SET
        product_id = $1,
        name = $2,
        category = $3,
        price_buy = $4,
        price_sell = $5,
        min_stock = $6,
        barcode = $7
      WHERE id = $8
      RETURNING *
      `,
      [
        product_id || null,
        name,
        category || null,
        Number(price_buy) || 0,
        Number(price_sell) || 0,
        Number(min_stock) || 10,
        barcode || null,
        id
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        ok: false,
        error: "Produk tidak ditemukan"
      });
    }

    res.json({
      ok: true,
      message: "PRODUCT UPDATED",
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
================================
STOCK IN
Jika product_id sudah ada -> tambah stock
Jika pakai id -> tambah stock produk itu
================================
*/
app.post("/stock/in", async (req, res) => {
  try {
    const {
      id,
      product_id,
      name,
      category,
      price_buy,
      price_sell,
      min_stock,
      qty,
      barcode
    } = req.body;

    const quantity = Number(qty) || 0;

    if (quantity <= 0) {
      return res.status(400).json({
        ok: false,
        error: "Qty harus lebih dari 0"
      });
    }

    let product = null;

    if (id) {
      const findById = await pool.query(
        `SELECT * FROM products WHERE id = $1 LIMIT 1`,
        [id]
      );
      if (findById.rows.length > 0) {
        product = findById.rows[0];
      }
    } else if (product_id) {
      const findByProductId = await pool.query(
        `SELECT * FROM products WHERE product_id = $1 LIMIT 1`,
        [product_id]
      );
      if (findByProductId.rows.length > 0) {
        product = findByProductId.rows[0];
      }
    } else if (barcode) {
      const findByBarcode = await pool.query(
        `SELECT * FROM products WHERE barcode = $1 LIMIT 1`,
        [barcode]
      );
      if (findByBarcode.rows.length > 0) {
        product = findByBarcode.rows[0];
      }
    }

    let result;

    if (product) {
      result = await pool.query(
        `
        UPDATE products
        SET
          stock = stock + $1,
          name = COALESCE($2, name),
          category = COALESCE($3, category),
          price_buy = COALESCE($4, price_buy),
          price_sell = COALESCE($5, price_sell),
          min_stock = COALESCE($6, min_stock),
          barcode = COALESCE($7, barcode)
        WHERE id = $8
        RETURNING *
        `,
        [
          quantity,
          name || null,
          category || null,
          price_buy !== undefined ? Number(price_buy) : null,
          price_sell !== undefined ? Number(price_sell) : null,
          min_stock !== undefined ? Number(min_stock) : null,
          barcode || null,
          product.id
        ]
      );
    } else {
      if (!name) {
        return res.status(400).json({
          ok: false,
          error: "Produk baru wajib punya nama"
        });
      }

      result = await pool.query(
        `
        INSERT INTO products (
          product_id, name, category, price_buy, price_sell, stock, min_stock, barcode
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        RETURNING *
        `,
        [
          product_id || null,
          name,
          category || null,
          Number(price_buy) || 0,
          Number(price_sell) || 0,
          quantity,
          Number(min_stock) || 10,
          barcode || null
        ]
      );
    }

    res.json({
      ok: true,
      message: "STOCK IN SUCCESS",
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
================================
STOCK OUT / BARANG KELUAR (JUAL)
Kurangi stok
Masukkan ke sales status DONE
================================
*/
app.post("/stock/out", async (req, res) => {
  try {
    const { id, qty, staff } = req.body;
    const quantity = Number(qty) || 0;

    if (!id || quantity <= 0) {
      return res.status(400).json({
        ok: false,
        error: "id dan qty wajib valid"
      });
    }

    const productResult = await pool.query(
      `SELECT * FROM products WHERE id = $1 LIMIT 1`,
      [id]
    );

    if (productResult.rows.length === 0) {
      return res.status(404).json({
        ok: false,
        error: "Produk tidak ditemukan"
      });
    }

    const product = productResult.rows[0];

    if (Number(product.stock) < quantity) {
      return res.status(400).json({
        ok: false,
        error: "Stok tidak mencukupi"
      });
    }

    const updatedProduct = await pool.query(
      `
      UPDATE products
      SET stock = stock - $1
      WHERE id = $2
      RETURNING *
      `,
      [quantity, id]
    );

    const total = Number(product.price_sell || 0) * quantity;

    const sale = await pool.query(
      `
      INSERT INTO sales (
        product_id, product_name, qty, total, status, staff, created_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,CURRENT_TIMESTAMP)
      RETURNING *
      `,
      [
        product.id,
        product.name,
        quantity,
        total,
        "DONE",
        staff || "Unknown"
      ]
    );

    res.json({
      ok: true,
      message: "STOCK OUT SUCCESS",
      product: updatedProduct.rows[0],
      sale: sale.rows[0]
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

/*
================================
STOCK DAMAGE / BARANG RUSAK
Kurangi stok
Masukkan ke sales status RUSAK
total = 0
================================
*/
app.post("/stock/damage", async (req, res) => {
  try {
    const { id, qty, staff } = req.body;
    const quantity = Number(qty) || 0;

    if (!id || quantity <= 0) {
      return res.status(400).json({
        ok: false,
        error: "id dan qty wajib valid"
      });
    }

    const productResult = await pool.query(
      `SELECT * FROM products WHERE id = $1 LIMIT 1`,
      [id]
    );

    if (productResult.rows.length === 0) {
      return res.status(404).json({
        ok: false,
        error: "Produk tidak ditemukan"
      });
    }

    const product = productResult.rows[0];

    if (Number(product.stock) < quantity) {
      return res.status(400).json({
        ok: false,
        error: "Stok tidak mencukupi"
      });
    }

    const updatedProduct = await pool.query(
      `
      UPDATE products
      SET stock = stock - $1
      WHERE id = $2
      RETURNING *
      `,
      [quantity, id]
    );

    const sale = await pool.query(
      `
      INSERT INTO sales (
        product_id, product_name, qty, total, status, staff, created_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,CURRENT_TIMESTAMP)
      RETURNING *
      `,
      [
        product.id,
        product.name,
        quantity,
        0,
        "RUSAK",
        staff || "Unknown"
      ]
    );

    res.json({
      ok: true,
      message: "DAMAGE REPORT SUCCESS",
      product: updatedProduct.rows[0],
      sale: sale.rows[0]
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

/*
================================
SALES REPORT
================================
*/
app.get("/sales/report", async (req, res) => {
  try {
    const sort = req.query.sort || "recent";

    let orderBy = "created_at DESC";

    if (sort === "oldest") orderBy = "created_at ASC";
    if (sort === "qty") orderBy = "qty DESC";
    if (sort === "total") orderBy = "total DESC";

    const result = await pool.query(`
      SELECT *
      FROM sales
      ORDER BY ${orderBy}
    `);

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
================================
INVENTORY REPORT
================================
*/
app.get("/inventory/report", async (req, res) => {
  try {
    const sort = req.query.sort || "recent";

    let orderBy = "created_at DESC";

    if (sort === "stock_high") orderBy = "stock DESC";
    if (sort === "stock_low") orderBy = "stock ASC";
    if (sort === "name_asc") orderBy = "name ASC";
    if (sort === "name_desc") orderBy = "name DESC";

    const result = await pool.query(`
      SELECT *
      FROM products
      ORDER BY ${orderBy}
    `);

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
================================
DASHBOARD
- total balance real time
- total penjualan
- stock menipis
- recent activity penting
================================
*/
app.get("/dashboard", async (req, res) => {
  try {
    const balanceResult = await pool.query(`
      SELECT COALESCE(SUM(total), 0)::int AS balance
      FROM sales
      WHERE status = 'DONE'
    `);

    const totalSalesResult = await pool.query(`
      SELECT COALESCE(COUNT(*), 0)::int AS total_sales
      FROM sales
      WHERE status = 'DONE'
    `);

    const lowStockResult = await pool.query(`
      SELECT COALESCE(COUNT(*), 0)::int AS low_stock_count
      FROM products
      WHERE stock <= min_stock
    `);

    const thinnestStockResult = await pool.query(`
      SELECT name, stock
      FROM products
      ORDER BY stock ASC, created_at DESC
      LIMIT 1
    `);

    const recentActivityResult = await pool.query(`
      SELECT *
      FROM sales
      ORDER BY created_at DESC
      LIMIT 5
    `);

    res.json({
      ok: true,
      data: {
        balance: balanceResult.rows[0].balance,
        total_sales: totalSalesResult.rows[0].total_sales,
        low_stock_count: lowStockResult.rows[0].low_stock_count,
        thinnest_stock: thinnestStockResult.rows[0] || null,
        recent_activity: recentActivityResult.rows
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
================================
TRACKER
Grafik penjualan per hari (mingguan)
================================
*/
app.get("/tracker", async (req, res) => {
  try {
    const statsResult = await pool.query(`
      SELECT
        DATE(created_at) AS sale_date,
        COALESCE(SUM(total), 0)::int AS amount
      FROM sales
      WHERE status = 'DONE'
        AND created_at >= NOW() - INTERVAL '7 days'
      GROUP BY DATE(created_at)
      ORDER BY sale_date ASC
    `);

    const trackerNotifResult = await pool.query(`
      SELECT *
      FROM tracker_notifications
      ORDER BY created_at DESC
      LIMIT 10
    `);

    const chart = statsResult.rows.map(row => ({
      date: row.sale_date,
      label: getWeekdayLabel(row.sale_date),
      amount: row.amount
    }));

    res.json({
      ok: true,
      data: {
        chart,
        notifications: trackerNotifResult.rows
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
================================
TRACKER - ADD IMPORTANT NOTIF
Manual helper endpoint kalau nanti dibutuhkan
================================
*/
app.post("/tracker/notify", async (req, res) => {
  try {
    const { title, description } = req.body;

    if (!title || !description) {
      return res.status(400).json({
        ok: false,
        error: "title dan description wajib diisi"
      });
    }

    const result = await pool.query(
      `
      INSERT INTO tracker_notifications (title, description, created_at)
      VALUES ($1, $2, CURRENT_TIMESTAMP)
      RETURNING *
      `,
      [title, description]
    );

    res.json({
      ok: true,
      message: "TRACKER NOTIFICATION ADDED",
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
================================
SERVER START
================================
*/
const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});