/* ---------------- History tab analytics core ----------------
   Pure functions: no DOM, no globals, no fetch. Unit-tested under Node
   (`node --test`) and also loaded as a classic browser script, where the
   functions land in global scope for dist/flips.js to call.
---------------------------------------------------------- */

function parseCopilot(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) return [];
  // Header: Timestamp,Account,Side,Item,Quantity,Paid/Received,Tax,Price ea.,Part of Flip
  // Copilot's Tax column is computed at export time with the current 2% rate
  // and no 5M-per-unit cap — so a pre-cutover sale or a >250M-per-unit sale
  // records the wrong number. We recompute from price + ts + qty instead.
  const events = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    if (cols.length < 9) continue;
    const side = cols[2];
    if (side !== "BUY" && side !== "SELL") continue;
    const qty = Number(cols[4]);
    const price = Number(cols[7]);
    const ts = Date.parse(cols[0]);
    if (!Number.isFinite(qty) || !Number.isFinite(price)) continue;
    const tax = side === "SELL" ? fcGeTax(price, qty, ts) : 0;
    events.push({
      account: cols[1],
      ts,
      itemName: cols[3],
      side,
      qty,
      price,
      tax,
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

// OSRS doubled the GE tax rate from 1% to 2% on 29 May 2025; the 5M-per-unit
// cap and the <100 gp exemption have been there throughout. Historical FU
// rows from before the cutover must be taxed at 1% to match what the user
// actually paid; rows on or after get 2%. Copilot CSVs carry tax in the file
// itself so this code path is FU-only — and FU rows always have a timestamp.
const GE_TAX_2PCT_CUTOVER_MS = Date.UTC(2025, 4, 29); // May = month index 4
function fcGeTax(price, qty, ts) {
  if (price < 100) return 0;
  const rate = (ts != null && ts < GE_TAX_2PCT_CUTOVER_MS) ? 0.01 : 0.02;
  const per = Math.min(Math.floor(price * rate), 5_000_000);
  return per * qty;
}

// Invert fcGeTax: given the net per-unit a seller received, find the gross
// per-unit listed price such that gross - floor(gross*rate) (capped at 5M) =
// net. Flipping Utilities records the NET sell price, while Copilot and our
// internal model use the GROSS — this normalizes FU rows so revenue/tax math
// matches reality and cross-source dedup can succeed.
function fcGrossFromNet(net, ts) {
  if (net < 99) return net;
  const rate = (ts != null && ts < GE_TAX_2PCT_CUTOVER_MS) ? 0.01 : 0.02;
  // Cap region: when tax saturates at 5M per unit, gross = net + 5M.
  const capThreshold = 5_000_000 / rate;
  if (net + 5_000_000 >= capThreshold) return net + 5_000_000;
  // Sub-cap: search around the linear inversion to find the integer gross
  // that produces exactly `net` after OSRS's floor-rounded tax.
  let gross = Math.ceil(net / (1 - rate));
  for (let i = 0; i < 5; i++) {
    const tax = Math.floor(gross * rate);
    if (gross - tax === net) return gross;
    if (gross - tax < net) gross++;
    else gross--;
  }
  return gross; // best effort if no exact match (shouldn't normally happen)
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
    const rawPrice = Number(priceStr);
    const ts = fcParseFuDate(date);
    if (!Number.isFinite(qty) || !Number.isFinite(rawPrice) || !Number.isFinite(ts)) continue;
    // FU records the NET per-unit received on completed/cancelled SELLs (the
    // GE has already taken its cut). Gross it up so `price` consistently
    // means the listed price, matching Copilot. Pending SELLs (SELLING) and
    // all BUYs are recorded at the listed price already — no conversion.
    let price = rawPrice;
    let tax = 0;
    if (map.side === "SELL" && map.status !== "pending") {
      const gross = fcGrossFromNet(rawPrice, ts);
      price = gross;
      tax = (gross - rawPrice) * qty;
    }
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

// Fuzzy-dedupe across sources: the same real-world trade may appear in both an
// FU export (local time, computed tax) and a Copilot export (UTC, real GE tax).
// Match on the stable fields and a wide ts tolerance.
const FUZZY_DEDUPE_WINDOW_MS = 24 * 3600 * 1000;

function fuzzyEventKey(e) {
  return `${e.account}|${e.side}|${e.itemId ?? ""}|${e.qty}|${e.price}`;
}

// Merge two events that represent the same underlying trade. Copilot wins on
// timestamp + tax (more accurate); FU wins on status (it's the only source that
// records cancellations and in-flight orders). The result is marked source
// "merged" so we can tell at a glance.
function mergeEventPair(a, b) {
  const copilot = a.source === "copilot" ? a : b.source === "copilot" ? b : null;
  const fu = a.source === "fu" ? a : b.source === "fu" ? b : null;
  const out = { ...(copilot || a) };
  if (copilot) {
    out.ts = copilot.ts;
    out.tax = copilot.tax;
  }
  if (fu && fu.status && fu.status !== "complete") out.status = fu.status;
  out.source = (copilot && fu) ? "merged" : out.source;
  // Preserve the original DB id if either input had one — we'll update in place.
  out.id = a.id ?? b.id;
  return out;
}

// Given an existing event list and an incoming event list, return:
//   - merged: events to keep (existing replaced where matched)
//   - inserts: events to add as new
//   - dedupedCount: how many incoming rows were matched to existing rows
function fuzzyDedupeMerge(existing, incoming, windowMs) {
  const window = windowMs ?? FUZZY_DEDUPE_WINDOW_MS;
  const byKey = new Map();
  for (const e of existing) {
    const k = fuzzyEventKey(e);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(e);
  }
  const used = new Set();
  const updates = []; // { existingId, mergedEvent }
  const inserts = [];
  for (const inc of incoming) {
    const k = fuzzyEventKey(inc);
    const candidates = byKey.get(k) || [];
    let bestIdx = -1;
    let bestDelta = Infinity;
    for (let i = 0; i < candidates.length; i++) {
      if (used.has(candidates[i].id)) continue;
      const delta = Math.abs(candidates[i].ts - inc.ts);
      if (delta <= window && delta < bestDelta) {
        bestDelta = delta;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0) {
      const ex = candidates[bestIdx];
      used.add(ex.id);
      updates.push({ existingId: ex.id, mergedEvent: mergeEventPair(ex, inc) });
    } else {
      inserts.push(inc);
    }
  }
  return { updates, inserts, dedupedCount: updates.length };
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

// LIFO inventory pop: consume the most-recently-acquired lots first. OSRS GE
// has no concept of which physical unit you sell — inventory is fungible —
// and "I just bought X and then sold X" matches user intent far better than
// "I sold the unit I held for 320 days while ignoring the one I bought
// yesterday". FIFO assigns recent sells to ancient buys whenever a long-term
// hold sits alongside active flipping, inventing fake multi-month flips.
function popFromInventory(queue, need) {
  if (!queue || need <= 0) return [];
  const out = [];
  let remaining = need;
  while (remaining > 0 && queue.length > 0) {
    const tail = queue[queue.length - 1];
    if (tail.qty <= remaining) {
      out.push(tail);
      remaining -= tail.qty;
      queue.pop();
    } else {
      out.push({ ...tail, qty: remaining });
      tail.qty -= remaining;
      remaining = 0;
    }
  }
  return out;
}
// Back-compat alias (older code path or tests may still reach for this name).
const popFromFIFO = popFromInventory;

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

function synthesizeFromNestedRecipe(itemId, needQty, ts, inventory, indexes, wikiPriceAt, mapping, priceWitnesses, depth, options) {
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
  const nested = _attemptConversionInner(synthSell, subRecipe, inventory, indexes, wikiPriceAt, mapping, priceWitnesses, depth + 1, options);
  // A synth lot is "primary-chain-tracked" when, recursively, the most-
  // expensive component at every layer of the nested chain came from real
  // FIFO lots. Cheap sub-components are allowed to self-extrapolate — only
  // the expensive part of each layer needs to be real per user intent.
  const primaryChainTracked = isPrimaryChainTracked(nested);
  const nestedEarliestTs = ts - (nested.timeToFlip || 0);
  return {
    qty: needQty,
    unitPrice: nested.totalCost / needQty,
    ts: nestedEarliestTs < ts ? nestedEarliestTs : ts,
    sourceRowId: null,
    nestedEarliestTs,
    status: "complete",
    fallback: false,
    estimated: nested.estimated,
    synthesized: true,
    primaryChainTracked,
    nestedConv: nested,
  };
}

function isPrimaryChainTracked(conv) {
  if (!conv.costBasis.length) return false;
  let primary = conv.costBasis[0];
  for (const cb of conv.costBasis) {
    if (cb.gp > primary.gp) primary = cb;
  }
  if (primary.wikiFallbackQty > 0) return false;
  if (primary.extrapolatedQty > 0) return false;
  if (primary.selfAssembledQty > 0) return primary.synthPrimaryChainTracked === true;
  return true;
}

// Smithing-level-adjusted repair cost, mirroring app.js: at level 99 you pay
// half the NPC fee at an armour stand. Returns 0 for non-repair recipes.
function fcRepairCost(repairBase, smithingLevel) {
  if (!repairBase) return 0;
  const lvl = Number.isFinite(smithingLevel) ? smithingLevel : 99;
  return Math.round(repairBase * (1 - lvl / 200));
}

function _attemptConversionInner(sellEvent, recipe, inventory, indexes, wikiPriceAt, mapping, priceWitnesses, depth, options) {
  const productQty = sellEvent.qty / (recipe.resultQty ?? 1);
  const costBasis = [];
  let estimated = false;
  let earliestTs = sellEvent.ts;
  const smithingLevel = options?.smithingLevel ?? 99;

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
    let synthEstimated = false;
    let synthPrimaryChainTracked = false;
    if (shortfall > 0 && indexes.byProduct.has(component.id)) {
      const synth = synthesizeFromNestedRecipe(component.id, shortfall, sellEvent.ts, inventory, indexes, wikiPriceAt, mapping, priceWitnesses, depth, options);
      lots.push(synth);
      synthesizedQty = synth.qty;
      synthPrimaryChainTracked = !!synth.primaryChainTracked;
      if (synth.estimated) { estimated = true; synthEstimated = true; }
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
      // Real FIFO lots contribute their own ts. Synthesized lots contribute
      // the earliest ts of the real buys that underpin them (propagated up
      // from the nested conversion). Self-extrapolation lots and wiki
      // fallbacks have no time signal — they don't move earliestTs.
      const candidate = l.sourceRowId != null ? l.ts
        : (l.synthesized ? l.nestedEarliestTs : null);
      if (candidate != null && candidate < earliestTs) earliestTs = candidate;
    }
    costBasis.push({
      itemId: component.id,
      itemName: fcItemName(mapping, component.id),
      qty: needed,
      gp,
      lots: lots.map((l) => l.sourceRowId).filter((x) => x != null),
      wikiFallbackQty: lots.filter((l) => l.fallback).reduce((s, l) => s + l.qty, 0),
      selfAssembledQty: synthesizedQty,
      synthEstimated, // synth lot itself relied on wiki deeper in chain
      synthPrimaryChainTracked, // synth's primary (recursively) lands on real FIFO
      extrapolatedQty,
      estimatedQty: lots.filter((l) => l.fallback).reduce((s, l) => s + l.qty, 0), // kept for back-compat with renderers
      lotStatuses: lots.filter((l) => l.sourceRowId != null).map((l) => l.status),
    });
  }

  // Smithing-adjusted repair cost for Barrows-style "repair" recipes — the
  // recipe defines `repairBase` (the NPC armour-stand fee at level 1) and we
  // scale by smithing level. Treated as a known cost (not estimated) and
  // emitted as a synthetic cost-basis line so the drilldown can show it.
  const repairUnitCost = fcRepairCost(recipe.repairBase, smithingLevel);
  if (repairUnitCost > 0) {
    costBasis.push({
      itemId: null,
      itemName: `Repair @ ${smithingLevel} smithing`,
      qty: productQty,
      gp: repairUnitCost * productQty,
      lots: [],
      wikiFallbackQty: 0,
      selfAssembledQty: 0,
      synthEstimated: false,
      synthPrimaryChainTracked: false,
      extrapolatedQty: 0,
      estimatedQty: 0,
      lotStatuses: [],
      repairCost: true,
    });
  }

  const totalCost = costBasis.reduce((s, c) => s + c.gp, 0);
  return {
    kind: "craft",
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

function attemptConversion(sellEvent, recipe, inventory, indexes, wikiPriceAt, mapping, priceWitnesses, options) {
  return _attemptConversionInner(sellEvent, recipe, inventory, indexes, wikiPriceAt, mapping, priceWitnesses || new Map(), 0, options);
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
  if (primary.wikiFallbackQty > 0) return true;
  if (primary.extrapolatedQty > 0) return true;
  // Synth is trusted when the recursive primary chain lands on real FIFO at
  // every layer. Cheap sub-components are allowed to self-extrap — only the
  // expensive piece of each layer has to be real (per user intent).
  if (primary.selfAssembledQty > 0 && !primary.synthPrimaryChainTracked) return true;
  return false;
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
      // Walk newest-first to mirror LIFO pop — coverage is order-independent,
      // but the cost tiebreaker should reflect the lots that will actually
      // be consumed.
      for (let i = queue.length - 1; i >= 0; i--) {
        if (remaining <= 0) break;
        const lot = queue[i];
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

// Decide whether a SELL is more naturally a craft than a pure flip. Only
// fires when the user holds BOTH finished product and a full set of components
// simultaneously — otherwise the choice is forced. Multi-week/month crafts
// where productInv is empty are unaffected by this heuristic.
//
// Two conditions must hold for craft preference:
//   1. The newest required component is newer than the newest held finished
//      product (recent acquisition signals an active project, not stale stock).
//   2. That newest component was bought within FRESH_CRAFT_WINDOW_MS of the
//      sell — i.e., this looks like a quick craft-and-sell cycle, not a
//      flip-and-replace where components were bought weeks ago for a different
//      future craft.
const FRESH_CRAFT_WINDOW_MS = 7 * 24 * 3600 * 1000; // 7 days
function shouldPreferCraft(productInv, candidates, inventory, sellTs) {
  if (!productInv || productInv.length === 0) return false;
  const productNewestTs = productInv[productInv.length - 1].ts;
  for (const recipe of candidates) {
    let allAvailable = true;
    let craftPossibleAt = -Infinity; // ts when all required components were owned
    for (const c of recipe.components) {
      const ci = inventory.get(c.id);
      if (!ci || ci.length === 0) { allAvailable = false; break; }
      const ts = ci[ci.length - 1].ts;
      if (ts > craftPossibleAt) craftPossibleAt = ts;
    }
    if (!allAvailable) continue;
    if (craftPossibleAt <= productNewestTs) continue;
    if (sellTs != null && (sellTs - craftPossibleAt) > FRESH_CRAFT_WINDOW_MS) continue;
    return true;
  }
  return false;
}

// Pure flip of a finished product: the user bought the recipe's product and
// later sold it, with no crafting involved. Emitted as a conversion (with
// kind: "flip") so the leaderboard surfaces it under the same recipe row.
// Returns null when nothing can be consumed or when the item has no recipe.
function emitPureFlip(sellEvent, productInv, candidates, qty, mapping) {
  if (!productInv || productInv.length === 0) return null;
  if (!candidates || candidates.length === 0) return null;
  const lots = popFromFIFO(productInv, qty);
  const consumed = lots.reduce((s, l) => s + l.qty, 0);
  if (consumed <= 0) return null;

  const recipeKey = candidates[0].key;
  const gp = lots.reduce((s, l) => s + l.qty * l.unitPrice, 0);
  let earliestTs = sellEvent.ts;
  for (const l of lots) if (l.ts < earliestTs) earliestTs = l.ts;
  const revenue = sellEvent.price * consumed;
  const taxShare = sellEvent.qty > 0 ? (sellEvent.tax || 0) * (consumed / sellEvent.qty) : 0;
  return {
    kind: "flip",
    ts: sellEvent.ts,
    recipeKey,
    productId: sellEvent.itemId,
    productName: fcItemName(mapping, sellEvent.itemId),
    productQty: consumed,
    revenue,
    tax: taxShare,
    costBasis: [{
      itemId: sellEvent.itemId,
      itemName: fcItemName(mapping, sellEvent.itemId),
      qty: consumed,
      gp,
      lots: lots.map((l) => l.sourceRowId).filter((x) => x != null),
      wikiFallbackQty: 0,
      selfAssembledQty: 0,
      synthEstimated: false,
      synthPrimaryChainTracked: false,
      extrapolatedQty: 0,
      estimatedQty: 0,
      lotStatuses: lots.map((l) => l.status).filter(Boolean),
    }],
    totalCost: gp,
    profit: revenue - taxShare - gp,
    estimated: false,
    timeToFlip: sellEvent.ts - earliestTs,
    sellRowId: sellEvent.id,
  };
}

// How many finished products the user can craft right now from direct
// inventory (ignores wiki fallback, synth-from-nested, and self-extrap).
// Used by matchEvents to size the craft when preferring craft-over-flip, so
// a partial-coverage sell doesn't push every wiki-fallback heuristic.
function computeMaxCraftableQty(recipe, inventory) {
  if (!recipe.components || recipe.components.length === 0) return 0;
  const productPerCraft = recipe.resultQty ?? 1;
  let minSets = Infinity;
  for (const c of recipe.components) {
    const queue = inventory.get(c.id) || [];
    const totalQty = queue.reduce((s, l) => s + l.qty, 0);
    const setsFromThis = Math.floor(totalQty / c.qty);
    if (setsFromThis < minSets) minSets = setsFromThis;
  }
  return minSets === Infinity ? 0 : minSets * productPerCraft;
}

function matchEvents(events, recipes, indexes, wikiPriceAt, mapping, options) {
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
      const candidates = indexes.byProduct.get(e.itemId) || [];
      const productHasRecipe = candidates.length > 0;
      const productInv = inventory.get(e.itemId);
      let remainingQty = e.qty;

      const preferCraft = productHasRecipe && shouldPreferCraft(productInv, candidates, inventory, e.ts);

      // Phase 1: when preferring craft, craft up to the limit of direct
      // component inventory first. This avoids forcing wiki fallback for a
      // mixed sell (e.g., 1 finished + 1 craft-able set, selling 2 — we want
      // 1 craft + 1 flip, not a wiki-padded 2-craft attempt that gets dropped).
      if (preferCraft && productHasRecipe) {
        const recipe = selectBestRecipe(candidates, inventory, remainingQty);
        const maxCraftable = computeMaxCraftableQty(recipe, inventory);
        const craftQty = Math.min(maxCraftable, remainingQty);
        if (craftQty > 0) {
          const conv = attemptConversion(
            { ...e, qty: craftQty },
            recipe, inventory, indexes, wikiPriceAt, mapping, priceWitnesses, options
          );
          if (!shouldDropConversion(conv)) {
            conversions.push(conv);
            remainingQty -= craftQty;
          }
        }
      }

      // Phase 2: pure-flip pre-consume from finished-product inventory.
      if (productInv && productInv.length > 0 && remainingQty > 0) {
        const flipConv = emitPureFlip(e, productInv, candidates, remainingQty, mapping);
        if (flipConv) {
          conversions.push(flipConv);
          remainingQty -= flipConv.productQty;
        }
      }

      if (remainingQty <= 0) continue;
      if (!productHasRecipe) continue;

      // Phase 3: craft any remaining qty (default path crafts here; preferCraft
      // path falls through here only if Phase 1 was capped by component supply).
      const recipe = selectBestRecipe(candidates, inventory, remainingQty);
      const conv = attemptConversion(
        { ...e, qty: remainingQty },
        recipe, inventory, indexes, wikiPriceAt, mapping, priceWitnesses, options
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
  module.exports = { parseCopilot, parseFlippingUtilities, fcGeTax, fcGrossFromNet, detectFormat, buildNameIndex, resolveItemNames, buildRecipeIndexes, popFromInventory, popFromFIFO, selectBestRecipe, attemptConversion, synthesizeFromNestedRecipe, matchEvents, summarizeRecipes, filterConversionsByRange, selfExtrapolateLot, shouldDropConversion, fuzzyEventKey, mergeEventPair, fuzzyDedupeMerge, fcRepairCost, shouldPreferCraft, emitPureFlip };
}
