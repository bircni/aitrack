//! Reading Cursor auth credentials from state.vscdb.

use rusqlite::{Connection, OpenFlags};
use std::error::Error;
use std::fs;
use std::path::Path;

#[derive(Debug, Clone)]
pub struct CursorAuthState {
    pub access_token: Option<String>,
    pub refresh_token: Option<String>,
}

fn normalize_cursor_database_value(value: Option<Vec<u8>>) -> Option<String> {
    value.and_then(|bytes| {
        let s = String::from_utf8_lossy(&bytes);
        let trimmed = s.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn read_cursor_auth_state_from_database(database_path: &Path) -> anyhow::Result<CursorAuthState> {
    let conn = Connection::open_with_flags(database_path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;

    let access_token = conn
        .query_row(
            "SELECT value FROM ItemTable WHERE key = ? LIMIT 1",
            ["cursorAuth/accessToken"],
            |row| row.get::<_, Vec<u8>>(0),
        )
        .ok();

    let refresh_token = conn
        .query_row(
            "SELECT value FROM ItemTable WHERE key = ? LIMIT 1",
            ["cursorAuth/refreshToken"],
            |row| row.get::<_, Vec<u8>>(0),
        )
        .ok();

    Ok(CursorAuthState {
        access_token: normalize_cursor_database_value(access_token),
        refresh_token: normalize_cursor_database_value(refresh_token),
    })
}

fn is_sqlite_locked_error(error: &dyn Error) -> bool {
    error
        .to_string()
        .to_lowercase()
        .contains("database is locked")
}

async fn with_cursor_state_snapshot<T, F>(database_path: &Path, callback: F) -> anyhow::Result<T>
where
    F: FnOnce(&Path) -> anyhow::Result<T>,
{
    let temp_dir = tempfile::Builder::new()
        .prefix("aitrack-cursor-")
        .tempdir()?;
    let snapshot_path = temp_dir.path().join("state.vscdb");

    fs::copy(database_path, &snapshot_path)?;

    // Copy WAL and SHM files if they exist
    for suffix in &["-shm", "-wal"] {
        let companion_path = format!("{}{}", database_path.display(), suffix);
        if Path::new(&companion_path).exists() {
            let snapshot_companion = format!("{}{}", snapshot_path.display(), suffix);
            let _ = fs::copy(&companion_path, &snapshot_companion);
        }
    }

    callback(&snapshot_path)
}

pub async fn read_cursor_auth_state(database_path: &Path) -> anyhow::Result<CursorAuthState> {
    match read_cursor_auth_state_from_database(database_path) {
        Ok(state) => Ok(state),
        Err(err) if is_sqlite_locked_error(err.as_ref()) => {
            with_cursor_state_snapshot(database_path, |snapshot_path| {
                read_cursor_auth_state_from_database(snapshot_path)
            })
            .await
        }
        Err(err) => Err(err),
    }
}
