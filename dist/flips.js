/* ---------------- History tab (browser shell) ----------------
   IndexedDB persistence, DOM rendering, upload UX, drag-and-drop,
   drilldown modal repopulation. Reads `state`, `RECIPES`, `api`,
   `iconUrl`, `fmtGp`, `el`, and the flips-core pure helpers
   (parseCopilot, parseFlippingUtilities, detectFormat, buildNameIndex,
   resolveItemNames, buildRecipeIndexes, matchEvents, summarizeRecipes,
   filterConversionsByRange) from global scope.
------------------------------------------------------------- */

const HISTORY_DB_NAME = "big-timby-history";
const HISTORY_DB_VERSION = 1;
const HISTORY_SCHEMA_VERSION = 1;

// HTML-escape helper for any CSV/user-derived string interpolated into innerHTML.
function fcEsc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

const flipsDb = (() => {
  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(HISTORY_DB_NAME, HISTORY_DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("events")) {
          const events = db.createObjectStore("events", { keyPath: "id", autoIncrement: true });
          events.createIndex("byAccountTs", ["account", "ts"]);
          events.createIndex("byItemId", "itemId");
        }
        if (!db.objectStoreNames.contains("analysis")) {
          db.createObjectStore("analysis", { keyPath: "account" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function dedupeKey(e) {
    return `${e.account}|${e.ts}|${e.side}|${e.itemId ?? ""}|${e.qty}|${e.price}`;
  }

  async function putEvents(events, { mode = "replace", account } = {}) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(["events"], "readwrite");
      const store = tx.objectStore("events");
      const insertAll = () => { for (const e of events) store.add(e); };
      if (mode === "replace" && account) {
        const idx = store.index("byAccountTs");
        const range = IDBKeyRange.bound([account, -Infinity], [account, Infinity]);
        idx.openCursor(range).onsuccess = (ev) => {
          const cursor = ev.target.result;
          if (cursor) { store.delete(cursor.primaryKey); cursor.continue(); }
          else insertAll();
        };
      } else if (mode === "merge" && account) {
        const existing = new Set();
        const idx = store.index("byAccountTs");
        const range = IDBKeyRange.bound([account, -Infinity], [account, Infinity]);
        idx.openCursor(range).onsuccess = (ev) => {
          const cursor = ev.target.result;
          if (cursor) { existing.add(dedupeKey(cursor.value)); cursor.continue(); }
          else for (const e of events) if (!existing.has(dedupeKey(e))) store.add(e);
        };
      } else {
        insertAll();
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function getEvents(account) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(["events"], "readonly");
      const idx = tx.objectStore("events").index("byAccountTs");
      const out = [];
      const range = IDBKeyRange.bound([account, -Infinity], [account, Infinity]);
      idx.openCursor(range).onsuccess = (ev) => {
        const cursor = ev.target.result;
        if (cursor) { out.push(cursor.value); cursor.continue(); }
        else resolve(out);
      };
      tx.onerror = () => reject(tx.error);
    });
  }

  async function listAccounts() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(["analysis"], "readonly");
      const store = tx.objectStore("analysis");
      const out = [];
      store.openCursor().onsuccess = (ev) => {
        const cursor = ev.target.result;
        if (cursor) { out.push(cursor.value.account); cursor.continue(); }
        else resolve(out);
      };
      tx.onerror = () => reject(tx.error);
    });
  }

  async function putAnalysis(row) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(["analysis"], "readwrite");
      tx.objectStore("analysis").put(row);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function getAnalysis(account) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(["analysis"], "readonly");
      const req = tx.objectStore("analysis").get(account);
      req.onsuccess = () => {
        const row = req.result;
        if (!row || row.schemaVersion !== HISTORY_SCHEMA_VERSION) resolve(null);
        else resolve(row);
      };
      req.onerror = () => reject(req.error);
    });
  }

  async function clearAccount(account) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(["events", "analysis"], "readwrite");
      const events = tx.objectStore("events");
      const range = IDBKeyRange.bound([account, -Infinity], [account, Infinity]);
      events.index("byAccountTs").openCursor(range).onsuccess = (ev) => {
        const cursor = ev.target.result;
        if (cursor) { events.delete(cursor.primaryKey); cursor.continue(); }
      };
      tx.objectStore("analysis").delete(account);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function clearAll() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(["events", "analysis"], "readwrite");
      tx.objectStore("events").clear();
      tx.objectStore("analysis").clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  return { openDb, putEvents, getEvents, listAccounts, putAnalysis, getAnalysis, clearAccount, clearAll, dedupeKey };
})();

let recipeIndexes = null;
function ensureRecipeIndexes() {
  if (!recipeIndexes) recipeIndexes = buildRecipeIndexes(RECIPES);
  return recipeIndexes;
}

/* ---- Wiki price-history fetcher (cached per item+day) ----
   Lookup order for a (itemId, ts) pair:
     1. Wiki /timeseries (24h step, ~15 days back).
     2. Recorded 90-day price-history store (per-day JSON files hosted on the
        repo's price-history branch). Used by the Experimental tab too.
     3. Return 0 — the caller may then decide to drop the conversion.
---------------------------------------------------------------- */
const wikiPriceCache = new Map();           // key: `${itemId}|${day}` -> number
const storeDayCache = new Map();            // key: "YYYY-MM-DD" -> Map<itemId, midPrice>

