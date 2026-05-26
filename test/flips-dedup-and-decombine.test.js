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
