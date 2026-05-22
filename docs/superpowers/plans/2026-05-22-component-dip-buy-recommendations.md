# Component-Dip Buy Recommendations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Flag a recipe on the Experimental tab as a buying opportunity when its components are unusually cheap right now versus their recorded price history — shown as a card badge, per-component indicators, and a boost in the Recommended sort.

**Architecture:** A new pure function `priceDip` in the overnight-core module computes a volatility-aware z-score of an item's latest price against its recorded history. The Experimental shell (`overnight.js`) computes it per item into a `dipMap`, aggregates per recipe (cost-weighted) via `overnightRecipeDip`, renders a badge plus per-component indicators, and attaches the aggregate to each grid item so the shared `scoreRecommended` can boost flagged recipes. No new data collection — it consumes the price-history store the Experimental tab already loads.

**Tech Stack:** Vanilla JavaScript, zero-build static app, classic `<script>` tags sharing global scope (`overnight-core.js` → `app.js` → `overnight.js`). Unit tests run under `node --test`.

**Spec:** `docs/superpowers/specs/2026-05-22-component-dip-buy-recommendations-design.md`

**Note on a deliberate spec deviation:** Spec §2 describes the component buy price as "strategy-aware." In practice the Experimental tab's predictions are always low-side — `predictPrices` in `overnight-core.js` uses `ocLowPrice` for the buy side unconditionally, and the strategy toggle never reaches the Experimental predMap path. To stay consistent with the prices the Experimental tab already shows, the dip is computed with `ocLowPrice`. `priceDip` keeps a `priceFn` parameter (matching the spec's signature), so this is purely a caller's choice.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `dist/overnight-core.js` | Pure analytics. Add `priceDip` + `OC_DIP_MIN_DAYS`. | Modify |
| `test/overnight-core.test.js` | Node unit tests. Add 3 `priceDip` tests. | Modify |
| `dist/overnight.js` | Experimental shell. Build `dipMap`, aggregate per recipe, render badge + indicators, attach `_dipAgg`. | Modify |
| `dist/app.js` | `scoreRecommended` dip bonus. | Modify |
| `dist/index.css` | `.dip-chip` badge + `.dip-tag` indicator styles. | Modify |

---

## Task 1: `priceDip` pure function

**Files:**
- Modify: `dist/overnight-core.js` (constants near line 8-9; new function after `priceTrend` which ends at line 208; `module.exports` at lines 294-300)
- Test: `test/overnight-core.test.js` (append after the last test)

- [ ] **Step 1: Write the failing tests**

Append these three tests to the end of `test/overnight-core.test.js`:

```js
test("priceDip scores the latest price against the series mean", () => {
  const day = (d) => Math.floor(Date.UTC(2026, 0, 1 + d) / 1000);
  // Five distinct days; prices 120,110,100,90,80 -> mean 100, the latest
  // (day 5) is 80. Population stddev = sqrt(1000/5) = sqrt(200).
  const series = [120, 110, 100, 90, 80].map((p, d) => ({
    timestamp: day(d), avgHighPrice: p, avgLowPrice: p,
  }));
  const dip = core.priceDip(series, core.ocLowPrice);
  assert.ok(Math.abs(dip.z - (-20 / Math.sqrt(200))) < 1e-9);
  assert.ok(Math.abs(dip.pctBelow - 0.2) < 1e-9);
  assert.strictEqual(dip.samples, 5);
});

test("priceDip returns null for a flat series (no volatility)", () => {
  const day = (d) => Math.floor(Date.UTC(2026, 0, 1 + d) / 1000);
  const series = [0, 1, 2, 3, 4, 5].map((d) => ({
    timestamp: day(d), avgHighPrice: 50, avgLowPrice: 50,
  }));
  assert.strictEqual(core.priceDip(series, core.ocLowPrice), null);
});

test("priceDip returns null when history spans too few days", () => {
  const day = (d) => Math.floor(Date.UTC(2026, 0, 1 + d) / 1000);
  // Four distinct days < OC_DIP_MIN_DAYS (5).
  const series = [100, 90, 110, 80].map((p, d) => ({
    timestamp: day(d), avgHighPrice: p, avgLowPrice: p,
  }));
  assert.strictEqual(core.priceDip(series, core.ocLowPrice), null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/overnight-core.test.js`
