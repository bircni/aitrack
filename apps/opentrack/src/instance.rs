//! One opentrack at a time: a lock in the data dir, and a loopback port a second launch uses to bring
//! the first one forward instead of starting.

use std::fs::File;
use std::io::{BufRead, BufReader, Write};
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use aitrack_core::fs::write_file_atomic;

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

/// What a later launch asks of the running one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Request {
    Show,
    Settings,
}

impl Request {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Show => "show",
            Self::Settings => "settings",
        }
    }

    fn parse(text: &str) -> Option<Self> {
        [Self::Show, Self::Settings].into_iter().find(|request| request.as_str() == text)
    }
}

/// The running instance's line in: only a launch that read the token from the data dir is heard.
pub struct Listener {
    listener: TcpListener,
    token: String,
}

/// The lock this instance holds, until it exits or hands over to an updated copy.
static LOCK: Mutex<Option<File>> = Mutex::new(None);

/// Lets an updated copy start as the only opentrack while this one finishes exiting.
pub fn release() {
    LOCK.lock().unwrap_or_else(PoisonError::into_inner).take();
}

/// The listener when this is the only opentrack; `None` after asking the running one for `request`.
pub fn claim(dir: &Path, request: Request) -> std::io::Result<Option<Listener>> {
    std::fs::create_dir_all(dir)?;
    let lock = File::options().create(true).truncate(false).write(true).open(dir.join("opentrack.lock"))?;
    let port_file = dir.join("opentrack.port");
    if lock.try_lock().is_err() {
        ask(&port_file, request);
        return Ok(None);
    }
    *LOCK.lock().unwrap_or_else(PoisonError::into_inner) = Some(lock);
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    let mut secret = [0u8; 16];
    getrandom::fill(&mut secret).map_err(std::io::Error::other)?;
    let token = aitrack_core::hex(&secret);
    write_file_atomic(&port_file, format!("{} {token}", listener.local_addr()?.port()), Some(0o600))?;
    Ok(Some(Listener { listener, token }))
}

/// A port file without a token is from a build before tokens, which took the bare request.
fn ask(port_file: &Path, request: Request) {
    let Ok(text) = std::fs::read_to_string(port_file) else { return };
    let text = text.trim();
    let (port, line) = match text.split_once(' ') {
        Some((port, token)) => (port, format!("{token} {}\n", request.as_str())),
        None => (text, format!("{}\n", request.as_str())),
    };
    let Ok(port) = port.parse::<u16>() else { return };
    if let Ok(mut stream) = TcpStream::connect_timeout(&(Ipv4Addr::LOCALHOST, port).into(), Duration::from_secs(2)) {
        let _ = stream.write_all(line.as_bytes());
    }
}

/// Calls `on_request` for every later launch; anything else that connects is ignored.
pub fn listen(Listener { listener, token }: Listener, on_request: impl Fn(Request) + Send + 'static) {
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
            let mut line = String::new();
            if BufReader::new(stream).read_line(&mut line).is_err() {
                continue;
            }
            let request = line.trim().split_once(' ').filter(|(t, _)| *t == token).and_then(|(_, r)| Request::parse(r));
            if let Some(request) = request {
                on_request(request);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;

    use super::*;

    /// One test, as the lock is held process-wide.
    #[test]
    fn a_second_launch_asks_the_first_and_an_update_hands_the_lock_over() {
        let dir = tempfile::tempdir().unwrap();
        let listener = claim(dir.path(), Request::Show).unwrap().expect("first launch");
        let port = listener.listener.local_addr().unwrap().port();
        let (tx, rx) = mpsc::channel();
        listen(listener, move |request| tx.send(request).unwrap());
        let mut stranger = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).unwrap();
        stranger.write_all(b"GET / HTTP/1.1\r\n").unwrap();
        drop(stranger);
        let second = File::options().write(true).open(dir.path().join("opentrack.lock")).unwrap();
        assert!(second.try_lock().is_err());
        ask(&dir.path().join("opentrack.port"), Request::Settings);
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap(), Request::Settings);
        rx.try_recv().unwrap_err();
        release();
        second.try_lock().unwrap();
    }
}
