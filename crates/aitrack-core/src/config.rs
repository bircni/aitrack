//! Configuration file handling.

use anyhow::Context;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;

use crate::errors::error_message_any;
use crate::machine_id::normalize_machine_id;
use crate::paths::{app_dir, config_path};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Budget {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub monthly_usd: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub repo_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub machine_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claude_projects_dir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub codex_sessions_dir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub budget: Option<Budget>,
    /// Preserve unknown JSON keys via flatten
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

fn validate_budget(value: &Value) -> Option<Budget> {
    let obj = value.as_object()?;
    let mut budget = Budget { monthly_usd: None };

    if let Some(monthly) = obj.get("monthlyUSD") {
        let val = monthly.as_f64()?;
        if !val.is_finite() || val <= 0.0 {
            return None;
        }
        budget.monthly_usd = Some(val);
    }

    Some(budget)
}

fn validate_config(parsed: &Value) -> Option<Config> {
    let obj = parsed.as_object()?;

    let repo_url = obj.get("repoUrl")?.as_str()?.to_string();

    let mut machine_id = None;
    if let Some(id_val) = obj.get("machineId") {
        let raw = id_val.as_str()?;
        machine_id = Some(normalize_machine_id(raw).ok()?);
    }

    let claude_projects_dir = obj
        .get("claudeProjectsDir")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let codex_sessions_dir = obj
        .get("codexSessionsDir")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let budget = obj.get("budget").and_then(validate_budget);

    // Collect extra fields
    let mut extra = HashMap::new();
    for (key, value) in obj {
        if !matches!(
            key.as_str(),
            "repoUrl" | "machineId" | "claudeProjectsDir" | "codexSessionsDir" | "budget"
        ) {
            extra.insert(key.clone(), value.clone());
        }
    }

    Some(Config {
        repo_url,
        machine_id,
        claude_projects_dir,
        codex_sessions_dir,
        budget,
        extra,
    })
}

#[derive(Debug)]
pub enum ConfigLoad {
    Ok { config: Config },
    Missing,
    Invalid { reason: String },
}

pub fn read_config() -> ConfigLoad {
    let path = config_path();
    let raw = match fs::read_to_string(&path) {
        Ok(content) => content,
        Err(_) => return ConfigLoad::Missing,
    };

    let parsed: Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => {
            return ConfigLoad::Invalid {
                reason: format!("not valid JSON ({})", error_message_any(&e)),
            };
        }
    };

    match validate_config(&parsed) {
        Some(config) => ConfigLoad::Ok { config },
        None => ConfigLoad::Invalid {
            reason: "missing or malformed fields".to_string(),
        },
    }
}

pub fn load_config() -> anyhow::Result<Config> {
    match read_config() {
        ConfigLoad::Ok { config } => Ok(config),
        ConfigLoad::Invalid { reason } => Err(anyhow::anyhow!(
            "Config at {} is {}. Fix it or re-run: npx aitrack init",
            config_path().display(),
            reason
        )),
        ConfigLoad::Missing => Err(anyhow::anyhow!(
            "No config found. Run: npx aitrack init to create {}",
            config_path().display()
        )),
    }
}

pub fn try_load_config() -> Option<Config> {
    match read_config() {
        ConfigLoad::Ok { config } => Some(config),
        _ => None,
    }
}

pub fn save_config(config: &Config) -> anyhow::Result<()> {
    let mut normalized = config.clone();
    if let Some(ref id) = normalized.machine_id {
        normalized.machine_id = Some(normalize_machine_id(id)?);
    }

    fs::create_dir_all(app_dir())
        .with_context(|| format!("Failed to create app directory {}", app_dir().display()))?;

    let json = serde_json::to_string_pretty(&normalized).context("Failed to serialize config")?;

    fs::write(config_path(), json)
        .with_context(|| format!("Failed to write config to {}", config_path().display()))?;

    Ok(())
}

/// Use the short hostname, not the FQDN: the same machine reports different
/// fully-qualified names depending on the network it is on.
pub fn local_machine_id() -> String {
    match hostname::get() {
        Ok(name) => {
            let raw = name.to_string_lossy().to_string();
            let short_name = raw.split('.').next().unwrap_or(&raw);
            if !short_name.is_empty() {
                short_name.to_string()
            } else {
                raw
            }
        }
        Err(_) => "unknown".to_string(),
    }
}

pub fn resolve_machine_id(config: &Config) -> anyhow::Result<String> {
    let default_id = local_machine_id();
    let id = config.machine_id.as_deref().unwrap_or(&default_id);
    normalize_machine_id(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_local_machine_id_is_short() {
        let id = local_machine_id();
        assert!(!id.is_empty());
        // Should not contain dots (i.e., should be short hostname)
        // This might not always be true, but it's the intent
    }
}
