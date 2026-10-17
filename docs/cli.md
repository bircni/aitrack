# aitrack CLI guide

[Back to the overview](../README.md) · [Desktop app](opentrack.md)

## Reports

A live terminal table (`aitrack show --tui`) — same data also renders to a PNG heatmap via `aitrack show`:

```text
┌─────────────┬──────┬────────┬────────┬────────┬───────────┬─────────┬────────────┐
│ Provider    │ Days │  Input │ Output │  Total │ Est. cost │  Streak │ Peak month │
├─────────────┼──────┼────────┼────────┼────────┼───────────┼─────────┼────────────┤
│ Claude Code │   28 │ 184.2M │   1.4M │ 185.6M │   $142.80 │ 12 / 12 │ May 2026   │
│ Codex       │   64 │ 612.0M │   3.1M │ 615.1M │   $318.40 │   0 / 9 │ Apr 2026   │
├─────────────┼──────┼────────┼────────┼────────┼───────────┼─────────┼────────────┤
│ TOTAL       │   92 │ 796.2M │   4.5M │ 800.7M │   $461.20 │       — │ —          │
└─────────────┴──────┴────────┴────────┴────────┴───────────┴─────────┴────────────┘
```

Today at a glance (`aitrack usage today`):

```text
┌─────────────┬────────┬───────────────────┬────────┐
│ Provider    │ Tokens │ Model             │  Price │
├─────────────┼────────┼───────────────────┼────────┤
│ Claude Code │  31.5M │ claude-opus-4-8   │ $25.38 │
│ Claude Code │ 827.0K │ claude-sonnet-4-6 │  $0.47 │
│ Codex       │  12.4M │ gpt-5-codex       │  $6.40 │
├─────────────┼────────┼───────────────────┼────────┤
│ TOTAL       │  44.7M │                   │ $32.25 │
└─────────────┴────────┴───────────────────┴────────┘
```

---

## Quick start

**Preview instantly — no setup required:**

```sh
npx aitrack show --tui     # stats table from local Claude/Codex (+ Cursor if available)
npx aitrack usage today    # today's usage, per provider + model
npx aitrack show           # heatmap PNG from the same local-first read
```

Provider-aware commands select Claude Code, Codex, and Cursor by default. To avoid reading Cursor credentials or making a Cursor HTTPS request, choose only the synced providers:

```sh
npx aitrack show --tui --providers claude,codex
```

Your local data is staged at `~/.config/aitrack/pending/data/` so a later `init` can adopt it into your repo.

**Then, to sync across machines:**

```sh
# 1. Create an EMPTY git repo (no README/license) — e.g. github.com/new → "aitrack-data"
# 2. Configure + clone it locally:
npx aitrack init

# 3. Push this machine's data:
npx aitrack sync

# 4. View everything, from any machine:
npx aitrack show
```

`init` asks for your repo's remote URL (SSH or HTTPS — whatever you normally use) and a stable machine name, then clones the repo to `~/.config/aitrack/repo/`. An existing clone whose `origin` differs from the URL you enter is replaced only after you confirm. A config file that cannot be read is reported, and `init` asks before overwriting it; `config list`, `get` and `set` refuse to run on it. The machine name defaults to the short hostname (the part before the first dot) and becomes `data/{machineId}.json`. `show` always reads **fresh local** Claude/Codex data, so you never need to `sync` first just to preview.

### Multiple machines

Run `aitrack init` once per machine with the **same** repo URL, choose a unique, stable, filename-safe machine name for each one, then run `aitrack sync`. Distinct `data/{machineId}.json` files avoid merge conflicts. Changing the ID through `aitrack config set machineId ...` or by rerunning `init` migrates that machine's pending and synced file; a conflicting target is rejected rather than overwritten.

---

## Commands

