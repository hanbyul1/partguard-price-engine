const express = require("express");
const axios = require("axios");

const app = express();

// =========================
// 🔐 ENV VARIABLES
// =========================
const CLIENT_ID = process.env.EBAY_CLIENT_ID;
const CLIENT_SECRET = process.env.EBAY_CLIENT_SECRET;
const EBAY_ENV = process.env.EBAY_ENV === "sandbox" ? "sandbox" : "production";

if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error("❌ Missing eBay credentials");
    process.exit(1);
}

const EBAY_BASE_URL =
    EBAY_ENV === "sandbox"
        ? "https://api.sandbox.ebay.com"
        : "https://api.ebay.com";

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
    let lastErr;

    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (err) {
            lastErr = err;
            console.log(`⚠️ Retry ${i + 1}:`, err.message);

            if (i < retries - 1) {
                await new Promise(r => setTimeout(r, 800 * (i + 1)));
            }
        }
    }

    throw lastErr;
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

    const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");

    const body = new URLSearchParams({
        grant_type: "client_credentials",
        scope: "https://api.ebay.com/oauth/api_scope"
    }).toString();

    const response = await retry(() =>
        axios.post(`${EBAY_BASE_URL}/identity/v1/oauth2/token`, body, {
            headers: {
                Authorization: `Basic ${credentials}`,
                "Content-Type": "application/x-www-form-urlencoded"
            },
            timeout: 8000
        })
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
// 🧹 HELPERS
// =========================
function cleanText(value) {
    return String(value || "")
        .replace(/[^\w\s\-&/]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function normalizePart(part) {
    return String(part || "")
        .trim()
        .replace(/\s+/g, "")
        .toUpperCase();
}

function buildQueries(part, desc) {
    const p = normalizePart(part);
    const d = cleanText(desc);

    const queries = [];

    // Most precise if description is available.
    if (d) queries.push(`${p} ${d} GM`);
    if (d) queries.push(`${p} ${d} Chevrolet`);
    if (d) queries.push(`${p} ${d} auto part`);

    // Good generic fallbacks for OEM part numbers.
    queries.push(`${p} GM part`);
    queries.push(`${p} Chevrolet part`);
    queries.push(`${p} OEM GM`);
    queries.push(`${p} auto part`);
    queries.push(p);

    // Last resort: description-only, but only if it exists.
    if (d) queries.push(`${d} GM`);
    if (d) queries.push(`${d} auto part`);

    // Remove duplicates while preserving order.
    return [...new Set(queries.filter(q => q && q.trim().length > 0))];
}

function extractMedianPrice(items) {
    const validItems = items.filter(i => {
        const value = Number(i.price?.value);
        return Number.isFinite(value) && value > 0;
    });

    if (validItems.length === 0) {
        return { median: null, validItems: [] };
    }

    const prices = validItems
        .map(i => Number(i.price.value))
        .sort((a, b) => a - b);

    const median =
        prices.length % 2 === 0
            ? (prices[prices.length / 2 - 1] + prices[prices.length / 2]) / 2
            : prices[Math.floor(prices.length / 2)];

    return { median, validItems };
}

function chooseImage(items) {
    for (const item of items) {
        if (item.image?.imageUrl) {
            return item.image.imageUrl;
        }

        if (Array.isArray(item.thumbnailImages) && item.thumbnailImages.length > 0) {
            const thumb = item.thumbnailImages.find(t => t.imageUrl);
            if (thumb?.imageUrl) return thumb.imageUrl;
        }
    }

    return null;
}

// =========================
// 🔍 EBAY SEARCH
// =========================
async function ebaySearch(query) {
    const token = await getToken();

    console.log("🔎 EBAY QUERY:", query);

    const response = await retry(() =>
        axios.get(`${EBAY_BASE_URL}/buy/browse/v1/item_summary/search`, {
            headers: {
                Authorization: `Bearer ${token}`
            },
            params: {
                q: query,
                limit: 20
            },
            timeout: 8000
        })
    );

    const data = response.data;
    const items = data.itemSummaries || [];

    console.log("📦 ITEMS FOUND:", items.length);

    if (items.length === 0) {
        return null;
    }

    const { median, validItems } = extractMedianPrice(items);

    if (median === null || validItems.length === 0) {
        console.log("⚠️ Items found but no valid prices");
        return null;
    }

    const first = validItems[0];

    return {
        price: median,
        url: first?.itemWebUrl || null,
        imageURL: chooseImage(validItems)
    };
}

async function searchWithQueryFallbacks(part, desc) {
    const queries = buildQueries(part, desc);

    console.log("🧭 QUERY PLAN:", queries);

    for (const query of queries) {
        const result = await ebaySearch(query);

        if (result && result.price !== null && result.price > 0) {
            console.log("✅ MATCHED QUERY:", query);
            return result;
        }
    }

    return null;
}

// =========================
// 🧪 HEALTH CHECK
// =========================
app.get("/", (req, res) => {
    res.send("PartGuard price engine running");
});

app.get("/ping", (req, res) => {
    console.log("🏓 /ping hit");
    res.send("server alive");
});

// =========================
// 🔍 SEARCH PART
// =========================
app.get("/search", async (req, res) => {
    const startTime = Date.now();

    const part = normalizePart(req.query.part);
    const desc = cleanText(req.query.desc);

    console.log("\n=========================");
    console.log("🔍 SEARCH PART:", part);
    console.log("📝 DESC:", desc || "(none)");

    if (!part) {
        return res.status(400).json({ error: "Missing part" });
    }

    const cacheKey = `${part}|${desc}`;

    const cached = resultCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        console.log("⚡ CACHE HIT:", cacheKey);
        return res.json(cached.data);
    }

    try {
        let result = await searchWithQueryFallbacks(part, desc);

        if (!result) {
            result = {
                price: null,
                url: null,
                imageURL: null
            };
        }

        resultCache.set(cacheKey, {
            data: result,
            timestamp: Date.now()
        });

        console.log("✅ RESULT:", result);
        console.log("⏱️ TIME:", Date.now() - startTime, "ms");

        return res.json(result);

    } catch (err) {
        const ebayMsg = err.response?.data || err.message;
        console.error("❌ ERROR:", ebayMsg);

        return res.json({
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
