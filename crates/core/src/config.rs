use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{Map, Value};

use crate::data::messages::{INIT_HINT, NO_CONFIG_MESSAGE};
use crate::fs::{is_missing_path, write_file_atomic};
use crate::machine_id::normalize_machine_id;
use crate::{js, machine_id};

/// `~/.config/aitrack/config.json`, in the key order 4.x writes it.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub repo_url: String,
    /// Names `data/<machineId>.json`; defaults to the short hostname.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub machine_id: Option<String>,
    /// Comma-separated Claude Code project roots.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claude_projects_dir: Option<String>,
    /// Comma-separated Codex session roots.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub codex_sessions_dir: Option<String>,
    /// Comma-separated Copilot CLI session-state roots.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub copilot_sessions_dir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub budget: Option<Budget>,
    /// Encrypt this machine's synced file with `AITRACK_ENCRYPTION_PASSPHRASE`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encrypt_data: Option<bool>,
    /// Days older than this keep per-provider totals only in the synced file.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compact_after_days: Option<u64>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct Budget {
    /// Estimated-cost ceiling for the calendar month, in USD.
    #[serde(rename = "monthlyUSD", skip_serializing_if = "Option::is_none")]
    pub monthly_usd: Option<f64>,
}

/// An invalid config must not suggest `init`, which would overwrite it.
#[derive(Clone, Debug, PartialEq)]
pub enum ConfigLoad {
    Ok(Config),
    Missing,
    Invalid { reason: String },
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("{NO_CONFIG_MESSAGE}")]
    Missing,
    #[error("{0}")]
    Invalid(String),
    #[error("{0}")]
    MachineId(&'static str),
    #[error("Could not write {path}: {source}")]
    Write { path: PathBuf, source: std::io::Error },
}

#[must_use]
pub fn read_config(path: &Path) -> ConfigLoad {
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) if is_missing_path(&error) => return ConfigLoad::Missing,
        Err(error) => return ConfigLoad::Invalid { reason: format!("unreadable ({error})") },
    };
    let parsed: Value = match serde_json::from_str(&raw) {
        Ok(parsed) => parsed,
        Err(error) => return ConfigLoad::Invalid { reason: format!("not valid JSON ({error})") },
    };
    validate_config(&parsed)
        .map_or_else(|| ConfigLoad::Invalid { reason: "missing or malformed fields".to_owned() }, ConfigLoad::Ok)
}

/// # Errors
///
/// When the file cannot be read or is not a valid config.
pub fn load_config(path: &Path) -> Result<Config, ConfigError> {
    match read_config(path) {
        ConfigLoad::Ok(config) => Ok(config),
        ConfigLoad::Missing => Err(ConfigError::Missing),
        ConfigLoad::Invalid { reason } => Err(ConfigError::Invalid(invalid_config_message(path, &reason))),
    }
}

/// Without the init hint, for `init` itself.
#[must_use]
pub fn describe_invalid_config(path: &Path, reason: &str) -> String {
    format!("Config at {} is {reason}.", path.display())
}

#[must_use]
pub fn invalid_config_message(path: &Path, reason: &str) -> String {
    format!("{} Fix it or re-run: {INIT_HINT}", describe_invalid_config(path, reason))
}

/// Writes through a symlinked config to its target and keeps its mode: dotfile managers link this
/// file, and a `repoUrl` can hold a token.
///
/// # Errors
///
/// When the config cannot be written.
pub fn save_config(path: &Path, config: &Config) -> Result<(), ConfigError> {
    let mut config = config.clone();
    if let Some(id) = &config.machine_id {
        config.machine_id = Some(normalize_machine_id(id).map_err(ConfigError::MachineId)?.to_owned());
    }
    let (target, mode) = match std::fs::canonicalize(path) {
        Ok(target) => {
            let mode = file_mode(&target).map_err(|source| ConfigError::Write { path: target.clone(), source })?;
            (target, mode)
        }
        Err(error) if is_missing_path(&error) => (path.to_owned(), None),
        Err(source) => return Err(ConfigError::Write { path: path.to_owned(), source }),
    };
    let json = js::stringify_pretty(&config);
    write_file_atomic(&target, &json, mode).map_err(|source| ConfigError::Write { path: target, source })
}

