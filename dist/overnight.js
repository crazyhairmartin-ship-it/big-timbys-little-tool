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

window.Overnight = {
  runOvernightAnalysis, ensureOvernightAnalysis,
  loadOvernightCache, overnightCacheAgeMs,
  get data() { return overnightData; },
  get running() { return overnightRunning; },
  renderOvernight() {
    const grid = document.getElementById("grid");
    grid.hidden = false;
    document.getElementById("table-wrap").hidden = true;
    grid.replaceChildren(el("div", { class: "loading", text: "Overnight mode — coming in Task 9" }));
  },
};
