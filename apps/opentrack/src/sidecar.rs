use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::sync::oneshot;

/// Every request answers at once (refresh reports progress as events); this only unblocks the UI.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const MIN_RESTART_DELAY: Duration = Duration::from_secs(2);
const MAX_RESTART_DELAY: Duration = Duration::from_secs(120);
const HEALTHY_RUN: Duration = Duration::from_secs(60);

type Reply = Result<Value, String>;
type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Reply>>>>;

/// One line from the sidecar: the answer to a request, or an event it pushed.
#[derive(Debug, PartialEq)]
pub enum Incoming {
    Reply { id: u64, reply: Reply },
    Event { name: String, data: Value },
}

pub fn parse_line(line: &str) -> Option<Incoming> {
    let value: Value = serde_json::from_str(line).ok()?;
    if let Some(id) = value.get("id").and_then(Value::as_u64) {
        let reply = match value.get("error").and_then(Value::as_str) {
            Some(error) => Err(error.to_owned()),
            None => Ok(value.get("result").cloned().unwrap_or(Value::Null)),
        };
        return Some(Incoming::Reply { id, reply });
    }
    let name = value.get("event")?.as_str()?.to_owned();
    let data = value.get("data").cloned().unwrap_or(Value::Null);
    Some(Incoming::Event { name, data })
}

/// The Node process that fetches limits and reads usage, restarted if it dies.
#[derive(Default)]
pub struct Sidecar {
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    pending: Pending,
    next_id: AtomicU64,
}

impl Sidecar {
    /// Runs the process, restarting it when it dies; call once whatever `on_event` touches exists.
    pub fn supervise<F>(&self, program: PathBuf, data_dir: PathBuf, on_event: F)
    where
        F: Fn(&str, Value) + Send + Sync + 'static,
    {
        let (supervised_stdin, supervised_pending) = (self.stdin.clone(), self.pending.clone());
        let mut delay = MIN_RESTART_DELAY;
        thread::spawn(move || loop {
            let started = Instant::now();
            match start(&program, &data_dir) {
                Ok(mut child) => {
                    *supervised_stdin.lock().unwrap() = child.stdin.take();
                    if let Some(stdout) = child.stdout.take() {
                        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                            match parse_line(&line) {
                                Some(Incoming::Reply { id, reply }) => {
                                    if let Some(sender) = supervised_pending.lock().unwrap().remove(&id) {
                                        let _ = sender.send(reply);
                                    }
                                }
                                Some(Incoming::Event { name, data }) => on_event(&name, data),
                                None => {}
                            }
                        }
                    }
                    let _ = child.wait();
                    *supervised_stdin.lock().unwrap() = None;
                    for (_, sender) in supervised_pending.lock().unwrap().drain() {
                        let _ = sender.send(Err("The background service stopped".into()));
                    }
                }
                Err(error) => eprintln!("opentrack: could not start {}: {error}", program.display()),
            }
            // One that dies at startup should not be relaunched every two seconds forever.
            if started.elapsed() > HEALTHY_RUN {
                delay = MIN_RESTART_DELAY;
            }
            thread::sleep(delay);
            delay = (delay * 2).min(MAX_RESTART_DELAY);
        });
    }

    pub async fn request(&self, method: &str, params: Value) -> Reply {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, sender);
        let line = json!({ "id": id, "method": method, "params": params }).to_string();
        let written = match self.stdin.lock().unwrap().as_mut() {
            Some(stdin) => writeln!(stdin, "{line}").and_then(|()| stdin.flush()).is_ok(),
            None => false,
        };
        if !written {
            self.pending.lock().unwrap().remove(&id);
            return Err("The background service is starting".into());
        }
        match tokio::time::timeout(REQUEST_TIMEOUT, receiver).await {
            Ok(reply) => reply.unwrap_or_else(|_| Err("The background service stopped".into())),
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                Err("The background service did not respond".into())
            }
        }
    }
}

fn start(program: &PathBuf, data_dir: &PathBuf) -> std::io::Result<std::process::Child> {
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
}
