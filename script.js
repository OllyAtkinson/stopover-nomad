// =========================================================
// Stopover Nomad — fit stopovers into a trip
//
// Idea: you have N days to get from A to B. Flying via one, two or three
// stopovers on separate tickets is often cheaper than one direct ticket, and
// you get to visit more places on the way. This finds stopover routes in the
// route data, fits the stays into your time budget, and ranks every option
// (direct included) from cheapest to most new countries.
//
// Prices: if the /api/prices backend is deployed with a Travelpayouts token,
// fares for every flight across the possible dates are looked up and the
// cheapest dates that fit the budget are picked. Without it, users type
// prices in from the prefilled search links.
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
const placeLabel = a => {
    const city = placeName(a), country = countryName(a.country);
    const text = !country || country === city ? city : `${city}, ${country}`;   // "Singapore", not "Singapore, Singapore"
    return esc(text) + (flag(a.country) ? " " + flag(a.country, country) : "");
};

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
const daysInput = document.getElementById("days-input");
const minStayInput = document.getElementById("minstay-input");
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

// ---- Prices -------------------------------------------------
// Keyed by "FROM-TO-DATE" so the same flight shares a price across cards.
const prices = new Map();       // key → number used in totals (typed or looked up)
const typedKeys = new Set();    // keys the user typed themselves; looked-up prices never overwrite these
const priceKey = (from, to, date) => `${from}-${to}-${date}`;
const parseKey = k => ({ from: k.slice(0, 3), to: k.slice(4, 7), date: k.slice(8) });

// Looked-up fares, per route pair and day:
//   dayFares["LHR-AUH"] = Map("2026-12-14" → fare | null)   (null = looked up, nothing seen)
const dayFares = new Map();
function fareOn(from, to, date) {         // fare | null (none seen) | undefined (not looked up)
    const m = dayFares.get(`${from}-${to}`);
    return m ? m.get(date) : undefined;
}

function dayDiff(a, b) {   // whole days from b to a
    const [y1, m1, d1] = a.split("-").map(Number), [y2, m2, d2] = b.split("-").map(Number);
    return Math.round((Date.UTC(y1, m1 - 1, d1) - Date.UTC(y2, m2 - 1, d2)) / 86400000);
}
const datesBetween = (start, end) => {
    const out = [];
    for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
    return out;
};

function priceBox(key) {
    const v = prices.has(key) ? prices.get(key) : "";
    const auto = !typedKeys.has(key) && fareOn(...Object.values(parseKey(key))) ? " auto" : "";
    return `<label class="price-input${auto}"><span>${CURRENCY}</span><input type="number" min="0" step="1" inputmode="decimal" placeholder="price" data-price-key="${esc(key)}" value="${v}"></label>`;
}

// The line under each price box saying where a looked-up price came from.
function fareNoteHtml(key, approx) {
    if (typedKeys.has(key)) return "";
    const { from, to, date } = parseKey(key);
    const f = fareOn(from, to, date);
    if (f === undefined) return "";
    if (f === null) return `<span class="muted">No recent fare seen for this flight — check the links.</span>`;
    const bits = [];
    if (approx) bits.push(`<span class="approx">nearest fare to your date</span>`);
    if (f.airline) bits.push(esc(AIRLINE_NAMES[f.airline] || f.airline));
    if (f.transfers != null) bits.push(f.transfers === 0 ? "nonstop" : `${f.transfers} change${f.transfers > 1 ? "s" : ""}`);
    const link = f.link ? ` · <a href="${esc(f.link)}" target="_blank" rel="noopener">Book on Aviasales ↗</a>` : "";
    return `Recent fare${bits.length ? " · " + bits.join(" · ") : ""}${link}`;
}

// Put the looked-up price for a key into the totals (unless the user typed one).
function syncAutoPrice(key) {
    if (typedKeys.has(key)) return;
    const f = fareOn(...Object.values(parseKey(key)));
    if (f) prices.set(key, f.price);
    else if (f === null) prices.delete(key);
}

