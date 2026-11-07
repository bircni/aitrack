use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::sync::{oneshot, watch};

const STOPPED: &str = "The background service stopped";
const UNRESPONSIVE: &str = "The background service did not respond";

#[derive(Clone, Copy)]
struct Timings {
    /// Every request answers at once (refresh reports progress as events), so a caller stops waiting here.
    request: Duration,
    /// Silence this long, when output is owed, is a hang: far past any stall of a working process, as a restart redoes its work.
    hang: Duration,
    min_restart: Duration,
    max_restart: Duration,
    healthy_run: Duration,
}

impl Default for Timings {
    fn default() -> Self {
        Self {
            request: Duration::from_secs(30),
            hang: Duration::from_secs(300),
            min_restart: Duration::from_secs(2),
            max_restart: Duration::from_secs(120),
            healthy_run: Duration::from_secs(60),
        }
    }
}

type Reply = Result<Value, String>;
type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Reply>>>>;

/// One line from the sidecar: the answer to a request, or an event it pushed.
#[derive(Debug, PartialEq)]
pub enum Incoming {
    Reply { id: u64, reply: Reply },
    Event { name: String, data: Value },
}

pub fn parse_line(line: &str) -> Option<Incoming> {
    let mut value: Value = serde_json::from_str(line).ok()?;
    if let Some(id) = value.get("id").and_then(Value::as_u64) {
        let reply = match value.get("error").and_then(Value::as_str) {
            Some(error) => Err(error.to_owned()),
            None => Ok(value.get_mut("result").map_or(Value::Null, Value::take)),
        };
        return Some(Incoming::Reply { id, reply });
    }
    let name = value.get("event")?.as_str()?.to_owned();
    let data = value.get_mut("data").map_or(Value::Null, Value::take);
    Some(Incoming::Event { name, data })
}

#[derive(Clone, Debug, Default, PartialEq)]
pub enum Status {
    /// A first launch or a first restart: requests wait for it.
    #[default]
    Starting,
    /// It has written to us, so it reads its input too.
    Running,
    /// It could not start or keeps dying: requests fail at once with this reason until one runs.
    Down(String),
}

impl Status {
    pub fn to_json(&self) -> Value {
        match self {
            Status::Starting => json!({ "state": "starting", "message": null }),
            Status::Running => json!({ "state": "running", "message": null }),
            Status::Down(message) => json!({ "state": "down", "message": message }),
        }
    }
}

/// The Node process that fetches limits and reads usage, restarted if it dies.
#[derive(Default)]
pub struct Sidecar {
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    child: Arc<Mutex<Option<Child>>>,
    status: watch::Sender<Status>,
    /// Since when it has owed us a line: from its start, or a request, until it next writes.
    owed_since: Arc<Mutex<Option<Instant>>>,
    pending: Pending,
    next_id: AtomicU64,
    timings: Timings,
}

