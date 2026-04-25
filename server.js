const express = require("express");

const app = express();

// =========================
// 🔐 ENV VARIABLES
// =========================
const CLIENT_ID = process.env.EBAY_CLIENT_ID;
const CLIENT_SECRET = process.env.EBAY_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error("❌ Missing eBay credentials in environment variables");
    process.exit(1);
}

// =========================
// 🔐 TOKEN CACHE
// =========================
let cachedToken = null;
let tokenExpiry = 0;

// =========================
// 📦 RESULT CACHE (VERY IMPORTANT)
// =========================
const resultCache = new Map();
const CACHE_TTL = 1000 * 60 * 10; // 10 minutes

// =========================
// 🔐 GET EBAY TOKEN
// =========================
async function getToken() {
    const now = Date.now();

    if (cachedToken && now < tokenExpiry) {
        return cachedToken;
    }

    const credentials = Buffer.from(
        `${CLIENT_ID}:${CLIENT_SECRET}`
    ).toString("base64");

    const ebayResponse = await fetch(
        "https://api.ebay.com/identity/v1/oauth2/token",
        {
            method: "POST",
            headers: {
                Authorization: `Basic ${credentials}`,
                "Content-Type": "application/x-www-form-urlencoded"
            },
            body: "grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope"
        }
    );

    if (!ebayResponse.ok) {
        const text = await ebayResponse.text();
        console.error("❌ TOKEN HTTP ERROR:", ebayResponse.status, text);
        throw new Error("Token request failed");
    }

    const data = await ebayResponse.json();

    if (!data.access_token) {
        console.error("❌ TOKEN ERROR:", data);
        throw new Error("Failed to get eBay token");
    }

    cachedToken = data.access_token;
    tokenExpiry = now + (data.expires_in - 60) * 1000;

    return cachedToken;
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
    const part = req.query.part;

    if (!part) {
        return res.status(400).json({ error: "Missing part" });
    }

    // =========================
    // 🔥 CACHE HIT (huge win)
    // =========================
    const cached = resultCache.get(part);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        return res.json(cached.data);
    }

    try {
        const token = await getToken();

        // =========================
        // 🔥 TIMEOUT PROTECTION (3s)
        // =========================
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);

        const ebayResponse = await fetch(
            `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(part)}&filter=buyingOptions:{FIXED_PRICE},conditionIds:{1000}`,
            {
                headers: {
                    Authorization: `Bearer ${token}`
                },
                signal: controller.signal
            }
        );

        clearTimeout(timeout);

        // =========================
        // ❗ HANDLE HTTP ERRORS
        // =========================
        if (!ebayResponse.ok) {
            const text = await ebayResponse.text();
            console.error("❌ EBAY HTTP ERROR:", ebayResponse.status, text);

            return res.json({
                price: 0,
                url: null,
                imageURL: null
            });
        }

        const data = await ebayResponse.json();

        const items = data.itemSummaries || [];

        if (items.length === 0) {
            return res.json({
                price: 0,
                url: null,
                imageURL: null
            });
        }

        // =========================
        // 🔥 MEDIAN PRICE
        // =========================
        const prices = items
            .map(i => parseFloat(i.price?.value))
            .filter(v => !isNaN(v));

        let median = 0;

        if (prices.length > 0) {
            const sorted = prices.sort((a, b) => a - b);

            median =
                sorted.length % 2 === 0
                    ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
                    : sorted[Math.floor(sorted.length / 2)];
        }

        // =========================
        // 🖼 IMAGE SELECTION
        // =========================
        let imageURL = null;

        for (const item of items) {
            if (item.image?.imageUrl?.includes("ebayimg.com")) {
                imageURL = item.image.imageUrl;
                break;
            }

            if (item.thumbnailImages) {
                for (const t of item.thumbnailImages) {
                    if (t.imageUrl?.includes("ebayimg.com")) {
                        imageURL = t.imageUrl;
                        break;
                    }
                }
            }

            if (imageURL) break;
        }

        const first = items[0];

        const result = {
            price: median,
            url: first?.itemWebUrl || null,
            imageURL
        };

        // =========================
        // 💾 STORE CACHE
        // =========================
        resultCache.set(part, {
            data: result,
            timestamp: Date.now()
        });

        res.json(result);

    } catch (err) {
        console.error("❌ SEARCH ERROR:", err);

        res.json({
            price: 0,
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
