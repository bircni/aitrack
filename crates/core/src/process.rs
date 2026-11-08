use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

/// Runs a command to completion, or kills it after `timeout`. `None` when it cannot start or times out.
pub fn run_with_timeout(program: &str, args: &[&str], env: &[(&str, &str)], timeout: Duration) -> Option<Output> {
    let mut command = Command::new(program);
    command.args(args).envs(env.iter().copied()).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut command, 0x0800_0000); // CREATE_NO_WINDOW
    let mut child = command.spawn().ok()?;
    let deadline = Instant::now() + timeout;
    loop {
        if child.try_wait().ok()?.is_some() {
            return child.wait_with_output().ok();
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}
