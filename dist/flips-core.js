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

// Find the user's closest historical buy of an item (in either direction) and
// extrapolate a price for `needQty` units. Returns null if no buys ever exist.
function selfExtrapolateLot(itemId, ts, needQty, priceWitnesses) {
  const ws = priceWitnesses.get(itemId);
  if (!ws || ws.length === 0) return null;
  let best = ws[0];
  let bestDelta = Math.abs(ws[0].ts - ts);
  for (let i = 1; i < ws.length; i++) {
    const d = Math.abs(ws[i].ts - ts);
    if (d < bestDelta) { best = ws[i]; bestDelta = d; }
  }
  return {
    qty: needQty,
    unitPrice: best.unitPrice,
    ts,
    sourceRowId: null,
    status: "complete",
    fallback: false,
    estimated: false,
    extrapolated: true,
    extrapolatedFromRowId: best.sourceRowId,
    extrapolatedFromTs: best.ts,
  };
}

function synthesizeFromNestedRecipe(itemId, needQty, ts, inventory, indexes, wikiPriceAt, mapping, priceWitnesses, depth) {
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
  const nested = _attemptConversionInner(synthSell, subRecipe, inventory, indexes, wikiPriceAt, mapping, priceWitnesses, depth + 1);
  return {
    qty: needQty,
    unitPrice: nested.totalCost / needQty,
    ts,
    sourceRowId: null,
    status: "complete",
    fallback: false,
    estimated: nested.estimated,
    synthesized: true,
    nestedConv: nested,
  };
}

