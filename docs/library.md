# aitrack-lib

## Using the library

The CLI is a thin shell over [`aitrack-lib`](../libs/aitrack-lib), which is published
separately. Read a provider's local usage, price it, and render it yourself:

```sh
npm install aitrack-lib
```

```ts
import { buildUsageReport, loadConfig, readClaudeData } from 'aitrack-lib';
// Or reach for one module on its own, without pulling the renderers in:
import { readClaudeData } from 'aitrack-lib/readers/claude';
```

The package root exports the common API; every module is also reachable at its own subpath.

Only the root export is the stable API: a removed or renamed root export is a breaking change, and a test fails until the export list is updated on purpose. Subpath modules are exposed so a consumer can skip the renderers, but their internals may change in any release.

See [Contributing](../CONTRIBUTING.md) for the source layout and development workflow.
