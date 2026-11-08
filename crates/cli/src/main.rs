#![expect(clippy::struct_excessive_bools, reason = "clap flags are bools")]

mod commands;
mod json;

use std::process::ExitCode;

use aitrack_core::Core;
use aitrack_core::env::Env;
use aitrack_core::output::StdOutput;
use aitrack_core::time::Clock;
use clap::{Args, CommandFactory, Parser, Subcommand, ValueEnum};

pub const EXIT_FAILURE: u8 = 1;
pub const EXIT_USAGE: u8 = 2;

/// A failure, and whether it was the way the command was called (exit 2) rather than what it ran into (exit 1).
#[derive(Debug)]
pub struct Failure {
    pub message: String,
    pub usage: bool,
}

impl Failure {
    pub fn usage(message: impl Into<String>) -> Self {
        Self { message: message.into(), usage: true }
    }
}

impl<E: std::fmt::Display> From<E> for Failure {
    fn from(error: E) -> Self {
        Self { message: error.to_string(), usage: false }
    }
}

pub type Outcome = Result<ExitCode, Failure>;

/// Report AI coding assistant usage, and sync it across machines via a git remote
#[derive(Parser)]
#[command(name = "aitrack", version, after_help = "No setup needed to start: aitrack usage today")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Set up: configure the git remote and machine name, and clone the repo
    Init(commands::init::InitArgs),
    /// Read local AI usage data and push to git repo
    Sync(commands::sync::SyncArgs),
    /// Merge local usage with already-synced machine data and render a heatmap PNG (or terminal table with --tui)
    Show(commands::show::ShowArgs),
    /// Show usage broken down by provider and model over a fixed time window
    Usage(commands::usage::UsageArgs),
    /// Export an itemized usage receipt for a window (default: month, the rolling 30 days) as PDF or CSV
    Export(commands::export::ExportArgs),
    /// Show top days, models or projects by tokens or cost, merging local usage with already-synced machine data
    Top(commands::top::TopArgs),
    /// List all machines synced to the repo with totals, last sync, and active providers
    Machines(JsonArg),
    /// Refresh costs: re-read local JSONL on this machine; reprice other machines from stored cache breakdown
    #[command(name = "recompute-costs")]
    RecomputeCosts(commands::recompute::RecomputeArgs),
    /// Check local setup, provider sources, git sync health, and pricing metadata
    Doctor(commands::doctor::DoctorArgs),
    /// Install the opentrack desktop app from the latest GitHub release
    #[command(name = "install-opentrack")]
    InstallOpentrack(commands::install_opentrack::InstallArgs),
    /// Print a shell completion script (eval it or save it to your completions folder)
    Completion {
        /// target shell
        shell: Shell,
    },
    /// Get, set, or list aitrack configuration (~/.config/aitrack/config.json)
    Config {
        #[command(subcommand)]
        action: commands::config::ConfigAction,
    },
}

#[derive(Args)]
pub struct JsonArg {
    /// print machine-readable JSON
    #[arg(long)]
    pub json: bool,
}

#[derive(Clone, Copy, ValueEnum)]
enum Shell {
    Bash,
    Zsh,
    Fish,
}

/// The command a parser failure names when `--json` was asked for, or `None` without `--json`.
fn json_parse_failure_command(args: &[String]) -> Option<String> {
    let args = args.iter().skip(1).take_while(|a| *a != "--").collect::<Vec<_>>();
    if !args.iter().any(|a| *a == "--json") {
        return None;
    }
    let names: Vec<String> = Cli::command().get_subcommands().map(|c| c.get_name().to_owned()).collect();
    Some(args.iter().find(|a| names.contains(a)).map_or_else(|| "aitrack".to_owned(), |a| (*a).clone()))
}

fn core(json: bool) -> Core {
    Core::new(Env::from_process(), Clock::system(), Box::new(StdOutput { quiet: false, info_to_stderr: json }))
}

fn run(command: Command) -> (Option<&'static str>, Outcome) {
    use commands::{config, doctor, export, init, install_opentrack, machines, recompute, show, sync, top, usage};
    match command {
        Command::Init(args) => (None, init::run(&core(false), &args)),
        Command::Sync(args) => (args.json.then_some("sync"), sync::run(&core(args.json), &args)),
        Command::Show(args) => (args.json.then_some("show"), show::run(&core(args.json), &args)),
        Command::Usage(args) => {
            let json = args.json();
            (json.then_some("usage"), usage::run(&core(json), &args))
        }
        Command::Export(args) => (args.json.then_some("export"), export::run(&core(args.json), &args)),
        Command::Top(args) => (args.json.then_some("top"), top::run(&core(args.json), &args)),
        Command::Machines(args) => (args.json.then_some("machines"), machines::run(&core(args.json), args.json)),
        Command::RecomputeCosts(args) => {
            (args.json.then_some("recompute-costs"), recompute::run(&core(args.json), &args))
        }
        Command::Doctor(args) => (args.json.then_some("doctor"), Ok(doctor::run(&core(args.json), &args))),
        Command::InstallOpentrack(args) => {
            (args.json.then_some("install-opentrack"), install_opentrack::run(&core(args.json), &args))
        }
        Command::Completion { shell } => {
            let shell = match shell {
                Shell::Bash => clap_complete::Shell::Bash,
                Shell::Zsh => clap_complete::Shell::Zsh,
                Shell::Fish => clap_complete::Shell::Fish,
            };
            clap_complete::generate(shell, &mut Cli::command(), "aitrack", &mut std::io::stdout());
            (None, Ok(ExitCode::SUCCESS))
        }
        Command::Config { action } => {
            let json = action.json();
            (json.then_some("config"), config::run(&core(json), action))
        }
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    if matches!(args.get(1..), Some([flag]) if flag == "-V" || flag == "--version") {
        println!("{}", env!("CARGO_PKG_VERSION")); // Bare, as 4.x printed it for scripts.
        return ExitCode::SUCCESS;
    }
    let cli = match Cli::try_parse_from(&args) {
        Ok(cli) => cli,
        Err(error) => {
            if !error.use_stderr() {
                let _ = error.print(); // --help and --version.
                return ExitCode::SUCCESS;
            }
            if let Some(command) = json_parse_failure_command(&args) {
                let text = error.render().to_string();
                let first = text.lines().next().unwrap_or_default().trim_start_matches("error: ").to_owned();
                json::print_json_error(&command, &first);
            } else {
                let _ = error.print();
            }
            return ExitCode::from(EXIT_USAGE);
        }
    };
    let (json_command, outcome) = run(cli.command);
    match outcome {
        Ok(code) => code,
        Err(failure) => {
            match json_command {
                Some(command) => json::print_json_error(command, &failure.message),
                None => eprintln!("{}", failure.message),
            }
            ExitCode::from(if failure.usage { EXIT_USAGE } else { EXIT_FAILURE })
        }
    }
}
