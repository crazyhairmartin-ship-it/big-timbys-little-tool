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

const FU_STATE_MAP = {
  BOUGHT:          { side: "BUY",  status: "complete"  },
  SOLD:            { side: "SELL", status: "complete"  },
  CANCELLED_BUY:   { side: "BUY",  status: "cancelled" },
  CANCELLED_SELL:  { side: "SELL", status: "cancelled" },
  BUYING:          { side: "BUY",  status: "pending"   },
  SELLING:         { side: "SELL", status: "pending"   },
};

// GE tax: 2% of sale price per unit, capped at 5M per unit, exempt under 100 gp.
function fcGeTax(price, qty) {
  if (price < 100) return 0;
  const per = Math.min(Math.floor(price * 0.02), 5_000_000);
  return per * qty;
}

function fcParseFuDate(s) {
  // Format: "2026-05-22 12:00 PM"
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{1,2}):(\d{2}) (AM|PM)$/);
  if (!m) return NaN;
  let [, y, mo, d, h, mi, ap] = m;
  y = +y; mo = +mo - 1; d = +d; h = +h; mi = +mi;
  if (ap === "PM" && h !== 12) h += 12;
  if (ap === "AM" && h === 12) h = 0;
  return new Date(y, mo, d, h, mi).getTime();
}

function parseFlippingUtilities(text, accountName) {
  const lines = text.split(/\r?\n/);
  const events = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) continue;
    if (line === "name,date,quantity,price,state") continue;
    const cols = line.split(",");
    if (cols.length < 5) continue;
    const [name, date, qtyStr, priceStr, state] = cols;
    const map = FU_STATE_MAP[state];
    if (!map) continue;
    const qty = Number(qtyStr);
    const price = Number(priceStr);
    const ts = fcParseFuDate(date);
    if (!Number.isFinite(qty) || !Number.isFinite(price) || !Number.isFinite(ts)) continue;
    const tax = map.side === "SELL" ? fcGeTax(price, qty) : 0;
    events.push({
      account: accountName,
      ts,
      itemName: name,
      side: map.side,
      qty,
      price,
      tax,
      status: map.status,
      source: "fu",
    });
  }
  return events;
}

function detectFormat(text) {
  // Strip BOM, find the first non-blank line.
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  let first = "";
  for (const l of lines) {
    if (l.trim()) { first = l; break; }
  }
  if (!first) return null;
  if (first.startsWith("#")) return "fu";
  if (first.startsWith("Timestamp,Account,Side,Item")) return "copilot";
  if (first === "name,date,quantity,price,state") return "fu"; // header-only FU file
  return null;
}

// Node test harness can require() this; browsers skip the guard.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { parseCopilot, parseFlippingUtilities, fcGeTax, detectFormat };
}