const PRICE_STORE_BASE =
  "https://raw.githubusercontent.com/crazyhairmartin-ship-it/big-timbys-little-tool/price-history/prices/";

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
}

function isoDay(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

async function fetchPriceStoreDay(dayIso) {
  if (storeDayCache.has(dayIso)) return storeDayCache.get(dayIso);
  let byId = new Map();
  try {
    const r = await fetch(PRICE_STORE_BASE + dayIso + ".json");
    if (r.ok) {
      const dayFile = await r.json();
      // Average each item's high+low across all hours present in the file.
      const sums = new Map(); // id -> { sum, n }
      for (const [, idMap] of Object.entries(dayFile.hours || {})) {
        for (const [id, pair] of Object.entries(idMap)) {
          if (!Array.isArray(pair)) continue;
          const mid = ((pair[0] || 0) + (pair[1] || 0)) / 2;
          if (!mid) continue;
          const k = Number(id);
          const cur = sums.get(k) || { sum: 0, n: 0 };
          cur.sum += mid; cur.n += 1;
          sums.set(k, cur);
        }
      }
      for (const [id, { sum, n }] of sums) byId.set(id, Math.round(sum / n));
    }
  } catch (_) { /* unreachable day — leave empty */ }
  storeDayCache.set(dayIso, byId);
  return byId;
}

async function fetchWikiPriceForDay(itemId, ts) {
  const key = `${itemId}|${dayKey(ts)}`;
  if (wikiPriceCache.has(key)) return wikiPriceCache.get(key);
  let price = 0;
  try {
    const data = await api(`/timeseries?timestep=24h&id=${itemId}`);
    const points = data.data || [];
    const tsSec = Math.floor(ts / 1000);
    let best = null;
    for (const p of points) {
      if (p.timestamp <= tsSec && (!best || p.timestamp > best.timestamp)) best = p;
    }
    if (best) {
      const mid = ((best.avgHighPrice || 0) + (best.avgLowPrice || 0)) / 2;
      price = Math.round(mid) || best.avgHighPrice || best.avgLowPrice || 0;
    }
  } catch (_) {
    price = 0;
  }
  if (price === 0) {
    // Wiki had no point near this timestamp — try the recorded store.
    const byId = await fetchPriceStoreDay(isoDay(ts));
    if (byId.has(itemId)) price = byId.get(itemId);
  }
  wikiPriceCache.set(key, price);
  return price;
}

async function prefetchWikiPrices(needs) {
  const distinct = new Set();
  for (const n of needs) distinct.add(`${n.itemId}|${dayKey(n.ts)}|${n.ts}`);
  const queue = [...distinct].map((s) => {
    const parts = s.split("|");
    return { itemId: Number(parts[0]), ts: Number(parts[2]) };
  });
  const CONCURRENCY = 5;
  let i = 0;
  async function worker() {
    while (i < queue.length) {
      const idx = i++;
      const { itemId, ts } = queue[idx];
      await fetchWikiPriceForDay(itemId, ts);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}

function wikiPriceSync(itemId, ts) {
  return wikiPriceCache.get(`${itemId}|${dayKey(ts)}`) || 0;
}

/* ---- Upload pipeline ---- */
function deriveAccountFromFilename(filename) {
  return filename.replace(/\.csv$/i, "").trim() || "Account";
}

async function ensureMappingLoaded() {
  if (Object.keys(state.mapping).length > 0) return;
  const data = await api("/mapping");
  state.mapping = {};
  for (const it of data) state.mapping[it.id] = it;
}

async function runUpload(file, { mode = "replace", fuAccountOverride } = {}) {
  ensureRecipeIndexes();
  await ensureMappingLoaded();
  const text = await file.text();
  const format = detectFormat(text);
  if (!format) throw new Error("Unrecognised CSV format. Supported: Flipping Utilities, Copilot.");

  const fuAccount = format === "fu"
    ? (fuAccountOverride || deriveAccountFromFilename(file.name))
    : null;

  let events = format === "fu"
    ? parseFlippingUtilities(text, fuAccount)
    : parseCopilot(text);

  if (events.length === 0) throw new Error("No usable rows parsed from this file.");

  const nameIndex = buildNameIndex(state.mapping);
  const { resolved, misses } = resolveItemNames(events, nameIndex);

  const writeAccounts = format === "copilot"
    ? [...new Set(resolved.map((e) => e.account))]
    : [fuAccount];
  if (writeAccounts.length === 0) throw new Error("No account name could be derived.");
  const activeAccount = writeAccounts[0];

  for (const a of writeAccounts) {
    const subset = resolved.filter((e) => e.account === a);
    await flipsDb.putEvents(subset, { mode, account: a });
  }

  const indexes = ensureRecipeIndexes();
  const needs = [];
  // Walk the full recipe tree for each product sold so nested components
  // (e.g. shards inside a synthesized godsword blade) get wiki-prefetched too.
  function collectComponentNeeds(itemId, ts, depth) {
    if (depth > 5) return;
    const recipes = indexes.byProduct.get(itemId);
    if (!recipes) return;
    for (const r of recipes) {
      for (const c of r.components) {
        needs.push({ itemId: c.id, ts });
        collectComponentNeeds(c.id, ts, depth + 1);
      }
    }
  }
  for (const e of resolved) {
    if (e.side === "SELL" && e.itemId && indexes.byProduct.has(e.itemId)) {
      collectComponentNeeds(e.itemId, e.ts, 0);
    }
  }
  await prefetchWikiPrices(needs);

  for (const a of writeAccounts) {
    const all = await flipsDb.getEvents(a);
    const conversions = matchEvents(all, RECIPES, indexes, wikiPriceSync, state.mapping);
    const recipeSummaries = summarizeRecipes(conversions, RECIPES);
    await flipsDb.putAnalysis({
      account: a,
      schemaVersion: HISTORY_SCHEMA_VERSION,
      computedAt: Date.now(),
      conversions,
      recipeSummaries,
      skippedRows: misses,
    });
  }

  state.flipsHistory.accounts = await flipsDb.listAccounts();
  state.flipsHistory.activeAccount = activeAccount;
  localStorage.setItem("osrs-combo-history-account", activeAccount);
  state.flipsHistory.analysisCache = await flipsDb.getAnalysis(activeAccount);

  return { account: activeAccount, accounts: writeAccounts, parsed: events.length, misses };
}

function promptAccountName(suggested) {
  return new Promise((resolve) => {
    const dialog = document.getElementById("history-account-modal");
    const input = document.getElementById("history-account-input");
    input.value = suggested;
    const confirm = document.getElementById("history-account-confirm");
    const cancel = document.getElementById("history-account-cancel");
    function done(value) {
      confirm.removeEventListener("click", onConfirm);
      cancel.removeEventListener("click", onCancel);
      dialog.close();
      resolve(value);
    }
    function onConfirm() { done(input.value.trim() || suggested); }
    function onCancel() { done(null); }
    confirm.addEventListener("click", onConfirm);
    cancel.addEventListener("click", onCancel);
    dialog.showModal();
    setTimeout(() => input.select(), 30);
  });
}

async function handleUpload(file, mode) {
  const errEl = document.getElementById("history-upload-error");
  errEl.hidden = true; errEl.textContent = "";
  try {
    const text = await file.text();
    const fmt = detectFormat(text);
    if (!fmt) throw new Error("Unrecognised CSV format. Supported: Flipping Utilities, Copilot.");
    let fuAccountOverride;
    if (fmt === "fu") {
      const suggested = deriveAccountFromFilename(file.name);
      fuAccountOverride = await promptAccountName(suggested);
      if (fuAccountOverride == null) return;
    }
    await runUpload(file, { mode, fuAccountOverride });
    renderHistory();
  } catch (e) {
    errEl.textContent = e.message || String(e);
    errEl.hidden = false;
  }
}

let historyWired = false;

function onModeEnter() {
  ensureRecipeIndexes();
  if (!historyWired) {
    historyWired = true;
    document.getElementById("history-pick-file").addEventListener("click", () => {
      document.getElementById("history-file-input").click();
    });
    document.getElementById("history-file-input").addEventListener("change", async (ev) => {
      const file = ev.target.files?.[0];
      const mode = ev.target.dataset.mode || "replace";
      ev.target.dataset.mode = "";
      if (!file) return;
      ev.target.value = "";
      await handleUpload(file, mode);
    });

    // Drag-and-drop on <main>
    const main = document.getElementById("main");
    const overlay = document.getElementById("history-drag-overlay");
    let dragDepth = 0;
    main.addEventListener("dragenter", (ev) => {
      if (state.mode !== "history") return;
      if (!Array.from(ev.dataTransfer?.items || []).some((it) => it.kind === "file")) return;
      ev.preventDefault();
      dragDepth++;
      overlay.hidden = false;
    });
    main.addEventListener("dragover", (ev) => {
      if (state.mode !== "history") return;
      ev.preventDefault();
    });
    main.addEventListener("dragleave", () => {
      if (state.mode !== "history") return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) overlay.hidden = true;
    });
    main.addEventListener("drop", async (ev) => {
      if (state.mode !== "history") return;
      ev.preventDefault();
      dragDepth = 0;
      overlay.hidden = true;
      const file = Array.from(ev.dataTransfer?.files || []).find((f) => /\.csv$/i.test(f.name));
      if (file) await handleUpload(file, "replace");
    });

    // Sidebar controls
    document.getElementById("history-range").value = state.flipsHistory.range;
    document.getElementById("history-range").addEventListener("change", (ev) => {
      state.flipsHistory.range = ev.target.value;
      localStorage.setItem("osrs-combo-history-range", state.flipsHistory.range);
      renderHistory();
    });
    document.getElementById("history-account-select").addEventListener("change", async (ev) => {
      state.flipsHistory.activeAccount = ev.target.value;
      localStorage.setItem("osrs-combo-history-account", state.flipsHistory.activeAccount);
      state.flipsHistory.analysisCache = await flipsDb.getAnalysis(state.flipsHistory.activeAccount);
      renderHistory();
    });
    document.getElementById("history-replace").addEventListener("click", () => {
      const input = document.getElementById("history-file-input");
      input.dataset.mode = "replace";
      input.click();
    });
    document.getElementById("history-merge").addEventListener("click", () => {
      const input = document.getElementById("history-file-input");
      input.dataset.mode = "merge";
      input.click();
    });
    document.getElementById("chart-modal").addEventListener("close", () => {
      document.querySelector("#chart-modal .modal-controls")?.classList.remove("history-modal");
    });
    document.getElementById("history-clear").addEventListener("click", async () => {
      if (!state.flipsHistory.activeAccount) return;
      if (!confirm(`Clear all stored data for ${state.flipsHistory.activeAccount}? This cannot be undone.`)) return;
      await flipsDb.clearAccount(state.flipsHistory.activeAccount);
      state.flipsHistory.activeAccount = null;
      state.flipsHistory.analysisCache = null;
      localStorage.removeItem("osrs-combo-history-account");
      await refreshAccountsAndRender();
    });
  }
  refreshAccountsAndRender();
}

function syncSidebarPanels() {
  const accountBlock = document.getElementById("history-account-block");
  const accountSel = document.getElementById("history-account-select");
  const loaded = document.getElementById("history-loaded-data");
  const summary = document.getElementById("history-loaded-summary");
  const accounts = state.flipsHistory.accounts;
  accountBlock.hidden = accounts.length <= 1;
  accountSel.replaceChildren();
  for (const a of accounts) {
    const opt = document.createElement("option");
    opt.value = a; opt.textContent = a;
    if (a === state.flipsHistory.activeAccount) opt.selected = true;
    accountSel.appendChild(opt);
  }
  if (!state.flipsHistory.activeAccount) { loaded.hidden = true; return; }
  loaded.hidden = false;
  const cache = state.flipsHistory.analysisCache;
  summary.replaceChildren();
  const acctSpan = document.createElement("div");
  acctSpan.textContent = state.flipsHistory.activeAccount;
  summary.appendChild(acctSpan);
  if (cache && cache.conversions?.length) {
    const tss = cache.conversions.map((c) => c.ts);
    const minTs = new Date(Math.min(...tss)).toLocaleDateString();
    const maxTs = new Date(Math.max(...tss)).toLocaleDateString();
    const meta = document.createElement("div");
    meta.textContent = `${cache.conversions.length.toLocaleString()} conversions · ${minTs} → ${maxTs}`;
    summary.appendChild(meta);
  }
}

async function refreshAccountsAndRender() {
  state.flipsHistory.accounts = await flipsDb.listAccounts();
  if (!state.flipsHistory.activeAccount && state.flipsHistory.accounts.length > 0) {
    state.flipsHistory.activeAccount = state.flipsHistory.accounts[0];
  }
  if (state.flipsHistory.activeAccount) {
    state.flipsHistory.analysisCache = await flipsDb.getAnalysis(state.flipsHistory.activeAccount);
  }
  renderHistory();
}

function onModeExit() {
  const bar = document.getElementById("history-summary-bar");
  if (bar) bar.remove();
}

function fcRangeBounds(rangeKey) {
  if (rangeKey === "all") return { start: null, end: null };
  const now = Date.now();
  const day = 86_400_000;
  const map = { week: 7 * day, month: 30 * day, "3mo": 90 * day, year: 365 * day };
  return { start: now - (map[rangeKey] || 0), end: null };
}

function fcHumanMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  const d = Math.round(h / 24);
  return `${d}d ${h % 24}h`;
}

function fcRelative(ts) {
  const diff = Date.now() - ts;
  if (diff < 0) return "now";
  const day = 86_400_000;
  if (diff < day) return `${Math.round(diff / 3_600_000)}h ago`;
  if (diff < 30 * day) return `${Math.round(diff / day)}d ago`;
  return `${Math.round(diff / (30 * day))}mo ago`;
}

function fcSortSummaries(summaries, sortKey) {
  const dir = sortKey.endsWith("-asc") ? 1 : -1;
  const base = sortKey.replace(/-(asc|desc)$/, "");
  const getter = {
    profit: (s) => s.totalProfit,
    roi: (s) => s.avgROI,
    conversions: (s) => s.conversions,
    avgprofit: (s) => s.avgProfit,
    timetoflip: (s) => s.avgTimeToFlip,
    winrate: (s) => s.winRate,
    name: (s) => s.productName,
  }[base] || ((s) => s.totalProfit);
  return summaries.slice().sort((a, b) => {
    const av = getter(a); const bv = getter(b);
    if (typeof av === "string") return dir * av.localeCompare(bv);
    return dir * (av - bv);
  });
}

function applyHistoryFilters(summaries) {
  const f = state.filters;
  const search = (f.search || "").toLowerCase().trim();
  const profitableOnly = !!f.profitableOnly;
  const favoritesOnly = !!f.favoritesOnly;
  const maxSlots = Number.isFinite(f.maxSlots) && f.maxSlots > 0 ? f.maxSlots : Infinity;
  const minCost = f.minCost ?? null;
  const maxCost = f.maxCost ?? null;
  const tagsActive = (f.activeCats instanceof Set) ? f.activeCats : null;

  return summaries.filter((s) => {
    if (search && !s.productName.toLowerCase().includes(search)) return false;
    if (profitableOnly && s.totalProfit <= 0) return false;
    if (favoritesOnly && !(state.favorites?.has?.(s.recipeKey))) return false;
    const recipe = RECIPES.find((r) => r.key === s.recipeKey);
    if (!recipe) return true;
    if (recipe.components.length > maxSlots) return false;
    if (tagsActive && tagsActive.size > 0 && recipe._tags && !recipe._tags.some((t) => tagsActive.has(t))) return false;
    if (minCost != null || maxCost != null) {
      const live = state.prices?.[s.productId]?.high ?? null;
      if (live != null) {
        if (minCost != null && live < minCost) return false;
        if (maxCost != null && live > maxCost) return false;
      }
    }
    return true;
  });
}

function makeBadge(label) {
  const b = document.createElement("span");
  b.className = "card-badge";
  b.textContent = label;
  return b;
}

function renderHistoryCards(host, summaries) {
  host.replaceChildren();
  const frag = document.createDocumentFragment();
  for (const s of summaries) {
    const card = document.createElement("article");
    card.className = "card history";
    card.dataset.recipeKey = s.recipeKey;
    if (s.totalProfit > 0) card.classList.add("profit");
    if (s.totalProfit < 0) card.classList.add("loss");

    const badges = document.createElement("div");
    badges.className = "card-badges";
    if (s.estimatedShare > 0.05) badges.appendChild(makeBadge("est"));
    if (s.totalProfit < 0) badges.appendChild(makeBadge("loss"));
    if (Date.now() - s.lastTs > 30 * 86_400_000) badges.appendChild(makeBadge("dormant"));
    card.appendChild(badges);

    const head = document.createElement("div");
    head.className = "card-head";
    const iconWrap = document.createElement("div");
    iconWrap.className = "card-icon";
    const img = document.createElement("img");
    img.src = iconUrl(s.productId);
    img.alt = "";
    iconWrap.appendChild(img);
    head.appendChild(iconWrap);
    const title = document.createElement("div");
    title.className = "card-title";
    const name = document.createElement("div");
    name.className = "card-name";
    name.textContent = s.productName;
    title.appendChild(name);
    const catRow = document.createElement("div");
    catRow.className = "card-cat-row";
    const catSpan = document.createElement("span");
    catSpan.textContent = s.category;
    catRow.appendChild(catSpan);
    title.appendChild(catRow);
    head.appendChild(title);
    card.appendChild(head);

    const primary = document.createElement("div");
    primary.className = "history-primary " + (s.totalProfit >= 0 ? "profit" : "loss");
    primary.textContent = fmtGp(s.totalProfit);
    card.appendChild(primary);

    if (s.estimatedShare > 0.05) {
      const est = document.createElement("div");
      est.className = "history-est-note";
      est.textContent = `~${Math.round(s.estimatedShare * 100)}% estimated`;
      card.appendChild(est);
    }

    const meta1 = document.createElement("div");
    meta1.className = "history-meta";
    meta1.textContent = `${s.conversions} conversions · ${(s.avgROI * 100).toFixed(1)}% ROI`;
    card.appendChild(meta1);

    const meta2 = document.createElement("div");
    meta2.className = "history-meta";
    meta2.textContent = `Avg flip: ${fcHumanMs(s.avgTimeToFlip)} · ${Math.round(s.winRate * 100)}% win`;
    card.appendChild(meta2);

    const last = document.createElement("div");
    last.className = "history-last";
    last.textContent = `Last: ${fcRelative(s.lastTs)}`;
    card.appendChild(last);

    card.addEventListener("click", () => openHistoryDrilldown(s.recipeKey));
    frag.appendChild(card);
  }
  host.appendChild(frag);
}

function renderHistoryTable(host, summaries) {
  const cols = [
    { key: "name",        label: "Recipe" },
    { key: "profit",      label: "Realized profit" },
    { key: "conversions", label: "Conversions" },
    { key: "avgprofit",   label: "Avg / conv" },
    { key: "roi",         label: "ROI %" },
    { key: "timetoflip",  label: "Avg flip" },
    { key: "winrate",     label: "Win rate" },
    { key: "lastts",      label: "Last" },
  ];
  const currentSort = state.filters.historySort;
  const sortBase = currentSort.replace(/-(asc|desc)$/, "");
  const sortDir = currentSort.endsWith("-asc") ? "asc" : "desc";
  const arrow = (key) => sortBase === key ? (sortDir === "asc" ? " ▲" : " ▼") : "";

  host.replaceChildren();
  const table = document.createElement("table");
  table.className = "history-table";
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const c of cols) {
    const th = document.createElement("th");
    th.className = "sortable";
    th.dataset.key = c.key;
    th.textContent = c.label + arrow(c.key);
    th.addEventListener("click", () => {
      let next;
      if (sortBase === c.key) next = sortDir === "desc" ? `${c.key}-asc` : `${c.key}-desc`;
      else next = `${c.key}-desc`;
      state.filters.historySort = next;
      localStorage.setItem("osrs-combo-history-sort", next);
      renderHistory();
    });
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const s of summaries) {
    const tr = document.createElement("tr");
    tr.dataset.recipeKey = s.recipeKey;
    tr.addEventListener("click", () => openHistoryDrilldown(s.recipeKey));
    const profitClass = s.totalProfit >= 0 ? "profit" : "loss";

    for (let i = 0; i < 8; i++) tr.appendChild(document.createElement("td"));

    const recipeTd = tr.children[0];
    recipeTd.className = "recipe-cell";
    const img = document.createElement("img");
    img.src = iconUrl(s.productId); img.alt = ""; img.className = "row-icon";
    recipeTd.appendChild(img);
    recipeTd.appendChild(document.createTextNode(" " + s.productName + " "));
    const catSpan = document.createElement("span");
    catSpan.className = "muted";
    catSpan.textContent = "· " + s.category;
    recipeTd.appendChild(catSpan);

    tr.children[1].className = profitClass;
    tr.children[1].textContent = fmtGp(s.totalProfit) + (s.estimatedShare > 0.05 ? ` ~${Math.round(s.estimatedShare * 100)}%` : "");
    tr.children[2].textContent = s.conversions;
    tr.children[3].textContent = fmtGp(Math.round(s.avgProfit));
    tr.children[4].textContent = (s.avgROI * 100).toFixed(1) + "%";
    tr.children[5].textContent = fcHumanMs(s.avgTimeToFlip);
    tr.children[6].textContent = Math.round(s.winRate * 100) + "%";
    tr.children[7].className = "muted";
    tr.children[7].textContent = fcRelative(s.lastTs);

    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  host.appendChild(table);
}

function renderHistorySummaryBar(conversions, summaries) {
  let bar = document.getElementById("history-summary-bar");
  const main = document.getElementById("main");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "history-summary-bar";
    bar.className = "history-summary-bar";
    main.insertBefore(bar, main.querySelector(".view-toggle").nextSibling);
  }
  if (conversions.length === 0) {
    bar.textContent = "No conversions in this range.";
    return;
  }
  const totalProfit = summaries.reduce((s, r) => s + r.totalProfit, 0);
  const tss = conversions.map((c) => c.ts);
  const minTs = new Date(Math.min(...tss)).toLocaleDateString();
  const maxTs = new Date(Math.max(...tss)).toLocaleDateString();
  bar.textContent = `${conversions.length.toLocaleString()} conversions · ${fmtGp(totalProfit)} realized · ${summaries.length} recipes · ${minTs} → ${maxTs}`;
}

