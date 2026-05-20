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

// ---- functions added in later tasks ----

// Node test harness can require() this; browsers skip the guard.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    OC_WINDOW_WIDTH, OC_MIN_DAYS, OC_BASELINE_DAYS, OC_CONFIDENCE_FLOOR,
    ocMidPrice, hourlyProfile, normalizeCurve, calibrateWindows,
    medianOf, windowPrices, recentBaseline, predictPrices,
  };
}
