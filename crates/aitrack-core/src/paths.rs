//! Application directories under the user's home.
//!
//! Mirrors `packages/aitrack-lib/src/paths.ts`: always `~/.config/aitrack`.

use std::path::PathBuf;
use std::sync::OnceLock;

use crate::env::environment_value;

fn home_dir() -> PathBuf {
    if let Some(override_home) = environment_value("HOME") {
        return PathBuf::from(override_home);
    }
    if let Some(profile) = environment_value("USERPROFILE") {
        return PathBuf::from(profile);
    }
    PathBuf::from(".")
}

static APP_DIR: OnceLock<PathBuf> = OnceLock::new();

fn app_dir_cached() -> &'static PathBuf {
    APP_DIR.get_or_init(|| home_dir().join(".config").join("aitrack"))
}

pub fn app_dir() -> PathBuf {
    app_dir_cached().clone()
}

pub fn config_path() -> PathBuf {
    app_dir().join("config.json")
}

pub fn local_repo() -> PathBuf {
    app_dir().join("repo")
}

pub fn data_dir() -> PathBuf {
    local_repo().join("data")
}

pub fn pending_data_dir() -> PathBuf {
    app_dir().join("pending").join("data")
}

pub fn cache_dir() -> PathBuf {
    app_dir().join("cache")
}
