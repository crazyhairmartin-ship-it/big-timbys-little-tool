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

// ---- functions added in later tasks ----

// Node test harness can require() this; browsers skip the guard.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    OC_WINDOW_WIDTH, OC_MIN_DAYS, OC_BASELINE_DAYS, OC_CONFIDENCE_FLOOR,
    ocMidPrice, hourlyProfile,
  };
}
