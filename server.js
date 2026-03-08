const express = require("express")
const cors = require("cors")
const { Pool } = require("pg")
const PDFDocument = require("pdfkit")

const app = express()

app.use(cors())
app.use(express.json())

/*
========================
DATABASE
========================
*/

const pool = new Pool({
 connectionString: process.env.DATABASE_URL,
 ssl:{rejectUnauthorized:false}
})

/*
========================
ROOT
========================
*/

app.get("/",(req,res)=>{

 res.json({
  ok:true,
  message:"StockFlow API Running"
 })

})

/*
========================
INIT DATABASE
========================
*/

app.get("/init-db",async(req,res)=>{

 try{

 await pool.query(`
 CREATE TABLE IF NOT EXISTS users(
 id SERIAL PRIMARY KEY,
 name TEXT,
 email TEXT UNIQUE,
 password TEXT,
 role TEXT,
 created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
 )
 `)

 await pool.query(`
 CREATE TABLE IF NOT EXISTS products(
 id SERIAL PRIMARY KEY,
 name TEXT,
 category TEXT,
 price_buy INTEGER,
 price_sell INTEGER,
 stock INTEGER,
 min_stock INTEGER,
 barcode TEXT,
 created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
 )
 `)

 await pool.query(`
 CREATE TABLE IF NOT EXISTS sales(
 id SERIAL PRIMARY KEY,
 product_id INTEGER,
 product_name TEXT,
 qty INTEGER,
 total INTEGER,
 status TEXT,
 staff TEXT,
 created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
 )
 `)

 res.json({
 ok:true,
 message:"DATABASE READY"
 })

 }catch(err){

 res.json({
 ok:false,
 error:err.message
 })

 }

})

/*
========================
REGISTER
========================
*/

app.post("/auth/register",async(req,res)=>{

 try{

 const {name,email,password}=req.body

 const count=await pool.query(`
 SELECT COUNT(*) FROM users
 `)

 const role = Number(count.rows[0].count)===0
 ? "OWNER"
 : "STAFF"

 const result=await pool.query(`
 INSERT INTO users(name,email,password,role)
 VALUES($1,$2,$3,$4)
 RETURNING id,name,email,role
 `,[name,email,password,role])

 res.json({
 ok:true,
 data:result.rows[0]
 })

 }catch(err){

 res.json({
 ok:false,
 error:err.message
 })

 }

})

/*
========================
LOGIN
========================
*/

app.post("/auth/login",async(req,res)=>{

 try{

 const {email,password}=req.body

 const result=await pool.query(`
 SELECT id,name,email,role
 FROM users
 WHERE email=$1 AND password=$2
 `,[email,password])

 if(result.rows.length===0){

 return res.json({
 ok:false,
 error:"Login gagal"
 })

 }

 res.json({
 ok:true,
 data:result.rows[0]
 })

 }catch(err){

 res.json({
 ok:false,
 error:err.message
 })

 }

})

/*
========================
ADD PRODUCT
========================
*/

app.post("/products/add",async(req,res)=>{

 try{

 const {name,category,price_buy,price_sell,stock,min_stock,barcode}=req.body

 const result=await pool.query(`
 INSERT INTO products
 (name,category,price_buy,price_sell,stock,min_stock,barcode)
 VALUES($1,$2,$3,$4,$5,$6,$7)
 RETURNING *
 `,[name,category,price_buy,price_sell,stock,min_stock,barcode])

 res.json({
 ok:true,
 data:result.rows[0]
 })

 }catch(err){

 res.json({
 ok:false,
 error:err.message
 })

 }

})

/*
========================
GET PRODUCTS
========================
*/

app.get("/products",async(req,res)=>{

 const result=await pool.query(`
 SELECT * FROM products
 ORDER BY created_at DESC
 `)

 res.json({
 ok:true,
 data:result.rows
 })

})

/*
========================
BARCODE LOOKUP
========================
*/

app.get("/products/barcode/:code",async(req,res)=>{

 const {code}=req.params

 const result=await pool.query(`
 SELECT *
 FROM products
 WHERE barcode=$1
 `,[code])

 if(result.rows.length===0){

 return res.json({
 ok:false,
 error:"Product not found"
 })

 }

 res.json({
 ok:true,
 data:result.rows[0]
 })

})

