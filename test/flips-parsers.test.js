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
