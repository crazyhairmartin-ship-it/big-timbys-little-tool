# Big Timby's Little Tool

OSRS combination item margin tracker. Live GE prices, GE tax included, trade-volume-aware bottleneck calculation, multi-tab price charts.

This repo is a static web app that can be run three ways:

| Mode | Setup | Output |
|---|---|---|
| **Browser (web)** | `python3 -m http.server 8765` | Opens at http://localhost:8765 |
| **PWA** | Install from Chrome/Edge/Safari address bar | Standalone window, dock/taskbar icon |
| **Tauri desktop app** | See below | Native `.app` / `.dmg` / `.exe` |

## Quick start: browser

```sh
python3 -m http.server 8765
```

Open <http://localhost:8765/index.html>.

## Quick start: native desktop app (Tauri)

You need **Rust** and **Node.js** installed first.

### One-time setup

```sh
# 1. Install Rust (if not already installed)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"

# 2. Install JS deps (just the Tauri CLI)
npm install
```

### Dev (hot-reload window)

```sh
# Terminal 1: serve the web app
npm run serve

# Terminal 2: launch the Tauri window pointing at the dev server
npm run dev
```

### Production build

```sh
npm run build
```

The artifacts land in `src-tauri/target/release/bundle/`:

- **macOS:** `.app` and `.dmg`
- **Windows:** `.exe` and `.msi`
- **Linux:** `.AppImage` and `.deb`

Drag the `.app` to Applications (macOS) or run the installer (Windows / Linux).

## Folder layout

```
.
├── index.html, index.css, app.js    # The web app
├── manifest.json, sw.js, icon.svg   # PWA support
├── package.json                     # Tauri CLI npm wrapper
├── src-tauri/                       # Tauri Rust shell
│   ├── Cargo.toml
│   ├── tauri.conf.json              # Window + bundle config
│   ├── build.rs
│   ├── src/main.rs + lib.rs         # Rust entry point
│   └── icons/                       # PNG icons in required sizes
└── ge-tracker-combos.json           # Source of truth for recipe list
```

## Data sources

- **Prices**: `prices.runescape.wiki/api/v1/osrs/latest` (real-time)
- **Volumes**: `prices.runescape.wiki/api/v1/osrs/volumes` (24h totals)
- **Mapping**: `prices.runescape.wiki/api/v1/osrs/mapping` (item id ↔ name, GE buy limit)
- **Timeseries**: `prices.runescape.wiki/api/v1/osrs/timeseries?id=X&timestep=Y` (per-item history)
- **Recipes**: scraped from GE-Tracker's combination items page + manually verified against the wiki mapping (Venator bow added separately since GE-Tracker omits it)

## License

Personal project. The OSRS Wiki API is free under a Creative Commons license; the recipe data comes from public game state.