Expected: the 3 new tests FAIL with `TypeError: core.priceDip is not a function`. Existing tests still pass.

- [ ] **Step 3: Add the `OC_DIP_MIN_DAYS` constant**

In `dist/overnight-core.js`, change lines 8-9 from:

```js
const OC_MIN_DAYS = 10;        // min distinct days of history to analyse an item
const OC_BASELINE_DAYS = 3;    // recent window the prediction is anchored to
```

to:

```js
const OC_MIN_DAYS = 10;        // min distinct days of history to analyse an item
const OC_BASELINE_DAYS = 3;    // recent window the prediction is anchored to
const OC_DIP_MIN_DAYS = 5;     // min distinct days before a price-dip signal is trusted
```

- [ ] **Step 4: Add the `priceDip` function**

In `dist/overnight-core.js`, insert this function immediately after `priceTrend` (after its closing brace on line 208, before the blank line preceding the `dayFileToPoints` comment block):

```js
// Volatility-aware "is this unusually cheap right now" score for one item's
// series. priceFn extracts the comparison price from a point (ocLowPrice for
// the buy side). Returns { z, pctBelow, samples }:
//   z        - the latest price's z-score vs the series mean (negative = below)
//   pctBelow - (mean - latest) / mean, the human-readable "% below usual"
//   samples  - count of priced points used
// Returns null when the series spans fewer than OC_DIP_MIN_DAYS distinct days,
// has a zero mean, or has zero variance (a flat series carries no dip signal).
function priceDip(series, priceFn = ocLowPrice) {
  const priced = [];
  for (const p of series) {
    const x = priceFn(p);
    if (x != null) priced.push({ ts: p.timestamp, x });
  }
  if (!priced.length) return null;
  const days = new Set();
  for (const p of priced) days.add(ocDayKey(p.ts));
  if (days.size < OC_DIP_MIN_DAYS) return null;
  const n = priced.length;
  const mean = priced.reduce((sum, p) => sum + p.x, 0) / n;
  if (mean === 0) return null;
  const variance = priced.reduce((sum, p) => sum + (p.x - mean) ** 2, 0) / n;
  if (variance === 0) return null;
  let current = priced[0];
  for (const p of priced) if (p.ts > current.ts) current = p;
  return {
    z: (current.x - mean) / Math.sqrt(variance),
    pctBelow: (mean - current.x) / mean,
    samples: n,
  };
}
```

- [ ] **Step 5: Export `priceDip` and `OC_DIP_MIN_DAYS`**

In `dist/overnight-core.js` `module.exports` (lines 294-300), change the line:

```js
    extremeHours, priceTrend, dayFileToPoints, mergeSeries, backtestParams,
```

to:

```js
    extremeHours, priceTrend, dayFileToPoints, mergeSeries, backtestParams,
    priceDip, OC_DIP_MIN_DAYS,
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test test/overnight-core.test.js`
Expected: ALL tests pass (the 26 existing + 3 new = 29).

- [ ] **Step 7: Commit**

```bash
git add dist/overnight-core.js test/overnight-core.test.js
git commit -m "Add priceDip volatility-aware price-dip score"
```

---

## Task 2: Surface component dips on the Experimental tab

**Files:**
- Modify: `dist/overnight.js` (constants after line 12; `runOvernightAnalysis` lines 158-181; new `overnightRecipeDip` after `overnightTrendChip` which ends at line 269; `overnightRecipeCard` lines 282-334; `overnightVisible` line 399)
- Modify: `dist/index.css` (after the `.skill-chip` block which ends at line 721)

- [ ] **Step 1: Add the dip threshold constants**

In `dist/overnight.js`, change line 12 from:

```js
const OVERNIGHT_TREND_DISCOUNT = 0.5;  // fraction of a downtrend applied as a sell-price haircut
```

