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

// Fetch ~15 days of hourly history for one item. Returns the series array
// or null on failure / empty.
async function overnightFetchSeries(id) {
  try {
    const series = await fetchTimeseries(id, "1h");
    return Array.isArray(series) && series.length ? series : null;
  } catch (_) {
    return null;
  }
}

// Full analysis run: fetch each item's history, self-calibrate, predict.
// `onProgress(done, total)` is called as fetches complete.
async function runOvernightAnalysis(onProgress) {
  const candidates = overnightItemIds().filter(id => {
    const vol = state.volumes[id];
    return vol != null && vol >= OVERNIGHT_MIN_VOLUME;
  });
  const seriesById = new Map();
  let done = 0;
  await overnightThrottle(candidates, OVERNIGHT_FETCH_CONCURRENCY, async (id) => {
    const series = await overnightFetchSeries(id);
    if (series) seriesById.set(id, series);
    done += 1;
    if (onProgress) onProgress(done, candidates.length);
  });

  // Per-item self-calibration: each item finds its OWN cheapest/dearest hour
  // (extremeHours), then we predict its low/high price and record the hours.
  // predMap is { id: { overnight, daytime, buyHour, sellHour, confidence } } —
  // `overnight` = predicted cheapest, `daytime` = predicted dearest. Those two
  // field names are kept so calcMargin's predMap path needs no change.
  const predMap = {};
  let analysed = 0;
  for (const [id, series] of seriesById) {
    const windows = extremeHours(hourlyProfile(series));
    const a = analyzeItem(id, series, windows, geTax);
    if (!a) continue;
    const trend = priceTrend(series);
    predMap[id] = {
      overnight: a.predBuy,
      daytime: a.predSell * (1 + OVERNIGHT_TREND_DISCOUNT * Math.min(0, trend)),
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
  for (const c of recipe.components) {
    const cName = state.mapping[c.id]?.name || "#" + c.id;
    const price = overnightData.predMap[c.id]?.overnight;
    const value = price != null
      ? (c.qty > 1 ? c.qty + "× " + fmtGp(price) : fmtGp(price))
      : "—";
    const buyHint = "buy " + overnightLocalHour(overnightData.predMap[c.id] && overnightData.predMap[c.id].buyHour);
    row(comp, { label: cName, value, hint: buyHint });
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
function overnightVisible() {
  const f = state.filters;
  const q = f.search.toLowerCase().trim();
  const out = [];
  for (const recipe of RECIPES) {
    const calc = calcMargin(recipe, overnightData.predMap);
    if (!calc.allPresent || !(calc.margin > 0)) continue;
    if (q && !recipe.name.toLowerCase().includes(q)) continue;
    if (f.minCost !== null && calc.totalCost < f.minCost) continue;
    if (f.maxCost !== null && calc.totalCost > f.maxCost) continue;
    // Experimental time filter: every component's buy hour must fall in the
    // buy range, and the product's sell hour in the sell range (local time).
    const localHour = (utc) => new Date(Date.UTC(2000, 0, 1, utc)).getHours();
    const inRange = (h, lo, hi) => (lo <= hi ? (h >= lo && h <= hi) : (h >= lo || h <= hi));
    const pm = overnightData.predMap;
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
    out.push({ recipe, calc });
  }
  out.sort((a, b) => b.calc.margin - a.calc.margin);
  return out;
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
