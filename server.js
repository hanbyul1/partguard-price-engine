const express = require("express");

const app = express();

app.get("/ping", (req, res) => {
    res.send("server alive");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
