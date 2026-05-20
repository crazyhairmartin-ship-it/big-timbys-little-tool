/* One-time price-history backfill.

   For each tracked recipe item, fetches the wiki /timeseries (1h step,
   ~15 days) and writes the points into the recorder's per-day prices/
   files — merging with whatever the hourly recorder has already captured,
   never overwriting it. This seeds the price-history store so it starts
   ~15 days deep instead of empty.

   Run by .github/workflows/backfill-prices.yml. The tracked item-id list
   is passed as a JSON-file argument (the workflow extracts it from
   dist/app.js, which doesn't exist on the price-history branch).

   Usage: node backfill-prices.mjs <ids.json> */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";

const UA = "big-timbys-little-tool price-recorder (github.com/crazyhairmartin-ship-it/big-timbys-little-tool)";
const DIR = "prices";
const CONCURRENCY = 5;

const idsFile = process.argv[2];
if (!idsFile) { console.error("usage: node backfill-prices.mjs <ids.json>"); process.exit(1); }
const ids = JSON.parse(readFileSync(idsFile, "utf8"));

async function fetchSeries(id) {
  try {
    const r = await fetch(
      `https://prices.runescape.wiki/api/v1/osrs/timeseries?id=${id}&timestep=1h`,
      { headers: { "User-Agent": UA } });
    if (!r.ok) return null;
    const j = await r.json();
    return Array.isArray(j.data) ? j.data : null;
  } catch (_) {
    return null;
  }
}

async function throttle(items, limit, worker) {
  const queue = items.slice();
  await Promise.all(Array.from({ length: limit }, async () => {
    while (queue.length) await worker(queue.shift());
  }));
}

mkdirSync(DIR, { recursive: true });

// Lazily load each day-file once (merge target), keyed by YYYY-MM-DD.
const dayCache = {};
function dayFile(day) {
  if (!dayCache[day]) {
    const f = `${DIR}/${day}.json`;
    dayCache[day] = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : { date: day, hours: {} };
  }
  return dayCache[day];
}

let written = 0, failed = 0;
await throttle(ids, CONCURRENCY, async (id) => {
  const series = await fetchSeries(id);
  if (!series) { failed++; return; }
  for (const p of series) {
    const hi = p.avgHighPrice ?? null;
    const lo = p.avgLowPrice ?? null;
    if (hi == null && lo == null) continue;
    const d = new Date(p.timestamp * 1000);
    const day = d.toISOString().slice(0, 10);
    const hour = d.getUTCHours();
    const dd = dayFile(day);
    if (!dd.hours[hour]) dd.hours[hour] = {};
    // Never overwrite a value already captured (by the recorder or an
    // earlier backfill) — only fill gaps.
    if (!(id in dd.hours[hour])) { dd.hours[hour][id] = [hi, lo]; written++; }
  }
});

for (const [day, dd] of Object.entries(dayCache)) {
  writeFileSync(`${DIR}/${day}.json`, JSON.stringify(dd));
}

console.log(`backfill: ${ids.length} items (${failed} fetch failures) -> ` +
            `${Object.keys(dayCache).length} day-files, ${written} point-values written`);
