const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("StockFlow API Running");
});

app.get("/products", (req, res) => {
  res.json([
    { id: 1, name: "Produk A", stock: 10 },
    { id: 2, name: "Produk B", stock: 5 }
  ]);
});

app.listen(3000, () => {
  console.log("Server running on port 3000");
});