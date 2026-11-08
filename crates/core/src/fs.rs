use std::io;
use std::path::Path;

/// Write then rename, so a concurrent reader never sees a half-written file. `mode` applies on Unix only.
pub fn write_file_atomic(path: &Path, contents: &str, mode: Option<u32>) -> io::Result<()> {
    let mut temporary = path.as_os_str().to_owned();
    temporary.push(format!(".{}.tmp", std::process::id()));
    let temporary = Path::new(&temporary);
    let result = (|| {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        if let Some(mode) = mode {
            std::os::unix::fs::OpenOptionsExt::mode(&mut options, mode);
        }
        #[cfg(not(unix))]
        let _ = mode;
        io::Write::write_all(&mut options.open(temporary)?, contents.as_bytes())?;
        std::fs::rename(temporary, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temporary);
    }
    result
}

/// A path that is gone, or has a file where a directory was expected.
#[must_use]
pub fn is_missing_path(error: &io::Error) -> bool {
    matches!(error.kind(), io::ErrorKind::NotFound | io::ErrorKind::NotADirectory)
}

#[cfg(test)]
mod tests {
    use super::write_file_atomic;

    #[test]
    fn creates_parents_and_leaves_no_temporary_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a").join("b.json");
        write_file_atomic(&path, "one", None).unwrap();
        write_file_atomic(&path, "two", Some(0o600)).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "two");
        assert_eq!(std::fs::read_dir(path.parent().unwrap()).unwrap().count(), 1);
    }
}
