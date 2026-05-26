const test = require("node:test");
const assert = require("node:assert");
const core = require("../dist/flips-core.js");

// Minimal mapping: id → wiki item object (as fetched from /mapping).
const MAPPING = {
  995:      { id: 995,      name: "Coins",          limit: 0 },
  11798:    { id: 11798,    name: "Godsword blade", limit: 8 },
  11810:    { id: 11810,    name: "Armadyl hilt",   limit: 8 },
  11812:    { id: 11812,    name: "Bandos hilt",    limit: 8 },
  11802:    { id: 11802,    name: "Armadyl godsword", limit: 8 },
  11804:    { id: 11804,    name: "Bandos godsword",  limit: 8 },
  11820:    { id: 11820,    name: "Godsword shard 1", limit: 100 },
  11818:    { id: 11818,    name: "Godsword shard 2", limit: 100 },
  11822:    { id: 11822,    name: "Godsword shard 3", limit: 100 },
};

test("buildNameIndex creates lowercase name -> id map", () => {
  const idx = core.buildNameIndex(MAPPING);
  assert.strictEqual(idx.get("bandos godsword"), 11804);
  assert.strictEqual(idx.get("godsword blade"), 11798);
});

test("resolveItemNames decorates events with itemId and collects misses", () => {
  const idx = core.buildNameIndex(MAPPING);
  const events = [
    { itemName: "Bandos hilt",     qty: 1, price: 1 },
    { itemName: "Imaginary item",  qty: 1, price: 1 },
    { itemName: "godsword blade",  qty: 1, price: 1 },
  ];
  const { resolved, misses } = core.resolveItemNames(events, idx);
  assert.strictEqual(resolved[0].itemId, 11812);
  assert.strictEqual(resolved[1].itemId, null);
  assert.strictEqual(resolved[2].itemId, 11798);
  assert.deepStrictEqual(misses, [{ name: "Imaginary item", count: 1 }]);
});

test("resolveItemNames aggregates miss counts", () => {
  const idx = core.buildNameIndex(MAPPING);
  const events = [
    { itemName: "Mystery A" },
    { itemName: "Mystery A" },
    { itemName: "Mystery B" },
  ];
  const { misses } = core.resolveItemNames(events, idx);
  assert.deepStrictEqual(
    misses.sort((a, b) => a.name.localeCompare(b.name)),
    [{ name: "Mystery A", count: 2 }, { name: "Mystery B", count: 1 }]
  );
});

const RECIPES_FIXTURE = [
  {
    key: "armadyl-godsword",
    id: 11802,
    name: "Armadyl godsword",
    cat: "Godswords",
    components: [{ id: 11798, qty: 1 }, { id: 11810, qty: 1 }],
  },
  {
    key: "bandos-godsword",
    id: 11804,
    name: "Bandos godsword",
    cat: "Godswords",
    components: [{ id: 11798, qty: 1 }, { id: 11812, qty: 1 }],
  },
  {
    key: "godsword-blade",
    id: 11798,
    name: "Godsword blade",
    cat: "Godswords",
    components: [{ id: 11820, qty: 1 }, { id: 11818, qty: 1 }, { id: 11822, qty: 1 }],
  },
];

test("buildRecipeIndexes maps products and components", () => {
  const idx = core.buildRecipeIndexes(RECIPES_FIXTURE);
  assert.strictEqual(idx.byProduct.get(11798).length, 1);
  assert.strictEqual(idx.byProduct.get(11804).length, 1);
  assert.strictEqual(idx.byComponent.get(11798).length, 2);
  assert.strictEqual(idx.byComponent.get(11820).length, 1);
});

test("buildRecipeIndexes returns undefined for unknown ids", () => {
  const idx = core.buildRecipeIndexes(RECIPES_FIXTURE);
  assert.strictEqual(idx.byProduct.get(999), undefined);
  assert.strictEqual(idx.byComponent.get(999), undefined);
});

test("popFromFIFO consumes lots in oldest-first order", () => {
  const queue = [
    { qty: 3, unitPrice: 100, ts: 1, sourceRowId: "a", status: "complete" },
    { qty: 5, unitPrice: 110, ts: 2, sourceRowId: "b", status: "complete" },
  ];
  const popped = core.popFromFIFO(queue, 4);
  assert.deepStrictEqual(popped.map((l) => [l.qty, l.unitPrice, l.sourceRowId]), [
    [3, 100, "a"], [1, 110, "b"],
  ]);
  assert.strictEqual(queue.length, 1);
  assert.strictEqual(queue[0].qty, 4);
});

