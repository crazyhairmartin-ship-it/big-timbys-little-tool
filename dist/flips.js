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

let historyWired = false;

function onModeEnter() {
  ensureRecipeIndexes();
}

function onModeExit() {
  const bar = document.getElementById("history-summary-bar");
  if (bar) bar.remove();
}

function renderHistory() {
  const grid = document.getElementById("grid");
  grid.textContent = "History tab — coming together…";
}

window.History = { renderHistory, onModeEnter, onModeExit };
