const express = require("express")
const cors = require("cors")
const { Pool } = require("pg")

const app = express()

app.use(cors())
app.use(express.json())

/*
==============================
DATABASE CONNECTION
==============================
*/

const pool = new Pool({
 connectionString: process.env.DATABASE_URL,
 ssl: {
  rejectUnauthorized: false
 }
})

/*
==============================
ROOT
==============================
*/

app.get("/", async (req, res) => {

 try {

  res.json({
   ok: true,
   message: "StockFlow API Running",
   hasDatabaseUrl: !!process.env.DATABASE_URL
  })

 } catch (err) {

  res.status(500).json({
   ok: false,
   error: err.message
  })

 }

})

/*
==============================
INIT DATABASE
==============================
*/

app.get("/init-db", async (req, res) => {

 try {

  await pool.query(`
   CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    name TEXT,
    email TEXT UNIQUE,
    password TEXT,
    role TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
   );
  `)

  await pool.query(`
   ALTER TABLE users
   ADD COLUMN IF NOT EXISTS role TEXT;
  `)

  await pool.query(`
   ALTER TABLE users
   ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
  `)

  await pool.query(`
   CREATE TABLE IF NOT EXISTS products (
    id SERIAL PRIMARY KEY,
    product_id TEXT,
    name TEXT,
    category TEXT,
    price_buy INTEGER,
    price_sell INTEGER,
    stock INTEGER,
    min_stock INTEGER,
    barcode TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
   );
  `)

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
  `)

  await pool.query(`
   CREATE TABLE IF NOT EXISTS tracker_notifications (
    id SERIAL PRIMARY KEY,
    title TEXT,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
   );
  `)

  res.json({
   ok: true,
   message: "DATABASE TABLES CREATED / UPDATED"
  })

 } catch (err) {

  res.status(500).json({
   ok: false,
   error: err.message
  })

 }

})

/*
==============================
RESET USERS
==============================
*/

app.get("/reset-users", async (req, res) => {

 try {

  // hapus sessions jika ada
  await pool.query(`DELETE FROM sessions`)

  // hapus users
  await pool.query(`DELETE FROM users`)

  // reset auto increment
  await pool.query(`ALTER SEQUENCE users_id_seq RESTART WITH 1`)

  res.json({
   ok: true,
   message: "ALL USERS RESET"
  })

 } catch (err) {

  res.status(500).json({
   ok: false,
   error: err.message
  })

 }

})

/*
==============================
REGISTER
==============================
*/

app.post("/auth/register", async (req, res) => {

 try {

  const { name, email, password } = req.body

  if (!name || !email || !password) {
   return res.status(400).json({
    ok: false,
    error: "name, email, password required"
   })
  }

  const userCount = await pool.query(`
   SELECT COUNT(*) FROM users
  `)

  const role = Number(userCount.rows[0].count) === 0
   ? "OWNER"
   : "STAFF"

  const result = await pool.query(`
   INSERT INTO users (name,email,password,role)
   VALUES ($1,$2,$3,$4)
   RETURNING id,name,email,role
  `,[name,email,password,role])

  res.json({
   ok: true,
   message: "REGISTER SUCCESS",
   data: result.rows[0]
  })

 } catch (err) {

  res.status(500).json({
   ok: false,
   error: err.message
  })

 }

})

/*
==============================
LOGIN
==============================
*/

app.post("/auth/login", async (req,res)=>{

 try{

  const { email,password } = req.body

  const result = await pool.query(`
   SELECT id,name,email,role
   FROM users
   WHERE email=$1 AND password=$2
  `,[email,password])

  if(result.rows.length === 0){

   return res.status(401).json({
    ok:false,
    error:"Invalid email or password"
   })

  }

  res.json({
   ok:true,
   message:"LOGIN SUCCESS",
   data:result.rows[0]
  })

 }
 catch(err){

  res.status(500).json({
   ok:false,
   error:err.message
  })

 }

})

/*
==============================
GET PRODUCTS
==============================
*/

app.get("/products", async (req,res)=>{

 try{

  const result = await pool.query(`
   SELECT *
   FROM products
   ORDER BY created_at DESC
  `)

  res.json({
   ok:true,
   data:result.rows
  })

 }
 catch(err){

  res.status(500).json({
   ok:false,
   error:err.message
  })

 }

})

/*
==============================
ADD PRODUCT
==============================
*/

app.post("/products/add", async (req,res)=>{

 try{

  const {
   name,
   category,
   price_buy,
   price_sell,
   stock,
   min_stock
  } = req.body

  const result = await pool.query(`
   INSERT INTO products
   (name,category,price_buy,price_sell,stock,min_stock)
   VALUES ($1,$2,$3,$4,$5,$6)
   RETURNING *
  `,[name,category,price_buy,price_sell,stock,min_stock])

  res.json({
   ok:true,
   data:result.rows[0]
  })

 }
 catch(err){

  res.status(500).json({
   ok:false,
   error:err.message
  })

 }

})

/*
==============================
SERVER START
==============================
*/

const PORT = process.env.PORT || 8080

app.listen(PORT, () => {
 console.log("Server running on port", PORT)
})