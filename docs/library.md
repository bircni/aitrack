# aitrack-lib

## Using the library

The CLI is a thin shell over [`aitrack-lib`](../libs/aitrack-lib), which is published
separately and needs Node.js 24+. Read a provider's local usage, price it, and render it yourself:

```sh
npm install aitrack-lib
```

```ts
import { buildUsageReport } from 'aitrack-lib';

const report = await buildUsageReport({ period: 'month', providers: ['claude_code', 'codex'] });
if (report) console.log(report.windowLabel, report.totals.tokens, report.totals.costUSD);
```

`report` is `null` when there is no usage to read.

### What a report touches

`buildUsageReport` works on the same files as the CLI:

- It reads `~/.config/aitrack/config.json` and, when a data repo is cloned, its machine files.
- It scans the Claude Code and Codex [source roots](cli.md#where-data-comes-from), runs
  `git remote get-url origin` in the working directories they record, and writes parse caches to
  `~/.config/aitrack/cache/` (`AITRACK_NO_CACHE=1` turns them off).
- **Without `providers`, or with `cursor` in it, it reads Cursor's saved access token and downloads
  the usage export** from `CURSOR_WEB_BASE_URL`, at most every 6 hours. Pass `providers` without
  `cursor` to skip both. A failed Cursor download is logged as a warning, not thrown.

It neither downloads rates nor writes to git. `syncPricingPack`, `aitrack-lib/sync` and
`aitrack-lib/recompute` do, and the `quota/` modules read provider logins and call their usage endpoints.
`syncData` and `recomputeCosts` warn when the clone's `origin` differs from `repoUrl`, then pull and push to `origin`.
`differingOrigin`, `sameRemote` and `redactUrl` in `aitrack-lib/git/remote` let you check or display that yourself; the same repository in another URL form counts as a match.
`loadConfig` throws when there is no config; `tryLoadConfig` returns `null`.

### Subpaths

The package root exports the common API; every module is also reachable at its own subpath:

```ts
import { normalizeProviderKey } from 'aitrack-lib/providers/descriptors';
import { readClaudeData } from 'aitrack-lib/readers/claude';
```

A folder module needs its `/index`, as in `aitrack-lib/quota/index`, `aitrack-lib/providers/index` or
`aitrack-lib/readers/cursor/index`. The rate tables under `pricing/tables/` are not exported.
`aitrack-lib/providers/descriptors` holds the provider names and keys with no runtime imports, for a
program that only needs to parse a provider name.

Only the root export is the stable API: a removed or renamed root export is a breaking change, and a test fails until the export list is updated on purpose. Subpath modules are exposed so a consumer can load one module on its own, but their internals may change in any release. The root loads canvas and pdfkit only when a renderer runs.

### Loaded data

`loadMergedProviderData` returns one merged set plus each machine's own days and timezone (`ZonedUsageData`). `buildUsageReportFromLoaded` builds several windows from one load, and `zonedUsageData` and `mergeUsageSources` convert and re-merge that data. `machineUsageTotals` gives one machine's totals with the same merge as a report. `rebucketPersistedDays` is what reports use after a timezone change, and `canonicalDays` and `outgoingDays` put days into the form a machine file stores.

`loadPersistedMachines` memoizes each file on its modification time, size and the passphrase, and its results are shared between calls: do not mutate them. `writeMachineFile` validates before writing and throws `InvalidMachineFileError` rather than write a file readers would reject.

See [Contributing](../CONTRIBUTING.md) for the source layout and development workflow.
