//! Reader timings on a generated corpus, to compare before and after a change; never asserts a time.
//!
//! ```sh
//! cargo test --release -p aitrack-core --test perf -- --ignored --nocapture
//! ```
//!
//! `AITRACK_PERF_SCALE` multiplies the corpus (default 1: 240 Claude transcripts, 80 Codex sessions).
#![expect(clippy::unwrap_used, reason = "a broken corpus should fail the run outright")]

use std::fmt::Write as _;
use std::path::Path;
use std::time::{Duration, Instant};

use aitrack_core::Core;
use aitrack_core::data::types::DayMap;
use aitrack_core::env::Env;
use aitrack_core::output::VecOutput;
use aitrack_core::pricing::ReaderPricing;
use aitrack_core::pricing::store::PricingStore;
use aitrack_core::readers::project::ProjectResolver;
use aitrack_core::readers::read::{read_claude_days, read_codex_days};
use aitrack_core::time::Clock;

struct NoRemotes;

impl ProjectResolver for NoRemotes {
    fn resolve(&self, _: &str) -> Option<String> {
        None
    }
}

const MESSAGES: usize = 200;
const MODELS: [&str; 3] = ["claude-sonnet-4-5-20250929", "claude-opus-4-1-latest", "claude-haiku-5-5"];