to:

```js
const OVERNIGHT_TREND_DISCOUNT = 0.5;  // fraction of a downtrend applied as a sell-price haircut
// Component-dip "buying opportunity" thresholds (volatility-aware z-scores).
const OVERNIGHT_DIP_COMPONENT_Z = -1.0;  // a component is "dipping" at or below this z
const OVERNIGHT_DIP_RECIPE_Z = -0.7;     // a recipe is flagged at or below this cost-weighted z
```

- [ ] **Step 2: Build `dipMap` in `runOvernightAnalysis`**

In `dist/overnight.js`, the per-item loop (lines 158-181) currently reads:

```js
  const predMap = {};
  let analysed = 0;
  for (const [id, series] of seriesById) {
    const windows = extremeHours(hourlyProfile(series));
    const a = analyzeItem(id, series, windows, geTax, baselineDays);
    if (!a) continue;
    const trend = priceTrend(series);
    predMap[id] = {
      overnight: a.predBuy,
      daytime: a.predSell * (1 + trendDiscount * Math.min(0, trend)),
      confidence: a.confidence,
      buyHour: windows.buyHours[0] ?? null,
      sellHour: windows.sellHours[0] ?? null,
      trend,
    };
    analysed += 1;
  }

  overnightData = {
    analysedAt: Date.now(),
    predMap,
    analysed,
    skipped: candidates.length - seriesById.size,
  };
```

Replace it with (note `priceDip` is computed BEFORE `if (!a) continue;` — a component can have ≥5 days for a dip yet fewer than `OC_MIN_DAYS` for a full prediction):

```js
  const predMap = {};
  const dipMap = {};
  let analysed = 0;
  for (const [id, series] of seriesById) {
    const dip = priceDip(series, ocLowPrice);
    if (dip) dipMap[id] = dip;
    const windows = extremeHours(hourlyProfile(series));
    const a = analyzeItem(id, series, windows, geTax, baselineDays);
    if (!a) continue;
    const trend = priceTrend(series);
    predMap[id] = {
      overnight: a.predBuy,
      daytime: a.predSell * (1 + trendDiscount * Math.min(0, trend)),
      confidence: a.confidence,
      buyHour: windows.buyHours[0] ?? null,
      sellHour: windows.sellHours[0] ?? null,
      trend,
    };
    analysed += 1;
  }

  overnightData = {
    analysedAt: Date.now(),
    predMap,
    dipMap,
    analysed,
    skipped: candidates.length - seriesById.size,
  };
```

- [ ] **Step 3: Add the `overnightRecipeDip` aggregation helper**

In `dist/overnight.js`, insert this function immediately after `overnightTrendChip` (after its closing brace on line 269, before the `// One Overnight recipe card` comment on line 271):

```js
// Aggregate a recipe's per-component price dips into one recipe-level signal,
// cost-weighted by each component's predicted buy cost (price x qty). A
// component with no dip entry (too little history) contributes its weight at
// z = 0. Returns { flagged, aggZ, pctBelow }, or null when no component has a
// usable dip signal or a predicted price is missing. Reads overnightData, so
// it tolerates a stale cache that predates dipMap via the `|| {}` fallback.
function overnightRecipeDip(recipe) {
  const predMap = overnightData.predMap;
  const dipMap = overnightData.dipMap || {};
  let weightSum = 0, zSum = 0, pctSum = 0, haveSignal = false;
  for (const c of recipe.components) {
    const pred = predMap[c.id];
    if (!pred || pred.overnight == null || pred.overnight <= 0) return null;
    const weight = pred.overnight * c.qty;
    weightSum += weight;
    const dip = dipMap[c.id];
    if (dip) {
      haveSignal = true;
      zSum += weight * dip.z;
      pctSum += weight * dip.pctBelow;
    }
  }
  if (!haveSignal || weightSum <= 0) return null;
  const aggZ = zSum / weightSum;
  return {
    flagged: aggZ <= OVERNIGHT_DIP_RECIPE_Z,
    aggZ,
    pctBelow: pctSum / weightSum,
  };
}
```

