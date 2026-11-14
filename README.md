# Stopover Nomad

Say how long you have to get somewhere, and Stopover Nomad fits in stopovers that
**cost less than flying direct** and **tick off more countries**. For example, with 3 days to
get from London to Hanoi, London → Abu Dhabi → Singapore → Hanoi might beat the direct fare
and add two countries to your list.

## How a search works

- **Time to get there**: the most days between your first and last flight.
- **Stops**: the most stopovers to try. Routes with 1 up to that many stops are shown together,
  alongside the direct flight.
- **Time at each stop**: the shortest stay you want at each stopover, from a quick connection up
  to 3 nights.
- One slider ranks every option, the direct flight included, from **cheapest** to **most new
  countries**. Countries you've already been to don't count, and well-known stopover cities
  (Istanbul, Dubai, Singapore…) get a small boost.
- Totals can include a rough hotel cost for each night at a stop and, if you're taking a hold
  bag, typical bag fees on budget airlines.
- Quick-start presets set everything in one tap. The search is kept in the URL, so the Share
  button gives a link that opens the same search.

## Where routes come from

- **Without prices**, stopover routes come from a 2014 OpenFlights route snapshot, so some may no
  longer run. Russia, Belarus and Ukraine are never suggested as stopovers.
- **With prices on**, the app also asks where you can fly cheaply from your origin, and from where
  cheaply on to your destination. Cities on both lists become extra stopover routes. Routes where
  nobody has priced a flight lately are hidden behind a "show" button, because they probably
  don't run.
- Prices are looked up by city (LON covers all six London airports). City names come from
  `places.js`, which is built from Travelpayouts' public data by `scripts/build-places.js`.

## How prices work

The map and route search run entirely in the browser. Prices come from a small backend
(`api/prices.js`) that looks up each flight using the
[Travelpayouts / Aviasales Data API](https://support.travelpayouts.com/hc/en-us/articles/203956163).

- For every flight, it looks up fares across all the days that could fit your time budget.
  The app then picks the cheapest set of dates for each route.
- These are **recently seen fares** (cached from real Aviasales searches), not a live quote.
  That makes them cheap enough to check dozens of split routes at once. Users still confirm
  the price via the Google / Skyscanner / Aviasales links before booking.
- If no route can start on your exact departure day, the first flight can move up to 3 days
  either way. This is marked on the card.
- Typing a price into any box overrides the looked-up price. Clearing the box brings it back.
- With no backend or no token, the app falls back to typing prices in by hand.

## Setup

1. Create a free account at [travelpayouts.com](https://www.travelpayouts.com/), join the
   Aviasales programme and copy your **API token** (and optionally your **partner marker**,
   which adds affiliate tracking to the "Book on Aviasales" links).
2. Run locally (Node 18+):
   ```bash
   TRAVELPAYOUTS_TOKEN=your_token npm run dev
   ```
   then open http://localhost:3000.
3. Deploy to [Vercel](https://vercel.com/): import the repo with no build settings, then add
   these environment variables:
   - `TRAVELPAYOUTS_TOKEN` (required)
   - `TRAVELPAYOUTS_MARKER` (optional, for affiliate links)
   - `ALLOWED_ORIGIN` (optional, restricts which site may call the API)

   The `api/` folder becomes the `/api/prices` endpoint automatically.

To keep the site on GitHub Pages and host only the API on Vercel, add this line to
`index.html` before `script.js`:
```html
<script>window.PRICE_API_URL = "https://your-app.vercel.app/api/prices";</script>
```

## Map

Esri satellite imagery (or a light map, switchable from the top-right) needs no API key. The
licence attribution is kept but shrunk to one line that expands on hover.

## Tests

```bash
npm test
```
