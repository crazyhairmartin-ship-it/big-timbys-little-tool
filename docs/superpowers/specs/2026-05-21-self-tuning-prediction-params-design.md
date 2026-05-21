# Self-Tuning Prediction Parameters — Design

**Status:** Approved design — ready for implementation planning.
**Date:** 2026-05-21

## Goal

The Experimental tab's prediction model has tunable parameters that are
currently hardcoded guesses. This feature makes the model tune them itself:
an offline job backtests the model against recorded price history, grid-searches
parameter combinations, and publishes the best-performing set. The app predicts
with the tuned values. No user-facing UI — the model quietly improves as price
history accumulates.

## Decisions made during brainstorming

- **No panel.** The user explicitly does not want to *see* accuracy numbers —
  the backtest feeds the model, it does not surface in the UI.
- **Self-tune the parameters.** Not just calibrating the output or improving
  hour-picking — the model grid-searches its own tunables and adopts the best.
- **Offline GitHub Action.** The backtest is real compute; it runs in a
  scheduled workflow (like the hourly recorder), not in the browser. The app
  just reads the published result.
- **Out-of-sample is mandatory.** Today's `confidenceOf` grades hours on the
  same history they were picked from — optimistic by construction. The backtest
  must be walk-forward (predict from the past, grade on a held-out future) or it
  would simply reward overfitting.

## Non-goals

- No accuracy panel, chart, or any new UI.
- No per-item parameters — one global parameter set, tuned across all items.
- No continuous optimization — a small fixed discrete grid only.
- Hour-selection logic (`extremeHours`) is not changed; only the existing
  numeric parameters are tuned.

## 1. Tunable parameters

Only the parameters that shape prediction *quality* are tuned:

| Parameter | Current default | Grid |
|---|---|---|
| `OC_BASELINE_DAYS` — recent window the prediction anchors to | 3 | `{2, 3, 5, 7}` |
| `OVERNIGHT_TREND_DISCOUNT` — downtrend haircut on the predicted sell | 0.5 | `{0, 0.25, 0.5, 0.75, 1.0}` |

20 combinations. `OC_MIN_DAYS` and `OVERNIGHT_MIN_VOLUME` are **excluded** —
they are eligibility gates (they change *which* items are predicted, not how
accurate a prediction is), so backtesting them is not meaningful here.

## 2. Parameterizing the model

The model functions currently read these as module constants. To let the
backtester and the app try different values, the values become explicit
arguments that **default to today's constants** (so all existing callers and
behaviour are unchanged):

- `dist/overnight-core.js` — `predictPrices(series, windows, baselineDays = OC_BASELINE_DAYS)` passes `baselineDays` through to `recentBaseline` (which already takes a `days` argument). `analyzeItem(id, series, windows, taxFn, baselineDays = OC_BASELINE_DAYS)` passes it to `predictPrices`.
- `dist/overnight.js` — `runOvernightAnalysis` applies the trend discount using a `trendDiscount` value (tuned, or the `OVERNIGHT_TREND_DISCOUNT` default) instead of the constant directly.

## 3. The walk-forward backtest

A pure function added to `dist/overnight-core.js` — `node --test`-able, and
reused verbatim by the offline tuner so the backtest exercises the *real*
prediction code, never a reimplementation that could drift.

**`backtestParams(series, params, taxFn)` → `{ error, samples }`**

For one item's hourly `series` and a parameter set `params = { baselineDays, trendDiscount }`:

