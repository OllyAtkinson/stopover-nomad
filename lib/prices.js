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
const MAX_LEGS = 80;
const CONCURRENCY = 6;
const FLEX_DAYS = 3; // if nothing on the exact day, accept the cheapest within ±3 days

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

// Months (YYYY-MM) touched by date ± FLEX_DAYS.
function monthsAround(date) {
    return [...new Set([addDays(date, -FLEX_DAYS), date, addDays(date, FLEX_DAYS)].map(d => d.slice(0, 7)))];
}

function fetchMonth(from, to, month, { token, fetchImpl, currency }) {
    const key = `${from}-${to}-${month}-${currency}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.promise;

    const url = `${API}?` + new URLSearchParams({
        origin: from, destination: to, departure_at: month,
        one_way: "true", currency, sorting: "price", limit: "1000",
    });
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

// Pick the best fare for a leg: cheapest on the exact day, else cheapest
// within ±FLEX_DAYS (closest day breaks ties).
function pickFare(rows, date) {
    let exact = null, near = null;
    for (const r of rows) {
        if (typeof r.price !== "number" || !r.departure_at) continue;
        const day = String(r.departure_at).slice(0, 10);
        const diff = Math.abs(dayDiff(day, date));
        if (diff === 0) {
            if (!exact || r.price < exact.price) exact = r;
        } else if (diff <= FLEX_DAYS) {
            if (!near || r.price < near.price ||
                (r.price === near.price && diff < Math.abs(dayDiff(near.departure_at.slice(0, 10), date)))) near = r;
        }
    }
    return { exact, near };
}

function shapeFare(r, date, marker) {
    if (!r) return null;
    let link = null;
    if (r.link) {
        const u = new URL(r.link, "https://www.aviasales.com");
        if (marker) u.searchParams.set("marker", marker);
        link = u.toString();
    }
    const day = String(r.departure_at).slice(0, 10);
    return {
        price: r.price,
        date: day,
        exactDate: day === date,
        airline: r.airline || null,
        flightNumber: r.flight_number || null,
        transfers: typeof r.transfers === "number" ? r.transfers : null,
        durationMin: r.duration_to || r.duration || null,
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

// legs: [{ from, to, date }] → [{ from, to, date, fare | null, error? }]
async function lookupLegs(legs, { token, marker = "", currency = "gbp", fetchImpl = fetch } = {}) {
    if (!Array.isArray(legs)) throw Object.assign(new Error("legs must be an array"), { status: 400 });
    if (legs.length > MAX_LEGS) throw Object.assign(new Error(`at most ${MAX_LEGS} legs per request`), { status: 400 });
    const clean = legs.map(l => ({
        from: String(l && l.from || "").toUpperCase(),
        to: String(l && l.to || "").toUpperCase(),
        date: String(l && l.date || ""),
    }));
    for (const l of clean) {
        if (!IATA.test(l.from) || !IATA.test(l.to) || !ISO_DATE.test(l.date)) {
            throw Object.assign(new Error(`bad leg ${JSON.stringify(l)}`), { status: 400 });
        }
    }

    let authFailed = false;
    const results = await mapLimit(clean, CONCURRENCY, async (l) => {
        try {
            const months = await Promise.all(monthsAround(l.date).map(m =>
                fetchMonth(l.from, l.to, m, { token, fetchImpl, currency })));
            const { exact, near } = pickFare(months.flat(), l.date);
            return { ...l, fare: shapeFare(exact || near, l.date, marker) };
        } catch (e) {
            if (e.auth) authFailed = true;
            return { ...l, fare: null, error: "lookup failed" };
        }
    });
    if (authFailed) throw Object.assign(new Error("Travelpayouts rejected the API token"), { status: 502 });
    return results;
}

module.exports = { lookupLegs, pickFare, monthsAround, MAX_LEGS, FLEX_DAYS, _cache: cache };