function openHistoryDrilldown(recipeKey) {
  const cache = state.flipsHistory.analysisCache;
  if (!cache) return;
  const recipe = RECIPES.find((r) => r.key === recipeKey);
  if (!recipe) return;
  const conversions = cache.conversions.filter((c) => c.recipeKey === recipeKey);
  if (conversions.length === 0) return;

  const dialog = document.getElementById("chart-modal");
  document.getElementById("modal-title").textContent = recipe.name;

  const tabs = document.getElementById("chart-tabs");
  tabs.replaceChildren();
  for (const [key, label] of [["conversions", "Conversions"], ["profit", "Profit"], ["components", "Components"]]) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = label;
    btn.dataset.historyTab = key;
    if (key === state.flipsHistory.modalTab) btn.classList.add("active");
    btn.addEventListener("click", () => switchHistoryTab(key, recipe, conversions));
    tabs.appendChild(btn);
  }

  document.querySelector("#chart-modal .modal-controls").classList.add("history-modal");
  document.getElementById("modal-detail").replaceChildren();
  document.getElementById("modal-links").replaceChildren();

  switchHistoryTab(state.flipsHistory.modalTab, recipe, conversions);
  dialog.showModal();
}

function switchHistoryTab(key, recipe, conversions) {
  state.flipsHistory.modalTab = key;
  localStorage.setItem("osrs-combo-history-modal-tab", key);
  document.querySelectorAll("#chart-tabs button[data-history-tab]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.historyTab === key);
  });
  if (key === "conversions") renderConversionsTab(recipe, conversions);
  else if (key === "profit") renderProfitTab(recipe, conversions);
  else if (key === "components") renderComponentsTab(recipe, conversions);
  renderHistoryModalLinks(recipe);
}

