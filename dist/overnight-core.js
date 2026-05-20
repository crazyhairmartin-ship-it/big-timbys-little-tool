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

// ---- functions added in later tasks ----

// Node test harness can require() this; browsers skip the guard.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    OC_WINDOW_WIDTH, OC_MIN_DAYS, OC_BASELINE_DAYS, OC_CONFIDENCE_FLOOR,
    ocMidPrice, hourlyProfile, normalizeCurve, calibrateWindows,
  };
}
