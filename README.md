# Stopover Nomad

Find routes with extra stops that **cost less than one ticket** and **tick off more countries**.
For example, London → Abu Dhabi → Singapore → Hanoi might beat a direct London → Hanoi fare
and add two countries to your list.

## How prices work

The map and route search run entirely in the browser. Prices come from a small backend
(`api/prices.js`) that looks up each flight using the
[Travelpayouts / Aviasales Data API](https://support.travelpayouts.com/hc/en-us/articles/203956163).

- These are **recently seen fares** (cached from real Aviasales searches), not a live quote.
  That makes them cheap enough to check dozens of split routes at once. Users still confirm
  the price via the Google / Skyscanner / Aviasales links before booking.
- If a flight has no fare on the exact day, the cheapest within ±3 days is used and marked.
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

## Tests

```bash
npm test
```
