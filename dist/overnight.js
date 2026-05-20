/* ---------------- Overnight mode (browser shell) ----------------
   Fetches per-item hourly history, runs the overnight-core analytics,
   caches results, and renders the Overnight view. Loaded after app.js;
   reads app.js globals (state, RECIPES, api, geTax, fmtGp, el, iconUrl)
   by lexical name and the overnight-core functions from global scope.
------------------------------------------------------------------- */

const OVERNIGHT_MIN_VOLUME = 100;   // skip items trading < 100/24h — not flippable
const OVERNIGHT_FETCH_CONCURRENCY = 5;
const OVERNIGHT_CACHE_KEY = "osrs-combo-overnight";
const OVERNIGHT_CACHE_TTL_MS = 24 * 3600 * 1000;

// In-memory analysis result, mirrored to localStorage by Task 7.
let overnightData = null; // { analysedAt, windows, items: analysis[] , skipped:int }
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

// Full analysis run: fetch, calibrate global windows, analyse each item.
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

  // Calibrate global windows from every fetched item's normalized curve.
  const curves = [];
  for (const series of seriesById.values()) {
    curves.push(normalizeCurve(hourlyProfile(series)));
  }
  const windows = calibrateWindows(curves, OC_WINDOW_WIDTH);

  // Analyse each item; drop nulls (thin history / no discount).
  const items = [];
  for (const [id, series] of seriesById) {
    const a = analyzeItem(id, series, windows, geTax);
    if (a) items.push(a);
  }
  items.sort((a, b) => b.score - a.score);

  // Per-item-id predicted price map: { id: { overnight, daytime, confidence } }.
  // Recipe margins (calcMargin with predMap) look up component overnight prices
  // and product daytime prices from this.
  const predMap = {};
  for (const a of items) {
    predMap[a.id] = { overnight: a.predBuy, daytime: a.predSell, confidence: a.confidence };
  }

  overnightData = {
    analysedAt: Date.now(),
    windows,
    items,
    predMap,
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
    if (!parsed || !parsed.predMap || !parsed.windows) return null;
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

// Format an hour list like [22,23,0,1,2,3] as "22:00-04:00 UTC".
function overnightWindowLabel(hours) {
  const start = hours.reduce((a, b) => Math.min(a, b), 24);
  // hours are contiguous mod 24; find the true start (the hour whose
  // predecessor is absent) so a wrapping window reads correctly.
  const set = new Set(hours);
  let s = hours[0];
  for (const h of hours) if (!set.has((h + 23) % 24)) s = h;
  const end = (s + hours.length) % 24;
  const pad = h => String(h).padStart(2, "0") + ":00";
  return `${pad(s)}-${pad(end)} UTC`;
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

// One Overnight recipe card, mirroring the realtime renderCard DOM structure.
function overnightRecipeCard(recipe, calc) {
  const card = el("article", { class: "card" });
  card.classList.add(calc.margin > 0 ? "profit" : "loss");
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
    row(comp, { label: cName, value });
  }
  row(comp, { cls: "tax", label: "GE tax", value: "-" + fmtGp(calc.geTax) });
  const sellLabel = calc.resultQty > 1 ? "Sell price ×" + calc.resultQty : "Sell price";
  row(comp, { cls: "sell", label: sellLabel, value: fmtGp(calc.revenue) });

  card.append(head, heroMargin, stats, comp);
  return card;
}

// Header strip: windows, freshness, refresh, or a progress bar mid-analysis.
function overnightHeader(progress) {
  const bar = el("div", { class: "ov-header" });
  if (progress) {
    bar.appendChild(el("span", { class: "ov-progress",
      text: `Analysing ${progress.done} / ${progress.total} items...` }));
    return bar;
  }
  const d = overnightData;
  const ageMin = Math.round(window.Overnight.overnightCacheAgeMs() / 60000);
  bar.appendChild(el("span", { class: "ov-windows",
    text: `Buy ${overnightWindowLabel(d.windows.buyHours)} - Sell ${overnightWindowLabel(d.windows.sellHours)}` }));
  bar.appendChild(el("span", { class: "ov-meta",
    text: `Analysed ${ageMin}m ago - ${d.items.length} items` +
          (d.skipped ? ` - ${d.skipped} skipped` : "") }));
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
    grid.appendChild(el("div", { class: "empty", text: "No profitable overnight recipes match the filters." }));
    return;
  }
  const wrap = el("div", { class: "grid ov-grid" });
  for (const { recipe, calc } of visible) wrap.appendChild(overnightRecipeCard(recipe, calc));
  grid.appendChild(wrap);
}

function openOvernightModal(recipe, calc) { /* implemented in R3 */ }

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
