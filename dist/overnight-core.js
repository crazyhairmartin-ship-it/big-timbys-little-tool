/* ---------------- Overnight analytics core ----------------
   Pure functions: no DOM, no globals, no fetch. Unit-tested under Node
   (`node --test`) and also loaded as a classic browser script, where the
   functions land in global scope for dist/overnight.js to call.
---------------------------------------------------------- */

// Tunable constants.
const OC_MIN_DAYS = 10;        // min distinct days of history to analyse an item
const OC_BASELINE_DAYS = 3;    // recent window the prediction is anchored to
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
function predictPrices(series, windows) {
  const predict = (hours, priceFn) => {
    const baseline = recentBaseline(series, OC_BASELINE_DAYS, priceFn);
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
  if (predBuy == null || predSell == null || predBuy <= 0 || predSell <= 0) return null;
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

// ---- functions added in later tasks ----

// Node test harness can require() this; browsers skip the guard.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    OC_MIN_DAYS, OC_BASELINE_DAYS,
    ocMidPrice, ocLowPrice, ocHighPrice, hourlyProfile,
    medianOf, windowPrices, recentBaseline, predictPrices,
    confidenceOf, predictedProfit, rankScore, analyzeItem,
    extremeHours,
  };
}
