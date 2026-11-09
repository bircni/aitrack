use std::process::ExitCode;

use aitrack_core::Core;
use aitrack_core::recompute::{RecomputeOptions, recompute_costs};
use clap::Args;
use serde_json::json;

use crate::Outcome;
use crate::json::print_json_command;

#[derive(Args)]
pub struct RecomputeArgs {
    /// Rebuild this machine from the local logs, dropping synced days the logs no longer cover; also the way past a file no passphrase can open
    #[arg(long)]
    pub replace_local: bool,
    /// print machine-readable JSON
    #[arg(long)]
    pub json: bool,
}

pub fn run(core: &Core, args: &RecomputeArgs) -> Outcome {
    let result = recompute_costs(core, RecomputeOptions { replace_local: args.replace_local })?;
    if args.json {
        print_json_command("recompute-costs", json!({ "changed": result.changed, "pushed": result.pushed }));
    }
    Ok(ExitCode::SUCCESS)
}
