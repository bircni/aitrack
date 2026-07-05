<div align="center">

# aitrack

**Track your AI coding-assistant usage across every machine — and own the data.**

Each machine pushes a single JSON file to a git repo _you_ control. Pull from anywhere to see a merged heatmap, stats table, and cost breakdown across Claude Code, Codex, and Cursor.

[![npm version](https://img.shields.io/npm/v/aitrack?color=cb3837&logo=npm)](https://www.npmjs.com/package/aitrack)
[![CI](https://github.com/bircni/aitrack/actions/workflows/ci.yml/badge.svg)](https://github.com/bircni/aitrack/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/aitrack?logo=node.js&color=339933)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/aitrack?color=blue)](LICENSE)

<br>

<img src="https://raw.githubusercontent.com/bircni/aitrack/main/docs/heatmap.png" alt="aitrack heatmap — a year of Claude Code, Codex and Cursor usage with token totals, cost and streaks" width="720">

<sub>One <code>aitrack show</code> — every assistant, every machine, a year at a glance.</sub>

</div>

---

## Why aitrack?

- 📊 **One picture of everything** — Claude Code + Codex + Cursor, merged across all your machines.
- 🔒 **You own the data** — it lives in a git repo you create. No accounts, no telemetry, no third-party servers.
- 🔑 **No API tokens for sync** — uses your local `git`, so whatever auth already works in your terminal (SSH keys, credential manager) just works.
- ⚡ **Zero-setup preview** — run `npx aitrack show --tui` and see your local usage _before_ configuring anything.
- 💰 **API-equivalent cost estimates** — per-model list pricing applied to Claude Code token + cache usage. On a subscription this is the pay-as-you-go value of your usage, not what you're billed.
- 🧮 **Total usage value, all in one place** — combined estimate across every machine you own, so you can see what your AI tooling would cost at API rates.

> **Synced via git:** Claude Code, Codex (OpenAI).
> **Cursor** is read locally on demand and **never** written to your repo (see [Where data comes from](#where-data-comes-from)).

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

Your local data is staged at `~/.config/aitrack/pending/data/` so a later `init`/`sync` can adopt it into your repo.

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

`init` asks for your repo's remote URL (SSH or HTTPS — whatever you normally use) and clones it to `~/.config/aitrack/repo/`. `sync` writes `data/{your-hostname}.json` and pushes it. `show` always reads **fresh local** Claude/Codex data, so you never need to `sync` first just to preview.

### Multiple machines

Run `aitrack init` once per machine with the **same** repo URL, then `aitrack sync` on each. Every machine writes its own `data/{hostname}.json`, so there are **no merge conflicts**.

---

## Commands

| Command                      | What it does                                                                  |
| ---------------------------- | ----------------------------------------------------------------------------- |
| `aitrack init`               | Interactive setup — provide your repo URL and clone it locally                |
| `aitrack sync`               | Read local data, write it to the cloned repo, and push (`--dry-run` previews) |
| `aitrack show`               | Merge all sources and render a heatmap PNG (add `--tui` for a terminal table) |
| `aitrack usage today`        | Today's usage as a table: provider / tokens / model / price                   |
| `aitrack usage week`         | Rolling 7-day usage table                                                     |
| `aitrack usage month`        | Rolling 30-day usage table                                                    |
| `aitrack usage year`         | Current calendar-year usage table                                             |
| `aitrack usage all`          | All-time usage table                                                          |
| `aitrack export [period]`    | PDF receipt for month/week/date/range/last windows                            |
| `aitrack top [days\|models]` | Rank busiest days or most-used models by cost (or `--sort tokens`)            |
| `aitrack machines`           | Per-machine totals + last sync time (helpful for spotting stale machines)     |
| `aitrack recompute-costs`    | Refresh costs: re-read local JSONL; reprice other machines from stored cache  |
| `aitrack doctor`             | Check Node, git, config, source paths, Cursor auth, sync health, and pricing   |

**`show` flags:** `--tui` (terminal table instead of PNG), `--all` (single merged heatmap), `--dark` (dark mode), `--providers <list>` (comma-separated providers to show — `claude`, `codex`, `cursor`; default: all), `--no-open` (don't auto-open the PNG), `-o <path>` (custom output path), `--year <year>` (filter to one calendar year). `--providers` also works on `usage`, `export`, `top`, and `daemon`.

**JSON output:** add `--json` to `usage`, `top`, or `machines` for scripting.

**`top` flags:** `-n, --limit <n>`, `--sort tokens|cost` (default `cost`), and `--year <year>`.

**`doctor` flags:** `--pricing-check` runs the pricing drift script when you are in a source checkout.

---

## How it works

```text
~/.config/aitrack/
├── config.json          # repo URL + optional machineId
├── pending/
│   └── data/            # staged machine JSON before init/sync
│       └── my-pc.json
└── repo/                # local clone of your data repo
    └── data/
        ├── my-pc.json
        └── work-laptop.json
```

- **Sync** uses a local git clone at `~/.config/aitrack/repo/` with your existing git credentials — ordinary pulls and pushes.
- **`show` (PNG or `--tui`) always reads fresh local Claude/Codex JSONL** on the current machine and merges in other machines' synced files. No `sync` needed to preview.
- Before `init`, local usage is staged in `~/.config/aitrack/pending/data/` and adopted on the next `init`/`sync`.
- **Cursor** is loaded only on the current machine: aitrack reads `cursorAuth/accessToken` from Cursor's local `state.vscdb`, then calls Cursor's own CSV usage export over HTTPS. The token is used solely for that request — it is **never** written to your repo or sent anywhere else. Use `--providers` without `cursor` (e.g. `--providers claude,codex`) to skip it.
- **Heatmap intensity** anchors on the 90th-percentile day rather than the absolute max, so one huge day doesn't flatten the rest of the year.

### Cost handling

Claude Code cost is an API-equivalent estimate from per-model pricing and token/cache usage, keyed by Claude API model id with the date suffix stripped (see [`src/readers/claude.ts`](src/readers/claude.ts)). Cursor and Codex local-session cost are left unknown because their local data doesn't expose a reliable all-history cost. If stored costs are missing or pricing changed, run `aitrack recompute-costs`.

---

## Configuration

Stored at `~/.config/aitrack/config.json`:

```json
{
  "repoUrl": "git@github.com:your-username/aitrack-data.git",
  "machineId": "work-laptop",
  "claudeProjectsDir": "/custom/claude/projects",
  "codexSessionsDir": "/custom/codex/sessions"
}
```

`machineId` is optional — without it, `sync` uses your OS hostname as the filename. Set a stable name during `init` if your hostname might collide across machines or change after a reinstall. Existing hostname-based files keep working when read.

`claudeProjectsDir` and `codexSessionsDir` are optional comma-separated overrides for nonstandard local data locations. You can also set `AITRACK_CLAUDE_PROJECTS_DIRS` or `AITRACK_CODEX_SESSION_DIRS`.

---

## Where data comes from

| Provider             | Source                                                                              |
| -------------------- | ----------------------------------------------------------------------------------- |
| Claude Code          | `~/.claude/projects/**/*.jsonl` or `$XDG_CONFIG_HOME/claude/projects/**/*.jsonl`    |
| Codex                | `~/.codex/sessions/*.jsonl` or `$CODEX_HOME/sessions/*.jsonl`                       |
| Cursor _(show only)_ | local `state.vscdb`, then Cursor's HTTPS CSV export — **never synced to your repo** |

Default `state.vscdb` locations (override with `CURSOR_STATE_DB_PATH` or `CURSOR_CONFIG_DIR`):

- **macOS:** `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`
- **Windows:** `%APPDATA%\Cursor\User\globalStorage\state.vscdb`
- **Linux:** `~/.config/Cursor/User/globalStorage/state.vscdb`

Optional: `CURSOR_WEB_BASE_URL` (default `https://cursor.com`).

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
        "byModel": { "codex-1": { "inputTokens": 12000, "outputTokens": 800 } },
        "totals": { "inputTokens": 12000, "outputTokens": 800 }
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