/*
========================
STOCK IN
========================
*/

app.post("/stock/in",async(req,res)=>{

 const {id,qty}=req.body

 const result=await pool.query(`
 UPDATE products
 SET stock = stock + $1
 WHERE id=$2
 RETURNING *
 `,[qty,id])

 res.json({
 ok:true,
 data:result.rows[0]
 })

})

/*
========================
STOCK OUT
========================
*/

app.post("/stock/out",async(req,res)=>{

 const {id,qty,staff}=req.body

 const product=await pool.query(`
 SELECT * FROM products WHERE id=$1
 `,[id])

 const item=product.rows[0]

 const total=item.price_sell * qty

 await pool.query(`
 UPDATE products
 SET stock=stock-$1
 WHERE id=$2
 `,[qty,id])

 await pool.query(`
 INSERT INTO sales(product_id,product_name,qty,total,status,staff)
 VALUES($1,$2,$3,$4,'DONE',$5)
 `,[id,item.name,qty,total,staff])

 res.json({
 ok:true
 })

})

/*
========================
STOCK DAMAGE
========================
*/

app.post("/stock/damage",async(req,res)=>{

 const {id,qty,staff}=req.body

 const product=await pool.query(`
 SELECT * FROM products WHERE id=$1
 `,[id])

 const item=product.rows[0]

 await pool.query(`
 UPDATE products
 SET stock=stock-$1
 WHERE id=$2
 `,[qty,id])

 await pool.query(`
 INSERT INTO sales(product_id,product_name,qty,total,status,staff)
 VALUES($1,$2,$3,0,'RUSAK',$4)
 `,[id,item.name,qty,staff])

 res.json({
 ok:true
 })

})

/*
========================
SALES REPORT
========================
*/

app.get("/sales/report",async(req,res)=>{

 const result=await pool.query(`
 SELECT * FROM sales
 ORDER BY created_at DESC
 `)

 res.json({
 ok:true,
 data:result.rows
 })

})

/*
========================
PDF REPORT
========================
*/

app.get("/sales/report/pdf",async(req,res)=>{

 const result=await pool.query(`
 SELECT *
 FROM sales
 ORDER BY created_at DESC
 `)

 const doc=new PDFDocument()

 res.setHeader("Content-Type","application/pdf")
 res.setHeader("Content-Disposition","inline; filename=report.pdf")

 doc.pipe(res)

 doc.fontSize(20).text("StockFlow Sales Report",{align:"center"})

 doc.moveDown()

 result.rows.forEach(sale=>{

 doc.fontSize(12).text(`
 Product : ${sale.product_name}
 Qty : ${sale.qty}
 Total : Rp ${sale.total}
 Status : ${sale.status}
 Staff : ${sale.staff}
 Date : ${sale.created_at}
 ------------------------------
 `)

 })

 doc.end()

})

/*
========================
DASHBOARD
========================
*/

app.get("/dashboard",async(req,res)=>{

 const balance=await pool.query(`
 SELECT COALESCE(SUM(total),0) AS balance
 FROM sales
 WHERE status='DONE'
 `)

 const lowStock=await pool.query(`
 SELECT COUNT(*) FROM products
 WHERE stock<=min_stock
 `)

 res.json({
 ok:true,
 balance:balance.rows[0].balance,
 lowStock:lowStock.rows[0].count
 })

})

/*
========================
TRACKER GRAPH
========================
*/

app.get("/tracker",async(req,res)=>{

 const result=await pool.query(`
 SELECT DATE(created_at) AS day,
 SUM(total) AS total
 FROM sales
 WHERE status='DONE'
 GROUP BY day
 ORDER BY day DESC
 LIMIT 7
 `)

 res.json({
 ok:true,
 data:result.rows
 })

})

/*
========================
SERVER START
========================
*/

const PORT = process.env.PORT || 8080

app.listen(PORT,()=>{
 console.log("Server running on port",PORT)
})