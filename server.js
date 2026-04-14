const express = require("express");

const app = express();

// ✅ 기존 ping API
app.get("/ping", (req, res) => {
    res.send("server alive");
});

// ✅ 여기다 추가한다 (핵심)
app.get("/price", (req, res) => {
    const part = req.query.part;
    res.send(`Looking up part: ${part}`);
});

// ❗ 항상 마지막
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
