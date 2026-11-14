// Builds places.js: each airport's real city name and Travelpayouts city code.
//   curl -o /tmp/airports.json https://api.travelpayouts.com/data/en/airports.json
//   curl -o /tmp/cities.json   https://api.travelpayouts.com/data/en/cities.json
//   node scripts/build-places.js /tmp/airports.json /tmp/cities.json
// Fixes names like "Ferno" (Milan Malpensa) and "Balice" (Kraków), and gives
// city codes (LON, NYC, PAR…) so prices cover every airport in a city.
const fs = require("fs");
const path = require("path");
const [apFile, ciFile] = process.argv.slice(2);
if (!apFile || !ciFile) { console.error("usage: node scripts/build-places.js airports.json cities.json"); process.exit(1); }

const tpAirports = new Map(JSON.parse(fs.readFileSync(apFile, "utf8")).map(a => [a.code, a]));
const tpCities = new Map(JSON.parse(fs.readFileSync(ciFile, "utf8")).map(c => [c.code, c]));
const src = fs.readFileSync(path.join(__dirname, "..", "airports.js"), "utf8");
const AIRPORTS = JSON.parse(src.slice(src.indexOf("["), src.lastIndexOf("]") + 1));

const out = {};
let named = 0;
for (const a of AIRPORTS) {
    const t = tpAirports.get(a.iata);
    if (!t || !t.city_code) continue;
    const c = tpCities.get(t.city_code);
    const name = c && ((c.name_translations && c.name_translations.en) || c.name);
    out[a.iata] = name ? [t.city_code, name] : [t.city_code];
    if (name) named++;
}
const header = "// Airport → [city code, city name], from Travelpayouts' public data (scripts/build-places.js).\n";
fs.writeFileSync(path.join(__dirname, "..", "places.js"), header + "const PLACES = " + JSON.stringify(out) + ";\n");
console.log(`places.js: ${Object.keys(out).length} of ${AIRPORTS.length} airports, ${named} with a city name`);
