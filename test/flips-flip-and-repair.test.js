const test = require("node:test");
const assert = require("node:assert");
const core = require("../dist/flips-core.js");

const MAPPING = {
  11798: { id: 11798, name: "Godsword blade",  limit: 8 },
  11810: { id: 11810, name: "Armadyl hilt",    limit: 8 },
  11812: { id: 11812, name: "Bandos hilt",     limit: 8 },
  11802: { id: 11802, name: "Armadyl godsword", limit: 8 },
  11804: { id: 11804, name: "Bandos godsword",  limit: 8 },
  // Verac's broken / repaired (Barrows)
  4753:  { id: 4753,  name: "Verac's plateskirt 0", limit: 8 },
  4759:  { id: 4759,  name: "Verac's plateskirt",   limit: 8 },
};

const RECIPES = [
  {
    key: "bandos-godsword",
    id: 11804,
    name: "Bandos godsword",
    cat: "Godswords",
    components: [{ id: 11798, qty: 1 }, { id: 11812, qty: 1 }],
  },
  {
    key: "verac-plateskirt",
    id: 4759,
    name: "Verac's plateskirt (repaired)",
    cat: "Barrows",
    components: [{ id: 4753, qty: 1 }],
    repairBase: 80_000,
  },
];

// ---------------- Repair cost ----------------

test("fcRepairCost halves at level 99 (mirrors app.js)", () => {
  assert.strictEqual(core.fcRepairCost(80_000, 99), 40_400);
  assert.strictEqual(core.fcRepairCost(80_000, 1), 79_600);
  assert.strictEqual(core.fcRepairCost(0, 99), 0);
  assert.strictEqual(core.fcRepairCost(undefined, 99), 0);
});

test("fcRepairCost falls back to level 99 when smithingLevel is bogus", () => {
  assert.strictEqual(core.fcRepairCost(80_000, NaN), 40_400);
  assert.strictEqual(core.fcRepairCost(80_000, undefined), 40_400);
});

test("attemptConversion adds repair cost line for Barrows recipes", () => {
  const inventory = new Map();
  inventory.set(4753, [{ qty: 1, unitPrice: 2_000_000, ts: 1, sourceRowId: "broken", status: "complete" }]);
  const sellEvent = { id: "s", ts: 100, itemId: 4759, qty: 1, price: 2_500_000, tax: 50_000 };
  const indexes = core.buildRecipeIndexes(RECIPES);
  const c = core.attemptConversion(
    sellEvent, RECIPES[1], inventory, indexes, () => 0, MAPPING, new Map(), { smithingLevel: 99 }
  );
  // Expect cost = broken piece + 40_400 repair at level 99.
  assert.strictEqual(c.totalCost, 2_000_000 + 40_400);
  const repairLine = c.costBasis.find((cb) => cb.repairCost);
  assert.ok(repairLine, "should have a repair cost line");
  assert.strictEqual(repairLine.gp, 40_400);
});

test("attemptConversion scales repair cost with productQty", () => {
  const inventory = new Map();
  inventory.set(4753, [{ qty: 3, unitPrice: 2_000_000, ts: 1, sourceRowId: "x", status: "complete" }]);
  const sellEvent = { id: "s", ts: 100, itemId: 4759, qty: 3, price: 2_500_000, tax: 0 };
  const indexes = core.buildRecipeIndexes(RECIPES);
  const c = core.attemptConversion(
    sellEvent, RECIPES[1], inventory, indexes, () => 0, MAPPING, new Map(), { smithingLevel: 99 }
  );
  const repairLine = c.costBasis.find((cb) => cb.repairCost);
  assert.strictEqual(repairLine.gp, 40_400 * 3);
});

test("attemptConversion uses the smithingLevel passed in options", () => {
  const inventory = new Map();
  inventory.set(4753, [{ qty: 1, unitPrice: 2_000_000, ts: 1, sourceRowId: "x", status: "complete" }]);
  const sellEvent = { id: "s", ts: 100, itemId: 4759, qty: 1, price: 2_500_000, tax: 0 };
  const indexes = core.buildRecipeIndexes(RECIPES);
  const c80 = core.attemptConversion(
    sellEvent, RECIPES[1], inventory, indexes, () => 0, MAPPING, new Map(), { smithingLevel: 80 }
  );
  const repairLine = c80.costBasis.find((cb) => cb.repairCost);
  assert.strictEqual(repairLine.gp, Math.round(80_000 * (1 - 80 / 200)));
  assert.ok(repairLine.itemName.includes("80"), `expected itemName to mention level: ${repairLine.itemName}`);
});

