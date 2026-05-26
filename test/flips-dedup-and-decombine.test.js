const test = require("node:test");
const assert = require("node:assert");
const core = require("../dist/flips-core.js");

const MAPPING = {
  4714: { id: 4714, name: "Ahrim's robeskirt",     limit: 8 },
  4878: { id: 4878, name: "Ahrim's robeskirt 0",   limit: 8 },
  4720: { id: 4720, name: "Dharok's platebody",    limit: 8 },
  4896: { id: 4896, name: "Dharok's platebody 0",  limit: 8 },
  12924: { id: 12924, name: "Toxic blowpipe (empty)", limit: 8 },
  12934: { id: 12934, name: "Zulrah's scales",     limit: 18000 },
};

const BARROWS_RECIPES = [
  { key: "ahrs", id: 4714, name: "Ahrim's robeskirt",  cat: "Barrows", components: [{ id: 4878, qty: 1 }], repairBase: 80_000 },
  { key: "dhpb", id: 4720, name: "Dharok's platebody", cat: "Barrows", components: [{ id: 4896, qty: 1 }], repairBase: 90_000 },
];

const DECOMBINE_RECIPES = [
  { key: "decomb-scales-pipe", id: 12934, name: "Zulrah's scales ← Toxic blowpipe (crack)", cat: "Decombines", components: [{ id: 12924, qty: 1 }], resultQty: 20000 },
];

// ---------------- Copilot partial-fill aggregation ----------------

test("parseCopilot collapses identical-timestamp duplicate rows into one event", () => {
  // Copilot occasionally exports a row twice (or splits a single listing into
  // multiple sub-fills logged at the same second). The Dharok's platebody
  // 1084-day-flip ghost trace back to this kind of duplicate.
  const csv = [
    "Timestamp,Account,Side,Item,Quantity,Paid/Received,Tax,Price ea.,Part of Flip",
    "2026-05-14T14:00:34Z,Big Timby,SELL,Dharok's platebody,4,3397968,67960,849492,NO",
    "2026-05-14T14:00:34Z,Big Timby,SELL,Dharok's platebody,4,3397968,67960,849492,NO",
  ].join("\n");
  const events = core.parseCopilot(csv);
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].qty, 8);
});

test("parseCopilot aggregates partial fills inside a 60s window", () => {
  // Two fills 30s apart from the same listing -> one event with summed qty.
  const csv = [
    "Timestamp,Account,Side,Item,Quantity,Paid/Received,Tax,Price ea.,Part of Flip",
    "2026-05-14T14:00:00Z,Big Timby,SELL,Dharok's platebody,3,2548476,50970,849492,NO",
    "2026-05-14T14:00:30Z,Big Timby,SELL,Dharok's platebody,5,4247460,84950,849492,NO",
  ].join("\n");
  const events = core.parseCopilot(csv);
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].qty, 8);
});

test("parseCopilot does NOT aggregate rows separated by more than 60s", () => {
  const csv = [
    "Timestamp,Account,Side,Item,Quantity,Paid/Received,Tax,Price ea.,Part of Flip",
    "2026-05-14T02:46:11Z,Big Timby,SELL,Dharok's platebody,4,3397968,67960,849492,NO",
    "2026-05-14T14:00:34Z,Big Timby,SELL,Dharok's platebody,4,3397968,67960,849492,NO",
  ].join("\n");
  const events = core.parseCopilot(csv);
  assert.strictEqual(events.length, 2);
});

test("parseCopilot does NOT aggregate rows with different prices", () => {
  const csv = [
    "Timestamp,Account,Side,Item,Quantity,Paid/Received,Tax,Price ea.,Part of Flip",
    "2026-05-14T14:00:00Z,Big Timby,SELL,Dharok's platebody,4,3397968,67960,849492,NO",
    "2026-05-14T14:00:30Z,Big Timby,SELL,Dharok's platebody,4,3399968,67960,849992,NO",
  ].join("\n");
  const events = core.parseCopilot(csv);
  assert.strictEqual(events.length, 2);
});

// ---------------- Drop fractional decombines ----------------

test("matchEvents drops a fractional decombine attempt (plain scale flipping into blowpipe)", () => {
  // User bought a Toxic blowpipe to flip; later sells scales they got from
  // a separate source (or pre-history). Without scale inventory, the old
  // code would attempt a decombine consuming 0.057 of the blowpipe — drop.
  const events = [
    { id: 1, ts: Date.parse("2025-04-08T17:00:00Z"), itemId: 12924, itemName: "Toxic blowpipe (empty)", side: "BUY",  qty: 1,    price: 6_955_841, tax: 0, status: "complete" },
    { id: 2, ts: Date.parse("2025-04-08T17:40:00Z"), itemId: 12934, itemName: "Zulrah's scales",        side: "SELL", qty: 1139, price: 257,        tax: 2278, status: "complete" },
  ];
  const indexes = core.buildRecipeIndexes(DECOMBINE_RECIPES);
  const convs = core.matchEvents(events, DECOMBINE_RECIPES, indexes, () => 250, MAPPING);
  assert.strictEqual(convs.length, 0, "expected no decombine conversion for a fractional scale sale");
});