/// The short hostname: the FQDN changes per network and would fork the machine's identity.
#[must_use]
pub fn local_machine_id() -> String {
    let raw = gethostname::gethostname().to_string_lossy().into_owned();
    match raw.split('.').next() {
        Some(short) if !short.is_empty() => short.to_owned(),
        _ => raw,
    }
}

/// # Errors
///
/// When the configured or derived id is not a valid machine id.
pub fn resolve_machine_id(config: Option<&Config>) -> Result<String, &'static str> {
    let id = config.and_then(|c| c.machine_id.clone()).unwrap_or_else(local_machine_id);
    machine_id::normalize_machine_id(&id).map(str::to_owned)
}

fn validate_config(parsed: &Value) -> Option<Config> {
    let fields = parsed.as_object()?;
    let optional_string = |key: &str| match fields.get(key) {
        None => Some(None),
        Some(Value::String(text)) => Some(Some(text.clone())),
        Some(_) => None,
    };
    let repo_url = fields.get("repoUrl")?.as_str()?.to_owned();
    let machine_id = match optional_string("machineId")? {
        Some(id) => Some(normalize_machine_id(&id).ok()?.to_owned()),
        None => None,
    };
    let claude_projects_dir = optional_string("claudeProjectsDir")?;
    let codex_sessions_dir = optional_string("codexSessionsDir")?;
    let copilot_sessions_dir = optional_string("copilotSessionsDir")?;
    let budget = match fields.get("budget") {
        None => None,
        Some(value) => Some(validate_budget(value.as_object()?)?),
    };
    let encrypt_data = match fields.get("encryptData") {
        None => None,
        Some(value) => Some(value.as_bool()?),
    };
    let compact_after_days = match fields.get("compactAfterDays") {
        None => None,
        Some(value) => Some(positive_integer(value)?),
    };
    Some(Config {
        repo_url,
        machine_id,
        claude_projects_dir,
        codex_sessions_dir,
        copilot_sessions_dir,
        budget,
        encrypt_data,
        compact_after_days,
    })
}

fn validate_budget(fields: &Map<String, Value>) -> Option<Budget> {
    fields.get("monthlyUSD").map_or_else(
        || Some(Budget::default()),
        |value| value.as_f64().filter(|usd| usd.is_finite() && *usd > 0.0).map(|usd| Budget { monthly_usd: Some(usd) }),
    )
}

/// `Number.isInteger(value) && value > 0`, which also accepts `5.0`.
fn positive_integer(value: &Value) -> Option<u64> {
    if let Some(n) = value.as_u64() {
        return (n > 0).then_some(n);
    }
    let x = value.as_f64()?;
    #[expect(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "checked just above: a positive whole number below 2^64"
    )]
    (x > 0.0 && x.fract() == 0.0 && x < 2f64.powi(64)).then_some(x as u64)
}

#[cfg(unix)]
fn file_mode(path: &Path) -> std::io::Result<Option<u32>> {
    use std::os::unix::fs::PermissionsExt;
    Ok(Some(std::fs::metadata(path)?.permissions().mode() & 0o777))
}

