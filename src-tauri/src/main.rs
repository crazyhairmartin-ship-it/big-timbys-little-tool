// Prevents an extra console window on Windows in release; safe on macOS/Linux.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    big_timbys_little_tool_lib::run()
}
