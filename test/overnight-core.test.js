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

test("analyzeItem returns null when no history lands in the sell window", () => {
  // 14 days of hourly points, but only hours 0-11 — nothing in sell hours 12-17.
  const start = Date.UTC(2026, 0, 1, 0);
  const series = [];
  for (let d = 0; d < 14; d++) {
    for (let h = 0; h < 12; h++) {
      const ts = Math.floor((start + (d * 24 + h) * 3600 * 1000) / 1000);
      series.push({ timestamp: ts, avgHighPrice: 100, avgLowPrice: 100 });
    }
  }
  const windows = { buyHours: [0, 1, 2, 3, 4, 5], sellHours: [12, 13, 14, 15, 16, 17] };
  assert.strictEqual(core.analyzeItem(1, series, windows, () => 0), null);
});

test("extremeHours finds the cheapest and dearest hour", () => {
  const curve = new Array(24).fill(100);
  curve[5] = 60;    // cheapest
  curve[18] = 140;  // dearest
  const w = core.extremeHours(curve);
  assert.deepStrictEqual(w.buyHours, [5]);
  assert.deepStrictEqual(w.sellHours, [18]);
});

test("extremeHours skips null-valued hours", () => {
  const curve = new Array(24).fill(null);
  curve[3] = 50;
  curve[9] = 200;
  const w = core.extremeHours(curve);
  assert.deepStrictEqual(w.buyHours, [3]);
  assert.deepStrictEqual(w.sellHours, [9]);
});

test("predictPrices uses the low at the buy hour and the high at the sell hour", () => {
  // 14 days; hour 2: low 80 / high 100; hour 14: low 120 / high 160; else 100/120.
  const start = Date.UTC(2026, 0, 1, 0);
  const series = [];
  for (let d = 0; d < 14; d++) {
    for (let h = 0; h < 24; h++) {
      const ts = Math.floor((start + (d * 24 + h) * 3600 * 1000) / 1000);
      let lo = 100, hi = 120;
      if (h === 2) { lo = 80; hi = 100; }
      if (h === 14) { lo = 120; hi = 160; }
      series.push({ timestamp: ts, avgLowPrice: lo, avgHighPrice: hi });
    }
  }
  const p = core.predictPrices(series, { buyHours: [2], sellHours: [14] });
  assert.ok(Math.abs(p.predBuy - 80) < 8, `predBuy ~80 (the LOW at hour 2), got ${p.predBuy}`);
  assert.ok(Math.abs(p.predSell - 160) < 12, `predSell ~160 (the HIGH at hour 14), got ${p.predSell}`);
});

test("priceTrend is positive for a rising series, negative for a falling one", () => {
  const start = Date.UTC(2026, 0, 1, 0);
  const mk = (priceForDay) => {
    const s = [];
    for (let d = 0; d < 14; d++) {
      for (let h = 0; h < 24; h++) {
        const ts = Math.floor((start + (d * 24 + h) * 3600 * 1000) / 1000);
        const p = priceForDay(d);
        s.push({ timestamp: ts, avgHighPrice: p, avgLowPrice: p });
      }
    }
    return s;
  };
  assert.ok(core.priceTrend(mk(d => 100 + d * 5)) > 0.1, "rising series -> positive");
  assert.ok(core.priceTrend(mk(d => 200 - d * 5)) < -0.1, "falling series -> negative");
  assert.strictEqual(core.priceTrend(mk(() => 100)), 0, "flat series -> 0");
});

test("dayFileToPoints converts a recorder day-file to hour-aligned points", () => {
  const pts = core.dayFileToPoints({
    date: "2026-05-04",
    hours: { "0": { "11802": [120, 100] }, "13": { "11802": [200, 180], "999": [5, 4] } },
  });
  assert.strictEqual(pts.length, 3);
  const ags0 = pts.find(p => p.id === 11802 && p.point.timestamp === Date.UTC(2026, 4, 4, 0) / 1000);
  assert.deepStrictEqual(ags0.point, {
    timestamp: Date.UTC(2026, 4, 4, 0) / 1000, avgHighPrice: 120, avgLowPrice: 100,
  });
  assert.strictEqual(typeof ags0.id, "number"); // ids coerced from JSON string keys
  const ags13 = pts.find(p => p.id === 11802 && p.point.timestamp === Date.UTC(2026, 4, 4, 13) / 1000);
  assert.strictEqual(ags13.point.avgHighPrice, 200);
});