function conversionStatusBadge(c) {
  const span = document.createElement("span");
  span.className = "conv-status";
  if (c.estimated) { span.textContent = "~"; span.title = "Used wiki fallback for one or more components"; return span; }
  const hasCancelled = c.costBasis.some((cb) => cb.lotStatuses?.some((s) => s === "cancelled"));
  if (hasCancelled) { span.textContent = "⚠"; span.title = "Includes partially-cancelled lots"; return span; }
  const hasPending = c.costBasis.some((cb) => cb.lotStatuses?.some((s) => s === "pending"));
  if (hasPending) { span.textContent = "…"; span.title = "Includes in-flight (pending) lots"; return span; }
  span.textContent = "✓"; span.title = "Complete";
  return span;
}

function toggleCostBasisExpansion(tr, conv) {
  const next = tr.nextElementSibling;
  if (next && next.classList.contains("cost-breakdown-row")) { next.remove(); return; }
  const breakdown = document.createElement("tr");
  breakdown.className = "cost-breakdown-row";
  const td = document.createElement("td");
  td.colSpan = 9;
  td.className = "cost-breakdown";
  for (const cb of conv.costBasis) {
    const row = document.createElement("div");
    const estPart = cb.estimatedQty > 0 ? ` (${cb.estimatedQty} est)` : "";
    const selfPart = cb.selfAssembledQty > 0 ? ` (${cb.selfAssembledQty} self-assembled)` : "";
    row.textContent = `${cb.qty}× ${cb.itemName}: ${fmtGp(cb.gp)}${estPart}${selfPart}`;
    td.appendChild(row);
  }
  breakdown.appendChild(td);
  tr.after(breakdown);
}

