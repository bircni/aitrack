use std::process::ExitCode;

use aitrack_core::Core;
use aitrack_core::sync::{SyncOptions, sync_data};
use clap::Args;
use serde_json::json;

use crate::Outcome;
use crate::json::print_json_command;

#[derive(Args)]
pub struct SyncArgs {
    /// show whether data would change without writing, committing, or pushing
    #[arg(long)]
    pub dry_run: bool,
    /// exit with an error if commits are still waiting to be pushed afterwards
    #[arg(long)]
    pub verify: bool,
    /// print machine-readable JSON
    #[arg(long)]
    pub json: bool,
}

pub fn run(core: &Core, args: &SyncArgs) -> Outcome {
    let result = sync_data(core, SyncOptions { dry_run: args.dry_run, verify: args.verify, timeout: None })?;
    if args.json {
        print_json_command(
            "sync",
            json!({ "message": result.message, "pushed": result.pushed, "days": result.days, "dryRun": args.dry_run }),
        );
    }
    Ok(ExitCode::SUCCESS)
}
