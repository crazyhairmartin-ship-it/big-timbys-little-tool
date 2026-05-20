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
