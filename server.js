const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const sgMail = require("@sendgrid/mail");

const app = express();

app.use(cors());
app.use(express.json());

/*
DATABASE
*/

const pool = new Pool({
connectionString: process.env.DATABASE_URL,
ssl: { rejectUnauthorized: false }
});

/*
SENDGRID
*/

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

/*
HELPER
*/

function generateCode(){
return Math.floor(100000 + Math.random()*900000).toString();
}

/*
ROOT
*/

app.get("/", (req,res)=>{

res.json({
ok:true,
message:"StockFlow API Running"
});

});

/*
INIT DATABASE
*/

app.get("/init-db", async(req,res)=>{

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
`);

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
`);

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
`);

await pool.query(`
CREATE TABLE IF NOT EXISTS password_resets(
id SERIAL PRIMARY KEY,
email TEXT,
code TEXT,
expires_at TIMESTAMP,
used BOOLEAN DEFAULT FALSE
)
`);

res.json({
ok:true,
message:"DATABASE TABLES CREATED"
});

}catch(err){

res.status(500).json({
ok:false,
error:err.message
});

}

});

/*
RESET USERS (DEV ONLY)
*/

app.get("/reset-users", async(req,res)=>{

try{

await pool.query(`DELETE FROM password_resets`);
await pool.query(`DELETE FROM users`);

res.json({
ok:true,
message:"ALL USERS DELETED"
});

}catch(err){

res.status(500).json({
ok:false,
error:err.message
});

}

});

/*
REGISTER
*/

app.post("/auth/register", async(req,res)=>{

try{

const { name,email,password } = req.body;

const count = await pool.query(`
SELECT COUNT(*) FROM users
`);

const role = Number(count.rows[0].count) === 0 ? "OWNER" : "STAFF";

const result = await pool.query(`
INSERT INTO users(name,email,password,role)
VALUES($1,$2,$3,$4)
RETURNING id,name,email,role
`,[name,email,password,role]);

res.json({
ok:true,
message:"REGISTER SUCCESS",
data:result.rows[0]
});

}catch(err){

res.status(500).json({
ok:false,
error:err.message
});

}

});

/*
LOGIN
*/

app.post("/auth/login", async(req,res)=>{

try{

const { email,password } = req.body;

const result = await pool.query(`
SELECT id,name,email,role
FROM users
WHERE email=$1 AND password=$2
`,[email,password]);

if(result.rows.length === 0){

return res.json({
ok:false,
error:"Email atau password salah"
});

}

res.json({
ok:true,
data:result.rows[0]
});

}catch(err){

res.status(500).json({
ok:false,
error:err.message
});

}

});

/*
FORGOT PASSWORD
*/

app.post("/auth/forgot-password", async(req,res)=>{

try{

const { email } = req.body;

const user = await pool.query(`
SELECT * FROM users
WHERE email=$1
`,[email]);

if(user.rows.length === 0){

return res.json({
ok:false,
error:"Email tidak ditemukan"
});

}

const code = generateCode();

const expire = new Date(Date.now()+10*60*1000);

await pool.query(`
INSERT INTO password_resets(email,code,expires_at)
VALUES($1,$2,$3)
`,[email,code,expire]);

await sgMail.send({

to:email,
from:process.env.SENDGRID_FROM,
subject:"StockFlow Reset Password",

html:`
<h2>StockFlow Reset Password</h2>
<p>Kode reset password kamu:</p>
<h1>${code}</h1>
<p>Kode berlaku 10 menit</p>
`

});

res.json({
ok:true,
message:"Reset code sent"
});

}catch(err){

res.status(500).json({
ok:false,
error:err.message
});

}

});

/*
RESET PASSWORD
*/

app.post("/auth/reset-password", async(req,res)=>{

try{

const { email,code,newPassword } = req.body;

const reset = await pool.query(`
SELECT * FROM password_resets
WHERE email=$1 AND code=$2 AND used=false
ORDER BY id DESC
LIMIT 1
`,[email,code]);

if(reset.rows.length === 0){

return res.json({
ok:false,
error:"Invalid code"
});

}

await pool.query(`
UPDATE users
SET password=$1
WHERE email=$2
`,[newPassword,email]);

await pool.query(`
UPDATE password_resets
SET used=true
WHERE id=$1
`,[reset.rows[0].id]);

res.json({
ok:true,
message:"Password updated"
});

}catch(err){

res.status(500).json({
ok:false,
error:err.message
});

}

});

/*
PRODUCT ADD
*/

app.post("/products/add", async(req,res)=>{

try{

const { name,category,price_buy,price_sell,stock,min_stock,barcode } = req.body;

const result = await pool.query(`
INSERT INTO products(name,category,price_buy,price_sell,stock,min_stock,barcode)
VALUES($1,$2,$3,$4,$5,$6,$7)
RETURNING *
`,[name,category,price_buy,price_sell,stock,min_stock,barcode]);

res.json({
ok:true,
data:result.rows[0]
});

}catch(err){

res.status(500).json({
ok:false,
error:err.message
});

}

});

/*
GET PRODUCTS
*/

app.get("/products", async(req,res)=>{

const result = await pool.query(`
SELECT * FROM products
ORDER BY id DESC
`);

res.json({
ok:true,
data:result.rows
});

});

/*
STOCK IN
*/

app.post("/stock/in", async(req,res)=>{

const { id,qty } = req.body;

const result = await pool.query(`
UPDATE products
SET stock = stock + $1
WHERE id=$2
RETURNING *
`,[qty,id]);

res.json({
ok:true,
data:result.rows[0]
});

});

/*
STOCK OUT
*/

app.post("/stock/out", async(req,res)=>{

const { id,qty,staff } = req.body;

const product = await pool.query(`
SELECT * FROM products WHERE id=$1
`,[id]);

const item = product.rows[0];

const total = item.price_sell * qty;

await pool.query(`
UPDATE products
SET stock = stock - $1
WHERE id=$2
`,[qty,id]);

await pool.query(`
INSERT INTO sales(product_id,product_name,qty,total,status,staff)
VALUES($1,$2,$3,$4,'DONE',$5)
`,[id,item.name,qty,total,staff]);

res.json({ ok:true });

});

/*
BARANG RUSAK
*/

app.post("/stock/damage", async(req,res)=>{

const { id,qty,staff } = req.body;

const product = await pool.query(`
SELECT * FROM products WHERE id=$1
`,[id]);

const item = product.rows[0];

await pool.query(`
UPDATE products
SET stock = stock - $1
WHERE id=$2
`,[qty,id]);

await pool.query(`
INSERT INTO sales(product_id,product_name,qty,total,status,staff)
VALUES($1,$2,$3,0,'RUSAK',$4)
`,[id,item.name,qty,staff]);

res.json({ ok:true });

});

/*
SALES REPORT
*/

app.get("/sales/report", async(req,res)=>{

const result = await pool.query(`
SELECT * FROM sales
ORDER BY id DESC
`);

res.json({
ok:true,
data:result.rows
});

});

/*
DASHBOARD
*/

app.get("/dashboard", async(req,res)=>{

const balance = await pool.query(`
SELECT COALESCE(SUM(total),0) as balance
FROM sales
WHERE status='DONE'
`);

const sold = await pool.query(`
SELECT COALESCE(SUM(qty),0) as sold
FROM sales
WHERE status='DONE'
`);

const low = await pool.query(`
SELECT COUNT(*) FROM products
WHERE stock <= min_stock
`);

res.json({
ok:true,
balance:balance.rows[0].balance,
sold:sold.rows[0].sold,
lowStock:low.rows[0].count
});

});

/*
TRACKER
*/

app.get("/tracker", async(req,res)=>{

const result = await pool.query(`
SELECT DATE(created_at) as day, SUM(total) as total
FROM sales
WHERE status='DONE'
GROUP BY day
ORDER BY day DESC
LIMIT 7
`);

res.json({
ok:true,
data:result.rows
});

});

/*
SERVER
*/

const PORT = process.env.PORT || 8080;

app.listen(PORT, ()=>{

console.log("Server running on port",PORT);

});