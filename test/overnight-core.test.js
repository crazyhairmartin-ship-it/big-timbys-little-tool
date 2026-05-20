const test = require("node:test");
const assert = require("node:assert");
const core = require("../dist/overnight-core.js");

test("ocMidPrice averages high and low", () => {
  assert.strictEqual(core.ocMidPrice({ avgHighPrice: 100, avgLowPrice: 80 }), 90);
});

test("ocMidPrice falls back to whichever side is present", () => {
  assert.strictEqual(core.ocMidPrice({ avgHighPrice: 100, avgLowPrice: null }), 100);
  assert.strictEqual(core.ocMidPrice({ avgHighPrice: null, avgLowPrice: 80 }), 80);
});

test("ocMidPrice returns null when both sides missing", () => {
  assert.strictEqual(core.ocMidPrice({ avgHighPrice: null, avgLowPrice: null }), null);
});

test("hourlyProfile buckets points by UTC hour", () => {
  // Two points at 03:00 UTC (prices 100, 120) -> hour 3 mean = 110.
  // One point at 15:00 UTC (price 200) -> hour 15 = 200.
  const at = (h, price) => ({
    timestamp: Math.floor(Date.UTC(2026, 0, 1, h) / 1000),
    avgHighPrice: price, avgLowPrice: price,
  });
  const curve = core.hourlyProfile([at(3, 100), at(3, 120), at(15, 200)]);
  assert.strictEqual(curve.length, 24);
  assert.strictEqual(curve[3], 110);
  assert.strictEqual(curve[15], 200);
  assert.strictEqual(curve[4], null); // no data -> null
});

test("hourlyProfile ignores points with no usable price", () => {
  const ts = Math.floor(Date.UTC(2026, 0, 1, 8) / 1000);
  const curve = core.hourlyProfile([
    { timestamp: ts, avgHighPrice: null, avgLowPrice: null },
    { timestamp: ts, avgHighPrice: 50, avgLowPrice: 50 },
  ]);
  assert.strictEqual(curve[8], 50);
});

test("normalizeCurve divides by the mean of non-null entries", () => {
  const curve = new Array(24).fill(null);
  curve[0] = 50; curve[1] = 150; // mean of present entries = 100
  const norm = core.normalizeCurve(curve);
  assert.strictEqual(norm[0], 0.5);
  assert.strictEqual(norm[1], 1.5);
  assert.strictEqual(norm[2], null);
});

test("calibrateWindows finds lowest and highest 6h blocks", () => {
  // Build one normalized curve: cheapest around hours 2-7, dearest around 14-19.
  const curve = new Array(24);
  for (let h = 0; h < 24; h++) {
    if (h >= 2 && h < 8) curve[h] = 0.8;
    else if (h >= 14 && h < 20) curve[h] = 1.2;
    else curve[h] = 1.0;
  }
  const w = core.calibrateWindows([curve], 6);
  assert.deepStrictEqual([...w.buyHours].sort((a, b) => a - b), [2, 3, 4, 5, 6, 7]);
  assert.deepStrictEqual([...w.sellHours].sort((a, b) => a - b), [14, 15, 16, 17, 18, 19]);
  assert.strictEqual(w.globalCurve.length, 24);
});

test("calibrateWindows window can wrap past hour 23", () => {
  const curve = new Array(24).fill(1.0);
  // cheapest block straddles midnight: hours 22,23,0,1,2,3
  for (const h of [22, 23, 0, 1, 2, 3]) curve[h] = 0.5;
  const w = core.calibrateWindows([curve], 6);
  assert.deepStrictEqual([...w.buyHours].sort((a, b) => a - b), [0, 1, 2, 3, 22, 23]);
});

// Helper: build a series spanning `days` days, one point per hour, where
// the price depends only on the hour-of-day via priceForHour(hour).
function buildSeries(days, priceForHour) {
  const series = [];
  const start = Date.UTC(2026, 0, 1, 0);
  for (let d = 0; d < days; d++) {
    for (let h = 0; h < 24; h++) {
      const ts = Math.floor((start + (d * 24 + h) * 3600 * 1000) / 1000);
      const p = priceForHour(h);
      series.push({ timestamp: ts, avgHighPrice: p, avgLowPrice: p });
    }
  }
  return series;
}

