/* ---------------- Overnight mode (browser shell) ----------------
   Fetches per-item hourly history, runs the overnight-core analytics,
   caches results, and renders the Overnight view. Loaded after app.js;
   reads app.js globals (state, RECIPES, api, geTax, fmtGp, el, iconUrl)
   by lexical name and the overnight-core functions from global scope.
------------------------------------------------------------------- */

const OVERNIGHT_MIN_VOLUME = 10;    // skip items trading < 10/24h (too thin to predict)
const OVERNIGHT_FETCH_CONCURRENCY = 5;
const OVERNIGHT_CACHE_KEY = "osrs-combo-overnight";
const OVERNIGHT_CACHE_TTL_MS = 24 * 3600 * 1000;
const OVERNIGHT_TREND_DISCOUNT = 0.5;  // fraction of a downtrend applied as a sell-price haircut
// Component-dip "buying opportunity" thresholds (volatility-aware z-scores).
const OVERNIGHT_DIP_COMPONENT_Z = -1.0;  // a component is "dipping" at or below this z
const OVERNIGHT_DIP_RECIPE_Z = -0.7;     // a recipe is flagged at or below this cost-weighted z
// Recorded price-history store: per-day files committed to the `price-history`
// branch by the hourly recorder, served raw from GitHub. Read alongside the
// live wiki /timeseries so the analysis can see history past the wiki's
// ~15-day /timeseries ceiling.
const OVERNIGHT_STORE_BASE =
  "https://raw.githubusercontent.com/crazyhairmartin-ship-it/big-timbys-little-tool/price-history/prices/";
const OVERNIGHT_STORE_DAYS = 90;    // how far back to probe (matches recorder retention)

// Self-tuned model parameters, published to the price-history branch root by
// the weekly tune-params workflow. Absent/unreadable -> the app uses defaults.
const OVERNIGHT_TUNED_PARAMS_URL =
  "https://raw.githubusercontent.com/crazyhairmartin-ship-it/big-timbys-little-tool/price-history/tuned-params.json";

// In-memory analysis result; also mirrored to localStorage.
let overnightData = null; // { analysedAt, predMap, analysed, skipped } — see runOvernightAnalysis
let overnightRunning = false;

// Every distinct item id referenced by any recipe — products AND components.
// Components are analysed because their predicted overnight prices feed each
// recipe's predicted cost; the recipe products are what gets shown as cards.
function overnightItemIds() {
  const ids = new Set();
  for (const r of RECIPES) {
    ids.add(r.id);
    for (const c of r.components) ids.add(c.id);
  }
  return [...ids];
}

// Run async `worker(item)` over `items`, at most `limit` in flight.
async function overnightThrottle(items, limit, worker) {
  const queue = items.slice();
  const runners = [];
  for (let i = 0; i < limit; i++) {
    runners.push((async () => {
      while (queue.length) {
        const item = queue.shift();
        await worker(item);
      }
    })());
  }
  await Promise.all(runners);
}

// Fetch ~15 days of live hourly history for one item from the wiki
// /timeseries. Returns the series array or null on failure / empty.
async function overnightFetchSeries(id) {
  try {
    const series = await fetchTimeseries(id, "1h");
    return Array.isArray(series) && series.length ? series : null;
  } catch (_) {
    return null;
  }
}

// Fetch the self-tuned parameters. Returns { baselineDays, trendDiscount } or
// null on any failure (missing file, network error, malformed or out-of-range
// values) — the caller then falls back to the built-in defaults.
async function overnightFetchTunedParams() {
  try {
    const r = await fetch(OVERNIGHT_TUNED_PARAMS_URL);
    if (!r.ok) return null;
    const p = await r.json();
    const bd = p && p.baselineDays, td = p && p.trendDiscount;
    if (typeof bd !== "number" || !Number.isInteger(bd) || bd < 1 || bd > 60) return null;
    if (typeof td !== "number" || td < 0 || td > 1) return null;
    return { baselineDays: bd, trendDiscount: td };
  } catch (_) {
    return null;
  }
}

// The store's index.json lists every day-file present. Returns that array, or
// null if the index is missing/unreadable — the caller then probes by date.
async function overnightFetchStoreIndex() {
  try {
    const r = await fetch(OVERNIGHT_STORE_BASE + "index.json");
    if (!r.ok) return null;
    const days = await r.json();
    return Array.isArray(days) && days.length ? days : null;
  } catch (_) {
    return null;
  }
}

