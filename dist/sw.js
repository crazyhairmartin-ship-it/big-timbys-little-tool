// Minimal service worker. Its presence makes the app PWA-installable in
// Chromium browsers (they require an active SW to show the install prompt).
// We do NOT cache anything — this tool needs live GE prices, and caching
// would mean serving stale data. The fetch handler is a pass-through.

const APP_SHELL_VERSION = "v1";

self.addEventListener("install", (e) => {
  // Activate immediately so updates take effect without waiting for old SW to die
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (e) => {
  // No-op: let the network handle everything. The presence of this listener
  // is what counts for installability heuristics.
});
