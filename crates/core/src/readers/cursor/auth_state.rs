use std::path::Path;

use rusqlite::{Connection, OpenFlags};

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CursorAuthState {
    pub access_token: Option<String>,
}

fn read_from(path: &Path) -> rusqlite::Result<CursorAuthState> {
    let database =
        Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
    let value: Option<rusqlite::types::Value> = database
        .query_row("SELECT value FROM ItemTable WHERE key = ? LIMIT 1", ["cursorAuth/accessToken"], |row| row.get(0))
        .map(Some)
        .or_else(|error| if matches!(error, rusqlite::Error::QueryReturnedNoRows) { Ok(None) } else { Err(error) })?;
    let text = match value {
        Some(rusqlite::types::Value::Text(text)) => Some(text),
        Some(rusqlite::types::Value::Blob(bytes)) => Some(String::from_utf8_lossy(&bytes).into_owned()),
        _ => None,
    };
    Ok(CursorAuthState { access_token: text.map(|t| crate::js::trim(&t).to_owned()).filter(|t| !t.is_empty()) })
}

fn is_locked(error: &rusqlite::Error) -> bool {
    error.to_string().to_lowercase().contains("database is locked")
}

/// A consistent copy: the backup API includes the WAL, so a read while Cursor writes is not a torn copy.
/// If it is still locked, the files beside it are copied instead.
fn snapshot(path: &Path, target: &Path) -> Result<(), String> {
    let backup = || -> rusqlite::Result<()> {
        let source = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let mut destination = Connection::open(target)?;
        rusqlite::backup::Backup::new(&source, &mut destination)?.run_to_completion(
            256,
            std::time::Duration::ZERO,
            None,
        )
    };
    match backup() {
        Ok(()) => Ok(()),
        Err(error) if is_locked(&error) => {
            std::fs::copy(path, target).map_err(|e| e.to_string())?;
            for suffix in ["-shm", "-wal"] {
                let companion = std::path::PathBuf::from(format!("{}{suffix}", path.display()));
                if companion.exists() {
                    std::fs::copy(&companion, format!("{}{suffix}", target.display())).map_err(|e| e.to_string())?;
                }
            }
            Ok(())
        }
        Err(error) => Err(error.to_string()),
    }
}

/// The login Cursor saved in `state.vscdb`, read from a snapshot when Cursor holds the database locked.
///
/// # Errors
///
/// With the message to show when the database cannot be read.
pub fn read_cursor_auth_state(path: &Path) -> Result<CursorAuthState, String> {
    match read_from(path) {
        Ok(state) => Ok(state),
        Err(error) if is_locked(&error) => {
            let dir = std::env::temp_dir().join(format!(
                "aitrack-cursor-{}-{}",
                std::process::id(),
                crate::time::iso_millis(jiff::Timestamp::now()).replace(':', "")
            ));
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let copy = dir.join("state.vscdb");
            let result = snapshot(path, &copy).and_then(|()| read_from(&copy).map_err(|e| e.to_string()));
            let _ = std::fs::remove_dir_all(&dir);
            result
        }
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_token_as_text_or_blob_and_tolerates_its_absence() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.vscdb");
        let db = Connection::open(&path).unwrap();
        db.execute_batch(
            "PRAGMA journal_mode=WAL; CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);",
        )
        .unwrap();
        assert_eq!(read_cursor_auth_state(&path).unwrap(), CursorAuthState::default());
        db.execute("INSERT INTO ItemTable VALUES ('cursorAuth/accessToken', ?)", [" tok "]).unwrap();
        assert_eq!(read_cursor_auth_state(&path).unwrap().access_token.as_deref(), Some("tok"));
        db.execute("INSERT INTO ItemTable VALUES ('cursorAuth/accessToken', ?)", [b"blob".to_vec()]).unwrap();
        assert_eq!(read_cursor_auth_state(&path).unwrap().access_token.as_deref(), Some("blob"));
        let locked = Connection::open(&path).unwrap();
        locked.execute_batch("BEGIN EXCLUSIVE; INSERT INTO ItemTable VALUES ('x', 'y');").unwrap();
        assert_eq!(
            read_cursor_auth_state(&path).unwrap().access_token.as_deref(),
            Some("blob"),
            "read past an exclusive lock"
        );
        read_cursor_auth_state(&dir.path().join("missing.vscdb")).unwrap_err();
    }
}