| Command                         | What it does                                                                                                                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `aitrack init`                  | Configure a remote and stable machine ID, then clone the data repo                                                                                                             |
| `aitrack sync`                  | Read local data, write it to the cloned repo, and push (`--dry-run` previews, `--verify` fails if commits remain unpushed, `--json` for scripts)                               |
| `aitrack show`                  | Merge all sources and render a heatmap PNG (add `--tui` for a terminal table)                                                                                                  |
| `aitrack usage <window>`        | Usage by provider and model for a rolling, calendar, or custom window (`--watch [seconds]` redraws it in place)                                                                |
| `aitrack export [window] [...]` | Export the same windows as an itemized PDF, or `--csv` (defaults to `month`)                                                                                                   |
| `aitrack top [days\|models]`    | Rank busiest days or most-used models by cost (or `--sort tokens`)                                                                                                             |
| `aitrack machines`              | Per-machine totals, timezone, and last sync time, marked `(stale)` after three days without a sync (this machine includes fresh local logs)                                    |
| `aitrack recompute-costs`       | Refresh costs: re-read local JSONL; reprice other machines from stored cache. `--replace-local` rebuilds this machine from the logs and drops synced days they no longer cover |
| `aitrack doctor`                | Check Node, git, config, source paths, Cursor auth, sync health, and pricing                                                                                                   |
| `aitrack completion <shell>`    | Print a `bash`, `zsh` or `fish` completion script, e.g. `eval "$(aitrack completion zsh)"`                                                                                     |
| `aitrack config list\|get\|set` | Inspect or update supported configuration keys                                                                                                                                 |
| `aitrack install-opentrack`     | Download the latest opentrack desktop app, verify its release signature and install it (`--dir` picks the macOS or Linux folder)                                               |

**Usage and export windows:** `today`, `yesterday`, `date <YYYY-MM-DD>`, `range <from> <to>`, `thisweek`, `lastweek`, `week` (rolling 7 days), `thismonth`, `lastmonth`, `month` (rolling 30 days), `last <n>`, `year`, and `all`.

**Provider selection:** `--providers <list>` accepts comma-separated `claude`, `codex`, and `cursor` values and works with `show`, every `usage` window, `export`, and `top`. All three are selected by default. Filtered reports read only selected local providers. Excluding `cursor` prevents the Cursor credential read and HTTPS export request. `show` and sync still read complete local-machine data when staging requires it.

**Live data refresh:** Cursor's CSV export is cached at `~/.config/aitrack/cache/cursor.json` (default 6 h, `AITRACK_CURSOR_CACHE_TTL` seconds to change, `AITRACK_NO_CACHE=1` to disable), so `show` / `usage` / `top` no longer hit the network on every run. Pass `--refresh` to `show`, `export`, `top` or any `usage` window to request a fresh fetch. Refresh attempts still honor failure backoff and `Retry-After`. The cache contains an account hash, never a token, and is served only after verifying the current local account. Legacy, mismatched or unverifiable-account exports are rejected. Alternate credential variants are tried only after 401/403 responses; server failures and rate limits stop the request sequence.

