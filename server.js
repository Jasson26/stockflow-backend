const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

function hashPassword(password) {
  return crypto.createHash("sha256").update(password).digest("hex");
}

function generateToken() {
  return crypto.randomBytes(32).toString("hex");
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    message: "StockFlow API Running",
    version: "FULL_SCHEMA_V1",
    hasDatabaseUrl: Boolean(process.env.DATABASE_URL),
    time: new Date().toISOString()
  });
});

app.get("/db-test", async (req, res) => {
  try {
    const r = await pool.query("SELECT NOW()");
    res.json({ ok: true, time: r.rows[0] });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.get("/init-db", async (req, res) => {
  try {

    await pool.query(`

CREATE TABLE IF NOT EXISTS roles (
id SERIAL PRIMARY KEY,
name TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
id SERIAL PRIMARY KEY,
name TEXT,
email TEXT UNIQUE,
password TEXT,
role_id INTEGER REFERENCES roles(id),
created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sessions (
token TEXT PRIMARY KEY,
user_id INTEGER REFERENCES users(id),
expires_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS registration_codes (
code TEXT PRIMARY KEY,
role_id INTEGER REFERENCES roles(id),
max_usage INTEGER DEFAULT 1,
used_count INTEGER DEFAULT 0,
expires_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS products (
id SERIAL PRIMARY KEY,
name TEXT,
sku TEXT,
stock INTEGER DEFAULT 0,
price INTEGER DEFAULT 0,
created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS stock_history (
id SERIAL PRIMARY KEY,
product_id INTEGER REFERENCES products(id),
change_type TEXT,
qty INTEGER,
note TEXT,
user_id INTEGER,
created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS transactions (
id SERIAL PRIMARY KEY,
total_amount INTEGER,
status TEXT DEFAULT 'PENDING',
created_by INTEGER,
approved_by INTEGER,
created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS transaction_items (
id SERIAL PRIMARY KEY,
transaction_id INTEGER REFERENCES transactions(id),
product_id INTEGER REFERENCES products(id),
qty INTEGER,
price INTEGER
);

CREATE TABLE IF NOT EXISTS ledger_month (
id SERIAL PRIMARY KEY,
month INTEGER,
year INTEGER,
is_closed BOOLEAN DEFAULT FALSE,
opening_balance INTEGER DEFAULT 0,
closing_balance INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ledger_entry (
id SERIAL PRIMARY KEY,
ledger_id INTEGER REFERENCES ledger_month(id),
type TEXT,
amount INTEGER,
description TEXT,
created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_logs (
id SERIAL PRIMARY KEY,
user_id INTEGER,
action TEXT,
entity TEXT,
entity_id INTEGER,
created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS notifications (
id SERIAL PRIMARY KEY,
type TEXT,
message TEXT,
is_read BOOLEAN DEFAULT FALSE,
created_at TIMESTAMP DEFAULT NOW()
);

`);

    await pool.query(`
INSERT INTO roles(name) VALUES
('Kasir'),
('Gudang'),
('Finance'),
('Manager'),
('Owner')
ON CONFLICT DO NOTHING
`);

    const owner = await pool.query(`
SELECT * FROM users WHERE email='owner@stockflow.local'
`);

    if (owner.rows.length === 0) {

      const role = await pool.query(`
SELECT id FROM roles WHERE name='Owner'
`);

      await pool.query(`
INSERT INTO users(name,email,password,role_id)
VALUES($1,$2,$3,$4)
`,[
        "Owner",
        "owner@stockflow.local",
        hashPassword("owner12345"),
        role.rows[0].id
      ]);
    }

    res.json({
      ok: true,
      message: "FULL DATABASE INITIALIZED"
    });

  } catch (err) {
    res.json({
      ok: false,
      error: err.message
    });
  }
});

app.post("/auth/login", async (req,res)=>{

try{

const {email,password}=req.body;

const user=await pool.query(`
SELECT u.*,r.name as role
FROM users u
JOIN roles r ON r.id=u.role_id
WHERE email=$1
`,[email]);

if(user.rows.length===0){

return res.json({ok:false,error:"user not found"});

}

const u=user.rows[0];

if(u.password!==hashPassword(password)){

return res.json({ok:false,error:"wrong password"});

}

const token=generateToken();

const expire=new Date(Date.now()+7*24*60*60*1000);

await pool.query(`
INSERT INTO sessions(token,user_id,expires_at)
VALUES($1,$2,$3)
`,[token,u.id,expire]);

res.json({

ok:true,
token:token,
user:{
id:u.id,
name:u.name,
email:u.email,
role:u.role
}

});

}catch(err){

res.json({ok:false,error:err.message});

}

});

app.get("/products", async(req,res)=>{

try{

const r=await pool.query(`
SELECT * FROM products ORDER BY id DESC
`);

res.json({ok:true,data:r.rows});

}catch(err){

res.json({ok:false,error:err.message});

}

});

app.post("/products", async(req,res)=>{

try{

const {name,sku,stock,price}=req.body;

const r=await pool.query(`
INSERT INTO products(name,sku,stock,price)
VALUES($1,$2,$3,$4)
RETURNING *
`,[name,sku,stock||0,price||0]);

res.json({ok:true,data:r.rows[0]});

}catch(err){

res.json({ok:false,error:err.message});

}

});

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});