/// Shaped like real transcripts: most bytes are tool results, every line has the session's `cwd`, a fifth of
/// the sessions resume an earlier one and a tenth have no `cwd` at all.
fn claude_transcript(file: usize, filler: &str) -> String {
    let mut out = String::new();
    let resumed = if file % 5 == 4 { file - 1 } else { file };
    let cwd = if file % 10 == 9 { String::new() } else { format!(r#""cwd":"/nonexistent/repo-{}","#, file % 12) };
    for i in 0..MESSAGES {
        let session = if i < MESSAGES / 3 { resumed } else { file };
        let day = 1 + (file + i / 40) % 28;
        let (hour, minute) = ((i / 60) % 24, i % 60);
        let ts = format!("2026-03-{day:02}T{hour:02}:{minute:02}:00Z");
        writeln!(
            out,
            r#"{{"type":"user",{cwd}"timestamp":"{ts}","message":{{"role":"user","content":[{{"type":"tool_result","content":"{filler}"}}]}}}}"#
        )
        .unwrap();
        writeln!(
            out,
            r#"{{"type":"assistant",{cwd}"timestamp":"{ts}","requestId":"r{session}-{i}","message":{{"id":"m{session}-{i}","model":"{}","usage":{{"input_tokens":{},"output_tokens":{},"cache_read_input_tokens":{},"cache_creation":{{"ephemeral_5m_input_tokens":{},"ephemeral_1h_input_tokens":0}}}},"content":[{{"type":"text","text":"done"}}]}}}}"#,
            MODELS[(session + i) % MODELS.len()],
            10 + i,
            100 + i * 3,
            5_000 + i * 17,
            i % 7 * 100,
        )
        .unwrap();
    }
    out
}

fn codex_session(file: usize, filler: &str) -> String {
    let mut out = format!(
        "{{\"timestamp\":\"2026-03-01T00:00:00Z\",\"type\":\"session_meta\",\"payload\":{{\"cwd\":\"/nonexistent/repo-{}\"}}}}\n",
        file % 12
    );
    let (mut input, mut cached, mut output) = (0, 0, 0);
    for i in 0..MESSAGES {
        let ts = format!("2026-03-{:02}T{:02}:{:02}:00Z", 1 + (file + i / 40) % 28, (i / 60) % 24, i % 60);
        if i % 50 == 0 {
            writeln!(out, r#"{{"timestamp":"{ts}","type":"turn_context","payload":{{"model":"gpt-5-codex"}}}}"#)
                .unwrap();
        }
        writeln!(out, r#"{{"timestamp":"{ts}","type":"response_item","payload":{{"type":"function_call_output","output":"{filler}"}}}}"#).unwrap();
        input += 1_000 + i;
        cached += 600;
        output += 50 + i;
        writeln!(
            out,
            r#"{{"timestamp":"{ts}","type":"event_msg","payload":{{"type":"token_count","info":{{"total_token_usage":{{"input_tokens":{input},"cached_input_tokens":{cached},"output_tokens":{output}}}}}}}}}"#
        )
        .unwrap();
    }
    out
}

fn write_corpus(root: &Path, scale: usize) -> u64 {
    let filler = "lorem ipsum dolor sit amet, consectetur adipiscing elit ".repeat(80);
    let mut bytes = 0;
    for file in 0..240 * scale {
        let dir = root.join(format!("claude/proj-{}", file % 16));
        std::fs::create_dir_all(&dir).unwrap();
        let text = claude_transcript(file, &filler);
        bytes += text.len() as u64;
        std::fs::write(dir.join(format!("s{file:05}.jsonl")), text).unwrap();
    }
    for file in 0..80 * scale {
        let dir = root.join(format!("codex/2026/03/{:02}", 1 + file % 28));
        std::fs::create_dir_all(&dir).unwrap();
        let text = codex_session(file, &filler);
        bytes += text.len() as u64;
        std::fs::write(dir.join(format!("rollout-{file:05}.jsonl")), text).unwrap();
    }
    bytes
}

fn core(home: &Path, logs: &Path, no_cache: bool) -> Core {
    let mut vars = vec![
        ("AITRACK_CLAUDE_PROJECTS_DIRS".to_owned(), logs.join("claude").to_string_lossy().into_owned()),
        ("AITRACK_CODEX_SESSION_DIRS".to_owned(), logs.join("codex").to_string_lossy().into_owned()),
    ];
    if no_cache {
        vars.push(("AITRACK_NO_CACHE".to_owned(), "1".to_owned()));
    }
    Core::new(Env::new(home, vars), Clock::in_zone("UTC").unwrap(), Box::new(VecOutput::default()))
}

/// The fastest of `runs`, so other work on the machine shows less.
fn best<T>(runs: usize, mut f: impl FnMut() -> T) -> (Duration, T) {
    let mut fastest = Duration::MAX;
    let mut last = None;
    for _ in 0..runs {
        let start = Instant::now();
        let value = f();
        fastest = fastest.min(start.elapsed());
        last = Some(value);
    }
    (fastest, last.unwrap())
}

#[test]
#[ignore = "timings, run by hand with --release"]
fn reader_timings() {
    let scale = std::env::var("AITRACK_PERF_SCALE").ok().and_then(|s| s.parse().ok()).unwrap_or(1);
    let logs = tempfile::tempdir().unwrap();
    let bytes = write_corpus(logs.path(), scale);
    let bundled = PricingStore::bundled();
    let pricing = ReaderPricing { pricing: &bundled, fallbacks: None };
    let read = |core: &Core| -> (DayMap, DayMap) {
        (read_claude_days(core, &pricing, &NoRemotes).unwrap(), read_codex_days(core, &pricing, &NoRemotes).unwrap())
    };

    let uncached = tempfile::tempdir().unwrap();
    let (no_cache, want) = best(3, || read(&core(uncached.path(), logs.path(), true)));
    let (cold, (home, got)) = best(3, || {
        let home = tempfile::tempdir().unwrap();
        let days = read(&core(home.path(), logs.path(), false));
        (home, days)
    });
    assert_eq!(got, want, "cold with cache");
    let (warm, got) = best(5, || read(&core(home.path(), logs.path(), false)));
    assert_eq!(got, want, "from the snapshot");
    let active = logs.path().join("claude/proj-0/s00000.jsonl");
    let (one_changed, got) = best(5, || {
        let mut file = std::fs::OpenOptions::new().append(true).open(&active).unwrap();
        std::io::Write::write_all(&mut file, b"\n").unwrap();
        read(&core(home.path(), logs.path(), false))
    });
    assert_eq!(got, want, "one file rescanned");
    let cache: u64 = std::fs::read_dir(home.path().join(".config/aitrack/cache"))
        .unwrap()
        .map(|e| e.unwrap().metadata().unwrap().len())
        .sum();

    println!("corpus           {:>8} kB", bytes / 1000);
    println!("no cache         {:>8.1} ms", no_cache.as_secs_f64() * 1e3);
    println!("cold, writing    {:>8.1} ms", cold.as_secs_f64() * 1e3);
    println!("warm, snapshot   {:>8.1} ms", warm.as_secs_f64() * 1e3);
    println!("one file changed {:>8.1} ms", one_changed.as_secs_f64() * 1e3);
    println!("cache on disk    {:>8} kB", cache / 1000);
}
