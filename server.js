const express = require("express");
const axios = require("axios");

const app = express();

// =========================
// 🔐 ENV VARIABLES
// =========================
const CLIENT_ID = process.env.EBAY_CLIENT_ID;
const CLIENT_SECRET = process.env.EBAY_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error("❌ Missing eBay credentials");
    process.exit(1);
}

// =========================
// 🔐 TOKEN CACHE
// =========================
let cachedToken = null;
let tokenExpiry = 0;

// =========================
// 📦 RESULT CACHE
// =========================
const resultCache = new Map();
const CACHE_TTL = 1000 * 60 * 10;

// =========================
// 🔁 RETRY HELPER
// =========================
async function retry(fn, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (err) {
            console.log(`⚠️ Retry ${i + 1}`);
            if (i === retries - 1) throw err;
            await new Promise(r => setTimeout(r, 800));
        }
    }
}

// =========================
// 🔐 GET EBAY TOKEN
// =========================
async function getToken() {
    const now = Date.now();

    if (cachedToken && now < tokenExpiry) {
        console.log("🔁 Using cached token");
        return cachedToken;
    }

    console.log("🆕 Fetching new eBay token");

    const credentials = Buffer.from(
        `${CLIENT_ID}:${CLIENT_SECRET}`
    ).toString("base64");

    const response = await retry(() =>
        axios.post(
            "https://api.ebay.com/identity/v1/oauth2/token",
            "grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope",
            {
                headers: {
                    Authorization: `Basic ${credentials}`,
                    "Content-Type": "application/x-www-form-urlencoded"
                },
                timeout: 5000
            }
        )
    );

    const data = response.data;

    if (!data.access_token) {
        console.error("❌ TOKEN ERROR:", data);
        throw new Error("No access token");
    }

    cachedToken = data.access_token;
    tokenExpiry = now + (data.expires_in - 60) * 1000;

    return cachedToken;
}

// =========================
// 🔍 EBAY SEARCH
// =========================
async function ebaySearch(query) {
    const token = await getToken();

    const response = await retry(() =>
        axios.get(
            "https://api.ebay.com/buy/browse/v1/item_summary/search",
            {
                headers: {
                    Authorization: `Bearer ${token}`
                },
                params: {
                    q: query,
                    limit: 10
                },
                timeout: 5000
            }
        )
    );

    const data = response.data;
    const items = data.itemSummaries || [];

    if (items.length === 0) return null;

    const prices = items
        .map(i => parseFloat(i.price?.value))
        .filter(v => !isNaN(v));

    if (prices.length === 0) return null;

    prices.sort((a, b) => a - b);

    const median =
        prices.length % 2 === 0
            ? (prices[prices.length / 2 - 1] + prices[prices.length / 2]) / 2
            : prices[Math.floor(prices.length / 2)];

    let imageURL = null;
    for (const item of items) {
        if (item.image?.imageUrl?.includes("ebayimg.com")) {
            imageURL = item.image.imageUrl;
            break;
        }
    }

    return {
        price: median,
        url: items[0]?.itemWebUrl || null,
        imageURL
    };
}

// =========================
// 🧪 HEALTH CHECK
// =========================
app.get("/ping", (req, res) => {
    res.send("server alive");
});

// =========================
// 🔍 SEARCH PART
// =========================
app.get("/search", async (req, res) => {
    const startTime = Date.now();
    const part = req.query.part;

    console.log("\n=========================");
    console.log("🔍 SEARCH:", part);

    if (!part) {
        return res.status(400).json({ error: "Missing part" });
    }

    // =========================
    // CACHE
    // =========================
    const cached = resultCache.get(part);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        console.log("⚡ CACHE HIT");
        return res.json(cached.data);
    }

    try {
        let result =
            await ebaySearch(`${part} GM`) ||
            await ebaySearch(part);

        if (!result) {
            result = {
                price: null,
                url: null,
                imageURL: null
            };
        }

        resultCache.set(part, {
            data: result,
            timestamp: Date.now()
        });

        console.log("✅ RESULT:", result);
        console.log("⏱️ TIME:", Date.now() - startTime, "ms");

        res.json(result);

    } catch (err) {
        console.error("❌ ERROR:", err.message);

        res.json({
            price: null,
            url: null,
            imageURL: null
        });
    }
});

// =========================
// 🚀 START SERVER
// =========================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
