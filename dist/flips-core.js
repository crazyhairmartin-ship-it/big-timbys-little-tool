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

function buildNameIndex(mapping) {
  const idx = new Map();
  for (const id in mapping) {
    const item = mapping[id];
    if (item && item.name) idx.set(item.name.toLowerCase(), item.id);
  }
  return idx;
}

function resolveItemNames(events, nameIndex) {
  const resolved = new Array(events.length);
  const missCounts = new Map();
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const id = nameIndex.get((e.itemName || "").toLowerCase());
    resolved[i] = { ...e, itemId: id ?? null };
    if (id == null) {
      const n = e.itemName || "";
      missCounts.set(n, (missCounts.get(n) || 0) + 1);
    }
  }
  const misses = [...missCounts.entries()].map(([name, count]) => ({ name, count }));
  return { resolved, misses };
}

function popFromFIFO(queue, need) {
  if (!queue || need <= 0) return [];
  const out = [];
  let remaining = need;
  while (remaining > 0 && queue.length > 0) {
    const head = queue[0];
    if (head.qty <= remaining) {
      out.push(head);
      remaining -= head.qty;
      queue.shift();
    } else {
      out.push({ ...head, qty: remaining });
      head.qty -= remaining;
      remaining = 0;
    }
  }
  return out;
}

function fcItemName(mapping, id) {
  return mapping[id]?.name || `#${id}`;
}

function synthesizeFromNestedRecipe(itemId, needQty, ts, inventory, indexes, wikiPriceAt, mapping, depth) {
  if (depth > 5) {
    const fbPrice = wikiPriceAt(itemId, ts);
    return { qty: needQty, unitPrice: fbPrice, ts, sourceRowId: null, status: "complete", fallback: true, estimated: true, synthesized: false };
  }
  const subRecipes = indexes.byProduct.get(itemId);
  if (!subRecipes || subRecipes.length === 0) {
    const fbPrice = wikiPriceAt(itemId, ts);
    return { qty: needQty, unitPrice: fbPrice, ts, sourceRowId: null, status: "complete", fallback: true, estimated: true, synthesized: false };
  }
  const subRecipe = selectBestRecipe(subRecipes, inventory, needQty);
  const synthSell = { id: null, ts, itemId, itemName: fcItemName(mapping, itemId), qty: needQty, price: 0, tax: 0 };
  const nested = _attemptConversionInner(synthSell, subRecipe, inventory, indexes, wikiPriceAt, mapping, depth + 1);
  return {
    qty: needQty,
    unitPrice: nested.totalCost / needQty,
    ts,
    sourceRowId: null,
    status: "complete",
    fallback: false,
    estimated: nested.estimated,
    synthesized: true,
  };
}

function _attemptConversionInner(sellEvent, recipe, inventory, indexes, wikiPriceAt, mapping, depth) {
  const productQty = sellEvent.qty / (recipe.resultQty ?? 1);
  const costBasis = [];
  let estimated = false;
  let earliestTs = sellEvent.ts;

  for (const component of recipe.components) {
    const needed = component.qty * productQty;
    if (!inventory.has(component.id)) inventory.set(component.id, []);
    const queue = inventory.get(component.id);
    const lots = popFromFIFO(queue, needed);
    let coveredQty = lots.reduce((s, l) => s + l.qty, 0);
    let shortfall = needed - coveredQty;
    let synthesizedQty = 0;

    if (shortfall > 0 && indexes.byProduct.has(component.id)) {
      const synth = synthesizeFromNestedRecipe(component.id, shortfall, sellEvent.ts, inventory, indexes, wikiPriceAt, mapping, depth);
      lots.push(synth);
      synthesizedQty = synth.qty;
      if (synth.estimated) estimated = true;
      shortfall -= synth.qty;
    }

    if (shortfall > 0) {
      const fbPrice = wikiPriceAt(component.id, sellEvent.ts);
      lots.push({ qty: shortfall, unitPrice: fbPrice, ts: sellEvent.ts, sourceRowId: null, status: "complete", fallback: true });
      estimated = true;
    }

    const gp = lots.reduce((s, l) => s + l.qty * l.unitPrice, 0);
    for (const l of lots) {
      if (l.sourceRowId != null && l.ts < earliestTs) earliestTs = l.ts;
    }
    costBasis.push({
      itemId: component.id,
      itemName: fcItemName(mapping, component.id),
      qty: needed,
      gp,
      lots: lots.map((l) => l.sourceRowId).filter((x) => x != null),
      estimatedQty: lots.filter((l) => l.fallback).reduce((s, l) => s + l.qty, 0),
      selfAssembledQty: synthesizedQty,
      lotStatuses: lots.filter((l) => l.sourceRowId != null).map((l) => l.status),
    });
  }

  const totalCost = costBasis.reduce((s, c) => s + c.gp, 0);
  return {
    ts: sellEvent.ts,
    recipeKey: recipe.key,
    productId: sellEvent.itemId,
    productName: fcItemName(mapping, sellEvent.itemId),
    productQty: sellEvent.qty,
    revenue: sellEvent.price * sellEvent.qty,
    tax: sellEvent.tax || 0,
    costBasis,
    totalCost,
    profit: (sellEvent.price * sellEvent.qty) - (sellEvent.tax || 0) - totalCost,
    estimated,
    timeToFlip: sellEvent.ts - earliestTs,
    sellRowId: sellEvent.id,
  };
}

function attemptConversion(sellEvent, recipe, inventory, indexes, wikiPriceAt, mapping) {
  return _attemptConversionInner(sellEvent, recipe, inventory, indexes, wikiPriceAt, mapping, 0);
}

function selectBestRecipe(recipes, inventory, productQty) {
  let best = recipes[0];
  let bestScore = -1;
  let bestCost = Infinity;
  for (const r of recipes) {
    let covered = 0;
    let cost = 0;
    for (const c of r.components) {
      const requireQty = c.qty * (productQty / (r.resultQty ?? 1));
      const queue = inventory.get(c.id) || [];
      let remaining = requireQty;
      for (const lot of queue) {
        if (remaining <= 0) break;
        const take = Math.min(lot.qty, remaining);
        covered += take;
        cost += take * lot.unitPrice;
        remaining -= take;
      }
    }
    if (covered > bestScore || (covered === bestScore && cost < bestCost)) {
      best = r;
      bestScore = covered;
      bestCost = cost;
    }
  }
  return best;
}

function buildRecipeIndexes(recipes) {
  const byProduct = new Map();
  const byComponent = new Map();
  for (const r of recipes) {
    if (!byProduct.has(r.id)) byProduct.set(r.id, []);
    byProduct.get(r.id).push(r);
    for (const c of r.components) {
      if (!byComponent.has(c.id)) byComponent.set(c.id, []);
      byComponent.get(c.id).push(r);
    }
  }
  return { byProduct, byComponent };
}

// Node test harness can require() this; browsers skip the guard.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { parseCopilot, parseFlippingUtilities, fcGeTax, detectFormat, buildNameIndex, resolveItemNames, buildRecipeIndexes, popFromFIFO, selectBestRecipe, attemptConversion, synthesizeFromNestedRecipe };
}