function renderConversionsTab(_recipe, conversions) {
  const host = document.getElementById("modal-detail");
  host.replaceChildren();
  const sorted = conversions.slice().sort((a, b) => b.ts - a.ts);
  const totals = sorted.reduce((acc, c) => {
    acc.profit += c.profit;
    if (c.profit > 0) acc.wins++;
    return acc;
  }, { profit: 0, wins: 0 });
  const winRate = sorted.length > 0 ? Math.round((totals.wins / sorted.length) * 100) : 0;

  const summary = document.createElement("div");
  summary.className = "conv-summary";
  summary.textContent = `${sorted.length} conversions · ${fmtGp(totals.profit)} profit · avg ${fmtGp(Math.round(totals.profit / Math.max(sorted.length, 1)))} · ${winRate}% win`;
  host.appendChild(summary);

  const table = document.createElement("table");
  table.className = "conv-table";
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const label of ["Date", "Qty", "Revenue", "Cost", "Tax", "Profit", "ROI", "Time to flip", ""]) {
    const th = document.createElement("th");
    th.textContent = label;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const c of sorted) {
    const tr = document.createElement("tr");
    tr.dataset.convTs = c.ts;
    const profitClass = c.profit >= 0 ? "profit" : "loss";
    for (let i = 0; i < 9; i++) tr.appendChild(document.createElement("td"));
    tr.children[0].textContent = new Date(c.ts).toLocaleString();
    tr.children[1].textContent = c.productQty;
    tr.children[2].textContent = fmtGp(c.revenue);
    tr.children[3].className = "cost-cell";
    tr.children[3].textContent = fmtGp(c.totalCost);
    tr.children[3].title = "Click to see component breakdown";
    tr.children[3].addEventListener("click", (ev) => {
      toggleCostBasisExpansion(tr, c);
      ev.stopPropagation();
    });
    tr.children[4].textContent = fmtGp(c.tax);
    tr.children[5].className = profitClass;
    tr.children[5].textContent = fmtGp(c.profit);
    tr.children[6].textContent = c.totalCost > 0 ? ((c.profit / c.totalCost) * 100).toFixed(1) + "%" : "—";
    tr.children[7].textContent = fcHumanMs(c.timeToFlip);
    tr.children[8].appendChild(conversionStatusBadge(c));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  host.appendChild(table);
}

