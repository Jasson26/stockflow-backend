const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();

app.use(cors());
app.use(express.json());

/*
====================
DATABASE
====================
*/

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/*
====================
UTIL
====================
*/

function generateToken() {
  return crypto.randomBytes(32).toString("hex");
}

function inviteCode() {
  return "STF-" + crypto.randomBytes(3).toString("hex").toUpperCase();
}

/*
====================
INIT DB
====================
*/

app.get("/init-db", async (req, res) => {
  try {

    await pool.query(`
      CREATE TABLE IF NOT EXISTS stores(
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS users(
        id SERIAL PRIMARY KEY,
        name TEXT,
        email TEXT UNIQUE,
        password TEXT,
        role TEXT,
        store_id INTEGER REFERENCES stores(id) ON DELETE CASCADE
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS sessions(
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        token TEXT UNIQUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS staff_invites(
        id SERIAL PRIMARY KEY,
        store_id INTEGER REFERENCES stores(id) ON DELETE CASCADE,
        code TEXT,
        used BOOLEAN DEFAULT FALSE
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS products(
        id SERIAL PRIMARY KEY,
        store_id INTEGER REFERENCES stores(id) ON DELETE CASCADE,
        name TEXT,
        category TEXT,
        price_buy INTEGER,
        price_sell INTEGER,
        stock INTEGER,
        min_stock INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS sales(
        id SERIAL PRIMARY KEY,
        store_id INTEGER REFERENCES stores(id) ON DELETE CASCADE,
        product_id INTEGER,
        product_name TEXT,
        qty INTEGER,
        total INTEGER,
        status TEXT,
        staff TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    res.json({
      ok: true,
      message: "DATABASE TABLES CREATED"
    });

  } catch (err) {
    res.json({
      ok: false,
      error: err.message
    });
  }
});

/*
====================
DEV RESET
====================
*/

app.get("/reset-dev", async (req, res) => {
  try {

    await pool.query(`DROP TABLE IF EXISTS sales CASCADE`);
    await pool.query(`DROP TABLE IF EXISTS products CASCADE`);
    await pool.query(`DROP TABLE IF EXISTS staff_invites CASCADE`);
    await pool.query(`DROP TABLE IF EXISTS sessions CASCADE`);
    await pool.query(`DROP TABLE IF EXISTS users CASCADE`);
    await pool.query(`DROP TABLE IF EXISTS stores CASCADE`);

    res.json({
      ok: true,
      message: "DATABASE RESET"
    });

  } catch (err) {
    res.json({
      ok: false,
      error: err.message
    });
  }
});

/*
====================
REGISTER OWNER
====================
*/

app.post("/auth/register-owner", async (req, res) => {

  const { name, email, password, store_name } = req.body;

  try {

    const store = await pool.query(
      `INSERT INTO stores(name) VALUES($1) RETURNING *`,
      [store_name]
    );

    const user = await pool.query(
      `INSERT INTO users(name,email,password,role,store_id)
       VALUES($1,$2,$3,'OWNER',$4)
       RETURNING *`,
      [name, email, password, store.rows[0].id]
    );

    res.json({
      ok: true,
      data: user.rows[0]
    });

  } catch (err) {
    res.json({
      ok: false,
      error: err.message
    });
  }

});

/*
====================
REGISTER STAFF
====================
*/

app.post("/auth/register-staff", async (req, res) => {

  const { name, email, password, invite_code } = req.body;

  try {

    const invite = await pool.query(
      `SELECT * FROM staff_invites WHERE code=$1 AND used=false`,
      [invite_code]
    );

    if (invite.rows.length === 0) {
      return res.json({
        ok:false,
        error:"Invalid invite code"
      });
    }

    const store_id = invite.rows[0].store_id;

    const user = await pool.query(
      `INSERT INTO users(name,email,password,role,store_id)
       VALUES($1,$2,$3,'STAFF',$4)
       RETURNING *`,
      [name,email,password,store_id]
    );

    await pool.query(
      `UPDATE staff_invites SET used=true WHERE code=$1`,
      [invite_code]
    );

    res.json({
      ok:true,
      data:user.rows[0]
    });

  } catch(err){
    res.json({ok:false,error:err.message});
  }

});

/*
====================
LOGIN
====================
*/

app.post("/auth/login", async (req,res)=>{

  const {email,password}=req.body;

  const user=await pool.query(
    `SELECT * FROM users WHERE email=$1 AND password=$2`,
    [email,password]
  );

  if(user.rows.length===0){
    return res.json({
      ok:false,
      error:"Invalid login"
    });
  }

  const token=generateToken();

  await pool.query(
    `INSERT INTO sessions(user_id,token) VALUES($1,$2)`,
    [user.rows[0].id,token]
  );

  res.json({
    ok:true,
    token,
    data:user.rows[0]
  });

});

/*
====================
AUTH
====================
*/

async function auth(req,res,next){

  const token=req.headers.authorization?.replace("Bearer ","");

  if(!token){
    return res.json({ok:false,error:"no token"});
  }

  const session=await pool.query(
    `SELECT * FROM sessions WHERE token=$1`,
    [token]
  );

  if(session.rows.length===0){
    return res.json({ok:false,error:"invalid session"});
  }

  const user=await pool.query(
    `SELECT * FROM users WHERE id=$1`,
    [session.rows[0].user_id]
  );

  req.user=user.rows[0];

  next();

}

/*
====================
INVITE STAFF
====================
*/

app.post("/owner/invite-staff",auth,async(req,res)=>{

  if(req.user.role!=="OWNER"){
    return res.json({ok:false,error:"only owner"});
  }

  const code=inviteCode();

  await pool.query(
    `INSERT INTO staff_invites(store_id,code) VALUES($1,$2)`,
    [req.user.store_id,code]
  );

  res.json({
    ok:true,
    invite_code:code
  });

});

/*
====================
PRODUCT ADD
====================
*/

app.post("/products/add",auth,async(req,res)=>{

  if(req.user.role!=="OWNER"){
    return res.json({ok:false,error:"owner only"});
  }

  const {name,category,price_buy,price_sell,stock,min_stock}=req.body;

  const p=await pool.query(
    `INSERT INTO products(store_id,name,category,price_buy,price_sell,stock,min_stock)
     VALUES($1,$2,$3,$4,$5,$6,$7)
     RETURNING *`,
    [
      req.user.store_id,
      name,
      category,
      price_buy,
      price_sell,
      stock,
      min_stock
    ]
  );

  res.json({ok:true,data:p.rows[0]});

});

/*
====================
PRODUCT LIST
====================
*/

app.get("/products",auth,async(req,res)=>{

  const p=await pool.query(
    `SELECT * FROM products WHERE store_id=$1`,
    [req.user.store_id]
  );

  res.json({ok:true,data:p.rows});

});

/*
====================
STOCK IN
====================
*/

app.post("/stock/in",auth,async(req,res)=>{

  const {id,qty}=req.body;

  await pool.query(
    `UPDATE products SET stock=stock+$1 WHERE id=$2`,
    [qty,id]
  );

  res.json({ok:true});

});

/*
====================
STOCK OUT
====================
*/

app.post("/stock/out",auth,async(req,res)=>{

  const {id,qty}=req.body;

  const product=await pool.query(
    `SELECT * FROM products WHERE id=$1`,
    [id]
  );

  const total=product.rows[0].price_sell*qty;

  await pool.query(
    `UPDATE products SET stock=stock-$1 WHERE id=$2`,
    [qty,id]
  );

  await pool.query(
    `INSERT INTO sales(store_id,product_id,product_name,qty,total,status,staff)
     VALUES($1,$2,$3,$4,$5,'DONE',$6)`,
    [
      req.user.store_id,
      id,
      product.rows[0].name,
      qty,
      total,
      req.user.name
    ]
  );

  res.json({ok:true});

});

/*
====================
STOCK DAMAGE
====================
*/

app.post("/stock/damage",auth,async(req,res)=>{

  const {id,qty}=req.body;

  const product=await pool.query(
    `SELECT * FROM products WHERE id=$1`,
    [id]
  );

  await pool.query(
    `UPDATE products SET stock=stock-$1 WHERE id=$2`,
    [qty,id]
  );

  await pool.query(
    `INSERT INTO sales(store_id,product_id,product_name,qty,total,status,staff)
     VALUES($1,$2,$3,$4,0,'RUSAK',$5)`,
    [
      req.user.store_id,
      id,
      product.rows[0].name,
      qty,
      req.user.name
    ]
  );

  res.json({ok:true});

});

/*
====================
DASHBOARD
====================
*/

app.get("/dashboard",auth,async(req,res)=>{

  const balance=await pool.query(
    `SELECT COALESCE(SUM(total),0) as balance
     FROM sales
     WHERE store_id=$1 AND status='DONE'`,
    [req.user.store_id]
  );

  const sold=await pool.query(
    `SELECT COALESCE(SUM(qty),0) as sold
     FROM sales
     WHERE store_id=$1 AND status='DONE'`,
    [req.user.store_id]
  );

  const low=await pool.query(
    `SELECT COUNT(*) FROM products
     WHERE store_id=$1 AND stock<=min_stock`,
    [req.user.store_id]
  );

  res.json({
    ok:true,
    balance:balance.rows[0].balance,
    sold:sold.rows[0].sold,
    lowStock:low.rows[0].count
  });

});

/*
====================
SERVER
====================
*/

const PORT = process.env.PORT || 8080;

app.listen(PORT,()=>{
  console.log("Server running on port",PORT);
});