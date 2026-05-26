const test = require("node:test");
const assert = require("node:assert");
const core = require("../dist/flips-core.js");

// OSRS doubled GE tax from 1% to 2% on 29 May 2025. The 5M-per-unit cap and
// the <100 gp exemption have been in place throughout.
const PRE_CUTOVER  = Date.parse("2025-04-27T17:53:50Z"); // user's 4/27 sample
const POST_CUTOVER = Date.parse("2025-07-29T15:45:24Z"); // user's 7/29 sample

test("fcGeTax applies 1% before May 29 2025", () => {
  // Zaryte crossbow at 331,295,450 — 1% = 3,312,954 (under the 5M cap).
  assert.strictEqual(core.fcGeTax(331_295_450, 1, PRE_CUTOVER), 3_312_954);
});

test("fcGeTax applies 2% on or after May 29 2025", () => {
  // 200M sale, 2% = 4M (still under cap).
  assert.strictEqual(core.fcGeTax(200_000_000, 1, POST_CUTOVER), 4_000_000);
});

test("fcGeTax caps tax at 5M per unit even at 2%", () => {
  // 400M sale, 2% would be 8M — capped at 5M.
  assert.strictEqual(core.fcGeTax(400_000_000, 1, POST_CUTOVER), 5_000_000);
});

test("fcGeTax cap also applies pre-cutover (5M @ 1% would need 500M+ per unit)", () => {
  assert.strictEqual(core.fcGeTax(600_000_000, 1, PRE_CUTOVER), 5_000_000);
});

test("fcGeTax scales by qty after capping each unit", () => {
  // 400M × 2 units, post-cutover: 5M cap × 2 = 10M.
  assert.strictEqual(core.fcGeTax(400_000_000, 2, POST_CUTOVER), 10_000_000);
});

test("fcGeTax is 0 for prices below 100 gp", () => {
  assert.strictEqual(core.fcGeTax(99, 100, POST_CUTOVER), 0);
});

test("fcGeTax defaults to 2% when no timestamp is given", () => {
  // Forward-looking computations (live app context) use the current rate.
  assert.strictEqual(core.fcGeTax(1_000_000, 1), 20_000);
});

test("fcGeTax cutover boundary: a sale exactly on May 29 2025 00:00 UTC is 2%", () => {
  const cutover = Date.UTC(2025, 4, 29);
  assert.strictEqual(core.fcGeTax(100_000_000, 1, cutover), 2_000_000);
  assert.strictEqual(core.fcGeTax(100_000_000, 1, cutover - 1), 1_000_000);
});

// ---------------- parseCopilot recompute ----------------

test("parseCopilot ignores the CSV's Tax column and recomputes from price+ts", () => {
  // Regression for the user's 4/27/2025 Zaryte crossbow: Copilot wrote
  // 6,625,909 (2% with no cap) but the correct historical tax is 3,312,954.
  const csv = [
    "Timestamp,Account,Side,Item,Quantity,Paid/Received,Tax,Price ea.,Part of Flip",
    "2025-04-27T17:53:50Z,Big Timby,SELL,Zaryte crossbow,1,331295450,6625909,331295450,YES",
  ].join("\n");
  const events = core.parseCopilot(csv);
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].tax, 3_312_954);
});

test("parseCopilot caps a >5M Copilot tax to 5M for a single high-value unit", () => {
  // Post-cutover, single crossbow at 400M: Copilot would write 8M, we cap at 5M.
  const csv = [
    "Timestamp,Account,Side,Item,Quantity,Paid/Received,Tax,Price ea.,Part of Flip",
    "2025-07-29T15:45:24Z,Big Timby,SELL,Zaryte crossbow,1,400000000,8000000,400000000,YES",
  ].join("\n");
  const events = core.parseCopilot(csv);
  assert.strictEqual(events[0].tax, 5_000_000);
});

test("parseCopilot keeps BUY tax at 0 even if the CSV says otherwise", () => {
  const csv = [
    "Timestamp,Account,Side,Item,Quantity,Paid/Received,Tax,Price ea.,Part of Flip",
    "2025-07-29T15:45:24Z,Big Timby,BUY,Zaryte crossbow,1,400000000,99999999,400000000,YES",
  ].join("\n");
  const events = core.parseCopilot(csv);
  assert.strictEqual(events[0].tax, 0);
});

// ---------------- parseFlippingUtilities ----------------

test("parseFlippingUtilities computes 1% tax for SELLs before cutover", () => {
  const csv = [
    "name,date,quantity,price,state",
    "Zaryte crossbow,2025-04-27 01:53 PM,1,331295450,SOLD",
  ].join("\n");
  const events = core.parseFlippingUtilities(csv, "Tester");
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].tax, 3_312_954);
});

test("parseFlippingUtilities computes 2% tax for SELLs after cutover", () => {
  const csv = [
    "name,date,quantity,price,state",
    "Zaryte crossbow,2025-07-29 11:45 AM,1,200000000,SOLD",
  ].join("\n");
  const events = core.parseFlippingUtilities(csv, "Tester");
  assert.strictEqual(events[0].tax, 4_000_000);
});