#[cfg(not(unix))]
#[expect(clippy::unnecessary_wraps, reason = "same signature as the Unix version")]
#[expect(clippy::missing_const_for_fn, reason = "same signature as the Unix version")]
fn file_mode(_: &Path) -> std::io::Result<Option<u32>> {
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, raw: &str) -> PathBuf {
        let path = dir.join("config.json");
        std::fs::write(&path, raw).unwrap();
        path
    }

    #[test]
    fn writes_the_bytes_4x_writes_and_reads_them_back() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("config.json");
        let config = Config {
            repo_url: "git@github.com:test/repo.git".into(),
            machine_id: Some(" Work Laptop_01.2 ".into()),
            claude_projects_dir: Some("/data/claude-a,/data/claude-b".into()),
            codex_sessions_dir: Some("/data/codex".into()),
            copilot_sessions_dir: None,
            budget: Some(Budget { monthly_usd: Some(5.0) }),
            encrypt_data: None,
            compact_after_days: Some(90),
        };
        save_config(&path, &config).unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "{\n  \"repoUrl\": \"git@github.com:test/repo.git\",\n  \"machineId\": \"Work Laptop_01.2\",\n  \
             \"claudeProjectsDir\": \"/data/claude-a,/data/claude-b\",\n  \"codexSessionsDir\": \"/data/codex\",\n  \
             \"budget\": {\n    \"monthlyUSD\": 5\n  },\n  \"compactAfterDays\": 90\n}"
        );
        let loaded = load_config(&path).unwrap();
        assert_eq!(loaded.machine_id.as_deref(), Some("Work Laptop_01.2"));
        assert_eq!(loaded.budget, config.budget);
    }

    #[test]
    fn tells_missing_from_invalid_and_rejects_malformed_fields() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read_config(&dir.path().join("none.json")), ConfigLoad::Missing);
        for raw in [
            "[]",
            "{}",
            r#"{"repoUrl":1}"#,
            r#"{"repoUrl":"x","machineId":null}"#,
            r#"{"repoUrl":"x","machineId":"../escape"}"#,
            r#"{"repoUrl":"x","budget":{"monthlyUSD":0}}"#,
            r#"{"repoUrl":"x","budget":[]}"#,
            r#"{"repoUrl":"x","encryptData":"yes"}"#,
            r#"{"repoUrl":"x","compactAfterDays":1.5}"#,
            r#"{"repoUrl":"x","compactAfterDays":0}"#,
        ] {
            let load = read_config(&write(dir.path(), raw));
            assert_eq!(load, ConfigLoad::Invalid { reason: "missing or malformed fields".into() }, "{raw}");
        }
        assert!(
            matches!(read_config(&write(dir.path(), "{")), ConfigLoad::Invalid { reason } if reason.starts_with("not valid JSON"))
        );
        let ok = read_config(&write(dir.path(), r#"{"repoUrl":"x","budget":{},"compactAfterDays":5.0,"extra":true}"#));
        assert_eq!(
            ok,
            ConfigLoad::Ok(Config {
                repo_url: "x".into(),
                budget: Some(Budget::default()),
                compact_after_days: Some(5),
                ..Config::default()
            })
        );
    }

    #[test]
    fn refuses_an_unsafe_machine_id_before_writing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        let config = Config { repo_url: "x".into(), machine_id: Some("../escape".into()), ..Config::default() };
        assert!(matches!(save_config(&path, &config), Err(ConfigError::MachineId(_))));
        assert!(!path.exists());
    }

    #[cfg(unix)]
    #[test]
    fn saves_through_a_symlink_and_keeps_a_restricted_mode() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let real = write(dir.path(), r#"{"repoUrl":"old"}"#).with_file_name("dotfiles-config.json");
        std::fs::write(&real, r#"{"repoUrl":"old"}"#).unwrap();
        std::fs::set_permissions(&real, std::fs::Permissions::from_mode(0o600)).unwrap();
        let link = dir.path().join("linked.json");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        save_config(&link, &Config { repo_url: "new".into(), ..Config::default() }).unwrap();
        assert!(std::fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
        assert_eq!(std::fs::read_to_string(&real).unwrap(), "{\n  \"repoUrl\": \"new\"\n}");
        assert_eq!(std::fs::metadata(&real).unwrap().permissions().mode() & 0o777, 0o600);
    }

    #[test]
    fn short_hostname_is_a_valid_machine_id() {
        let id = local_machine_id();
        assert!(!id.contains('.'));
        assert_eq!(resolve_machine_id(None), Ok(id));
    }
}
