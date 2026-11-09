//! Terminal colour as chalk applies it, so styled output matches 4.x byte for byte.

use std::io::IsTerminal;
use std::sync::OnceLock;

use crate::env::Env;

/// SGR open/close pairs, outermost first.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Style(&'static [(u8, u8)]);

pub const BOLD: Style = Style(&[(1, 22)]);
pub const DIM: Style = Style(&[(2, 22)]);
pub const RED: Style = Style(&[(31, 39)]);
pub const GREEN: Style = Style(&[(32, 39)]);
pub const YELLOW: Style = Style(&[(33, 39)]);
pub const CYAN: Style = Style(&[(36, 39)]);
pub const WHITE: Style = Style(&[(37, 39)]);
pub const GRAY: Style = Style(&[(90, 39)]);
pub const BOLD_CYAN: Style = Style(&[(1, 22), (36, 39)]);
pub const BOLD_WHITE: Style = Style(&[(1, 22), (37, 39)]);

fn sgr(code: u8) -> String {
    format!("\x1b[{code}m")
}

impl Style {
    /// `chalk.<style>(text)`: a nested close re-opens this style, and each line break is closed and re-opened.
    #[must_use]
    pub fn paint(self, text: &str, enabled: bool) -> String {
        if !enabled || text.is_empty() {
            return text.to_owned();
        }
        let mut text = text.to_owned();
        if text.contains('\x1b') {
            for &(open, close) in self.0.iter().rev() {
                text = text.replace(&sgr(close), &(sgr(close) + &sgr(open)));
            }
        }
        let open_all: String = self.0.iter().map(|&(open, _)| sgr(open)).collect();
        let close_all: String = self.0.iter().rev().map(|&(_, close)| sgr(close)).collect();
        if text.contains('\n') {
            let mut out = String::with_capacity(text.len());
            let mut lines = text.split('\n').peekable();
            while let Some(line) = lines.next() {
                if lines.peek().is_none() {
                    out.push_str(line);
                } else {
                    let (line, eol) = line.strip_suffix('\r').map_or((line, "\n"), |l| (l, "\r\n"));
                    out.push_str(line);
                    out.push_str(&close_all);
                    out.push_str(eol);
                    out.push_str(&open_all);
                }
            }
            text = out;
        }
        format!("{open_all}{text}{close_all}")
    }
}

/// Whether chalk would colour a stream: `FORCE_COLOR` wins, then `NO_COLOR`, then the TTY and terminal sniffing.
#[must_use]
pub fn color_supported(env: &Env, is_tty: bool, windows: bool) -> bool {
    let var = |name: &str| env.raw_var(name);
    let numeric = |v: &str| !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit());
    match var("FORCE_COLOR") {
        Some("false") => return false,
        Some(v) if numeric(v) => return v.bytes().any(|b| b != b'0'),
        Some("true" | "") => return true,
        _ => {}
    }
    if var("NO_COLOR").is_some_and(|v| !v.is_empty()) {
        return false;
    }
    if var("TF_BUILD").is_some() && var("AGENT_NAME").is_some() {
        return true;
    }
    let term = var("TERM").unwrap_or("").to_ascii_lowercase();
    if !is_tty || term == "dumb" {
        return false;
    }
    if windows {
        return true;
    }
    if var("CI").is_some() {
        return [
            "GITHUB_ACTIONS",
            "GITEA_ACTIONS",
            "CIRCLECI",
            "TRAVIS",
            "APPVEYOR",
            "GITLAB_CI",
            "BUILDKITE",
            "DRONE",
        ]
        .iter()
        .any(|k| var(k).is_some())
            || var("CI_NAME") == Some("codeship");
    }
    if let Some(version) = var("TEAMCITY_VERSION") {
        let mut parts = version.split('.');
        let (major, minor, more) = (parts.next().unwrap_or(""), parts.next(), parts.next().is_some());
        return (major == "9" && more && minor.is_some_and(|m| numeric(m) && m.bytes().any(|b| b != b'0')))
            || (major.len() >= 2 && numeric(major) && minor.is_some());
    }
    var("COLORTERM").is_some()
        || matches!(var("TERM_PROGRAM"), Some("iTerm.app" | "Apple_Terminal"))
        || ["screen", "xterm", "vt100", "vt220", "rxvt"].iter().any(|p| term.starts_with(p))
        || ["color", "ansi", "cygwin", "linux"].iter().any(|p| term.contains(p))
}

/// Colour for stdout, decided once per process.
pub fn enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| color_supported(&Env::from_process(), std::io::stdout().is_terminal(), cfg!(windows)))
}

#[must_use]
pub fn bold(text: &str) -> String {
    BOLD.paint(text, enabled())
}

#[must_use]
pub fn dim(text: &str) -> String {
    DIM.paint(text, enabled())
}

#[must_use]
pub fn red(text: &str) -> String {
    RED.paint(text, enabled())
}

#[must_use]
pub fn green(text: &str) -> String {
    GREEN.paint(text, enabled())
}

#[must_use]
pub fn yellow(text: &str) -> String {
    YELLOW.paint(text, enabled())
}

#[must_use]
pub fn cyan(text: &str) -> String {
    CYAN.paint(text, enabled())
}

#[must_use]
pub fn bold_cyan(text: &str) -> String {
    BOLD_CYAN.paint(text, enabled())
}