test("attemptConversion omits repair line when recipe has no repairBase", () => {
  const inventory = new Map();
  inventory.set(11798, [{ qty: 1, unitPrice: 14_000_000, ts: 1, sourceRowId: "b", status: "complete" }]);
  inventory.set(11812, [{ qty: 1, unitPrice: 17_800_000, ts: 2, sourceRowId: "h", status: "complete" }]);
  const sellEvent = { id: "s", ts: 100, itemId: 11804, qty: 1, price: 33_000_000, tax: 660_000 };
  const indexes = core.buildRecipeIndexes(RECIPES);
  const c = core.attemptConversion(
    sellEvent, RECIPES[0], inventory, indexes, () => 0, MAPPING, new Map(), { smithingLevel: 99 }
  );
  assert.strictEqual(c.costBasis.some((cb) => cb.repairCost), false);
});

// ---------------- Pure flip emission ----------------

test("matchEvents emits a kind:flip conversion when finished product is bought and sold", () => {
  const events = [
    { id: 1, ts: 1,   itemId: 11804, side: "BUY",  qty: 1, price: 30_000_000, tax: 0, status: "complete" },
    { id: 2, ts: 100, itemId: 11804, side: "SELL", qty: 1, price: 33_000_000, tax: 660_000, status: "complete" },
  ];
  const indexes = core.buildRecipeIndexes(RECIPES);
  const convs = core.matchEvents(events, RECIPES, indexes, () => 0, MAPPING);
  assert.strictEqual(convs.length, 1);
  assert.strictEqual(convs[0].kind, "flip");
  assert.strictEqual(convs[0].recipeKey, "bandos-godsword");
  assert.strictEqual(convs[0].totalCost, 30_000_000);
  assert.strictEqual(convs[0].revenue, 33_000_000);
  assert.strictEqual(convs[0].profit, 33_000_000 - 660_000 - 30_000_000);
});

test("matchEvents skips pure flip of non-recipe items (still no conversion)", () => {
  // Item with no recipe — we don't want random flips polluting the leaderboard.
  const events = [
    { id: 1, ts: 1,   itemId: 11820, side: "BUY",  qty: 1, price: 5_000_000, tax: 0, status: "complete" },
    { id: 2, ts: 100, itemId: 11820, side: "SELL", qty: 1, price: 5_500_000, tax: 110_000, status: "complete" },
  ];
  const indexes = core.buildRecipeIndexes(RECIPES);
  const convs = core.matchEvents(events, RECIPES, indexes, () => 0, MAPPING);
  assert.strictEqual(convs.length, 0);
});

test("matchEvents emits a flip for the portion consumed AND a craft for the remainder", () => {
  // 1 finished godsword in inventory, then components, then sell 2.
  // Expect: 1 flip conv + 1 craft conv.
  const events = [
    { id: 1, ts: 1,   itemId: 11804, side: "BUY",  qty: 1, price: 30_000_000, tax: 0, status: "complete" },
    { id: 2, ts: 2,   itemId: 11798, side: "BUY",  qty: 1, price: 14_000_000, tax: 0, status: "complete" },
    { id: 3, ts: 3,   itemId: 11812, side: "BUY",  qty: 1, price: 17_000_000, tax: 0, status: "complete" },
    { id: 4, ts: 100, itemId: 11804, side: "SELL", qty: 2, price: 33_000_000, tax: 1_320_000, status: "complete" },
  ];
  const indexes = core.buildRecipeIndexes(RECIPES);
  const convs = core.matchEvents(events, RECIPES, indexes, () => 0, MAPPING);
  assert.strictEqual(convs.length, 2);
  const kinds = convs.map((c) => c.kind).sort();
  assert.deepStrictEqual(kinds, ["craft", "flip"]);
});

// ---------------- Craft-vs-flip disambiguation ----------------

test("matchEvents prefers craft when components were bought more recently than finished product", () => {
  // 5/21 case: old finished godsword from a year ago, fresh hilt+blade today, sell godsword.
  const events = [
    { id: 1, ts: 1_000_000,    itemId: 11804, side: "BUY",  qty: 1, price: 30_000_000, tax: 0, status: "complete" },
    { id: 2, ts: 100_000_000,  itemId: 11798, side: "BUY",  qty: 1, price: 14_000_000, tax: 0, status: "complete" },
    { id: 3, ts: 100_000_001,  itemId: 11812, side: "BUY",  qty: 1, price: 17_000_000, tax: 0, status: "complete" },
    { id: 4, ts: 100_000_100,  itemId: 11804, side: "SELL", qty: 1, price: 33_000_000, tax: 660_000, status: "complete" },
  ];
  const indexes = core.buildRecipeIndexes(RECIPES);
  const convs = core.matchEvents(events, RECIPES, indexes, () => 0, MAPPING);
  assert.strictEqual(convs.length, 1);
  assert.strictEqual(convs[0].kind, "craft");
  assert.strictEqual(convs[0].totalCost, 14_000_000 + 17_000_000);
});

