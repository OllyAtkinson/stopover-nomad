// =========================================================
// Stopover Nomad — split-ticket finder
//
// Idea: one through-ticket A → B is often dearer than two separate
// one-way tickets A → C and C → B (especially when budget airlines
// fly one of the legs). This finds stopover airports C where the route
// data shows both legs exist, then gives the user prefilled search links
// for each ticket so they can check the prices and see the saving.
//
// Prices: if the /api/prices backend is deployed with a Travelpayouts token,
// every leg's price is filled in automatically from recently seen fares, and
// splits are sorted by real total. Without it, users type prices in.
//
// Data: AIRPORTS (airports.js, OurAirports) and ROUTES / AIRLINE_NAMES
// (routes.js, an OpenFlights snapshot — around 2014, so it's used to
// find candidate stopovers, not as a live timetable).
// =========================================================

// ---- Small helpers -------------------------------------------------
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
));
// OurAirports city names can be long ("Paris (Roissy-en-France, Val-d'Oise)") — keep the first part.
const placeName = a => (a.city ? a.city.replace(/\s*\(.*$/, "").split(",")[0].trim() : "") || a.name;
const CURRENCY = "£";
// Flag image (bundled flag-icons SVGs, so Windows shows real flags too, not "IN").
// alt is empty where the country name is written next to it.
const flag = (cc, alt = "") => /^[A-Z]{2}$/.test(cc || "")
    ? `<img class="flag" src="vendor/flags/${cc.toLowerCase()}.svg" alt="${esc(alt)}" title="${esc(alt)}" width="16" height="12" loading="lazy" onerror="this.remove()">`
    : "";
// "IN" → "India" (built into the browser, no data file needed)
const REGION_NAMES = (() => { try { return new Intl.DisplayNames(["en-GB"], { type: "region" }); } catch { return null; } })();
const countryName = cc => { try { return (REGION_NAMES && cc && REGION_NAMES.of(cc)) || cc || ""; } catch { return cc || ""; } };
// "Delhi, India [flag]" (HTML)
const placeLabel = a => esc([placeName(a), countryName(a.country)].filter(Boolean).join(", ")) + (flag(a.country) ? " " + flag(a.country) : "");

// ---- Map setup -------------------------------------------------
const WORLD_BOUNDS = L.latLngBounds([-85, -180], [85, 180]);

const map = L.map("map", {
    zoomControl: true,
    worldCopyJump: false,
    minZoom: 2,
    maxBounds: WORLD_BOUNDS,
    maxBoundsViscosity: 1.0,
    preferCanvas: true
}).setView([20, 10], 2);

map.attributionControl.setPrefix(false);
// Basemap: Esri Light Gray (no API key needed — CARTO's free tiles now show an
// "API KEY REQUIRED" watermark). Labels come from a separate reference layer.
// If Esri tiles fail repeatedly, fall back to standard OpenStreetMap tiles.
const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/";
const baseLayer = L.tileLayer(ESRI + "World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 16,
    noWrap: true,
    attribution: 'Tiles &copy; <a href="https://www.esri.com">Esri</a> — Esri, HERE, Garmin, &copy; OpenStreetMap contributors'
}).addTo(map);
map.createPane("labels");                       // above the basemap, below dots and routes
map.getPane("labels").style.zIndex = 350;
map.getPane("labels").style.pointerEvents = "none";
const labelLayer = L.tileLayer(ESRI + "World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 16,
    noWrap: true,
    pane: "labels"
}).addTo(map);

let tileErrors = 0;
baseLayer.on("tileerror", () => {
    if (++tileErrors !== 6) return;
    map.removeLayer(baseLayer);
    map.removeLayer(labelLayer);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        noWrap: true,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);
});

// If the layout changes size (e.g. phone rotation), make Leaflet re-measure.
window.addEventListener("resize", () => map.invalidateSize());

// ---- Airport index -----------------------------------------------
const byIata = new Map();
AIRPORTS.forEach(a => {
    byIata.set(a.iata, a);
    a._iata = a.iata.toLowerCase();
    a._city = (a.city || "").toLowerCase();
    a._name = a.name.toLowerCase();
    a._search = `${a.iata} ${a.icao} ${a.name} ${a.city} ${a.country} ${countryName(a.country)}`.toLowerCase();
});

function connectionCount(iata) {
    const edges = ROUTES[iata];
    return edges ? edges.length : 0;
}

// ---- Render every airport as a canvas dot, coloured by connectivity ------------------------
const sizeByType = {
    large_airport:  { radius: 4.2, weight: 1 },
    medium_airport: { radius: 2.8, weight: 0 },
    small_airport:  { radius: 1.8, weight: 0 }
};

function connectivityColor(count) {
    if (count === 0) return { color: "#cbd5e1", fillOpacity: 0.5 };
    if (count < 5)   return { color: "#ef4444", fillOpacity: 0.75 };
    if (count < 15)  return { color: "#f59e0b", fillOpacity: 0.8 };
    return               { color: "#22c55e", fillOpacity: 0.85 };
}

const airportLayer = L.layerGroup().addTo(map);

AIRPORTS.forEach(a => {
    const size = sizeByType[a.type] || sizeByType.small_airport;
    const conns = connectionCount(a.iata);
    const c = connectivityColor(conns);
    const m = L.circleMarker([a.lat, a.lon], {
        radius: size.radius,
        color: c.color,
        fillColor: c.color,
        fillOpacity: c.fillOpacity,
        weight: size.weight,
        opacity: 0.9
    });

    const connLabel = conns > 0 ? `${conns} nonstop route${conns === 1 ? "" : "s"}` : "no route data";
    m.bindTooltip(`${esc(a.iata)} · ${placeLabel(a)} · ${connLabel}`, { direction: "top", opacity: 0.9, offset: [0, -4] });

    m.bindPopup(`
        <div class="airport-popup">
            <div class="airport-popup-code">${esc(a.iata)}</div>
            <div class="airport-popup-name">${esc(a.name)}</div>
            <div class="airport-popup-city">${placeLabel(a)}</div>
            <div class="airport-popup-conns">${connLabel}</div>
            <div class="airport-popup-actions">
                <button data-role="from" data-iata="${esc(a.iata)}">Set as From</button>
                <button data-role="to" data-iata="${esc(a.iata)}">Set as To</button>
            </div>
        </div>
    `);

    m.on("popupopen", () => {
        const el = m.getPopup().getElement();
        el.querySelectorAll("button[data-role]").forEach(btn => {
            btn.addEventListener("click", () => {
                setField(btn.dataset.role, btn.dataset.iata);
                map.closePopup();
            });
        });
    });

    m.addTo(airportLayer);
});

