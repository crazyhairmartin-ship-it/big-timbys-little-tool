# Big Timby's Little Tool

OSRS combination item margin tracker. Live GE prices, GE tax included, trade-volume-aware bottleneck calculation, multi-tab price charts.

**Live site:** <https://big-timbys-little-tool.vercel.app/> — no install, works in any modern browser. Mobile-friendly; installable as a PWA from the address bar.

---

## Install (prebuilt binaries)

Each tagged release builds installers for Windows, macOS, and Linux on GitHub Actions and attaches them to a release at [Releases](../../releases).

### Windows

1. Go to the [latest release page](../../releases/latest)
2. Under **Assets**, download one of:
   - `Big.Timby_s.Little.Tool_0.1.0_x64_en-US.msi` *(recommended — integrates with Windows "Apps & features" so you can uninstall later)*
   - `Big.Timby_s.Little.Tool_0.1.0_x64-setup.exe` *(NSIS installer — smaller, simpler)*
3. Double-click the file to run the installer
4. **SmartScreen will block it on first run** because the binary isn't code-signed (signing certificates cost ~$200/yr and aren't worth it for a personal tool). To proceed:
   - Click **More info**
   - Click **Run anyway**
5. Click through the installer (Next → Install)
6. Launch from the Start menu — search "Big Timby"

**Where does it install?**
- `.msi`: `C:\Program Files\Big Timby's Little Tool\`
- `.exe` (NSIS): `C:\Users\<you>\AppData\Local\Big Timby's Little Tool\` (per-user, no admin needed)

**To uninstall:** Settings → Apps → Installed apps → search "Big Timby" → ⋯ → Uninstall.

### macOS

1. Download from the [latest release](../../releases/latest):
   - `Big.Timby_s.Little.Tool_0.1.0_aarch64.dmg` for Apple Silicon (M1/M2/M3/M4)
   - `Big.Timby_s.Little.Tool_0.1.0_x64.dmg` for Intel Macs
2. Double-click the `.dmg` to mount
3. Drag **Big Timby's Little Tool.app** into the **Applications** folder
4. **Gatekeeper will block it on first launch** (unsigned binary):
   - Right-click the app in `/Applications` → **Open** → click **Open** in the dialog
   - Or: System Settings → Privacy & Security → scroll to the bottom → **Open Anyway**

### Linux

1. Download from the [latest release](../../releases/latest):
   - `big-timbys-little-tool_0.1.0_amd64.AppImage` *(easiest — single file, works on most distros)*
   - `big-timbys-little-tool_0.1.0_amd64.deb` *(Debian/Ubuntu)*
2. **AppImage:** `chmod +x` it, then double-click or `./big-timbys-little-tool_*.AppImage`
3. **.deb:** `sudo dpkg -i big-timbys-little-tool_*.deb`

---

## Run in browser (no install)

Just open <https://big-timbys-little-tool.vercel.app/>.

For a standalone window without an installer, visit that page in Chrome/Edge/Safari and click the **install** button in the address bar — it becomes a regular app on your dock/taskbar via the Progressive Web App spec.

### Self-host

If you'd rather run it locally:

```sh
git clone https://github.com/crazyhairmartin-ship-it/big-timbys-little-tool.git
cd big-timbys-little-tool
python3 -m http.server 8765 -d dist
```

Open <http://localhost:8765>.

---

## Build from source

You need **Rust** (any recent stable) and **Node.js** (LTS) installed.

```sh
# Clone
git clone https://github.com/crazyhairmartin-ship-it/big-timbys-little-tool.git
cd big-timbys-little-tool

# Install Rust if you don't have it
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source "$HOME/.cargo/env"

# Install npm deps and build
npm install
npm run build
```

Output lands in `~/.big-timby-target/release/bundle/` (the build script redirects `CARGO_TARGET_DIR` to your home directory to avoid issues with non-APFS source mounts).

### Dev (hot-reload)

```sh
# Terminal 1: serve the web files
npm run serve

# Terminal 2: launch the Tauri window pointed at the dev server
npm run dev
```

Edits to `dist/index.html`, `dist/index.css`, and `dist/app.js` reload automatically.

### Cross-platform CI builds

Push a `v*` tag and the [`Build & Release` workflow](.github/workflows/release.yml) produces installers for Windows, macOS (arm + Intel), and Linux on GitHub Actions, attaching them to a draft release:

```sh
git tag v0.1.1
git push origin v0.1.1
```

Review the draft release and click **Publish** to make it visible to others.

---

## Folder layout

```
.
├── dist/                            # Static web app (HTML/CSS/JS + PWA manifest)
│   ├── index.html, index.css, app.js
│   ├── manifest.json, sw.js
│   └── icon.svg, icon-maskable.svg
├── src-tauri/                       # Tauri Rust shell
│   ├── Cargo.toml, tauri.conf.json
│   ├── build.rs
│   ├── src/main.rs + lib.rs
│   └── icons/                       # Multi-platform launcher icons
├── .github/workflows/release.yml    # Cross-platform CI build
├── package.json                     # Tauri CLI scripts
└── ge-tracker-combos.json           # Source recipe data (dev reference)
```

---

## History tab

Upload a CSV export of your trade history to see per-recipe analysis of your
actual combination-item flipping — realized profit, ROI, average time-to-flip,
and win rate, with a drilldown for each recipe (Conversions list, cumulative
profit chart, and per-component breakdown).

Supported formats:
- **Flipping Utilities** (RuneLite plugin) — `name,date,quantity,price,state`.
- **Copilot** — `Timestamp,Account,Side,Item,Quantity,Paid/Received,Tax,Price ea.,Part of Flip`.

The file format is auto-detected from the first line. You can drag-and-drop a
`.csv` anywhere on the History tab, or use the **Choose file** button. Existing
data can be replaced or merged on subsequent uploads (merge dedupes by
timestamp + side + item + qty + price).

Data is stored in your browser only (IndexedDB) — nothing is uploaded to a
server. Each visitor sees only their own data; clearing browser data clears the
history.

---

## Data sources

- **Prices** — `prices.runescape.wiki/api/v1/osrs/latest` (real-time, refreshes every 60s in the app)
- **Volumes** — `prices.runescape.wiki/api/v1/osrs/volumes` (24h trade totals)
- **Mapping** — `prices.runescape.wiki/api/v1/osrs/mapping` (item ID ↔ name, GE 4h buy limits)
- **Timeseries** — `prices.runescape.wiki/api/v1/osrs/timeseries?id=X&timestep=Y` (per-item history)
- **Recipes** — scraped from GE-Tracker's combination items page and manually verified against the wiki mapping. Venator bow added separately since GE-Tracker omits it.

---

## License

Personal project. The OSRS Wiki API is free under a Creative Commons license; recipe data comes from public game state.