test("matchEvents prefers flip when finished product is newer than any component buy", () => {
  // Old components from a year ago, then a recent finished-godsword buy, then sell.
  const events = [
    { id: 1, ts: 1_000_000,   itemId: 11798, side: "BUY",  qty: 1, price: 14_000_000, tax: 0, status: "complete" },
    { id: 2, ts: 1_000_001,   itemId: 11812, side: "BUY",  qty: 1, price: 17_000_000, tax: 0, status: "complete" },
    { id: 3, ts: 100_000_000, itemId: 11804, side: "BUY",  qty: 1, price: 30_000_000, tax: 0, status: "complete" },
    { id: 4, ts: 100_000_100, itemId: 11804, side: "SELL", qty: 1, price: 33_000_000, tax: 660_000, status: "complete" },
  ];
  const indexes = core.buildRecipeIndexes(RECIPES);
  const convs = core.matchEvents(events, RECIPES, indexes, () => 0, MAPPING);
  // Should produce a flip (consumes the recent product buy) and leave the
  // older components alone.
  const flips = convs.filter((c) => c.kind === "flip");
  assert.strictEqual(flips.length, 1);
  assert.strictEqual(flips[0].totalCost, 30_000_000);
});

test("shouldPreferCraft returns false when components are incomplete", () => {
  const productInv = [{ qty: 1, unitPrice: 30_000_000, ts: 1_000_000, sourceRowId: "p", status: "complete" }];
  const inventory = new Map();
  inventory.set(11798, [{ qty: 1, unitPrice: 14_000_000, ts: 9_999_999_999, sourceRowId: "blade", status: "complete" }]);
  // No hilt in inventory.
  const candidates = [RECIPES[0]];
  assert.strictEqual(core.shouldPreferCraft(productInv, candidates, inventory), false);
});

test("shouldPreferCraft returns true when newest required component is newer than product", () => {
  const productInv = [{ qty: 1, unitPrice: 30_000_000, ts: 1, sourceRowId: "p", status: "complete" }];
  const inventory = new Map();
  inventory.set(11798, [{ qty: 1, unitPrice: 14_000_000, ts: 50, sourceRowId: "blade", status: "complete" }]);
  inventory.set(11812, [{ qty: 1, unitPrice: 17_000_000, ts: 100, sourceRowId: "hilt", status: "complete" }]);
  const candidates = [RECIPES[0]];
  assert.strictEqual(core.shouldPreferCraft(productInv, candidates, inventory), true);
});

// ---------------- 7-day craft-preference window ----------------

test("shouldPreferCraft returns true when components are within the 7-day window of the sell", () => {
  const DAY = 24 * 3600 * 1000;
  const sellTs = 100 * DAY;
  const productInv = [{ qty: 1, unitPrice: 30_000_000, ts: 0, sourceRowId: "p", status: "complete" }];
  const inventory = new Map();
  // Components bought 3 days before the sell.
  inventory.set(11798, [{ qty: 1, unitPrice: 14_000_000, ts: sellTs - 3 * DAY, sourceRowId: "blade", status: "complete" }]);
  inventory.set(11812, [{ qty: 1, unitPrice: 17_000_000, ts: sellTs - 2 * DAY, sourceRowId: "hilt",  status: "complete" }]);
  assert.strictEqual(core.shouldPreferCraft(productInv, [RECIPES[0]], inventory, sellTs), true);
});

test("shouldPreferCraft returns false when newest component is older than 7 days before the sell", () => {
  // Flip-and-replace pattern: held finished + stale components from an
  // earlier project. The sell should be treated as a flip of the held one.
  const DAY = 24 * 3600 * 1000;
  const sellTs = 100 * DAY;
  const productInv = [{ qty: 1, unitPrice: 30_000_000, ts: 0, sourceRowId: "p", status: "complete" }];
  const inventory = new Map();
  inventory.set(11798, [{ qty: 1, unitPrice: 14_000_000, ts: sellTs - 30 * DAY, sourceRowId: "blade", status: "complete" }]);
  inventory.set(11812, [{ qty: 1, unitPrice: 17_000_000, ts: sellTs - 30 * DAY, sourceRowId: "hilt",  status: "complete" }]);
  assert.strictEqual(core.shouldPreferCraft(productInv, [RECIPES[0]], inventory, sellTs), false);
});