// ---- DOM refs -------------------------------------------------
const fromInput = document.getElementById("from-input");
const toInput = document.getElementById("to-input");
const fromList = document.getElementById("from-suggestions");
const toList = document.getElementById("to-suggestions");
const dateInput = document.getElementById("date-input");
const nightsInput = document.getElementById("nights-input");
const stopsInput = document.getElementById("stops-input");
const nearbyInput = document.getElementById("nearby-input");
const searchBtn = document.getElementById("search-btn");
const resultsPanel = document.getElementById("results");
const statusHint = document.getElementById("status-hint");

let fromAirport = null;
let toAirport = null;

// ---- Dates -------------------------------------------------
function isoDate(d) {
    const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
}
function addDays(iso, n) {
    const [y, m, d] = iso.split("-").map(Number);
    return isoDate(new Date(y, m - 1, d + n));
}
function prettyDate(iso) {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

const today = new Date();
dateInput.min = isoDate(today);
dateInput.value = addDays(isoDate(today), 30);

// ---- Autocomplete -------------------------------------------------
// Ranks real matches (exact code, city name, airport name) and breaks ties by
// how connected the airport is — so "London" gives Heathrow, not London, Ontario.
function search(query, limit = 8) {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    const scored = [];
    for (const a of AIRPORTS) {
        let s;
        if (a._iata === q) s = 2000;
        else if (a._city === q || a._city.startsWith(q + ",") || a._city.startsWith(q + " (")) s = 700;
        else if (a._city.startsWith(q)) s = 500;
        else if (a._name.startsWith(q)) s = 450;
        else if (a._iata.startsWith(q)) s = 400;
        else if (a._search.includes(q)) s = 100;
        else continue;
        s += Math.min(connectionCount(a.iata), 250) * 1.5;
        if (a.type === "large_airport") s += 60;
        else if (a.type === "medium_airport") s += 20;
        scored.push({ a, s });
    }
    scored.sort((x, y) => y.s - x.s);
    return scored.slice(0, limit).map(x => x.a);
}

function renderSuggestions(listEl, items, role) {
    listEl.innerHTML = "";
    if (!items.length) { listEl.classList.remove("open"); return; }
    items.forEach(a => {
        const li = document.createElement("li");
        li.innerHTML = `<span class="sugg-code">${esc(a.iata)}</span><span class="sugg-info">${esc(a.name)}${a.city ? " · " + esc(placeName(a)) : ""}, ${esc(countryName(a.country))} ${flag(a.country)}</span>`;
        li.addEventListener("mousedown", (e) => {
            e.preventDefault();
            setField(role, a.iata);
            listEl.classList.remove("open");
        });
        listEl.appendChild(li);
    });
    listEl.classList.add("open");
}

function wireInput(input, list, role) {
    input.addEventListener("input", () => {
        // Typing invalidates the previous pick — otherwise the old airport gets searched.
        if (role === "from") fromAirport = null; else toAirport = null;
        renderSuggestions(list, search(input.value), role);
    });
    input.addEventListener("blur", () => setTimeout(() => list.classList.remove("open"), 100));
    input.addEventListener("keydown", (e) => {
        if (e.key === "Escape") { list.classList.remove("open"); return; }
        if (e.key !== "Enter") return;
        e.preventDefault();
        const first = search(input.value)[0];
        if (first && !(role === "from" ? fromAirport : toAirport)) setField(role, first.iata);
        list.classList.remove("open");
        runSearch();
    });
}
wireInput(fromInput, fromList, "from");
wireInput(toInput, toList, "to");

function setField(role, iata) {
    const a = byIata.get(iata);
    if (!a) return;
    if (role === "from") {
        fromAirport = a;
        fromInput.value = `${placeName(a)} (${a.iata})`;
    } else {
        toAirport = a;
        toInput.value = `${placeName(a)} (${a.iata})`;
    }
}

// ---- Geo math -------------------------------------------------
const R_KM = 6371;
const toRad = d => d * Math.PI / 180;
const toDeg = r => r * 180 / Math.PI;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

function haversine(a, b) {
    const dLat = toRad(b.lat - a.lat);
    const dLon = toRad(b.lon - a.lon);
    const la1 = toRad(a.lat), la2 = toRad(b.lat);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
    return 2 * R_KM * Math.asin(Math.sqrt(clamp(h, 0, 1)));
}

function bearing(a, b) {
    const la1 = toRad(a.lat), la2 = toRad(b.lat);
    const dLon = toRad(b.lon - a.lon);
    const y = Math.sin(dLon) * Math.cos(la2);
    const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLon);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

// Cross-track distance of p from the great circle a→b (km), and signed
// along-track fraction (negative = behind a, >1 = beyond b).
function crossTrack(a, b, p) {
    const d13 = haversine(a, p) / R_KM;
    const dBrng = toRad(bearing(a, p)) - toRad(bearing(a, b));
    const dxt = Math.asin(clamp(Math.sin(d13) * Math.sin(dBrng), -1, 1));
    const dat = Math.acos(clamp(Math.cos(d13) / Math.cos(dxt), -1, 1)) * R_KM;
    const sign = Math.cos(dBrng) < 0 ? -1 : 1;
    const total = haversine(a, b);
    return { cross: Math.abs(dxt * R_KM), frac: total > 0 ? sign * dat / total : 0 };
}

// Great-circle points between a and b, longitudes kept continuous.
function greatCirclePoints(a, b, n = 64) {
    const la1 = toRad(a.lat), lo1 = toRad(a.lon);
    const la2 = toRad(b.lat), lo2 = toRad(b.lon);
    const d = 2 * Math.asin(Math.sqrt(clamp(
        Math.sin((la2 - la1) / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin((lo2 - lo1) / 2) ** 2, 0, 1
    )));
    if (d === 0) return [[a.lat, a.lon]];
    const pts = [];
    for (let i = 0; i <= n; i++) {
        const f = i / n;
        const A = Math.sin((1 - f) * d) / Math.sin(d);
        const B = Math.sin(f * d) / Math.sin(d);
        const x = A * Math.cos(la1) * Math.cos(lo1) + B * Math.cos(la2) * Math.cos(lo2);
        const y = A * Math.cos(la1) * Math.sin(lo1) + B * Math.cos(la2) * Math.sin(lo2);
        const z = A * Math.sin(la1) + B * Math.sin(la2);
        pts.push([toDeg(Math.atan2(z, Math.sqrt(x * x + y * y))), toDeg(Math.atan2(y, x))]);
    }
    return pts;
}

// The map doesn't wrap (noWrap + maxBounds at ±180), so a line crossing the
// Pacific date line has to be cut into two pieces, one at each map edge.
function splitAtAntimeridian(pts) {
    const segs = [[pts[0]]];
    for (let i = 1; i < pts.length; i++) {
        const [lat0, lon0] = pts[i - 1];
        const [lat1, lon1] = pts[i];
        if (Math.abs(lon1 - lon0) > 180) {
            const edge = lon0 > 0 ? 180 : -180;
            const lon1Adj = lon1 + (lon0 > 0 ? 360 : -360);
            const t = (edge - lon0) / (lon1Adj - lon0);
            const latX = lat0 + t * (lat1 - lat0);
            segs[segs.length - 1].push([latX, edge]);
            segs.push([[latX, -edge]]);
        }
        segs[segs.length - 1].push([lat1, lon1]);
    }
    return segs;
}

function flightTimeStr(km) {
    const mins = Math.round((km / 850 + 0.5) * 60); // ~850 km/h cruise + taxi/climb buffer
    const h = Math.floor(mins / 60), m = mins % 60;
    return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

// ---- Route drawing -------------------------------------------------
const routeLayers = L.layerGroup().addTo(map);
const endpointMarkers = L.layerGroup().addTo(map);

function clearRoute() {
    routeLayers.clearLayers();
    endpointMarkers.clearLayers();
}

function drawLeg(a, b, color = "#2563eb") {
    const segs = splitAtAntimeridian(greatCirclePoints(a, b));
    L.polyline(segs, { color, weight: 10, opacity: 0.08, interactive: false }).addTo(routeLayers);
    L.polyline(segs, { color, weight: 4, opacity: 0.9, lineJoin: "round", interactive: false }).addTo(routeLayers);
    return segs.flat();
}

function markPoint(a, label, cls = "") {
    const icon = L.divIcon({
        className: "custom-marker",
        html: `<div class="dot ${cls}"></div>`,
        iconSize: [14, 14],
        iconAnchor: [7, 7]
    });
    L.marker([a.lat, a.lon], { icon, zIndexOffset: 1000 })
        .bindTooltip(`${esc(label)}: ${esc(a.iata)} — ${placeLabel(a)}`, { direction: "top", offset: [0, -8] })
        .addTo(endpointMarkers);
}

function fitTo(points) {
    map.fitBounds(L.latLngBounds(points), { padding: [60, 60], maxZoom: 7 });
}

// ---- Route data helpers -------------------------------------------------
function airlineLabel(codes) {
    return codes.map(c => AIRLINE_NAMES[c] || c).join(", ");
}

function findEdge(fromIata, toIata) {
    return (ROUTES[fromIata] || []).find(e => e.to === toIata) || null;
}

// Budget airlines in the dataset. Splits with one of these on a leg are the
// classic split-ticket win, because they rarely sell through-tickets.
const BUDGET = new Set([
    "FR", "U2", "W6", "DY", "VY", "HV", "TO", "LS", "4U", "EW", "PC", "V7", "XQ",
    "AK", "FD", "QZ", "D7", "TR", "3K", "JQ", "TT", "5J", "Z2", "DD", "SL", "JT", "OD", "QG",
    "MM", "BC", "7C", "ZE", "TW", "LJ",
    "6E", "SG", "IX", "G9", "FZ", "XY", "J9",
    "NK", "WN", "F9", "G4", "B6", "Y4", "4O", "AD"
]);
const hasBudget = codes => codes.some(c => BUDGET.has(c));

// Airports near `a` (including `a`) that actually have routes — lets a London
// search use Stansted/Luton/Gatwick too, which is where a lot of savings are.
function nearbyAirports(a, km = 100, max = 6) {
    if (!nearbyInput.checked) return [a];
    const near = AIRPORTS
        .filter(x => x.iata !== a.iata && connectionCount(x.iata) > 0 && haversine(a, x) <= km)
        .sort((x, y) => connectionCount(y.iata) - connectionCount(x.iata))
        .slice(0, max - 1);
    return [a, ...near];
}

// Reverse route index (who flies INTO each airport) — built once, used to
// prune multi-stop searches to airports that can still reach the destination.
let REVERSE = null;
function reverseIndex() {
    if (REVERSE) return REVERSE;
    REVERSE = new Map();
    for (const from in ROUTES) {
        for (const e of ROUTES[from]) {
            if (!REVERSE.has(e.to)) REVERSE.set(e.to, []);
            REVERSE.get(e.to).push(from);
        }
    }
    return REVERSE;
}

// Fewest legs from each airport to any destination airport (up to maxHops).
function hopsToDest(dests, maxHops) {
    const rev = reverseIndex();
    const hops = new Map(dests.map(d => [d.iata, 0]));
    let frontier = dests.map(d => d.iata);
    for (let h = 1; h <= maxHops && frontier.length; h++) {
        const next = [];
        for (const iata of frontier) {
            for (const from of rev.get(iata) || []) {
                if (!hops.has(from)) { hops.set(from, h); next.push(from); }
            }
        }
        frontier = next;
    }
    return hops;
}

// Split candidates with exactly `stops` stopovers:
//   O (near A) → hub 1 → … → hub N → D (near B), every leg a separate ticket,
// and every leg present in the route data. Ranked by how likely the split is
// to save money (budget airlines, airline changes, little detour).
function findSplits(a, b, origins, dests, stops = 1) {
    const direct = haversine(a, b);
    // Generous detour limit: a longer way round can still be the cheapest.
    const maxRatio = (direct < 1500 ? 3.0 : 2.2) + 0.2 * (stops - 1);
    const maxDist = direct * maxRatio;
    const excluded = new Set([...origins, ...dests].map(x => x.iata));
    const hops = hopsToDest(dests, stops);
    const destByIata = new Map(dests.map(d => [d.iata, d]));
    const best = new Map(); // hub sequence → best candidate
    let explored = 0;
    const LIMIT = 150000;   // safety cap so 3-stop searches stay fast

    function addCandidate(path, edges, dist) {
        const o = path[0], d = path[path.length - 1];
        const hubs = path.slice(1, -1);
        let budgetLegs = 0, airlineChanges = 0;
        edges.forEach((e, i) => {
            if (hasBudget(e.airlines)) budgetLegs++;
            if (i > 0 && !edges[i - 1].airlines.some(x => e.airlines.includes(x))) airlineChanges++;
        });
        const ratio = dist / direct;
        // Without prices this is a best guess at "likely cheap", so distance is
        // only a minor factor next to budget airlines and airline changes.
        let score = 0.4 * ratio;
        score -= 0.12 * (airlineChanges / stops);  // switching airlines → splits the big sites often miss
        if (budgetLegs > 0) score -= 0.10;          // a budget carrier on a leg
        if (budgetLegs > 1) score -= 0.05;
        if (o !== a) score += 0.03;                 // slight preference for the airports they asked for
        if (d !== b) score += 0.03;
        // Multi-stop sanity: tiny hops and small airports rarely make a good split.
        for (let i = 0; i < path.length - 1; i++) {
            if (haversine(path[i], path[i + 1]) < Math.max(250, direct * 0.08)) score += 0.08;
        }
        for (const h of hubs) {
            const n = connectionCount(h.iata);
            if (n < 40) score += 0.06;
            if (n < 15) score += 0.06;
        }
        const key = hubs.map(h => h.iata).join(">");
        const prev = best.get(key);
        if (!prev || score < prev.score) {
            best.set(key, { path, hubs, edges, o, d, dist, ratio, budgetLegs, airlineChanges, score });
        }
    }

    function walk(path, edges, dist) {
        if (++explored > LIMIT) return;
        const node = path[path.length - 1];
        const legsLeft = stops + 1 - edges.length;   // legs still to fly, including the next one
        for (const e of ROUTES[node.iata] || []) {
            if (legsLeft === 1) {
                const d = destByIata.get(e.to);
                if (!d) continue;
                const total = dist + haversine(node, d);
                if (total <= maxDist) addCandidate([...path, d], [...edges, e], total);
                continue;
            }
            if (excluded.has(e.to) || path.some(p => p.iata === e.to)) continue;
            const h = hops.get(e.to);
            if (h === undefined || h > legsLeft - 1) continue;      // can't reach B in time
            const next = byIata.get(e.to);
            if (!next) continue;
            const legKm = haversine(node, next);
            if (legKm < 150) continue;                               // skip pointless hops
            const soFar = dist + legKm;
            if (soFar + haversine(next, b) > maxDist) continue;      // too much detour already
            walk([...path, next], [...edges, e], soFar);
        }
    }

    for (const o of origins) walk([o], [], 0);

    // Best first, but don't let one hub dominate the list.
    const sorted = [...best.values()].sort((x, y) => x.score - y.score);
    const uses = new Map();
    const picked = [];
    for (const c of sorted) {
        if (c.hubs.some(h => (uses.get(h.iata) || 0) >= 2)) continue;
        c.hubs.forEach(h => uses.set(h.iata, (uses.get(h.iata) || 0) + 1));
        picked.push(c);
        if (picked.length >= 12) break;
    }
    return picked;
}

// Geometry-only fallback (1 stop) when the route data has no split for this
// pair — clearly labelled as unconfirmed.
function estimatedSplits(a, b) {
    const direct = haversine(a, b);
    const out = [];
    for (const c of AIRPORTS) {
        if (c.iata === a.iata || c.iata === b.iata) continue;
        if (c.type !== "large_airport" || !c.sched) continue;
        const { cross, frac } = crossTrack(a, b, c);
        if (frac <= 0.08 || frac >= 0.92) continue;
        const dist = haversine(a, c) + haversine(c, b);
        const detour = dist - direct;
        if (cross > Math.max(400, direct * 0.18) || detour / direct > 0.45) continue;
        out.push({
            path: [a, c, b], hubs: [c], edges: [findEdge(a.iata, c.iata), findEdge(c.iata, b.iata)],
            o: a, d: b, dist, ratio: dist / direct, budgetLegs: 0, airlineChanges: 0,
            estimate: true, score: cross * 0.5 + detour
        });
    }
    out.sort((x, y) => x.score - y.score);
    const picked = [];
    for (const c of out) {
        if (picked.some(p => haversine(p.hubs[0], c.hubs[0]) < 300)) continue;
        picked.push(c);
        if (picked.length >= 5) break;
    }
    return picked;
}

// ---- Search links -------------------------------------------------
// Google Flights has no public API, so we link out with the search prefilled.
function googleUrl(from, to, date) {
    return "https://www.google.com/travel/flights?q=" +
        encodeURIComponent(`Flights from ${from} to ${to} on ${date} one way`);
}
function skyscannerUrl(from, to, date) {
    const yymmdd = date.slice(2).replace(/-/g, "");
    return `https://www.skyscanner.net/transport/flights/${from.toLowerCase()}/${to.toLowerCase()}/${yymmdd}/?adultsv2=1&rtn=0`;
}
// Google Flights multi-city link. Google encodes the search in a `tfs`
// parameter: a base64url protobuf. Fields (as used by Google's own URLs):
//   Info:   3 = flight legs (repeated), 8 = passengers (1 = adult),
//           9 = cabin (1 = economy), 19 = trip type (2 = one way, 3 = multi-city)
//   Leg:    2 = date "YYYY-MM-DD", 13 = from airport, 14 = to airport
//   Airport: 1 = kind (1 = airport code), 2 = IATA code
function pbVarint(n) {
    const out = [];
    while (n > 0x7f) { out.push((n & 0x7f) | 0x80); n >>>= 7; }
    out.push(n);
    return out;
}
const pbInt = (field, n) => [...pbVarint(field << 3), ...pbVarint(n)];
const pbBytes = (field, bytes) => [...pbVarint((field << 3) | 2), ...pbVarint(bytes.length), ...bytes];
const pbStr = (field, str) => pbBytes(field, [...new TextEncoder().encode(str)]);

function googleMultiCityUrl(legs) {   // legs: [{ from, to, date }] with IATA codes
    const airport = code => [...pbInt(1, 1), ...pbStr(2, code)];
    const info = [
        ...legs.flatMap(l => pbBytes(3, [...pbStr(2, l.date), ...pbBytes(13, airport(l.from)), ...pbBytes(14, airport(l.to))])),
        ...pbInt(8, 1),
        ...pbInt(9, 1),
        ...pbInt(19, legs.length > 1 ? 3 : 2),
    ];
    const b64 = btoa(String.fromCharCode(...info)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return `https://www.google.com/travel/flights/search?tfs=${b64}&hl=en-GB&curr=GBP`;
}

function searchLinks(from, to, date) {
    return `
        <a class="link-btn" href="${googleUrl(from, to, date)}" target="_blank" rel="noopener">Google ↗</a>
        <a class="link-btn" href="${skyscannerUrl(from, to, date)}" target="_blank" rel="noopener">Skyscanner ↗</a>
    `;
}

// ---- Prices the user types in -------------------------------------------------
// Keyed by "FROM-TO-DATE" so the same leg shares a price across cards.
const prices = new Map();      // key → number used in totals (typed or auto)
const typedKeys = new Set();    // keys the user typed themselves; auto prices never overwrite these
const autoFares = new Map();    // key → fare from /api/prices, or null if none found
const priceKey = (from, to, date) => `${from}-${to}-${date}`;

function priceBox(key) {
    const v = prices.has(key) ? prices.get(key) : "";
    const auto = autoFares.get(key) && !typedKeys.has(key) ? " auto" : "";
    return `<label class="price-input${auto}"><span>${CURRENCY}</span><input type="number" min="0" step="1" inputmode="decimal" placeholder="price" data-price-key="${esc(key)}" value="${v}"></label>`;
}
// A line under each price box saying where an auto price came from.
const fareNote = key => `<div class="fare-note" data-note-key="${esc(key)}">${fareNoteHtml(key)}</div>`;

// ---- Automatic prices (/api/prices) -------------------------------------------------
// Point the app at an API on another host with: <script>window.PRICE_API_URL = "https://…/api/prices"</script>
const PRICE_API = window.PRICE_API_URL || "api/prices";
let liveState = "unknown";      // "unknown" | "off" (no backend / no token) | "on" | "error"
let searchSeq = 0;              // ignores responses from a search the user has since replaced
const MANUAL_NOTE = `No prices yet, so "cheapest" is a best guess (budget airlines, airline changes, big hubs). Add leg prices to rank by real totals.`;

function fareNoteHtml(key) {
    if (!autoFares.has(key) || typedKeys.has(key)) return "";
    const f = autoFares.get(key);
    if (!f) return `<span class="muted">No recent fare seen for this leg — check the links.</span>`;
    const bits = [];
    if (!f.exactDate) bits.push(`<span class="approx">nearest fare is ${prettyDate(f.date)}</span>`);
    if (f.airline) bits.push(esc(AIRLINE_NAMES[f.airline] || f.airline));
    if (f.transfers != null) bits.push(f.transfers === 0 ? "nonstop" : `${f.transfers} change${f.transfers > 1 ? "s" : ""}`);
    const link = f.link ? ` · <a href="${esc(f.link)}" target="_blank" rel="noopener">Book on Aviasales ↗</a>` : "";
    return `Recent fare${bits.length ? " · " + bits.join(" · ") : ""}${link}`;
}

function applyAutoFare(key) {
    const f = autoFares.get(key);
    if (typedKeys.has(key)) return;
    if (f) prices.set(key, f.price); else prices.delete(key);
    resultsPanel.querySelectorAll(`[data-price-key="${CSS.escape(key)}"]`).forEach(inp => {
        inp.value = f ? f.price : "";
        inp.closest(".price-input").classList.toggle("auto", !!f);
    });
    resultsPanel.querySelectorAll(`[data-note-key="${CSS.escape(key)}"]`).forEach(el => { el.innerHTML = fareNoteHtml(key); });
}

function setLiveStatus(html) {
    const el = resultsPanel.querySelector(".live-status");
    if (el) el.innerHTML = html;
}

async function fetchFares(seq) {
    if (liveState === "off") return;
    const allKeys = [...new Set([...resultsPanel.querySelectorAll("[data-price-key]")].map(i => i.dataset.priceKey))];
    const keys = allKeys.filter(k => !autoFares.has(k));
    const doneMsg = () => {
        const found = allKeys.filter(k => autoFares.get(k)).length;
        setLiveStatus(`Prices filled in for ${found} of ${allKeys.length} flights from fares seen in the last few days. ` +
            `They're a guide, not a quote: confirm before booking.`);
    };
    if (!keys.length) { if (liveState === "on") doneMsg(); return; }
    setLiveStatus(`<span class="spinner"></span>Looking up prices for ${keys.length} flight${keys.length > 1 ? "s" : ""}…`);
    const legs = keys.map(k => ({ from: k.slice(0, 3), to: k.slice(4, 7), date: k.slice(8) }));
    let body;
    try {
        const r = await fetch(PRICE_API, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ legs }),
        });
        body = r.headers.get("content-type")?.includes("json") ? await r.json() : null;
        if (!body) throw Object.assign(new Error("no API"), { off: true });   // e.g. static hosting, 404 page
        if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
    } catch (e) {
        if (seq !== searchSeq) return;
        if (e.off || e instanceof TypeError) {
            liveState = "off";
            setLiveStatus(MANUAL_NOTE);
        } else {
            liveState = "error";
            setLiveStatus(`Couldn't load prices (${esc(e.message)}). ${MANUAL_NOTE}`);
        }
        return;
    }
    if (body.configured === false) { liveState = "off"; if (seq === searchSeq) setLiveStatus(MANUAL_NOTE); return; }
    liveState = "on";
    for (const r of body.results || []) autoFares.set(priceKey(r.from, r.to, r.date), r.fare || null);
    if (seq !== searchSeq) return;   // fares are cached above; the user has moved on

    keys.forEach(applyAutoFare);
    doneMsg();
    updateTotals();
    applySort();
}

const money = n => CURRENCY + Math.round(n).toLocaleString("en-GB");

function updateTotals() {
    const beatEl = resultsPanel.querySelector("[data-beat-key]");
    const beat = beatEl ? prices.get(beatEl.dataset.beatKey) : undefined;
    let cheapest = null;

    resultsPanel.querySelectorAll(".option").forEach(card => {
        const keys = card.dataset.keys.split("|");
        const vals = keys.map(k => prices.get(k));
        const el = card.querySelector(".total");
        const n = keys.length;
        const word = n === 2 ? "Two" : n === 3 ? "Three" : n === 4 ? "Four" : String(n);
        const nc = +card.dataset.countries || 0;
        const extra = nc ? ` · <span class="countries">+${nc} countr${nc > 1 ? "ies" : "y"}</span>` : "";
        if (vals.some(v => v === undefined)) {
            const missing = vals.filter(v => v === undefined).length;
            el.innerHTML = (missing === n ? `Add all ${n} ticket prices to see the total.`
                : `${missing} of ${n} prices missing — type ${missing > 1 ? "them" : "it"} in to see the total.`) + extra;
            card._total = null;
            return;
        }
        const total = vals.reduce((x, y) => x + y, 0);
        card._total = total;
        const lead = `${word} tickets: <strong>${money(total)}</strong>`;
        if (beat === undefined) {
            el.innerHTML = `${lead} · add the one-ticket price above to compare${extra}`;
        } else if (total < beat) {
            el.innerHTML = `${lead} · <span class="save">${money(beat - total)} cheaper</span> than one ticket${extra}`;
        } else if (total > beat) {
            el.innerHTML = `${lead} · <span class="lose">${money(total - beat)} dearer</span> than one ticket${extra}`;
        } else {
            el.innerHTML = `${lead} · same as one ticket${extra}`;
        }
        if (cheapest === null || total < cheapest._total) cheapest = card;
    });

    resultsPanel.querySelectorAll(".tag.cheapest").forEach(t => t.remove());
    if (cheapest) {
        cheapest.querySelector(".tags").insertAdjacentHTML("afterbegin", `<span class="tag good cheapest">Cheapest split</span>`);
    }
}

// ---- Ranking: cheapest ←→ most countries -------------------------------------------------
// rankWeight 0 = cheapest total first, 100 = most new countries first, in between blends the two:
//   score = (1 − w) · price + w · (1 − countries), both scaled 0–1 across the current results.
// With no prices yet, "price" falls back to the best-guess order from the route data.
let rankWeight = 0;
try { rankWeight = Math.min(100, Math.max(0, +localStorage.getItem("rankWeight") || 0)); } catch { /* storage blocked */ }

const rankLabel = w => w <= 10 ? "Cheapest first" : w >= 90 ? "Most countries first" : w < 40 ? "Mostly cheapest" : w > 60 ? "Mostly countries" : "Balanced";

function applySort() {
    const list = resultsPanel.querySelector(".option-list");
    if (!list) return;
    const label = resultsPanel.querySelector(".rank-value");
    if (label) label.textContent = rankLabel(rankWeight);

    const cards = [...list.querySelectorAll(".option")];
    const totals = cards.map(c => c._total).filter(t => t != null);
    const lo = Math.min(...totals), hi = Math.max(...totals);
    const maxCountries = Math.max(0, ...cards.map(c => +c.dataset.countries || 0));
    const w = rankWeight / 100;
    const priceScore = c => {
        if (!totals.length) return cards.length > 1 ? +c.dataset.idx / (cards.length - 1) : 0;
        if (c._total == null) return 1.5;                 // unpriced after priced ones
        return hi > lo ? (c._total - lo) / (hi - lo) : 0;
    };
    const countryScore = c => maxCountries ? 1 - (+c.dataset.countries || 0) / maxCountries : 0;
    const score = new Map(cards.map(c => [c, (1 - w) * priceScore(c) + w * countryScore(c)]));
    // Ties (e.g. same number of countries) go to the cheaper route, then the best guess.
    cards.sort((x, y) => (score.get(x) - score.get(y)) || (priceScore(x) - priceScore(y)) || (+x.dataset.idx - +y.dataset.idx));
    cards.forEach(c => list.appendChild(c));
}

resultsPanel.addEventListener("input", (e) => {
    if (!e.target.classList.contains("rank-slider")) return;
    rankWeight = +e.target.value;
    try { localStorage.setItem("rankWeight", String(rankWeight)); } catch { /* storage blocked */ }
    applySort();
});

// Re-sort once a price is committed (blur / Enter), not on every keystroke,
// so the card you're typing in doesn't jump around.
resultsPanel.addEventListener("change", (e) => {
    const key = e.target.dataset && e.target.dataset.priceKey;
    if (!key) return;
    if (e.target.value === "" && autoFares.get(key)) {   // cleared → go back to the looked-up price
        typedKeys.delete(key);
        applyAutoFare(key);
        updateTotals();
    }
    applySort();
});

resultsPanel.addEventListener("input", (e) => {
    const key = e.target.dataset && e.target.dataset.priceKey;
    if (!key) return;
    const n = parseFloat(e.target.value);
    if (Number.isFinite(n) && n >= 0) prices.set(key, n); else prices.delete(key);
    typedKeys.add(key);
    // keep any other box for the same leg in sync
    resultsPanel.querySelectorAll(`[data-price-key="${CSS.escape(key)}"]`).forEach(inp => {
        if (inp !== e.target) inp.value = e.target.value;
        inp.closest(".price-input").classList.remove("auto");
    });
    resultsPanel.querySelectorAll(`[data-note-key="${CSS.escape(key)}"]`).forEach(el => { el.innerHTML = ""; });
    updateTotals();
});

// ---- Results rendering -------------------------------------------------
function renderResults(a, b) {
    const date1 = dateInput.value || addDays(isoDate(new Date()), 30);
    const nights = parseInt(nightsInput.value, 10) || 0;
    const stops = parseInt(stopsInput.value, 10) || 1;

    const origins = nearbyAirports(a);
    const dests = nearbyAirports(b);
    let splits = findSplits(a, b, origins, dests, stops);
    const usingEstimate = splits.length === 0 && stops === 1;
    if (usingEstimate) splits = estimatedSplits(a, b);

    const direct = haversine(a, b);
    const nonstop = findEdge(a.iata, b.iata);
    const beatKey = priceKey(a.iata, b.iata, date1);
    const tickets = stops + 1;

    let html = `
        <div class="result-header">
            <div class="result-route">${esc(a.iata)} <span class="arrow">→</span> ${esc(b.iata)}</div>
            <div class="result-sub">${placeLabel(a)} to ${placeLabel(b)} · ${Math.round(direct).toLocaleString()} km · ${prettyDate(date1)}</div>
        </div>

        <div class="options-label">1 · Price to beat <span class="sub">— one ticket all the way</span></div>
        <div class="beat" data-beat-key="${esc(beatKey)}">
            <div class="beat-title">${esc(a.iata)} → ${esc(b.iata)}, one ticket</div>
            <div class="beat-sub">${nonstop
                ? `Nonstop listed in the route data (${esc(airlineLabel(nonstop.airlines))}) · ~${flightTimeStr(direct)}. Airlines may have changed since.`
                : `No nonstop in the route data, so the cheapest one-ticket option will have a connection.`}
                ${liveState === "off" || liveState === "error" ? "Find the cheapest fare and type it in." : ""}</div>
            <div class="price-row">${priceBox(beatKey)}${searchLinks(a.iata, b.iata, date1)}</div>
            ${fareNote(beatKey)}
        </div>
    `;

    if (splits.length) {
        html += `<div class="options-label">2 · ${stops}-stop splits <span class="sub">— ${usingEstimate
            ? "no confirmed split in the route data; these are hubs on the way, check both legs exist"
            : `${tickets} separate tickets`}</span></div>
            <div class="rank-bar">
                <div class="rank-head"><span>Rank by</span><strong class="rank-value">${rankLabel(rankWeight)}</strong></div>
                <input class="rank-slider" type="range" min="0" max="100" step="5" value="${rankWeight}"
                    aria-label="Rank routes from cheapest (left) to most new countries (right)">
                <div class="rank-ends"><span>💷 Cheapest</span><span>Most countries 🌍</span></div>
            </div>
            <p class="sort-note live-status">${liveState === "off" || liveState === "error" ? MANUAL_NOTE : ""}</p>
            <div class="option-list">`;

        splits.forEach((s, i) => {
            const legs = s.path.slice(0, -1).map((from, j) => {
                const to = s.path[j + 1];
                const date = addDays(date1, j * nights);
                return { from, to, edge: s.edges[j], date, key: priceKey(from.iata, to.iata, date) };
            });
            const extraPct = Math.round((s.ratio - 1) * 100);
            // New countries this route adds on top of where you start and end.
            const homeCountries = new Set([a.country, b.country, s.o.country, s.d.country]);
            const newCountries = [...new Set(s.hubs.map(h => h.country).filter(c => c && !homeCountries.has(c)))];
            const tags = [];
            if (newCountries.length) tags.push(`<span class="tag country">${newCountries.map(c => flag(c, countryName(c))).join("")} +${newCountries.length} countr${newCountries.length > 1 ? "ies" : "y"}</span>`);
            if (s.estimate) tags.push(`<span class="tag warn">Unconfirmed</span>`);
            if (s.budgetLegs > 0) tags.push(`<span class="tag good">Budget airline${s.budgetLegs > 1 ? `s on ${s.budgetLegs} legs` : ""}</span>`);
            if (s.airlineChanges > 0) tags.push(`<span class="tag">${s.airlineChanges === stops ? "Different airlines" : "Airline change"}</span>`);
            if (s.o !== a) tags.push(`<span class="tag">From ${esc(s.o.iata)}</span>`);
            if (s.d !== b) tags.push(`<span class="tag">To ${esc(s.d.iata)}</span>`);
            if (nights > 0) {
                const n = `${nights} night${nights > 1 ? "s" : ""}`;
                tags.push(`<span class="tag">${stops === 1 ? `${n} in ${esc(placeName(s.hubs[0]))}` : `${n} at each stop`}</span>`);
            }

            const legHtml = l => `
                <div class="leg">
                    <div class="leg-head">
                        <span class="leg-route">${esc(l.from.iata)} → ${esc(l.to.iata)}</span>
                        <span class="leg-date">${prettyDate(l.date)} · ~${flightTimeStr(haversine(l.from, l.to))}</span>
                    </div>
                    <div class="leg-air">${l.edge ? esc(airlineLabel(l.edge.airlines)) : "Not in route data — check it exists"}</div>
                    <div class="price-row">${priceBox(l.key)}${searchLinks(l.from.iata, l.to.iata, l.date)}</div>
                    ${fareNote(l.key)}
                </div>`;

            const title = stops === 1
                ? `via ${esc(s.hubs[0].iata)} — ${placeLabel(s.hubs[0])}`
                : `via ${s.hubs.map(h => esc(h.iata)).join(" → ")}`;
            const subtitle = stops === 1 ? "" :
                `<div class="option-places">${s.hubs.map(placeLabel).join(" → ")}</div>`;

            html += `
                <div class="option${i === 0 ? " selected" : ""}" data-idx="${i}" data-countries="${newCountries.length}" data-keys="${esc(legs.map(l => l.key).join("|"))}">
                    <div class="option-top">
                        <span class="option-title">${title}</span>
                        <span class="option-dist">${extraPct <= 0 ? "no detour" : `+${extraPct}% distance`}</span>
                    </div>
                    ${subtitle}
                    <div class="tags">${tags.join("")}</div>
                    ${legs.map(legHtml).join("")}
                    <div class="total"></div>
                    <a class="multi-link" target="_blank" rel="noopener" href="${esc(googleMultiCityUrl(legs.map(l => ({ from: l.from.iata, to: l.to.iata, date: l.date }))))}">
                        Search the whole route on Google Flights (multi-city) ↗</a>
                </div>
            `;
        });

        html += `</div>`;
        html += `
            <div class="warning">
                <strong>Separate tickets = you're on your own at ${stops === 1 ? "the" : "every"} ${nights > 0 ? "stopover" : "connection"}.</strong>
                If one flight is late and you miss the next, that airline owes you nothing. ${nights > 0
                    ? "A night or more in between makes this low-risk."
                    : "Leave at least 3 hours each time, and more if you need to collect and re-check bags."}
                Check each ticket's baggage allowance, as budget fares often exclude hold bags.
            </div>
        `;
    } else if (stops > 1) {
        html += `<p class="hint">No ${stops}-stop split found in the route data within a sensible detour. Try fewer stops.</p>`;
    } else {
        html += `<p class="hint">No split found for this pair, even as an estimate. The airports may be too close together, or not covered by the route data.</p>`;
    }

    resultsPanel.innerHTML = html;
    resultsPanel.classList.add("open");

    function drawSplit(i) {
        clearRoute();
        const s = splits[i];
        if (!s) {
            markPoint(a, "From");
            markPoint(b, "To");
            fitTo(drawLeg(a, b));
            return;
        }
        const pts = [];
        for (let j = 0; j < s.path.length - 1; j++) pts.push(...drawLeg(s.path[j], s.path[j + 1]));
        markPoint(s.o, "From");
        markPoint(s.d, "To");
        s.hubs.forEach((h, j) => markPoint(h, s.hubs.length > 1 ? `Stop ${j + 1}` : "Stopover", "hub"));
        fitTo(pts);
    }

    resultsPanel.querySelectorAll(".option").forEach(el => {
        el.addEventListener("click", (e) => {
            if (e.target.closest("a, input, label")) return; // don't refit the map while typing a price
            if (el.classList.contains("selected")) return;
            resultsPanel.querySelectorAll(".option").forEach(o => o.classList.remove("selected"));
            el.classList.add("selected");
            drawSplit(+el.dataset.idx);
        });
    });

    drawSplit(0);
    updateTotals();
    applySort();
    fetchFares(++searchSeq);
}

// ---- Search button -------------------------------------------------
function showMessage(msg) {
    resultsPanel.innerHTML = `<p class="hint" style="margin-top:0;">${esc(msg)}</p>`;
    resultsPanel.classList.add("open");
}

function runSearch() {
    if (!fromAirport) {
        const guess = search(fromInput.value)[0];
        if (guess) setField("from", guess.iata);
    }
    if (!toAirport) {
        const guess = search(toInput.value)[0];
        if (guess) setField("to", guess.iata);
    }
    if (!fromAirport || !toAirport) {
        showMessage('Pick a "From" and "To" airport first — start typing a city or airport code.');
        return;
    }
    if (fromAirport.iata === toAirport.iata) {
        showMessage("From and To are the same airport.");
        return;
    }
    renderResults(fromAirport, toAirport);
}

searchBtn.addEventListener("click", runSearch);
dateInput.addEventListener("change", () => { if (fromAirport && toAirport && resultsPanel.classList.contains("open")) runSearch(); });
nightsInput.addEventListener("change", () => { if (fromAirport && toAirport && resultsPanel.classList.contains("open")) runSearch(); });
nearbyInput.addEventListener("change", () => { if (fromAirport && toAirport && resultsPanel.classList.contains("open")) runSearch(); });
stopsInput.addEventListener("change", () => { if (fromAirport && toAirport && resultsPanel.classList.contains("open")) runSearch(); });

// ---- Initial demo: London → Bangkok -------------------------------------------------
setField("from", "LHR");
setField("to", "BKK");
renderResults(fromAirport, toAirport);

statusHint.textContent = `${AIRPORTS.length.toLocaleString()} airports · route data is a 2014 OpenFlights snapshot, so always check the live search links.`;
