const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");

const app = express();

app.use(cors());
app.use(express.json());

const pool = new Pool({
connectionString: process.env.DATABASE_URL,
ssl: { rejectUnauthorized: false }
});

const SECRET = "stockflow-secret";

function auth(req,res,next){

const authHeader = req.headers.authorization;

if(!authHeader){
return res.json({ok:false,error:"unauthorized"});
}

const token = authHeader.split(" ")[1];

try{

const user = jwt.verify(token,SECRET);

req.user=user;

next();

}catch{

return res.json({ok:false,error:"invalid token"});

}

}

app.get("/",(req,res)=>{

res.json({
ok:true,
message:"StockFlow API Running"
});

});

app.get("/reset-dev",async(req,res)=>{

await pool.query("DROP TABLE IF EXISTS stock_history");
await pool.query("DROP TABLE IF EXISTS products");
await pool.query("DROP TABLE IF EXISTS users");
await pool.query("DROP TABLE IF EXISTS stores");
await pool.query("DROP TABLE IF EXISTS invites");

res.json({
ok:true,
message:"DEV RESET DONE"
});

});

app.get("/init-db",async(req,res)=>{

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

res.json({
ok:true,
message:"DATABASE TABLES CREATED"
});

});

app.post("/auth/register-owner",async(req,res)=>{

const {name,email,password,store_name} = req.body;

const hash = await bcrypt.hash(password,10);

const store = await pool.query(
"INSERT INTO stores(name) VALUES($1) RETURNING *",
[store_name]
);

const storeId = store.rows[0].id;

await pool.query(
"INSERT INTO users(name,email,password,role,store_id) VALUES($1,$2,$3,$4,$5)",
[name,email,hash,"OWNER",storeId]
);

res.json({
ok:true,
message:"OWNER REGISTERED"
});

});

app.post("/auth/register-staff",async(req,res)=>{

const {name,email,password,invite_code} = req.body;

const invite = await pool.query(
"SELECT * FROM invites WHERE code=$1",
[invite_code]
);

if(invite.rows.length===0){
return res.json({ok:false,error:"invalid invite code"});
}

const storeId = invite.rows[0].store_id;

const hash = await bcrypt.hash(password,10);

await pool.query(
"INSERT INTO users(name,email,password,role,store_id) VALUES($1,$2,$3,$4,$5)",
[name,email,hash,"STAFF",storeId]
);

res.json({
ok:true,
message:"STAFF REGISTERED"
});

});

app.post("/auth/login",async(req,res)=>{

const {email,password} = req.body;

const user = await pool.query(
"SELECT * FROM users WHERE email=$1",
[email]
);

if(user.rows.length===0){
return res.json({ok:false,error:"user not found"});
}

const u = user.rows[0];

const match = await bcrypt.compare(password,u.password);

if(!match){
return res.json({ok:false,error:"wrong password"});
}

const token = jwt.sign({
id:u.id,
store_id:u.store_id,
role:u.role
},SECRET);

res.json({
ok:true,
token,
data:{
id:u.id,
name:u.name,
email:u.email,
role:u.role
}
});

});

app.get("/auth/me",auth,async(req,res)=>{

const user = await pool.query(
"SELECT * FROM users WHERE id=$1",
[req.user.id]
);

res.json({
ok:true,
data:user.rows[0]
});

});

app.post("/owner/invite-staff",auth,async(req,res)=>{

if(req.user.role!=="OWNER"){
return res.json({ok:false,error:"owner only"});
}

const code = Math.random().toString(36).substring(2,8).toUpperCase();

await pool.query(
"INSERT INTO invites(code,store_id) VALUES($1,$2)",
[code,req.user.store_id]
);

res.json({
ok:true,
data:{code}
});

});

app.get("/products",auth,async(req,res)=>{

const products = await pool.query(
"SELECT * FROM products WHERE store_id=$1",
[req.user.store_id]
);

res.json({
ok:true,
data:products.rows
});

});

app.post("/stock/in",auth,async(req,res)=>{

const {product_name,qty} = req.body;

let product = await pool.query(
"SELECT * FROM products WHERE name=$1 AND store_id=$2",
[product_name,req.user.store_id]
);

if(product.rows.length===0){

product = await pool.query(
"INSERT INTO products(name,stock,store_id) VALUES($1,$2,$3) RETURNING *",
[product_name,qty,req.user.store_id]
);

}else{

await pool.query(
"UPDATE products SET stock=stock+$1 WHERE id=$2",
[qty,product.rows[0].id]
);

}

res.json({
ok:true,
message:"stock added"
});

});

app.post("/stock/out",auth,async(req,res)=>{

const {product_name,qty} = req.body;

const product = await pool.query(
"SELECT * FROM products WHERE name=$1 AND store_id=$2",
[product_name,req.user.store_id]
);

if(product.rows.length===0){
return res.json({ok:false,error:"product not found"});
}

if(product.rows[0].stock < qty){
return res.json({ok:false,error:"stock not enough"});
}

await pool.query(
"UPDATE products SET stock=stock-$1 WHERE id=$2",
[qty,product.rows[0].id]
);

await pool.query(
"INSERT INTO stock_history(product_id,qty,type,total,status,store_id) VALUES($1,$2,$3,$4,$5,$6)",
[
product.rows[0].id,
qty,
"OUT",
product.rows[0].price*qty,
"DONE",
req.user.store_id
]
);

res.json({ok:true});

});

app.post("/stock/damage",auth,async(req,res)=>{

const {product_name,qty} = req.body;

const product = await pool.query(
"SELECT * FROM products WHERE name=$1 AND store_id=$2",
[product_name,req.user.store_id]
);

await pool.query(
"UPDATE products SET stock=stock-$1 WHERE id=$2",
[qty,product.rows[0].id]
);

await pool.query(
"INSERT INTO stock_history(product_id,qty,type,total,status,store_id) VALUES($1,$2,$3,$4,$5,$6)",
[
product.rows[0].id,
qty,
"DAMAGE",
0,
"RUSAK",
req.user.store_id
]
);

res.json({ok:true});

});

app.get("/sales/report",auth,async(req,res)=>{

const sales = await pool.query(
`
SELECT
p.name as product_name,
h.qty,
h.total,
h.status,
h.created_at
FROM stock_history h
JOIN products p ON h.product_id=p.id
WHERE h.store_id=$1
ORDER BY h.created_at DESC
`,
[req.user.store_id]
);

res.json({
ok:true,
data:sales.rows
});

});

app.get("/dashboard",auth,async(req,res)=>{

const balance = await pool.query(
"SELECT SUM(total) FROM stock_history WHERE store_id=$1 AND status='DONE'",
[req.user.store_id]
);

const sold = await pool.query(
"SELECT SUM(qty) FROM stock_history WHERE store_id=$1 AND status='DONE'",
[req.user.store_id]
);

const low = await pool.query(
"SELECT * FROM products WHERE store_id=$1 ORDER BY stock ASC LIMIT 1",
[req.user.store_id]
);

res.json({
ok:true,
balance:balance.rows[0].sum||0,
sold:sold.rows[0].sum||0,
lowStock:low.rows.length,
lowestItem:low.rows[0]||null
});

});

app.get("/tracker",auth,async(req,res)=>{

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
ok:true,
data:tracker.rows
});

});

const PORT = process.env.PORT || 8080;

app.listen(PORT,()=>{
console.log("Server running on",PORT);
});