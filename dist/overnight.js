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

// Every distinct item id referenced by any recipe (product + components).
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

  overnightData = {
    analysedAt: Date.now(),
    windows,
    items,
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

// Load a cached analysis, or null if absent / unparseable.
function loadOvernightCache() {
  try {
    const raw = localStorage.getItem(OVERNIGHT_CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
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

// A tiny 24-bar sparkline of an item's hour-of-day curve, buy/sell shaded.
function overnightSparkline(curve, windows) {
  const wrap = el("div", { class: "ov-spark" });
  const vals = curve.filter(v => v != null);
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = max - min || 1;
  const buy = new Set(windows.buyHours), sell = new Set(windows.sellHours);
  for (let h = 0; h < 24; h++) {
    const v = curve[h];
    const bar = el("div", { class: "ov-spark-bar" });
    bar.style.height = v == null ? "2px" : `${4 + Math.round(((v - min) / span) * 22)}px`;
    if (buy.has(h)) bar.classList.add("buy");
    else if (sell.has(h)) bar.classList.add("sell");
    wrap.appendChild(bar);
  }
  return wrap;
}

// One Overnight card for an analysis result.
function overnightCard(a, windows) {
  const m = state.mapping[a.id];
  const name = m?.name || `#${a.id}`;
  const card = el("article", { class: "card ov-card " + (a.profit > 0 ? "profit" : "loss") });

  const img = el("img", { attrs: { alt: "", loading: "lazy", src: iconUrl(a.id) } });
  img.onerror = () => { img.style.display = "none"; };
  const iconBox = el("div", { class: "card-icon" }, img);
  const confChip = el("span", {
    class: "skill-chip", text: `${Math.round(a.confidence * 100)}% reliable`,
  });
  const title = el("div", { class: "card-title" },
    el("div", { class: "card-name", text: name }),
    el("div", { class: "card-cat-row" }, confChip));
  const head = el("div", { class: "card-head" }, iconBox, title);

  const heroVal = el("div", {
    class: "card-hero-value " + (a.profit > 0 ? "pos" : "neg"),
    text: `${a.profitPct >= 0 ? "+" : ""}${(a.profitPct * 100).toFixed(1)}%`,
  });
  const hero = el("div", { class: "card-hero" },
    el("div", { class: "card-hero-label", text: "Predicted profit" }),
    heroVal,
    el("div", { class: "card-hero-sub", text: `${fmtGp(a.profit)} / unit` }));

  // Reuse app.js's row() helper so the rows match the existing card styling.
  const stats = el("div", { class: "components" });
  row(stats, { label: "Predicted buy", value: fmtGp(a.predBuy) });
  row(stats, { label: "Predicted sell", value: fmtGp(a.predSell) });

  card.append(head, hero, stats, overnightSparkline(a.curve, windows));
  card.onclick = () => openOvernightModal(a, windows);
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

// Apply the sidebar search + cost-range filters to the analysis list.
function overnightVisible() {
  const f = state.filters;
  const q = f.search.toLowerCase().trim();
  return overnightData.items.filter(a => {
    if (a.confidence < OC_CONFIDENCE_FLOOR) return false;
    if (a.profit <= 0) return false;
    const name = (state.mapping[a.id]?.name || "").toLowerCase();
    if (q && !name.includes(q)) return false;
    if (f.minCost !== null && a.predBuy < f.minCost) return false;
    if (f.maxCost !== null && a.predBuy > f.maxCost) return false;
    return true;
  });
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
    grid.appendChild(el("div", { class: "empty", text: "No overnight opportunities match the filters." }));
    return;
  }
  const wrap = el("div", { class: "grid ov-grid" });
  for (const a of visible) wrap.appendChild(overnightCard(a, overnightData.windows));
  grid.appendChild(wrap);
}

function openOvernightModal(a, windows) { /* implemented in Task 10 */ }

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
    if (state.mode === "overnight") paintOvernight();
  });
}

window.Overnight = {
  runOvernightAnalysis, ensureOvernightAnalysis,
  loadOvernightCache, overnightCacheAgeMs,
  get data() { return overnightData; },
  get running() { return overnightRunning; },
  renderOvernight: renderOvernight,
};
