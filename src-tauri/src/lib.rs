// Tauri v2 entry point.
// The web app is entirely static (no backend calls into Rust) so this is
// a minimal shell — Tauri handles the window creation and the system
// webview renders index.html + app.js as-is.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|_app| Ok(()))
        .run(tauri::generate_context!())
        .expect("error while running Big Timby's Little Tool");
}
