# aitrack-lib

The library behind [`aitrack`](https://www.npmjs.com/package/aitrack): reading Claude Code,
Codex and Cursor usage off the local machine, pricing it, merging it across machines, and
rendering it as a heatmap, terminal table or receipt.

```sh
npm install aitrack-lib
```

It needs Node.js 24+.

```ts
import { buildUsageReport } from 'aitrack-lib';

const report = await buildUsageReport({ period: 'month', providers: ['claude_code', 'codex'] });
if (report) console.log(report.windowLabel, report.totals.tokens, report.totals.costUSD);
```

`report` is `null` when there is no usage to read. **Without `providers`, or with `cursor` in it,
`buildUsageReport` reads Cursor's saved access token and downloads the usage export from
`CURSOR_WEB_BASE_URL`**, at most every 6 hours. It also reads `~/.config/aitrack/config.json`, scans
the local logs, runs `git remote get-url origin` in the folders they record and writes parse caches
to `~/.config/aitrack/cache/`.
[What a report touches](https://github.com/bircni/aitrack/blob/main/docs/library.md#what-a-report-touches)
has the details.

Every module is also reachable at its own subpath, so a program that only needs one module loads
just that:

```ts
import type { DayEntry, MachineFile } from 'aitrack-lib/data/types';
import { resolveModelCost } from 'aitrack-lib/pricing/resolve';
import { normalizeProviderKey } from 'aitrack-lib/providers/descriptors';
import { readClaudeData } from 'aitrack-lib/readers/claude';
```

A folder module needs its `/index`, as in `aitrack-lib/quota/index`. Only the root export is the
stable API; subpath internals may change in any release.

The main groups are `readers/` (provider ingestion), `pricing/` (list-price estimates; the rate
tables are not exported), `data/` (the day/model data model, validation, aggregation and reports),
`store/` and `git.ts` (the synced machine files), `providers/` (the provider registry), `quota/` (live
limits, which read provider logins and call their usage endpoints) and `display/` (terminal, PNG, PDF
and CSV output).

**[Full documentation →](https://github.com/bircni/aitrack#readme)**

## License

[MIT](https://github.com/bircni/aitrack/blob/main/LICENSE)