test("medianOf returns the middle value", () => {
  assert.strictEqual(core.medianOf([3, 1, 2]), 2);
  assert.strictEqual(core.medianOf([4, 1, 3, 2]), 2.5);
});

test("predictPrices anchors ratios to the recent baseline", () => {
  // Hours 0-5 cost 80, hours 12-17 cost 120, everything else 100.
  const series = buildSeries(14, h => {
    if (h < 6) return 80;
    if (h >= 12 && h < 18) return 120;
    return 100;
  });
  const windows = { buyHours: [0, 1, 2, 3, 4, 5], sellHours: [12, 13, 14, 15, 16, 17] };
  const p = core.predictPrices(series, windows);
  // baseline = recent median of all hours. overnightRatio = 80/median.
  assert.ok(p.predBuy < p.predSell, "buy should be below sell");
  assert.ok(Math.abs(p.predBuy - 80) < 5, `predBuy ~80, got ${p.predBuy}`);
  assert.ok(Math.abs(p.predSell - 120) < 5, `predSell ~120, got ${p.predSell}`);
});

test("confidenceOf is 1.0 when buy hours are always below sell hours", () => {
  const series = buildSeries(14, h => (h < 6 ? 80 : 120));
  const windows = { buyHours: [0, 1, 2, 3, 4, 5], sellHours: [12, 13, 14, 15, 16, 17] };
  assert.strictEqual(core.confidenceOf(series, windows), 1);
});

test("confidenceOf is ~0.5 when the pattern holds on half the days", () => {
  // Even days: dip overnight. Odd days: flat (no dip).
  const start = Date.UTC(2026, 0, 1, 0);
  const series = [];
  for (let d = 0; d < 14; d++) {
    for (let h = 0; h < 24; h++) {
      const ts = Math.floor((start + (d * 24 + h) * 3600 * 1000) / 1000);
      const p = (d % 2 === 0 && h < 6) ? 80 : 100;
      series.push({ timestamp: ts, avgHighPrice: p, avgLowPrice: p });
    }
  }
  const windows = { buyHours: [0, 1, 2, 3, 4, 5], sellHours: [12, 13, 14, 15, 16, 17] };
  const c = core.confidenceOf(series, windows);
  assert.ok(c >= 0.45 && c <= 0.55, `expected ~0.5, got ${c}`);
});

test("predictedProfit nets the tax off the sale", () => {
  const noTax = () => 0;
  assert.strictEqual(core.predictedProfit(100, 150, noTax), 50);
  const tenPct = sell => sell * 0.1;
  assert.strictEqual(core.predictedProfit(100, 150, tenPct), 35); // 150 - 15 - 100
});

test("rankScore squares confidence", () => {
  assert.ok(Math.abs(core.rankScore(0.2, 0.5) - 0.05) < 1e-9);
  assert.ok(Math.abs(core.rankScore(0.1, 1.0) - 0.1) < 1e-9);
});

test("analyzeItem returns null for too-thin history", () => {
  const windows = { buyHours: [0, 1, 2, 3, 4, 5], sellHours: [12, 13, 14, 15, 16, 17] };
  const series = buildSeries(3, h => 100); // 3 days < OC_MIN_DAYS
  assert.strictEqual(core.analyzeItem(7, series, windows, () => 0), null);
});

test("analyzeItem produces a full analysis for a clean pattern", () => {
  const windows = { buyHours: [0, 1, 2, 3, 4, 5], sellHours: [12, 13, 14, 15, 16, 17] };
  const series = buildSeries(14, h => {
    if (h < 6) return 80;
    if (h >= 12 && h < 18) return 120;
    return 100;
  });
  const a = core.analyzeItem(7, series, windows, sell => sell * 0.02);
  assert.strictEqual(a.id, 7);
  assert.ok(a.predBuy < a.predSell);
  assert.strictEqual(a.confidence, 1);
  assert.ok(a.profit > 0);
  assert.ok(a.profitPct > 0);
  assert.ok(a.score > 0);
  assert.strictEqual(a.curve.length, 24);
});