- [ ] **Step 4: Attach `_dipAgg` to grid items in `overnightVisible`**

In `dist/overnight.js`, `overnightVisible` ends its loop with this line (line 399):

```js
    out.push({ recipe, calc });
```

Replace it with:

```js
    const item = { recipe, calc };
    item._dipAgg = overnightRecipeDip(recipe);
    out.push(item);
```

- [ ] **Step 5: Render the badge and per-component indicators in `overnightRecipeCard`**

In `dist/overnight.js`, `overnightRecipeCard` builds the head's category row. Lines 289-290 currently read:

```js
  const trendChipEl = overnightTrendChip(overnightData.predMap[recipe.id] && overnightData.predMap[recipe.id].trend);
  if (trendChipEl) catRow.appendChild(trendChipEl);
```

Replace those two lines with:

```js
  const trendChipEl = overnightTrendChip(overnightData.predMap[recipe.id] && overnightData.predMap[recipe.id].trend);
  if (trendChipEl) catRow.appendChild(trendChipEl);
  const recipeDip = overnightRecipeDip(recipe);
  if (recipeDip && recipeDip.flagged) {
    const pct = Math.max(1, Math.round(recipeDip.pctBelow * 100));
    const dipBadge = el("span", { class: "dip-chip", text: "parts " + pct + "% below usual" });
    dipBadge.title = "Components are unusually cheap to buy right now — about "
      + pct + "% below their recorded average.";
    catRow.appendChild(dipBadge);
  }
```

Then, in the same function, the component breakdown loop (lines 325-334) currently reads:

```js
  const comp = el("div", { class: "components" });
  for (const c of recipe.components) {
    const cName = state.mapping[c.id]?.name || "#" + c.id;
    const price = overnightData.predMap[c.id]?.overnight;
    const value = price != null
      ? (c.qty > 1 ? c.qty + "× " + fmtGp(price) : fmtGp(price))
      : "—";
    const buyHint = "buy " + overnightLocalHour(overnightData.predMap[c.id] && overnightData.predMap[c.id].buyHour);
    row(comp, { label: cName, value, hint: buyHint });
  }
```

Replace that loop with (`recipeDip` is in scope from the head block above; per-component indicators show only on a flagged recipe):

```js
  const comp = el("div", { class: "components" });
  const showDipTags = !!(recipeDip && recipeDip.flagged);
  for (const c of recipe.components) {
    const cName = state.mapping[c.id]?.name || "#" + c.id;
    const price = overnightData.predMap[c.id]?.overnight;
    const value = price != null
      ? (c.qty > 1 ? c.qty + "× " + fmtGp(price) : fmtGp(price))
      : "—";
    const buyHint = "buy " + overnightLocalHour(overnightData.predMap[c.id] && overnightData.predMap[c.id].buyHour);
    const dip = (overnightData.dipMap || {})[c.id];
    const dipTag = (showDipTags && dip && dip.z <= OVERNIGHT_DIP_COMPONENT_Z)
      ? el("span", { class: "dip-tag", text: "↓ " + Math.max(1, Math.round(dip.pctBelow * 100)) + "% low" })
      : null;
    row(comp, { label: cName, value, hint: buyHint, nameExtras: dipTag ? [dipTag] : [] });
  }
```

- [ ] **Step 6: Add the badge and indicator CSS**

In `dist/index.css`, the `.skill-chip` rule block ends at line 721 (`}`), and line 722 is blank. Insert this immediately after line 721:

```css
/* Component-dip "buying opportunity" badge — components are unusually cheap to
   buy right now. Green: a dip on the buy side is a positive signal. Mirrors
   the .skill-chip shape. */
.dip-chip {
  display: inline-block;
  margin-left: 6px;
  padding: 1px 6px;
  font-size: 10px;
  font-weight: 700;
  border-radius: 4px;
  font-variant-numeric: tabular-nums;
  color: #4ade80;
  background: rgba(74, 222, 128, 0.14);
  border: 1px solid rgba(74, 222, 128, 0.5);
  cursor: help;
  white-space: nowrap;
}
/* Per-component dip indicator, shown inline next to a dipping component name. */
.dip-tag {
  margin-left: 6px;
  font-size: 10px;
  font-weight: 700;
  color: #4ade80;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
```