impl Sidecar {
    /// Runs the process, restarting it when it dies; call once whatever the callbacks touch exists.
    pub fn supervise<E, S>(&self, program: PathBuf, data_dir: PathBuf, on_event: E, on_status: S)
    where
        E: Fn(&str, Value) + Send + 'static,
        S: Fn(&Status) + Send + 'static,
    {
        let (stdin, child, status, pending, timings) =
            (self.stdin.clone(), self.child.clone(), self.status.clone(), self.pending.clone(), self.timings);
        let owed_since = self.owed_since.clone();
        let hang_killed = Arc::new(AtomicBool::new(false));
        watch_for_hang(self.owed_since.clone(), self.child.clone(), hang_killed.clone(), timings.hang);
        let set_status = move |next: Status| {
            let changed = status.send_if_modified(|current| {
                let changed = *current != next;
                if changed {
                    current.clone_from(&next);
                }
                changed
            });
            if changed {
                on_status(&next);
            }
        };
        thread::spawn(move || {
            let mut delay = timings.min_restart;
            loop {
                let started = Instant::now();
                match start(&program, &data_dir) {
                    Ok(mut spawned) => {
                        let stdout = spawned.stdout.take();
                        *stdin.lock().unwrap() = spawned.stdin.take();
                        *owed_since.lock().unwrap() = Some(started);
                        *child.lock().unwrap() = Some(spawned);
                        if let Some(stdout) = stdout {
                            pump(stdout, &pending, &on_event, || {
                                *owed_since.lock().unwrap() = None;
                                set_status(Status::Running);
                            });
                        }
                        // Its output has ended, so a process still alive here is of no more use.
                        let ended = child.lock().unwrap().take();
                        if let Some(mut ended) = ended {
                            let _ = ended.kill();
                            let _ = ended.wait();
                        }
                        *owed_since.lock().unwrap() = None;
                        // The hang limit outlasts `healthy_run`, so without this a process hung at startup looks healthy.
                        if !hang_killed.swap(false, Ordering::Relaxed) && started.elapsed() > timings.healthy_run {
                            delay = timings.min_restart;
                        }
                        set_status(if delay > timings.min_restart {
                            let log = data_dir.join("sidecar.log");
                            Status::Down(format!("{STOPPED} repeatedly and keeps restarting. See {}", log.display()))
                        } else {
                            Status::Starting
                        });
                        *stdin.lock().unwrap() = None;
                        for (_, sender) in pending.lock().unwrap().drain() {
                            let _ = sender.send(Err(STOPPED.into()));
                        }
                    }
                    Err(error) => {
                        set_status(Status::Down(format!("The background service could not start: {error}")));
                    }
                }
                // One that dies at startup should not be relaunched every two seconds forever.
                thread::sleep(delay);
                delay = (delay * 2).min(timings.max_restart);
            }
        });
    }

    pub fn status(&self) -> Status {
        self.status.borrow().clone()
    }

    pub async fn request(&self, method: &str, params: Value) -> Reply {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let line = json!({ "id": id, "method": method, "params": params }).to_string();
        let exchange = async {
            // A request made while the process (re)starts, like the popup's first load, waits for it.
            if let Ok(status) = self.status.subscribe().wait_for(|status| *status != Status::Starting).await {
                if let Status::Down(reason) = &*status {
                    return Err(reason.clone());
                }
            }
            let (sender, receiver) = oneshot::channel();
            self.pending.lock().unwrap().insert(id, sender);
            self.owed_since.lock().unwrap().get_or_insert_with(Instant::now);
            let written = match self.stdin.lock().unwrap().as_mut() {
                Some(stdin) => writeln!(stdin, "{line}").and_then(|()| stdin.flush()).is_ok(),
                None => false,
            };
            if !written {
                return Err(STOPPED.into());
            }
            receiver.await.unwrap_or_else(|_| Err(STOPPED.into()))
        };
        let reply =
            tokio::time::timeout(self.timings.request, exchange).await.unwrap_or_else(|_| Err(UNRESPONSIVE.into()));
        self.pending.lock().unwrap().remove(&id);
        reply
    }
}

/// Killing ends its output, which sends the supervisor on to the restart.
fn watch_for_hang(
    owed_since: Arc<Mutex<Option<Instant>>>,
    child: Arc<Mutex<Option<Child>>>,
    hang_killed: Arc<AtomicBool>,
    hang: Duration,
) {
    thread::spawn(move || loop {
        thread::sleep(hang / 8);
        if owed_since.lock().unwrap().is_some_and(|since| since.elapsed() >= hang) {
            if let Some(child) = child.lock().unwrap().as_mut() {
                let _ = child.kill();
                hang_killed.store(true, Ordering::Relaxed);
            }
        }
    });
}

fn pump(stdout: ChildStdout, pending: &Pending, on_event: &impl Fn(&str, Value), on_alive: impl Fn()) {
    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        let Some(incoming) = parse_line(&line) else { continue };
        on_alive();
        match incoming {
            Incoming::Reply { id, reply } => {
                if let Some(sender) = pending.lock().unwrap().remove(&id) {
                    let _ = sender.send(reply);
                }
            }
            Incoming::Event { name, data } => on_event(&name, data),
        }
    }
}

