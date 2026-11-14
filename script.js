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
// City name: from places.js (Travelpayouts' city for the airport, e.g. Milan for Malpensa,
// not "Ferno"), else OurAirports' town, which can be long ("Paris (Roissy-en-France, …)").
const PLACE_DATA = typeof PLACES === "object" ? PLACES : {};
const placeName = a => (PLACE_DATA[a.iata] && PLACE_DATA[a.iata][1]) ||
    (a.city ? a.city.replace(/\s*\(.*$/, "").split(",")[0].trim() : "") || a.name;
// City code used for prices, so London covers LHR, LGW, STN, LTN, LCY and SEN.
const metro = a => (PLACE_DATA[a.iata] && PLACE_DATA[a.iata][0]) || a.iata;
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

// Basemaps: Esri tiles need no API key. Satellite (default) with country and city labels on
// top, or a clean light map. Attribution is required by the licence; it's kept, but shrunk to
// one quiet line that expands on hover (see .leaflet-control-attribution in style.css).
const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/";
map.createPane("labels");                       // above the basemap, below dots and routes
map.getPane("labels").style.zIndex = 350;
map.getPane("labels").style.pointerEvents = "none";
const BASEMAPS = {
    Satellite: L.layerGroup([
        L.tileLayer(ESRI + "World_Imagery/MapServer/tile/{z}/{y}/{x}", {
            maxZoom: 17, noWrap: true, className: "tiles-satellite",
            attribution: "Imagery &copy; Esri, Maxar, Earthstar Geographics",
        }),
        L.tileLayer("https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}", {
            maxZoom: 17, noWrap: true, pane: "labels", attribution: "Labels &copy; Esri",
        }),
    ]),
    Light: L.layerGroup([
        L.tileLayer(ESRI + "Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}", {
            maxZoom: 16, noWrap: true, attribution: "&copy; Esri, HERE, Garmin, OpenStreetMap contributors",
        }),
        L.tileLayer(ESRI + "Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}", { maxZoom: 16, noWrap: true, pane: "labels" }),
    ]),
};
let basemapName = "Satellite";
try { if (BASEMAPS[localStorage.getItem("basemap")]) basemapName = localStorage.getItem("basemap"); } catch { /* storage blocked */ }
BASEMAPS[basemapName].addTo(map);
document.getElementById("map").classList.toggle("dark-map", basemapName === "Satellite");
L.control.layers(BASEMAPS, null, { position: "topright" }).addTo(map);
map.on("baselayerchange", e => {
    document.getElementById("map").classList.toggle("dark-map", e.name === "Satellite");
    try { localStorage.setItem("basemap", e.name); } catch { /* storage blocked */ }
});

// If tiles keep failing (e.g. Esri unreachable), fall back to OpenStreetMap.
let tileErrors = 0;
map.on("tileerror", () => {
    if (++tileErrors !== 8) return;
    Object.values(BASEMAPS).forEach(l => map.removeLayer(l));
    document.getElementById("map").classList.remove("dark-map");
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19, noWrap: true,
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
    a._city = placeName(a).toLowerCase();
    a._name = a.name.toLowerCase();
    a._search = `${a.iata} ${a.icao} ${a.name} ${a.city} ${placeName(a)} ${a.country} ${countryName(a.country)}`.toLowerCase();
});

function connectionCount(iata) {
    const edges = ROUTES[iata];
    return edges ? edges.length : 0;
}

// ---- Render every airport as a canvas dot, coloured by connectivity ------------------------

const airportLayer = L.layerGroup().addTo(map);

// Airports with routes, as small soft dots: bigger for bigger hubs. Click one to use it.
AIRPORTS.forEach(a => {
    const conns = connectionCount(a.iata);
    if (!conns) return;
    const m = L.circleMarker([a.lat, a.lon], {
        radius: conns >= 60 ? 3.2 : conns >= 15 ? 2.2 : 1.5,
        stroke: false,
        fillColor: "#e0f2fe",
        fillOpacity: conns >= 15 ? 0.65 : 0.35,
        className: "airport-dot",
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

// Each flight gets its own colour, with a soft glow and a moving dashed "flight path".
const LEG_COLOURS = ["#ff4d8d", "#ffb020", "#2ee6c5", "#8b7bff", "#4fc3ff"];
const routeRenderer = L.svg({ padding: 0.5 });   // SVG so the dashes can animate (dots stay on canvas)

function drawLeg(a, b, i = 0, faint = false) {
    const color = LEG_COLOURS[i % LEG_COLOURS.length];
    const segs = splitAtAntimeridian(greatCirclePoints(a, b));
    const base = { renderer: routeRenderer, interactive: false, lineCap: "round", lineJoin: "round" };
    if (faint) {
        L.polyline(segs, { ...base, color: "#ffffff", weight: 1.5, opacity: 0.35, dashArray: "2 6" }).addTo(routeLayers);
        return segs.flat();
    }
    L.polyline(segs, { ...base, color, weight: 14, opacity: 0.18 }).addTo(routeLayers);
    L.polyline(segs, { ...base, color, weight: 4, opacity: 0.95 }).addTo(routeLayers);
    L.polyline(segs, { ...base, color: "#ffffff", weight: 2, opacity: 0.9, dashArray: "1 14", className: "flight-flow" }).addTo(routeLayers);
    return segs.flat();
}

// A pin with a label: kind = "from" | "to" | "stop"; note e.g. "2 nights".
function markPoint(a, kind, num, note = "") {
    const badge = kind === "stop" ? `<span class="pin-num">${num}</span>` : `<span class="pin-dot"></span>`;
    const label = `${flag(a.country)}<b>${esc(placeName(a))}</b>${note ? `<i>${esc(note)}</i>` : ""}`;
    const icon = L.divIcon({
        className: `map-pin pin-${kind}`,
        html: `${badge}<span class="pin-label">${label}</span>`,
        iconSize: [22, 22],
        iconAnchor: [11, 11],
    });
    L.marker([a.lat, a.lon], { icon, zIndexOffset: kind === "stop" ? 900 : 1000, keyboard: false })
        .bindTooltip(`${esc(a.iata)} — ${esc(a.name)}`, { direction: "top", offset: [0, -12] })
        .addTo(endpointMarkers);
}

// Pins near the right-hand edge put their label on the left, so it isn't cut off.
function updatePinSides() {
    const w = map.getSize().x;
    endpointMarkers.eachLayer(m => {
        const el = m.getElement();
        if (el) el.classList.toggle("label-left", map.latLngToContainerPoint(m.getLatLng()).x > w - 190);
    });
}
map.on("moveend zoomend resize", updatePinSides);

// Extra room on the right so the city labels beside each pin aren't cut off.
function fitTo(points) {
    const w = map.getSize().x;
    map.fitBounds(L.latLngBounds(points), {
        paddingTopLeft: [Math.min(70, w * 0.12), 70],
        paddingBottomRight: [Math.min(170, w * 0.32), 50],
        maxZoom: 6,
    });
    updatePinSides();
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

// Countries not used as stopovers: since 2022 Russia and Belarus are cut off from UK/EU/US
// airlines and airspace, and Ukraine's airspace is closed. Skipped unless the trip starts or ends there.
const CLOSED_COUNTRIES = new Set(["RU", "BY", "UA"]);
let closedForTrip = CLOSED_COUNTRIES;
const closedHub = a => closedForTrip.has(a.country);

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
            if (!destByIata.has(next.iata) && closedHub(next)) continue;
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
        if (c.type !== "large_airport" || !c.sched || closedHub(c)) continue;
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
// Keyed by city codes and date ("LON-AUH-2026-12-14"), so the same flight shares a price across
// cards, and a fare from any London airport counts for London.
const prices = new Map();       // key → number used in totals (typed or looked up)
const typedKeys = new Set();    // keys the user typed themselves; looked-up prices never overwrite these
const priceKey = (from, to, date) => `${from}-${to}-${date}`;
const parseKey = k => ({ from: k.slice(0, 3), to: k.slice(4, 7), date: k.slice(8) });
const { addDays: pAddDays, dayDiff, datesBetween } = Planner;

// Looked-up fares, per city pair and day:
//   dayFares["LON-AUH"] = Map("2026-12-14" → fare | null)   (null = looked up, nothing seen)
const dayFares = new Map();
function fareOn(from, to, date) {         // fare | null (none seen) | undefined (not looked up)
    const m = dayFares.get(`${from}-${to}`);
    return m ? m.get(date) : undefined;
}
const fareForKey = key => { const { from, to, date } = parseKey(key); return fareOn(from, to, date); };
// Did we see any fare at all for this pair in the dates we looked at?
const pairHasFares = (from, to) => { const m = dayFares.get(`${from}-${to}`); return !!m && [...m.values()].some(Boolean); };

function priceBox(key) {
    const v = prices.has(key) ? prices.get(key) : "";
    const auto = !typedKeys.has(key) && fareForKey(key) ? " auto" : "";
    return `<label class="price-input${auto}"><span>${CURRENCY}</span><input type="number" min="0" step="1" inputmode="decimal" placeholder="price" data-price-key="${esc(key)}" value="${v}"></label>`;
}

function ago(iso) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return "";
    const h = (Date.now() - t) / 3600000;
    return h < 1 ? "seen just now" : h < 24 ? `seen ${Math.round(h)}h ago` : `seen ${Math.round(h / 24)} day${Math.round(h / 24) > 1 ? "s" : ""} ago`;
}

// The line under each price box saying where a looked-up price came from.
function fareNoteHtml(key, approx) {
    if (typedKeys.has(key)) return "";
    const f = fareForKey(key);
    if (f === undefined) return "";
    if (f === null) return `<span class="muted">No recent fare seen for this flight — check the links.</span>`;
    const bits = [];
    if (approx) bits.push(`<span class="approx">nearest fare to your date</span>`);
    if (f.fromAirport && f.toAirport) bits.push(`${esc(f.fromAirport)} → ${esc(f.toAirport)}`);
    else if (f.fromAirport) bits.push(`from ${esc(f.fromAirport)}`);
    else if (f.toAirport) bits.push(`to ${esc(f.toAirport)}`);
    if (f.airline) bits.push(esc(AIRLINE_NAMES[f.airline] || f.airline));
    if (f.transfers != null) bits.push(f.transfers === 0 ? "nonstop" : `${f.transfers} change${f.transfers > 1 ? "s" : ""}`);
    if (f.foundAt) bits.push(ago(f.foundAt));
    const link = f.link ? ` · <a href="${esc(f.link)}" target="_blank" rel="noopener">Book on Aviasales ↗</a>` : "";
    return `Recent fare${bits.length ? " · " + bits.join(" · ") : ""}${link}`;
}

// Put the looked-up price for a key into the totals (unless the user typed one).
function syncAutoPrice(key) {
    if (typedKeys.has(key)) return;
    const f = fareForKey(key);
    if (f) prices.set(key, f.price);
    else if (f === null) prices.delete(key);
}

// ---- Trip costs beyond the flights -------------------------------------------------
// Rough nightly cost of a budget hotel or private room, in £, by country. A guide only.
const NIGHT_COST = (() => {
    const tiers = {
        20: "VN KH LA IN NP LK BD PK MM EG BO NI KG UZ TJ ET",
        30: "TH MY PH ID TR GE AM AZ MA TN CO PE EC GT MX AL MK RS BA ME KE TZ UG RW ZM ZW GH SN LB",
        45: "CN TW PL HU CZ SK RO BG HR SI LT LV EE PT GR CY MT ES ZA BR AR CL UY KZ OM JO MU CR PA BW NA MN",
        70: "KR JP IT FR DE AT BE NL IE FI SE AE QA SA BH KW IL CA US AU NZ HK MO GB PR",
        100: "CH NO IS DK SG LU MC MV BS BM",
    };
    const m = new Map();
    for (const [cost, ccs] of Object.entries(tiers)) ccs.split(" ").forEach(cc => m.set(cc, +cost));
    return m;
})();
const nightCost = cc => NIGHT_COST.get(cc) || 45;
const BAG_FEE = 35;   // typical hold-bag fee on a budget airline, per flight

const costsInput = document.getElementById("costs-input");
const bagsInput = document.getElementById("bags-input");

// Is this flight likely to charge for a hold bag? Budget airlines do; full-service ones mostly don't.
function budgetFlight(l) {
    const f = fareForKey(l.key);
    if (f && f.airline) return BUDGET.has(f.airline);
    return !!(l.edge && l.edge.airlines.length && l.edge.airlines.every(c => BUDGET.has(c)));
}

// { stays, nights, bags } for a route's current dates.
function extraCosts(route) {
    let stays = 0, nights = 0;
    route.legs.forEach((l, j) => {
        if (j === 0) return;
        const n = dayDiff(l.date, route.legs[j - 1].date);
        nights += n;
        stays += n * nightCost(l.from.country);
    });
    const bags = bagsInput.checked ? route.legs.filter(budgetFlight).length * BAG_FEE : 0;
    return { stays: costsInput.checked ? stays : 0, nights, bags };
}

// ---- Countries you've been to -------------------------------------------------
let visited = new Set();
try { visited = new Set(JSON.parse(localStorage.getItem("visited") || "[]")); } catch { /* storage blocked */ }
const visitedInput = document.getElementById("visited-input");
const visitedList = document.getElementById("visited-list");
const visitedOptions = document.getElementById("visited-options");
const ALL_COUNTRIES = [...new Set(AIRPORTS.map(a => a.country).filter(Boolean))]
    .map(cc => ({ cc, name: countryName(cc) })).sort((x, y) => x.name.localeCompare(y.name));
visitedOptions.innerHTML = ALL_COUNTRIES.map(c => `<option value="${esc(c.name)}">`).join("");

function saveVisited() {
    try { localStorage.setItem("visited", JSON.stringify([...visited])); } catch { /* storage blocked */ }
    renderVisited();
    if (current) runSearch();
}
function renderVisited() {
    visitedList.innerHTML = [...visited].sort((x, y) => countryName(x).localeCompare(countryName(y))).map(cc =>
        `<button type="button" class="chip" data-cc="${esc(cc)}" title="Remove">${flag(cc)} ${esc(countryName(cc))} ×</button>`).join("");
    document.getElementById("visited-count").textContent = visited.size ? `${visited.size} so far` : "";
}
visitedInput.addEventListener("change", () => {
    const q = visitedInput.value.trim().toLowerCase();
    const hit = ALL_COUNTRIES.find(c => c.name.toLowerCase() === q || c.cc.toLowerCase() === q);
    visitedInput.value = "";
    if (hit && !visited.has(hit.cc)) { visited.add(hit.cc); saveVisited(); }
});
visitedList.addEventListener("click", e => {
    const chip = e.target.closest("[data-cc]");
    if (chip) { visited.delete(chip.dataset.cc); saveVisited(); }
});
renderVisited();

// ---- Stopover cities worth a stay -------------------------------------------------
// City codes of well-known stopover cities: good transport from the airport, plenty to do in a
// day or two, and often an airline stopover deal. They get a tag and a small ranking boost.
const GREAT_STOPOVERS = new Set(("IST DXB DOH AUH SIN HKG BKK KUL TPE SEL TYO REK LIS HEL AMS PRG BUD " +
    "ATH BCN ROM PAR MAD CPH MCT DEL BOM CMB NBO ADD JNB SYD AKL HNL YVR NYC MEX LIM BOG PTY").split(" "));
const isGreatStop = a => GREAT_STOPOVERS.has(metro(a));

// ---- Fitting a route into the time budget -------------------------------------------------
const lookupLegs = route => route.legs.map(l => ({ from: metro(l.from), to: metro(l.to) }));

// Choose dates for a route; sets leg.date / leg.key / leg.approx.
function planRoute(route, ctx) {
    const { dates, approx } = Planner.planDates(lookupLegs(route), ctx, fareOn, liveState === "on");
    route.legs.forEach((l, j) => {
        l.date = dates[j];
        l.key = priceKey(metro(l.from), metro(l.to), l.date);
        l.approx = j === 0 && approx;
        syncAutoPrice(l.key);
    });
    // With prices on, a route with a flight nobody has priced recently probably doesn't run.
    route.noFares = liveState === "on" && route.legs.some(l => !pairHasFares(metro(l.from), metro(l.to)));
}

// Date ranges still to look up for these routes.
function windowsNeeded(routes, ctx) {
    return Planner.windowsFor(routes.map(lookupLegs), ctx).filter(w => {
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

async function callApi(payload) {
    const r = await fetch(PRICE_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
    const body = r.headers.get("content-type")?.includes("json") ? await r.json() : null;
    if (!body) throw Object.assign(new Error("no API"), { off: true });   // e.g. static hosting, 404 page
    if (body.configured === false) throw Object.assign(new Error("not configured"), { off: true });
    if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
    return body;
}

// Main airport for a city code (most routes in the route data), for routes found from fares.
let cityAirports = null;
function airportForCity(code) {
    if (!cityAirports) {
        cityAirports = new Map();
        for (const a of AIRPORTS) {
            const c = metro(a), cur = cityAirports.get(c);
            if (!cur || connectionCount(a.iata) > connectionCount(cur.iata)) cityAirports.set(c, a);
        }
    }
    return cityAirports.get(code) || byIata.get(code) || null;
}
const cityHasRoute = (fromCode, toCode) => {
    for (const a of AIRPORTS) {
        if (metro(a) !== fromCode || !ROUTES[a.iata]) continue;
        if (ROUTES[a.iata].some(e => { const t = byIata.get(e.to); return t && metro(t) === toCode; })) return true;
    }
    return false;
};

// Price-first route finding: stopovers in cities you can fly to cheaply from the origin and
// on cheaply to the destination, from recent fares. Adds routes the old route data misses.
function routesFromExplore(ex, c) {
    const { a, b, ctx, maxStops } = c;
    const ends = new Set([metro(a), metro(b)]);
    const ok = code => {
        const ap = airportForCity(code);
        return ap && !ends.has(code) && !closedHub(ap) ? ap : null;
    };
    const out = new Map(ex.outbound.map(x => [x.code, x])), inb = new Map(ex.inbound.map(x => [x.code, x]));
    const found = [];
    if (Planner.feasible(1, ctx)) {
        for (const [code, o] of out) {
            const i = inb.get(code), hub = ok(code);
            if (i && hub) found.push({ hubs: [hub], guess: o.price + i.price });
        }
    }
    if (maxStops >= 2 && Planner.feasible(2, ctx)) {
        const firsts = ex.outbound.slice(0, 15), lasts = ex.inbound.slice(0, 15);
        for (const o of firsts) for (const i of lasts) {
            const h1 = ok(o.code), h2 = ok(i.code);
            if (!h1 || !h2 || o.code === i.code || !cityHasRoute(o.code, i.code)) continue;
            found.push({ hubs: [h1, h2], guess: o.price + i.price + 60 });
        }
    }
    found.sort((x, y) => x.guess - y.guess);
    return found.slice(0, 12).map(f => {
        const path = [a, ...f.hubs, b];
        const dist = path.slice(1).reduce((t, p, j) => t + haversine(path[j], p), 0);
        return {
            path, hubs: f.hubs, o: a, d: b, ratio: dist / haversine(a, b), budgetLegs: 0, airlineChanges: 0, fromFares: true,
            legs: path.slice(0, -1).map((from, j) => ({ from, to: path[j + 1], edge: findEdge(from.iata, path[j + 1].iata) })),
        };
    });
}

async function fetchFares(seq) {
    if (liveState === "off" || !current) return;
    const c = current;
    const fail = e => {
        if (seq !== searchSeq) return;
        if (e.off || e instanceof TypeError) { liveState = "off"; setLiveStatus(MANUAL_NOTE); }
        else { liveState = "error"; setLiveStatus(`Couldn't load prices (${esc(e.message)}). ${MANUAL_NOTE}`); }
    };

    // 1. Explore: find stopover cities from recent fares (once per search).
    if (!c.explored) {
        setLiveStatus(`<span class="spinner"></span>Finding cheap stopover cities from recent fares…`);
        try {
            const body = await callApi({ explore: {
                from: metro(c.a), to: metro(c.b),
                start: pAddDays(c.ctx.depart, -Planner.SHIFT_DAYS), end: pAddDays(c.ctx.depart, c.ctx.days + Planner.SHIFT_DAYS),
            } });
            liveState = "on";
            c.explored = true;
            if (seq !== searchSeq) return;
            const seen = new Set(c.routes.map(routeSignature));
            const extra = routesFromExplore(body.explore || { outbound: [], inbound: [] }, c).filter(r => !seen.has(routeSignature(r)));
            extra.forEach(r => {
                r.idx = c.routes.length;
                r.countries = newCountries(r, c.a, c.b);
                planRoute(r, c.ctx);
                c.routes.push(r);
            });
            if (extra.length) renderList();
        } catch (e) { return fail(e); }
    }

    // 2. Prices for every flight across the dates that could fit.
    const windows = windowsNeeded(c.routes, c.ctx);
    if (windows.length) {
        setLiveStatus(`<span class="spinner"></span>Looking up prices for ${windows.length} flight${windows.length > 1 ? "s" : ""} across your dates…`);
        let results;
        try {
            const batches = [];
            for (let i = 0; i < windows.length; i += API_BATCH) batches.push(windows.slice(i, i + API_BATCH));
            results = (await Promise.all(batches.map(w => callApi({ windows: w })))).flatMap(b => b.results || []);
        } catch (e) { return fail(e); }
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
    c.routes.forEach(r => planRoute(r, c.ctx));
    renderList();
    const shown = c.routes.filter(r => !r.noFares);
    const priced = shown.filter(r => r.legs.every(l => prices.has(l.key))).length;
    const found = c.routes.filter(r => r.fromFares && !r.noFares).length;
    setLiveStatus(`Prices found for ${priced} of ${shown.length} options from fares seen in the last few days, ` +
        `with dates picked to be cheapest within your ${c.ctx.days ? `${c.ctx.days} day${c.ctx.days > 1 ? "s" : ""}` : "day"}` +
        `${found ? `, including ${found} route${found > 1 ? "s" : ""} found from recent fares` : ""}. ` +
        `They're a guide, not a quote: confirm before booking.`);
}

// ---- Totals -------------------------------------------------
const money = n => CURRENCY + Math.round(n).toLocaleString("en-GB");

function updateTotals() {
    const cards = [...resultsPanel.querySelectorAll(".option")];
    const directCard = cards.find(c => c.dataset.direct === "1");
    let beat;
    const totalOf = card => {
        const route = card._route;
        const keys = route.legs.map(l => l.key);
        const vals = keys.map(k => prices.get(k));
        if (vals.some(v => v === undefined)) return { missing: vals.filter(v => v === undefined).length, n: keys.length };
        const flights = vals.reduce((x, y) => x + y, 0);
        const x = extraCosts(route);
        return { flights, ...x, total: flights + x.stays + x.bags, n: keys.length };
    };
    if (directCard) { const t = totalOf(directCard); beat = t.total; }
    let cheapest = null;

    cards.forEach(card => {
        const t = totalOf(card);
        const el = card.querySelector(".total");
        const nc = +card.dataset.countries || 0;
        const extra = nc ? ` · <span class="countries">+${nc} new countr${nc > 1 ? "ies" : "y"}</span>` : "";
        const isDirect = card === directCard;
        if (t.total === undefined) {
            el.innerHTML = (isDirect ? "Add the one-ticket price to compare against."
                : t.missing === t.n ? `Add all ${t.n} ticket prices to see the total.`
                : `${t.missing} of ${t.n} prices missing — type ${t.missing > 1 ? "them" : "it"} in to see the total.`) + extra;
            card._total = null;
            return;
        }
        card._total = t.total;
        const parts = [`Flights ${money(t.flights)}`];
        if (t.stays) parts.push(`${t.nights} night${t.nights > 1 ? "s" : ""} ≈ ${money(t.stays)}`);
        if (t.bags) parts.push(`bags ≈ ${money(t.bags)}`);
        const lead = parts.length > 1 ? `${parts.join(" + ")} = <strong>${money(t.total)}</strong>` : `<strong>${money(t.total)}</strong>`;
        if (isDirect) {
            el.innerHTML = `One ticket: ${lead} · the price to beat`;
        } else {
            el.innerHTML = beat === undefined ? `${lead}${extra}`
                : t.total < beat ? `${lead} · <span class="save">${money(beat - t.total)} cheaper</span> than direct${extra}`
                : t.total > beat ? `${lead} · <span class="lose">${money(t.total - beat)} dearer</span> than direct${extra}`
                : `${lead} · same as direct${extra}`;
        }
        if (!card.hidden && (cheapest === null || t.total < cheapest._total)) cheapest = card;
    });

    resultsPanel.querySelectorAll(".tag.cheapest").forEach(t => t.remove());
    if (cheapest) cheapest.querySelector(".tags").insertAdjacentHTML("afterbegin", `<span class="tag good cheapest">Cheapest</span>`);
}
[costsInput, bagsInput].forEach(el => el.addEventListener("change", () => {
    try { localStorage.setItem("costs", JSON.stringify({ stays: costsInput.checked, bags: bagsInput.checked })); } catch { /* storage blocked */ }
    updateTotals(); applySort();
}));
try {
    const c = JSON.parse(localStorage.getItem("costs") || "null");
    if (c) { costsInput.checked = !!c.stays; bagsInput.checked = !!c.bags; }
} catch { /* storage blocked */ }

// ---- Ranking: cheapest ←→ most countries -------------------------------------------------
// rankWeight 0 = cheapest total first, 100 = most new countries first, in between blends the two:
//   score = (1 − w) · price + w · (1 − places), both scaled 0–1 across the current results,
// where places = new countries + half a point per great stopover city. The direct flight is
// ranked too. With no prices yet, "price" falls back to the best-guess order from the route data.
let rankWeight = 0;
try { rankWeight = Math.min(100, Math.max(0, +localStorage.getItem("rankWeight") || 0)); } catch { /* storage blocked */ }

const rankLabel = w => w <= 10 ? "Cheapest first" : w >= 90 ? "Most countries first" : w < 40 ? "Mostly cheapest" : w > 60 ? "Mostly countries" : "Balanced";

function applySort() {
    const list = resultsPanel.querySelector(".option-list");
    if (!list) return;
    const label = resultsPanel.querySelector(".rank-value");
    if (label) label.textContent = rankLabel(rankWeight);
    const slider = resultsPanel.querySelector(".rank-slider");
    if (slider && +slider.value !== rankWeight) slider.value = rankWeight;

    const cards = [...list.querySelectorAll(".option")];
    const totals = cards.map(c => c._total).filter(t => t != null);
    const lo = Math.min(...totals), hi = Math.max(...totals);
    const placesOf = c => (+c.dataset.countries || 0) + 0.5 * (+c.dataset.great || 0);
    const maxPlaces = Math.max(0, ...cards.map(placesOf));
    const w = rankWeight / 100;
    const priceScore = c => {
        if (!totals.length) return cards.length > 1 ? +c.dataset.idx / (cards.length - 1) : 0;
        if (c._total == null) return 1.5;                 // unpriced after priced ones
        return hi > lo ? (c._total - lo) / (hi - lo) : 0;
    };
    const placeScore = c => maxPlaces ? 1 - placesOf(c) / maxPlaces : 0;
    const score = new Map(cards.map(c => [c, (1 - w) * priceScore(c) + w * placeScore(c)]));
    // Ties (e.g. same number of countries) go to the cheaper route, then the best guess.
    cards.sort((x, y) => (score.get(x) - score.get(y)) || (priceScore(x) - priceScore(y)) || (+x.dataset.idx - +y.dataset.idx));
    cards.forEach(c => list.appendChild(c));
}

resultsPanel.addEventListener("input", (e) => {
    if (!e.target.classList.contains("rank-slider")) return;
    rankWeight = +e.target.value;
    try { localStorage.setItem("rankWeight", String(rankWeight)); } catch { /* storage blocked */ }
    applySort();
    updateHash();
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
    if (e.target.value === "" && fareForKey(key)) {
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
let current = null;   // { a, b, ctx, maxStops, routes, explored }

const nightsText = n => n === 0 ? "Same-day connection" : `${n} night${n > 1 ? "s" : ""}`;
// Routes that visit the same cities in the same order are the same trip for pricing.
const routeSignature = r => r.path.map(metro).join(">");
// New countries a route adds: not where you start or end, and not ones you've been to.
function newCountries(r, a, b) {
    const skip = new Set([a.country, b.country, r.o.country, r.d.country, ...visited]);
    return [...new Set(r.hubs.map(h => h.country).filter(c => c && !skip.has(c)))];
}

function legHtml(l) {
    return `
        <div class="leg">
            <div class="leg-head">
                <span class="leg-route">${esc(l.from.iata)} → ${esc(l.to.iata)}</span>
                <span class="leg-date">${prettyDate(l.date)} · ~${flightTimeStr(haversine(l.from, l.to))}</span>
            </div>
            <div class="leg-air">${l.edge ? esc(airlineLabel(l.edge.airlines)) : l.direct ? "" : "Not in the 2014 route data — check it runs"}</div>
            <div class="price-row">${priceBox(l.key)}${searchLinks(l.from.iata, l.to.iata, l.date)}</div>
            <div class="fare-note" data-note-key="${esc(l.key)}" data-approx="${l.approx ? 1 : 0}">${fareNoteHtml(l.key, l.approx)}</div>
        </div>`;
}

// Flights, the stays between them, the total and the multi-city link for one route.
function renderRouteBody(route) {
    const card = resultsPanel.querySelector(`.option[data-idx="${route.idx}"]`);
    if (!card) return;
    card._route = route;
    const parts = [];
    route.legs.forEach((l, j) => {
        if (j > 0) {
            const stay = dayDiff(l.date, route.legs[j - 1].date);
            const cost = stay && costsInput.checked ? ` <span class="stay-cost">≈ ${money(nightCost(l.from.country))}/night</span>` : "";
            parts.push(`<div class="stay">${stay ? "🛏️" : "⏱️"} ${nightsText(stay)} in ${placeLabel(l.from)}${cost}</div>`);
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
    const seen = new Set([routeSignature(routes[0])]);
    const skipped = [];
    let estimated = false;
    for (let stops = 1; stops <= maxStops; stops++) {
        if (!Planner.feasible(stops, ctx)) { skipped.push(stops); continue; }
        let splits = findSplits(a, b, origins, dests, stops);
        if (!splits.length && stops === 1) { splits = estimatedSplits(a, b); estimated = splits.length > 0; }
        let added = 0;
        for (const s of splits) {
            if (added >= (stops === 1 ? 12 : 8)) break;
            const r = { ...s, legs: s.path.slice(0, -1).map((from, j) => ({ from, to: s.path[j + 1], edge: s.edges[j] })) };
            const sig = routeSignature(r);
            if (seen.has(sig)) continue;   // e.g. the same trip from Heathrow and from Gatwick
            seen.add(sig);
            routes.push(r);
            added++;
        }
    }
    routes.forEach((r, i) => { r.idx = i; r.countries = newCountries(r, a, b); });
    return { routes, skipped, estimated };
}

function routeCardHtml(route, a, b) {
    const tags = [];
    let title, subtitle = "", right = "";
    const great = route.hubs.filter(isGreatStop);
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
        if (route.countries.length) tags.push(`<span class="tag country">${route.countries.map(c => flag(c, countryName(c))).join("")} +${route.countries.length} new countr${route.countries.length > 1 ? "ies" : "y"}</span>`);
        tags.push(`<span class="tag">${stops} stop${stops > 1 ? "s" : ""}</span>`);
        if (great.length) tags.push(`<span class="tag great" title="${esc(great.map(placeName).join(", "))}">⭐ Great stopover${great.length > 1 ? "s" : ""}</span>`);
        if (s.fromFares) tags.push(`<span class="tag good">Found in recent fares</span>`);
        if (s.estimate) tags.push(`<span class="tag warn">Unconfirmed</span>`);
        if (s.budgetLegs > 0) tags.push(`<span class="tag good">Budget airline${s.budgetLegs > 1 ? `s on ${s.budgetLegs} flights` : ""}</span>`);
        if (s.airlineChanges > 0) tags.push(`<span class="tag">${s.airlineChanges === stops ? "Different airlines" : "Airline change"}</span>`);
        if (s.o !== a) tags.push(`<span class="tag">From ${esc(s.o.iata)}</span>`);
        if (s.d !== b) tags.push(`<span class="tag">To ${esc(s.d.iata)}</span>`);
    }
    return `
        <div class="option${route.direct ? " direct" : ""}" data-idx="${route.idx}" data-direct="${route.direct ? 1 : 0}"
             data-countries="${route.countries.length}" data-great="${great.length}" data-keys=""${route.noFares ? " hidden" : ""}>
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

// The selected route in colour, with the other options shown faintly behind it.
function drawRoute(r) {
    clearRoute();
    if (current) {
        const others = [...resultsPanel.querySelectorAll(".option:not([hidden])")]
            .map(el => current.routes[+el.dataset.idx]).filter(x => x && x !== r).slice(0, 8);
        others.forEach(o => { for (let j = 0; j < o.path.length - 1; j++) drawLeg(o.path[j], o.path[j + 1], 0, true); });
    }
    const pts = [];
    for (let j = 0; j < r.path.length - 1; j++) pts.push(...drawLeg(r.path[j], r.path[j + 1], j));
    markPoint(r.o, "from");
    markPoint(r.d, "to");
    r.hubs.forEach((h, j) => {
        const n = r.legs[j + 1] && r.legs[j] && r.legs[j + 1].date && r.legs[j].date ? dayDiff(r.legs[j + 1].date, r.legs[j].date) : null;
        markPoint(h, "stop", j + 1, n == null ? "" : n === 0 ? "connect" : `${n} night${n > 1 ? "s" : ""}`);
    });
    fitTo(pts);
}

// (Re)draw the list of option cards for the current search, keeping the selected one.
function renderList() {
    const c = current;
    const list = resultsPanel.querySelector(".option-list");
    if (!c || !list) return;
    const selectedIdx = list.querySelector(".option.selected")?.dataset.idx;
    list.innerHTML = c.routes.map(r => routeCardHtml(r, c.a, c.b)).join("");
    c.routes.forEach(renderRouteBody);

    const hidden = c.routes.filter(r => r.noFares).length;
    const more = resultsPanel.querySelector(".hidden-routes");
    more.innerHTML = hidden ? `<button type="button" class="link-like">Show ${hidden} route${hidden > 1 ? "s" : ""} with no recent fares</button>
        <span>— nobody has priced one of their flights lately, so they may not run any more (e.g. a 2014 route).</span>` : "";

    list.querySelectorAll(".option").forEach(el => {
        el.addEventListener("click", (e) => {
            if (e.target.closest("a, input, label")) return; // don't refit the map while typing a price
            if (el.classList.contains("selected")) return;
            list.querySelectorAll(".option").forEach(o => o.classList.remove("selected"));
            el.classList.add("selected");
            drawRoute(c.routes[+el.dataset.idx]);
        });
    });

    updateTotals();
    applySort();
    let sel = selectedIdx != null && list.querySelector(`.option[data-idx="${selectedIdx}"]:not([hidden])`);
    if (!sel) {
        sel = list.querySelector(".option:not([hidden])");
        if (sel) drawRoute(c.routes[+sel.dataset.idx]);
    }
    if (sel) sel.classList.add("selected");
}

resultsPanel.addEventListener("click", e => {
    if (e.target.closest(".hidden-routes button")) {
        resultsPanel.querySelectorAll(".option[hidden]").forEach(el => { el.hidden = false; el.classList.add("no-fares"); });
        resultsPanel.querySelector(".hidden-routes").innerHTML = "";
        updateTotals();
    }
    if (e.target.closest(".share-btn")) shareSearch(e.target.closest(".share-btn"));
});

function renderResults(a, b) {
    const ctx = {
        depart: dateInput.value || addDays(isoDate(new Date()), 30),
        days: parseInt(daysInput.value, 10) || 0,
        minStay: parseInt(minStayInput.value, 10) || 0,
    };
    const maxStops = parseInt(stopsInput.value, 10) || 1;
    closedForTrip = new Set([...CLOSED_COUNTRIES].filter(cc => cc !== a.country && cc !== b.country));
    const { routes, skipped, estimated } = buildRoutes(a, b, ctx, maxStops);
    current = { a, b, ctx, maxStops, routes, explored: false };
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
            <div class="result-route">${esc(a.iata)} <span class="arrow">→</span> ${esc(b.iata)}
                <button type="button" class="share-btn" title="Copy a link to this search">🔗 Share</button></div>
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
        <div class="option-list"></div>
        <p class="hint hidden-routes"></p>
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
                Hotel and bag costs are rough guides. Check each country's visa rules for your passport: some need a visa or
                transit permit even for a short stop (the US needs an ESTA just to change planes).
            </div>`;
    }

    resultsPanel.innerHTML = html;
    resultsPanel.classList.add("open");
    renderList();
    updateHash();
    fetchFares(++searchSeq);
}

// ---- Presets and sharing -------------------------------------------------
const PRESETS = {
    cheapest: { days: 2, stops: 2, stay: 0, rank: 0 },
    balanced: { days: 5, stops: 2, stay: 1, rank: 50 },
    explorer: { days: 10, stops: 3, stay: 2, rank: 100 },
};
document.querySelectorAll("[data-preset]").forEach(btn => btn.addEventListener("click", () => {
    const p = PRESETS[btn.dataset.preset];
    daysInput.value = String(p.days);
    stopsInput.value = String(p.stops);
    minStayInput.value = String(p.stay);
    rankWeight = p.rank;
    try { localStorage.setItem("rankWeight", String(rankWeight)); } catch { /* storage blocked */ }
    document.querySelectorAll("[data-preset]").forEach(b => b.classList.toggle("active", b === btn));
    runSearch();
}));

// The search lives in the URL (#from=LHR&to=HAN&…), so a link opens the same search.
function updateHash() {
    if (!current) return;
    const q = new URLSearchParams({
        from: current.a.iata, to: current.b.iata, date: current.ctx.depart, days: current.ctx.days,
        stops: current.maxStops, stay: current.ctx.minStay, rank: rankWeight, nearby: nearbyInput.checked ? 1 : 0,
    });
    try { history.replaceState(null, "", "#" + q); } catch { /* sandboxed */ }
}
function applyHash() {
    const q = new URLSearchParams(location.hash.slice(1));
    if (!q.get("from") || !q.get("to") || !byIata.has(q.get("from")) || !byIata.has(q.get("to"))) return false;
    setField("from", q.get("from"));
    setField("to", q.get("to"));
    const setSel = (el, v) => { if (v != null && [...el.options].some(o => o.value === v)) el.value = v; };
    if (/^\d{4}-\d{2}-\d{2}$/.test(q.get("date") || "")) dateInput.value = q.get("date");
    setSel(daysInput, q.get("days"));
    setSel(stopsInput, q.get("stops"));
    setSel(minStayInput, q.get("stay"));
    if (q.has("rank")) rankWeight = Math.min(100, Math.max(0, +q.get("rank") || 0));
    if (q.has("nearby")) nearbyInput.checked = q.get("nearby") === "1";
    return true;
}
async function shareSearch(btn) {
    updateHash();
    const url = location.href;
    try {
        if (navigator.share && matchMedia("(pointer: coarse)").matches) await navigator.share({ title: "Stopover Nomad", url });
        else { await navigator.clipboard.writeText(url); btn.textContent = "✓ Link copied"; }
    } catch {
        window.prompt("Copy this link:", url);
    }
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

// ---- First load: a shared link's search, or a London → Bangkok demo ---------------------
if (!applyHash()) {
    setField("from", "LHR");
    setField("to", "BKK");
}
renderResults(fromAirport, toAirport);

statusHint.textContent = `${AIRPORTS.length.toLocaleString()} airports · without live prices, routes come from a 2014 snapshot, so always check the search links.`;
