// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
  if anote_lib::maybe_run_bridge_cli() {
    return;
  }
  anote_lib::run();
}
