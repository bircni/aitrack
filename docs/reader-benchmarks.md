# Reader benchmark

`crates/core/tests/perf.rs` times the 5.0 readers on a generated corpus (no cache, cold, warm, one
file changed) and checks that every path gives the same days. It is ignored by default; compare a
change against its base on the same machine, pinned to one core when other work is running:

```sh
cargo test --release -p aitrack-core --test perf -- --ignored --nocapture
```

These measurements are of the 4.x TypeScript readers. The 5.0 Rust readers keep their design (the
needle filter, up to four scan threads, the parse cache and merged snapshot). On one machine's real
logs (4.9 GB of Claude transcripts, caches off) a 5.0 cold read took 0.6 s and 130 MB resident
against 4.x's 1.5 s and 510 MB.

The first two tables were measured on 2026-10-31, Linux x64 (4 vCPUs), Node v26.8.2. Baseline is
`main` before the filtered scan, worker threads and compact parse cache; Updated is the reader that
introduced them. [Later changes](#later-changes) were measured on another machine and are not
comparable with them. All of these are synthetic local measurements, not guarantees for other
machines or storage.

## End to end

A generated corpus shaped like real logs: 600 Claude Code transcripts (2.3 GB) with tool
results and attachments between messages, and 250 Codex sessions (618 MB). Each timing is the
median of the built CLI run several times; cold removes the parse cache first, active session
appends one message to a transcript before each run.

| Command                       | Baseline | Updated |
| ----------------------------- | -------: | ------: |
| `usage all`, cold             |   8.98 s |  2.07 s |
| `usage all`, warm             |   411 ms |  251 ms |
| `usage today`, active session |   585 ms |  310 ms |
| `show --tui`, warm            |   410 ms |  255 ms |
| `--version`                   |   128 ms |   81 ms |
| Claude parse cache            |  22.3 MB |  6.0 MB |

Node itself starts in about 30 ms on this machine.

## Synthetic reader

These were run with 4.x's `scripts/benchmark-readers.ts`, which 5.0 removed with the rest of the
TypeScript tree; git history keeps it. Set `AITRACK_BENCH_ROOT` to another
source checkout to compare implementations; that checkout must have its dependencies
available. The benchmark makes no network requests and removes its temporary home after
completion. It imports the TypeScript sources, so it measures the in-thread scan.

Each corpus contains 100 files with 100 assistant messages each. The overlapping corpus
repeats the first 80 messages in every file; the mixed corpus puts a 20 KB tool result before
each message. Cold runs remove the derived cache; warm runs use the full reader with its
disk/memory cache. Assertions require identical totals and ordering between cold and warm reads.

| Measurement               |    Baseline |   Updated |
| ------------------------- | ----------: | --------: |
| Unique cold read          |    92.33 ms |  76.32 ms |
| Unique warm read          |     7.07 ms |   3.58 ms |
| Overlapping cold read     |    80.86 ms |  74.87 ms |
| Overlapping warm read     |     5.59 ms |   4.25 ms |
| Mixed cold read           |   398.21 ms | 189.10 ms |
| Mixed warm read           |     6.79 ms |   3.97 ms |
| Unique derived cache      | 2,558,990 B | 708,310 B |
| Overlapping derived cache | 2,494,650 B | 676,190 B |

Both versions open each transcript once cold and none warm, and read the same bytes.

## Where the time went

- **Parsing every line.** Most bytes in a transcript are tool results, file attachments and
  prompts. A line is now decoded and parsed only when it holds a needle (`"usage"` for Claude,
  `"token_count"`, `"turn_context"` or `"session_meta"` for Codex). State that other lines carry
  (Claude's `cwd`, Codex's timestamp) is read from the last such line, and only when the
  counted line lacks it.
- **One thread.** A cold read is scanned on one worker per 24 MiB of files to read, up to four and
  no more than the files or cores available, so it takes at least 48 MiB across two files to leave
  the main thread. The main thread prices every result, so more workers add CPU and memory, not speed.
  Pricing, project attribution and the cache stay on the main thread. The opentrack sidecar is
  bundled without a worker file and scans in-thread.
- **Parse cache size.** Per-message contributions are stored as flat rows over a string table
  and parsed only when a file shares message ids with an earlier one.
- **Warm reads.** A provider's merged result is kept in its own snapshot, reused while the source
  list, sizes and modification times match. The parse cache is not rewritten when only files active
  in the last 10 minutes changed and rescanning them is cheaper than the write.
- **Startup.** Commands load their modules when they run, compiled code is cached across runs,
  `node:sqlite` loads only when Cursor's database is opened, and canvas and pdfkit load only when
  a PNG or PDF is rendered.

## Later changes

Measured on 2026-11-06 on Apple Silicon (14 cores), Node v26.8.2, with other work running on the
machine, so treat small differences as noise. Everything is synthetic. Corpus: 1,800 generated
transcripts (1.7 GB), whole process through the readers. The runs were repeated and the medians
kept, except the single-file row. The import row is its own measurement, the median of 7.

| Measurement                           |  Before |   After |
| ------------------------------------- | ------: | ------: |
| Warm read, wall                       |  159 ms |   74 ms |
| Warm read, RSS                        |  259 MB |   88 MB |
| Active session, wall                  |  204 ms |  178 ms |
| Active session, RSS                   |  326 MB |  264 MB |
| Cold read, wall (8 vs 4 workers)      |  954 ms |  974 ms |
| Cold read, CPU (8 vs 4 workers)       | 3805 ms | 3344 ms |
| Cold read, RSS (8 vs 4 workers)       |  703 MB |  603 MB |
| 9.5 MB transcript with no `cwd`, cold |  24.0 s |  150 ms |
| Import of the package root, compiled  |  115 ms |   44 ms |

The sidecar's in-thread scan yields to its event loop every 4 MB: a cold read of a 6.7 GB synthetic
corpus (1,500 transcripts plus one 1 GB file) under `--optimize-for-size` took 3.0-3.9 s with a worst
stall of 30-44 ms.

Small corpora saw no meaningful change in warm reads. In `scripts/benchmark-readers.ts`, warm reads
(unique / overlapping / mixed) went from 1.9 / 1.9 / 1.2 ms to 0.8 / 0.8 / 0.7 ms and cold reads from
27.6 / 22.4 / 58.9 ms to 26.3 / 22.2 / 52.4 ms; those before and after runs were not interleaved.
