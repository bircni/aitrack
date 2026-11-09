//! Option parsers shared by the report commands, with 4.x's messages.

use aitrack_core::data::usage_periods::{invalid_date_message, parse_positive_integer};
use aitrack_core::day::Day;
use aitrack_core::providers::{PROVIDERS, normalize_provider_key};

pub const PROVIDERS_HELP: &str = "comma-separated providers to show (claude, codex, cursor); default: all";
pub const REFRESH_HELP: &str = "re-fetch live provider data (Cursor), ignoring the local cache";
const WATCH_MIN_SECONDS: u64 = 5;

fn provider_names() -> String {
    PROVIDERS.iter().map(|p| p.aliases[0]).collect::<Vec<_>>().join(", ")
}

/// Canonical, de-duplicated keys for a comma-separated, alias-tolerant list.
/// Clap reads a bare `Vec` as a repeated flag, so the parsed list is wrapped.
#[derive(Clone, Debug)]
pub struct Providers(Vec<String>);

impl std::ops::Deref for Providers {
    type Target = [String];
    fn deref(&self) -> &[String] {
        &self.0
    }
}

pub fn parse_providers(value: &str) -> Result<Providers, String> {
    let mut keys: Vec<String> = Vec::new();
    for name in value.split(',').map(aitrack_core::js::trim).filter(|n| !n.is_empty()) {
        let key = normalize_provider_key(name)
            .ok_or_else(|| format!("Invalid provider: \"{name}\". Expected one of: {}.", provider_names()))?;
        if !keys.iter().any(|k| k == key) {
            keys.push(key.to_owned());
        }
    }
    if keys.is_empty() {
        return Err(format!("No valid providers given. Expected one of: {}.", provider_names()));
    }
    Ok(Providers(keys))
}

pub fn parse_positive_int(value: &str) -> Result<u64, String> {
    parse_positive_integer(value).ok_or_else(|| format!("Expected a positive integer, got: {value}"))
}

/// Day keys are four-digit years.
pub fn parse_year(value: &str) -> Result<i16, String> {
    let year = parse_positive_int(value)?;
    i16::try_from(year)
        .ok()
        .filter(|year| *year <= 9999)
        .ok_or_else(|| format!("Expected a year up to 9999, got: {value}"))
}

pub fn parse_date(value: &str) -> Result<Day, String> {
    Day::parse(value).ok_or_else(|| invalid_date_message(value))
}

pub fn parse_watch_seconds(value: &str) -> Result<u64, String> {
    let seconds = parse_positive_int(value)?;
    if seconds < WATCH_MIN_SECONDS {
        return Err(format!("--watch needs at least {WATCH_MIN_SECONDS} seconds."));
    }
    Ok(seconds)
}

/// `-` conventionally means stdout, which these writers do not support.
pub fn warn_stdout_path(core: &aitrack_core::Core, path: Option<&std::path::Path>) {
    if path.is_some_and(|p| p.as_os_str() == "-") {
        core.output.warn("-o - writes a file named \"-\": aitrack cannot write to stdout.");
    }
}
