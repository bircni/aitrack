//! Finding Cursor's state database across platforms.

use crate::env::environment_value;
use std::path::PathBuf;

pub const CURSOR_CONFIG_DIR_ENV: &str = "CURSOR_CONFIG_DIR";
pub const CURSOR_STATE_DB_PATH_ENV: &str = "CURSOR_STATE_DB_PATH";
const CURSOR_STATE_DB_RELATIVE_PATH: &str = "User/globalStorage/state.vscdb";

fn get_cursor_default_state_database_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());

    if cfg!(target_os = "macos") {
        PathBuf::from(&home)
            .join("Library")
            .join("Application Support")
            .join("Cursor")
            .join(CURSOR_STATE_DB_RELATIVE_PATH)
    } else if cfg!(target_os = "windows") {
        let appdata =
            environment_value("APPDATA").unwrap_or_else(|| format!("{}\\AppData\\Roaming", home));
        PathBuf::from(appdata)
            .join("Cursor")
            .join(CURSOR_STATE_DB_RELATIVE_PATH)
    } else {
        // Linux/Unix
        let xdg_config =
            environment_value("XDG_CONFIG_HOME").unwrap_or_else(|| format!("{}/.config", home));
        PathBuf::from(xdg_config)
            .join("Cursor")
            .join(CURSOR_STATE_DB_RELATIVE_PATH)
    }
}

fn get_cursor_state_database_candidates() -> Vec<PathBuf> {
    if let Some(explicit) = environment_value(CURSOR_STATE_DB_PATH_ENV) {
        return vec![PathBuf::from(explicit)];
    }

    if let Some(configured) = environment_value(CURSOR_CONFIG_DIR_ENV) {
        return configured
            .split(',')
            .map(|v| v.trim())
            .filter(|v| !v.is_empty())
            .map(|value| {
                let resolved = PathBuf::from(value);
                if resolved.extension().and_then(|s| s.to_str()) == Some("vscdb") {
                    resolved
                } else {
                    resolved.join(CURSOR_STATE_DB_RELATIVE_PATH)
                }
            })
            .collect();
    }

    vec![get_cursor_default_state_database_path()]
}

pub fn get_cursor_state_database_path() -> Option<PathBuf> {
    let mut seen = std::collections::HashSet::new();

    for candidate in get_cursor_state_database_candidates() {
        let canonical = candidate
            .canonicalize()
            .unwrap_or_else(|_| candidate.clone());
        if !seen.insert(canonical.clone()) {
            continue;
        }
        if candidate.exists() {
            return Some(candidate);
        }
    }

    None
}