**`show` flags:** `--tui` (terminal table instead of PNG), `--all` (single merged heatmap), `--dark` (dark mode), `--no-open` (don't auto-open the PNG), `-o <path>` (custom output path), `--year <year>` (filter to one calendar year), and `--refresh` (re-fetch Cursor, ignoring the cache).

**JSON output:** add `--json` to `sync`, `show`, `usage`, `export`, `top`, `machines`, `recompute-costs`, `doctor`, `config list`, `config get` or `install-opentrack` for scripting. Stdout then holds exactly one document shaped `{ "command": "...", ... }`; progress lines go to stderr. A failure keeps its non-zero exit code and prints `{ "command": "...", "error": "..." }` on stdout instead.

| Command                      | Fields besides `command`                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------ |
| `sync`                       | `message`, `pushed`, `days`, `dryRun`                                                |
| `show --tui`                 | `mode: "tui"`, `providers` (numeric stats per provider), `total` (or `null`), `year` |
| `show`                       | `mode: "png"`, `path` (the PNG is still opened unless `--no-open`)                   |
| `export`                     | `path`, `format`, `rowCount`, `windowLabel` (`path: null` for an empty window)       |
| `recompute-costs`            | `changed` (files rewritten), `pushed`                                                |
| `config list` / `config get` | `action`, `values` and `resolvedMachineId` / `key` and `value` (`null` when unset)   |
| `install-opentrack`          | `version`, `path` (`null` on Windows)                                                |
| `usage`, `top`, `machines`   | the report; `doctor` adds `checks` and `hasFailures`                                 |

`aitrack usage <window> --short` prints one line (`$12.34 · 44.7M tokens`, nothing for an empty window) for status bars and prompts.

**Exit codes:**

| Code | Meaning                                                                                                         |
| ---- | --------------------------------------------------------------------------------------------------------------- |
| `0`  | Success (also `--help`, `--version`, and `doctor` with only `ok` and `warn` checks)                             |
| `1`  | Runtime failure: no config, network or repository errors, unreadable data, or a `doctor` check reporting `fail` |
| `2`  | Usage error: unknown command, option or config key, an invalid value, or `--watch` without a terminal           |

**Watching:** `aitrack usage <window> --watch [seconds]` redraws the report in place every 30 seconds by default (minimum 5). It needs an interactive terminal and cannot be combined with `--json`. Ctrl-C stops it with exit code 0.

**`export` flags:** `-o <path>` (output path, default `aitrack-receipt.pdf`) and `--csv` (write a spreadsheet-friendly CSV — raw token counts, one row per provider+model plus a `TOTAL` row — instead of the PDF receipt; the default path becomes `aitrack-receipt.csv`, an explicit `-o` is used as given).

Relative windows (`today`, `thisweek`, and the other windows anchored on today) are evaluated in each machine's recorded timezone. `date` and `range` use the stored date keys as written. A heatmap still draws those keys on one grid; `show` says so when the machines are not in the same zone.

**Period comparison:** add `--compare` to any finite `usage` window to compare tokens, estimated
cost, and per-model movement with the equivalent previous period. Calendar-to-date windows compare
the same elapsed days—for example, `aitrack usage thisweek --compare` compares this week so far with
the same weekdays last week. Comparison data is also included with `--json`.

**`top` flags:** `[days|models]` (default `days`), `-n, --limit <n>` (default 10), `--sort tokens|cost` (default `cost`), `--year <year>`, and `--since <YYYY-MM-DD>` / `--until <YYYY-MM-DD>` for an explicit inclusive date range.

**`doctor` flags:** `--pricing-check` also runs the pricing drift script when you are in a source checkout. Without it, doctor still reports the pricing cache: model counts, refresh outcome and the rates' `updatedAt`.

---

## How it works

```text
~/.config/aitrack/
├── config.json          # remote, machine, and source-root settings
├── cache/               # parse and Cursor caches, rebuildable at any time
│   ├── claude-<key>.json
│   ├── codex-<key>.json
│   └── cursor.json
├── pending/
│   └── data/            # staged machine JSON before init
│       └── my-pc.json
├── pricing/             # downloaded rate pack, refreshed at most daily
└── repo/                # local clone of your data repo
    └── data/
        ├── my-pc.json
        └── work-laptop.json
```

- **Sync** uses a local git clone at `~/.config/aitrack/repo/` with your existing git credentials. Non-fast-forward pushes are rebased and retried up to three times; if both machines updated the same machine file, only the current machine's freshly generated file is reapplied.
- **`show` (PNG or `--tui`) always reads fresh local Claude/Codex JSONL** on the current machine and merges in other machines' synced files. No `sync` needed to preview.
- Before `init`, local usage is staged in `~/.config/aitrack/pending/data/` and adopted by the next `init`.
- **Cursor** is loaded only on the current machine when selected: aitrack reads `cursorAuth/accessToken` from Cursor's local `state.vscdb`, then calls the CSV usage export at `CURSOR_WEB_BASE_URL` (`https://cursor.com` by default). The endpoint is required to use HTTPS and contain no embedded credentials. Any configured HTTPS origin receives the Cursor token, so override it only with an endpoint you trust. The token is **never** written to your repo. Use `--providers` without `cursor` (for example, `--providers claude,codex`) to skip both the credential read and request.
- **Pricing** starts from the rate tables bundled with aitrack. `sync`, `doctor` and `recompute-costs` overlay them with a rate pack downloaded from `https://raw.githubusercontent.com/bircni/aitrack/pricing/` (`AITRACK_PRICING_URL` for a mirror) into `~/.config/aitrack/pricing/`, at most once a day, without sending usage data or credentials. Each file's SHA-256 is listed in the pack's manifest and checked on download; a pack whose content does not match is rejected, the current rates stay, and `doctor` reports the failure. A pack published without checksums is still accepted, and `doctor` warns that its content was not verified. This guards against corruption, not a hostile mirror, since the manifest is not signed. A failed download keeps the current rates and is retried after 30 minutes. Set `AITRACK_NO_PRICING_REFRESH=1` to skip it.
- **Heatmap intensity** anchors on the 90th-percentile day rather than the absolute max, so one huge day doesn't flatten the rest of the year.
- **Parsed transcripts are cached** per file in `~/.config/aitrack/cache/`, keyed by path, size, and modification time, and invalidated when the timezone changes. Each app version and pricing fingerprint gets its own `claude-<key>.json` / `codex-<key>.json`, so the CLI and the desktop app do not invalidate each other; on save, only the newest other key is kept. Claude caches retain per-message contributions and aggregated unkeyed usage so overlapping transcripts can be deduplicated without reopening files. Derived-cache upgrades rebuild from logs; synced machine files need no schema migration and existing stored historical costs retain their meaning. Deleting the directory only costs one slower run. Set `AITRACK_NO_CACHE=1` to bypass it entirely.
- **Machine files carry a `schemaVersion` and the producing machine's `timezone`.** Day keys are still that machine's local calendar day (unchanged from 1.x); the timezone is recorded so data merged across machines in different zones can be understood later. These fields are metadata — nothing in a report reads them — so they are tolerated rather than required: a file written by aitrack 1.x (or by a machine still running it) is read normally and upgraded in memory, silently, and the header lands on disk the next time that machine's usage actually changes. A file written by a _newer_ aitrack than the one reading it is skipped with a clear message so the rest of the fleet still loads.

### Cost handling

Claude Code, Codex, and Cursor costs are API-equivalent estimates from per-model list pricing, not subscription charges. Rates live in `libs/aitrack-lib/src/pricing/tables/*.json` so a price change is a JSON edit. Claude estimates account for regular input, cache reads, cache creation, and output. Cache creation uses the 5-minute write rate (1.25× input) unless the transcript splits out 1-hour writes, which are 2× input. Claude 4.6 and later list prices cover the full context window at those base rates, so there is no separate long-context surcharge to apply. Codex estimates use the cached-input count recorded by newer sessions and apply the prompt-cache discount (10% of the input rate); older records without that field are treated as uncached input. A long Astra or Fable session is mostly cache hits, so a multi-million-token day can still be a few dollars. Cursor estimates use the same CSV token buckets (uncached input, cache write, cache read, output) and ignore the export's Cost column, which is plan-included rather than a list price. Cursor CSV rows are aggregates, so long-context rate tiers are not applied. No other table carries a tier either: a context-length surcharge is decided per request, but usage is stored as per-day, per-model sums, and Claude transcripts do not record whether an extended-context mode was on. The tables hold no sourced tier rates (the Claude 4.6+ and Codex rows are flat, and Cursor prices its 1M-context Sonnet as its own `claude-4-sonnet-1m` row), so a tier would have to be invented rather than read from a source; none is applied. Unknown Claude or Codex model IDs that name a known family use that family's rates and emit a warning from `sync`, `show`, `usage`, `top`, and `export`. An id that matches no family stays unpriced, as do unknown Cursor models. When priced and unpriced usage are combined, desktop and terminal totals are marked as partial estimates. JSON includes `hasUnpricedTokens` and `totals.unpricedModels`; `top --json` adds `unpricedModels`; CSV adds `pricing_status` (`complete`, `partial` or `unpriced`) and `unpriced_models`; terminals print an `Unpriced models:` footnote and PDF receipts name them. If stored Claude or Codex estimates are missing or pricing changed, run `aitrack recompute-costs`.

---

## Configuration

Stored at `~/.config/aitrack/config.json`:

```json
{
  "repoUrl": "git@github.com:your-username/aitrack-data.git",
  "machineId": "work-laptop",
  "claudeProjectsDir": "/custom/claude/projects",
  "codexSessionsDir": "/custom/codex/sessions-a,/custom/codex/sessions-b",
  "budget": {
    "monthlyUSD": 200
  },
  "encryptData": true,
  "compactAfterDays": 365
}
```

`repoUrl` is the git remote used by `init` and `sync`. `machineId` becomes the `data/{machineId}.json` filename; `init` asks for it and defaults to the short hostname. Keep it unique, stable, and valid as a filename on every machine you use. Changing it through the CLI migrates the old pending and synced file without overwriting an existing target.

`claudeProjectsDir` and `codexSessionsDir` are optional comma-separated **additional** source roots. They do not replace the standard locations; aitrack recursively scans the configured, environment, and default roots and deduplicates identical paths. You can also add roots with `AITRACK_CLAUDE_PROJECTS_DIRS` or `AITRACK_CODEX_SESSION_DIRS`.

`aitrack config list`, `get`, and `set` cover every key shown above, using dotted names for nested settings—for example, `aitrack config set budget.monthly 200`.

`budget.monthly` (set with `aitrack config set budget.monthly 200`) is an estimated-cost ceiling in USD for the calendar month. When it is set, `aitrack usage thismonth` prints a line showing month-to-date estimated spend against it, warning at 80% and flagging the overage once it is exceeded. It is advisory only—nothing is blocked—and it is ignored by the rolling `usage month` window.

### Encrypting the synced files

`aitrack config set encryptData true` encrypts this machine's `data/{machineId}.json` before it is committed. It is off by default. The key comes from the `AITRACK_ENCRYPTION_PASSPHRASE` environment variable, which is never written to the config or the repo; every machine and the desktop app must have it set to read the encrypted files. Use the same passphrase on all machines, or each machine's file will be unreadable to the others.

- `sync` fails with a clear message when `encryptData` is on and the variable is missing, and so does `recompute-costs` when it has a file to write. Turning the setting on or off rewrites the file on the next `sync` even if no usage changed.
- Files use scrypt (N=2^15) and AES-256-GCM from Node's built-in crypto, with a random salt and IV per file. The file is a small JSON envelope (`"encrypted": "aitrack-aes-256-gcm-scrypt-v1"`, base64 `salt`, `iv`, `tag`, `data`); any change to it or a wrong passphrase fails authentication.
- Plain and encrypted files can sit side by side in one repo. A reader without the right passphrase skips an encrypted file with a warning that names the file and the variable to set; the rest of the fleet still loads. An aitrack version that predates encryption skips it with an "upgrade aitrack" message.
- Threat model: this hides token counts, models and costs from whoever hosts or can read the data repo. It does not hide metadata: file names (so machine IDs), commit times and sizes, and the fact that you use aitrack. A weak passphrase can be brute-forced offline from any clone, and history committed before you enabled encryption stays readable in git. The GUI launches with its own environment, so export the variable where the desktop app starts or it will skip encrypted machines.

### Compacting old history

`aitrack config set compactAfterDays 365` (a positive whole number; `off` clears it) shrinks long-lived repos. When `sync` writes this machine's file, each day older than that many local calendar days keeps its per-provider totals (tokens and cost) but loses its per-model breakdown, which is replaced by a single `(compacted)` entry mirroring the totals. Report totals and costs for those days do not change, and older aitrack versions still read the file.

The tradeoff is that per-model history for old days is gone: model tables show those days as `(compacted)`, and `recompute-costs` cannot reprice them and leaves the stored cost as it is. It is irreversible once pushed, because earlier commits are the only copy of the detail and the local logs are not used to restore a compacted day whose totals have not changed. Only this machine's file is compacted; other machines compact their own.

---

## Where data comes from

| Provider              | Source                                                                              |
| --------------------- | ----------------------------------------------------------------------------------- |
| Claude Code           | `~/.claude/projects/**/*.jsonl` or `$XDG_CONFIG_HOME/claude/projects/**/*.jsonl`    |
| Codex                 | `~/.codex/sessions/**/*.jsonl` or `$CODEX_HOME/sessions/**/*.jsonl`                 |
| Cursor _(local only)_ | local `state.vscdb`, then Cursor's HTTPS CSV export — **never synced to your repo** |

Default `state.vscdb` locations (override with `CURSOR_STATE_DB_PATH` or `CURSOR_CONFIG_DIR`):

- **macOS:** `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`
- **Windows:** `%APPDATA%\Cursor\User\globalStorage\state.vscdb`
- **Linux:** `~/.config/Cursor/User/globalStorage/state.vscdb`

Optional: `CURSOR_WEB_BASE_URL` (default `https://cursor.com`). It must be a credential-free HTTPS URL; the configured origin receives your Cursor access token.

---

## Data format

Each machine's file in the repo:

```json
{
  "hostname": "my-pc",
  "lastUpdated": "2026-04-12T10:00:00.000Z",
  "days": {
    "2026-04-12": {
      "claude_code": {
        "byModel": {
          "claude-sonnet-4-6": { "inputTokens": 45000, "outputTokens": 3200, "costUSD": 0.183 }
        },
        "totals": { "inputTokens": 45000, "outputTokens": 3200, "costUSD": 0.183 }
      },
      "codex": {
        "byModel": {
          "gpt-5.1-codex": {
            "inputTokens": 12000,
            "cachedInputTokens": 4000,
            "outputTokens": 800,
            "costUSD": 0.0185
          }
        },
        "totals": {
          "inputTokens": 12000,
          "cachedInputTokens": 4000,
          "outputTokens": 800,
          "costUSD": 0.0185
        }
      }
    }
  }
}
```

---
