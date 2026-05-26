const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const core = require("../dist/flips-core.js");

const fixture = (name) =>
  fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");

test("parseCopilot parses tiny fixture into 3 normalized events", () => {
  const events = core.parseCopilot(fixture("flips-tiny-copilot.csv"));
  assert.strictEqual(events.length, 3);

  assert.deepStrictEqual(events[0], {
    account: "Test",
    ts: Date.parse("2026-05-22T10:00:00Z"),
    itemName: "Bandos hilt",
    side: "BUY",
    qty: 1,
    price: 17800000,
    tax: 0,
    status: "complete",
    source: "copilot",
  });

  assert.strictEqual(events[2].side, "SELL");
  assert.strictEqual(events[2].tax, 660000);
});

test("parseCopilot skips rows whose Side is not BUY or SELL", () => {
  const csv = [
    "Timestamp,Account,Side,Item,Quantity,Paid/Received,Tax,Price ea.,Part of Flip",
    "2026-05-22T10:00:00Z,Test,BUY,Coal,100,1000,0,10,NO",
    "2026-05-22T10:01:00Z,Test,TRANSFER,Coal,100,0,0,10,NO",
    "2026-05-22T10:02:00Z,Test,SELL,Coal,100,1200,24,12,NO",
  ].join("\n");
  const events = core.parseCopilot(csv);
  assert.strictEqual(events.length, 2);
  assert.deepStrictEqual(events.map((e) => e.side), ["BUY", "SELL"]);
});

test("parseCopilot handles trailing newline and CRLF line endings", () => {
  const csv =
    "Timestamp,Account,Side,Item,Quantity,Paid/Received,Tax,Price ea.,Part of Flip\r\n" +
    "2026-05-22T10:00:00Z,Test,BUY,Coal,100,1000,0,10,NO\r\n";
  const events = core.parseCopilot(csv);
  assert.strictEqual(events.length, 1);
});

test("parseFlippingUtilities maps all FU state values to (side, status)", () => {
  const csv = [
    "name,date,quantity,price,state",
    "Coal,2026-05-22 10:00 AM,100,10,BOUGHT",
    "Coal,2026-05-22 10:01 AM,100,12,SOLD",
    "Coal,2026-05-22 10:02 AM,50,9,CANCELLED_BUY",
    "Coal,2026-05-22 10:03 AM,50,13,CANCELLED_SELL",
    "Coal,2026-05-22 10:04 AM,75,9,BUYING",
    "Coal,2026-05-22 10:05 AM,75,13,SELLING",
  ].join("\n");
  const events = core.parseFlippingUtilities(csv, "TestAccount");
  assert.strictEqual(events.length, 6);
  assert.deepStrictEqual(events.map((e) => [e.side, e.status]), [
    ["BUY", "complete"],
    ["SELL", "complete"],
    ["BUY", "cancelled"],
    ["SELL", "cancelled"],
    ["BUY", "pending"],
    ["SELL", "pending"],
  ]);
  for (const e of events) {
    assert.strictEqual(e.account, "TestAccount");
    assert.strictEqual(e.source, "fu");
  }
});

test("parseFlippingUtilities drops comment lines and blank lines", () => {
  const events = core.parseFlippingUtilities(
    fixture("flips-tiny-fu.csv"),
    "Test"
  );
  assert.strictEqual(events.length, 5); // 3 from first block + 2 from second
});

test("parseFlippingUtilities parses 12-hour AM/PM dates as local time", () => {
  const events = core.parseFlippingUtilities(
    "name,date,quantity,price,state\nCoal,2026-05-22 12:00 PM,1,10,BOUGHT\n",
    "Test"
  );
  const d = new Date(events[0].ts);
  assert.strictEqual(d.getFullYear(), 2026);
  assert.strictEqual(d.getMonth(), 4); // May = 4
  assert.strictEqual(d.getDate(), 22);
  assert.strictEqual(d.getHours(), 12);
  assert.strictEqual(d.getMinutes(), 0);
});

test("parseFlippingUtilities grosses up SELL prices and computes per-unit-capped tax", () => {
  // FU records the NET sell per-unit (post-tax). Buys are listed-price; sells
  // under 100 gp are exempt. 17,444,000 net @ 2% post-cutover ⇔ 17,800,000
  // gross, tax 356,000.
  const csv = [
    "name,date,quantity,price,state",
    "Coal,2026-05-22 10:00 AM,100,10,BOUGHT", // buy → 0
    "Coal,2026-05-22 10:01 AM,100,12,SOLD",   // 12 < 100, exempt → 0
    "Bandos hilt,2026-05-22 10:02 AM,1,17444000,SOLD",
  ].join("\n");
  const events = core.parseFlippingUtilities(csv, "Test");
  assert.strictEqual(events[0].tax, 0);
  assert.strictEqual(events[1].tax, 0);
  assert.strictEqual(events[2].price, 17_800_000);
  assert.strictEqual(events[2].tax, 356_000);
});

test("detectFormat recognises Flipping Utilities by leading comment", () => {
  assert.strictEqual(core.detectFormat(fixture("flips-tiny-fu.csv")), "fu");
});

test("detectFormat recognises Copilot by header line", () => {
  assert.strictEqual(core.detectFormat(fixture("flips-tiny-copilot.csv")), "copilot");
});

test("detectFormat returns null on unknown content", () => {
  assert.strictEqual(core.detectFormat("hello,world\n1,2\n"), null);
  assert.strictEqual(core.detectFormat(""), null);
});

test("detectFormat skips leading blank lines and BOMs", () => {
  assert.strictEqual(
    core.detectFormat("﻿\n\nTimestamp,Account,Side,Item,Quantity,Paid/Received,Tax,Price ea.,Part of Flip\n"),
    "copilot"
  );
});
