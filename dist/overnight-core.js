/* ---------------- Overnight analytics core ----------------
   Pure functions: no DOM, no globals, no fetch. Unit-tested under Node
   (`node --test`) and also loaded as a classic browser script, where the
   functions land in global scope for dist/overnight.js to call.
---------------------------------------------------------- */

// Tunable constants.
const OC_WINDOW_WIDTH = 6;     // hours in the buy / sell window
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
    OC_WINDOW_WIDTH, OC_MIN_DAYS, OC_BASELINE_DAYS,
    ocMidPrice, hourlyProfile, normalizeCurve, calibrateWindows,
    medianOf, windowPrices, recentBaseline, predictPrices,
    confidenceOf, predictedProfit, rankScore, analyzeItem,
    extremeHours,
  };
}
