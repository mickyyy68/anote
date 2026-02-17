#[path = "../db.rs"]
mod db;
#[path = "../bridge_cli.rs"]
mod bridge_cli;

fn main() {
    bridge_cli::run_stdio_from_stdin();
}
