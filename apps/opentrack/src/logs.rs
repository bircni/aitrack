//! The app's log, and exporting it as a zip for bug reports.

use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use aitrack_core::git::remote::redact_urls;
use aitrack_core::output::{Level, Output};
use aitrack_core::time::{iso_millis, Clock};
use aitrack_core::update::InstallTarget;
use aitrack_core::Locked;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

use crate::app::{Bus, Msg};

const LOG_FILES: [&str; 2] = ["opentrack.log", "opentrack.log.1"];
/// Each of the two files stays under this, so a failure repeated for weeks cannot fill the disk.
const MAX_LOG_BYTES: u64 = 256 * 1024;
const MAX_LINE_BYTES: usize = 2000;
const TOKEN_PREFIXES: [&str; 7] = ["sk-ant-", "eyJ", "ghp_", "gho_", "ghs_", "github_pat_", "glpat-"];
const SECRET_KEYS: [&str; 4] = ["token", "password", "passphrase", "secret"];

/// `opentrack.log` in the data dir: one line per event, as `<UTC time> <LEVEL> <topic> <what>`, with
/// credentials masked. Clones write to the same file.
#[derive(Clone)]
pub struct LogOutput(Arc<Shared>);

struct Shared {
    clock: Clock,
    home: Option<String>,
    file: Mutex<LogFile>,
}

struct LogFile {
    path: PathBuf,
    file: Option<File>,
    written: u64,
    /// The last status written per topic, so a failure repeated every poll is one line.
    statuses: HashMap<String, String>,
}

impl LogFile {
    /// Starts an empty log, keeping the one before as `opentrack.log.1`.
    fn rotate(&mut self) {
        self.file = None;
        if std::fs::rename(&self.path, self.path.with_extension("log.1")).is_err() {
            let _ = std::fs::remove_file(&self.path); // Losing it beats growing it without end.
        }
        self.open();
    }

    fn open(&mut self) {
        self.file = OpenOptions::new().create(true).append(true).open(&self.path).ok();
        self.written = self.file.as_ref().and_then(|file| file.metadata().ok()).map_or(0, |meta| meta.len());
    }

    fn append(&mut self, line: &str) {
        let bytes = line.len() as u64;
        if self.written + bytes > MAX_LOG_BYTES {
            self.rotate();
        }
        if let Some(file) = self.file.as_mut() {
            if file.write_all(line.as_bytes()).is_ok() {
                self.written += bytes;
            }
        }
    }
}

impl LogOutput {
    /// A new run's log; the last run's is kept beside it.
    pub fn open(data_dir: &Path) -> Self {
        Self::new(data_dir, Clock::system(), std::env::home_dir(), true)
    }

    /// The running instance's log, for a launch that must not take it away.
    pub fn append(data_dir: &Path) -> Self {
        Self::new(data_dir, Clock::system(), std::env::home_dir(), false)
    }

    fn new(data_dir: &Path, clock: Clock, home: Option<PathBuf>, fresh: bool) -> Self {
        let _ = std::fs::create_dir_all(data_dir);
        let mut file = LogFile { path: data_dir.join(LOG_FILES[0]), file: None, written: 0, statuses: HashMap::new() };
        if fresh {
            file.rotate();
        } else {
            file.open();
        }
        let home = home.map(|home| home.to_string_lossy().into_owned()).filter(|home| home.len() > 1);
        Self(Arc::new(Shared { clock, home, file: Mutex::new(file) }))
    }

    fn line(&self, level: Level, message: &str) -> String {
        let flat = message.lines().map(str::trim).filter(|line| !line.is_empty()).collect::<Vec<_>>().join(" | ");
        let shown = self.0.home.as_ref().map_or_else(|| flat.clone(), |home| flat.replace(home.as_str(), "~"));
        let mut text = redact(&shown);
        if text.len() > MAX_LINE_BYTES {
            let end = (0..=MAX_LINE_BYTES).rev().find(|at| text.is_char_boundary(*at)).unwrap_or(0);
            text.truncate(end);
            text.push('…');
        }
        let level = match level {
            Level::Info => "INFO ",
            Level::Warn => "WARN ",
            Level::Error => "ERROR",
        };
        format!("{} {level} {text}\n", iso_millis(self.0.clock.now()))
    }

