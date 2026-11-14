const test = require("node:test");
const assert = require("node:assert");
const { lookupWindows, cheapestByDay, monthsBetween, _cache } = require("../lib/prices.js");

function fakeFetch(table, calls = []) {
    return async (url, opts) => {
        calls.push({ url, opts });
        const u = new URL(url);
        const key = `${u.searchParams.get("origin")}-${u.searchParams.get("destination")}-${u.searchParams.get("departure_at")}`;
        return { ok: true, status: 200, json: async () => ({ success: true, data: table[key] || [] }) };
    };
}

test("monthsBetween covers every month a window touches", () => {
    assert.deepStrictEqual(monthsBetween("2026-12-28", "2027-01-03"), ["2026-12", "2027-01"]);
    assert.deepStrictEqual(monthsBetween("2026-12-01", "2026-12-31"), ["2026-12"]);
    assert.deepStrictEqual(monthsBetween("2026-11-30", "2027-01-01"), ["2026-11", "2026-12", "2027-01"]);
});

test("cheapestByDay keeps the cheapest fare on each day", () => {
    const d = cheapestByDay([
        { price: 300, departure_at: "2026-12-14T10:00:00+00:00" },
        { price: 250, departure_at: "2026-12-14T22:00:00+00:00" },
        { price: 100, departure_at: "2026-12-16T10:00:00+00:00" },
        { price: "x", departure_at: "2026-12-17T10:00:00+00:00" },
    ]);
    assert.deepStrictEqual(Object.keys(d).sort(), ["2026-12-14", "2026-12-16"]);
    assert.strictEqual(d["2026-12-14"].price, 250);
});

test("lookupWindows returns per-day fares inside the window, caches months, adds marker", async () => {
    _cache.clear();
    const calls = [];
    const fetchImpl = fakeFetch({
        "LHR-AUH-2026-12": [
            { price: 210, departure_at: "2026-12-14T09:00:00+04:00", airline: "EY", transfers: 0, link: "/LON1412AUH1?t=abc" },
            { price: 190, departure_at: "2026-12-20T09:00:00+04:00", airline: "EY", transfers: 0 },
        ],
        "AUH-HAN-2026-12": [{ price: 180, departure_at: "2026-12-31T09:00:00+04:00", airline: "VJ", transfers: 1 }],
        "AUH-HAN-2027-01": [{ price: 150, departure_at: "2027-01-02T09:00:00+04:00", airline: "VJ", transfers: 0 }],
    }, calls);
    const out = await lookupWindows([
        { from: "LHR", to: "AUH", start: "2026-12-13", end: "2026-12-16" },
        { from: "lhr", to: "auh", start: "2026-12-18", end: "2026-12-22" },  // same month → cached
        { from: "AUH", to: "HAN", start: "2026-12-30", end: "2027-01-03" },
    ], { token: "t", marker: "123", fetchImpl });
    assert.deepStrictEqual(Object.keys(out[0].days), ["2026-12-14"]);
    assert.strictEqual(out[0].days["2026-12-14"].link, "https://www.aviasales.com/LON1412AUH1?t=abc&marker=123");
    assert.deepStrictEqual(Object.keys(out[1].days), ["2026-12-20"]);
    assert.deepStrictEqual(Object.keys(out[2].days).sort(), ["2026-12-31", "2027-01-02"]);
    assert.strictEqual(calls.length, 3, "LHR-AUH December fetched once");
    assert.strictEqual(calls[0].opts.headers["X-Access-Token"], "t");
    assert.ok(!calls[0].url.includes("token="), "token not in URL");
});

test("lookupWindows rejects bad input and bad tokens", async () => {
    _cache.clear();
    const ok = fakeFetch({});
    await assert.rejects(lookupWindows([{ from: "LHR", to: "AUH", start: "soon", end: "2026-12-14" }], { token: "t", fetchImpl: ok }), /bad window/);
    await assert.rejects(lookupWindows([{ from: "LHR", to: "AUH", start: "2026-12-14", end: "2026-12-10" }], { token: "t", fetchImpl: ok }), /window must be/);
    await assert.rejects(lookupWindows([{ from: "LHR", to: "AUH", start: "2026-12-01", end: "2027-03-01" }], { token: "t", fetchImpl: ok }), /window must be/);
    const denied = async () => ({ ok: false, status: 401, json: async () => ({}) });
    await assert.rejects(lookupWindows([{ from: "LHR", to: "AUH", start: "2026-12-14", end: "2026-12-14" }], { token: "t", fetchImpl: denied }), /token/);
});

test("explore returns the cheapest destination per city in the window, both ways", async () => {
    const { explore } = require("../lib/prices.js");
    _cache.clear();
    const calls = [];
    const fetchImpl = async (url) => {
        calls.push(url);
        const u = new URL(url);
        const o = u.searchParams.get("origin"), d = u.searchParams.get("destination");
        const data = o === "LON" && !d ? [
            { destination: "AUH", price: 210, departure_at: "2026-12-14T09:00:00Z" },
            { destination: "AUH", price: 190, departure_at: "2026-12-15T09:00:00Z" },
            { destination: "IST", price: 60, departure_at: "2026-12-30T09:00:00Z" },   // outside window
        ] : d === "HAN" && !o ? [{ origin: "SIN", price: 70, departure_at: "2026-12-16T09:00:00Z" }] : [];
        return { ok: true, status: 200, json: async () => ({ success: true, data }) };
    };
    const r = await explore({ from: "LON", to: "HAN", start: "2026-12-10", end: "2026-12-20" }, { token: "t", fetchImpl });
    assert.deepStrictEqual(r.outbound, [{ code: "AUH", price: 190, date: "2026-12-15" }]);
    assert.deepStrictEqual(r.inbound, [{ code: "SIN", price: 70, date: "2026-12-16" }]);
    assert.ok(calls.every(u => new URL(u).searchParams.get("unique") === "true"));
});