function _attemptConversionInner(sellEvent, recipe, inventory, indexes, wikiPriceAt, mapping, priceWitnesses, depth) {
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
    let extrapolatedQty = 0;

    // Step 1: self-extrapolate from any of the user's own buy history of this item.
    if (shortfall > 0) {
      const extr = selfExtrapolateLot(component.id, sellEvent.ts, shortfall, priceWitnesses);
      if (extr) {
        lots.push(extr);
        extrapolatedQty = extr.qty;
        shortfall -= extr.qty;
      }
    }

    // Step 2: if the component is itself a recipe product, try synthesizing from its components.
    if (shortfall > 0 && indexes.byProduct.has(component.id)) {
      const synth = synthesizeFromNestedRecipe(component.id, shortfall, sellEvent.ts, inventory, indexes, wikiPriceAt, mapping, priceWitnesses, depth);
      lots.push(synth);
      synthesizedQty = synth.qty;
      if (synth.estimated) estimated = true;
      shortfall -= synth.qty;
    }

    // Step 3: wiki fallback (least trusted).
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
      wikiFallbackQty: lots.filter((l) => l.fallback).reduce((s, l) => s + l.qty, 0),
      selfAssembledQty: synthesizedQty,
      extrapolatedQty,
      estimatedQty: lots.filter((l) => l.fallback).reduce((s, l) => s + l.qty, 0), // kept for back-compat with renderers
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

function attemptConversion(sellEvent, recipe, inventory, indexes, wikiPriceAt, mapping, priceWitnesses) {
  return _attemptConversionInner(sellEvent, recipe, inventory, indexes, wikiPriceAt, mapping, priceWitnesses || new Map(), 0);
}

// A conversion is "too speculative to trust" when we're inventing the
// primary (most-expensive) component out of thin air. Per user intent:
// "estimate the cheaper components, not the expensive ones". Reasons to drop:
//   1. Total cost basis is $0 — we have no information at all.
//   2. Any component was wiki-fallback AND came back with $0 — that component
//      has no usable data and we can't reason about its share.
//   3. The primary component (highest gp) required extrapolation (using a
//      price witness elsewhere in the user's history) or wiki fallback. If
//      the user didn't actually own enough of the primary to craft the
//      product, the "conversion" probably never happened.
//
// Synth-from-nested-recipe (e.g. blade reconstructed from shards the user
// actually bought) IS trusted for the primary — that's still the user's own
// real buy data, just one recipe layer down.
function shouldDropConversion(conv) {
  if (!conv.costBasis.length) return true;
  if (conv.totalCost === 0) return true;

  for (const cb of conv.costBasis) {
    if (cb.wikiFallbackQty > 0 && cb.gp === 0) return true;
  }

  let primary = conv.costBasis[0];
  for (const cb of conv.costBasis) {
    if (cb.gp > primary.gp) primary = cb;
  }
  return primary.wikiFallbackQty > 0 || primary.extrapolatedQty > 0;
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

function matchEvents(events, recipes, indexes, wikiPriceAt, mapping) {
  const inventory = new Map();
  // Price-witness ledger: every BUY is recorded here. Lots get consumed from
  // `inventory` as sells happen, but `priceWitnesses` is append-only so we can
  // always recall what the user paid for an item at any point in their history.
  const priceWitnesses = new Map();
  const conversions = [];
  const sorted = events.slice().sort((a, b) => a.ts - b.ts || (a.id ?? 0) - (b.id ?? 0));

  for (const e of sorted) {
    if (!e.itemId || !Number.isFinite(e.qty) || e.qty <= 0) continue;
    if (e.side === "BUY") {
      if (!inventory.has(e.itemId)) inventory.set(e.itemId, []);
      inventory.get(e.itemId).push({
        qty: e.qty,
        unitPrice: e.price,
        ts: e.ts,
        sourceRowId: e.id,
        status: e.status,
      });
      if (!priceWitnesses.has(e.itemId)) priceWitnesses.set(e.itemId, []);
      priceWitnesses.get(e.itemId).push({ ts: e.ts, unitPrice: e.price, sourceRowId: e.id });
      continue;
    }
    if (e.side === "SELL") {
      let remainingQty = e.qty;
      if (inventory.has(e.itemId)) {
        const directLots = popFromFIFO(inventory.get(e.itemId), remainingQty);
        const consumed = directLots.reduce((s, l) => s + l.qty, 0);
        remainingQty -= consumed;
      }
      if (remainingQty <= 0) continue;

      const candidates = indexes.byProduct.get(e.itemId);
      if (!candidates || candidates.length === 0) continue;

      const recipe = selectBestRecipe(candidates, inventory, remainingQty);
      const conv = attemptConversion(
        { ...e, qty: remainingQty },
        recipe, inventory, indexes, wikiPriceAt, mapping, priceWitnesses
      );
      if (!shouldDropConversion(conv)) {
        conversions.push(conv);
      }
    }
  }
  return conversions;
}

function summarizeRecipes(conversions, recipes) {
  const byKey = new Map();
  for (const r of recipes) byKey.set(r.key, r);

  const grouped = new Map();
  for (const c of conversions) {
    let g = grouped.get(c.recipeKey);
    if (!g) { g = []; grouped.set(c.recipeKey, g); }
    g.push(c);
  }

  const out = [];
  for (const [recipeKey, list] of grouped) {
    const recipe = byKey.get(recipeKey);
    const totalProfit = list.reduce((s, c) => s + c.profit, 0);
    const totalRevenue = list.reduce((s, c) => s + c.revenue, 0);
    const totalCost = list.reduce((s, c) => s + c.totalCost, 0);
    const totalTax = list.reduce((s, c) => s + (c.tax || 0), 0);
    const wins = list.filter((c) => c.profit > 0).length;
    const ests = list.filter((c) => c.estimated).length;
    const totalProductQty = list.reduce((s, c) => s + (c.productQty || 1), 0);
    const tss = list.map((c) => c.ts);
    out.push({
      recipeKey,
      productId: recipe?.id ?? list[0].productId,
      productName: recipe?.name ?? list[0].productName,
      category: recipe?.cat ?? "",
      conversions: list.length,
      totalProfit,
      totalRevenue,
      totalCost,
      totalTax,
      avgProfit: totalProfit / list.length,
      avgROI: totalCost > 0 ? totalProfit / totalCost : 0,
      avgTimeToFlip: list.reduce((s, c) => s + c.timeToFlip, 0) / list.length,
      winRate: wins / list.length,
      estimatedShare: ests / list.length,
      totalProductQty,
      firstTs: Math.min(...tss),
      lastTs: Math.max(...tss),
    });
  }
  out.sort((a, b) => b.totalProfit - a.totalProfit);
  return out;
}

function filterConversionsByRange(conversions, start, end) {
  return conversions.filter((c) =>
    (start == null || c.ts >= start) &&
    (end == null || c.ts < end)
  );
}

// Node test harness can require() this; browsers skip the guard.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { parseCopilot, parseFlippingUtilities, fcGeTax, detectFormat, buildNameIndex, resolveItemNames, buildRecipeIndexes, popFromFIFO, selectBestRecipe, attemptConversion, synthesizeFromNestedRecipe, matchEvents, summarizeRecipes, filterConversionsByRange, selfExtrapolateLot, shouldDropConversion };
}