    pub fn event(&self, level: Level, message: &str) {
        let line = self.line(level, message);
        if cfg!(all(debug_assertions, not(test))) {
            eprint!("{line}"); // `cargo dev` shows what a release only logs.
        }
        self.0.file.locked().append(&line);
    }

    /// An event only when `topic` was not already in `status`: a poll that fails the same way every
    /// minute, or works as before, is not news.
    pub fn status(&self, level: Level, topic: &str, status: &str) {
        let changed = {
            let mut file = self.0.file.locked();
            let changed = file.statuses.get(topic).is_none_or(|last| last != status);
            if changed {
                file.statuses.insert(topic.to_owned(), status.to_owned());
            }
            changed
        };
        if changed {
            self.event(level, &format!("{topic} {status}"));
        }
    }

    /// [`Self::event`] from the UI thread, which must not wait for the disk.
    pub fn later(&self, level: Level, message: String) {
        let log = self.clone();
        std::thread::spawn(move || log.event(level, &message));
    }
}

impl Output for LogOutput {
    fn info(&self, message: &str) {
        self.event(Level::Info, message);
    }
    fn warn(&self, message: &str) {
        self.event(Level::Warn, message);
    }
    fn error(&self, message: &str) {
        self.event(Level::Error, message);
    }
}

/// Masks what must not reach a bug report: credentials in URLs, bearer tokens, provider and git
/// host tokens, and the value of anything named like a secret.
fn redact(text: &str) -> String {
    let delimiter = |c: char| c.is_whitespace() || matches!(c, '\'' | '"' | '=' | ':' | ',' | ';' | '&' | '?');
    let mut redacted = String::with_capacity(text.len());
    let mut secret_next = false;
    for piece in redact_urls(text).split_inclusive(delimiter) {
        let word = piece.trim_end_matches(delimiter);
        if word.is_empty() {
            redacted.push_str(piece);
            continue;
        }
        if secret_next || TOKEN_PREFIXES.iter().any(|prefix| word.starts_with(prefix)) {
            redacted.push_str("***");
            redacted.push_str(&piece[word.len()..]);
        } else {
            redacted.push_str(piece);
        }
        let key = word.to_ascii_lowercase();
        // `token=…` and `"token":"…"` carry a value; "the token expired" does not.
        let assigned =
            piece[word.len()..].starts_with(['=', '"']) && SECRET_KEYS.iter().any(|name| key.ends_with(name));
        secret_next = key == "bearer" || assigned;
    }
    redacted
}

/// What a run's log starts with: enough to tell which build a report is about.
pub fn start_line(data_dir: &Path) -> String {
    let exe = std::env::current_exe().unwrap_or_default();
    let install = if cfg!(debug_assertions) {
        "dev"
    } else {
        match InstallTarget::running(&exe, std::env::var_os("APPIMAGE").map(PathBuf::from)) {
            Ok(InstallTarget::MacBundle(_)) => "app-bundle",
            Ok(InstallTarget::AppImage(_)) => "appimage",
            Ok(InstallTarget::WindowsInstaller) => "windows-installer",
            Err(_) if exe.starts_with("/usr") => "deb",
            Err(_) => "binary",
        }
    };
    format!(
        "start version={} os={} arch={} install={install} data_dir={}",
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        std::env::consts::ARCH,
        data_dir.display()
    )
}