// ---- Fitting a route into the time budget -------------------------------------------------
// ctx: { depart, days, minStay }. A route with s stops has s + 1 flights; flight j leaves on
// date d_j with d_0 = depart, d_j ≥ d_(j-1) + minStay, and the last flight leaves by depart + days.
const SHIFT_DAYS = 3;   // if nothing is seen on the departure day, look this many days either side

function feasible(stops, ctx) { return stops * ctx.minStay <= ctx.days; }

// Without prices: a sensible stay at each stop — the budget shared evenly, but no more than
// DEFAULT_STAY nights unless the minimum stay asks for more.
const DEFAULT_STAY = 3;
function defaultDates(nLegs, ctx) {
    const s = nLegs - 1;
    const stay = s ? Math.max(ctx.minStay, Math.min(Math.floor(ctx.days / s), Math.max(ctx.minStay, DEFAULT_STAY))) : 0;
    return Array.from({ length: nLegs }, (_, j) => addDays(ctx.depart, j * stay));
}

// With prices: cheapest set of dates that fits the budget (dynamic programming over days).
// The budget runs from the first flight's day, so each possible first day is tried on its own.
function cheapestDates(legs, ctx, firstDays) {
    let best = null;
    for (const d0 of firstDays) {
        const r = cheapestDatesFrom(legs, ctx, d0);
        if (r && (!best || r.cost < best.cost)) best = r;
    }
    return best && best.dates;
}

