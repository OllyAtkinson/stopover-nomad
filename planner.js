// Fitting stopovers into a time budget. Pure functions, shared by the
// browser (window.Planner) and the tests (require("./planner.js")).
//
// ctx = { depart: "YYYY-MM-DD", days, minStay }
// A route with s stops has s + 1 flights. Flight j leaves on d_j with
//   d_0 = the departure day (or up to SHIFT_DAYS either side, if nothing leaves that day),
//   d_j ≥ d_(j-1) + minStay, and the last flight leaves by d_0 + days.
// legs = [{ from, to }] (codes); fareOn(from, to, date) → fare | null | undefined.
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.Planner = factory();
})(typeof self !== "undefined" ? self : this, function () {
    const SHIFT_DAYS = 3;
    const DEFAULT_STAY = 3;

    function addDays(iso, n) {
        const [y, m, d] = iso.split("-").map(Number);
        return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
    }
    function dayDiff(a, b) {   // whole days from b to a
        const [y1, m1, d1] = a.split("-").map(Number), [y2, m2, d2] = b.split("-").map(Number);
        return Math.round((Date.UTC(y1, m1 - 1, d1) - Date.UTC(y2, m2 - 1, d2)) / 86400000);
    }
    function datesBetween(start, end) {
        const out = [];
        for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
        return out;
    }

    const feasible = (stops, ctx) => stops * ctx.minStay <= ctx.days;

    // Without prices: a sensible stay at each stop — the budget shared evenly, but no more
    // than DEFAULT_STAY nights unless the minimum stay asks for more.
    function defaultDates(nLegs, ctx) {
        const s = nLegs - 1;
        const stay = s ? Math.max(ctx.minStay, Math.min(Math.floor(ctx.days / s), Math.max(ctx.minStay, DEFAULT_STAY))) : 0;
        return Array.from({ length: nLegs }, (_, j) => addDays(ctx.depart, j * stay));
    }

    // Cheapest dates starting on d0 (dynamic programming over days). → { dates, cost } | null
    function cheapestFrom(legs, ctx, d0, fareOn) {
        const s = legs.length - 1;
        const last = addDays(d0, ctx.days);
        const f0 = fareOn(legs[0].from, legs[0].to, d0);
        if (!f0) return null;
        let layer = new Map([[d0, { cost: f0.price, prev: null }]]);
        const layers = [layer];
        for (let j = 1; j <= s; j++) {
            const next = new Map();
            const latest = addDays(last, -(s - j) * ctx.minStay);
            for (const [pd, st] of layer) {
                for (let d = addDays(pd, ctx.minStay); d <= latest; d = addDays(d, 1)) {
                    const f = fareOn(legs[j].from, legs[j].to, d);
                    if (!f) continue;
                    const cost = st.cost + f.price;
                    if (!next.has(d) || cost < next.get(d).cost) next.set(d, { cost, prev: pd });
                }
            }
            layers.push(layer = next);
        }
        if (!layer.size) return null;
        const [end, { cost }] = [...layer.entries()].sort((x, y) => x[1].cost - y[1].cost)[0];
        const dates = [];
        for (let j = s, d = end; j >= 0; j--) { dates[j] = d; d = layers[j].get(d).prev; }
        return { dates, cost };
    }

    function cheapestDates(legs, ctx, firstDays, fareOn) {
        let best = null;
        for (const d0 of firstDays) {
            const r = cheapestFrom(legs, ctx, d0, fareOn);
            if (r && (!best || r.cost < best.cost)) best = r;
        }
        return best && best.dates;
    }

    // When not every flight has a fare: flight by flight, the cheapest seen day that still
    // leaves room for the rest, else the default date.
    function greedyDates(legs, ctx, fareOn) {
        const s = legs.length - 1;
        const last = addDays(ctx.depart, ctx.days);
        const fallback = defaultDates(legs.length, ctx);
        const dates = [];
        for (let j = 0; j <= s; j++) {
            const earliest = j === 0 ? ctx.depart : addDays(dates[j - 1], ctx.minStay);
            const latest = j === 0 ? ctx.depart : addDays(last, -(s - j) * ctx.minStay);
            let best = null;
            for (const d of datesBetween(earliest, latest)) {
                const f = fareOn(legs[j].from, legs[j].to, d);
                if (f && (!best || f.price < best.price)) best = { d, price: f.price };
            }
            dates[j] = best ? best.d : (fallback[j] < earliest ? earliest : fallback[j] > latest ? latest : fallback[j]);
        }
        return dates;
    }

    // → { dates, approx } — approx: the first flight was moved off the departure day.
    function planDates(legs, ctx, fareOn, live) {
        if (!live) return { dates: defaultDates(legs.length, ctx), approx: false };
        let dates = cheapestDates(legs, ctx, [ctx.depart], fareOn);
        if (dates) return { dates, approx: false };
        const around = datesBetween(addDays(ctx.depart, -SHIFT_DAYS), addDays(ctx.depart, SHIFT_DAYS));
        dates = cheapestDates(legs, ctx, around, fareOn);
        if (dates) return { dates, approx: dates[0] !== ctx.depart };
        return { dates: greedyDates(legs, ctx, fareOn), approx: false };
    }

    // Date ranges to look up so any plan is covered, merged per code pair.
    // legLists = [[{ from, to }, …], …] (one list per route)
    function windowsFor(legLists, ctx) {
        const byPair = new Map();
        for (const legs of legLists) {
            const s = legs.length - 1;
            legs.forEach((l, j) => {
                const start = addDays(ctx.depart, j * ctx.minStay - SHIFT_DAYS);
                const end = addDays(ctx.depart, SHIFT_DAYS + (j === 0 ? 0 : ctx.days - (s - j) * ctx.minStay));
                const k = `${l.from}-${l.to}`;
                const w = byPair.get(k);
                if (!w) byPair.set(k, { from: l.from, to: l.to, start, end });
                else { if (start < w.start) w.start = start; if (end > w.end) w.end = end; }
            });
        }
        return [...byPair.values()];
    }

    return { SHIFT_DAYS, DEFAULT_STAY, addDays, dayDiff, datesBetween, feasible, defaultDates,
             cheapestDates, greedyDates, planDates, windowsFor };
});
