const test = require("node:test");
const assert = require("node:assert");
const P = require("../planner.js");

// fares: { "A-B": { "2026-12-14": 100, … } }
const fareFn = fares => (from, to, d) => {
    const m = fares[`${from}-${to}`];
    if (!m) return undefined;
    return d in m ? { price: m[d] } : null;
};
const legs = codes => codes.slice(0, -1).map((c, i) => ({ from: c, to: codes[i + 1] }));
const ctx = (days, minStay, depart = "2026-12-13") => ({ depart, days, minStay });

test("date helpers cross month and year ends", () => {
    assert.strictEqual(P.addDays("2026-12-30", 3), "2027-01-02");
    assert.strictEqual(P.dayDiff("2027-01-02", "2026-12-30"), 3);
    assert.deepStrictEqual(P.datesBetween("2026-12-31", "2027-01-01"), ["2026-12-31", "2027-01-01"]);
});

test("feasible: stops × minimum stay must fit the days", () => {
    assert.ok(P.feasible(3, ctx(3, 1)));
    assert.ok(!P.feasible(3, ctx(2, 1)));
    assert.ok(P.feasible(3, ctx(0, 0)));
});

test("defaultDates spreads stays but caps them at 3 nights", () => {
    assert.deepStrictEqual(P.defaultDates(2, ctx(3, 1)), ["2026-12-13", "2026-12-16"]);
    assert.deepStrictEqual(P.defaultDates(4, ctx(3, 1)), ["2026-12-13", "2026-12-14", "2026-12-15", "2026-12-16"]);
    assert.deepStrictEqual(P.defaultDates(2, ctx(14, 1)), ["2026-12-13", "2026-12-16"]);
    assert.deepStrictEqual(P.defaultDates(2, ctx(14, 5)), ["2026-12-13", "2026-12-18"]);
    assert.deepStrictEqual(P.defaultDates(3, ctx(0, 0)), ["2026-12-13", "2026-12-13", "2026-12-13"]);
    assert.deepStrictEqual(P.defaultDates(1, ctx(3, 1)), ["2026-12-13"]);
});

test("planDates picks the cheapest dates that fit the budget and minimum stay", () => {
    const f = fareFn({
        "LON-AUH": { "2026-12-13": 200 },
        "AUH-SIN": { "2026-12-13": 10, "2026-12-14": 150, "2026-12-15": 90, "2026-12-17": 20 },
        "SIN-HAN": { "2026-12-15": 60, "2026-12-16": 50, "2026-12-17": 5 },
    });
    // 3 days, ≥1 night: 13 → AUH; AUH→SIN on 14 or 15 (17 leaves no night before the last day); SIN→HAN by 16.
    const r = P.planDates(legs(["LON", "AUH", "SIN", "HAN"]), ctx(3, 1), f, true);
    assert.deepStrictEqual(r.dates, ["2026-12-13", "2026-12-15", "2026-12-16"]);
    assert.strictEqual(r.approx, false);
});

test("planDates shifts the first flight when nothing leaves on the day, and the budget moves with it", () => {
    const f = fareFn({
        "LON-AUH": { "2026-12-11": 200 },
        "AUH-HAN": { "2026-12-13": 100, "2026-12-14": 50, "2026-12-15": 10 },
    });
    const r = P.planDates(legs(["LON", "AUH", "HAN"]), ctx(3, 1), f, true);
    assert.deepStrictEqual(r.dates, ["2026-12-11", "2026-12-14"]);   // 15th would be 4 days after the 11th
    assert.strictEqual(r.approx, true);
});

test("planDates falls back flight by flight when no full chain is priced", () => {
    const f = fareFn({ "LON-AUH": { "2026-12-13": 200 }, "AUH-HAN": {} });
    const r = P.planDates(legs(["LON", "AUH", "HAN"]), ctx(3, 1), f, true);
    assert.deepStrictEqual(r.dates, ["2026-12-13", "2026-12-16"]);
    const manual = P.planDates(legs(["LON", "AUH", "HAN"]), ctx(3, 1), f, false);
    assert.deepStrictEqual(manual.dates, ["2026-12-13", "2026-12-16"]);
});

test("every plan respects the rules (randomised)", () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let t = 0; t < 300; t++) {
        const stops = 1 + Math.floor(rnd() * 3), minStay = Math.floor(rnd() * 3), days = stops * minStay + Math.floor(rnd() * 6);
        const codes = ["A", "B", "C", "D", "E"].slice(0, stops + 2);
        const fares = {};
        for (const l of legs(codes)) {
            const m = (fares[`${l.from}-${l.to}`] = {});
            for (const d of P.datesBetween("2026-12-08", "2026-12-31")) if (rnd() < 0.5) m[d] = Math.floor(rnd() * 300);
        }
        const c = ctx(days, minStay);
        const { dates } = P.planDates(legs(codes), c, fareFn(fares), true);
        assert.ok(Math.abs(P.dayDiff(dates[0], c.depart)) <= P.SHIFT_DAYS);
        for (let j = 1; j < dates.length; j++) assert.ok(P.dayDiff(dates[j], dates[j - 1]) >= minStay, `stay ${j}`);
        assert.ok(P.dayDiff(dates.at(-1), dates[0]) <= days, "within budget");
    }
});

test("windowsFor merges ranges per pair and covers shifted starts", () => {
    const w = P.windowsFor([legs(["LON", "AUH", "HAN"]), legs(["LON", "AUH", "SIN", "HAN"])], ctx(3, 1));
    const lonAuh = w.find(x => x.from === "LON" && x.to === "AUH");
    assert.deepStrictEqual([lonAuh.start, lonAuh.end], ["2026-12-10", "2026-12-16"]);
    const auhHan = w.find(x => x.from === "AUH" && x.to === "HAN");
    assert.deepStrictEqual([auhHan.start, auhHan.end], ["2026-12-11", "2026-12-19"]);
});
