# Component-Dip Buy Recommendations — Design

**Status:** Approved design — ready for implementation planning.
**Date:** 2026-05-22

## Goal

The Experimental tab predicts buy/sell hours and margins, but never tells the
user *when* now is an unusually good moment to act. This feature uses the
recorded price-history store to flag a recipe as a **buying opportunity** when
its components are unusually cheap to buy right now — volatility-aware, judged
against each component's own price history. A flagged recipe gets a card badge,
its dipping components get inline indicators, and flagged recipes are boosted in
the existing Recommended sort.

## Decisions made during brainstorming

- **Signal = component side, not product side.** Recommend buying when the
  components are at a volatility-aware low. An expensive product is a *sell*
  signal, not a buy signal, and is explicitly not a trigger.
- **Volatility-aware, per-component.** Each component is scored with a z-score
  against its own recorded history, so a naturally jumpy component needs a
  bigger drop to qualify than a stable one. The recipe rolls those up.
- **Per-component indicators.** The card shows *which* component(s) are dipping,
  alongside the recipe-level badge.
- **Surfaces as a badge + a Recommended-sort boost** — not a new sort and not a
  separate section. A new sort was rejected: this is a membership/timing signal,
  and a sort would overlap confusingly with the existing Recommended sort (which
  ranks *every* recipe by steady-state quality).
- **Built on the existing price-history store.** The feature is a pure consumer
  of the data the Experimental tab already loads — it does not change the
  recorder, the backfill, or the workflows that populate the store.

## Non-goals

- No new tab, no new sort option, no dedicated section.
- No change to the prediction model (`predictPrices`, `extremeHours`, etc.).
- No per-component or per-recipe configuration.
- No change to price-history *collection* (recorder / backfill / workflows).
- Not driven by the product / sell price at all.
- Only `recipe.components` are scored — `recipe.supplies` (cheap live-priced
  consumables) are out of scope.

## 1. The signal

A recipe is a *buying opportunity* when its components are unusually cheap to
buy at the **current** moment, measured against each component's own recorded
price history. "Current" means the latest available price — distinct from the
Experimental tab's *predicted-hour* prices. The feature answers "the dip is
happening now," not "a dip is predicted for hour H."

The feature is built directly on the price-history store: each component's
"usual" price (mean and volatility) is derived entirely from the recorded
`prices/` day-files. Without that store there is no baseline and the feature
produces no signal.

## 2. Per-component dip score

For each item in `recipe.components`:

1. Reconstruct its hourly buy-price series from the merged store+live series
   that `runOvernightAnalysis` already builds per item. The buy price is
   strategy-aware — `avgLowPrice` for slow-buy, `avgHighPrice` for insta-buy,
   matching `supplyPrice` in `dist/app.js` — and the history is reconstructed
   with the same price selector for a like-for-like comparison.
2. Compute the mean **μ** and the population standard deviation **σ** of that
   series.
3. The current (latest) price **p** gives the **z-score** `z = (p − μ) / σ`.
   Negative means below the component's norm. Because σ is the component's *own*
   volatility, a jumpy component needs a larger absolute drop to reach the same
   z as a stable component.
4. Also compute `pctBelow = (μ − p) / μ` — the human-readable "% below usual".
5. A component is **dipping** when `z ≤ −1.0`.

**Data-thinness guard.** A component with fewer than 5 distinct days of recorded
data, or with σ = 0 (a perfectly flat series), yields **no** dip signal: it is
treated as "normal" (z = 0) — neither dipping nor blocking its recipe.

## 3. Recipe-level aggregation

The recipe's dip is the **cost-weighted average** of its components' z-scores,
each weighted by that component's share of the total component cost
(`current price × qty`). A component that is 80% of the basket cost dominates
the aggregate; a 2% one barely registers. Components with no signal contribute
their cost weight at z = 0.

The recipe is **flagged** when the cost-weighted aggregate `z ≤ −0.7`. The badge
magnitude is the cost-weighted `pctBelow` across the components.

