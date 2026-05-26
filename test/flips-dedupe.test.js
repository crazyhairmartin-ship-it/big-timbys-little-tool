const test = require("node:test");
const assert = require("node:assert");
const core = require("../dist/flips-core.js");

// A Copilot row and an FU row representing the same trade:
//   - Copilot: ISO UTC timestamp, real GE tax
//   - FU: local-time timestamp (4h offset here for EDT), computed tax
const COPILOT_ROW = {
  id: 1, account: "Big Timby", source: "copilot", status: "complete",
  ts: Date.parse("2026-05-21T18:45:57Z"),
  itemId: 27612, itemName: "Venator bow (uncharged)", side: "SELL",
  qty: 1, price: 68000000, tax: 1360000,
};
const FU_ROW_SAME_TRADE = {
  id: 2, account: "Big Timby", source: "fu", status: "complete",
  ts: Date.parse("2026-05-21T18:45:57Z") + 0, // same instant, same answer
  itemId: 27612, itemName: "Venator bow (uncharged)", side: "SELL",
  qty: 1, price: 68000000, tax: 1360000, // FU computes 2% which happens to equal
};
const FU_ROW_TZ_SHIFTED = {
  ...FU_ROW_SAME_TRADE,
  ts: Date.parse("2026-05-21T18:45:57Z") - 4 * 3600 * 1000, // FU treated local time as if it were UTC
};
const UNRELATED_ROW = {
  id: 3, account: "Big Timby", source: "fu", status: "complete",
  ts: Date.parse("2025-08-10T12:00:00Z"),
  itemId: 11804, itemName: "Bandos godsword", side: "BUY",
  qty: 1, price: 30000000, tax: 0,
};

test("fuzzyEventKey ignores timestamp", () => {
  assert.strictEqual(core.fuzzyEventKey(COPILOT_ROW), core.fuzzyEventKey(FU_ROW_SAME_TRADE));
  assert.strictEqual(core.fuzzyEventKey(COPILOT_ROW), core.fuzzyEventKey(FU_ROW_TZ_SHIFTED));
  assert.notStrictEqual(core.fuzzyEventKey(COPILOT_ROW), core.fuzzyEventKey(UNRELATED_ROW));
});

test("mergeEventPair prefers Copilot for ts+tax, FU for status flags", () => {
  const fuCancelled = { ...FU_ROW_SAME_TRADE, status: "cancelled" };
  const merged = core.mergeEventPair(COPILOT_ROW, fuCancelled);
  assert.strictEqual(merged.ts, COPILOT_ROW.ts);
  assert.strictEqual(merged.tax, COPILOT_ROW.tax);
  assert.strictEqual(merged.status, "cancelled");
  assert.strictEqual(merged.source, "merged");
});

test("mergeEventPair keeps the existing DB id so we can update in place", () => {
  const merged = core.mergeEventPair(COPILOT_ROW, FU_ROW_SAME_TRADE);
  assert.strictEqual(merged.id, COPILOT_ROW.id);
});

test("fuzzyDedupeMerge matches across a 24h timezone offset", () => {
  const { updates, inserts, dedupedCount } = core.fuzzyDedupeMerge(
    [COPILOT_ROW],
    [FU_ROW_TZ_SHIFTED]
  );
  assert.strictEqual(dedupedCount, 1);
  assert.strictEqual(inserts.length, 0);
  assert.strictEqual(updates.length, 1);
  assert.strictEqual(updates[0].existingId, COPILOT_ROW.id);
});

test("fuzzyDedupeMerge treats genuinely different trades as inserts", () => {
  const { updates, inserts, dedupedCount } = core.fuzzyDedupeMerge(
    [COPILOT_ROW],
    [UNRELATED_ROW]
  );
  assert.strictEqual(dedupedCount, 0);
  assert.strictEqual(inserts.length, 1);
  assert.strictEqual(updates.length, 0);
});

test("fuzzyDedupeMerge does NOT pair the same existing row to multiple incoming rows", () => {
  const incomingDuplicate = { ...FU_ROW_SAME_TRADE, id: 99 };
  const { updates, inserts } = core.fuzzyDedupeMerge(
    [COPILOT_ROW],
    [FU_ROW_SAME_TRADE, incomingDuplicate]
  );
  assert.strictEqual(updates.length, 1);
  assert.strictEqual(inserts.length, 1); // the second one had nowhere to merge
});

