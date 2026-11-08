//! Runs `aitrack sync` against this process's environment, for comparing with 4.x.
use aitrack_core::Core;
use aitrack_core::env::Env;
use aitrack_core::output::StdOutput;
use aitrack_core::sync::{SyncOptions, sync_data};
use aitrack_core::time::Clock;

fn main() {
    let core = Core::new(Env::from_process(), Clock::system(), Box::new(StdOutput::default()));
    match sync_data(&core, SyncOptions::default()) {
        Ok(result) => println!("RESULT {}", result.message),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}
