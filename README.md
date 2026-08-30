<div align="center">

# aitrack

**Track your AI coding-assistant usage across every machine — and own the data.**

Each machine pushes Claude Code and Codex usage to a git repo _you_ control. Pull from anywhere to see a merged heatmap, stats table, and estimated cost breakdown; optionally add Cursor usage from the current machine.

[![npm version](https://img.shields.io/npm/v/aitrack?color=cb3837&logo=npm)](https://www.npmjs.com/package/aitrack)
[![CI](https://github.com/bircni/aitrack/actions/workflows/ci.yml/badge.svg)](https://github.com/bircni/aitrack/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/aitrack?logo=node.js&color=339933)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/aitrack?color=blue)](LICENSE)

<br>

<img src="https://raw.githubusercontent.com/bircni/aitrack/main/docs/heatmap.png" alt="aitrack heatmap — a year of Claude Code, Codex and Cursor usage with token totals, cost and streaks" width="720">

<sub>One <code>aitrack show</code> — synced assistants across every machine, plus local Cursor, at a glance.</sub>

</div>

---

## Why aitrack?

- 📊 **One picture of everything** — Claude Code + Codex merged across your machines, with current-machine Cursor usage available on demand.
- 🔒 **You own the synced data** — it lives in a git repo you create. aitrack has no account or telemetry; Cursor requests go to `cursor.com` by default when that provider is selected.
- 🔑 **No API tokens for sync** — uses your local `git`, so whatever auth already works in your terminal (SSH keys, credential manager) just works.
- ⚡ **Zero-setup preview** — run `npx aitrack show --tui` and see your local usage _before_ configuring anything.
- 💰 **API-equivalent cost estimates** — per-model list pricing applied to Claude Code and Codex token/cache usage. On a subscription this is the pay-as-you-go value of your usage, not what you're billed.
- 🧮 **Total usage value, all in one place** — combined estimates across every synced machine, alongside local Cursor token usage when selected.

> **Synced via git:** Claude Code, Codex (OpenAI).
> **Cursor** is selected by default, read through the current machine's Cursor session, and **never** written to your repo. Pass `--providers claude,codex` to provider-aware commands to exclude it (see [Where data comes from](#where-data-comes-from)).

---

## See it

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

`init` asks for your repo's remote URL (SSH or HTTPS — whatever you normally use) and a stable machine name, then clones the repo to `~/.config/aitrack/repo/`. The machine name defaults to your hostname and becomes `data/{machineId}.json`. `show` always reads **fresh local** Claude/Codex data, so you never need to `sync` first just to preview.

### Multiple machines

Run `aitrack init` once per machine with the **same** repo URL, choose a unique, stable, filename-safe machine name for each one, then run `aitrack sync`. Distinct `data/{machineId}.json` files avoid merge conflicts. Changing the ID through `aitrack config set machineId ...` or by rerunning `init` migrates that machine's pending and synced file; a conflicting target is rejected rather than overwritten.

---

## Commands

| Command                         | What it does                                                                  |
| ------------------------------- | ----------------------------------------------------------------------------- |
| `aitrack init`                  | Configure a remote and stable machine ID, then clone the data repo            |
| `aitrack sync`                  | Read local data, write it to the cloned repo, and push (`--dry-run` previews) |
| `aitrack show`                  | Merge all sources and render a heatmap PNG (add `--tui` for a terminal table) |
| `aitrack usage <window>`        | Usage by provider and model for a rolling, calendar, or custom window         |
| `aitrack export [window] [...]` | Export the same windows as an itemized PDF, or `--csv` (defaults to `month`)  |
| `aitrack daemon`                | Serve a local, periodically refreshed HTML dashboard                          |
| `aitrack top [days\|models]`    | Rank busiest days or most-used models by cost (or `--sort tokens`)            |
| `aitrack machines`              | Per-machine totals + last sync time (helpful for spotting stale machines)     |
| `aitrack recompute-costs`       | Refresh costs: re-read local JSONL; reprice other machines from stored cache  |
| `aitrack doctor`                | Check Node, git, config, source paths, Cursor auth, sync health, and pricing  |
| `aitrack config list\|get\|set` | Inspect or update supported configuration keys                                |

**Usage and export windows:** `today`, `yesterday`, `date <YYYY-MM-DD>`, `range <from> <to>`, `thisweek`, `lastweek`, `week` (rolling 7 days), `thismonth`, `lastmonth`, `month` (rolling 30 days), `last <n>`, `year`, and `all`.

**Provider selection:** `--providers <list>` accepts comma-separated `claude`, `codex`, and `cursor` values and works with `show`, every `usage` window, `export`, `top`, and `daemon`. All three are selected by default. Excluding `cursor` prevents the Cursor credential read and HTTPS export request.

**`show` flags:** `--tui` (terminal table instead of PNG), `--all` (single merged heatmap), `--dark` (dark mode), `--no-open` (don't auto-open the PNG), `-o <path>` (custom output path), and `--year <year>` (filter to one calendar year).

**JSON output:** add `--json` to `usage`, `top`, `machines`, or `doctor` for scripting.

**`export` flags:** `-o <path>` (output path) and `--csv` (write a spreadsheet-friendly CSV — raw token counts, one row per provider+model plus a `TOTAL` row — instead of the PDF receipt; the default `-o` extension switches to `.csv`).

**Period comparison:** add `--compare` to any finite `usage` window to compare tokens, estimated
cost, and per-model movement with the equivalent previous period. Calendar-to-date windows compare
the same elapsed days—for example, `aitrack usage thisweek --compare` compares this week so far with
the same weekdays last week. Comparison data is also included with `--json`.

**`top` flags:** `-n, --limit <n>`, `--sort tokens|cost` (default `cost`), `--year <year>`, and `--since <YYYY-MM-DD>` / `--until <YYYY-MM-DD>` for an explicit inclusive date range.

**`doctor` flags:** `--pricing-check` runs the pricing drift script when you are in a source checkout.

**Daemon reliability:** refresh and sync ticks are single-flight, so a slow refresh cannot overlap the
next one. The dashboard shows the last successful refresh and sync plus the latest error. For local
monitoring, `GET /healthz` reports process liveness, `GET /readyz` reports whether a refresh has
succeeded, and `GET /status.json` returns the full runtime status as JSON.

---

## How it works

```text
~/.config/aitrack/
├── config.json          # remote, machine, source-root, and daemon settings
├── cache/               # parsed-transcript cache, rebuildable at any time
│   ├── claude.json
│   └── codex.json
├── pending/
│   └── data/            # staged machine JSON before init
│       └── my-pc.json
└── repo/                # local clone of your data repo
    └── data/
        ├── my-pc.json
        └── work-laptop.json
```

- **Sync** uses a local git clone at `~/.config/aitrack/repo/` with your existing git credentials. Non-fast-forward pushes are rebased and retried up to three times; if both machines updated the same machine file, only the current machine's freshly generated file is reapplied.
- **`show` (PNG or `--tui`) always reads fresh local Claude/Codex JSONL** on the current machine and merges in other machines' synced files. No `sync` needed to preview.
- Before `init`, local usage is staged in `~/.config/aitrack/pending/data/` and adopted by the next `init`.
- **Cursor** is loaded only on the current machine when selected: aitrack reads `cursorAuth/accessToken` from Cursor's local `state.vscdb`, then calls the CSV usage export at `CURSOR_WEB_BASE_URL` (`https://cursor.com` by default). The endpoint is required to use HTTPS and contain no embedded credentials. Any configured HTTPS origin receives the Cursor token, so override it only with an endpoint you trust. The token is **never** written to your repo. Use `--providers` without `cursor` (for example, `--providers claude,codex`) to skip both the credential read and request.
- **Heatmap intensity** anchors on the 90th-percentile day rather than the absolute max, so one huge day doesn't flatten the rest of the year.
- **Parsed transcripts are cached** per file in `~/.config/aitrack/cache/`, keyed by path, size, and modification time, and invalidated whenever the aitrack version changes (costs are computed at parse time, so a pricing update must not be served from cache). Deleting the directory only costs one slower run. Set `AITRACK_NO_CACHE=1` to bypass it entirely.

### Cost handling

Claude Code and Codex costs are API-equivalent estimates from per-model list pricing, not subscription charges. Claude estimates account for regular input, cache reads, cache creation, and output. Codex estimates use the cached-input count recorded by newer sessions and apply the prompt-cache discount; older records without that field are treated as uncached input. Unknown model IDs may use a family fallback and emit a warning, or remain unpriced when no safe match exists. Cursor's CSV supplies token counts but not a cost, so Cursor cost remains unknown. If stored estimates are missing or pricing changed, run `aitrack recompute-costs`.

---

## Configuration

Stored at `~/.config/aitrack/config.json`:

```json
{
  "repoUrl": "git@github.com:your-username/aitrack-data.git",
  "machineId": "work-laptop",
  "claudeProjectsDir": "/custom/claude/projects",
  "codexSessionsDir": "/custom/codex/sessions-a,/custom/codex/sessions-b",
  "daemon": {
    "port": 9089,
    "interval": 120,
    "sync": false
  },
  "budget": {
    "monthlyUSD": 200
  }
}
```

`repoUrl` is the git remote used by `init` and `sync`. `machineId` becomes the `data/{machineId}.json` filename; `init` asks for it and defaults to your OS hostname. Keep it unique, stable, and valid as a filename on every machine you use. Changing it through the CLI migrates the old pending and synced file without overwriting an existing target.

`claudeProjectsDir` and `codexSessionsDir` are optional comma-separated **additional** source roots. They do not replace the standard locations; aitrack recursively scans the configured, environment, and default roots and deduplicates identical paths. You can also add roots with `AITRACK_CLAUDE_PROJECTS_DIRS` or `AITRACK_CODEX_SESSION_DIRS`.

`daemon.port`, `daemon.interval` (seconds), and `daemon.sync` provide defaults for `aitrack daemon`; command-line options take precedence, including `--sync` and `--no-sync`. `aitrack config list`, `get`, and `set` cover every key shown above, using dotted names for nested settings—for example, `aitrack config set daemon.interval 60`.

`budget.monthly` (set with `aitrack config set budget.monthly 200`) is an estimated-cost ceiling in USD for the calendar month. When it is set, `aitrack usage thismonth` prints a line showing month-to-date estimated spend against it, warning at 80% and flagging the overage once it is exceeded. It is advisory only—nothing is blocked—and it is ignored by the rolling `usage month` window.

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

## Requirements

- **Node.js 24+**
- **git** installed and on your `PATH`
- A git remote you can push to (GitHub or any host)

Native dependencies (`@napi-rs/canvas`) install automatically; on some systems you may need build tools if prebuilt binaries aren't available.

---

## License

[MIT](LICENSE)
