# Overnight Flipping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an "Overnight" mode that forecasts a predicted overnight buy price and daytime sell price for every tracked item, from each item's own ~15-day hourly price history.

**Architecture:** A pure-analytics module (`dist/overnight-core.js`) holds the math — hour-of-day profiling, global-window calibration, per-item price prediction, confidence, ranking — with no browser dependencies, so it is unit-tested under Node. A browser shell (`dist/overnight.js`) does the throttled API fetching, localStorage caching, and rendering, reusing `app.js`'s globals. `app.js` gains a top-level `state.mode` ("realtime" | "overnight") and `renderGrid()` delegates to the shell when in Overnight mode.

**Tech Stack:** Vanilla ES (no build step), classic `<script>` tags sharing global scope, OSRS Wiki real-time API, `node --test` (Node built-in) for unit tests, Playwright/manual browser checks for UI.

**Testing note:** Tasks 1–5 (pure math) are TDD with `node --test`. Tasks 6–10 (fetching, caching, UI) have no unit-test runner available in this static app — each instead has an explicit **Verify in browser** step with exact actions and expected results, run against `npm run serve` (http://localhost:8765).

**Data shapes (referenced throughout):**

- **Timeseries point** — from `/timeseries?id=X&timestep=1h`, the API returns `{ data: [ { timestamp, avgHighPrice, avgLowPrice, highPriceVolume, lowPriceVolume } ] }`. `timestamp` is unix **seconds**; `avgHighPrice`/`avgLowPrice` may be `null`.
- **`series`** — the raw `data` array of timeseries points for one item.
- **`windows`** — `{ buyHours: number[], sellHours: number[], globalCurve: number[24] }`. `buyHours`/`sellHours` are arrays of UTC hour indices (0–23).
- **`analysis`** — per item: `{ id, predBuy, predSell, profit, profitPct, confidence, score, curve }` where `curve` is `number[24]` (the item's own hour-of-day mean prices, nulls allowed).

---

## Task 1: Test harness + core module skeleton

**Files:**
- Create: `dist/overnight-core.js`
- Create: `test/overnight-core.test.js`
- Modify: `package.json` (scripts block)

- [ ] **Step 1: Create the core module skeleton**

Create `dist/overnight-core.js`:

```javascript
/* ---------------- Overnight analytics core ----------------
   Pure functions: no DOM, no globals, no fetch. Unit-tested under Node
   (`node --test`) and also loaded as a classic browser script, where the
   functions land in global scope for dist/overnight.js to call.
---------------------------------------------------------- */

// Tunable constants.
const OC_WINDOW_WIDTH = 6;     // hours in the buy / sell window
const OC_MIN_DAYS = 10;        // min distinct days of history to analyse an item
const OC_BASELINE_DAYS = 3;    // recent window the prediction is anchored to
const OC_CONFIDENCE_FLOOR = 0.55; // below this, no genuine recurring pattern

// Representative price for one timeseries point: mid of avg high/low.
function ocMidPrice(point) {
  const h = point.avgHighPrice, l = point.avgLowPrice;
  if (h != null && l != null) return (h + l) / 2;
  if (h != null) return h;
  if (l != null) return l;
  return null;
}

// ---- functions added in later tasks ----

// Node test harness can require() this; browsers skip the guard.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    OC_WINDOW_WIDTH, OC_MIN_DAYS, OC_BASELINE_DAYS, OC_CONFIDENCE_FLOOR,
    ocMidPrice,
  };
}
```

- [ ] **Step 2: Create the test file**

Create `test/overnight-core.test.js`:

```javascript
const test = require("node:test");
const assert = require("node:assert");
const core = require("../dist/overnight-core.js");

test("ocMidPrice averages high and low", () => {
  assert.strictEqual(core.ocMidPrice({ avgHighPrice: 100, avgLowPrice: 80 }), 90);
});

test("ocMidPrice falls back to whichever side is present", () => {
  assert.strictEqual(core.ocMidPrice({ avgHighPrice: 100, avgLowPrice: null }), 100);
  assert.strictEqual(core.ocMidPrice({ avgHighPrice: null, avgLowPrice: 80 }), 80);
});

test("ocMidPrice returns null when both sides missing", () => {
  assert.strictEqual(core.ocMidPrice({ avgHighPrice: null, avgLowPrice: null }), null);
});
```

- [ ] **Step 3: Add the test script to package.json**

In `package.json`, add to the `scripts` block (after `"serve"`):

```json
    "serve": "cd dist && python3 -m http.server 8765",
    "test": "node --test test/"
```

(Add a comma after the `serve` line.)

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: 3 tests pass, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add dist/overnight-core.js test/overnight-core.test.js package.json
git commit -m "Add overnight analytics core skeleton + node:test harness"
```

---

## Task 2: Hour-of-day profile

Builds a 24-element curve of mean price per UTC hour from one item's series.

**Files:**
- Modify: `dist/overnight-core.js`
- Modify: `test/overnight-core.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `test/overnight-core.test.js`:

```javascript
test("hourlyProfile buckets points by UTC hour", () => {
  // Two points at 03:00 UTC (prices 100, 120) -> hour 3 mean = 110.
  // One point at 15:00 UTC (price 200) -> hour 15 = 200.
  const at = (h, price) => ({
    timestamp: Math.floor(Date.UTC(2026, 0, 1, h) / 1000),
    avgHighPrice: price, avgLowPrice: price,
  });
  const curve = core.hourlyProfile([at(3, 100), at(3, 120), at(15, 200)]);
  assert.strictEqual(curve.length, 24);
  assert.strictEqual(curve[3], 110);
  assert.strictEqual(curve[15], 200);
  assert.strictEqual(curve[4], null); // no data -> null
});

test("hourlyProfile ignores points with no usable price", () => {
  const ts = Math.floor(Date.UTC(2026, 0, 1, 8) / 1000);
  const curve = core.hourlyProfile([
    { timestamp: ts, avgHighPrice: null, avgLowPrice: null },
    { timestamp: ts, avgHighPrice: 50, avgLowPrice: 50 },
  ]);
  assert.strictEqual(curve[8], 50);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `core.hourlyProfile is not a function`.

- [ ] **Step 3: Implement `hourlyProfile`**

In `dist/overnight-core.js`, replace the `// ---- functions added in later tasks ----` line with:

```javascript
// 24-element curve: mean midPrice per UTC hour-of-day, null for empty hours.
function hourlyProfile(series) {
  const sums = new Array(24).fill(0);
  const counts = new Array(24).fill(0);
  for (const point of series) {
    const price = ocMidPrice(point);
    if (price == null) continue;
    const hour = new Date(point.timestamp * 1000).getUTCHours();
    sums[hour] += price;
    counts[hour] += 1;
  }
  return sums.map((s, h) => (counts[h] > 0 ? s / counts[h] : null));
}

// ---- functions added in later tasks ----
```

- [ ] **Step 4: Export `hourlyProfile`**

In the `module.exports` object in `dist/overnight-core.js`, add `hourlyProfile`:

```javascript
  module.exports = {
    OC_WINDOW_WIDTH, OC_MIN_DAYS, OC_BASELINE_DAYS, OC_CONFIDENCE_FLOOR,
    ocMidPrice, hourlyProfile,
  };
```

- [ ] **Step 5: Run tests and commit**

Run: `npm test` — expected: all 5 tests pass.

```bash
git add dist/overnight-core.js test/overnight-core.test.js
git commit -m "Add hourlyProfile to overnight core"
```

---

## Task 3: Curve normalisation + global window calibration

**Files:**
- Modify: `dist/overnight-core.js`
- Modify: `test/overnight-core.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `test/overnight-core.test.js`:

```javascript
test("normalizeCurve divides by the mean of non-null entries", () => {
  const curve = new Array(24).fill(null);
  curve[0] = 50; curve[1] = 150; // mean of present entries = 100
  const norm = core.normalizeCurve(curve);
  assert.strictEqual(norm[0], 0.5);
  assert.strictEqual(norm[1], 1.5);
  assert.strictEqual(norm[2], null);
});

test("calibrateWindows finds lowest and highest 6h blocks", () => {
  // Build one normalized curve: cheapest around hours 2-7, dearest around 14-19.
  const curve = new Array(24);
  for (let h = 0; h < 24; h++) {
    if (h >= 2 && h < 8) curve[h] = 0.8;
    else if (h >= 14 && h < 20) curve[h] = 1.2;
    else curve[h] = 1.0;
  }
  const w = core.calibrateWindows([curve], 6);
  assert.deepStrictEqual([...w.buyHours].sort((a, b) => a - b), [2, 3, 4, 5, 6, 7]);
  assert.deepStrictEqual([...w.sellHours].sort((a, b) => a - b), [14, 15, 16, 17, 18, 19]);
  assert.strictEqual(w.globalCurve.length, 24);
});

test("calibrateWindows window can wrap past hour 23", () => {
  const curve = new Array(24).fill(1.0);
  // cheapest block straddles midnight: hours 22,23,0,1,2,3
  for (const h of [22, 23, 0, 1, 2, 3]) curve[h] = 0.5;
  const w = core.calibrateWindows([curve], 6);
  assert.deepStrictEqual([...w.buyHours].sort((a, b) => a - b), [0, 1, 2, 3, 22, 23]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `core.normalizeCurve is not a function`.

- [ ] **Step 3: Implement `normalizeCurve` and `calibrateWindows`**

In `dist/overnight-core.js`, above the `// ---- functions added in later tasks ----` line, add:

```javascript
// Divide each non-null hour by the curve's own mean -> values around 1.0.
function normalizeCurve(curve) {
  const present = curve.filter(v => v != null);
  if (!present.length) return curve.slice();
  const mean = present.reduce((a, b) => a + b, 0) / present.length;
  return curve.map(v => (v == null ? null : v / mean));
}

// Average many normalized curves into one global curve, then slide a
// `width`-hour window (wrapping past 23) to find the lowest-mean block
// (buy window) and highest-mean block (sell window).
function calibrateWindows(normalizedCurves, width = OC_WINDOW_WIDTH) {
  const globalCurve = new Array(24);
  for (let h = 0; h < 24; h++) {
    let sum = 0, count = 0;
    for (const c of normalizedCurves) {
      if (c[h] != null) { sum += c[h]; count += 1; }
    }
    globalCurve[h] = count > 0 ? sum / count : 1.0;
  }
  let lowStart = 0, highStart = 0;
  let lowMean = Infinity, highMean = -Infinity;
  for (let start = 0; start < 24; start++) {
    let sum = 0;
    for (let i = 0; i < width; i++) sum += globalCurve[(start + i) % 24];
    const mean = sum / width;
    if (mean < lowMean) { lowMean = mean; lowStart = start; }
    if (mean > highMean) { highMean = mean; highStart = start; }
  }
  const block = start => Array.from({ length: width }, (_, i) => (start + i) % 24);
  return { buyHours: block(lowStart), sellHours: block(highStart), globalCurve };
}
```

- [ ] **Step 4: Export the new functions**

Add `normalizeCurve, calibrateWindows` to the `module.exports` object.

- [ ] **Step 5: Run tests and commit**

Run: `npm test` — expected: all 8 tests pass.

```bash
git add dist/overnight-core.js test/overnight-core.test.js
git commit -m "Add curve normalisation + window calibration to overnight core"
```

---

## Task 4: Per-item price prediction

**Files:**
- Modify: `dist/overnight-core.js`
- Modify: `test/overnight-core.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `test/overnight-core.test.js`:

```javascript
// Helper: build a series spanning `days` days, one point per hour, where
// the price depends only on the hour-of-day via priceForHour(hour).
function buildSeries(days, priceForHour) {
  const series = [];
  const start = Date.UTC(2026, 0, 1, 0);
  for (let d = 0; d < days; d++) {
    for (let h = 0; h < 24; h++) {
      const ts = Math.floor((start + (d * 24 + h) * 3600 * 1000) / 1000);
      const p = priceForHour(h);
      series.push({ timestamp: ts, avgHighPrice: p, avgLowPrice: p });
    }
  }
  return series;
}

test("medianOf returns the middle value", () => {
  assert.strictEqual(core.medianOf([3, 1, 2]), 2);
  assert.strictEqual(core.medianOf([4, 1, 3, 2]), 2.5);
});

test("predictPrices anchors ratios to the recent baseline", () => {
  // Hours 0-5 cost 80, hours 12-17 cost 120, everything else 100.
  const series = buildSeries(14, h => {
    if (h < 6) return 80;
    if (h >= 12 && h < 18) return 120;
    return 100;
  });
  const windows = { buyHours: [0, 1, 2, 3, 4, 5], sellHours: [12, 13, 14, 15, 16, 17] };
  const p = core.predictPrices(series, windows);
  // baseline = recent median of all hours. overnightRatio = 80/median.
  assert.ok(p.predBuy < p.predSell, "buy should be below sell");
  assert.ok(Math.abs(p.predBuy - 80) < 5, `predBuy ~80, got ${p.predBuy}`);
  assert.ok(Math.abs(p.predSell - 120) < 5, `predSell ~120, got ${p.predSell}`);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `core.medianOf is not a function`.

- [ ] **Step 3: Implement `medianOf`, `windowPrices`, `recentBaseline`, `predictPrices`**

In `dist/overnight-core.js`, above `// ---- functions added in later tasks ----`, add:

```javascript
// Median of a numeric array (non-mutating). Returns null if empty.
function medianOf(values) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// midPrices of the points whose UTC hour is in `hours`.
function windowPrices(series, hours) {
  const set = new Set(hours);
  const out = [];
  for (const point of series) {
    const price = ocMidPrice(point);
    if (price == null) continue;
    if (set.has(new Date(point.timestamp * 1000).getUTCHours())) out.push(price);
  }
  return out;
}

// Median midPrice of the points within the last `days` days of the series.
function recentBaseline(series, days = OC_BASELINE_DAYS) {
  if (!series.length) return null;
  let maxTs = 0;
  for (const p of series) if (p.timestamp > maxTs) maxTs = p.timestamp;
  const cutoff = maxTs - days * 24 * 3600;
  const recent = [];
  for (const p of series) {
    if (p.timestamp < cutoff) continue;
    const price = ocMidPrice(p);
    if (price != null) recent.push(price);
  }
  return medianOf(recent);
}

// Predicted overnight buy + daytime sell, ratios anchored to recent baseline.
function predictPrices(series, windows) {
  const baseline = recentBaseline(series);
  const allPrices = [];
  for (const p of series) {
    const price = ocMidPrice(p);
    if (price != null) allPrices.push(price);
  }
  const allMedian = medianOf(allPrices);
  if (baseline == null || allMedian == null || allMedian === 0) {
    return { predBuy: null, predSell: null };
  }
  const overnightRatio = medianOf(windowPrices(series, windows.buyHours)) / allMedian;
  const daytimeRatio = medianOf(windowPrices(series, windows.sellHours)) / allMedian;
  return {
    predBuy: baseline * overnightRatio,
    predSell: baseline * daytimeRatio,
  };
}
```

- [ ] **Step 4: Export the new functions**

Add `medianOf, windowPrices, recentBaseline, predictPrices` to `module.exports`.

- [ ] **Step 5: Run tests and commit**

Run: `npm test` — expected: all 11 tests pass.

```bash
git add dist/overnight-core.js test/overnight-core.test.js
git commit -m "Add price prediction to overnight core"
```

---

## Task 5: Confidence, profit, ranking, and the analyzeItem entry point

**Files:**
- Modify: `dist/overnight-core.js`
- Modify: `test/overnight-core.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `test/overnight-core.test.js`:

```javascript
test("confidenceOf is 1.0 when buy hours are always below sell hours", () => {
  const series = buildSeries(14, h => (h < 6 ? 80 : 120));
  const windows = { buyHours: [0, 1, 2, 3, 4, 5], sellHours: [12, 13, 14, 15, 16, 17] };
  assert.strictEqual(core.confidenceOf(series, windows), 1);
});

test("confidenceOf is ~0.5 when the pattern holds on half the days", () => {
  // Even days: dip overnight. Odd days: flat (no dip).
  const start = Date.UTC(2026, 0, 1, 0);
  const series = [];
  for (let d = 0; d < 14; d++) {
    for (let h = 0; h < 24; h++) {
      const ts = Math.floor((start + (d * 24 + h) * 3600 * 1000) / 1000);
      const p = (d % 2 === 0 && h < 6) ? 80 : 100;
      series.push({ timestamp: ts, avgHighPrice: p, avgLowPrice: p });
    }
  }
  const windows = { buyHours: [0, 1, 2, 3, 4, 5], sellHours: [12, 13, 14, 15, 16, 17] };
  const c = core.confidenceOf(series, windows);
  assert.ok(c >= 0.45 && c <= 0.55, `expected ~0.5, got ${c}`);
});

test("predictedProfit nets the tax off the sale", () => {
  const noTax = () => 0;
  assert.strictEqual(core.predictedProfit(100, 150, noTax), 50);
  const tenPct = sell => sell * 0.1;
  assert.strictEqual(core.predictedProfit(100, 150, tenPct), 35); // 150 - 15 - 100
});

test("rankScore squares confidence", () => {
  assert.ok(Math.abs(core.rankScore(0.2, 0.5) - 0.05) < 1e-9);
  assert.ok(Math.abs(core.rankScore(0.1, 1.0) - 0.1) < 1e-9);
});

test("analyzeItem returns null for too-thin history", () => {
  const windows = { buyHours: [0, 1, 2, 3, 4, 5], sellHours: [12, 13, 14, 15, 16, 17] };
  const series = buildSeries(3, h => 100); // 3 days < OC_MIN_DAYS
  assert.strictEqual(core.analyzeItem(7, series, windows, () => 0), null);
});

test("analyzeItem produces a full analysis for a clean pattern", () => {
  const windows = { buyHours: [0, 1, 2, 3, 4, 5], sellHours: [12, 13, 14, 15, 16, 17] };
  const series = buildSeries(14, h => {
    if (h < 6) return 80;
    if (h >= 12 && h < 18) return 120;
    return 100;
  });
  const a = core.analyzeItem(7, series, windows, sell => sell * 0.02);
  assert.strictEqual(a.id, 7);
  assert.ok(a.predBuy < a.predSell);
  assert.strictEqual(a.confidence, 1);
  assert.ok(a.profit > 0);
  assert.ok(a.profitPct > 0);
  assert.ok(a.score > 0);
  assert.strictEqual(a.curve.length, 24);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `core.confidenceOf is not a function`.

- [ ] **Step 3: Implement the remaining core functions**

In `dist/overnight-core.js`, above `// ---- functions added in later tasks ----`, add:

```javascript
// UTC calendar day key "YYYY-MM-DD" for a unix-seconds timestamp.
function ocDayKey(tsSeconds) {
  return new Date(tsSeconds * 1000).toISOString().slice(0, 10);
}

// Fraction of days on which the buy-hours mean was below the sell-hours mean.
function confidenceOf(series, windows) {
  const buySet = new Set(windows.buyHours);
  const sellSet = new Set(windows.sellHours);
  const byDay = new Map(); // dayKey -> { buy:[], sell:[] }
  for (const point of series) {
    const price = ocMidPrice(point);
    if (price == null) continue;
    const hour = new Date(point.timestamp * 1000).getUTCHours();
    const key = ocDayKey(point.timestamp);
    let day = byDay.get(key);
    if (!day) { day = { buy: [], sell: [] }; byDay.set(key, day); }
    if (buySet.has(hour)) day.buy.push(price);
    if (sellSet.has(hour)) day.sell.push(price);
  }
  let evaluable = 0, good = 0;
  for (const day of byDay.values()) {
    if (!day.buy.length || !day.sell.length) continue;
    evaluable += 1;
    const buyMean = day.buy.reduce((a, b) => a + b, 0) / day.buy.length;
    const sellMean = day.sell.reduce((a, b) => a + b, 0) / day.sell.length;
    if (buyMean < sellMean) good += 1;
  }
  return evaluable > 0 ? good / evaluable : 0;
}

// Profit per unit: sale price, less GE tax on the sale, less the buy price.
function predictedProfit(buy, sell, taxFn) {
  return sell - taxFn(sell) - buy;
}

// Ranking score: profit% weighted by confidence-squared.
function rankScore(profitPct, confidence) {
  return profitPct * confidence * confidence;
}

// Count distinct UTC days present in a series.
function ocDistinctDays(series) {
  const days = new Set();
  for (const p of series) days.add(ocDayKey(p.timestamp));
  return days.size;
}

// Full per-item analysis. Returns null when history is too thin to trust.
// taxFn(sellPrice) -> gp of GE tax on that sale.
function analyzeItem(id, series, windows, taxFn) {
  if (ocDistinctDays(series) < OC_MIN_DAYS) return null;
  const { predBuy, predSell } = predictPrices(series, windows);
  if (predBuy == null || predSell == null || predBuy <= 0) return null;
  const profit = predictedProfit(predBuy, predSell, taxFn);
  const profitPct = profit / predBuy;
  const confidence = confidenceOf(series, windows);
  return {
    id,
    predBuy, predSell, profit, profitPct, confidence,
    score: rankScore(profitPct, confidence),
    curve: hourlyProfile(series),
  };
}
```

- [ ] **Step 4: Export the new functions**

Add `confidenceOf, predictedProfit, rankScore, analyzeItem` to `module.exports`.

- [ ] **Step 5: Run tests and commit**

Run: `npm test` — expected: all 17 tests pass.

```bash
git add dist/overnight-core.js test/overnight-core.test.js
git commit -m "Add confidence, profit, ranking + analyzeItem to overnight core"
```

---

## Task 6: Data layer — throttled fetch + analysis orchestration

Creates `dist/overnight.js`, the browser shell. This task adds fetching and
the analysis run; caching (Task 7) and rendering (Tasks 9–10) follow.

**Files:**
- Create: `dist/overnight.js`
- Modify: `dist/index.html` (script tags)

- [ ] **Step 1: Create `dist/overnight.js` with the data layer**

Create `dist/overnight.js`:

```javascript
/* ---------------- Overnight mode (browser shell) ----------------
   Fetches per-item hourly history, runs the overnight-core analytics,
   caches results, and renders the Overnight view. Loaded after app.js;
   reads app.js globals (state, RECIPES, api, geTax, fmtGp, el, iconUrl)
   by lexical name and the overnight-core functions from global scope.
------------------------------------------------------------------- */

const OVERNIGHT_MIN_VOLUME = 100;   // skip items trading < 100/24h — not flippable
const OVERNIGHT_FETCH_CONCURRENCY = 5;
const OVERNIGHT_CACHE_KEY = "osrs-combo-overnight";
const OVERNIGHT_CACHE_TTL_MS = 24 * 3600 * 1000;

// In-memory analysis result, mirrored to localStorage by Task 7.
let overnightData = null; // { analysedAt, windows, items: analysis[] , skipped:int }
let overnightRunning = false;

// Every distinct item id referenced by any recipe (product + components).
function overnightItemIds() {
  const ids = new Set();
  for (const r of RECIPES) {
    ids.add(r.id);
    for (const c of r.components) ids.add(c.id);
  }
  return [...ids];
}

// Run async `worker(item)` over `items`, at most `limit` in flight.
async function overnightThrottle(items, limit, worker) {
  const queue = items.slice();
  const runners = [];
  for (let i = 0; i < limit; i++) {
    runners.push((async () => {
      while (queue.length) {
        const item = queue.shift();
        await worker(item);
      }
    })());
  }
  await Promise.all(runners);
}

// Fetch ~15 days of hourly history for one item. Returns the series array
// or null on failure / empty.
async function overnightFetchSeries(id) {
  try {
    const series = await fetchTimeseries(id, "1h");
    return Array.isArray(series) && series.length ? series : null;
  } catch (_) {
    return null;
  }
}

// Full analysis run: fetch, calibrate global windows, analyse each item.
// `onProgress(done, total)` is called as fetches complete.
async function runOvernightAnalysis(onProgress) {
  const candidates = overnightItemIds().filter(id => {
    const vol = state.volumes[id];
    return vol != null && vol >= OVERNIGHT_MIN_VOLUME;
  });
  const seriesById = new Map();
  let done = 0;
  await overnightThrottle(candidates, OVERNIGHT_FETCH_CONCURRENCY, async (id) => {
    const series = await overnightFetchSeries(id);
    if (series) seriesById.set(id, series);
    done += 1;
    if (onProgress) onProgress(done, candidates.length);
  });

  // Calibrate global windows from every fetched item's normalized curve.
  const curves = [];
  for (const series of seriesById.values()) {
    curves.push(normalizeCurve(hourlyProfile(series)));
  }
  const windows = calibrateWindows(curves, OC_WINDOW_WIDTH);

  // Analyse each item; drop nulls (thin history / no discount).
  const items = [];
  for (const [id, series] of seriesById) {
    const a = analyzeItem(id, series, windows, geTax);
    if (a) items.push(a);
  }
  items.sort((a, b) => b.score - a.score);

  overnightData = {
    analysedAt: Date.now(),
    windows,
    items,
    skipped: candidates.length - seriesById.size,
  };
  return overnightData;
}

// Exposed entry points; app.js calls window.Overnight.*
window.Overnight = { runOvernightAnalysis };
```

- [ ] **Step 2: Add the script tags to index.html**

In `dist/index.html`, the single `<script src="app.js"></script>` line becomes three lines, in this order:

```html
<script src="overnight-core.js"></script>
<script src="app.js"></script>
<script src="overnight.js"></script>
```

- [ ] **Step 3: Verify in browser**

Run `npm run serve`, open http://localhost:8765, open DevTools console, run:

```javascript
await window.Overnight.runOvernightAnalysis((d, t) => console.log(d + "/" + t));
```

Expected: progress logs counting up; the call resolves to an object with
`analysedAt`, `windows` (with `buyHours`/`sellHours` arrays of 6 hours each),
and `items` (a sorted array of analyses). `items[0].score` is the largest.
No console errors.

- [ ] **Step 4: Commit**

```bash
git add dist/overnight.js dist/index.html
git commit -m "Add overnight data layer: throttled fetch + analysis run"
```

---

## Task 7: localStorage caching

**Files:**
- Modify: `dist/overnight.js`

- [ ] **Step 1: Add cache read/write + a cache-aware ensure function**

In `dist/overnight.js`, replace the final block (`window.Overnight = { runOvernightAnalysis };`) with:

```javascript
// Persist the computed analysis (not raw series) to localStorage.
function saveOvernightCache(data) {
  try {
    localStorage.setItem(OVERNIGHT_CACHE_KEY, JSON.stringify(data));
  } catch (_) { /* quota / disabled — cache is best-effort */ }
}

// Load a cached analysis, or null if absent / unparseable.
function loadOvernightCache() {
  try {
    const raw = localStorage.getItem(OVERNIGHT_CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

function overnightCacheAgeMs() {
  return overnightData ? Date.now() - overnightData.analysedAt : Infinity;
}

// Ensure analysis is available and fresh. Uses cache when < TTL old;
// otherwise runs a fresh analysis. `force` always re-runs.
async function ensureOvernightAnalysis(onProgress, force = false) {
  if (overnightRunning) return overnightData;
  if (!overnightData) overnightData = loadOvernightCache();
  const fresh = overnightData && Date.now() - overnightData.analysedAt < OVERNIGHT_CACHE_TTL_MS;
  if (fresh && !force) return overnightData;
  overnightRunning = true;
  try {
    const data = await runOvernightAnalysis(onProgress);
    saveOvernightCache(data);
    return data;
  } finally {
    overnightRunning = false;
  }
}

window.Overnight = {
  runOvernightAnalysis, ensureOvernightAnalysis,
  loadOvernightCache, overnightCacheAgeMs,
  get data() { return overnightData; },
  get running() { return overnightRunning; },
};
```

- [ ] **Step 2: Verify in browser**

Run `npm run serve`, open http://localhost:8765, console:

```javascript
await window.Overnight.ensureOvernightAnalysis();           // runs analysis
console.log(JSON.parse(localStorage.getItem("osrs-combo-overnight")).items.length);
await window.Overnight.ensureOvernightAnalysis();           // 2nd call — instant
console.log(window.Overnight.overnightCacheAgeMs());        // small number, < 60000
```

Expected: first call runs the fetch (progress visible if you pass a callback);
second call returns immediately (no network tab activity); the localStorage key
holds the analysis; cache age is a small positive number.

- [ ] **Step 3: Commit**

```bash
git add dist/overnight.js
git commit -m "Add localStorage caching for overnight analysis"
```

---

## Task 8: Mode × Format toggles

Adds `state.mode`, the Mode toggle UI, and makes `renderGrid()` mode-aware.

**Files:**
- Modify: `dist/app.js` (state object; `renderGrid`; init wiring)
- Modify: `dist/index.html` (mode toggle markup)
- Modify: `dist/index.css` (toggle styles)

- [ ] **Step 1: Add `state.mode` to the state object**

In `dist/app.js`, in the `state` object literal, immediately after the
`view:` line (`view: localStorage.getItem("osrs-combo-view") || "cards",`),
add:

```javascript
  mode: localStorage.getItem("osrs-combo-mode") || "realtime",
```

- [ ] **Step 2: Add the Mode toggle markup**

In `dist/index.html`, find the existing view toggle:

```html
    <div class="view-toggle">
      <button id="view-cards" class="vt-btn active" data-view="cards">Cards</button>
      <button id="view-table" class="vt-btn" data-view="table">Table</button>
    </div>
```

Immediately **before** that `<div class="view-toggle">`, add:

```html
    <div class="mode-toggle">
      <button id="mode-realtime" class="mode-btn active" data-mode="realtime">Real-time</button>
      <button id="mode-overnight" class="mode-btn" data-mode="overnight">Overnight</button>
    </div>
```

- [ ] **Step 3: Add toggle styles**

In `dist/index.css`, after the `.view-toggle` rule block, add:

```css
.mode-toggle {
  display: inline-flex;
  gap: 4px;
  margin-right: 12px;
  padding: 3px;
  background: var(--bg-2);
  border-radius: 8px;
}
.mode-btn {
  background: transparent;
  color: var(--text-1);
  border: none;
  border-radius: 6px;
  padding: 5px 12px;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
.mode-btn.active {
  background: var(--gold);
  color: #1a1205;
}
```

- [ ] **Step 4: Make `renderGrid` mode-aware**

In `dist/app.js`, at the very top of the `renderGrid` function body (before
`const grid = document.getElementById("grid");`), add:

```javascript
  if (state.mode === "overnight" && window.Overnight) { window.Overnight.renderOvernight(); return; }
```

The `&& window.Overnight` guard matters: `overnight.js` loads *after*
`app.js`, so the synchronous part of `init()` (which calls `renderGrid` via
`setView`) can run before `window.Overnight` exists. The guard makes that
first call fall through harmlessly to the realtime path (which is showing the
"Fetching..." loading state anyway); the real overnight render happens when
`refresh()` calls `renderGrid` again after its first `await`, by which point
`overnight.js` has executed.

- [ ] **Step 5: Wire the Mode toggle in `init()`**

In `dist/app.js`, find the view-toggle wiring (`document.getElementById("view-cards").addEventListener(...)`). Immediately after the line `setView(state.view);`, add:

```javascript
  const setMode = (m) => {
    state.mode = m;
    localStorage.setItem("osrs-combo-mode", m);
    document.getElementById("mode-realtime").classList.toggle("active", m === "realtime");
    document.getElementById("mode-overnight").classList.toggle("active", m === "overnight");
    renderGrid();
  };
  document.getElementById("mode-realtime").addEventListener("click", () => setMode("realtime"));
  document.getElementById("mode-overnight").addEventListener("click", () => setMode("overnight"));
  setMode(state.mode);
```

- [ ] **Step 6: Add a temporary `renderOvernight` stub**

So Task 8 is independently runnable, add a stub to `dist/overnight.js` — in
the `window.Overnight = { ... }` object, add one property:

```javascript
  renderOvernight() {
    const grid = document.getElementById("grid");
    grid.hidden = false;
    document.getElementById("table-wrap").hidden = true;
    grid.replaceChildren(el("div", { class: "loading", text: "Overnight mode — coming in Task 9" }));
  },
```

- [ ] **Step 7: Verify in browser**

Run `npm run serve`, open http://localhost:8765. Expected: a "Real-time /
Overnight" toggle appears left of the Cards/Table toggle. Clicking
**Overnight** shows the "coming in Task 9" placeholder; clicking **Real-time**
restores the recipe grid. Reload the page while on Overnight — it stays on
Overnight (persisted). No console errors.

- [ ] **Step 8: Commit**

```bash
git add dist/app.js dist/index.html dist/index.css dist/overnight.js
git commit -m "Add Mode toggle (Real-time / Overnight), persisted + mode-aware renderGrid"
```

---

## Task 9: Overnight cards + mode header

Replaces the Task 8 stub with the real Overnight render path.

**Files:**
- Modify: `dist/overnight.js`
- Modify: `dist/index.css`

- [ ] **Step 1: Implement the render functions**

In `dist/overnight.js`, replace the `renderOvernight()` stub property in the
`window.Overnight` object with `renderOvernight: renderOvernight` and add these
functions above the `window.Overnight = {...}` block:

```javascript
// Format an hour list like [22,23,0,1,2,3] as "22:00-04:00 UTC".
function overnightWindowLabel(hours) {
  const start = hours.reduce((a, b) => Math.min(a, b), 24);
  // hours are contiguous mod 24; find the true start (the hour whose
  // predecessor is absent) so a wrapping window reads correctly.
  const set = new Set(hours);
  let s = hours[0];
  for (const h of hours) if (!set.has((h + 23) % 24)) s = h;
  const end = (s + hours.length) % 24;
  const pad = h => String(h).padStart(2, "0") + ":00";
  return `${pad(s)}-${pad(end)} UTC`;
}

// A tiny 24-bar sparkline of an item's hour-of-day curve, buy/sell shaded.
function overnightSparkline(curve, windows) {
  const wrap = el("div", { class: "ov-spark" });
  const vals = curve.filter(v => v != null);
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = max - min || 1;
  const buy = new Set(windows.buyHours), sell = new Set(windows.sellHours);
  for (let h = 0; h < 24; h++) {
    const v = curve[h];
    const bar = el("div", { class: "ov-spark-bar" });
    bar.style.height = v == null ? "2px" : `${4 + Math.round(((v - min) / span) * 22)}px`;
    if (buy.has(h)) bar.classList.add("buy");
    else if (sell.has(h)) bar.classList.add("sell");
    wrap.appendChild(bar);
  }
  return wrap;
}

// One Overnight card for an analysis result.
function overnightCard(a, windows) {
  const m = state.mapping[a.id];
  const name = m?.name || `#${a.id}`;
  const card = el("article", { class: "card ov-card " + (a.profit > 0 ? "profit" : "loss") });

  const img = el("img", { attrs: { alt: "", loading: "lazy", src: iconUrl(a.id) } });
  img.onerror = () => { img.style.display = "none"; };
  const iconBox = el("div", { class: "card-icon" }, img);
  const confChip = el("span", {
    class: "skill-chip", text: `${Math.round(a.confidence * 100)}% reliable`,
  });
  const title = el("div", { class: "card-title" },
    el("div", { class: "card-name", text: name }),
    el("div", { class: "card-cat-row" }, confChip));
  const head = el("div", { class: "card-head" }, iconBox, title);

  const heroVal = el("div", {
    class: "card-hero-value " + (a.profit > 0 ? "pos" : "neg"),
    text: `${a.profitPct >= 0 ? "+" : ""}${(a.profitPct * 100).toFixed(1)}%`,
  });
  const hero = el("div", { class: "card-hero" },
    el("div", { class: "card-hero-label", text: "Predicted profit" }),
    heroVal,
    el("div", { class: "card-hero-sub", text: `${fmtGp(a.profit)} / unit` }));

  // Reuse app.js's row() helper so the rows match the existing card styling.
  const stats = el("div", { class: "components" });
  row(stats, { label: "Predicted buy", value: fmtGp(a.predBuy) });
  row(stats, { label: "Predicted sell", value: fmtGp(a.predSell) });

  card.append(head, hero, stats, overnightSparkline(a.curve, windows));
  card.onclick = () => openOvernightModal(a, windows);
  return card;
}

// Header strip: windows, freshness, refresh, or a progress bar mid-analysis.
function overnightHeader(progress) {
  const bar = el("div", { class: "ov-header" });
  if (progress) {
    bar.appendChild(el("span", { class: "ov-progress",
      text: `Analysing ${progress.done} / ${progress.total} items...` }));
    return bar;
  }
  const d = overnightData;
  const ageMin = Math.round(window.Overnight.overnightCacheAgeMs() / 60000);
  bar.appendChild(el("span", { class: "ov-windows",
    text: `Buy ${overnightWindowLabel(d.windows.buyHours)} - Sell ${overnightWindowLabel(d.windows.sellHours)}` }));
  bar.appendChild(el("span", { class: "ov-meta",
    text: `Analysed ${ageMin}m ago - ${d.items.length} items` +
          (d.skipped ? ` - ${d.skipped} skipped` : "") }));
  const refresh = el("button", { class: "ov-refresh", text: "⟳", attrs: { title: "Re-analyse" } });
  refresh.onclick = async () => {
    await window.Overnight.ensureOvernightAnalysis(p => paintOvernight(p), true);
    paintOvernight();
  };
  bar.appendChild(refresh);
  return bar;
}

// Apply the sidebar search + cost-range filters to the analysis list.
function overnightVisible() {
  const f = state.filters;
  const q = f.search.toLowerCase().trim();
  return overnightData.items.filter(a => {
    if (a.confidence < OC_CONFIDENCE_FLOOR) return false;
    const name = (state.mapping[a.id]?.name || "").toLowerCase();
    if (q && !name.includes(q)) return false;
    if (f.minCost !== null && a.predBuy < f.minCost) return false;
    if (f.maxCost !== null && a.predBuy > f.maxCost) return false;
    return true;
  });
}

// Paint the grid for Overnight mode. With `progress`, shows the progress bar.
function paintOvernight(progress) {
  const grid = document.getElementById("grid");
  grid.hidden = false;
  document.getElementById("table-wrap").hidden = true;
  grid.replaceChildren(overnightHeader(progress));
  if (progress) return;
  const visible = overnightVisible();
  if (!visible.length) {
    grid.appendChild(el("div", { class: "empty", text: "No overnight opportunities match the filters." }));
    return;
  }
  const wrap = el("div", { class: "grid ov-grid" });
  for (const a of visible) wrap.appendChild(overnightCard(a, overnightData.windows));
  grid.appendChild(wrap);
}

// Entry point called by app.js renderGrid() when state.mode === "overnight".
function renderOvernight() {
  // Seed overnightData from cache BEFORE painting — paintOvernight() with no
  // progress arg reads overnightData and would throw if it were still null.
  if (!overnightData) overnightData = window.Overnight.loadOvernightCache();
  if (overnightData) paintOvernight();
  else paintOvernight({ done: 0, total: 1 });
  // Refresh in the background; only show the progress bar if we had nothing
  // cached to display in the meantime.
  window.Overnight.ensureOvernightAnalysis(p => {
    if (!overnightData) paintOvernight(p);
  }).then(() => {
    if (state.mode === "overnight") paintOvernight();
  });
}
```

- [ ] **Step 2: Add a temporary `openOvernightModal` stub**

`overnightCard` references `openOvernightModal` (built in Task 10). Add a stub
above `renderOvernight` so Task 9 runs standalone:

```javascript
function openOvernightModal(a, windows) { /* implemented in Task 10 */ }
```

- [ ] **Step 3: Add Overnight styles**

In `dist/index.css`, append:

```css
.ov-header {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  padding: 10px 14px;
  margin-bottom: 14px;
  background: var(--bg-1);
  border: 1px solid var(--line);
  border-radius: 10px;
  font-size: 13px;
}
.ov-windows { font-weight: 700; color: var(--gold); }
.ov-meta { color: var(--text-2); }
.ov-progress { color: var(--text-1); font-weight: 600; }
.ov-refresh {
  margin-left: auto;
  background: var(--bg-2);
  color: var(--text-1);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 3px 9px;
  cursor: pointer;
}
.ov-spark {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  height: 28px;
  margin-top: 10px;
}
.ov-spark-bar {
  flex: 1;
  background: var(--line-2);
  border-radius: 1px;
}
.ov-spark-bar.buy  { background: #4ade80; }
.ov-spark-bar.sell { background: #f5c518; }
```

- [ ] **Step 4: Verify in browser**

Run `npm run serve`, open http://localhost:8765, click **Overnight**.
Expected: a progress bar ("Analysing N / M items..."), then a header strip
showing the buy/sell windows + freshness + a ⟳ button, then a grid of
Overnight cards. Each card shows item icon + name, a "% reliable" chip, a
"Predicted profit" hero with profit %, predicted buy/sell rows, and a 24-bar
sparkline with green (buy) and gold (sell) bars. Type in the sidebar search —
the card list filters. Click ⟳ — it re-analyses. No console errors.

- [ ] **Step 5: Commit**

```bash
git add dist/overnight.js dist/index.css
git commit -m "Add Overnight cards, header, and sparkline rendering"
```

---

## Task 10: Overnight detail modal

Clicking an Overnight card opens a modal with the full 24-hour profile curve.
The realtime modal's chart controls (timeframe buttons, refresh, legend) are
irrelevant here, so the overnight modal hides them via an `overnight-mode`
class on the dialog.

**Files:**
- Modify: `dist/overnight.js`
- Modify: `dist/index.css`
- Modify: `dist/app.js` (one line in `openModal` to clear the class)

- [ ] **Step 1: Implement the modal**

In `dist/overnight.js`, replace the `openOvernightModal` stub with:

```javascript
// Draw the item's 24h profile curve onto a canvas, buy/sell windows shaded.
function drawOvernightCurve(canvas, curve, windows) {
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height, pad = 28;
  ctx.clearRect(0, 0, W, H);
  const vals = curve.filter(v => v != null);
  if (!vals.length) return;
  const min = Math.min(...vals), max = Math.max(...vals), span = max - min || 1;
  const x = h => pad + (h / 23) * (W - 2 * pad);
  const y = v => H - pad - ((v - min) / span) * (H - 2 * pad);

  // Shade buy (green) and sell (gold) windows.
  const shade = (hours, colour) => {
    ctx.fillStyle = colour;
    for (const h of hours) ctx.fillRect(x(h) - (W - 2 * pad) / 46, pad, (W - 2 * pad) / 23, H - 2 * pad);
  };
  shade(windows.buyHours, "rgba(74,222,128,0.14)");
  shade(windows.sellHours, "rgba(245,197,24,0.14)");

  // The curve.
  ctx.beginPath();
  let started = false;
  for (let h = 0; h < 24; h++) {
    if (curve[h] == null) continue;
    const px = x(h), py = y(curve[h]);
    if (started) ctx.lineTo(px, py); else { ctx.moveTo(px, py); started = true; }
  }
  ctx.strokeStyle = "#9ca3af";
  ctx.lineWidth = 2;
  ctx.stroke();
}

// Modal: full-size 24h profile + predicted prices. Reuses #chart-modal.
function openOvernightModal(a, windows) {
  const m = state.mapping[a.id];
  const modal = document.getElementById("chart-modal");
  modal.classList.add("overnight-mode"); // CSS hides the realtime chart controls
  document.getElementById("modal-title").textContent = m?.name || `#${a.id}`;
  document.getElementById("modal-links").replaceChildren();
  document.getElementById("chart-tabs").replaceChildren();
  document.getElementById("modal-status").textContent =
    `${Math.round(a.confidence * 100)}% reliable`;

  const canvas = document.getElementById("modal-chart");
  drawOvernightCurve(canvas, a.curve, windows);

  const detail = document.getElementById("modal-detail");
  const row = (label, value) => el("tr", {}, el("td", { text: label }), el("td", { text: value }));
  detail.replaceChildren(
    row("Predicted buy", fmtGp(a.predBuy)),
    row("Predicted sell", fmtGp(a.predSell)),
    row("Profit / unit", fmtGp(a.profit)),
    row("Profit %", `${(a.profitPct * 100).toFixed(1)}%`),
    row("Confidence", `${Math.round(a.confidence * 100)}%`),
    row("Buy window", overnightWindowLabel(windows.buyHours)),
    row("Sell window", overnightWindowLabel(windows.sellHours)),
  );
  if (typeof modal.showModal === "function") modal.showModal();
  else modal.setAttribute("open", "");
}
```

- [ ] **Step 2: Hide the realtime chart controls in overnight mode (CSS)**

In `dist/index.css`, append:

```css
#chart-modal.overnight-mode .timeframe-buttons,
#chart-modal.overnight-mode #modal-refresh,
#chart-modal.overnight-mode .modal-legend { display: none; }
```

- [ ] **Step 3: Clear the class when the realtime modal opens (app.js)**

In `dist/app.js`, in the `openModal` function, immediately after the line
`activeModalRecipe = recipe;`, add:

```javascript
  document.getElementById("chart-modal").classList.remove("overnight-mode");
```

This ensures a realtime recipe modal opened after an overnight modal shows
its timeframe buttons / legend normally.

- [ ] **Step 4: Verify in browser**

Run `npm run serve`, open http://localhost:8765, click **Overnight**, then
click any Overnight card. Expected: the modal opens with the item name as
title, a "% reliable" status, a canvas showing the 24-hour price curve with
the buy window shaded green and the sell window shaded gold, and a detail
table listing predicted buy/sell, profit, profit %, confidence, and the two
window labels. The Year/Quarter/Month/Week/Day buttons and the chart legend
are **hidden**. Closing the modal (× or backdrop) works. Switch back to
Real-time mode and open a recipe card — the normal chart modal shows its
timeframe buttons and legend again (no regression). No console errors.

- [ ] **Step 5: Commit**

```bash
git add dist/overnight.js dist/index.css dist/app.js
git commit -m "Add Overnight detail modal with 24h profile curve"
```

---

## Task 11: GE buy-limit line on card and modal

The spec lists the GE buy limit as a secondary detail — it caps how many
units you can accumulate per night. Added last so the core feature is
verifiable first.

**Files:**
- Modify: `dist/overnight.js`

- [ ] **Step 1: Add the buy-limit row to the Overnight card**

In `dist/overnight.js`, in `overnightCard`, immediately after the
`row(stats, { label: "Predicted sell", ... })` line, add:

```javascript
  const limit = state.mapping[a.id]?.limit;
  if (limit != null) row(stats, { label: "GE buy limit", value: `${limit.toLocaleString()} / 4h` });
```

- [ ] **Step 2: Add the buy-limit row to the detail modal**

In `dist/overnight.js`, in `openOvernightModal`, immediately after the
`detail.replaceChildren( ... );` call, add:

```javascript
  const limit = m?.limit;
  if (limit != null) detail.appendChild(row("GE buy limit", `${limit.toLocaleString()} / 4h`));
```

(`m` and the local `row` helper are already in scope from earlier in the
function.)

- [ ] **Step 3: Verify in browser**

Run `npm run serve`, open http://localhost:8765, click **Overnight**.
Expected: cards now show a "GE buy limit — N / 4h" row beneath predicted
sell (only for items that have a limit). Open a card's modal — the detail
table has a matching "GE buy limit" row. No console errors.

- [ ] **Step 4: Commit**

```bash
git add dist/overnight.js
git commit -m "Show GE buy limit on Overnight cards and modal"
```

---

## Self-review notes

- **Spec coverage:** data-derived windows (Task 3 `calibrateWindows`);
  ratio-based trend-robust prediction (Task 4 `predictPrices`); confidence
  (Task 5 `confidenceOf`); ranking `profit% x confidence^2` with the
  confidence floor (Task 5 `rankScore`, Task 9 `overnightVisible`);
  Mode x Format with Real-time + Cards default (Task 8); Overnight cards +
  header + sparkline (Task 9); volume pre-filter + throttled fetch (Task 6);
  24h caching (Task 7); detail modal (Task 10); GE buy-limit line (Task 11);
  GE tax via `geTax` passed as `taxFn` (Task 6 `runOvernightAnalysis`).
  All spec sections map to a task.
- **Out of scope (per spec):** the broken Table view is not touched — the
  Overnight feature only renders cards; `renderGrid`'s table branch is
  unchanged. A future task can add an Overnight table format.
