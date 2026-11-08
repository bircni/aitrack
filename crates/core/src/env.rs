use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::js;

/// The process environment, captured once at the entry point so the rest of the core never reads globals.
#[derive(Clone, Debug)]
pub struct Env {
    home: PathBuf,
    vars: HashMap<String, String>,
}

impl Env {
    #[must_use]
    pub fn from_process() -> Self {
        Self { home: std::env::home_dir().unwrap_or_default(), vars: std::env::vars().collect() }
    }

    /// An isolated environment for tests and embedders.
    pub fn new<K: Into<String>, V: Into<String>>(
        home: impl Into<PathBuf>,
        vars: impl IntoIterator<Item = (K, V)>,
    ) -> Self {
        Self { home: home.into(), vars: vars.into_iter().map(|(k, v)| (k.into(), v.into())).collect() }
    }

    #[must_use]
    pub fn home(&self) -> &Path {
        &self.home
    }

    /// A variable's trimmed value; one set to whitespace counts as unset.
    #[must_use]
    pub fn var(&self, name: &str) -> Option<&str> {
        self.vars.get(name).map(|value| js::trim(value)).filter(|value| !value.is_empty())
    }

    /// A variable exactly as set, for values where whitespace is meaningful, such as the encryption passphrase.
    #[must_use]
    pub fn raw_var(&self, name: &str) -> Option<&str> {
        self.vars.get(name).map(String::as_str)
    }

    #[must_use]
    pub fn paths(&self) -> Paths {
        Paths::under(&self.home)
    }
}

/// Where aitrack keeps its state: `~/.config/aitrack` on every platform.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Paths {
    pub app_dir: PathBuf,
    pub config: PathBuf,
    /// Clone of the user's data repo.
    pub repo: PathBuf,
    /// Machine files inside the clone.
    pub data: PathBuf,
    /// Machine files written while the repo was unavailable.
    pub pending_data: PathBuf,
    /// Parsed-transcript cache, keyed by source mtime and size.
    pub cache: PathBuf,
}

impl Paths {
    #[must_use]
    pub fn under(home: &Path) -> Self {
        let app_dir = home.join(".config").join("aitrack");
        let repo = app_dir.join("repo");
        Self {
            config: app_dir.join("config.json"),
            data: repo.join("data"),
            pending_data: app_dir.join("pending").join("data"),
            cache: app_dir.join("cache"),
            repo,
            app_dir,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Env;

    #[test]
    fn treats_blank_variables_as_unset_but_keeps_raw_values() {
        let env = Env::new("/home/me", [("A", "  value \n"), ("BLANK", " \t"), ("PASS", " secret ")]);
        assert_eq!(env.var("A"), Some("value"));
        assert_eq!(env.var("BLANK"), None);
        assert_eq!(env.var("MISSING"), None);
        assert_eq!(env.raw_var("PASS"), Some(" secret "));
        assert!(env.paths().data.ends_with(".config/aitrack/repo/data"));
    }
}
