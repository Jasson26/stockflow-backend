const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

/*
DATABASE CONNECTION
Railway otomatis menyediakan DATABASE_URL
*/
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

/*
TEST SERVER
*/
app.get("/", (req, res) => {
  res.send("StockFlow API Running");
});

/*
TEST DATABASE
*/
app.get("/db-test", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW()");
    res.json(result.rows);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

/*
CREATE PRODUCTS TABLE
*/
app.get("/init-db", async (req, res) => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        stock INTEGER DEFAULT 0,
        price INTEGER DEFAULT 0
      );
    `);

    res.send("Database initialized");
  } catch (err) {
    res.status(500).send(err.message);
  }
});

/*
GET PRODUCTS
*/
app.get("/products", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM products ORDER BY id DESC");
    res.json(result.rows);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

/*
ADD PRODUCT
*/
app.post("/products", async (req, res) => {
  try {
    const { name, stock, price } = req.body;

    const result = await pool.query(
      "INSERT INTO products (name, stock, price) VALUES ($1,$2,$3) RETURNING *",
      [name, stock, price]
    );

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

/*
UPDATE STOCK
*/
app.put("/products/:id/stock", async (req, res) => {
  try {
    const { qty } = req.body;

    const result = await pool.query(
      "UPDATE products SET stock = stock + $1 WHERE id=$2 RETURNING *",
      [qty, req.params.id]
    );

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

/*
START SERVER
*/
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});