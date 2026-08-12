/* ---------------- Overnight analytics core ----------------
   Pure functions: no DOM, no globals, no fetch. Unit-tested under Node
   (`node --test`) and also loaded as a classic browser script, where the
   functions land in global scope for dist/overnight.js to call.
---------------------------------------------------------- */

// Tunable constants.
const OC_MIN_DAYS = 10;        // min distinct days of history to analyse an item
const OC_BASELINE_DAYS = 3;    // recent window the prediction is anchored to
const OC_DIP_MIN_DAYS = 5;     // min distinct days before a price-dip signal is trusted
// Representative price for one timeseries point: mid of avg high/low.
function ocMidPrice(point) {
  const h = point.avgHighPrice, l = point.avgLowPrice;
  if (h != null && l != null) return (h + l) / 2;
  if (h != null) return h;
  if (l != null) return l;
  return null;
}

// Buy-side price: what you'd pay placing a buy offer (avgLowPrice).
function ocLowPrice(point) {
  const l = point.avgLowPrice, h = point.avgHighPrice;
  if (l != null) return l;
  if (h != null) return h;
  return null;
}

// Sell-side price: what you'd receive listing to sell (avgHighPrice).
function ocHighPrice(point) {
  const h = point.avgHighPrice, l = point.avgLowPrice;
  if (h != null) return h;
  if (l != null) return l;
  return null;
}

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

// Median of a numeric array (non-mutating). Returns null if empty.
function medianOf(values) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// midPrices of the points whose UTC hour is in `hours`.
function windowPrices(series, hours, priceFn = ocMidPrice) {
  const set = new Set(hours);
  const out = [];
  for (const point of series) {
    const price = priceFn(point);
    if (price == null) continue;
    if (set.has(new Date(point.timestamp * 1000).getUTCHours())) out.push(price);
  }
  return out;
}

// Median midPrice of the points within the last `days` days of the series.
function recentBaseline(series, days = OC_BASELINE_DAYS, priceFn = ocMidPrice) {
  if (!series.length) return null;
  let maxTs = 0;
  for (const p of series) if (p.timestamp > maxTs) maxTs = p.timestamp;
  const cutoff = maxTs - days * 24 * 3600;
  const recent = [];
  for (const p of series) {
    if (p.timestamp < cutoff) continue;
    const price = priceFn(p);
    if (price != null) recent.push(price);
  }
  return medianOf(recent);
}

// Predicted buy + sell price. Buy side uses avgLowPrice (you place buy offers
// and get filled at the low); sell side uses avgHighPrice (you list to sell).
// Each is a ratio — the chosen hours' median vs the item's overall median —
// anchored to the recent baseline, so a trending item still predicts correctly.
function predictPrices(series, windows, baselineDays = OC_BASELINE_DAYS) {
  const predict = (hours, priceFn) => {
    const baseline = recentBaseline(series, baselineDays, priceFn);
    const all = [];
    for (const p of series) {
      const x = priceFn(p);
      if (x != null) all.push(x);
    }
    const allMedian = medianOf(all);
    if (baseline == null || allMedian == null || allMedian === 0) return null;
    const hourMedian = medianOf(windowPrices(series, hours, priceFn));
    if (hourMedian == null) return null;
    return baseline * (hourMedian / allMedian);
  };
  return {
    predBuy: predict(windows.buyHours, ocLowPrice),
    predSell: predict(windows.sellHours, ocHighPrice),
  };
}

// UTC calendar day key "YYYY-MM-DD" for a unix-seconds timestamp.
function ocDayKey(tsSeconds) {
  return new Date(tsSeconds * 1000).toISOString().slice(0, 10);
}

// Fraction of days on which the buy-hours mean was below the sell-hours mean.
// Wilson lower-bound on the success rate — shrinks small-sample "100%" back
// toward the baseline that finite evidence actually supports. 8-of-8 evaluable
// days becomes ~68%, not 100%; 80-of-80 becomes ~96%. Fixes the "22 items
// showing bogus 100% reliable" issue where a handful of days of buy-mean <
// sell-mean lucked into a perfect streak.
// z=1.96 corresponds to a 95% confidence interval.
function wilsonLowerBound(good, n, z = 1.96) {
  if (n <= 0) return 0;
  const p = good / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))) / denom;
  return Math.max(0, center - half);
}

