//! Path resolution and JSONL file discovery.

use crate::config::try_load_config;
use crate::env::environment_value;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

pub fn split_configured_paths(value: Option<&str>) -> Vec<String> {
    value
        .unwrap_or("")
        .split(',')
        .map(|v| v.trim())
        .filter(|v| !v.is_empty())
        .map(|v| v.to_string())
        .collect()
}

/// Walk directory tree and find all .jsonl files.
fn walk_jsonl_files(dir: &Path) -> Vec<PathBuf> {
    if !dir.exists() {
        return Vec::new();
    }

    WalkDir::new(dir)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .filter(|e| {
            e.path()
                .extension()
                .and_then(|s| s.to_str())
                .map(|s| s == "jsonl")
                .unwrap_or(false)
        })
        .map(|e| e.path().to_path_buf())
        .collect()
}

/// List every .jsonl file under root (recursive).
pub fn list_jsonl_files(root: &Path) -> Vec<PathBuf> {
    walk_jsonl_files(root)
}

/// List every .jsonl file under any of roots, de-duplicated and in root order.
pub fn list_unique_source_files(roots: &[PathBuf]) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    roots
        .iter()
        .flat_map(|root| list_jsonl_files(root))
        .filter(|file| seen.insert(file.clone()))
        .collect()
}

pub fn resolve_source_roots(options: ResolveSourceRootsOptions) -> Vec<PathBuf> {
    let mut paths = HashSet::new();

    for path in split_configured_paths(options.env_value.as_deref()) {
        paths.insert(PathBuf::from(&path));
    }

    for path in split_configured_paths(options.config_value.as_deref()) {
        paths.insert(PathBuf::from(&path));
    }

    for path in &options.defaults {
        paths.insert(path.clone());
    }

    paths
        .into_iter()
        .map(|p| {
            if p.is_absolute() {
                p
            } else {
                std::env::current_dir().unwrap_or_default().join(p)
            }
        })
        .collect()
}

pub struct ResolveSourceRootsOptions {
    pub env_value: Option<String>,
    pub config_value: Option<String>,
    pub defaults: Vec<PathBuf>,
}

pub fn get_claude_paths() -> Vec<PathBuf> {
    let home = std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."));
    let xdg = environment_value("XDG_CONFIG_HOME");

    let mut defaults = Vec::new();
    if let Some(xdg) = xdg {
        defaults.push(PathBuf::from(xdg).join("claude").join("projects"));
    }
    defaults.push(home.join(".config").join("claude").join("projects"));
    defaults.push(home.join(".claude").join("projects"));

    resolve_source_roots(ResolveSourceRootsOptions {
        env_value: environment_value("AITRACK_CLAUDE_PROJECTS_DIRS"),
        config_value: try_load_config().and_then(|c| c.claude_projects_dir),
        defaults,
    })
}

pub fn get_codex_paths() -> Vec<PathBuf> {
    let home = std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."));
    let codex_home = environment_value("CODEX_HOME");

    let mut defaults = Vec::new();
    if let Some(codex_home) = codex_home {
        defaults.push(PathBuf::from(codex_home).join("sessions"));
    }
    defaults.push(home.join(".codex").join("sessions"));

    resolve_source_roots(ResolveSourceRootsOptions {
        env_value: environment_value("AITRACK_CODEX_SESSION_DIRS"),
        config_value: try_load_config().and_then(|c| c.codex_sessions_dir),
        defaults,
    })
}

// Legacy compatibility exports
pub fn claude_project_dirs() -> Vec<PathBuf> {
    get_claude_paths()
}

pub fn codex_session_dirs() -> Vec<PathBuf> {
    get_codex_paths()
}

pub fn cursor_state_dir() -> Option<PathBuf> {
    None // Will be implemented in cursor/location.rs
}
