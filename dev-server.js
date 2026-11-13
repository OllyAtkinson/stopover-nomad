// Local dev server: serves the static site and /api/prices.
//   TRAVELPAYOUTS_TOKEN=your_token node dev-server.js
// then open http://localhost:3000
const http = require("http");
const fs = require("fs");
const path = require("path");
const pricesHandler = require("./api/prices.js");

const ROOT = __dirname;
const PORT = process.env.PORT || 3000;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json" };

http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/api/prices") return pricesHandler(req, res);
    const file = path.normalize(path.join(ROOT, url.pathname === "/" ? "index.html" : url.pathname));
    if (!file.startsWith(ROOT + path.sep) || /[\\/](api|lib|test|\.git)[\\/]/.test(file.slice(ROOT.length))) {
        res.statusCode = 404; return res.end("not found");
    }
    fs.readFile(file, (err, data) => {
        if (err) { res.statusCode = 404; return res.end("not found"); }
        res.setHeader("Content-Type", TYPES[path.extname(file)] || "application/octet-stream");
        res.end(data);
    });
}).listen(PORT, () => {
    console.log(`Stopover Nomad on http://localhost:${PORT}` +
        (process.env.TRAVELPAYOUTS_TOKEN ? " (live prices on)" : " (no TRAVELPAYOUTS_TOKEN: manual prices only)"));
});
