// Leg price lookup against the Travelpayouts (Aviasales) Data API.
//
// These are *cached* fares: the cheapest prices Aviasales users have seen
// recently, not a live search. That's what makes it cheap enough to score
// lots of split routes at once. Treat the result as "about this much" and
// let the user click through to confirm.
//
// API: GET https://api.travelpayouts.com/aviasales/v3/prices_for_dates
//      ?origin=LHR&destination=DXB&departure_at=2026-12&one_way=true
//      &currency=gbp&sorting=price&limit=1000&token=...

const API = "https://api.travelpayouts.com/aviasales/v3/prices_for_dates";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // upstream data is itself cached; 6h is plenty
const MAX_WINDOWS = 80;
const MAX_SPAN = 45;  // days per window
const CONCURRENCY = 6;

const IATA = /^[A-Z]{3}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const cache = new Map(); // "LHR-DXB-2026-12" -> { at, promise }

function dayDiff(a, b) {
    return Math.round((Date.parse(a) - Date.parse(b)) / 86400000);
}
function addDays(iso, n) {
    const d = new Date(iso + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}

// from or to may be "" for an explore query (cheapest fares to/from anywhere).
function fetchMonth(from, to, month, { token, fetchImpl, currency }) {
    const key = `${from}-${to}-${month}-${currency}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.promise;

    const params = { departure_at: month, one_way: "true", currency, sorting: "price", limit: "1000" };
    if (from) params.origin = from;
    if (to) params.destination = to;
    if (!from || !to) params.unique = "true";   // one row (the cheapest) per route
    const url = `${API}?` + new URLSearchParams(params);
    const promise = fetchImpl(url, { headers: { "X-Access-Token": token, "Accept-Encoding": "gzip" } })
        .then(async r => {
            if (r.status === 401 || r.status === 403) throw Object.assign(new Error("bad token"), { auth: true });
            if (!r.ok) throw new Error(`upstream ${r.status}`);
            const body = await r.json();
            return Array.isArray(body.data) ? body.data : [];
        });
    cache.set(key, { at: Date.now(), promise });
    promise.catch(() => cache.delete(key)); // don't cache failures
    return promise;
}

// Cheapest fare per departure day: { "2026-12-14": row, ... }
function cheapestByDay(rows) {
    const out = {};
    for (const r of rows) {
        if (typeof r.price !== "number" || !r.departure_at) continue;
        const day = String(r.departure_at).slice(0, 10);
        if (!out[day] || r.price < out[day].price) out[day] = r;
    }
    return out;
}

function shapeFare(r, marker) {
    let link = null;
    if (r.link) {
        const u = new URL(r.link, "https://www.aviasales.com");
        if (marker) u.searchParams.set("marker", marker);
        link = u.toString();
    }
    return {
        price: r.price,
        airline: r.airline || null,
        flightNumber: r.flight_number || null,
        transfers: typeof r.transfers === "number" ? r.transfers : null,
        durationMin: r.duration_to || r.duration || null,
        fromAirport: r.origin_airport || null,
        toAirport: r.destination_airport || null,
        foundAt: r.found_at || null,   // when this fare was seen, if the API says
        link,
    };
}

async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let i = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (i < items.length) {
            const idx = i++;
            out[idx] = await fn(items[idx], idx);
        }
    });
    await Promise.all(workers);
    return out;
}

const monthsBetween = (start, end) => {
    const out = [];
    for (let m = start.slice(0, 7); m <= end.slice(0, 7); m = addDays(m + "-01", 32).slice(0, 7)) out.push(m);
    return out;
};

// windows: [{ from, to, start, end }] (dates inclusive, at most MAX_SPAN days)
// → [{ from, to, start, end, days: { "YYYY-MM-DD": fare } }]; days with no fare are left out.
async function lookupWindows(windows, { token, marker = "", currency = "gbp", fetchImpl = fetch } = {}) {
    const bad = msg => Object.assign(new Error(msg), { status: 400 });
    if (!Array.isArray(windows)) throw bad("windows must be an array");
    if (windows.length > MAX_WINDOWS) throw bad(`at most ${MAX_WINDOWS} windows per request`);
    const clean = windows.map(w => ({
        from: String(w && w.from || "").toUpperCase(),
        to: String(w && w.to || "").toUpperCase(),
        start: String(w && w.start || ""),
        end: String(w && w.end || ""),
    }));
    for (const w of clean) {
        if (!IATA.test(w.from) || !IATA.test(w.to) || !ISO_DATE.test(w.start) || !ISO_DATE.test(w.end)) throw bad(`bad window ${JSON.stringify(w)}`);
        const span = dayDiff(w.end, w.start);
        if (span < 0 || span > MAX_SPAN) throw bad(`window must be 0–${MAX_SPAN} days: ${JSON.stringify(w)}`);
    }

    let authFailed = false;
    const results = await mapLimit(clean, CONCURRENCY, async (w) => {
        try {
            const months = await Promise.all(monthsBetween(w.start, w.end).map(m =>
                fetchMonth(w.from, w.to, m, { token, fetchImpl, currency })));
            const byDay = cheapestByDay(months.flat());
            const days = {};
            for (const [day, r] of Object.entries(byDay)) {
                if (day >= w.start && day <= w.end) days[day] = shapeFare(r, marker);
            }
            return { ...w, days };
        } catch (e) {
            if (e.auth) authFailed = true;
            return { ...w, days: {}, error: "lookup failed" };
        }
    });
    if (authFailed) throw Object.assign(new Error("Travelpayouts rejected the API token"), { status: 502 });
    return results;
}

// Price-first route finding: the cheapest places to fly to from `from`, and to `to` from,
// between two dates. → { outbound: [{ code, price, date }], inbound: [...] }
async function explore({ from, to, start, end } = {}, { token, currency = "gbp", fetchImpl = fetch } = {}) {
    const bad = msg => Object.assign(new Error(msg), { status: 400 });
    from = String(from || "").toUpperCase(); to = String(to || "").toUpperCase();
    if ((from && !IATA.test(from)) || (to && !IATA.test(to)) || (!from && !to)) throw bad("explore needs from and/or to codes");
    if (!ISO_DATE.test(start || "") || !ISO_DATE.test(end || "") || dayDiff(end, start) < 0 || dayDiff(end, start) > MAX_SPAN) throw bad("bad explore dates");
    const months = monthsBetween(start, end);
    let authFailed = false;
    const side = async (origin, destination, pick) => {
        try {
            const rows = (await Promise.all(months.map(m => fetchMonth(origin, destination, m, { token, fetchImpl, currency })))).flat();
            const best = new Map();
            for (const r of rows) {
                const code = pick(r), day = String(r.departure_at || "").slice(0, 10);
                if (!code || typeof r.price !== "number" || day < start || day > end) continue;
                if (!best.has(code) || r.price < best.get(code).price) best.set(code, { code, price: r.price, date: day });
            }
            return [...best.values()].sort((x, y) => x.price - y.price).slice(0, 80);
        } catch (e) {
            if (e.auth) authFailed = true;
            return [];   // explore is a bonus: the app falls back to the route data
        }
    };
    const [outbound, inbound] = await Promise.all([
        from ? side(from, "", r => r.destination) : [],
        to ? side("", to, r => r.origin) : [],
    ]);
    if (authFailed) throw Object.assign(new Error("Travelpayouts rejected the API token"), { status: 502 });
    return { outbound, inbound };
}

module.exports = { explore, lookupWindows, cheapestByDay, monthsBetween, MAX_WINDOWS, MAX_SPAN, _cache: cache };