test("fuzzyDedupeMerge rejects matches outside the ts window", () => {
  const distant = { ...FU_ROW_SAME_TRADE, ts: COPILOT_ROW.ts + 7 * 24 * 3600 * 1000 };
  const { updates, inserts } = core.fuzzyDedupeMerge([COPILOT_ROW], [distant]);
  assert.strictEqual(updates.length, 0);
  assert.strictEqual(inserts.length, 1);
});

test("fuzzyDedupeMerge picks the closest existing event when multiple candidates fit", () => {
  const near = { ...COPILOT_ROW, id: 10, ts: COPILOT_ROW.ts };
  const far = { ...COPILOT_ROW, id: 20, ts: COPILOT_ROW.ts - 12 * 3600 * 1000 };
  const incoming = { ...FU_ROW_SAME_TRADE };
  const { updates } = core.fuzzyDedupeMerge([near, far], [incoming]);
  assert.strictEqual(updates.length, 1);
  assert.strictEqual(updates[0].existingId, 10);
});

test("fuzzyDedupeMerge suppresses an FU aggregate row when Copilot has the per-fill rows", () => {
  // Regression for the Ahrim's robetop 672-day flip: user sold 2 robetops as
  // one listing that filled in 2 chunks. FU recorded qty=2 at 12:37; Copilot
  // recorded two qty=1 fills at 12:34:56 and 12:37:15. Without this fix the
  // dedup keeps all three rows and the algorithm consumes 4 broken pieces
  // (1 fresh + 1 ancient + 2 from elsewhere).
  const fuAggregate = {
    id: 100, account: "Big Timby", source: "fu", status: "complete",
    ts: Date.parse("2026-05-14T16:37:00Z"),
    itemId: 4712, itemName: "Ahrim's robetop", side: "SELL",
    qty: 2, price: 2_004_914, tax: 80_198,
  };
  const copilotFill1 = {
    id: 200, account: "Big Timby", source: "copilot", status: "complete",
    ts: Date.parse("2026-05-14T16:34:56Z"),
    itemId: 4712, itemName: "Ahrim's robetop", side: "SELL",
    qty: 1, price: 2_004_914, tax: 40_099,
  };
  const copilotFill2 = {
    id: 201, account: "Big Timby", source: "copilot", status: "complete",
    ts: Date.parse("2026-05-14T16:37:15Z"),
    itemId: 4712, itemName: "Ahrim's robetop", side: "SELL",
    qty: 1, price: 2_004_914, tax: 40_099,
  };
  const { updates, inserts, deletes } = core.fuzzyDedupeMerge(
    [fuAggregate],
    [copilotFill1, copilotFill2]
  );
  // FU is suppressed (deleted from DB), both Copilot rows are inserted.
  assert.deepStrictEqual(deletes, [100]);
  assert.strictEqual(inserts.length, 2);
  assert.strictEqual(updates.length, 0);
});

test("fuzzyDedupeMerge does NOT suppress an FU row when only a single Copilot row is nearby", () => {
  // 1 Copilot qty=2 vs 1 FU qty=2 — these are the same trade reported by
  // both sources. The normal key-based dedup should merge them; the
  // FU-aggregate path must not interfere.
  const fu = {
    id: 1, account: "A", source: "fu", status: "complete",
    ts: Date.parse("2026-05-14T16:37:00Z"),
    itemId: 4712, itemName: "X", side: "SELL", qty: 2, price: 1000, tax: 40,
  };
  const cop = {
    id: 2, account: "A", source: "copilot", status: "complete",
    ts: Date.parse("2026-05-14T16:37:30Z"),
    itemId: 4712, itemName: "X", side: "SELL", qty: 2, price: 1000, tax: 40,
  };
  const { updates, inserts, deletes } = core.fuzzyDedupeMerge([fu], [cop]);
  assert.deepStrictEqual(deletes, []);
  assert.strictEqual(updates.length, 1);
  assert.strictEqual(inserts.length, 0);
});
