use std::path::PathBuf;

use crate::env::Env;
use crate::readers::paths::{absolute, split_configured_paths};

fn relative() -> PathBuf {
    PathBuf::from("User").join("globalStorage").join("state.vscdb")
}

fn default_path(env: &Env) -> PathBuf {
    let base = if cfg!(target_os = "macos") {
        env.home().join("Library").join("Application Support")
    } else if cfg!(windows) {
        env.var("APPDATA").map_or_else(|| env.home().join("AppData").join("Roaming"), PathBuf::from)
    } else {
        env.var("XDG_CONFIG_HOME").map_or_else(|| env.home().join(".config"), PathBuf::from)
    };
    base.join("Cursor").join(relative())
}

fn candidates(env: &Env) -> Vec<PathBuf> {
    if let Some(explicit) = env.var("CURSOR_STATE_DB_PATH") {
        return vec![absolute(std::path::Path::new(explicit))];
    }
    let Some(dirs) = env.var("CURSOR_CONFIG_DIR") else { return vec![default_path(env)] };
    split_configured_paths(Some(dirs))
        .into_iter()
        .map(|dir| {
            let resolved = absolute(std::path::Path::new(&dir));
            if resolved.to_string_lossy().ends_with(".vscdb") { resolved } else { resolved.join(relative()) }
        })
        .collect()
}

/// Cursor's `state.vscdb`, where the IDE keeps its login, or `None` when there is none.
pub fn cursor_state_database_path(env: &Env) -> Option<PathBuf> {
    candidates(env).into_iter().find(|candidate| candidate.exists())
}