test("dayFileToPoints tolerates a malformed day-file", () => {
  assert.deepStrictEqual(core.dayFileToPoints(null), []);
  assert.deepStrictEqual(core.dayFileToPoints({ date: "2026-05-04" }), []);
  assert.deepStrictEqual(core.dayFileToPoints({ hours: { "0": {} } }), []);
});

test("mergeSeries dedups by timestamp with live winning over recorded", () => {
  const recorded = [
    { timestamp: 100, avgHighPrice: 10, avgLowPrice: 8 },
    { timestamp: 200, avgHighPrice: 20, avgLowPrice: 18 }, // overlaps live
  ];
  const live = [
    { timestamp: 200, avgHighPrice: 99, avgLowPrice: 90 }, // wins the 200 slot
    { timestamp: 300, avgHighPrice: 30, avgLowPrice: 28 },
  ];
  const merged = core.mergeSeries(recorded, live);
  assert.deepStrictEqual(merged.map(p => p.timestamp), [100, 200, 300], "sorted, deduped");
  assert.strictEqual(merged.find(p => p.timestamp === 200).avgHighPrice, 99, "live wins overlap");
});

test("mergeSeries handles empty / missing inputs", () => {
  assert.deepStrictEqual(core.mergeSeries([], []), []);
  assert.deepStrictEqual(core.mergeSeries(null, null), []);
  assert.strictEqual(core.mergeSeries([{ timestamp: 1, avgHighPrice: 1, avgLowPrice: 1 }], null).length, 1);
});

test("predictPrices honors the baselineDays argument", () => {
  // 14 days rising 100 -> 230 (+10/day, flat within each day). A short
  // baseline window anchors to recent (higher) prices; a long one averages
  // in older (lower) prices.
  const series = [];
  const start = Date.UTC(2026, 0, 1, 0) / 1000;
  for (let d = 0; d < 14; d++) {
    for (let h = 0; h < 24; h++) {
      const price = 100 + d * 10;
      series.push({ timestamp: start + (d * 24 + h) * 3600, avgHighPrice: price, avgLowPrice: price });
    }
  }
  const windows = { buyHours: [2], sellHours: [14] };
  const short = core.predictPrices(series, windows, 2);
  const long  = core.predictPrices(series, windows, 10);
  assert.ok(short.predBuy > long.predBuy,
    `short baseline anchors higher on a rising series: ${short.predBuy} vs ${long.predBuy}`);
  // Default argument reproduces the explicit OC_BASELINE_DAYS call.
  assert.deepStrictEqual(core.predictPrices(series, windows),
                         core.predictPrices(series, windows, core.OC_BASELINE_DAYS));
  // analyzeItem forwards the 5th argument through to predictPrices — a short
  // vs long baseline must yield a different predicted buy price.
  const aShort = core.analyzeItem("x", series, windows, () => 0, 2);
  const aLong  = core.analyzeItem("x", series, windows, () => 0, 10);
  assert.ok(aShort.predBuy > aLong.predBuy,
    `analyzeItem must forward baselineDays: ${aShort.predBuy} vs ${aLong.predBuy}`);
});

test("backtestParams scores a perfectly repeating series with near-zero error", () => {
  // 20 days; every day low 100 at hour 2, high 130 at hour 14, 115 otherwise.
  const series = [];
  const start = Date.UTC(2026, 0, 1, 0) / 1000;
  for (let d = 0; d < 20; d++) {
    for (let h = 0; h < 24; h++) {
      const price = h === 2 ? 100 : h === 14 ? 130 : 115;
      series.push({ timestamp: start + (d * 24 + h) * 3600, avgHighPrice: price, avgLowPrice: price });
    }
  }
  const res = core.backtestParams(series, { baselineDays: 3, trendDiscount: 0 }, () => 0);
  assert.ok(res.samples > 0, `expected scored test days, got ${res.samples}`);
  assert.ok(res.error != null && res.error < 0.05, `expected near-zero error, got ${res.error}`);
});

test("backtestParams returns no samples when history is below OC_MIN_DAYS", () => {
  const series = [];
  const start = Date.UTC(2026, 0, 1, 0) / 1000;
  for (let d = 0; d < 5; d++) {                      // 5 days < OC_MIN_DAYS (10)
    for (let h = 0; h < 24; h++) {
      series.push({ timestamp: start + (d * 24 + h) * 3600, avgHighPrice: 115, avgLowPrice: 115 });
    }
  }
  const res = core.backtestParams(series, { baselineDays: 3, trendDiscount: 0 }, () => 0);
  assert.strictEqual(res.samples, 0);
  assert.strictEqual(res.error, null);
});
