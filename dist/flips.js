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

/* ---- Wiki price-history fetcher (cached per item+day) ---- */
const wikiPriceCache = new Map();

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
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

async function runUpload(file, { mode = "replace", fuAccountOverride } = {}) {
  ensureRecipeIndexes();
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
  for (const e of resolved) {
    if (e.side === "SELL" && e.itemId && indexes.byProduct.has(e.itemId)) {
      for (const r of indexes.byProduct.get(e.itemId)) {
        for (const c of r.components) needs.push({ itemId: c.id, ts: e.ts });
      }
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
    return;
  }
  empty.hidden = true;
  grid.hidden = false;
  tableWrap.hidden = true;
  const n = state.flipsHistory.analysisCache?.conversions?.length ?? 0;
  grid.textContent = `Loaded ${n} conversions. (Leaderboard renders in Task 25.)`;
}

window.History = { renderHistory, onModeEnter, onModeExit, handleUpload, runUpload };