All thresholds — `z ≤ −1.0` (component dipping), `z ≤ −0.7` (recipe flagged),
the 5-day minimum — are starting values, easy to tune later.

## 4. Surfacing (Experimental tab)

- **Card badge.** On a flagged recipe's Experimental card head, beside the
  existing confidence and trend chips: a badge reading e.g. *"parts 12% below
  usual"*, using the cost-weighted `pctBelow`. Shown only on flagged recipes.
- **Per-component indicators.** In the component breakdown of a flagged recipe's
  card, each component with `z ≤ −1.0` gets an inline marker — a down-arrow plus
  *"14% low"* — next to that component's row. This is the "which item is
  dipping" indicator; it explains the badge and is shown only on flagged
  recipes.
- **Recommended-sort boost.** `scoreRecommended` in `dist/app.js` gains a bonus
  term: a flagged recipe's blended score is nudged up by
  `min(−aggZ, 2) × 0.25` (so a recipe at aggZ = −0.7 gets +0.175, capped at
  +0.5). The bonus is applied **only** in the non-losing branch — it never lifts
  a losing or no-data flip — and is additive to, not a replacement for, the
  existing ≥50k-margin tier float.
- **Scope.** The dip is computed inside the Experimental analysis, the only
  place the price-history store is loaded. `scoreRecommended` runs on both the
  real-time and Experimental grids; the dip aggregate is present only on
  Experimental items, so on the real-time grid the bonus is 0 and the
  Recommended ranking there is unchanged.

## 5. Architecture & data flow

- `dist/overnight-core.js` — a new **pure** function `priceDip(series, priceFn)`
  → `{ z, pctBelow, samples } | null`. `priceFn` extracts the buy price from a
  series point. Returns `null` when the series has fewer than 5 distinct days or
  σ = 0. Pure and `node --test`-able; added to `module.exports`.
- `dist/overnight.js` — `runOvernightAnalysis` calls `priceDip` for each
  component item during its existing per-item pass, building a
  `dipMap: { componentId → { z, pctBelow, samples } }`. A small helper
  aggregates per recipe (cost-weighted) into `{ flagged, aggZ, pctBelow }` plus
  the per-component breakdown. `overnightRecipeCard` renders the badge and the
  per-component indicators; the per-recipe aggregate is attached to the
  `{ recipe, calc }` item (e.g. `it._dipAgg`) so the shared sorter can read it.
- `dist/app.js` — `scoreRecommended` reads `it._dipAgg` and applies the bonus.
- `dist/index.css` — styles for the badge chip and the per-component indicator.

## 6. Affected files

- `dist/overnight-core.js` — add and export `priceDip`.
- `dist/overnight.js` — compute `dipMap`, aggregate per recipe, render the badge
  and per-component indicators, attach `_dipAgg` to grid items.
- `dist/app.js` — `scoreRecommended` dip bonus.
- `dist/index.css` — badge + indicator styles.
- `test/overnight-core.test.js` — unit tests for `priceDip`.

No changes to the recorder, the backfill, the workflows, the `RECIPES` data, or
the prediction model.

## 7. Testing

- `priceDip` is pure → unit-tested under `node --test` alongside the existing
  tests: a constructed series with a known mean/stddev and a known current price
  yields the expected `z` and `pctBelow`; a flat series (σ = 0) returns `null`;
  a thin series (< 5 distinct days) returns `null`.
- The recipe aggregation, the badge, and the per-component indicators are
  verified in-browser on the Experimental tab: a recipe whose component series
  is dipping shows the badge and the correct per-component indicators; a normal
  recipe shows neither.
- The Recommended-sort boost is verified in-browser: a flagged recipe rises
  under the Recommended sort on the Experimental tab; a losing flip is not
  lifted; the real-time Recommended grid is unchanged.

## 8. Data-thinness note

The recorded price-history store is ~17 days deep and growing hourly (the
recorder retains 90 days). Early μ/σ are computed on thin data, so the dip
signal is noisier at first. The per-component thin-data guard (§2) prevents the
feature from firing on near-empty series. This is expected and self-correcting —
the baselines sharpen automatically as history accumulates, with no code change.
