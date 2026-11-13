const test = require("node:test");
const assert = require("node:assert");
const { lookupLegs, pickFare, monthsAround, _cache } = require("../lib/prices.js");

function fakeFetch(table, calls = []) {
    return async (url, opts) => {
        calls.push({ url, opts });
        const u = new URL(url);
        const key = `${u.searchParams.get("origin")}-${u.searchParams.get("destination")}-${u.searchParams.get("departure_at")}`;
        return { ok: true, status: 200, json: async () => ({ success: true, data: table[key] || [] }) };
    };
}

test("monthsAround spans a month boundary", () => {
    assert.deepStrictEqual(monthsAround("2026-12-30"), ["2026-12", "2027-01"]);
    assert.deepStrictEqual(monthsAround("2026-12-15"), ["2026-12"]);
});

test("pickFare prefers the exact day, else cheapest within ±3 days", () => {
    const rows = [
        { price: 300, departure_at: "2026-12-14T10:00:00+00:00" },
        { price: 250, departure_at: "2026-12-14T22:00:00+00:00" },
        { price: 100, departure_at: "2026-12-16T10:00:00+00:00" },
        { price: 50, departure_at: "2026-12-25T10:00:00+00:00" },
    ];
    assert.strictEqual(pickFare(rows, "2026-12-14").exact.price, 250);
    assert.strictEqual(pickFare(rows, "2026-12-13").exact, null);
    assert.strictEqual(pickFare(rows, "2026-12-13").near.price, 100);
    assert.strictEqual(pickFare(rows, "2026-12-01").near, null);
});

test("lookupLegs returns fares, adds marker, caches months", async () => {
    _cache.clear();
    const calls = [];
    const fetchImpl = fakeFetch({
        "LHR-AUH-2026-12": [{ price: 210, departure_at: "2026-12-14T09:00:00+04:00", airline: "EY", transfers: 0, link: "/LON1412AUH1?t=abc" }],
        "AUH-HAN-2026-12": [{ price: 180, departure_at: "2026-12-18T09:00:00+04:00", airline: "VJ", transfers: 1 }],
    }, calls);
    const legs = [
        { from: "LHR", to: "AUH", date: "2026-12-14" },
        { from: "lhr", to: "auh", date: "2026-12-15" }, // same month → cached
        { from: "AUH", to: "HAN", date: "2026-12-17" },
        { from: "AUH", to: "XXX", date: "2026-12-17" },
    ];
    const out = await lookupLegs(legs, { token: "t", marker: "123", fetchImpl });
    assert.strictEqual(out[0].fare.price, 210);
    assert.strictEqual(out[0].fare.exactDate, true);
    assert.strictEqual(out[0].fare.link, "https://www.aviasales.com/LON1412AUH1?t=abc&marker=123");
    assert.strictEqual(out[1].fare.exactDate, false);
    assert.strictEqual(out[1].fare.date, "2026-12-14");
    assert.strictEqual(out[2].fare.transfers, 1);
    assert.strictEqual(out[3].fare, null);
    assert.strictEqual(calls.length, 3, "LHR-AUH month fetched once");
    assert.strictEqual(calls[0].opts.headers["X-Access-Token"], "t");
    assert.ok(!calls[0].url.includes("token="), "token not in URL");
});

test("lookupLegs rejects bad input and bad tokens", async () => {
    _cache.clear();
    await assert.rejects(lookupLegs([{ from: "LHR", to: "AUH", date: "tomorrow" }], { token: "t", fetchImpl: fakeFetch({}) }), /bad leg/);
    const denied = async () => ({ ok: false, status: 401, json: async () => ({}) });
    await assert.rejects(lookupLegs([{ from: "LHR", to: "AUH", date: "2026-12-14" }], { token: "t", fetchImpl: denied }), /token/);
});
