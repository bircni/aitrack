use std::io::IsTerminal;
use std::process::ExitCode;

use aitrack_core::Core;
use aitrack_core::config::{
    Config, ConfigLoad, describe_invalid_config, local_machine_id, read_config, resolve_machine_id, save_config,
};
use aitrack_core::git::remote::{redact_url, same_remote};
use aitrack_core::git::{clone_repo, is_cloned, replace_local_clone};
use aitrack_core::js::trim;
use aitrack_core::machine_id::{machine_id_validation_error, normalize_machine_id};
use aitrack_core::store::machine_files::adopt_pending_data_files;
use aitrack_core::store::migrate::migrate_machine_data_files;
use clap::Args;
use dialoguer::{Confirm, Input};

use crate::{EXIT_FAILURE, Failure, Outcome};

#[derive(Args)]
pub struct InitArgs {
    /// git remote URL; required without a terminal
    #[arg(long, value_name = "url")]
    pub repo: Option<String>,
    /// machine name, the data filename; required without a terminal on first setup
    #[arg(long, value_name = "name")]
    pub machine: Option<String>,
}

/// `None` when the prompt was cancelled.
fn confirm(message: &str) -> Option<bool> {
    Confirm::new().with_prompt(message).default(false).interact_opt().ok().flatten()
}

fn prompt_repo_url() -> Option<String> {
    Input::<String>::new()
        .with_prompt("Git remote URL (SSH or HTTPS), e.g. git@github.com:you/aitrack-data.git")
        .validate_with(|v: &String| if trim(v).is_empty() { Err("URL is required") } else { Ok(()) })
        .interact_text()
        .ok()
        .map(|v| trim(&v).to_owned())
}

fn prompt_machine_id(initial: &str) -> Option<String> {
    Input::<String>::new()
        .with_prompt("Machine name (used as data filename), e.g. work-laptop")
        .default(initial.to_owned())
        .validate_with(|v: &String| machine_id_validation_error(v).map_or(Ok(()), Err))
        .interact_text()
        .ok()
        .and_then(|v| normalize_machine_id(&v).ok().map(str::to_owned))
}

fn needs_terminal(what: &str) -> Failure {
    Failure::usage(format!("{what} Run init in a terminal, or pass --repo <url> --machine <name>."))
}

/// Nothing was written; scripts must not read this as a finished setup.
fn abort(core: &Core) -> ExitCode {
    core.output.info("Aborted.");
    ExitCode::from(EXIT_FAILURE)
}

/// Commits no remote has, even when a first push failed and left the branch with no upstream to compare to.
fn unpushed_commit_count(core: &Core) -> u64 {
    core.git()
        .run(&["rev-list", "--count", "HEAD", "--not", "--remotes"])
        .ok()
        .and_then(|n| trim(&n).parse().ok())
        .unwrap_or(0)
}

fn reclone_message(unpushed: u64) -> String {
    let (lead, ask) = ("Repo URL changed.", "Replace the local clone with a clone of the new URL?");
    if unpushed == 0 {
        format!("{lead} {ask}")
    } else {
        format!("{lead} The local clone holds {unpushed} commit(s) on no remote, and replacing it deletes them. {ask}")
    }
}

