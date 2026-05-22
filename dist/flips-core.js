/* ---------------- History tab analytics core ----------------
   Pure functions: no DOM, no globals, no fetch. Unit-tested under Node
   (`node --test`) and also loaded as a classic browser script, where the
   functions land in global scope for dist/flips.js to call.
---------------------------------------------------------- */

function parseCopilot(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) return [];
  // Header: Timestamp,Account,Side,Item,Quantity,Paid/Received,Tax,Price ea.,Part of Flip
  const events = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    if (cols.length < 9) continue;
    const side = cols[2];
    if (side !== "BUY" && side !== "SELL") continue;
    const qty = Number(cols[4]);
    const tax = Number(cols[6]);
    const price = Number(cols[7]);
    if (!Number.isFinite(qty) || !Number.isFinite(price)) continue;
    events.push({
      account: cols[1],
      ts: Date.parse(cols[0]),
      itemName: cols[3],
      side,
      qty,
      price,
      tax: Number.isFinite(tax) ? tax : 0,
      status: "complete",
      source: "copilot",
    });
  }
  return events;
}

// Node test harness can require() this; browsers skip the guard.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { parseCopilot };
}