/// Zips the logs found in `data_dir` into `out`, returning how many were added.
///
/// # Errors
///
/// When there is no log to export, or reading or writing fails.
pub fn write_archive(data_dir: &Path, out: &Path) -> io::Result<usize> {
    let logs: Vec<(&str, Vec<u8>)> = LOG_FILES
        .iter()
        .filter_map(|name| std::fs::read(data_dir.join(name)).ok().map(|bytes| (*name, bytes)))
        .collect();
    if logs.is_empty() {
        return Err(io::Error::new(io::ErrorKind::NotFound, format!("no logs in {}", data_dir.display())));
    }
    let result = (|| {
        let mut zip = ZipWriter::new(File::create(out)?);
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        for (name, bytes) in &logs {
            zip.start_file(*name, options)?;
            zip.write_all(bytes)?;
        }
        zip.finish()?;
        Ok(logs.len())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(out);
    }
    result.map_err(|error: zip::result::ZipError| io::Error::other(error))
}

pub fn archive_name(clock: &Clock) -> String {
    format!("opentrack-logs-{}.zip", clock.now().to_zoned(clock.zone().clone()).strftime("%Y-%m-%d-%H%M"))
}

/// Asks where to save the archive and writes it there, reporting the outcome as a notification.
pub fn export(data_dir: PathBuf, file_name: String, bus: Bus) {
    std::thread::spawn(move || {
        let dialog = rfd::AsyncFileDialog::new()
            .set_title("Export opentrack logs")
            .set_file_name(file_name)
            .add_filter("Zip archive", &["zip"]);
        let Some(handle) = pollster::block_on(dialog.save_file()) else { return };
        let out = handle.path();
        let (title, body) = match write_archive(&data_dir, out) {
            Ok(_) => ("Logs exported".to_owned(), out.display().to_string()),
            Err(error) => ("Exporting logs failed".to_owned(), error.to_string()),
        };
        bus.send(Msg::Alert { title, body });
    });
}

#[cfg(test)]
mod tests {
    use std::io::Read;

    use super::*;

    #[test]
    fn zips_the_logs_that_exist_and_fails_without_any() {
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("logs.zip");
        write_archive(dir.path(), &out).unwrap_err();
        assert!(!out.exists());

        std::fs::write(dir.path().join("opentrack.log"), "now").unwrap();
        std::fs::write(dir.path().join("opentrack.log.1"), "before").unwrap();
        assert_eq!(write_archive(dir.path(), &out).unwrap(), 2);
        let mut zip = zip::ZipArchive::new(File::open(&out).unwrap()).unwrap();
        for (name, expected) in [("opentrack.log", "now"), ("opentrack.log.1", "before")] {
            let mut text = String::new();
            zip.by_name(name).unwrap().read_to_string(&mut text).unwrap();
            assert_eq!(text, expected);
        }
    }

    #[test]
    fn stamps_masks_and_bounds_what_it_logs() {
        let dir = tempfile::tempdir().unwrap();
        let read = |name: &str| std::fs::read_to_string(dir.path().join(name)).unwrap();
        std::fs::write(dir.path().join("opentrack.log"), "last run\n").unwrap();
        let clock = Clock::fixed("2026-11-16T23:30:00Z".parse().unwrap(), "UTC").unwrap();
        let log = LogOutput::new(dir.path(), clock, Some("/home/me".into()), true);
        log.warn("could not sync: fatal: 'https://me:s3cret@host/data.git/' 403\nAuthorization: Bearer abc.def\n");
        let failed = r#"failed kind=Network: {"access_token":"tok-1"} sk-ant-oat01-x /home/me/.codex/auth.json?refresh_token=tok-2"#;
        for status in [failed, failed, "ok", "ok"] {
            log.status(Level::Warn, "quota provider=codex", status);
        }
        LogOutput::append(dir.path()).error("instance lock failed");
        let text = read("opentrack.log");
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(
            lines[..3],
            [
                "2026-11-16T23:30:00.000Z WARN  could not sync: fatal: 'https://***@host/data.git/' 403 | Authorization: Bearer ***",
                r#"2026-11-16T23:30:00.000Z WARN  quota provider=codex failed kind=Network: {"access_token":"***"} *** ~/.codex/auth.json?refresh_token=***"#,
                "2026-11-16T23:30:00.000Z WARN  quota provider=codex ok",
            ]
        );
        assert!(lines[3].ends_with("Z ERROR instance lock failed") && lines.len() == 4, "{text}");
        for secret in ["s3cret", "abc.def", "tok-1", "sk-ant", "tok-2", "/home/me"] {
            assert!(!text.contains(secret), "{secret} in {text}");
        }
        assert_eq!(read("opentrack.log.1"), "last run\n");

        for _ in 0..200 {
            log.info(&"é".repeat(MAX_LINE_BYTES));
        }
        for name in LOG_FILES {
            let size = read(name).len() as u64;
            assert!(size > MAX_LOG_BYTES / 2 && size <= MAX_LOG_BYTES, "{name}: {size}");
        }
    }

    #[test]
    fn names_the_archive_by_local_time() {
        let clock = Clock::fixed("2026-11-16T23:30:00Z".parse().unwrap(), "Pacific/Kiritimati").unwrap();
        assert_eq!(archive_name(&clock), "opentrack-logs-2026-11-17-1330.zip");
    }
}