test("popFromFIFO returns what it can if inventory is short", () => {
  const queue = [{ qty: 2, unitPrice: 100, ts: 1, sourceRowId: "a", status: "complete" }];
  const popped = core.popFromFIFO(queue, 5);
  assert.strictEqual(popped.length, 1);
  assert.strictEqual(popped[0].qty, 2);
  assert.strictEqual(queue.length, 0);
});

test("popFromFIFO is a no-op on an empty queue", () => {
  const popped = core.popFromFIFO([], 5);
  assert.deepStrictEqual(popped, []);
});

test("popFromFIFO handles missing queue (undefined)", () => {
  const popped = core.popFromFIFO(undefined, 5);
  assert.deepStrictEqual(popped, []);
});

test("selectBestRecipe picks the recipe with the most coverage", () => {
  const inventory = new Map();
  inventory.set(11798, [{ qty: 1, unitPrice: 14000000, ts: 1, sourceRowId: "a", status: "complete" }]);
  inventory.set(11812, [{ qty: 1, unitPrice: 17800000, ts: 2, sourceRowId: "b", status: "complete" }]);
  // No Armadyl hilt -> bandos-godsword has 2/2 covered, armadyl-godsword 1/2.
  const recipes = [RECIPES_FIXTURE[0], RECIPES_FIXTURE[1]];
  const r = core.selectBestRecipe(recipes, inventory, 1);
  assert.strictEqual(r.key, "bandos-godsword");
});

test("selectBestRecipe ties broken by lower cost basis", () => {
  const inventory = new Map();
  inventory.set(11798, [{ qty: 2, unitPrice: 14000000, ts: 1, sourceRowId: "blade", status: "complete" }]);
  inventory.set(11810, [{ qty: 1, unitPrice: 20000000, ts: 2, sourceRowId: "ah", status: "complete" }]);
  inventory.set(11812, [{ qty: 1, unitPrice: 17800000, ts: 3, sourceRowId: "bh", status: "complete" }]);
  const r = core.selectBestRecipe([RECIPES_FIXTURE[0], RECIPES_FIXTURE[1]], inventory, 1);
  assert.strictEqual(r.key, "bandos-godsword");
});

test("selectBestRecipe returns first recipe when no inventory at all", () => {
  const inventory = new Map();
  const r = core.selectBestRecipe([RECIPES_FIXTURE[0], RECIPES_FIXTURE[1]], inventory, 1);
  assert.strictEqual(r.key, "armadyl-godsword");
});

test("attemptConversion computes profit from FIFO lots", () => {
  const inventory = new Map();
  inventory.set(11798, [{ qty: 1, unitPrice: 14200000, ts: 1, sourceRowId: "blade", status: "complete" }]);
  inventory.set(11812, [{ qty: 1, unitPrice: 17800000, ts: 2, sourceRowId: "hilt",  status: "complete" }]);
  const sellEvent = {
    id: "sell", ts: 100, itemId: 11804, itemName: "Bandos godsword",
    qty: 1, price: 33000000, tax: 660000,
  };
  const recipe = RECIPES_FIXTURE[1];
  const indexes = core.buildRecipeIndexes(RECIPES_FIXTURE);
  const wikiPrice = () => { throw new Error("wiki should not be consulted"); };

  const c = core.attemptConversion(sellEvent, recipe, inventory, indexes, wikiPrice, MAPPING);

  assert.strictEqual(c.recipeKey, "bandos-godsword");
  assert.strictEqual(c.revenue, 33000000);
  assert.strictEqual(c.tax, 660000);
  assert.strictEqual(c.totalCost, 14200000 + 17800000);
  assert.strictEqual(c.profit, 33000000 - 660000 - (14200000 + 17800000));
  assert.strictEqual(c.estimated, false);
  assert.strictEqual(c.costBasis.length, 2);
  assert.strictEqual(c.timeToFlip, 100 - 1);
});

test("attemptConversion consumes inventory FIFO", () => {
  const inventory = new Map();
  inventory.set(11798, [{ qty: 2, unitPrice: 14000000, ts: 1, sourceRowId: "blade", status: "complete" }]);
  inventory.set(11812, [{ qty: 2, unitPrice: 17800000, ts: 2, sourceRowId: "hilt",  status: "complete" }]);
  const sellEvent = { id: "s", ts: 100, itemId: 11804, itemName: "Bandos godsword", qty: 1, price: 33000000, tax: 660000 };
  const indexes = core.buildRecipeIndexes(RECIPES_FIXTURE);
  core.attemptConversion(sellEvent, RECIPES_FIXTURE[1], inventory, indexes, () => 0, MAPPING);
  assert.strictEqual(inventory.get(11798)[0].qty, 1);
  assert.strictEqual(inventory.get(11812)[0].qty, 1);
});

