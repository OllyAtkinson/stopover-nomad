// POST /api/prices  { legs: [{ from: "LHR", to: "AUH", date: "2026-12-14" }, ...] }
// → { configured: true, currency: "GBP", results: [{ from, to, date, fare: {...} | null }] }
//
// Runs as a Vercel serverless function (also used by dev-server.js).
// Needs TRAVELPAYOUTS_TOKEN set; without it the endpoint says
// { configured: false } and the app stays in manual-price mode.
const { lookupLegs } = require("../lib/prices.js");

function readBody(req) {
    if (req.body !== undefined) {
        return Promise.resolve(typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body);
    }
    return new Promise((resolve, reject) => {
        let raw = "";
        req.on("data", c => { raw += c; if (raw.length > 100000) reject(new Error("too large")); });
        req.on("end", () => { try { resolve(JSON.parse(raw || "{}")); } catch (e) { reject(e); } });
        req.on("error", reject);
    });
}

function send(res, status, obj) {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify(obj));
}

module.exports = async function handler(req, res) {
    // Lets a frontend hosted elsewhere (e.g. GitHub Pages) call this API.
    res.setHeader("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN || "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }

    const token = process.env.TRAVELPAYOUTS_TOKEN;
    if (!token) return send(res, 200, { configured: false });
    if (req.method !== "POST") return send(res, 405, { error: "POST only" });

    let body;
    try { body = await readBody(req); } catch { return send(res, 400, { error: "invalid JSON" }); }

    try {
        const results = await lookupLegs(body.legs, {
            token,
            marker: process.env.TRAVELPAYOUTS_MARKER || "",
            currency: "gbp",
        });
        send(res, 200, { configured: true, currency: "GBP", results });
    } catch (e) {
        send(res, e.status || 500, { error: e.message });
    }
};
