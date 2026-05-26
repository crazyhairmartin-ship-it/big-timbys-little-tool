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