function drawProfitCanvas(canvas, conversions) {
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  if (conversions.length === 0) {
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.fillText("No conversions to chart.", 10, 20);
    return;
  }
  const sorted = conversions.slice().sort((a, b) => a.ts - b.ts);
  let running = 0;
  const points = sorted.map((c) => { running += c.profit; return { ts: c.ts, total: running, est: c.estimated }; });

  const tsMin = points[0].ts;
  const tsMax = points[points.length - 1].ts;
  const valMin = Math.min(0, ...points.map((p) => p.total));
  const valMax = Math.max(0, ...points.map((p) => p.total));
  const pad = 32;
  const xFor = (ts) => pad + ((ts - tsMin) / Math.max(tsMax - tsMin, 1)) * (W - 2 * pad);
  const yFor = (v)  => H - pad - ((v - valMin) / Math.max(valMax - valMin, 1)) * (H - 2 * pad);

  ctx.strokeStyle = "rgba(255,255,255,0.15)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad, yFor(0));
  ctx.lineTo(W - pad, yFor(0));
  ctx.stroke();

  ctx.lineWidth = 2;
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1], cur = points[i];
    ctx.setLineDash(cur.est ? [4, 4] : []);
    ctx.strokeStyle = cur.total >= 0 ? "rgba(74,222,128,0.85)" : "rgba(248,113,113,0.85)";
    ctx.beginPath();
    ctx.moveTo(xFor(prev.ts), yFor(prev.total));
    ctx.lineTo(xFor(cur.ts), yFor(prev.total));
    ctx.lineTo(xFor(cur.ts), yFor(cur.total));
    ctx.stroke();
  }
  ctx.setLineDash([]);

  ctx.fillStyle = "rgba(255,255,255,0.55)";
  ctx.font = "11px system-ui";
  ctx.fillText(fmtGp(valMax), 4, yFor(valMax) + 4);
  ctx.fillText(fmtGp(valMin), 4, yFor(valMin) + 4);
  ctx.fillText(new Date(tsMin).toLocaleDateString(), pad, H - 8);
  const endLabel = new Date(tsMax).toLocaleDateString();
  ctx.fillText(endLabel, W - pad - ctx.measureText(endLabel).width, H - 8);
}

