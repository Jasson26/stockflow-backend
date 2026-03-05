const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Bikin pool hanya kalau DATABASE_URL ada
let pool = null;
if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // Railway Postgres umumnya butuh SSL saat akses via public host.
    // Kalau internal railway kadang tidak butuh, tapi setting ini biasanya tetap aman.
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

// test DB
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

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});