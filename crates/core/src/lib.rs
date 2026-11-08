//! Usage readers, pricing, data repo sync and live limits shared by the aitrack CLI and opentrack.

pub mod config;
pub mod data;
pub mod day;
pub mod env;
pub mod fs;
pub mod http;
pub mod js;
pub mod machine_id;
pub mod output;
pub mod pricing;
pub mod process;
pub mod readers;
pub mod store;
pub mod time;

use std::collections::HashSet;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::config::{Config, ConfigLoad};
use crate::env::{Env, Paths};
use crate::output::Output;
use crate::store::validate::Diagnostic;
use crate::time::Clock;

/// Lower-case hex, as `digest('hex')` writes it.
pub(crate) fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    bytes.iter().fold(String::with_capacity(bytes.len() * 2), |mut out, b| {
        let _ = write!(out, "{b:02x}");
        out
    })
}

/// Keys the parse caches, so one written by another version is discarded.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Everything the core reads from outside: environment, clock and output.
///
/// The CLI builds one per run; the desktop app keeps one for its lifetime, so state that 4.x kept in
/// module globals (caches, retry windows, warnings already shown) lives here.
pub struct Core {
    pub env: Env,
    pub paths: Paths,
    pub clock: Clock,
    pub output: Box<dyn Output>,
    warned_invalid_config: AtomicBool,
    /// Other machines' files cannot self-heal, so their dropped days are reported once per file.
    warned_files: Mutex<HashSet<String>>,
}

impl Core {
    #[must_use]
    pub fn new(env: Env, clock: Clock, output: Box<dyn Output>) -> Self {
        Self {
            paths: env.paths(),
            env,
            clock,
            output,
            warned_invalid_config: AtomicBool::new(false),
            warned_files: Mutex::default(),
        }
    }

    /// Warns about what reading a machine file found: every skipped file, other findings once per file.
    pub fn report_diagnostics(&self, diagnostics: &[Diagnostic]) {
        for diagnostic in diagnostics {
            if !matches!(diagnostic, Diagnostic::FileSkipped { .. })
                && !self.warned_files.lock().expect("not poisoned").insert(diagnostic.file().to_owned())
            {
                continue;
            }
            self.output.warn(&diagnostic.to_string());
        }
    }

    /// The config, or `None` when there is none; a report still renders without it, but it
    /// undercounts, so an invalid one is reported once.
    pub fn try_load_config(&self) -> Option<Config> {
        match config::read_config(&self.paths.config) {
            ConfigLoad::Ok(config) => Some(config),
            ConfigLoad::Missing => None,
            ConfigLoad::Invalid { reason } => {
                if !self.warned_invalid_config.swap(true, Ordering::Relaxed) {
                    let message = config::invalid_config_message(&self.paths.config, &reason);
                    self.output.warn(&format!("{message} Ignoring it for now."));
                }
                None
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::output::{Level, VecOutput};

    struct Shared(Arc<VecOutput>);

    impl Output for Shared {
        fn info(&self, message: &str) {
            self.0.info(message);
        }
        fn warn(&self, message: &str) {
            self.0.warn(message);
        }
        fn error(&self, message: &str) {
            self.0.error(message);
        }
    }

    #[test]
    fn warns_about_an_invalid_config_once() {
        let home = tempfile::tempdir().unwrap();
        let output = Arc::new(VecOutput::default());
        let core = Core::new(
            Env::new(home.path(), Vec::<(String, String)>::new()),
            Clock::system(),
            Box::new(Shared(output.clone())),
        );
        std::fs::create_dir_all(&core.paths.app_dir).unwrap();
        std::fs::write(&core.paths.config, "{}").unwrap();
        assert_eq!(core.try_load_config(), None);
        assert_eq!(core.try_load_config(), None);
        let messages = output.messages();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].0, Level::Warn);
        assert!(
            messages[0]
                .1
                .ends_with("is missing or malformed fields. Fix it or re-run: npx aitrack init Ignoring it for now.")
        );
    }
}