// Fetch the recorded price-history store and pivot it into a
// Map<itemId, point[]> of /timeseries-shaped points. Uses index.json to fetch
// exactly the day-files that exist; only if the index is unavailable does it
// fall back to probing the last OVERNIGHT_STORE_DAYS UTC dates. Returns
// whatever it gathered — an empty Map on total failure, so the caller can
// still run on live data alone.
async function overnightFetchStore() {
  let days = await overnightFetchStoreIndex();
  if (!days) {
    const now = new Date();
    days = [];
    for (let i = 0; i < OVERNIGHT_STORE_DAYS; i++) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
      days.push(d.toISOString().slice(0, 10));
    }
  }
  const byId = new Map();
  await overnightThrottle(days, OVERNIGHT_FETCH_CONCURRENCY, async (day) => {
    try {
      const r = await fetch(OVERNIGHT_STORE_BASE + day + ".json");
      if (!r.ok) return;
      const dayFile = await r.json();
      for (const { id, point } of dayFileToPoints(dayFile)) {
        let arr = byId.get(id);
        if (!arr) { arr = []; byId.set(id, arr); }
        arr.push(point);
      }
    } catch (_) { /* unreachable day — skip it */ }
  });
  return byId;
}

// Full analysis run: fetch each item's history, self-calibrate, predict.
// Each item's series is the live wiki /timeseries merged with the recorded
// price-history store, so analysis sees history past the ~15-day wiki ceiling.
// `onProgress({ done, total })` is called as fetches complete.
async function runOvernightAnalysis(onProgress) {
  const candidates = overnightItemIds().filter(id => {
    const vol = state.volumes[id];
    return vol != null && vol >= OVERNIGHT_MIN_VOLUME;
  });
  if (onProgress) onProgress({ done: 0, total: candidates.length });
  const [tuned, store] = await Promise.all([overnightFetchTunedParams(), overnightFetchStore()]);
  const baselineDays = tuned ? tuned.baselineDays : OC_BASELINE_DAYS;
  const trendDiscount = tuned ? tuned.trendDiscount : OVERNIGHT_TREND_DISCOUNT;
  const seriesById = new Map();
  let done = 0;
  await overnightThrottle(candidates, OVERNIGHT_FETCH_CONCURRENCY, async (id) => {
    const live = await overnightFetchSeries(id);
    const series = mergeSeries(store.get(id) || [], live || []);
    if (series.length) seriesById.set(id, series);
    done += 1;
    if (onProgress) onProgress({ done, total: candidates.length });
  });

  // Per-item self-calibration: each item finds its OWN cheapest/dearest hour
  // (extremeHours), then we predict its low/high price and record the hours.
  // predMap is { id: { overnight, daytime, buyHour, sellHour, confidence } } —
  // `overnight` = predicted cheapest, `daytime` = predicted dearest. Those two
  // field names are kept so calcMargin's predMap path needs no change.
  const predMap = {};
  const dipMap = {};
  let analysed = 0;
  for (const [id, series] of seriesById) {
    const dip = priceDip(series, ocLowPrice);
    if (dip) dipMap[id] = dip;
    const windows = extremeHours(hourlyProfile(series));
    const a = analyzeItem(id, series, windows, geTax, baselineDays);
    if (!a) continue;
    const trend = priceTrend(series);
    predMap[id] = {
      overnight: a.predBuy,
      daytime: a.predSell * (1 + trendDiscount * Math.min(0, trend)),
      confidence: a.confidence,
      buyHour: windows.buyHours[0] ?? null,
      sellHour: windows.sellHours[0] ?? null,
      trend,
    };
    analysed += 1;
  }

  overnightData = {
    analysedAt: Date.now(),
    predMap,
    dipMap,
    analysed,
    skipped: candidates.length - seriesById.size,
  };
  return overnightData;
}

// Persist the computed analysis (not raw series) to localStorage.
function saveOvernightCache(data) {
  try {
    localStorage.setItem(OVERNIGHT_CACHE_KEY, JSON.stringify(data));
  } catch (_) { /* quota / disabled — cache is best-effort */ }
}

