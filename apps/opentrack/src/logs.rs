//! Exporting the app's logs as a zip for bug reports.

use std::fs::File;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use aitrack_core::time::Clock;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

use crate::app::{Bus, Msg};

const LOG_FILES: [&str; 2] = ["opentrack.log", "opentrack.log.1"];

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
    fn names_the_archive_by_local_time() {
        let clock = Clock::fixed("2026-11-16T23:30:00Z".parse().unwrap(), "Pacific/Kiritimati").unwrap();
        assert_eq!(archive_name(&clock), "opentrack-logs-2026-11-17-1330.zip");
    }
}
