/* Hourly GE price recorder.

   Fetches the OSRS Wiki /1h endpoint and appends an hourly snapshot to a
   per-day JSON file under prices/. Run by .github/workflows/record-prices.yml
   on the `price-history` branch.

   Purpose: accumulate hourly price history beyond the wiki's ~15-day window.
   The app's Experimental mode reads these day-files (via prices/index.json)
   and merges them with the live wiki /timeseries.

   Day-files older than RETENTION_DAYS are pruned each run so the branch
   doesn't grow without bound. */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from "node:fs";

const ENDPOINT = "https://prices.runescape.wiki/api/v1/osrs/1h";
const UA = "big-timbys-little-tool price-recorder (github.com/crazyhairmartin-ship-it/big-timbys-little-tool)";
const DIR = "prices";
const RETENTION_DAYS = 90;

const res = await fetch(ENDPOINT, { headers: { "User-Agent": UA } });
if (!res.ok) {
  console.error(`fetch failed: ${res.status} ${res.statusText}`);
  process.exit(1);
}
const { data } = await res.json();
if (!data || typeof data !== "object") {
  console.error("unexpected response shape");
  process.exit(1);
}

// Compact snapshot — { itemId: [avgHighPrice, avgLowPrice] } — for items that
// actually traded this hour. Skipping zero-volume items drops the long tail
// of dead items and keeps each day-file small.
const snapshot = {};
let kept = 0;
for (const [id, p] of Object.entries(data)) {
  if ((p.highPriceVolume || 0) + (p.lowPriceVolume || 0) === 0) continue;
  snapshot[id] = [p.avgHighPrice ?? null, p.avgLowPrice ?? null];
  kept++;
}

const now = new Date();
const day = now.toISOString().slice(0, 10);   // YYYY-MM-DD (UTC)
const hour = now.getUTCHours();

mkdirSync(DIR, { recursive: true });
const file = `${DIR}/${day}.json`;
const dayData = existsSync(file)
  ? JSON.parse(readFileSync(file, "utf8"))
  : { date: day, hours: {} };
dayData.hours[hour] = snapshot;
writeFileSync(file, JSON.stringify(dayData));

// Matches only the YYYY-MM-DD.json day-files — never index.json.
const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.json$/;

// Prune day-files older than the retention window.
const cutoff = new Date(now.getTime() - RETENTION_DAYS * 86400000)
  .toISOString().slice(0, 10);
let pruned = 0;
for (const f of readdirSync(DIR)) {
  if (DAY_FILE.test(f) && f.slice(0, 10) < cutoff) {
    rmSync(`${DIR}/${f}`);
    pruned++;
  }
}

// Refresh prices/index.json — the sorted list of available day-files. The
// app reads this so it fetches exactly what exists instead of probing dates.
const days = readdirSync(DIR).filter(f => DAY_FILE.test(f)).map(f => f.slice(0, 10)).sort();
writeFileSync(`${DIR}/index.json`, JSON.stringify(days));

console.log(`recorded ${kept} items — ${day} hour ${hour} UTC ` +
            `(${days.length} day-files indexed` +
            (pruned ? `, pruned ${pruned}` : "") + ")");