- [ ] **Step 7: Verify in the browser**

Serve on a fresh port (the app caches `app.js`/`index.css`, so a new port avoids stale assets):

```bash
cd "dist" && python3 -m http.server 8210
```

Then, in a browser at `http://localhost:8210/index.html`:
1. Click the **Experimental** tab. Wait for "Analysing N / N items..." to finish (the grid fills with cards).
2. Open the devtools console and run:

```js
const d = window.Overnight.data;
console.log("dipMap entries:", Object.keys(d.dipMap).length);  // expect > 0
// Force every predicted item to look deeply dipped, then re-render:
for (const k of Object.keys(d.predMap)) d.dipMap[k] = { z: -3, pctBelow: 0.22, samples: 200 };
window.Overnight.renderOvernight();
console.log("badges:", document.querySelectorAll('.dip-chip').length);   // expect > 0
console.log("indicators:", document.querySelectorAll('.dip-tag').length); // expect > 0
```

Expected: `dipMap entries` > 0; after the forced re-render, `badges` > 0 and `indicators` > 0. Visually confirm a green "parts 22% below usual" badge sits beside the confidence/trend chips on a card head, and green "↓ N% low" markers appear next to component names. No console errors.

Stop the server when done (Ctrl-C).

- [ ] **Step 8: Commit**

```bash
git add dist/overnight.js dist/index.css
git commit -m "Surface component-dip buy badges on the Experimental tab"
```

---

## Task 3: Boost flagged recipes in the Recommended sort

**Files:**
- Modify: `dist/app.js` (`scoreRecommended` loop, lines 1416-1428)

- [ ] **Step 1: Add the dip bonus to `scoreRecommended`**

In `dist/app.js`, the scoring loop (lines 1416-1428) currently reads:

```js
  for (const it of items) {
    let s = 0.30 * pct.roi.get(it)  + 0.30 * pct.daily.get(it)
          + 0.30 * pct.hist.get(it) + 0.10 * pct.vol.get(it);
    const stale = isItemStale(it.recipe.id) ||
                  it.recipe.components.some(c => isItemStale(c.id));
    if (stale) s *= 0.2;
    // A losing flip or one with missing prices can never be "recommended".
    if (!it.calc.allPresent || !(it.calc.margin > 0)) s = -1;
    // The blended score is 0–1, so a +1 bump floats every ≥50k-margin flip
    // above every sub-50k one while the score still orders within each tier.
    else if (it.calc.margin >= REC_MARGIN_PRIORITY) s += 1;
    it._recScore = s;
  }
```

Replace it with:

```js
  for (const it of items) {
    let s = 0.30 * pct.roi.get(it)  + 0.30 * pct.daily.get(it)
          + 0.30 * pct.hist.get(it) + 0.10 * pct.vol.get(it);
    const stale = isItemStale(it.recipe.id) ||
                  it.recipe.components.some(c => isItemStale(c.id));
    if (stale) s *= 0.2;
    // A losing flip or one with missing prices can never be "recommended".
    if (!it.calc.allPresent || !(it.calc.margin > 0)) {
      s = -1;
    } else {
      // The blended score is 0–1, so a +1 bump floats every ≥50k-margin flip
      // above every sub-50k one while the score still orders within each tier.
      if (it.calc.margin >= REC_MARGIN_PRIORITY) s += 1;
      // Component-dip bonus: a flagged buying opportunity is nudged up,
      // proportional to dip strength and capped at +0.5. _dipAgg is set only
      // on Experimental grid items (see overnightVisible), so the real-time
      // Recommended ranking is unchanged.
      if (it._dipAgg && it._dipAgg.flagged) {
        s += Math.min(-it._dipAgg.aggZ, 2) * 0.25;
      }
    }
    it._recScore = s;
  }
```