function renderProfitTab(_recipe, conversions) {
  const host = document.getElementById("modal-detail");
  host.replaceChildren();
  const canvas = document.createElement("canvas");
  canvas.id = "history-profit-canvas";
  canvas.width = 760; canvas.height = 320;
  canvas.style.width = "100%";
  canvas.style.maxWidth = "760px";
  host.appendChild(canvas);
  drawProfitCanvas(canvas, conversions);
}

function computeComponentStats(recipe, conversions) {
  const byId = new Map();
  for (const c of recipe.components) {
    byId.set(c.id, {
      itemId: c.id,
      itemName: state.mapping[c.id]?.name || `#${c.id}`,
      consumed: 0, selfAssembled: 0, estimated: 0, totalGp: 0,
    });
  }
  for (const conv of conversions) {
    for (const cb of conv.costBasis) {
      const s = byId.get(cb.itemId);
      if (!s) continue;
      s.consumed += cb.qty;
      s.selfAssembled += cb.selfAssembledQty || 0;
      s.estimated += cb.estimatedQty || 0;
      s.totalGp += cb.gp;
    }
  }
  return [...byId.values()];
}

function renderComponentsTab(recipe, conversions) {
  const host = document.getElementById("modal-detail");
  host.replaceChildren();
  const stats = computeComponentStats(recipe, conversions);
  const table = document.createElement("table");
  table.className = "comp-table";
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const label of ["Component", "Consumed", "Self-assembled", "Estimated", "Total spent", "Avg buy price"]) {
    const th = document.createElement("th");
    th.textContent = label;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const c of stats) {
    const tr = document.createElement("tr");
    for (let i = 0; i < 6; i++) tr.appendChild(document.createElement("td"));
    const nameCell = tr.children[0];
    const img = document.createElement("img");
    img.src = iconUrl(c.itemId); img.alt = ""; img.className = "row-icon";
    nameCell.appendChild(img);
    nameCell.appendChild(document.createTextNode(" " + c.itemName));
    tr.children[1].textContent = c.consumed;
    tr.children[2].textContent = c.selfAssembled;
    tr.children[3].textContent = c.estimated;
    tr.children[4].textContent = fmtGp(c.totalGp);
    tr.children[5].textContent = c.consumed > 0 ? fmtGp(Math.round(c.totalGp / c.consumed)) : "—";
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  host.appendChild(table);
}