function cheapestDatesFrom(legs, ctx, d0) {
    const s = legs.length - 1;
    const last = addDays(d0, ctx.days);
    const f0 = fareOn(legs[0].from.iata, legs[0].to.iata, d0);
    if (!f0) return null;
    let layer = new Map([[d0, { cost: f0.price, prev: null }]]);
    const layers = [layer];
    for (let j = 1; j <= s; j++) {
        const next = new Map();
        const latest = addDays(last, -(s - j) * ctx.minStay);
        for (const [pd, st] of layer) {
            for (let d = addDays(pd, ctx.minStay); d <= latest; d = addDays(d, 1)) {
                const f = fareOn(legs[j].from.iata, legs[j].to.iata, d);
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

// When not every flight has a fare: go flight by flight, taking the cheapest seen day that
// still leaves room for the rest, or the evenly spread date if nothing is seen.
function greedyDates(legs, ctx) {
    const s = legs.length - 1;
    const last = addDays(ctx.depart, ctx.days);
    const fallback = defaultDates(legs.length, ctx);
    const dates = [];
    for (let j = 0; j <= s; j++) {
        const earliest = j === 0 ? ctx.depart : addDays(dates[j - 1], ctx.minStay);
        const latest = j === 0 ? ctx.depart : addDays(last, -(s - j) * ctx.minStay);
        let best = null;
        for (const d of datesBetween(earliest, latest)) {
            const f = fareOn(legs[j].from.iata, legs[j].to.iata, d);
            if (f && (!best || f.price < best.price)) best = { d, price: f.price };
        }
        dates[j] = best ? best.d : (fallback[j] < earliest ? earliest : fallback[j] > latest ? latest : fallback[j]);
    }
    return dates;
}

// Choose dates for a route; sets leg.date / leg.key / leg.approx.
function planRoute(route, ctx) {
    let dates = null, approx = false;
    if (liveState === "on") {
        dates = cheapestDates(route.legs, ctx, [ctx.depart]);
        if (!dates) {   // nothing on the exact day: allow the first flight to move a few days
            const around = datesBetween(addDays(ctx.depart, -SHIFT_DAYS), addDays(ctx.depart, SHIFT_DAYS));
            dates = cheapestDates(route.legs, ctx, around);
            approx = !!dates && dates[0] !== ctx.depart;
        }
        if (!dates) dates = greedyDates(route.legs, ctx);
    } else {
        dates = defaultDates(route.legs.length, ctx);
    }
    route.legs.forEach((l, j) => {
        l.date = dates[j];
        l.key = priceKey(l.from.iata, l.to.iata, l.date);
        l.approx = j === 0 && approx;
        syncAutoPrice(l.key);
    });
}

// Date ranges to look up so every possible plan is covered, merged per route pair.
function windowsFor(routes, ctx) {
    const byPair = new Map();
    const add = (from, to, start, end) => {
        const k = `${from}-${to}`;
        const w = byPair.get(k);
        if (!w) byPair.set(k, { from, to, start, end });
        else { if (start < w.start) w.start = start; if (end > w.end) w.end = end; }
    };
    // The first flight may move up to SHIFT_DAYS either way, and the budget moves with it.
    for (const r of routes) {
        const s = r.legs.length - 1;
        r.legs.forEach((l, j) => {
            const start = addDays(ctx.depart, j * ctx.minStay - SHIFT_DAYS);
            const end = addDays(ctx.depart, SHIFT_DAYS + (j === 0 ? 0 : ctx.days - (s - j) * ctx.minStay));
            add(l.from.iata, l.to.iata, start, end);
        });
    }
    // Only ask for days we haven't looked up already.
    return [...byPair.values()].filter(w => {
        const m = dayFares.get(`${w.from}-${w.to}`);
        return !m || datesBetween(w.start, w.end).some(d => !m.has(d));
    });
}

// ---- Automatic prices (/api/prices) -------------------------------------------------
// Point the app at an API on another host with: <script>window.PRICE_API_URL = "https://…/api/prices"</script>
const PRICE_API = window.PRICE_API_URL || "api/prices";
let liveState = "unknown";      // "unknown" | "off" (no backend / no token) | "on" | "error"
let searchSeq = 0;              // ignores responses from a search the user has since replaced
const MANUAL_NOTE = `No prices yet, so "cheapest" is a best guess (budget airlines, airline changes, big hubs). Add flight prices to rank by real totals.`;
const API_BATCH = 60;

function setLiveStatus(html) {
    const el = resultsPanel.querySelector(".live-status");
    if (el) el.innerHTML = html;
}

async function postWindows(windows) {
    const r = await fetch(PRICE_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ windows }),
    });
    const body = r.headers.get("content-type")?.includes("json") ? await r.json() : null;
    if (!body) throw Object.assign(new Error("no API"), { off: true });   // e.g. static hosting, 404 page
    if (body.configured === false) throw Object.assign(new Error("not configured"), { off: true });
    if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
    return body.results || [];
}

async function fetchFares(seq) {
    if (liveState === "off" || !current) return;
    const windows = windowsFor(current.routes, current.ctx);
    if (windows.length) {
        setLiveStatus(`<span class="spinner"></span>Looking up prices for ${windows.length} flight${windows.length > 1 ? "s" : ""} across your dates…`);
        let results;
        try {
            const batches = [];
            for (let i = 0; i < windows.length; i += API_BATCH) batches.push(windows.slice(i, i + API_BATCH));
            results = (await Promise.all(batches.map(postWindows))).flat();
        } catch (e) {
            if (seq !== searchSeq) return;
            if (e.off || e instanceof TypeError) { liveState = "off"; setLiveStatus(MANUAL_NOTE); }
            else { liveState = "error"; setLiveStatus(`Couldn't load prices (${esc(e.message)}). ${MANUAL_NOTE}`); }
            return;
        }
        liveState = "on";
        for (const w of results) {
            const k = `${w.from}-${w.to}`;
            if (!dayFares.has(k)) dayFares.set(k, new Map());
            const m = dayFares.get(k);
            for (const d of datesBetween(w.start, w.end)) if (!m.has(d) || !w.error) m.set(d, (w.days && w.days[d]) || null);
        }
        if (seq !== searchSeq) return;   // fares are kept above; the user has moved on
    }
    if (liveState !== "on") return;
    current.routes.forEach(r => { planRoute(r, current.ctx); renderRouteBody(r); });
    const priced = current.routes.filter(r => r.legs.every(l => prices.has(l.key))).length;
    setLiveStatus(`Prices found for ${priced} of ${current.routes.length} options, from fares seen in the last few days, ` +
        `with dates picked to be cheapest within your ${current.ctx.days ? `${current.ctx.days} day${current.ctx.days > 1 ? "s" : ""}` : "day"}. ` +
        `They're a guide, not a quote: confirm before booking.`);
    updateTotals();
    applySort();
}

// ---- Totals -------------------------------------------------
const money = n => CURRENCY + Math.round(n).toLocaleString("en-GB");

function updateTotals() {
    const directCard = resultsPanel.querySelector('.option[data-direct="1"]');
    const directKeys = directCard ? directCard.dataset.keys.split("|") : [];
    const beat = directKeys.length && prices.has(directKeys[0]) ? prices.get(directKeys[0]) : undefined;
    let cheapest = null;

    resultsPanel.querySelectorAll(".option").forEach(card => {
        const keys = card.dataset.keys.split("|");
        const vals = keys.map(k => prices.get(k));
        const el = card.querySelector(".total");
        const n = keys.length;
        const nc = +card.dataset.countries || 0;
        const extra = nc ? ` · <span class="countries">+${nc} countr${nc > 1 ? "ies" : "y"}</span>` : "";
        const isDirect = card === directCard;
        if (vals.some(v => v === undefined)) {
            const missing = vals.filter(v => v === undefined).length;
            el.innerHTML = (isDirect ? "Add the one-ticket price to compare against."
                : missing === n ? `Add all ${n} ticket prices to see the total.`
                : `${missing} of ${n} prices missing — type ${missing > 1 ? "them" : "it"} in to see the total.`) + extra;
            card._total = null;
            return;
        }
        const total = vals.reduce((x, y) => x + y, 0);
        card._total = total;
        if (isDirect) {
            el.innerHTML = `One ticket: <strong>${money(total)}</strong> · the price to beat`;
        } else {
            const word = n === 2 ? "Two" : n === 3 ? "Three" : n === 4 ? "Four" : String(n);
            const lead = `${word} tickets: <strong>${money(total)}</strong>`;
            el.innerHTML = beat === undefined ? `${lead}${extra}`
                : total < beat ? `${lead} · <span class="save">${money(beat - total)} cheaper</span> than direct${extra}`
                : total > beat ? `${lead} · <span class="lose">${money(total - beat)} dearer</span> than direct${extra}`
                : `${lead} · same as direct${extra}`;
        }
        if (cheapest === null || total < cheapest._total) cheapest = card;
    });

    resultsPanel.querySelectorAll(".tag.cheapest").forEach(t => t.remove());
    if (cheapest) cheapest.querySelector(".tags").insertAdjacentHTML("afterbegin", `<span class="tag good cheapest">Cheapest</span>`);
}

// ---- Ranking: cheapest ←→ most countries -------------------------------------------------
// rankWeight 0 = cheapest total first, 100 = most new countries first, in between blends the two:
//   score = (1 − w) · price + w · (1 − countries), both scaled 0–1 across the current results.
// The direct flight is ranked too (0 new countries). With no prices yet, "price" falls back
// to the best-guess order from the route data.
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

// Typing a price: it overrides the looked-up one everywhere that flight appears.
resultsPanel.addEventListener("input", (e) => {
    const key = e.target.dataset && e.target.dataset.priceKey;
    if (!key) return;
    const n = parseFloat(e.target.value);
    if (Number.isFinite(n) && n >= 0) prices.set(key, n); else prices.delete(key);
    typedKeys.add(key);
    resultsPanel.querySelectorAll(`[data-price-key="${CSS.escape(key)}"]`).forEach(inp => {
        if (inp !== e.target) inp.value = e.target.value;
        inp.closest(".price-input").classList.remove("auto");
    });
    resultsPanel.querySelectorAll(`[data-note-key="${CSS.escape(key)}"]`).forEach(el => { el.innerHTML = ""; });
    updateTotals();
});

// Re-sort once a price is committed (blur / Enter), not on every keystroke, so the card you're
// typing in doesn't jump around. Clearing a typed price brings back the looked-up one.
resultsPanel.addEventListener("change", (e) => {
    const key = e.target.dataset && e.target.dataset.priceKey;
    if (!key) return;
    if (e.target.value === "" && fareOn(...Object.values(parseKey(key)))) {
        typedKeys.delete(key);
        syncAutoPrice(key);
        resultsPanel.querySelectorAll(`[data-price-key="${CSS.escape(key)}"]`).forEach(inp => {
            inp.value = prices.get(key);
            inp.closest(".price-input").classList.add("auto");
        });
        resultsPanel.querySelectorAll(`[data-note-key="${CSS.escape(key)}"]`).forEach(el => {
            el.innerHTML = fareNoteHtml(key, el.dataset.approx === "1");
        });
        updateTotals();
    }
    applySort();
});

// ---- Results rendering -------------------------------------------------
let current = null;   // { a, b, ctx, routes }

const nightsText = n => n === 0 ? "Same-day connection" : `${n} night${n > 1 ? "s" : ""}`;

function legHtml(l) {
    return `
        <div class="leg">
            <div class="leg-head">
                <span class="leg-route">${esc(l.from.iata)} → ${esc(l.to.iata)}</span>
                <span class="leg-date">${prettyDate(l.date)} · ~${flightTimeStr(haversine(l.from, l.to))}</span>
            </div>
            <div class="leg-air">${l.edge ? esc(airlineLabel(l.edge.airlines)) : l.direct ? "" : "Not in route data — check it exists"}</div>
            <div class="price-row">${priceBox(l.key)}${searchLinks(l.from.iata, l.to.iata, l.date)}</div>
            <div class="fare-note" data-note-key="${esc(l.key)}" data-approx="${l.approx ? 1 : 0}">${fareNoteHtml(l.key, l.approx)}</div>
        </div>`;
}

// Flights, the stays between them, the total and the multi-city link for one route.
function renderRouteBody(route) {
    const card = resultsPanel.querySelector(`.option[data-idx="${route.idx}"]`);
    if (!card) return;
    const parts = [];
    route.legs.forEach((l, j) => {
        if (j > 0) {
            const stay = dayDiff(l.date, route.legs[j - 1].date);
            parts.push(`<div class="stay">${stay ? "🛏️" : "⏱️"} ${nightsText(stay)} in ${placeLabel(l.from)}</div>`);
        }
        parts.push(legHtml(l));
    });
    card.querySelector(".legs").innerHTML = parts.join("");
    card.dataset.keys = route.legs.map(l => l.key).join("|");
    const arrive = route.legs[route.legs.length - 1].date;
    const span = dayDiff(arrive, route.legs[0].date);
    card.querySelector(".trip-span").textContent = route.direct ? "" :
        `Leave ${prettyDate(route.legs[0].date)}, last flight ${prettyDate(arrive)}${span ? ` (${span} day${span > 1 ? "s" : ""})` : " (same day)"}`;
    const multi = card.querySelector(".multi-link");
    if (multi) multi.href = googleMultiCityUrl(route.legs.map(l => ({ from: l.from.iata, to: l.to.iata, date: l.date })));
}

// All routes for this search: the direct flight plus splits with 1 … maxStops stops.
function buildRoutes(a, b, ctx, maxStops) {
    const origins = nearbyAirports(a);
    const dests = nearbyAirports(b);
    const routes = [{
        direct: true, path: [a, b], hubs: [], o: a, d: b, ratio: 1,
        legs: [{ from: a, to: b, edge: findEdge(a.iata, b.iata), direct: true }],
    }];
    const skipped = [];
    let estimated = false;
    for (let stops = 1; stops <= maxStops; stops++) {
        if (!feasible(stops, ctx)) { skipped.push(stops); continue; }
        let splits = findSplits(a, b, origins, dests, stops).slice(0, stops === 1 ? 12 : 8);
        if (!splits.length && stops === 1) { splits = estimatedSplits(a, b); estimated = splits.length > 0; }
        for (const s of splits) {
            routes.push({ ...s, legs: s.path.slice(0, -1).map((from, j) => ({ from, to: s.path[j + 1], edge: s.edges[j] })) });
        }
    }
    routes.forEach((r, i) => {
        r.idx = i;
        const home = new Set([a.country, b.country, r.o.country, r.d.country]);
        r.countries = [...new Set(r.hubs.map(h => h.country).filter(c => c && !home.has(c)))];
    });
    return { routes, skipped, estimated };
}

function routeCardHtml(route, a, b, ctx) {
    const tags = [];
    let title, subtitle = "", right = "";
    if (route.direct) {
        const nonstop = route.legs[0].edge;
        title = `Direct — one ticket`;
        subtitle = `<div class="option-places">${nonstop
            ? `Nonstop listed in the route data · ~${flightTimeStr(haversine(a, b))}`
            : `No nonstop in the route data, so this will usually have a connection`}</div>`;
        tags.push(`<span class="tag">The price to beat</span>`);
    } else {
        const s = route;
        const stops = s.hubs.length;
        title = stops === 1 ? `via ${esc(s.hubs[0].iata)} — ${placeLabel(s.hubs[0])}` : `via ${s.hubs.map(h => esc(h.iata)).join(" → ")}`;
        if (stops > 1) subtitle = `<div class="option-places">${s.hubs.map(placeLabel).join(" → ")}</div>`;
        const extraPct = Math.round((s.ratio - 1) * 100);
        right = extraPct <= 0 ? "no detour" : `+${extraPct}% distance`;
        if (route.countries.length) tags.push(`<span class="tag country">${route.countries.map(c => flag(c, countryName(c))).join("")} +${route.countries.length} countr${route.countries.length > 1 ? "ies" : "y"}</span>`);
        tags.push(`<span class="tag">${stops} stop${stops > 1 ? "s" : ""}</span>`);
        if (s.estimate) tags.push(`<span class="tag warn">Unconfirmed</span>`);
        if (s.budgetLegs > 0) tags.push(`<span class="tag good">Budget airline${s.budgetLegs > 1 ? `s on ${s.budgetLegs} flights` : ""}</span>`);
        if (s.airlineChanges > 0) tags.push(`<span class="tag">${s.airlineChanges === stops ? "Different airlines" : "Airline change"}</span>`);
        if (s.o !== a) tags.push(`<span class="tag">From ${esc(s.o.iata)}</span>`);
        if (s.d !== b) tags.push(`<span class="tag">To ${esc(s.d.iata)}</span>`);
    }
    return `
        <div class="option${route.direct ? " direct" : ""}" data-idx="${route.idx}" data-direct="${route.direct ? 1 : 0}" data-countries="${route.countries.length}" data-keys="">
            <div class="option-top">
                <span class="option-title">${title}</span>
                <span class="option-dist">${right}</span>
            </div>
            ${subtitle}
            <div class="tags">${tags.join("")}</div>
            <div class="trip-span"></div>
            <div class="legs"></div>
            <div class="total"></div>
            ${route.direct ? "" : `<a class="multi-link" target="_blank" rel="noopener" href="#">Search the whole route on Google Flights (multi-city) ↗</a>`}
        </div>`;
}

function renderResults(a, b) {
    const ctx = {
        depart: dateInput.value || addDays(isoDate(new Date()), 30),
        days: parseInt(daysInput.value, 10) || 0,
        minStay: parseInt(minStayInput.value, 10) || 0,
    };
    const maxStops = parseInt(stopsInput.value, 10) || 1;
    const { routes, skipped, estimated } = buildRoutes(a, b, ctx, maxStops);
    current = { a, b, ctx, routes };
    routes.forEach(r => planRoute(r, ctx));

    const direct = haversine(a, b);
    const budget = ctx.days === 0 ? "same day" : `within ${ctx.days} day${ctx.days > 1 ? "s" : ""}`;
    const notes = [];
    if (skipped.length) {
        notes.push(`${skipped.map(n => `${n}-stop`).join(" and ")} routes don't fit: ${skipped[0]} stop${skipped[0] > 1 ? "s" : ""} × ${nightsText(ctx.minStay).toLowerCase()} needs more than ${ctx.days} day${ctx.days === 1 ? "" : "s"}. Allow more time or shorter stays.`);
    }
    if (estimated) notes.push(`No confirmed 1-stop route in the route data; the "Unconfirmed" ones are hubs on the way, so check each flight exists.`);

    let html = `
        <div class="result-header">
            <div class="result-route">${esc(a.iata)} <span class="arrow">→</span> ${esc(b.iata)}</div>
            <div class="result-sub">${placeLabel(a)} to ${placeLabel(b)} · ${Math.round(direct).toLocaleString()} km · leave ${prettyDate(ctx.depart)}, arrive ${budget}</div>
        </div>
        <div class="rank-bar">
            <div class="rank-head"><span>Rank by</span><strong class="rank-value">${rankLabel(rankWeight)}</strong></div>
            <input class="rank-slider" type="range" min="0" max="100" step="5" value="${rankWeight}"
                aria-label="Rank routes from cheapest (left) to most new countries (right)">
            <div class="rank-ends"><span>💷 Cheapest</span><span>Most countries 🌍</span></div>
        </div>
        <p class="sort-note live-status">${liveState === "off" || liveState === "error" ? MANUAL_NOTE : ""}</p>
        ${notes.map(n => `<p class="hint">${esc(n)}</p>`).join("")}
        <div class="option-list">${routes.map(r => routeCardHtml(r, a, b, ctx)).join("")}</div>
    `;
    if (routes.length === 1) {
        html += `<p class="hint">No stopover routes found within a sensible detour. Try allowing more stops or more time.</p>`;
    } else {
        html += `
            <div class="warning">
                <strong>Separate tickets = you're on your own at each stop.</strong>
                If one flight is late and you miss the next, that airline owes you nothing. ${ctx.minStay > 0
                    ? "A night or more at each stop makes this low-risk."
                    : "For same-day connections leave at least 3 hours, more if you need to collect and re-check bags."}
                Check each ticket's baggage allowance, as budget fares often exclude hold bags, and check visa rules for each stop.
            </div>`;
    }

    resultsPanel.innerHTML = html;
    resultsPanel.classList.add("open");
    routes.forEach(renderRouteBody);

    function drawRoute(i) {
        clearRoute();
        const r = routes[i];
        const pts = [];
        for (let j = 0; j < r.path.length - 1; j++) pts.push(...drawLeg(r.path[j], r.path[j + 1]));
        markPoint(r.o, "From");
        markPoint(r.d, "To");
        r.hubs.forEach((h, j) => markPoint(h, r.hubs.length > 1 ? `Stop ${j + 1}` : "Stopover", "hub"));
        fitTo(pts);
    }

    resultsPanel.querySelectorAll(".option").forEach(el => {
        el.addEventListener("click", (e) => {
            if (e.target.closest("a, input, label")) return; // don't refit the map while typing a price
            if (el.classList.contains("selected")) return;
            resultsPanel.querySelectorAll(".option").forEach(o => o.classList.remove("selected"));
            el.classList.add("selected");
            drawRoute(+el.dataset.idx);
        });
    });

    updateTotals();
    applySort();
    // Show the top-ranked option on the map.
    const first = resultsPanel.querySelector(".option-list .option");
    if (first) { first.classList.add("selected"); drawRoute(+first.dataset.idx); }
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
daysInput.addEventListener("change", () => { if (fromAirport && toAirport && resultsPanel.classList.contains("open")) runSearch(); });
minStayInput.addEventListener("change", () => { if (fromAirport && toAirport && resultsPanel.classList.contains("open")) runSearch(); });
nearbyInput.addEventListener("change", () => { if (fromAirport && toAirport && resultsPanel.classList.contains("open")) runSearch(); });
stopsInput.addEventListener("change", () => { if (fromAirport && toAirport && resultsPanel.classList.contains("open")) runSearch(); });

// ---- Initial demo: London → Bangkok -------------------------------------------------
setField("from", "LHR");
setField("to", "BKK");
renderResults(fromAirport, toAirport);

statusHint.textContent = `${AIRPORTS.length.toLocaleString()} airports · route data is a 2014 OpenFlights snapshot, so always check the live search links.`;
