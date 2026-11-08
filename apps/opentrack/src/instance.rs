//! One opentrack at a time: a lock in the data dir, and a loopback port a second launch uses to bring
//! the first one forward instead of starting.

use std::fs::File;
use std::hash::{BuildHasher, RandomState};
use std::io::{BufRead, BufReader, Write};
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const ID: &str = "dev.bircni.opentrack";
/// How long a relaunched copy waits for the one that installed it to exit.
const RELAUNCH_WAIT: Duration = Duration::from_secs(10);

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
    fn as_str(self) -> &'static str {
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

/// The listener when this is the only opentrack, which then holds the lock until it exits; `None`
/// after asking the running one for `request`. `relaunch` waits for an updating predecessor to exit.
pub fn claim(dir: &Path, request: Request, relaunch: bool) -> std::io::Result<Option<Listener>> {
    std::fs::create_dir_all(dir)?;
    let lock = File::options().create(true).truncate(false).write(true).open(dir.join("opentrack.lock"))?;
    let port_file = dir.join("opentrack.port");
    let deadline = Instant::now() + if relaunch { RELAUNCH_WAIT } else { Duration::ZERO };
    while lock.try_lock().is_err() {
        if Instant::now() >= deadline {
            ask(&port_file, request);
            return Ok(None);
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    std::mem::forget(lock); // Held until the process exits.
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    let token = format!("{:016x}{:016x}", RandomState::new().hash_one(0), RandomState::new().hash_one(1));
    std::fs::write(&port_file, format!("{} {token}", listener.local_addr()?.port()))?;
    Ok(Some(Listener { listener, token }))
}

fn ask(port_file: &Path, request: Request) {
    let Ok(text) = std::fs::read_to_string(port_file) else { return };
    let Some((port, token)) = text.trim().split_once(' ') else { return };
    let Ok(port) = port.parse::<u16>() else { return };
    if let Ok(mut stream) = TcpStream::connect_timeout(&(Ipv4Addr::LOCALHOST, port).into(), Duration::from_secs(2)) {
        let _ = stream.write_all(format!("{token} {}\n", request.as_str()).as_bytes());
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

    #[test]
    fn a_second_launch_asks_the_first_to_show_and_strangers_are_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let listener = claim(dir.path(), Request::Show, false).unwrap().expect("first launch");
        let port = listener.listener.local_addr().unwrap().port();
        let (tx, rx) = mpsc::channel();
        listen(listener, move |request| tx.send(request).unwrap());
        let mut stranger = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).unwrap();
        stranger.write_all(b"GET / HTTP/1.1\r\n").unwrap();
        drop(stranger);
        assert!(claim(dir.path(), Request::Settings, false).unwrap().is_none());
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap(), Request::Settings);
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn a_relaunch_waits_for_the_previous_copy_to_let_go() {
        let dir = tempfile::tempdir().unwrap();
        let held = File::options().create(true).truncate(false).write(true).open(dir.path().join("opentrack.lock"));
        let held = held.unwrap();
        held.lock().unwrap();
        let release = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            drop(held);
        });
        assert!(claim(dir.path(), Request::Show, true).unwrap().is_some());
        release.join().unwrap();
    }
}
