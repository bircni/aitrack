use std::collections::HashSet;
use std::io;
use std::path::{Component, Path, PathBuf};

use crate::env::Env;
use crate::fs::is_missing_path;

/// Comma-separated roots from an env var or the config, trimmed, blanks dropped.
#[must_use]
pub fn split_configured_paths(value: Option<&str>) -> Vec<String> {
    value.unwrap_or_default().split(',').map(|v| crate::js::trim(v).to_owned()).filter(|v| !v.is_empty()).collect()
}

/// Every `.jsonl` file under `dir`, depth first, in the order Node lists entries. Symlinks are not followed.
///
/// # Errors
///
/// When a directory cannot be listed.
pub fn list_jsonl_files(dir: &Path) -> io::Result<Vec<PathBuf>> {
    let mut entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries.collect::<io::Result<Vec<_>>>()?,
        Err(error) if is_missing_path(&error) => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    // Entry order matters: Claude dedup is first-file-wins.
    entries.sort_by(|a, b| entry_order(&a.file_name(), &b.file_name()));
    let mut files = Vec::new();
    for entry in entries {
        let kind = entry.file_type()?;
        let path = entry.path();
        if kind.is_dir() {
            files.extend(list_jsonl_files(&path)?);
        } else if kind.is_file() && entry.file_name().to_string_lossy().ends_with(".jsonl") {
            files.push(path);
        }
    }
    Ok(files)
}

/// libuv sorts with `strcmp` on Unix; NTFS returns names case-insensitively ordered.
#[must_use]
pub fn entry_order(a: &std::ffi::OsStr, b: &std::ffi::OsStr) -> std::cmp::Ordering {
    if cfg!(windows) {
        a.to_string_lossy().to_uppercase().cmp(&b.to_string_lossy().to_uppercase())
    } else {
        a.as_encoded_bytes().cmp(b.as_encoded_bytes())
    }
}

/// Every `.jsonl` file under `roots`, de-duplicated by real location: overlapping roots would double tokens.
///
/// The listed path is kept, since macOS resolves `/var` to `/private/var` and cache keys would change.
///
/// # Errors
///
/// When a directory cannot be listed.
pub fn list_unique_source_files(roots: &[PathBuf]) -> io::Result<Vec<PathBuf>> {
    let mut seen = HashSet::new();
    let mut files = Vec::new();
    for root in roots {
        let real_root = std::fs::canonicalize(root).unwrap_or_else(|_| root.clone());
        for file in list_jsonl_files(root)? {
            let identity = real_root.join(file.strip_prefix(root).unwrap_or(&file));
            if seen.insert(identity) {
                files.push(file);
            }
        }
    }
    Ok(files)
}

/// Claude Code config directories, highest priority first. With `override_only`, only the one
/// `CLAUDE_CONFIG_DIR` names: the tool reads nothing else, so a login found elsewhere is another account's.
#[must_use]
pub fn claude_home_dirs(env: &Env, override_only: bool) -> Vec<PathBuf> {
    let config_dir = env.var("CLAUDE_CONFIG_DIR").map(PathBuf::from);
    if let Some(dir) = &config_dir
        && override_only
    {
        return vec![dir.clone()];
    }
    let xdg = env.var("XDG_CONFIG_HOME").map(|xdg| Path::new(xdg).join("claude"));
    config_dir
        .into_iter()
        .chain(xdg)
        .chain([env.home().join(".config").join("claude"), env.home().join(".claude")])
        .collect()
}

/// Codex home directories, highest priority first.
#[must_use]
pub fn codex_home_dirs(env: &Env, override_only: bool) -> Vec<PathBuf> {
    let codex_home = env.var("CODEX_HOME").map(PathBuf::from);
    if let Some(dir) = &codex_home
        && override_only
    {
        return vec![dir.clone()];
    }
    codex_home.into_iter().chain([env.home().join(".codex"), env.home().join(".config").join("codex")]).collect()
}

/// Env roots, then config roots, then defaults, de-duplicated as written and made absolute.
#[must_use]
pub fn resolve_source_roots(env_value: Option<&str>, config_value: Option<&str>, defaults: &[PathBuf]) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    let configured =
        split_configured_paths(env_value).into_iter().chain(split_configured_paths(config_value)).map(PathBuf::from);
    configured
        .chain(defaults.iter().cloned())
        .filter(|path| seen.insert(path.clone()))
        .map(|path| absolute(&path))
        .collect()
}

/// `path.resolve`: absolute against the working directory, with `.` and `..` folded lexically.
#[must_use]
pub fn absolute(path: &Path) -> PathBuf {
    let joined =
        if path.is_absolute() { path.to_owned() } else { std::env::current_dir().unwrap_or_default().join(path) };
    let mut out = PathBuf::new();
    for component in joined.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_jsonl_files_in_byte_order_without_following_symlinks() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        for file in ["b.jsonl", "a/z.jsonl", "a/B.jsonl", "a.jsonl", "_.jsonl", "notes.txt", "c/d/e.jsonl"] {
            let path = root.join(file);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, "").unwrap();
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(root.join("c"), root.join("link")).unwrap();
        let names: Vec<String> = list_jsonl_files(root)
            .unwrap()
            .iter()
            .map(|p| p.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/"))
            .collect();
        let mut expected = vec!["_.jsonl", "a/B.jsonl", "a/z.jsonl", "a.jsonl", "b.jsonl", "c/d/e.jsonl"];
        if cfg!(windows) {
            expected.rotate_left(1); // Upper-cased, `_` sorts after the letters.
        }
        assert_eq!(names, expected);
        assert!(list_jsonl_files(&root.join("missing")).unwrap().is_empty());
        assert!(list_jsonl_files(&root.join("b.jsonl")).unwrap().is_empty());
        let overlapping = [root.to_owned(), root.join("a"), root.join("a")];
        assert_eq!(list_unique_source_files(&overlapping).unwrap().len(), 6);
    }

    #[test]
    fn orders_roots_env_first_and_resolves_them() {
        let roots = resolve_source_roots(Some(" /x , ,/y/../z"), Some("/x,/w/."), &[PathBuf::from("/d")]);
        assert_eq!(roots, ["/x", "/z", "/w", "/d"].map(|p| absolute(Path::new(p))));
        let env = Env::new("/home/me", [("CLAUDE_CONFIG_DIR", "/cfg"), ("XDG_CONFIG_HOME", "/xdg")]);
        assert_eq!(
            claude_home_dirs(&env, false),
            ["/cfg", "/xdg/claude", "/home/me/.config/claude", "/home/me/.claude"].map(PathBuf::from)
        );
        assert_eq!(claude_home_dirs(&env, true), [PathBuf::from("/cfg")]);
        assert_eq!(
            codex_home_dirs(&Env::new("/h", Vec::<(String, String)>::new()), true),
            ["/h/.codex", "/h/.config/codex"].map(PathBuf::from)
        );
    }
}
