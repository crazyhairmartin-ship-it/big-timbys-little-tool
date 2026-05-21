/* Offline self-tuning of the Experimental prediction parameters.

   Walk-forward-backtests the prediction model over a grid of parameter
   combinations and writes the lowest-error set to the file given as the
   single argument. Run by .github/workflows/tune-params.yml, which then
   publishes that file as tuned-params.json on the price-history branch.

   If there is not enough history to backtest (fewer than MIN_SAMPLES scored
   days across all items), it writes nothing and exits 0 — the app keeps
   whatever was last published, or its built-in defaults.

   Usage: node tune-params.mjs <output-path> */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import core from "../dist/overnight-core.js";

const { dayFileToPoints, mergeSeries, backtestParams } = core;

const UA = "big-timbys-little-tool param-tuner (github.com/crazyhairmartin-ship-it/big-timbys-little-tool)";
const STORE_BASE = "https://raw.githubusercontent.com/crazyhairmartin-ship-it/big-timbys-little-tool/price-history/";
const TS_BASE = "https://prices.runescape.wiki/api/v1/osrs";
const CONCURRENCY = 5;
const MIN_SAMPLES = 200;          // below this, history is too thin to publish a result
const BASELINE_DAYS = [2, 3, 5, 7];
const TREND_DISCOUNT = [0, 0.25, 0.5, 0.75, 1.0];

const outPath = process.argv[2];
if (!outPath) { console.error("usage: node tune-params.mjs <output-path>"); process.exit(1); }

// GE tax: 2% of the sale, floored, capped at 5M, exempt below 100 gp.
// Mirrors geTax in dist/app.js.
function geTax(price) {
  if (!price || price < 100) return 0;
  return Math.min(Math.floor(price * 0.02), 5_000_000);
}

async function fetchJson(url) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA } });
    if (!r.ok) return null;
    return await r.json();
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

// Tracked item ids — the products and components of every recipe.
const here = dirname(fileURLToPath(import.meta.url));
const appSrc = readFileSync(join(here, "../dist/app.js"), "utf8");
const recipesLiteral = appSrc.match(/const RECIPES = \[[\s\S]*?\n\];/)[0];
const ids = [...new Set([...recipesLiteral.matchAll(/\bid:(\d+)/g)].map(m => Number(m[1])))];

// Recorded price-history store, fetched the same way the app fetches it.
const storeById = new Map();
const index = await fetchJson(STORE_BASE + "prices/index.json");
if (Array.isArray(index)) {
  await throttle(index, CONCURRENCY, async (day) => {
    const dayFile = await fetchJson(STORE_BASE + "prices/" + day + ".json");
    if (!dayFile) return;
    for (const { id, point } of dayFileToPoints(dayFile)) {
      let arr = storeById.get(id);
      if (!arr) { arr = []; storeById.set(id, arr); }
      arr.push(point);
    }
  });
}

// Per-item history: live /timeseries merged with the recorded store.
const seriesById = new Map();
await throttle(ids, CONCURRENCY, async (id) => {
  const j = await fetchJson(`${TS_BASE}/timeseries?id=${id}&timestep=1h`);
  const live = j && Array.isArray(j.data) ? j.data : [];
  const series = mergeSeries(storeById.get(id) || [], live);
  if (series.length) seriesById.set(id, series);
});

// Grid-search: sample-weighted mean error across all items, lowest wins.
let best = null;
for (const baselineDays of BASELINE_DAYS) {
  for (const trendDiscount of TREND_DISCOUNT) {
    let errSum = 0, samples = 0;
    for (const series of seriesById.values()) {
      const r = backtestParams(series, { baselineDays, trendDiscount }, geTax);
      if (r.error != null && r.samples > 0) { errSum += r.error * r.samples; samples += r.samples; }
    }
    if (samples === 0) continue;
    const score = errSum / samples;
    if (!best || score < best.score) best = { baselineDays, trendDiscount, score, samples };
  }
}

if (!best || best.samples < MIN_SAMPLES) {
  console.log(`tune: only ${best ? best.samples : 0} samples (< ${MIN_SAMPLES}) — no file written`);
  process.exit(0);
}

const result = {
  baselineDays: best.baselineDays,
  trendDiscount: best.trendDiscount,
  score: Number(best.score.toFixed(5)),
  samples: best.samples,
  tunedAt: new Date().toISOString(),
};
writeFileSync(outPath, JSON.stringify(result, null, 2));
console.log("tune: wrote " + outPath + " -> " + JSON.stringify(result));
