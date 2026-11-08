use clap::Parser;

/// Track Claude Code, Codex and Cursor usage across machines.
#[derive(Parser)]
#[command(name = "aitrack", version)]
struct Cli {}

fn main() {
    Cli::parse();
}
