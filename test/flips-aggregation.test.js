const test = require("node:test");
const assert = require("node:assert");
const core = require("../dist/flips-core.js");

const CONVERSIONS = [
  { ts: 1000, recipeKey: "a", productName: "A", profit:  100, revenue: 1000, totalCost: 900,  tax: 0, timeToFlip: 60_000, estimated: false, productId: 1, productQty: 1 },
  { ts: 2000, recipeKey: "a", productName: "A", profit: -200, revenue: 1000, totalCost: 1200, tax: 0, timeToFlip: 30_000, estimated: true,  productId: 1, productQty: 1 },
  { ts: 3000, recipeKey: "a", productName: "A", profit:  500, revenue: 1500, totalCost: 1000, tax: 0, timeToFlip: 90_000, estimated: false, productId: 1, productQty: 1 },
  { ts: 4000, recipeKey: "b", productName: "B", profit:  300, revenue: 1500, totalCost: 1200, tax: 0, timeToFlip: 45_000, estimated: false, productId: 2, productQty: 1 },
];

const RECIPES = [
  { key: "a", id: 1, name: "Recipe A", cat: "Misc", components: [] },
  { key: "b", id: 2, name: "Recipe B", cat: "Misc", components: [] },
];

test("summarizeRecipes computes per-recipe totals and averages", () => {
  const summary = core.summarizeRecipes(CONVERSIONS, RECIPES);
  const a = summary.find((s) => s.recipeKey === "a");
  assert.strictEqual(a.conversions, 3);
  assert.strictEqual(a.totalProfit, 400);
  assert.strictEqual(a.totalRevenue, 3500);
  assert.strictEqual(a.totalCost, 3100);
  assert.strictEqual(Math.round(a.avgProfit), 133);
  assert.strictEqual(a.avgTimeToFlip, (60_000 + 30_000 + 90_000) / 3);
  assert.strictEqual(Math.round(a.winRate * 100) / 100, 0.67);
  assert.strictEqual(Math.round(a.estimatedShare * 100) / 100, 0.33);
  assert.strictEqual(a.firstTs, 1000);
  assert.strictEqual(a.lastTs, 3000);
});

test("summarizeRecipes orders by totalProfit desc by default", () => {
  const summary = core.summarizeRecipes(CONVERSIONS, RECIPES);
  assert.deepStrictEqual(summary.map((s) => s.recipeKey), ["a", "b"]);
});

test("filterConversionsByRange returns subset in [start, end)", () => {
  const subset = core.filterConversionsByRange(CONVERSIONS, 2000, 4000);
  assert.deepStrictEqual(subset.map((c) => c.ts), [2000, 3000]);
});

test("filterConversionsByRange treats null bounds as unbounded", () => {
  assert.strictEqual(core.filterConversionsByRange(CONVERSIONS, null, null).length, 4);
  assert.strictEqual(core.filterConversionsByRange(CONVERSIONS, 3000, null).length, 2);
});
