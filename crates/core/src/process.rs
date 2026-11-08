use std::io::Read;
use std::path::Path;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

/// What a finished command wrote.
#[derive(Debug)]
pub struct Finished {
    pub status: ExitStatus,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

#[derive(Debug, thiserror::Error)]
pub enum RunError {
    /// It could not start: not installed, or the working directory is gone.
    #[error("{0}")]
    Spawn(std::io::Error),
    #[error("timed out")]
    Timeout,
}

/// Runs a command to completion with its output captured, or kills it (and on Windows its children,
/// such as git's credential helpers) after `timeout`. The pipes are drained while it runs, so a
/// large output cannot fill them and stall it.
pub fn run(
    program: &str,
    args: &[&str],
    env: &[(String, String)],
    cwd: Option<&Path>,
    timeout: Option<Duration>,
) -> Result<Finished, RunError> {
    let mut command = Command::new(program);
    command
        .args(args)
        .envs(env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut command, 0x0800_0000); // CREATE_NO_WINDOW
    let mut child = command.spawn().map_err(RunError::Spawn)?;
    let drain = |pipe: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut buffer = Vec::new();
            if let Some(mut pipe) = pipe {
                let _ = pipe.read_to_end(&mut buffer);
            }
            buffer
        })
    };
    let stdout = drain(child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    let stderr = drain(child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    let deadline = timeout.map(|t| Instant::now() + t);
    let status = loop {
        if let Some(status) = child.try_wait().map_err(RunError::Spawn)? {
            break status;
        }
        if deadline.is_some_and(|d| Instant::now() >= d) {
            kill_tree(&mut child);
            return Err(RunError::Timeout);
        }
        std::thread::sleep(Duration::from_millis(5));
    };
    Ok(Finished { status, stdout: stdout.join().unwrap_or_default(), stderr: stderr.join().unwrap_or_default() })
}

/// Runs a command with the terminal attached, for prompts such as `git clone`'s credentials.
pub fn run_interactive(program: &str, args: &[&str]) -> Result<ExitStatus, RunError> {
    Command::new(program).args(args).status().map_err(RunError::Spawn)
}

fn kill_tree(child: &mut Child) {
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/pid", &child.id().to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn drains_large_output_and_times_out() {
        let big = run("sh", &["-c", "head -c 3000000 /dev/zero"], &[], None, Some(Duration::from_secs(20))).unwrap();
        assert_eq!(big.stdout.len(), 3_000_000);
        assert!(matches!(
            run("sh", &["-c", "sleep 5"], &[], None, Some(Duration::from_millis(100))),
            Err(RunError::Timeout)
        ));
        assert!(matches!(run("definitely-not-a-program", &[], &[], None, None), Err(RunError::Spawn(_))));
    }
}
