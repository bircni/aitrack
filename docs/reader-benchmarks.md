# Reader benchmark

Measured on 2026-10-03, macOS ARM64, Node v26.10.0. Each timing is the median of
five runs in an isolated temporary home. The baseline is the checkout's original
`HEAD`; the comparison uses the implementation working tree. These are synthetic
local measurements, not guarantees for other machines or storage.

Reproduce with `pnpm exec tsx scripts/benchmark-readers.ts`. Set
`AITRACK_BENCH_ROOT` to another source checkout to compare implementations; that
checkout must have its dependencies available. The benchmark makes no network
requests and removes its temporary home after completion.

Each corpus contains 100 files with 100 assistant messages each. The overlapping
corpus repeats the first 80 messages in every file. Cold runs remove the derived
cache; warm runs use the full reader with its disk/memory cache. Assertions require
identical totals and ordering between cold and warm reads. The unique corpus has
1,250,000 tokens; the overlapping corpus has 260,000 in both implementations.

| Measurement               |      Baseline |         Updated |
| ------------------------- | ------------: | --------------: |
| Unique cold read          |      24.46 ms |        34.26 ms |
| Unique warm read          |       3.12 ms |         3.34 ms |
| Overlapping cold read     |      40.71 ms |        23.31 ms |
| Overlapping warm read     |      21.91 ms |         2.11 ms |
| 10,000-file listing       |     380.89 ms |        97.73 ms |
| Unique derived cache      | 207,024 bytes | 2,306,190 bytes |
| Overlapping derived cache | 174,906 bytes | 2,241,845 bytes |

| Filesystem work per read           | Unique baseline/updated | Overlapping baseline | Overlapping updated |
| ---------------------------------- | ----------------------: | -------------------: | ------------------: |
| Cold transcript streams            |               100 / 100 |                  199 |                 100 |
| Warm transcript streams            |                   0 / 0 |                   99 |                   0 |
| Cold transcript bytes              |   1,787,780 / 1,787,780 |            3,493,640 |           1,755,560 |
| Warm transcript bytes              |                   0 / 0 |            1,738,080 |                   0 |
| Async metadata calls, cold or warm |               201 / 201 |                  201 |                 201 |
| Synchronous reads, cold / warm     |                   2 / 1 |                2 / 1 |               2 / 1 |
| Network requests                   |                   0 / 0 |                    0 |                   0 |

Listing uses 10,001 metadata calls in both versions. Bounded concurrent `realpath`
changes latency while preserving the filesystem's input ordering and deduplication.

Process memory after unique reads was 155.4 MB RSS / 22.8 MB heap used at baseline
and 182.2 MB / 46.9 MB updated; after overlapping reads it was 200.4 MB / 38.9 MB
and 215.9 MB / 31.7 MB respectively. These are snapshots from separate processes,
not peak-memory measurements; garbage collection and preceding runs affect them.

Per-message contributions eliminate overlapping transcript reparses, but increase
cache size, allocations and cold serialization work. The unique cold-read slowdown
is a material tradeoff; the nonoverlapping warm path retains aggregate merging
rather than iterating every cached message. Unkeyed contributions are aggregated
by date/model before caching. Pricing changes invalidate derived caches and rebuild
costs from logs without changing stored historical machine costs.
