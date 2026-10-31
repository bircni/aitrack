# Reader benchmark

Measured on 2026-10-31, Linux x64 (4 vCPUs), Node v26.8.2. Baseline is `main` before the
filtered scan, worker threads and compact parse cache; Updated is the reader that introduced
them. These are synthetic local measurements, not guarantees for other machines or storage.

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

Reproduce with `bun x tsx scripts/benchmark-readers.ts`. Set `AITRACK_BENCH_ROOT` to another
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
- **One thread.** A cold read of more than 32 MB is scanned on up to eight worker threads.
  Pricing, project attribution and the cache stay on the main thread. The opentrack sidecar is
  bundled without a worker file and scans in-thread.
- **Parse cache size.** Per-message contributions are stored as flat rows over a string table
  and parsed only when a file shares message ids with an earlier one.
- **Startup.** Commands load their modules when they run, compiled code is cached across runs,
  and `node:sqlite` loads only when Cursor's database is opened.
