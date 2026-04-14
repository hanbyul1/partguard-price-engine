import express from "express";

const app = express();

app.get("/ping", (req, res) => {
    res.send("server alive");
});

app.listen(3000, () => {
    console.log("Server running on port 3000");
});
