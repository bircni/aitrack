use std::process::ExitCode;

use aitrack_core::Core;
use aitrack_core::config::{
    Budget, Config, ConfigLoad, invalid_config_message, read_config, resolve_machine_id, save_config,
};
use aitrack_core::data::messages::{NO_CONFIG_MESSAGE, REPO_URL_UNSET_MESSAGE};
use aitrack_core::data::usage_periods::parse_positive_integer;
use aitrack_core::git::remote::{differing_origin, redact_url};
use aitrack_core::js::{number_to_string, parse_number};
use aitrack_core::machine_id::normalize_machine_id;
use aitrack_core::store::encryption::{ENCRYPTION_PASSPHRASE_ENV, encryption_passphrase};
use aitrack_core::store::migrate::migrate_machine_data_files;
use clap::Subcommand;
use serde_json::{Map, Value, json};

use crate::json::print_json_command;
use crate::{Failure, Outcome};
use aitrack_core::display::style;

pub const CONFIG_KEYS: [&str; 7] = [
    "repoUrl",
    "machineId",
    "claudeProjectsDir",
    "codexSessionsDir",
    "budget.monthly",
    "encryptData",
    "compactAfterDays",
];

#[derive(Subcommand)]
pub enum ConfigAction {
    /// Print the current configuration
    List {
        /// print machine-readable JSON
        #[arg(long)]
        json: bool,
    },
    /// Print a single configuration value
    Get {
        key: String,
        /// print machine-readable JSON
        #[arg(long)]
        json: bool,
    },
    /// Set a configuration value (keys: repoUrl, machineId, claudeProjectsDir, codexSessionsDir, budget.monthly, encryptData, compactAfterDays)
    Set { key: String, value: String },
}

impl ConfigAction {
    pub const fn json(&self) -> bool {
        match self {
            Self::List { json } | Self::Get { json, .. } => *json,
            Self::Set { .. } => false,
        }
    }
}

fn unknown_key(key: &str) -> Failure {
    Failure::usage(format!("Unknown config key: \"{key}\". Valid keys: {}.", CONFIG_KEYS.join(", ")))
}

fn config_value(config: Option<&Config>, key: &str) -> Option<Value> {
    let config = config?;
    match key {
        "repoUrl" => Some(Value::from(config.repo_url.clone())),
        "machineId" => config.machine_id.clone().map(Value::from),
        "claudeProjectsDir" => config.claude_projects_dir.clone().map(Value::from),
        "codexSessionsDir" => config.codex_sessions_dir.clone().map(Value::from),
        "budget.monthly" => config.budget.as_ref().and_then(|b| b.monthly_usd).map(Value::from),
        "encryptData" => config.encrypt_data.map(Value::from),
        "compactAfterDays" => config.compact_after_days.map(Value::from),
        _ => None,
    }
}

/// `String(value)`.
fn plain(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Number(n) => n.as_f64().map_or_else(|| n.to_string(), number_to_string),
        other @ (Value::Null | Value::Bool(_) | Value::Array(_) | Value::Object(_)) => other.to_string(),
    }
}

/// What `list` and the `set` echo show; `get` prints the stored value, since asking for it is explicit.
fn display_value(key: &str, value: &Value) -> String {
    if key == "repoUrl" { redact_url(&plain(value)) } else { plain(value) }
}

/// `None` when there is no config; an invalid one fails, so nothing here overwrites it.
fn existing_config(core: &Core) -> Result<Option<Config>, Failure> {
    match read_config(&core.paths.config) {
        ConfigLoad::Ok(config) => Ok(Some(config)),
        ConfigLoad::Missing => Ok(None),
        ConfigLoad::Invalid { reason } => Err(invalid_config_message(&core.paths.config, &reason).into()),
    }
}

fn list(core: &Core, json: bool) -> Outcome {
    let config = existing_config(core)?;
    let resolved = config.as_ref().map(|c| resolve_machine_id(Some(c))).transpose()?;
    if json {
        let values: Map<String, Value> = CONFIG_KEYS
            .iter()
            .map(|k| ((*k).to_owned(), config_value(config.as_ref(), k).unwrap_or(Value::Null)))
            .collect();
        let mut payload = json!({ "action": "list", "values": values, "resolvedMachineId": resolved });
        if config.is_none() {
            payload["message"] = Value::from(NO_CONFIG_MESSAGE);
        }
        print_json_command("config", payload);
        return Ok(ExitCode::SUCCESS);
    }
    let (Some(config), Some(resolved)) = (config, resolved) else {
        core.output.info(NO_CONFIG_MESSAGE);
        return Ok(ExitCode::SUCCESS);
    };
    core.output.info(&style::bold("aitrack config"));
    for key in CONFIG_KEYS {
        let shown = config_value(Some(&config), key).map_or_else(|| style::dim("(unset)"), |v| display_value(key, &v));
        core.output.info(&format!("  {key} = {shown}"));
    }
    core.output.info(&format!("  {} = {resolved}", style::dim("resolved machineId")));
    Ok(ExitCode::SUCCESS)
}

