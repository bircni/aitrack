use crate::Locked;
use std::sync::Mutex;

/// Where progress, warnings and failures go; the CLI prints them, the desktop app logs them.
pub trait Output: Send + Sync {
    /// Progress and results; dropped when quiet.
    fn info(&self, message: &str);
    /// Recoverable problems; never dropped.
    fn warn(&self, message: &str);
    /// Failures; never dropped.
    fn error(&self, message: &str);
}

/// Prints to the terminal. With `info_to_stderr`, stdout carries only a `--json` document.
#[derive(Clone, Copy, Debug, Default)]
pub struct StdOutput {
    pub quiet: bool,
    pub info_to_stderr: bool,
}

impl Output for StdOutput {
    fn info(&self, message: &str) {
        if self.quiet {
            return;
        }
        if self.info_to_stderr {
            eprintln!("{message}");
        } else {
            println!("{message}");
        }
    }

    fn warn(&self, message: &str) {
        eprintln!("{message}");
    }

    fn error(&self, message: &str) {
        eprintln!("{message}");
    }
}

/// Collects messages, for tests.
#[derive(Debug, Default)]
pub struct VecOutput(Mutex<Vec<(Level, String)>>);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Level {
    Info,
    Warn,
    Error,
}

impl VecOutput {
    #[must_use]
    pub fn messages(&self) -> Vec<(Level, String)> {
        self.0.locked().clone()
    }

    fn push(&self, level: Level, message: &str) {
        self.0.locked().push((level, message.to_owned()));
    }
}

impl Output for VecOutput {
    fn info(&self, message: &str) {
        self.push(Level::Info, message);
    }

    fn warn(&self, message: &str) {
        self.push(Level::Warn, message);
    }

    fn error(&self, message: &str) {
        self.push(Level::Error, message);
    }
}
