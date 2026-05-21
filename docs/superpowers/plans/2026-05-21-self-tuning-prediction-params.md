# Self-Tuning Prediction Parameters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An offline GitHub Action walk-forward-backtests the Experimental prediction model, grid-searches its two tunable parameters, and publishes the best set as `tuned-params.json`; the app reads it and predicts with the tuned values.

**Architecture:** The pure prediction functions in `dist/overnight-core.js` gain an explicit `baselineDays` argument (defaulting to today's constant) and a new pure `backtestParams` walk-forward scorer. A new Node script (`scripts/tune-params.mjs`) grid-searches with `backtestParams` and writes `tuned-params.json`; a new weekly workflow runs it and commits the file to the `price-history` branch. `dist/overnight.js` fetches that file and feeds the values into the analysis, falling back to defaults.

**Tech Stack:** Vanilla JS (zero-build static app), Node ESM scripts, `node --test`, GitHub Actions. Approved spec: `docs/superpowers/specs/2026-05-21-self-tuning-prediction-params-design.md`.

---

## Verification environment

`dist/overnight-core.js` is unit-tested with `node --test` (run from the repo root: `node --test`). `dist/app.js`/`dist/overnight.js` have no unit harness — verify those in a browser. The browser caches `overnight.js`/`app.js`, so **always serve on a fresh port** after editing:

```bash
cd "/Volumes/Public/runescape app/dist" && python3 -m http.server 8830
```

Bump the port on each re-verification. Work from `/Volumes/Public/runescape app`.

## File Structure

- `dist/overnight-core.js` — pure prediction module. Parameterize `predictPrices`/`analyzeItem`; add `backtestParams`. Already dual-mode (`module.exports`), so the Node script can import it.
- `dist/overnight.js` — browser shell. Add `overnightFetchTunedParams`; apply tuned values in `runOvernightAnalysis`.
- `test/overnight-core.test.js` — append unit tests for the parameterized functions and `backtestParams`.
- `scripts/tune-params.mjs` — **new.** Offline grid-search; writes `tuned-params.json`.
- `.github/workflows/tune-params.yml` — **new.** Weekly workflow; runs the script, commits the result to `price-history`.

Line numbers shift as edits land — anchor every edit to the quoted surrounding code.

---

## Task 1: Parameterize `predictPrices` and `analyzeItem`

**Files:**
- Modify: `dist/overnight-core.js`
- Test: `test/overnight-core.test.js`

- [ ] **Step 1: Write the failing test**

Append to the end of `test/overnight-core.test.js`:

```js
test("predictPrices honors the baselineDays argument", () => {
  // 14 days rising 100 -> 230 (+10/day, flat within each day). A short
  // baseline window anchors to recent (higher) prices; a long one averages
  // in older (lower) prices.
  const series = [];
  const start = Date.UTC(2026, 0, 1, 0) / 1000;
  for (let d = 0; d < 14; d++) {
    for (let h = 0; h < 24; h++) {
      const price = 100 + d * 10;
      series.push({ timestamp: start + (d * 24 + h) * 3600, avgHighPrice: price, avgLowPrice: price });
    }
  }
  const windows = { buyHours: [2], sellHours: [14] };
  const short = core.predictPrices(series, windows, 2);
  const long  = core.predictPrices(series, windows, 10);
  assert.ok(short.predBuy > long.predBuy,
    `short baseline anchors higher on a rising series: ${short.predBuy} vs ${long.predBuy}`);
  // Default argument reproduces the explicit OC_BASELINE_DAYS call.
  assert.deepStrictEqual(core.predictPrices(series, windows),
                         core.predictPrices(series, windows, core.OC_BASELINE_DAYS));
  // analyzeItem accepts and forwards the new 5th argument.
  assert.ok(core.analyzeItem("x", series, windows, () => 0, 2) != null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test`
Expected: the new test fails — `predictPrices` currently ignores a 3rd argument, so `short.predBuy` and `long.predBuy` are equal and the `assert.ok` fails.

- [ ] **Step 3: Parameterize the two functions**

In `dist/overnight-core.js`, find:

```js
function predictPrices(series, windows) {
  const predict = (hours, priceFn) => {
    const baseline = recentBaseline(series, OC_BASELINE_DAYS, priceFn);
```

Replace those three lines with:

```js
function predictPrices(series, windows, baselineDays = OC_BASELINE_DAYS) {
  const predict = (hours, priceFn) => {
    const baseline = recentBaseline(series, baselineDays, priceFn);
```

Then find:

```js
function analyzeItem(id, series, windows, taxFn) {
  if (ocDistinctDays(series) < OC_MIN_DAYS) return null;
  const { predBuy, predSell } = predictPrices(series, windows);
```

Replace those three lines with:

```js
function analyzeItem(id, series, windows, taxFn, baselineDays = OC_BASELINE_DAYS) {
  if (ocDistinctDays(series) < OC_MIN_DAYS) return null;
  const { predBuy, predSell } = predictPrices(series, windows, baselineDays);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test`
Expected: PASS — the new test and all pre-existing tests pass (the old 2-argument `predictPrices` calls still work via the default).

- [ ] **Step 5: Commit**

```bash
git add dist/overnight-core.js test/overnight-core.test.js
git commit -m "Parameterize predictPrices/analyzeItem with baselineDays"
```

---

## Task 2: Add the `backtestParams` walk-forward scorer

**Files:**
- Modify: `dist/overnight-core.js`
- Test: `test/overnight-core.test.js`

- [ ] **Step 1: Write the failing test**

Append to the end of `test/overnight-core.test.js`:

```js
test("backtestParams scores a perfectly repeating series with near-zero error", () => {
  // 20 days; every day low 100 at hour 2, high 130 at hour 14, 115 otherwise.
  const series = [];
  const start = Date.UTC(2026, 0, 1, 0) / 1000;
  for (let d = 0; d < 20; d++) {
    for (let h = 0; h < 24; h++) {
      const price = h === 2 ? 100 : h === 14 ? 130 : 115;
      series.push({ timestamp: start + (d * 24 + h) * 3600, avgHighPrice: price, avgLowPrice: price });
    }
  }
  const res = core.backtestParams(series, { baselineDays: 3, trendDiscount: 0 }, () => 0);
  assert.ok(res.samples > 0, `expected scored test days, got ${res.samples}`);
  assert.ok(res.error != null && res.error < 0.05, `expected near-zero error, got ${res.error}`);
});

test("backtestParams returns no samples when history is below OC_MIN_DAYS", () => {
  const series = [];
  const start = Date.UTC(2026, 0, 1, 0) / 1000;
  for (let d = 0; d < 5; d++) {                      // 5 days < OC_MIN_DAYS (10)
    for (let h = 0; h < 24; h++) {
      series.push({ timestamp: start + (d * 24 + h) * 3600, avgHighPrice: 115, avgLowPrice: 115 });
    }
  }
  const res = core.backtestParams(series, { baselineDays: 3, trendDiscount: 0 }, () => 0);
  assert.strictEqual(res.samples, 0);
  assert.strictEqual(res.error, null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test`
Expected: FAIL — `core.backtestParams is not a function`.

- [ ] **Step 3: Implement `backtestParams`**

In `dist/overnight-core.js`, find the `mergeSeries` function and the `module.exports` block after it. Insert this function **between** `mergeSeries` and the `module.exports` block (i.e. immediately before the `// Node test harness can require() this;` comment):

```js
// Walk-forward backtest of one item's series under a parameter set
// { baselineDays, trendDiscount }. For each day that has at least OC_MIN_DAYS
// of history before it, predicts that day's buy/sell spread using only the
// prior days, then compares it to the day's actual prices at the predicted
// hours. Returns { error, samples }: error is the mean relative gap between
// predicted and realized spread (null when nothing was scorable).
function backtestParams(series, params, taxFn) {
  const byDay = new Map();                       // dayKey -> points[]
  for (const p of series) {
    const key = ocDayKey(p.timestamp);
    let arr = byDay.get(key);
    if (!arr) { arr = []; byDay.set(key, arr); }
    arr.push(p);
  }
  const days = [...byDay.keys()].sort();         // YYYY-MM-DD sorts chronologically
  const prior = [];
  let errSum = 0, samples = 0;
  for (let i = 0; i < days.length; i++) {
    if (i >= OC_MIN_DAYS) {
      const windows = extremeHours(hourlyProfile(prior));
      const buyHour = windows.buyHours[0], sellHour = windows.sellHours[0];
      if (buyHour != null && sellHour != null) {
        const { predBuy, predSell } = predictPrices(prior, windows, params.baselineDays);
        if (predBuy != null && predSell != null && predBuy > 0) {
          const trend = priceTrend(prior);
          const predSellAdj = predSell * (1 + params.trendDiscount * Math.min(0, trend));
          const predictedSpread = predSellAdj - taxFn(predSellAdj) - predBuy;
          let actualBuy = null, actualSell = null;
          for (const p of byDay.get(days[i])) {
            const h = new Date(p.timestamp * 1000).getUTCHours();
            if (h === buyHour) actualBuy = ocLowPrice(p);
            if (h === sellHour) actualSell = ocHighPrice(p);
          }
          if (actualBuy != null && actualSell != null && actualBuy > 0) {
            const realizedSpread = actualSell - taxFn(actualSell) - actualBuy;
            errSum += Math.abs(predictedSpread - realizedSpread) / predBuy;
            samples += 1;
          }
        }
      }
    }
    prior.push(...byDay.get(days[i]));
  }
  return { error: samples > 0 ? errSum / samples : null, samples };
}
```

Then add `backtestParams` to the `module.exports` list. Find:

```js
    extremeHours, priceTrend, dayFileToPoints, mergeSeries,
  };
```

Replace with:

```js
    extremeHours, priceTrend, dayFileToPoints, mergeSeries, backtestParams,
  };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test`
Expected: PASS — both new tests pass, all pre-existing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add dist/overnight-core.js test/overnight-core.test.js
git commit -m "Add backtestParams walk-forward scorer"
```

---

## Task 3: App fetches and applies the tuned parameters

**Files:**
- Modify: `dist/overnight.js`

- [ ] **Step 1: Add the tuned-params URL constant**

In `dist/overnight.js`, find:

```js
const OVERNIGHT_STORE_DAYS = 90;    // how far back to probe (matches recorder retention)
```

Insert immediately after it:

```js
// Self-tuned model parameters, published to the price-history branch root by
// the weekly tune-params workflow. Absent/unreadable -> the app uses defaults.
const OVERNIGHT_TUNED_PARAMS_URL =
  "https://raw.githubusercontent.com/crazyhairmartin-ship-it/big-timbys-little-tool/price-history/tuned-params.json";
```

- [ ] **Step 2: Add `overnightFetchTunedParams`**

In `dist/overnight.js`, find the `overnightFetchStoreIndex` function:

```js
async function overnightFetchStoreIndex() {
```

Insert this function immediately **before** it:

```js
// Fetch the self-tuned parameters. Returns { baselineDays, trendDiscount } or
// null on any failure (missing file, network error, malformed or out-of-range
// values) — the caller then falls back to the built-in defaults.
async function overnightFetchTunedParams() {
  try {
    const r = await fetch(OVERNIGHT_TUNED_PARAMS_URL);
    if (!r.ok) return null;
    const p = await r.json();
    const bd = p && p.baselineDays, td = p && p.trendDiscount;
    if (typeof bd !== "number" || bd < 1 || bd > 60) return null;
    if (typeof td !== "number" || td < 0 || td > 1) return null;
    return { baselineDays: bd, trendDiscount: td };
  } catch (_) {
    return null;
  }
}
```

- [ ] **Step 3: Apply the tuned values in `runOvernightAnalysis`**

In `dist/overnight.js`, find:

```js
  if (onProgress) onProgress({ done: 0, total: candidates.length });
  const store = await overnightFetchStore();
```

Replace with:

```js
  if (onProgress) onProgress({ done: 0, total: candidates.length });
  const [tuned, store] = await Promise.all([overnightFetchTunedParams(), overnightFetchStore()]);
  const baselineDays = tuned ? tuned.baselineDays : OC_BASELINE_DAYS;
  const trendDiscount = tuned ? tuned.trendDiscount : OVERNIGHT_TREND_DISCOUNT;
```

Then find:

```js
    const windows = extremeHours(hourlyProfile(series));
    const a = analyzeItem(id, series, windows, geTax);
```

Replace with:

```js
    const windows = extremeHours(hourlyProfile(series));
    const a = analyzeItem(id, series, windows, geTax, baselineDays);
```

Then find:

```js
      daytime: a.predSell * (1 + OVERNIGHT_TREND_DISCOUNT * Math.min(0, trend)),
```

Replace with:

```js
      daytime: a.predSell * (1 + trendDiscount * Math.min(0, trend)),
```

- [ ] **Step 4: Syntax-check**

Run: `node -c dist/overnight.js`
Expected: no output (exit 0).

- [ ] **Step 5: Verify in a browser**

Serve on a fresh port, open the app, switch to the Experimental tab, let the analysis run. In the console:

```js
const tp = await overnightFetchTunedParams();
console.log("tuned params:", tp);   // null until the workflow has published a file — that is fine
const data = await window.Overnight.ensureOvernightAnalysis(()=>{}, true);
console.log("analysed:", data.analysed, "skipped:", data.skipped);
```

Expected: `tuned params: null` (no file published yet) and the analysis still completes with a non-zero `analysed` count — confirming the fallback to `OC_BASELINE_DAYS`/`OVERNIGHT_TREND_DISCOUNT` works.

- [ ] **Step 6: Commit**

```bash
git add dist/overnight.js
git commit -m "Fetch and apply self-tuned prediction parameters"
```

---

## Task 4: The offline tuning script

**Files:**
- Create: `scripts/tune-params.mjs`

- [ ] **Step 1: Create the script**

Create `scripts/tune-params.mjs` with exactly this content:

```js
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
```

- [ ] **Step 2: Syntax-check**

Run: `node -c scripts/tune-params.mjs`
Expected: no output (exit 0).

- [ ] **Step 3: Dry run**

Run: `node scripts/tune-params.mjs /tmp/tuned-params-dryrun.json`
Expected: it fetches the store + ~676 `/timeseries` series (takes 1–2 minutes), then prints either `tune: wrote /tmp/tuned-params-dryrun.json -> {...}` with a `baselineDays` from `{2,3,5,7}` and a `trendDiscount` from `{0,0.25,0.5,0.75,1.0}`, **or** `tune: only N samples (< 200) — no file written` if the store is still too thin. Either outcome is a pass — it confirms the script runs end-to-end. If a file was written, `cat /tmp/tuned-params-dryrun.json` and confirm it is well-formed JSON with the five fields.

- [ ] **Step 4: Commit**

```bash
git add scripts/tune-params.mjs
git commit -m "Add offline parameter-tuning script"
```

---

## Task 5: The weekly tuning workflow

**Files:**
- Create: `.github/workflows/tune-params.yml`

Note: the project's hooks warn when writing GitHub Actions workflow files — if the write is blocked, retry it; the retry succeeds.

- [ ] **Step 1: Create the workflow**

Create `.github/workflows/tune-params.yml` with exactly this content:

```yaml
name: Tune prediction parameters

# Weekly self-tuning: backtests the Experimental prediction model over a grid
# of parameter values and publishes the best set as tuned-params.json on the
# `price-history` branch. dist/overnight.js reads that file at analysis time.
#
# Security note: no untrusted event input is used in any run: step — only
# `date`, git, node, and the committed script.

on:
  schedule:
    - cron: "30 4 * * 0"   # weekly, Sunday 04:30 UTC
  workflow_dispatch:

permissions:
  contents: write

concurrency: record-prices  # shared with the recorder — never commit to price-history together

jobs:
  tune:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout (default branch — script, recipe data, overnight-core)
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Run the backtest grid-search
        run: node scripts/tune-params.mjs "$RUNNER_TEMP/tuned-params.json"

      - name: Publish tuned-params.json to the price-history branch
        run: |
          if [ ! -f "$RUNNER_TEMP/tuned-params.json" ]; then
            echo "no result written (history too thin) — nothing to publish"
            exit 0
          fi
          git config user.name "price-recorder"
          git config user.email "noreply@github.com"
          if git show-ref --verify --quiet refs/remotes/origin/price-history; then
            git checkout price-history
          else
            echo "price-history branch does not exist yet — run the recorder first"
            exit 1
          fi
          cp "$RUNNER_TEMP/tuned-params.json" ./tuned-params.json
          git add tuned-params.json
          if git commit -m "Tune prediction parameters ($(date -u +'%Y-%m-%d'))"; then
            git push origin price-history
          else
            echo "nothing to commit"
          fi
```

- [ ] **Step 2: Validate the workflow file**

Run: `node -e 'const fs=require("fs");const s=fs.readFileSync(".github/workflows/tune-params.yml","utf8");if(!/^name:/.test(s)||!s.includes("tune-params.mjs"))throw new Error("malformed");console.log("workflow file ok")'`
Expected: `workflow file ok`.

Confirm the script runs on the default branch (so its `../dist/overnight-core.js` and `../dist/app.js` imports/reads resolve) and writes to `$RUNNER_TEMP` — only the *publish* step switches to `price-history`, after the script has finished. This mirrors the recorder/backfill pattern while keeping the script's imports stable.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/tune-params.yml
git commit -m "Add weekly prediction-parameter tuning workflow"
```

---

## Self-Review

**Spec coverage:**
- §1 tunable parameters + grids → Task 4 (`BASELINE_DAYS`, `TREND_DISCOUNT` arrays). `OC_MIN_DAYS`/`OVERNIGHT_MIN_VOLUME` correctly untouched.
- §2 parameterizing the model → Task 1. `recentBaseline` already took `days`; `priceTrend` is deliberately left on the constant (its window is trend-detection, separate from the tuned price-anchor window — `backtestParams` and the app both call `priceTrend` un-parameterized, so they stay consistent).
- §3 walk-forward backtest, out-of-sample, predicted-vs-realized-spread objective → Task 2 (`backtestParams`) + Task 4 (the sample-weighted grid-search aggregation).
- §4 offline tuning job, weekly, writes `tuned-params.json` to the `price-history` branch, min-samples guard → Tasks 4 & 5.
- §5 app consumption with fallback → Task 3.
- §6 affected files → matches: `overnight-core.js`, `overnight.js`, `tune-params.mjs`, `tune-params.yml`, `test/overnight-core.test.js`; `tuned-params.json` lives on the `price-history` branch (created by the workflow, not in this repo).
- §7 testing → Task 1/2 unit tests, Task 3 browser check, Task 4 dry run.
- §8 data-thinness → the `MIN_SAMPLES` guard (Task 4) and the workflow's "nothing to publish" branch (Task 5).

**Placeholder scan:** none — every step has exact code, paths, and commands.

**Type/name consistency:** `backtestParams(series, params, taxFn)` returns `{ error, samples }` — defined in Task 2, consumed in Task 4 (`r.error`, `r.samples`). `params` is `{ baselineDays, trendDiscount }` everywhere. `predictPrices`'s 3rd arg is `baselineDays` in Task 1 and is what `backtestParams` passes in Task 2. `analyzeItem`'s 5th arg is `baselineDays` in Task 1 and is what `runOvernightAnalysis` passes in Task 3. `overnightFetchTunedParams` returns `{ baselineDays, trendDiscount }`, matching the `tuned-params.json` shape written in Task 4.