fn get(core: &Core, key: &str, json: bool) -> Outcome {
    if !CONFIG_KEYS.contains(&key) {
        return Err(unknown_key(key));
    }
    let value = config_value(existing_config(core)?.as_ref(), key);
    if json {
        print_json_command("config", json!({ "action": "get", "key": key, "value": value }));
    } else {
        core.output.info(&value.map(|v| plain(&v)).unwrap_or_default());
    }
    Ok(ExitCode::SUCCESS)
}

/// `None` for "off", which clears the setting.
fn parse_monthly_budget(value: &str) -> Result<Option<f64>, Failure> {
    if value == "off" {
        return Ok(None);
    }
    match parse_number(value) {
        Some(n) if n.is_finite() && n > 0.0 => Ok(Some(n)),
        _ => Err(Failure::usage("budget.monthly must be a positive dollar amount, e.g. 200 or 149.99, or \"off\".")),
    }
}

fn parse_compact_after_days(value: &str) -> Result<Option<u64>, Failure> {
    if value == "off" {
        return Ok(None);
    }
    parse_positive_integer(value)
        .map(Some)
        .ok_or_else(|| Failure::usage("compactAfterDays must be a positive whole number of days, or \"off\"."))
}

/// Moving the remote replaces the clone, which needs init's confirmation; saying so here beats a sync
/// that keeps pushing to the old one.
fn assert_repo_url_fits_clone(core: &Core, repo_url: &str) -> Result<(), Failure> {
    let Some(origin) = differing_origin(core, &core.git(), repo_url) else { return Ok(()) };
    let repo = core.paths.repo.display();
    Err(Failure::usage(format!(
        "repoUrl not changed: the local clone at {repo} pushes to {}. To replace the clone, run: aitrack init --repo <url> (asks first). To keep its history and move it to the new remote, run: git -C \"{repo}\" remote set-url origin <url>, then set repoUrl again.",
        redact_url(&origin)
    )))
}

fn set(core: &Core, key: &str, value: &str) -> Outcome {
    if !CONFIG_KEYS.contains(&key) {
        return Err(unknown_key(key));
    }
    let existing = existing_config(core)?;
    let mut next = existing.clone().unwrap_or_default();
    match key {
        "budget.monthly" => {
            next.budget = parse_monthly_budget(value)?.map(|monthly| Budget { monthly_usd: Some(monthly) });
        }
        "encryptData" => {
            let encrypt = match value {
                "true" => true,
                "false" => false,
                _ => return Err(Failure::usage("encryptData must be true or false.")),
            };
            next.encrypt_data = Some(encrypt);
            if encrypt && encryption_passphrase(&core.env).is_none() {
                core.output.warn(&style::yellow(&format!(
                    "{ENCRYPTION_PASSPHRASE_ENV} is not set; sync will fail until it is."
                )));
            }
        }
        "compactAfterDays" => next.compact_after_days = parse_compact_after_days(value)?,
        "machineId" => {
            let machine_id = normalize_machine_id(value).map_err(Failure::usage)?.to_owned();
            migrate_machine_data_files(core, &resolve_machine_id(existing.as_ref())?, &machine_id)?;
            next.machine_id = Some(machine_id);
        }
        "repoUrl" => {
            assert_repo_url_fits_clone(core, value)?;
            value.clone_into(&mut next.repo_url);
        }
        "claudeProjectsDir" => next.claude_projects_dir = Some(value.to_owned()),
        _ => next.codex_sessions_dir = Some(value.to_owned()),
    }
    save_config(&core.paths.config, &next)?;
    let message = config_value(Some(&next), key)
        .map_or_else(|| format!("Cleared {key}."), |saved| format!("Set {key} = {}", display_value(key, &saved)));
    core.output.info(&message);
    if next.repo_url.is_empty() {
        core.output.warn(&style::yellow(REPO_URL_UNSET_MESSAGE));
    }
    Ok(ExitCode::SUCCESS)
}

pub fn run(core: &Core, action: ConfigAction) -> Outcome {
    match action {
        ConfigAction::List { json } => list(core, json),
        ConfigAction::Get { key, json } => get(core, &key, json),
        ConfigAction::Set { key, value } => set(core, &key, &value),
    }
}