// Returns { confidence, raw, good, evaluable } where:
//   confidence = Wilson lower-bound (what the UI displays)
//   raw        = naive good / evaluable (kept for backwards debug / diagnostics)
//   good       = day count where buy-hour mean < sell-hour mean
//   evaluable  = day count with both buy-hour and sell-hour points
// The UI can render "X of Y days" for transparency alongside the % chip.
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
  const raw = evaluable > 0 ? good / evaluable : 0;
  return {
    confidence: wilsonLowerBound(good, evaluable),
    raw,
    good,
    evaluable,
  };
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
function analyzeItem(id, series, windows, taxFn, baselineDays = OC_BASELINE_DAYS) {
  if (ocDistinctDays(series) < OC_MIN_DAYS) return null;
  const { predBuy, predSell } = predictPrices(series, windows, baselineDays);
  if (predBuy == null || predSell == null || predBuy <= 0 || predSell <= 0) return null;
  const profit = predictedProfit(predBuy, predSell, taxFn);
  const profitPct = profit / predBuy;
  const c = confidenceOf(series, windows);
  return {
    id,
    predBuy, predSell, profit, profitPct,
    confidence: c.confidence,
    // Extra transparency fields for the UI — how many evaluable days went into
    // the confidence number, and how many were "good" (buy-mean < sell-mean).
    // Also the raw (unshrunk) fraction for anyone who wants to see the pre-
    // Wilson value.
    confidenceGood: c.good,
    confidenceEvaluable: c.evaluable,
    confidenceRaw: c.raw,
    score: rankScore(profitPct, c.confidence),
    curve: hourlyProfile(series),
  };
}

// An item's own cheapest and dearest UTC hour, from its hour-of-day curve
// (the 24-element array from hourlyProfile). Returned as single-hour arrays
// so the result plugs straight into analyzeItem's `windows` parameter
// ({ buyHours, sellHours }). Null-valued hours are skipped.
function extremeHours(curve) {
  let buyHour = null, sellHour = null, lo = Infinity, hi = -Infinity;
  for (let h = 0; h < 24; h++) {
    const v = curve[h];
    if (v == null) continue;
    if (v < lo) { lo = v; buyHour = h; }
    if (v > hi) { hi = v; sellHour = h; }
  }
  return {
    buyHours: buyHour == null ? [] : [buyHour],
    sellHours: sellHour == null ? [] : [sellHour],
  };
}

// Fractional price drift across the series: the recent OC_BASELINE_DAYS-day
// median vs the median of everything older. +0.08 = up 8%, -0.12 = down 12%.
// Returns 0 when there isn't enough data on both sides to compare.
function priceTrend(series) {
  if (!series.length) return 0;
  let maxTs = 0;
  for (const p of series) if (p.timestamp > maxTs) maxTs = p.timestamp;
  const cutoff = maxTs - OC_BASELINE_DAYS * 24 * 3600;
  const recent = [], older = [];
  for (const p of series) {
    const x = ocMidPrice(p);
    if (x == null) continue;
    (p.timestamp >= cutoff ? recent : older).push(x);
  }
  const r = medianOf(recent), o = medianOf(older);
  if (r == null || o == null || o === 0) return 0;
  return (r - o) / o;
}

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

// Convert one recorder day-file — { date:"YYYY-MM-DD", hours:{ H:{ id:[hi,lo] } } }
// — into a flat list of { id, point } entries. Each `point` matches the wiki
// /timeseries shape ({ timestamp, avgHighPrice, avgLowPrice }) with the
// timestamp aligned to the start of that UTC hour, so recorded and live
// points for the same hour share an identical timestamp key.
function dayFileToPoints(dayFile) {
  const out = [];
  if (!dayFile || typeof dayFile.date !== "string" || !dayFile.hours) return out;
  const [y, mo, d] = dayFile.date.split("-").map(Number);
  if (!y || !mo || !d) return out;
  for (const [hourKey, idMap] of Object.entries(dayFile.hours)) {
    const hour = Number(hourKey);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !idMap) continue;
    const timestamp = Date.UTC(y, mo - 1, d, hour) / 1000;
    for (const [id, pair] of Object.entries(idMap)) {
      if (!Array.isArray(pair)) continue;
      out.push({
        id: Number(id),
        point: { timestamp, avgHighPrice: pair[0] ?? null, avgLowPrice: pair[1] ?? null },
      });
    }
  }
  return out;
}

// Merge two timeseries-point arrays into one, deduped by timestamp and sorted
// ascending. `live` (the wiki's own hourly aggregation) wins over `recorded`
// (our once-an-hour snapshot) on any shared timestamp — live is the more
// complete source for the window it covers; recorded extends it further back.
function mergeSeries(recorded, live) {
  const byTs = new Map();
  for (const p of (recorded || [])) if (p && p.timestamp != null) byTs.set(p.timestamp, p);
  for (const p of (live || [])) if (p && p.timestamp != null) byTs.set(p.timestamp, p);
  return [...byTs.values()].sort((a, b) => a.timestamp - b.timestamp);
}

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

// Node test harness can require() this; browsers skip the guard.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    OC_MIN_DAYS, OC_BASELINE_DAYS,
    ocMidPrice, ocLowPrice, ocHighPrice, hourlyProfile,
    medianOf, windowPrices, recentBaseline, predictPrices,
    confidenceOf, predictedProfit, rankScore, analyzeItem,
    extremeHours, priceTrend, dayFileToPoints, mergeSeries, backtestParams,
    priceDip, OC_DIP_MIN_DAYS,
  };
}