function renderHistoryModalLinks(recipe) {
  const host = document.getElementById("modal-links");
  host.replaceChildren();
  const name = state.mapping[recipe.id]?.name || recipe.name;
  const linkSpec = [
    { label: "Wiki ↗", href: `https://oldschool.runescape.wiki/w/Special:Search?search=${encodeURIComponent(name)}` },
    { label: "GE database ↗", href: `https://secure.runescape.com/m=itemdb_oldschool/results?query=${encodeURIComponent(name)}` },
  ];
  for (const l of linkSpec) {
    const a = document.createElement("a");
    a.href = l.href; a.target = "_blank"; a.rel = "noopener";
    a.textContent = l.label;
    host.appendChild(a);
    host.appendChild(document.createTextNode(" "));
  }
}

function renderHistory() {
  ensureRecipeIndexes();
  const grid = document.getElementById("grid");
  const tableWrap = document.getElementById("table-wrap");
  const empty = document.getElementById("history-empty");
  syncSidebarPanels();

  if (!state.flipsHistory.activeAccount) {
    grid.replaceChildren();
    grid.hidden = true;
    tableWrap.hidden = true;
    empty.hidden = false;
    const bar = document.getElementById("history-summary-bar");
    if (bar) bar.remove();
    return;
  }
  empty.hidden = true;

  const cache = state.flipsHistory.analysisCache;
  const conversions = cache?.conversions || [];
  const { start, end } = fcRangeBounds(state.flipsHistory.range);
  const inRange = filterConversionsByRange(conversions, start, end);
  const summaries = summarizeRecipes(inRange, RECIPES);
  const filtered = applyHistoryFilters(summaries);
  const sorted = fcSortSummaries(filtered, state.filters.historySort);

  renderHistorySummaryBar(inRange, filtered);

  if (state.view === "cards") {
    grid.hidden = false; tableWrap.hidden = true;
    renderHistoryCards(grid, sorted);
  } else {
    grid.hidden = true; tableWrap.hidden = false;
    renderHistoryTable(tableWrap, sorted);
  }
}

window.Flips = { renderHistory, onModeEnter, onModeExit, handleUpload, runUpload };
