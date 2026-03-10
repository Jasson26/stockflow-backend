const express = require("express")
const cors = require("cors")
const bcrypt = require("bcryptjs")
const jwt = require("jsonwebtoken")
const { Pool } = require("pg")

const app = express()

app.use(cors())
app.use(express.json())

const PORT = process.env.PORT || 8080
const SECRET = "stockflow-secret"

/*
SAFE DATABASE CONNECTION
*/
if(!process.env.DATABASE_URL){
console.error("DATABASE_URL NOT FOUND")
process.exit(1)
}

const pool = new Pool({
connectionString:process.env.DATABASE_URL,
ssl:{rejectUnauthorized:false}
})

pool.connect()
.then(()=>console.log("DATABASE CONNECTED"))
.catch(err=>{
console.error("DATABASE ERROR",err)
process.exit(1)
})

/*
AUTH MIDDLEWARE
*/

function auth(req,res,next){

const header = req.headers.authorization

if(!header){
return res.json({ok:false,error:"no token"})
}

try{

const token = header.split(" ")[1]

const decoded = jwt.verify(token,SECRET)

req.user = decoded

next()

}catch(e){

return res.json({ok:false,error:"invalid token"})

}

}

/*
HEALTH CHECK
*/

app.get("/",(req,res)=>{
res.json({
ok:true,
service:"StockFlow Backend",
status:"running"
})
})

/*
RESET DATABASE
*/

app.get("/reset-dev",async(req,res)=>{

try{

await pool.query("DROP TABLE IF EXISTS stock_history CASCADE")
await pool.query("DROP TABLE IF EXISTS products CASCADE")
await pool.query("DROP TABLE IF EXISTS invites CASCADE")
await pool.query("DROP TABLE IF EXISTS users CASCADE")
await pool.query("DROP TABLE IF EXISTS stores CASCADE")

res.json({ok:true})

}catch(e){
res.json({ok:false,error:e.message})
}

})

/*
INIT DATABASE
*/

app.get("/init-db",async(req,res)=>{

try{

await pool.query(`
CREATE TABLE IF NOT EXISTS stores(
id SERIAL PRIMARY KEY,
name TEXT
)
`)

await pool.query(`
CREATE TABLE IF NOT EXISTS users(
id SERIAL PRIMARY KEY,
name TEXT,
email TEXT UNIQUE,
password TEXT,
role TEXT,
store_id INTEGER
)
`)

await pool.query(`
CREATE TABLE IF NOT EXISTS invites(
id SERIAL PRIMARY KEY,
code TEXT,
store_id INTEGER
)
`)

await pool.query(`
CREATE TABLE IF NOT EXISTS products(
id SERIAL PRIMARY KEY,
name TEXT,
stock INTEGER DEFAULT 0,
price INTEGER DEFAULT 0,
store_id INTEGER
)
`)

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
`)

res.json({ok:true})

}catch(e){

res.json({ok:false,error:e.message})

}

})

/*
REGISTER OWNER
*/

app.post("/auth/register-owner",async(req,res)=>{

try{

const {name,email,password,store_name} = req.body

const hash = await bcrypt.hash(password,10)

const store = await pool.query(
`INSERT INTO stores(name) VALUES($1) RETURNING *`,
[store_name]
)

const storeId = store.rows[0].id

await pool.query(
`INSERT INTO users(name,email,password,role,store_id)
VALUES($1,$2,$3,$4,$5)`,
[name,email,hash,"OWNER",storeId]
)

res.json({ok:true})

}catch(e){

res.json({ok:false,error:e.message})

}

})

/*
LOGIN
*/

app.post("/auth/login",async(req,res)=>{

try{

const {email,password} = req.body

const user = await pool.query(
`SELECT * FROM users WHERE email=$1`,
[email]
)

if(user.rows.length===0){
return res.json({ok:false,error:"user not found"})
}

const u = user.rows[0]

const valid = await bcrypt.compare(password,u.password)

if(!valid){
return res.json({ok:false,error:"wrong password"})
}

const token = jwt.sign({
id:u.id,
store_id:u.store_id,
role:u.role
},SECRET)

res.json({
ok:true,
token,
user:{
name:u.name,
role:u.role
}
})

}catch(e){

res.json({ok:false,error:e.message})

}

})

/*
ADD PRODUCT
*/

app.post("/product/add",auth,async(req,res)=>{

try{

const {name,stock,price} = req.body

await pool.query(
`INSERT INTO products(name,stock,price,store_id)
VALUES($1,$2,$3,$4)`,
[name,stock,price,req.user.store_id]
)

res.json({ok:true})

}catch(e){

res.json({ok:false,error:e.message})

}

})

/*
GET PRODUCTS
*/

app.get("/products",auth,async(req,res)=>{

const data = await pool.query(
`SELECT * FROM products WHERE store_id=$1`,
[req.user.store_id]
)

res.json({
ok:true,
data:data.rows
})

})

/*
STOCK IN
*/

app.post("/stock/in",auth,async(req,res)=>{

const {product_id,qty} = req.body

await pool.query(
`UPDATE products SET stock=stock+$1 WHERE id=$2`,
[qty,product_id]
)

res.json({ok:true})

})

/*
STOCK OUT
*/

app.post("/stock/out",auth,async(req,res)=>{

const {product_id,qty} = req.body

const p = await pool.query(
`SELECT * FROM products WHERE id=$1`,
[product_id]
)

if(p.rows[0].stock < qty){
return res.json({ok:false,error:"stock not enough"})
}

await pool.query(
`UPDATE products SET stock=stock-$1 WHERE id=$2`,
[qty,product_id]
)

res.json({ok:true})

})

/*
DAMAGE
*/

app.post("/stock/damage",auth,async(req,res)=>{

const {product_id,qty} = req.body

await pool.query(
`UPDATE products SET stock=stock-$1 WHERE id=$2`,
[qty,product_id]
)

res.json({ok:true})

})

/*
START SERVER
*/

app.listen(PORT,()=>{
console.log("SERVER RUNNING",PORT)
})