pub fn run(core: &Core, args: &InitArgs) -> Outcome {
    let interactive = std::io::stdin().is_terminal();
    let repo_flag = args.repo.as_deref().map(|r| trim(r).to_owned());
    if repo_flag.as_deref() == Some("") {
        return Err(Failure::usage("--repo must not be empty."));
    }
    let machine_flag = args.machine.as_deref().map(normalize_machine_id).transpose().map_err(Failure::usage)?;

    let loaded = read_config(&core.paths.config);
    let existing = match &loaded {
        ConfigLoad::Ok(config) => Some(config.clone()),
        ConfigLoad::Missing | ConfigLoad::Invalid { .. } => None,
    };
    let path = &core.paths.config;

    // Prompts cannot read a pipe.
    if !interactive {
        if repo_flag.is_none() {
            return Err(needs_terminal("No terminal to ask for the git remote."));
        }
        if machine_flag.is_none() && existing.as_ref().and_then(|c| c.machine_id.as_ref()).is_none_or(String::is_empty)
        {
            return Err(needs_terminal("No terminal to ask for the machine name."));
        }
        if let ConfigLoad::Invalid { reason } = &loaded {
            return Err(Failure::usage(format!(
                "{} Fix it, or run init in a terminal to overwrite it.",
                describe_invalid_config(path, reason)
            )));
        }
    }

    match &loaded {
        ConfigLoad::Missing => {}
        ConfigLoad::Invalid { reason } => core.output.warn(&describe_invalid_config(path, reason)),
        ConfigLoad::Ok(config) => core.output.info(&format!("Current config: repo={}", redact_url(&config.repo_url))),
    }
    // On a pipe, --repo is the answer; nothing below touches another setting in the config.
    if !matches!(loaded, ConfigLoad::Missing)
        && interactive
        && confirm("Config already exists. Overwrite?") != Some(true)
    {
        return Ok(abort(core));
    }
    let previous_machine_id = resolve_machine_id(existing.as_ref())?;

    if repo_flag.is_none() {
        core.output.info("First, create an empty GitHub repository (or any git remote) for storing data.");
        core.output.info("Example: https://github.com/new — name it something like \"aitrack-data\".");
        core.output.info("");
    }
    let Some(repo_url) = repo_flag.or_else(prompt_repo_url).filter(|u| !u.is_empty()) else { return Ok(abort(core)) };

    // Asked before the clone changes, so giving up here leaves the setup as it was.
    let existing_machine = existing.as_ref().and_then(|c| c.machine_id.clone()).filter(|m| !m.is_empty());
    let machine_id = match machine_flag {
        Some(flag) => Some(flag.to_owned()),
        None if interactive => prompt_machine_id(&existing_machine.unwrap_or_else(local_machine_id)),
        None => existing_machine,
    };
    let Some(machine_id) = machine_id else { return Ok(abort(core)) };

    let repo = core.paths.repo.display().to_string();
    let was_cloned = is_cloned(core);
    let origin = if was_cloned { core.git().clone_origin_url() } else { None };
    if let Some(origin) = origin.filter(|o| !same_remote(o, &repo_url)) {
        if !interactive {
            return Err(Failure::usage(format!(
                "The local clone at {repo} uses {}. Replacing it needs a confirmation, so run init in a terminal.",
                redact_url(&origin)
            )));
        }
        if confirm(&reclone_message(unpushed_commit_count(core))) != Some(true) {
            return Ok(abort(core));
        }
        core.output.info(&format!("Replacing the clone at {repo} with {}...", redact_url(&repo_url)));
        replace_local_clone(core, &repo_url)?;
        let base = existing.clone().unwrap_or_default();
        save_config(path, &Config { repo_url: repo_url.clone(), ..base })?; // Already true of the clone.
    } else if was_cloned {
        core.output.info(&format!("Repo already cloned at {repo}. Skipping clone."));
    } else {
        core.output.info(&format!("Cloning {} into {repo}...", redact_url(&repo_url)));
        if let Some(parent) = core.paths.repo.parent() {
            std::fs::create_dir_all(parent)?;
        }
        clone_repo(&repo_url, &core.paths.repo)?;
    }

    // Renames staged data too, so it runs first: an adopted file is untracked, and the rename's `git add` fails on it.
    migrate_machine_data_files(core, &previous_machine_id, &machine_id)?;
    // Once a clone exists, pending data may duplicate its synced current-machine file.
    let adopted = if existing.is_none() || !was_cloned { adopt_pending_data_files(core, &core.paths.data)? } else { 0 };

    let base = existing.unwrap_or_default();
    save_config(path, &Config { repo_url, machine_id: Some(machine_id), ..base })?;
    if adopted > 0 {
        core.output.info(&format!("Adopted {adopted} pending data file(s) into the repo."));
    }
    for line in [
        "",
        "Done! Next steps:",
        "  npx aitrack sync   # push your local AI usage data",
        "  npx aitrack show   # render heatmap PNG",
    ] {
        core.output.info(line);
    }
    Ok(ExitCode::SUCCESS)
}
