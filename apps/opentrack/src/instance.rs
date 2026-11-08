//! One opentrack at a time: a lock in the data dir, and a loopback port a second launch uses to bring
//! the first one forward instead of starting.

use std::fs::File;
use std::io::{BufRead, BufReader, Write};
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

const ID: &str = "dev.bircni.opentrack";

/// Where Tauri kept settings.json and cache.json for this identifier, so 4.x data carries over.
pub fn data_dir() -> PathBuf {
    let home = std::env::home_dir().unwrap_or_default();
    if cfg!(target_os = "macos") {
        home.join("Library").join("Application Support").join(ID)
    } else if cfg!(windows) {
        std::env::var_os("APPDATA").map_or_else(|| home.join("AppData").join("Roaming"), PathBuf::from).join(ID)
    } else {
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .filter(|dir| dir.is_absolute())
            .unwrap_or_else(|| home.join(".local").join("share"))
            .join(ID)
    }
}

pub enum Instance {
    /// This is the only one; the lock is held for as long as the value lives.
    First { _lock: File, listener: TcpListener },
    /// Another one runs and was asked to show itself.
    Second,
}

/// `request` is what a second launch asks of the first: `show` or `settings`.
pub fn claim(dir: &Path, request: &str) -> std::io::Result<Instance> {
    std::fs::create_dir_all(dir)?;
    let lock = File::options().create(true).truncate(false).write(true).open(dir.join("opentrack.lock"))?;
    let port_file = dir.join("opentrack.port");
    if lock.try_lock().is_err() {
        if let Some(port) = std::fs::read_to_string(&port_file).ok().and_then(|text| text.trim().parse::<u16>().ok()) {
            let address = (Ipv4Addr::LOCALHOST, port).into();
            if let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_secs(2)) {
                let _ = stream.write_all(format!("{request}\n").as_bytes());
            }
        }
        return Ok(Instance::Second);
    }
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    std::fs::write(&port_file, listener.local_addr()?.port().to_string())?;
    Ok(Instance::First { _lock: lock, listener })
}

/// Calls `on_request` with what every later launch asks for.
pub fn listen(listener: TcpListener, on_request: impl Fn(&str) + Send + 'static) {
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
            let mut line = String::new();
            if BufReader::new(stream).read_line(&mut line).is_ok() {
                on_request(line.trim());
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;

    use super::*;

    #[test]
    fn a_second_launch_asks_the_first_to_show_and_stands_down() {
        let dir = tempfile::tempdir().unwrap();
        let Instance::First { _lock, listener } = claim(dir.path(), "show").unwrap() else { panic!("first launch") };
        let (tx, rx) = mpsc::channel();
        listen(listener, move |request| tx.send(request.to_owned()).unwrap());
        assert!(matches!(claim(dir.path(), "settings").unwrap(), Instance::Second));
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap(), "settings");
    }
}
