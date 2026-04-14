const express = require("express");

const app = express();

app.get("/ping", (req, res) => {
    res.send("server alive");
});

app.get("/price", (req, res) => {
    const part = req.query.part;
    res.send(`Looking up part: ${part}`);
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