test("matchEvents still allows a real whole-multiple decombine", () => {
  // sell exactly 20,000 scales right after buying a blowpipe — looks like a
  // real decombine and should still register.
  const events = [
    { id: 1, ts: Date.parse("2025-04-08T17:00:00Z"), itemId: 12924, itemName: "Toxic blowpipe (empty)", side: "BUY",  qty: 1,     price: 6_955_841, tax: 0,       status: "complete" },
    { id: 2, ts: Date.parse("2025-04-08T17:40:00Z"), itemId: 12934, itemName: "Zulrah's scales",        side: "SELL", qty: 20000, price: 350,        tax: 140_000, status: "complete" },
  ];
  const indexes = core.buildRecipeIndexes(DECOMBINE_RECIPES);
  const convs = core.matchEvents(events, DECOMBINE_RECIPES, indexes, () => 0, MAPPING);
  assert.strictEqual(convs.length, 1);
  assert.strictEqual(convs[0].kind, "craft");
});

// ---------------- Drop fake repair-crafts (pre-history pure flip) ----------------

test("shouldDropConversion drops a repair-recipe conv whose broken item is wiki-fallback", () => {
  // Pre-history flip: user sold a repaired Barrows piece they owned from
  // before the data window. No broken-piece buy in inventory -> the craft
  // path wiki-fallbacks the broken item. Treat as not-a-craft and drop.
  const events = [
    { id: 1, ts: Date.parse("2026-05-14T10:00:00Z"), itemId: 4714, itemName: "Ahrim's robeskirt", side: "SELL", qty: 1, price: 3_000_000, tax: 60_000, status: "complete" },
  ];
  const indexes = core.buildRecipeIndexes(BARROWS_RECIPES);
  const convs = core.matchEvents(events, BARROWS_RECIPES, indexes, (id) => id === 4878 ? 2_500_000 : 0, MAPPING, { smithingLevel: 99 });
  assert.strictEqual(convs.length, 0, "should drop the phantom craft");
});

test("partial shortfall on primary keeps the conversion (Venator 4/5, Oathplate 350/450)", () => {
  // User bought 4 of 5 Venator shards in-window; the 5th came from pre-history
  // inventory we can't see. Previously this conversion was dropped because
  // the primary (shards) had any wiki-fallback at all; now it stays visible
  // and the shortfall is priced via self-extrapolation from the user's own
  // recent shard buys (so the cost basis is realistic, not just wiki).
  const MAP = {
    27614: { id: 27614, name: "Venator shard",        limit: 50 },
    27612: { id: 27612, name: "Venator bow (uncharged)", limit: 8 },
  };
  const RECIPES = [
    { key: "venator-bow", id: 27612, name: "Venator bow (uncharged)", cat: "Ranged", components: [{ id: 27614, qty: 5 }] },
  ];
  const events = [
    { id: 1, ts: 1, itemId: 27614, itemName: "Venator shard", side: "BUY",  qty: 4, price: 28_000_000, tax: 0, status: "complete" },
    { id: 2, ts: 100, itemId: 27612, itemName: "Venator bow (uncharged)", side: "SELL", qty: 1, price: 160_000_000, tax: 3_200_000, status: "complete" },
  ];
  const indexes = core.buildRecipeIndexes(RECIPES);
  const convs = core.matchEvents(events, RECIPES, indexes, (id) => id === 27614 ? 30_000_000 : 0, MAP);
  assert.strictEqual(convs.length, 1, "expected the partial-shortfall craft to remain visible");
  const shardLine = convs[0].costBasis.find((cb) => cb.itemId === 27614);
  assert.strictEqual(shardLine.extrapolatedQty, 1, "shortfall covered by self-extrapolation from user's own buy");
});

test("zero real FIFO on primary still drops (no in-window evidence at all)", () => {
  // Counterpart to the partial-coverage case: if the user bought ZERO shards
  // in-window, drop. Selling a Venator bow with no shard purchases at all is
  // either a pure flip of the bow itself (different path) or a craft built
  // entirely outside the data window — we can't trust the cost basis.
  const MAP = {
    27614: { id: 27614, name: "Venator shard",        limit: 50 },
    27612: { id: 27612, name: "Venator bow (uncharged)", limit: 8 },
  };
  const RECIPES = [
    { key: "venator-bow", id: 27612, name: "Venator bow (uncharged)", cat: "Ranged", components: [{ id: 27614, qty: 5 }] },
  ];
  const events = [
    { id: 1, ts: 100, itemId: 27612, itemName: "Venator bow (uncharged)", side: "SELL", qty: 1, price: 160_000_000, tax: 3_200_000, status: "complete" },
  ];
  const indexes = core.buildRecipeIndexes(RECIPES);
  const convs = core.matchEvents(events, RECIPES, indexes, (id) => id === 27614 ? 30_000_000 : 0, MAP);
  assert.strictEqual(convs.length, 0, "no shard buys in-window -> no trustworthy craft");
});

test("shouldDropConversion keeps a repair-recipe conv when the broken item is a REAL buy", () => {
  const events = [
    { id: 1, ts: Date.parse("2026-05-13T10:00:00Z"), itemId: 4878, itemName: "Ahrim's robeskirt 0", side: "BUY",  qty: 1, price: 2_500_000, tax: 0,      status: "complete" },
    { id: 2, ts: Date.parse("2026-05-14T10:00:00Z"), itemId: 4714, itemName: "Ahrim's robeskirt",   side: "SELL", qty: 1, price: 3_000_000, tax: 60_000, status: "complete" },
  ];
  const indexes = core.buildRecipeIndexes(BARROWS_RECIPES);
  const convs = core.matchEvents(events, BARROWS_RECIPES, indexes, () => 0, MAPPING, { smithingLevel: 99 });
  assert.strictEqual(convs.length, 1);
  assert.strictEqual(convs[0].kind, "craft");
});