// Load a cached analysis, or null if absent / unparseable / written by an
// older build with an incompatible shape (missing predMap / windows).
function loadOvernightCache() {
  try {
    const raw = localStorage.getItem(OVERNIGHT_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.predMap || parsed.windows) return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

function overnightCacheAgeMs() {
  return overnightData ? Date.now() - overnightData.analysedAt : Infinity;
}

// Ensure analysis is available and fresh. Uses cache when < TTL old;
// otherwise runs a fresh analysis. `force` always re-runs.
async function ensureOvernightAnalysis(onProgress, force = false) {
  if (overnightRunning) return overnightData;
  if (!overnightData) overnightData = loadOvernightCache();
  const fresh = overnightData && Date.now() - overnightData.analysedAt < OVERNIGHT_CACHE_TTL_MS;
  if (fresh && !force) return overnightData;
  overnightRunning = true;
  try {
    const data = await runOvernightAnalysis(onProgress);
    saveOvernightCache(data);
    return data;
  } finally {
    overnightRunning = false;
  }
}

// Format a UTC hour-of-day (0-23) as a local-time label, e.g. "3 AM".
// The analysis runs in UTC (GE prices follow the global UTC cycle); only
// the displayed hour is converted to the viewer's local timezone.
function overnightLocalHour(utcHour) {
  if (utcHour == null) return "—";
  const localH = new Date(Date.UTC(2000, 0, 1, utcHour)).getHours();
  const ampm = localH < 12 ? "AM" : "PM";
  const h12 = localH % 12 === 0 ? 12 : localH % 12;
  return `${h12} ${ampm}`;
}

// The recipe's confidence = minimum confidence among product + all components.
// Returns a 0–1 number, or null if any prediction is missing.
function overnightRecipeConfidence(recipe) {
  const pm = overnightData.predMap;
  let min = Infinity;
  for (const id of [recipe.id, ...recipe.components.map(c => c.id)]) {
    const p = pm[id];
    if (!p || p.confidence == null) return null;
    if (p.confidence < min) min = p.confidence;
  }
  return min === Infinity ? null : min;
}

// A trend chip for the recipe card — reuses the realtime .trend-chip styling.
// Returns null for a roughly-flat trend (no chip).
function overnightTrendChip(t) {
  if (t == null) return null;
  const pct = t * 100;
  let kind, arrow;
  if (t <= -0.05)      { kind = "crash";         arrow = "▼▼"; }
  else if (t < -0.01)  { kind = "trending-down"; arrow = "↘"; }
  else if (t >= 0.05)  { kind = "spike";         arrow = "▲▲"; }
  else if (t > 0.01)   { kind = "trending-up";   arrow = "↗"; }
  else return null;
  const sign = pct >= 0 ? "+" : "";
  const chip = el("span", {
    class: "trend-chip trend-" + kind,
    text: `${arrow} ${sign}${pct.toFixed(1)}%`,
  });
  chip.title = `Price ${sign}${pct.toFixed(1)}% — recent vs earlier in the analysis window`;
  return chip;
}

// Aggregate a recipe's per-component price dips into one recipe-level signal,
// cost-weighted by each component's predicted buy cost (price x qty). A
// component with no dip entry (too little history) contributes its weight at
// z = 0. Returns { flagged, aggZ, pctBelow }, or null when no component has a
// usable dip signal or a predicted price is missing. Reads overnightData, so
// it tolerates a stale cache that predates dipMap via the `|| {}` fallback.
function overnightRecipeDip(recipe) {
  const predMap = overnightData.predMap;
  const dipMap = overnightData.dipMap || {};
  let weightSum = 0, zSum = 0, pctSum = 0, haveSignal = false;
  for (const c of recipe.components) {
    const pred = predMap[c.id];
    if (!pred || pred.overnight == null || pred.overnight <= 0) return null;
    const weight = pred.overnight * c.qty;
    weightSum += weight;
    const dip = dipMap[c.id];
    if (dip) {
      haveSignal = true;
      zSum += weight * dip.z;
      pctSum += weight * dip.pctBelow;
    }
  }
  if (!haveSignal || weightSum <= 0) return null;
  const aggZ = zSum / weightSum;
  return {
    flagged: aggZ <= OVERNIGHT_DIP_RECIPE_Z,
    aggZ,
    pctBelow: pctSum / weightSum,
  };
}

// One Overnight recipe card, mirroring the realtime renderCard DOM structure.
function overnightRecipeCard(recipe, calc) {
  const card = el("article", { class: "card ov-card " + (calc.margin > 0 ? "profit" : "loss") });
  card.onclick = () => openOvernightModal(recipe, calc);

  // Head
  const iconBox = el("div", { class: "card-icon" });
  const img = el("img", { attrs: { alt: "", loading: "lazy", src: recipeIcon(recipe) } });
  img.onerror = () => { img.style.display = "none"; };
  iconBox.appendChild(img);

  const conf = overnightRecipeConfidence(recipe);
  const catRow = el("div", { class: "card-cat-row" },
    el("span", { class: "card-cat", text: recipe.cat }),
  );
  if (conf !== null) {
    catRow.appendChild(el("span", { class: "skill-chip", text: Math.round(conf * 100) + "% reliable" }));
  }
  const trendChipEl = overnightTrendChip(overnightData.predMap[recipe.id] && overnightData.predMap[recipe.id].trend);
  if (trendChipEl) catRow.appendChild(trendChipEl);
  const recipeDip = overnightRecipeDip(recipe);
  if (recipeDip && recipeDip.flagged) {
    // pctBelow is a cost-weighted blend and can net out non-positive even on a
    // flagged recipe; only show a percentage when it is genuinely positive.
    const pct = Math.round(recipeDip.pctBelow * 100);
    const dipBadge = el("span", { class: "dip-chip",
      text: pct > 0 ? "parts " + pct + "% below usual" : "parts unusually cheap" });
    dipBadge.title = pct > 0
      ? "Components are unusually cheap to buy right now — about " + pct
        + "% below their recorded average."
      : "Components are unusually cheap to buy right now versus their recorded history.";
    catRow.appendChild(dipBadge);
  }
  const nameDiv = el("div", { class: "card-name", text: recipe.name });
  const titleBox = el("div", { class: "card-title" }, nameDiv, catRow);
  const head = el("div", { class: "card-head" }, iconBox, titleBox);

  // Hero margin block
  const heroVal = el("div", { class: "card-hero-value " + (calc.margin > 0 ? "pos" : "neg") });
  heroVal.textContent = fmtGp(calc.margin);
  const heroSub = el("div", { class: "card-hero-sub" });
  if (calc.roi != null) {
    heroSub.appendChild(el("span", { class: "card-hero-roi", text: calc.roi.toFixed(1) + "% ROI" }));
  }
  const heroMargin = el("div", { class: "card-hero" },
    el("div", { class: "card-hero-label", text: "Predicted margin" }),
    heroVal,
    heroSub,
  );

  // Supporting 3-col mini stats
  const flipsPerHour = perHour(calc.maxFlips);
  const fmtFlips = flipsPerHour != null ? String(Math.round(flipsPerHour * 10) / 10) : "—";
  const dailyText = calc.maxFlips != null && calc.margin != null ? fmtGp(calc.maxFlips * calc.margin) : "—";
  const stats = el("div", { class: "card-stats card-stats-3 card-stats-mini" },
    el("div", { class: "stat cost" },
      el("span", { class: "stat-label", text: "Total cost" }),
      el("span", { class: "stat-value", text: fmtGp(calc.totalCost) })),
    el("div", { class: "stat flips" },
      el("span", { class: "stat-label", text: "Trades/hr" }),
      el("span", { class: "stat-value", text: flipsPerHour != null ? fmtFlips : "—" })),
    el("div", { class: "stat daily" },
      el("span", { class: "stat-label", text: "Daily potential" }),
      el("span", { class: "stat-value", text: dailyText })),
  );

  // Component breakdown
  const comp = el("div", { class: "components" });
  const showDips = !!(recipeDip && recipeDip.flagged);
  for (const c of recipe.components) {
    const cName = state.mapping[c.id]?.name || "#" + c.id;
    const price = overnightData.predMap[c.id]?.overnight;
    const value = price != null
      ? (c.qty > 1 ? c.qty + "× " + fmtGp(price) : fmtGp(price))
      : "—";
    const buyHint = "buy " + overnightLocalHour(overnightData.predMap[c.id] && overnightData.predMap[c.id].buyHour);
    const dip = (overnightData.dipMap || {})[c.id];
    const dipping = showDips && dip && dip.z <= OVERNIGHT_DIP_COMPONENT_Z;
    const compRow = row(comp, { label: cName, value, hint: buyHint, cls: dipping ? "comp-dip" : "" });
    if (dipping) {
      const pct = Math.max(1, Math.round(dip.pctBelow * 100));
      compRow.title = `${cName} is about ${pct}% below its usual price — cheaper than usual to buy right now.`;
    }
  }
  if (recipe.supplies && recipe.supplies.length) {
    const supplyRow = row(comp, { label: "Supplies", value: fmtGp(calc.suppliesCost) });
    supplyRow.title = recipe.supplies
      .map(s => `${s.qty}× ${state.mapping[s.id]?.name || "#" + s.id}`)
      .join(" · ");
  }
  row(comp, { cls: "tax", label: "GE tax", value: "-" + fmtGp(calc.geTax) });
  const sellLabel = calc.resultQty > 1 ? "Sell price ×" + calc.resultQty : "Sell price";
  const sellHint = "sell " + overnightLocalHour(overnightData.predMap[recipe.id] && overnightData.predMap[recipe.id].sellHour);
  row(comp, { cls: "sell", label: sellLabel, value: fmtGp(calc.revenue), hint: sellHint });

  card.append(head, heroMargin, stats, comp);
  return card;
}

// Header strip: freshness + item count + refresh, or a progress bar.
function overnightHeader(progress) {
  const bar = el("div", { class: "ov-header" });
  if (progress) {
    bar.appendChild(el("span", { class: "ov-progress",
      text: `Analysing ${progress.done} / ${progress.total} items...` }));
    return bar;
  }
  const d = overnightData;
  const ageMin = Math.round(window.Overnight.overnightCacheAgeMs() / 60000);
  bar.appendChild(el("span", { class: "ov-meta",
    text: `Analysed ${ageMin}m ago · ${d.analysed} items` +
          (d.skipped ? ` · ${d.skipped} skipped` : "") }));
  const refresh = el("button", { class: "ov-refresh", text: "⟳", attrs: { title: "Re-analyse" } });
  refresh.onclick = async () => {
    await window.Overnight.ensureOvernightAnalysis(p => paintOvernight(p), true);
    paintOvernight();
  };
  bar.appendChild(refresh);
  return bar;
}

// Recipes with a complete, profitable predicted margin, after sidebar filters.
// Shares the real-time grid's filter predicate and sort, then adds the
// Experimental-only buy/sell-time filter.
function overnightVisible() {
  const f = state.filters;
  const pm = overnightData.predMap;
  const localHour = (utc) => new Date(Date.UTC(2000, 0, 1, utc)).getHours();
  const inRange = (h, lo, hi) => (lo <= hi ? (h >= lo && h <= hi) : (h >= lo || h <= hi));
  const out = [];
  for (const recipe of RECIPES) {
    const calc = calcMargin(recipe, pm);
    if (!calc.allPresent || !(calc.margin > 0)) continue;
    if (!passesSidebarFilters(recipe, calc)) continue;
    // Experimental time filter: every component's buy hour must fall in the
    // buy range, and the product's sell hour in the sell range (local time).
    const prod = pm[recipe.id];
    if (!prod || prod.sellHour == null) continue;
    if (!inRange(localHour(prod.sellHour), f.sellHourStart, f.sellHourEnd)) continue;
    let timeOk = true;
    for (const c of recipe.components) {
      const p = pm[c.id];
      if (!p || p.buyHour == null || !inRange(localHour(p.buyHour), f.buyHourStart, f.buyHourEnd)) {
        timeOk = false;
        break;
      }
    }
    if (!timeOk) continue;
    const item = { recipe, calc };
    // _dipAgg feeds the Recommended sort's component-dip bonus (scoreRecommended);
    // overnightRecipeCard recomputes its own copy for rendering.
    item._dipAgg = overnightRecipeDip(recipe);
    out.push(item);
  }
  return sortRecipeList(out);
}

// Paint the grid for Overnight mode. With `progress`, shows the progress bar.
function paintOvernight(progress) {
  const grid = document.getElementById("grid");
  grid.hidden = false;
  document.getElementById("table-wrap").hidden = true;
  grid.replaceChildren(overnightHeader(progress));
  if (progress) return;
  const visible = overnightVisible();
  if (!visible.length) {
    grid.appendChild(el("div", { class: "empty ov-empty", text: "No profitable overnight recipes match the filters." }));
    return;
  }
  for (const { recipe, calc } of visible) grid.appendChild(overnightRecipeCard(recipe, calc));
}

// Clicking an Overnight recipe card opens the same price-history chart modal
// the realtime view uses — the charts are the basis for the predictions.
function openOvernightModal(recipe, calc) {
  openModal(recipe);
}

// Entry point called by app.js renderGrid() when state.mode === "overnight".
function renderOvernight() {
  // Seed overnightData from cache BEFORE painting — paintOvernight() with no
  // progress arg reads overnightData and would throw if it were still null.
  if (!overnightData) overnightData = window.Overnight.loadOvernightCache();
  if (overnightData) paintOvernight();
  else paintOvernight({ done: 0, total: 1 });
  // Refresh in the background; only show the progress bar if we had nothing
  // cached to display in the meantime.
  window.Overnight.ensureOvernightAnalysis(p => {
    if (!overnightData) paintOvernight(p);
  }).then(() => {
    if (state.mode === "overnight" && overnightData) paintOvernight();
  });
}

window.Overnight = {
  runOvernightAnalysis, ensureOvernightAnalysis,
  loadOvernightCache, overnightCacheAgeMs,
  get data() { return overnightData; },
  get running() { return overnightRunning; },
  renderOvernight: renderOvernight,
};