This is behaviour-preserving for any item without `_dipAgg`: the `if/else` reproduces the original `if/else if` exactly, and the bonus line is skipped.

- [ ] **Step 2: Verify in the browser**

Serve on a fresh port:

```bash
cd "dist" && python3 -m http.server 8211
```

Then, in a browser at `http://localhost:8211/index.html`, open the devtools console and run (`scoreRecommended`, `RECIPES`, and `REC_MARGIN_PRIORITY` are app.js globals):

```js
const baseCalc = () => ({ allPresent: true, margin: 10000, roi: 5, maxFlips: 10, resultVol: 100 });
const flagged   = { recipe: RECIPES[0], calc: baseCalc(), _dipAgg: { flagged: true,  aggZ: -2, pctBelow: 0.2 } };
const unflagged = { recipe: RECIPES[1], calc: baseCalc() };
const losing    = { recipe: RECIPES[2], calc: { ...baseCalc(), margin: -5 }, _dipAgg: { flagged: true, aggZ: -2, pctBelow: 0.2 } };
scoreRecommended([flagged, unflagged, losing]);
console.log("flagged > unflagged:", flagged._recScore > unflagged._recScore);          // expect true
console.log("bonus size:", (flagged._recScore - unflagged._recScore).toFixed(3));        // expect 0.500
console.log("losing flip not lifted:", losing._recScore === -1);                         // expect true
```

Expected: `flagged > unflagged` is `true`; `bonus size` is `0.500` (min(2,2)×0.25); `losing flip not lifted` is `true`. The `unflagged` item has no `_dipAgg`, demonstrating the real-time grid is unaffected.

Stop the server when done (Ctrl-C).

- [ ] **Step 3: Commit**

```bash
git add dist/app.js
git commit -m "Boost component-dip buying opportunities in the Recommended sort"
```

---

## Self-Review

**Spec coverage:**
- §2 per-component volatility-aware z-score → Task 1 `priceDip`.
- §2 data-thinness guard (< 5 days, σ = 0) → `priceDip` returns `null`.
- §3 cost-weighted recipe aggregate, flag at `z ≤ −0.7` → Task 2 `overnightRecipeDip`.
- §4 card badge → Task 2 Step 5.
- §4 per-component indicators → Task 2 Step 5.
- §4 Recommended-sort boost (`min(−aggZ, 2) × 0.25`, never lifts a losing flip, additive to the ≥50k float) → Task 3.
- §4 scope (Experimental only; real-time Recommended unchanged) → `_dipAgg` set only in `overnightVisible`; verified in Task 3 Step 2.
- §5 architecture (`priceDip` in core, `dipMap` + helper + render in `overnight.js`, bonus in `app.js`, CSS) → Tasks 1-3.
- §6 affected files → all five files covered; recorder/backfill/workflows untouched.
- §7 testing → Task 1 unit tests; Tasks 2-3 in-browser verification.

**Deliberate deviation:** Spec §2 says "strategy-aware" buy price; the plan uses `ocLowPrice` to match the Experimental tab's existing low-side predictions (see the note under the header). `priceDip` keeps the `priceFn` parameter, so this is a one-line caller choice.

**Type consistency:** `priceDip` → `{ z, pctBelow, samples } | null`, consumed by `overnightRecipeDip` and `overnightRecipeCard` (`dip.z`, `dip.pctBelow`). `overnightRecipeDip` → `{ flagged, aggZ, pctBelow } | null`, consumed by the card (`recipeDip.flagged`, `recipeDip.pctBelow`) and `scoreRecommended` (`it._dipAgg.flagged`, `it._dipAgg.aggZ`). Constants `OC_DIP_MIN_DAYS`, `OVERNIGHT_DIP_COMPONENT_Z`, `OVERNIGHT_DIP_RECIPE_Z` are each defined once and referenced consistently.

**Stale-cache safety:** A cached analysis written before this feature has no `dipMap`. `overnightRecipeDip` and the card both read `overnightData.dipMap || {}`, so an old cache simply yields no badges until the next analysis refreshes (within the 24h TTL, or via the background refresh `renderOvernight` triggers).