test("attemptConversion uses wiki fallback when inventory is short", () => {
  const inventory = new Map();
  inventory.set(11798, [{ qty: 1, unitPrice: 14000000, ts: 1, sourceRowId: "blade", status: "complete" }]);
  const sellEvent = { id: "s", ts: 100, itemId: 11804, itemName: "Bandos godsword", qty: 1, price: 33000000, tax: 660000 };
  const indexes = core.buildRecipeIndexes(RECIPES_FIXTURE);
  const wikiPrice = (id, ts) => {
    assert.strictEqual(id, 11812);
    assert.strictEqual(ts, 100);
    return 17500000;
  };
  const c = core.attemptConversion(sellEvent, RECIPES_FIXTURE[1], inventory, indexes, wikiPrice, MAPPING);
  assert.strictEqual(c.estimated, true);
  assert.strictEqual(c.totalCost, 14000000 + 17500000);
  const hiltCost = c.costBasis.find((cb) => cb.itemId === 11812);
  assert.strictEqual(hiltCost.estimatedQty, 1);
});

test("attemptConversion with zero matching inventory falls back fully", () => {
  const inventory = new Map();
  const sellEvent = { id: "s", ts: 100, itemId: 11804, itemName: "Bandos godsword", qty: 1, price: 33000000, tax: 660000 };
  const indexes = core.buildRecipeIndexes(RECIPES_FIXTURE);
  const wikiPrice = (id) => id === 11798 ? 14000000 : 17500000;
  const c = core.attemptConversion(sellEvent, RECIPES_FIXTURE[1], inventory, indexes, wikiPrice, MAPPING);
  assert.strictEqual(c.estimated, true);
  assert.strictEqual(c.totalCost, 14000000 + 17500000);
});

test("nested recipe: shards in inventory back out a self-assembled blade", () => {
  const inventory = new Map();
  inventory.set(11820, [{ qty: 1, unitPrice: 4_000_000, ts: 1, sourceRowId: "s1", status: "complete" }]);
  inventory.set(11818, [{ qty: 1, unitPrice: 4_500_000, ts: 2, sourceRowId: "s2", status: "complete" }]);
  inventory.set(11822, [{ qty: 1, unitPrice: 5_700_000, ts: 3, sourceRowId: "s3", status: "complete" }]);
  inventory.set(11812, [{ qty: 1, unitPrice: 17_800_000, ts: 4, sourceRowId: "h", status: "complete" }]);
  const sellEvent = { id: "sell", ts: 100, itemId: 11804, itemName: "Bandos godsword", qty: 1, price: 33_000_000, tax: 660_000 };
  const indexes = core.buildRecipeIndexes(RECIPES_FIXTURE);
  const wikiPrice = () => { throw new Error("wiki should not be consulted"); };

  const c = core.attemptConversion(sellEvent, RECIPES_FIXTURE[1], inventory, indexes, wikiPrice, MAPPING);

  assert.strictEqual(c.totalCost, 4_000_000 + 4_500_000 + 5_700_000 + 17_800_000);
  assert.strictEqual(c.estimated, false);
  const bladeCost = c.costBasis.find((cb) => cb.itemId === 11798);
  assert.strictEqual(bladeCost.selfAssembledQty, 1);
});

test("nested recipe with mixed shard inventory falls back to wiki for missing shard", () => {
  const inventory = new Map();
  inventory.set(11820, [{ qty: 1, unitPrice: 4_000_000, ts: 1, sourceRowId: "s1", status: "complete" }]);
  inventory.set(11818, [{ qty: 1, unitPrice: 4_500_000, ts: 2, sourceRowId: "s2", status: "complete" }]);
  inventory.set(11812, [{ qty: 1, unitPrice: 17_800_000, ts: 4, sourceRowId: "h", status: "complete" }]);
  const sellEvent = { id: "sell", ts: 100, itemId: 11804, itemName: "Bandos godsword", qty: 1, price: 33_000_000, tax: 660_000 };
  const indexes = core.buildRecipeIndexes(RECIPES_FIXTURE);
  const wikiPrice = (id) => id === 11822 ? 5_500_000 : 0;
  const c = core.attemptConversion(sellEvent, RECIPES_FIXTURE[1], inventory, indexes, wikiPrice, MAPPING);
  assert.strictEqual(c.estimated, true);
  assert.strictEqual(c.totalCost, 4_000_000 + 4_500_000 + 5_500_000 + 17_800_000);
});