1. Group the series into UTC days.
2. For each **test day** `D` that has at least `OC_MIN_DAYS` distinct days of history *before* it:
   - `prior` = all points strictly before day `D`.
   - `windows = extremeHours(hourlyProfile(prior))` — the cheap/dear hours, picked from prior data only.
   - `{ predBuy, predSell } = predictPrices(prior, windows, params.baselineDays)`.
   - Apply the trend haircut: `predSellAdj = predSell * (1 + params.trendDiscount * Math.min(0, priceTrend(prior)))`.
   - **Predicted spread** = `predSellAdj − taxFn(predSellAdj) − predBuy`.
   - **Realized spread** = `(day D's avgHighPrice at the predicted sell hour) − taxFn(that) − (day D's avgLowPrice at the predicted buy hour)`. Skip the test day if day `D` has no price at either hour.
   - Sample error = `|predictedSpread − realizedSpread| / predBuy` (normalized by the item's price scale so cheap and expensive items contribute comparably).
3. Return `{ error: mean sample error, samples: number of test days scored }`.

**Grid-search objective.** For each of the 20 parameter combinations, run
`backtestParams` over every tracked item, then aggregate into one score =
the sample-weighted mean error across all items. The combination with the
**lowest** score wins. A well-calibrated model (predicted spread ≈ realized
spread) is the definition of "trustworthy" here, and minimizing this error
tunes both parameters — `baselineDays` drives the predicted price level,
`trendDiscount` drives the predicted sell side.

## 4. The offline tuning job

**`scripts/tune-params.mjs`** (Node ESM, run by the workflow):

1. Extract the tracked item ids from `dist/app.js`'s `RECIPES` literal — the
   same `matchAll(/\bid:(\d+)/g)` approach the backfill workflow uses.
2. For each item, build its history the same way the app does: fetch the wiki
   `/timeseries` (1h) and merge it with the recorded price-history store, reusing
   `dayFileToPoints` and `mergeSeries` from `overnight-core.js`.
3. Grid-search the 20 combinations with `backtestParams`; pick the lowest-error set.
4. Write `tuned-params.json` to the repo root of the `price-history` branch:
   ```json
   { "baselineDays": 5, "trendDiscount": 0.25, "tunedAt": "2026-05-21T04:00:00Z",
     "score": 0.137, "samples": 4821 }
   ```
5. If the total backtest samples fall below a minimum (history still too thin
   to tune reliably), the script writes **nothing** and leaves any existing
   `tuned-params.json` in place — the app then keeps using whatever was last
   published, or its built-in defaults.

**`.github/workflows/tune-params.yml`:** scheduled weekly (`workflow_dispatch`
also), `concurrency: record-prices` shared with the hourly recorder so the two
never commit to the `price-history` branch at once. It checks out the default
branch for the script + recipe data, switches to `price-history`, runs the
script, and commits `tuned-params.json`.

## 5. App consumption

`dist/overnight.js` gains `overnightFetchTunedParams()` — fetches
`tuned-params.json` raw from the root of the `price-history` branch (the parent
of the `prices/` store directory). `runOvernightAnalysis` calls it once at the start of a run and
feeds `baselineDays` into `analyzeItem` and `trendDiscount` into the daytime
calculation. On any failure — missing file, fetch error, malformed JSON, or
out-of-range values — it falls back to the `OC_BASELINE_DAYS` /
`OVERNIGHT_TREND_DISCOUNT` defaults. Graceful degradation, mirroring how
`overnightFetchStore` already tolerates a missing store.

## 6. Affected files

- `dist/overnight-core.js` — parameterize `predictPrices`/`analyzeItem`; add
  `backtestParams` and any small pure helpers it needs; export them.
- `dist/overnight.js` — `overnightFetchTunedParams`; apply tuned values in
  `runOvernightAnalysis`.
- `scripts/tune-params.mjs` — new offline tuning script.
- `.github/workflows/tune-params.yml` — new scheduled workflow.
- `test/overnight-core.test.js` — unit tests for the parameterized functions
  and `backtestParams`.
- `tuned-params.json` — published on the `price-history` branch (not `main`).

No changes to `dist/app.js`, the recorder, or the backfill.

## 7. Testing

- `backtestParams` and the parameterized `predictPrices`/`analyzeItem` are pure
  → unit-tested under `node --test` alongside the existing 22 tests: a
  constructed series with a known cheap/dear pattern yields the expected
  walk-forward error; passing different `baselineDays`/`trendDiscount` changes
  the result as expected; default arguments reproduce today's behaviour.
- `scripts/tune-params.mjs` — verified with a local dry run: it produces a
  well-formed `tuned-params.json` with a parameter set drawn from the grid.
- The app's fallback path is verified in-browser: with no `tuned-params.json`
  reachable, the Experimental analysis still runs on the default parameters.

## 8. Data-thinness note

The recorded price-history store is currently ~17 days deep and growing hourly.
Walk-forward needs `OC_MIN_DAYS` (10) of prior history before the first test
day, so early backtests have few test days per item and the tuned result is
noisy. This is expected and self-correcting — the minimum-samples guard in §4
keeps the job from publishing a result until there is enough data, and the
tuning sharpens automatically as the store deepens. This is the feature working
as intended: the model improves itself as its evidence base grows.
