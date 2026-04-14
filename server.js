const express = require("express");

const app = express();

const fakeEbay = {
    "123": [45, 50, 55],
    "ABC123": [80, 90, 100]
};

app.get("/ping", (req, res) => {
    res.send("server alive");
});

app.get("/price", (req, res) => {
    const part = req.query.part;

    const prices = fakeEbay[part];

    if (!prices) {
        return res.json({
            part,
            error: "No data"
        });
    }

    const avg = prices.reduce((a, b) => a + b, 0) / prices.length;

    res.json({
        part,
        avgPrice: avg,
        samples: prices
    });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
