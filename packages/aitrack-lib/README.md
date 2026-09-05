# aitrack-lib

The library behind [`aitrack`](https://www.npmjs.com/package/aitrack): reading Claude Code,
Codex and Cursor usage off the local machine, pricing it, merging it across machines, and
rendering it as a heatmap, terminal table or receipt.

```sh
npm install aitrack-lib
```

```ts
import { buildUsageReport, loadConfig, readClaudeData } from 'aitrack-lib';
```

Every module is also reachable at its own subpath, so a program that only needs one reader
does not pull the renderers in with it:

```ts
import { readClaudeData } from 'aitrack-lib/readers/claude';
import { resolveModelCost } from 'aitrack-lib/pricing/resolve';
import type { DayEntry, MachineFile } from 'aitrack-lib/data/types';
```

The main groups are `readers/` (provider ingestion), `pricing/` (model price tables and cost
resolution), `data/` (the day/model data model, validation, aggregation and reports),
`store/` and `git.ts` (the synced machine files), `providers/` (the provider registry) and
`display/` (terminal, PNG, PDF and CSV output).

**[Full documentation →](https://github.com/bircni/aitrack#readme)**

## License

[MIT](https://github.com/bircni/aitrack/blob/main/LICENSE)