fn start(program: &Path, data_dir: &Path) -> std::io::Result<std::process::Child> {
    std::fs::create_dir_all(data_dir)?;
    let log_path = data_dir.join("sidecar.log");
    let _ = std::fs::rename(&log_path, data_dir.join("sidecar.log.1")); // Keep the crashed run's stderr.
    let log = File::create(log_path)?;
    let mut command = Command::new(program);
    command.arg("--data-dir").arg(data_dir).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(log);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000; // No console for it or the git it runs.
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command.spawn()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_replies_errors_and_events() {
        assert_eq!(
            parse_line(r#"{"id":3,"result":{"a":1}}"#),
            Some(Incoming::Reply { id: 3, reply: Ok(json!({ "a": 1 })) })
        );
        assert_eq!(
            parse_line(r#"{"id":4,"error":"nope"}"#),
            Some(Incoming::Reply { id: 4, reply: Err("nope".into()) })
        );
        assert_eq!(
            parse_line(r#"{"event":"state","data":[1]}"#),
            Some(Incoming::Event { name: "state".into(), data: json!([1]) })
        );
        assert_eq!(parse_line("not json"), None);
        assert_eq!(parse_line(r#"{"other":true}"#), None);
    }

    #[cfg(unix)]
    mod supervision {
        use super::*;

        /// Answers each request with its own pid, so a restart shows; the other methods act up on request.
        const SCRIPT: &str = r#"#!/bin/sh
    case "$2" in
      *crash-loop*) exit 1;;
      *silent*) while read -r line; do :; done; exit 0;;
    esac
    echo '{"event":"hello"}'
    while read -r line; do
      id=${line#*\"id\":}; id=${id%%[!0-9]*}
      case "$line" in
        *'"method":"die"'*) exit 1;;
        *'"method":"hang"'*) while :; do :; done;;
        *'"method":"stall"'*) sleep 0.3; echo "{\"id\":$id,\"result\":$$}";;
        *'"method":"work"'*) for _ in 1 2 3 4 5 6; do sleep 0.25; echo '{"event":"state"}'; done;;
        *) echo "{\"id\":$id,\"result\":$$}";;
      esac
    done
    "#;

        /// Written once, before any test spawns, since a fork during the write makes it "text file busy".
        fn script() -> &'static Path {
            use std::os::unix::fs::PermissionsExt;
            static PATH: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
            PATH.get_or_init(|| {
                let dir = std::env::temp_dir().join("opentrack-sidecar-tests");
                std::fs::create_dir_all(&dir).unwrap();
                let path = dir.join("sidecar.sh");
                std::fs::write(&path, SCRIPT).unwrap();
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
                path
            })
        }

        fn supervised(name: &str, program: &Path, timings: Timings) -> (Sidecar, Arc<Mutex<Vec<Status>>>) {
            let sidecar = Sidecar { timings, ..Sidecar::default() };
            let seen = Arc::new(Mutex::new(Vec::new()));
            let log = seen.clone();
            let data_dir = script().with_file_name(name);
            sidecar.supervise(
                program.to_owned(),
                data_dir,
                |_, _| {},
                move |status| log.lock().unwrap().push(status.clone()),
            );
            (sidecar, seen)
        }

        /// A busy process answers late rather than never, so a fixed sleep would race a slow runner.
        async fn ping_when_free(sidecar: &Sidecar) -> Value {
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                match sidecar.request("ping", Value::Null).await {
                    Err(error) if error == UNRESPONSIVE && Instant::now() < deadline => {}
                    reply => return reply.unwrap(),
                }
            }
        }

        const FAST: Timings = Timings {
            request: Duration::from_secs(10),
            hang: Duration::from_secs(60),
            min_restart: Duration::from_millis(20),
            max_restart: Duration::from_millis(100),
            healthy_run: Duration::from_secs(60),
        };

        #[test]
        fn a_first_crash_fails_the_request_in_flight_and_later_ones_wait_for_the_restart() {
            let (sidecar, seen) = supervised("restart", script(), FAST);
            tauri::async_runtime::block_on(async {
                let first = sidecar.request("ping", Value::Null).await.unwrap();
                assert_eq!(sidecar.request("die", Value::Null).await, Err(STOPPED.into()));
                let second = sidecar.request("ping", Value::Null).await.unwrap();
                assert_ne!(first, second);
            });
            assert_eq!(*seen.lock().unwrap(), [Status::Running, Status::Starting, Status::Running]);
        }

        #[test]
        fn a_crash_loop_fails_requests_at_once_with_where_to_look() {
            let (sidecar, seen) = supervised("crash-loop", script(), FAST);
            tauri::async_runtime::block_on(async {
                let error = sidecar.request("ping", Value::Null).await.unwrap_err();
                assert!(error.contains("sidecar.log"), "{error}");
                let started = Instant::now();
                let error = sidecar.request("ping", Value::Null).await.unwrap_err();
                assert!(error.contains("sidecar.log"), "{error}");
                assert!(started.elapsed() < Duration::from_secs(1));
            });
            assert!(matches!(seen.lock().unwrap().as_slice(), [Status::Down(_)]));
        }

        #[test]
        fn a_hung_process_is_killed_and_restarted() {
            let timings = Timings { request: Duration::from_millis(200), hang: Duration::from_millis(400), ..FAST };
            let (sidecar, _) = supervised("hang", script(), timings);
            tauri::async_runtime::block_on(async {
                let first = sidecar.request("ping", Value::Null).await.unwrap();
                assert_eq!(sidecar.request("hang", Value::Null).await, Err(UNRESPONSIVE.into()));
                tokio::time::sleep(Duration::from_millis(500)).await;
                assert_ne!(sidecar.request("ping", Value::Null).await.unwrap(), first);
            });
        }

        #[test]
        fn a_stalled_process_fails_the_request_but_is_not_killed() {
            let timings = Timings { request: Duration::from_millis(100), ..FAST };
            let (sidecar, _) = supervised("stall", script(), timings);
            tauri::async_runtime::block_on(async {
                let first = sidecar.request("ping", Value::Null).await.unwrap();
                assert_eq!(sidecar.request("stall", Value::Null).await, Err(UNRESPONSIVE.into()));
                assert_eq!(ping_when_free(&sidecar).await, first);
            });
        }

        #[test]
        fn output_while_working_keeps_it_alive_past_the_hang_limit() {
            let timings = Timings { request: Duration::from_millis(100), hang: Duration::from_secs(1), ..FAST };
            let (sidecar, _) = supervised("work", script(), timings);
            tauri::async_runtime::block_on(async {
                let first = sidecar.request("ping", Value::Null).await.unwrap();
                assert_eq!(sidecar.request("work", Value::Null).await, Err(UNRESPONSIVE.into()));
                assert_eq!(ping_when_free(&sidecar).await, first);
            });
        }

        #[test]
        fn a_slow_start_outlasts_a_request_until_the_hang_limit() {
            let timings = Timings {
                request: Duration::from_millis(100),
                hang: Duration::from_millis(500),
                healthy_run: Duration::from_millis(100),
                ..FAST
            };
            let (sidecar, _) = supervised("silent", script(), timings);
            tauri::async_runtime::block_on(async {
                assert_eq!(sidecar.request("ping", Value::Null).await, Err(UNRESPONSIVE.into()));
                assert_eq!(sidecar.status(), Status::Starting);
                let mut down = sidecar.status.subscribe();
                tokio::time::timeout(Duration::from_secs(5), down.wait_for(|status| matches!(status, Status::Down(_))))
                    .await
                    .unwrap()
                    .unwrap();
            });
        }

        #[test]
        fn a_program_that_cannot_start_is_reported() {
            let (sidecar, _) = supervised("missing", Path::new("/nonexistent/sidecar"), FAST);
            let reply = tauri::async_runtime::block_on(sidecar.request("ping", Value::Null));
            assert!(reply.unwrap_err().contains("could not start"));
            assert!(matches!(sidecar.status(), Status::Down(_)));
        }
    }
}