test("matchEvents: held finished + 30-day-old components -> flip the held one (don't steal components)", () => {
  // The exact pattern the user described: held a godsword (long), bought
  // components weeks ago for a future project, now the godsword price is
  // good and they sell the held one. Components must remain in inventory
  // for a future craft, not be attributed to this sell.
  const DAY = 24 * 3600 * 1000;
  const events = [
    { id: 1, ts: 0,           itemId: 11804, side: "BUY",  qty: 1, price: 30_000_000, tax: 0,       status: "complete" }, // hold the finished
    { id: 2, ts: 70 * DAY,    itemId: 11798, side: "BUY",  qty: 1, price: 14_000_000, tax: 0,       status: "complete" }, // components, 30d before sell
    { id: 3, ts: 70 * DAY,    itemId: 11812, side: "BUY",  qty: 1, price: 17_000_000, tax: 0,       status: "complete" },
    { id: 4, ts: 100 * DAY,   itemId: 11804, side: "SELL", qty: 1, price: 38_000_000, tax: 760_000, status: "complete" },
  ];
  const indexes = core.buildRecipeIndexes(RECIPES);
  const convs = core.matchEvents(events, RECIPES, indexes, () => 0, MAPPING);
  assert.strictEqual(convs.length, 1);
  assert.strictEqual(convs[0].kind, "flip", "should flip the long-held finished product, not steal stale components");
  assert.strictEqual(convs[0].totalCost, 30_000_000);
});

test("matchEvents: same-day component buy still triggers craft attribution", () => {
  // Regression: the 5/21-style same-day craft must still resolve as a craft.
  const DAY = 24 * 3600 * 1000;
  const HOUR = 3600 * 1000;
  const events = [
    { id: 1, ts: 0,                                   itemId: 11804, side: "BUY",  qty: 1, price: 30_000_000, tax: 0,       status: "complete" }, // held finished, ancient
    { id: 2, ts: 365 * DAY,                           itemId: 11798, side: "BUY",  qty: 1, price: 14_000_000, tax: 0,       status: "complete" }, // blade today
    { id: 3, ts: 365 * DAY + 2 * HOUR,                itemId: 11812, side: "BUY",  qty: 1, price: 17_000_000, tax: 0,       status: "complete" }, // hilt 2h later
    { id: 4, ts: 365 * DAY + 4 * HOUR + 30 * 60_000,  itemId: 11804, side: "SELL", qty: 1, price: 38_000_000, tax: 760_000, status: "complete" }, // sell 4.5h after first buy
  ];
  const indexes = core.buildRecipeIndexes(RECIPES);
  const convs = core.matchEvents(events, RECIPES, indexes, () => 0, MAPPING);
  assert.strictEqual(convs.length, 1);
  assert.strictEqual(convs[0].kind, "craft");
  assert.strictEqual(convs[0].totalCost, 14_000_000 + 17_000_000);
});

// ---------------- LIFO regression: long-hold + active flipping ----------------

test("long-held lot is preserved when user actively flips the same item", () => {
  // Masori-helm-style scenario: bought 1 a year ago and never sold it, then
  // did several quick buy-and-flip cycles. Each flip-cycle SELL should be
  // paired with its own freshly-bought lot, NOT with the year-old hold.
  const DAY = 24 * 3600 * 1000;
  const events = [
    // The long-term hold: bought day 0, never the one being sold below.
    { id: 1, ts: 0,             itemId: 11804, side: "BUY",  qty: 1, price: 30_000_000, tax: 0,         status: "complete" },

    // Flip cycle 1: bought day 100, sold day 101.
    { id: 2, ts: 100 * DAY,     itemId: 11804, side: "BUY",  qty: 1, price: 31_000_000, tax: 0,         status: "complete" },
    { id: 3, ts: 101 * DAY,     itemId: 11804, side: "SELL", qty: 1, price: 32_000_000, tax: 640_000,   status: "complete" },

    // Flip cycle 2: bought day 200, sold day 201.
    { id: 4, ts: 200 * DAY,     itemId: 11804, side: "BUY",  qty: 1, price: 31_500_000, tax: 0,         status: "complete" },
    { id: 5, ts: 201 * DAY,     itemId: 11804, side: "SELL", qty: 1, price: 32_500_000, tax: 650_000,   status: "complete" },

    // Flip cycle 3: bought day 320, sold day 321.
    { id: 6, ts: 320 * DAY,     itemId: 11804, side: "BUY",  qty: 1, price: 32_000_000, tax: 0,         status: "complete" },
    { id: 7, ts: 321 * DAY,     itemId: 11804, side: "SELL", qty: 1, price: 33_000_000, tax: 660_000,   status: "complete" },
  ];
  const indexes = core.buildRecipeIndexes(RECIPES);
  const convs = core.matchEvents(events, RECIPES, indexes, () => 0, MAPPING);

  // Three quick flips, all one-day holds — NOT one 321-day hold.
  assert.strictEqual(convs.length, 3, "expected 3 flip conversions");
  for (const c of convs) {
    assert.strictEqual(c.kind, "flip");
    assert.strictEqual(c.timeToFlip, 1 * DAY, `expected 1-day flip, got ${c.timeToFlip / DAY} days`);
  }
});
